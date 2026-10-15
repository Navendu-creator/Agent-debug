import { spawnSync } from 'node:child_process';
import { createTwoFilesPatch } from 'diff';
import { parseAllDocuments } from 'yaml';
import type { Analysis, FileChange, Incident, ProposedChange, ValidationCheck } from '../types.js';
import { checkPath, RCA_DIR } from './repo.js';

/**
 * Turns model-proposed edits into a validated patch. Every check here is static and in-process
 * (or a syntax-only `bash -n`); model-generated commands are never executed.
 */

const TEXT_EXT = /\.(ya?ml|json|tf|tfvars|hcl|toml|ini|conf|cfg|properties|env\.example|sh|js|mjs|cjs|ts|py|go|java|rb|md|txt|xml|sql|dockerfile)$|(^|\/)Dockerfile$/i;
// Keeps the prompt within an 8k-token context window.
const MAX_FILES = 3;
const MAX_FILE_BYTES = 6_000;

const STOPWORDS = new Set(
  ('the and for with from that this have been were when what into after before since about there their they them then than only also some more most very error errors fail failed failing failure issue problem please need needs should would could incident service environment production staging increase decrease change update using used ' +
    'not are but was has its our you can all any out use set get new one two too why how who did yes see via does found missing define defined something').split(' '),
);

/** Lower-cased, lightly stemmed keywords from the incident text ("replicas" → "replica"; short infra terms like "vpc" kept). */
export function incidentKeywords(incident: Incident): string[] {
  const words = [incident.title, incident.description, incident.logs ?? '']
    .join(' ')
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  const stems = words
    .filter((w) => !STOPWORDS.has(w))
    .map((w) => {
      const stem = w.replace(/(ing|ed|es|s)$/, '');
      return stem.length >= 3 ? stem : w; // "aws" stays "aws", not "aw"
    })
    .filter((w) => !STOPWORDS.has(w));
  return [...new Set(stems)].slice(0, 40);
}

const DOC_EXT = /\.(md|txt)$/i;

const BLOCK_KINDS: Record<string, string> = { module: 'module', variable: 'variable', var: 'variable', output: 'output', resource: 'resource', data: 'data' };
const NOT_A_NAME = new Set('not is was has block name named call missing found defined declared undeclared error the a an for in with of to and or does exist exists'.split(' '));

/**
 * Terraform blocks the report names: "module vpc", "module.vpc.vpc_id", `variable "region"`, "var.region",
 * Terraform's own `No module call named "vpc" is declared`.
 */
export function referencedBlocks(incident: Incident): Array<{ kind: string; name: string }> {
  const text = [incident.title, incident.description, incident.logs ?? ''].join('\n');
  const found = new Map<string, { kind: string; name: string }>();
  const add = (k: string, name: string) => {
    const kind = BLOCK_KINDS[k.toLowerCase()];
    if (kind && name && !NOT_A_NAME.has(name.toLowerCase())) found.set(`${kind} ${name.toLowerCase()}`, { kind, name });
  };
  for (const m of text.matchAll(/\b(module|variable|output|resource|data)\s+(?:call\s+)?named\s+"([^"]+)"/gi)) add(m[1], m[2]);
  for (const m of text.matchAll(/\b(module|variable|var|output|resource|data)(?:\s+"?|\.)([A-Za-z_][\w-]*)/gi)) add(m[1], m[2]);
  return [...found.values()].slice(0, 5);
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Deterministic problems in a file that are often the bug itself: Terraform blocks with an empty name
 * (`module "" {`), YAML/JSON that does not parse, unbalanced brackets.
 */
export function staticFindings(path: string, content: string): string[] {
  const findings: string[] = [];
  if (/\.(tf|hcl)$/i.test(path)) {
    content.split('\n').forEach((line, i) => {
      const m = line.match(/^\s*(resource|module|variable|output|data|provider)\s+(?:"[^"]*"\s+)*""/);
      if (m) findings.push(`${path} line ${i + 1}: ${m[1]} block has an empty name: ${line.trim()}`);
    });
  }
  // Helm/Go templates ({{ }}) are not plain YAML; don't report them as broken.
  if (!(/\.ya?ml$/i.test(path) && content.includes('{{'))) {
    const check = syntaxCheck(path, content);
    if (check.status === 'failed') findings.push(`${path}: ${check.detail}`);
  }
  return findings.slice(0, 5);
}

/**
 * Where a referenced block is (or should be) declared: +12 for `module "vpc"`; +10 for a block of
 * that kind with an empty name whose body mentions it (`module "" { source = ".../vpc/aws"`); +2 for
 * a reference (`module.vpc`).
 */
function declarationScore(content: string, refs: Array<{ kind: string; name: string }>): number {
  let score = 0;
  for (const { kind, name } of refs) {
    const n = escapeRe(name);
    if (new RegExp(`^\\s*${kind}\\s+"${n}"`, 'mi').test(content)) score += 12;
    else {
      for (const block of content.matchAll(new RegExp(`^\\s*${kind}\\s+((?:"[^"]*"\\s*)+)\\{([\\s\\S]*?)^\\}`, 'gm'))) {
        if (/""/.test(block[1]) && new RegExp(n, 'i').test(block[2])) {
          score += 10;
          break;
        }
      }
    }
    if (new RegExp(`\\b${kind === 'variable' ? 'var' : kind}\\.${n}\\b`, 'i').test(content)) score += 2;
  }
  return score;
}

export interface ContentRank {
  score: number;
  findings: string[];
  /** A deterministic signal (static finding about a referenced block kind, or a declaration match). */
  strong: boolean;
}

/**
 * How likely a file is to need the fix: incident keywords in its path/contents (counted up to 3 times
 * each), where the blocks named in the report are declared, and static findings.
 */
export function contentRank(
  file: { path: string; content: string },
  keywords: string[],
  refs: Array<{ kind: string; name: string }>,
): ContentRank {
  const path = file.path.toLowerCase();
  const content = file.content.toLowerCase();
  let score = 0;
  for (const k of keywords) {
    if (path.includes(k)) score += 2;
    score += Math.min(content.split(k).length - 1, 3);
  }
  const declared = declarationScore(file.content, refs);
  const findings = staticFindings(file.path, file.content);
  // A finding about a kind of block the report talks about ("module vpc" + empty `module ""`) is the strongest hint.
  const relevantFinding = findings.some((f) => refs.some((r) => f.includes(`${r.kind} block`)));
  score += declared + Math.min(findings.length, 2) * 8;
  // READMEs mention every keyword but are rarely what needs fixing.
  if (DOC_EXT.test(file.path)) score /= 2;
  return { score, findings, strong: declared >= 10 || relevantFinding };
}

/** Ranks files by `contentRank` (used by tests and as a simple API over the scan in the pipeline). */
export function rankByContent(files: Array<{ path: string; content: string }>, incident: Incident, max = MAX_FILES): string[] {
  const keywords = incidentKeywords(incident);
  const refs = referencedBlocks(incident);
  return files
    .map((f) => ({ path: f.path, score: contentRank(f, keywords, refs).score }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, max)
    .map((x) => x.path);
}

/** Lists repository files the model may read: text files inside the allowed paths. */
export function candidateFiles(paths: string[], allowedPaths: string[]): string[] {
  return paths.filter((p) => TEXT_EXT.test(p) && !p.startsWith(RCA_DIR) && checkPath(p, allowedPaths) === null);
}

/** Files the report names by path or file name. */
export function selectRelevantFiles(paths: string[], incident: Incident, allowedPaths: string[]): string[] {
  const text = [incident.title, incident.description, incident.logs ?? ''].join('\n').toLowerCase();
  const scored = candidateFiles(paths, allowedPaths)
    .map((p) => {
      const lower = p.toLowerCase();
      const base = lower.split('/').pop()!;
      const score = text.includes(lower) ? 10 : base.length > 4 && text.includes(base) ? 5 : 0;
      return { p, score: score && /\.(ya?ml|json|tf|tfvars|toml|ini|conf|properties)$/.test(lower) ? score + 1 : score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.localeCompare(b.p));
  return scored.slice(0, MAX_FILES).map((x) => x.p);
}

/** Paths containing the reported service name ("payment-api" → services/payment-api/…): searched first. */
export function serviceFiles(candidates: string[], service: string | undefined): string[] {
  const s = service?.trim().toLowerCase();
  return s && s.length >= 3 ? candidates.filter((p) => p.toLowerCase().includes(s)) : [];
}

/**
 * Code the reporter quoted: lines that look like code (`#enable_nat_gateway = true`, `replicas: 2`,
 * `resource "aws_vpc" "this" {`) and distinctive identifiers (`enable_nat_gateway`, `maxConnections`,
 * `DATABASE_URL`). Used to find the file that contains them when file names don't match.
 */
export function quotedCode(incident: Incident): { lines: string[]; identifiers: string[] } {
  const text = [incident.title, incident.description, incident.logs ?? ''].join('\n');
  const lines = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length < 6 || line.length > 200) continue;
    // key = value / key: value / block opener, optionally commented out; not "file: line 3: message" log prose.
    if (/^(#|\/\/)?\s*[A-Za-z_][\w.-]*(\s*=\s*\S|:\s+\S+$|\s+"[^"]*"(\s+"[^"]*")?\s*\{)/.test(line) && !/\bline \d+\b/i.test(line)) {
      lines.add(line);
      const uncommented = line.replace(/^(#|\/\/)\s*/, '');
      if (uncommented !== line) lines.add(uncommented);
    }
  }
  const identifiers = new Set<string>();
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) {
    if (m[0].length >= 8) identifiers.add(m[0]);
  }
  return { lines: [...lines], identifiers: [...identifiers].slice(0, 20) };
}

/**
 * 10 per quoted line that is a whole line of the file (ignoring indentation, spacing, a leading comment
 * marker and a trailing comment, so `type: Cluster` does not match `type: ClusterIP`), 1 per identifier.
 */
export function quotedCodeScore(content: string, quoted: { lines: string[]; identifiers: string[] }): number {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().replace(/^(#|\/\/)\s*/, '');
  const fileLines = content.split('\n').map(norm);
  const isLine = (q: string) => fileLines.some((l) => l === q || l.startsWith(`${q} #`) || l.startsWith(`${q} //`));
  const lines = [...new Set(quoted.lines.map(norm))];
  return (
    lines.filter(isLine).length * 10 +
    quoted.identifiers.filter((i) => new RegExp(`\\b${i}\\b`).test(content)).length
  );
}

const CONFIG_EXT = /\.(tf|tfvars|hcl|ya?ml|json|toml|ini|conf|cfg|properties|env\.example|sh)$|(^|\/)Dockerfile$/i;

/** Search order for quoted code: name matches, then config/infra files, then source, docs last. */
export function quotedCodeSearchOrder(candidates: string[], preferred: string[]): string[] {
  const rank = (p: string) => (preferred.includes(p) ? 0 : CONFIG_EXT.test(p) ? 1 : DOC_EXT.test(p) ? 3 : 2);
  return [...candidates].sort((a, b) => rank(a) - rank(b));
}

export function truncateForModel(content: string): string {
  return content.length > MAX_FILE_BYTES ? `${content.slice(0, MAX_FILE_BYTES)}\n…[truncated]` : content;
}

export interface BuiltPatch {
  changes: FileChange[];
  rejected: Array<{ file: string; reason: string }>;
}

/** Applies exact search/replace edits to files the model was shown; anything else is rejected. */
export function applyProposedChanges(
  proposed: ProposedChange[],
  originals: Map<string, string>,
  allowedPaths: string[],
): BuiltPatch {
  const working = new Map<string, { before: string; after: string; descriptions: string[] }>();
  const rejected: BuiltPatch['rejected'] = [];

  for (const change of proposed) {
    const file = change.file.trim().replace(/^\.?\//, '');
    const pathProblem = checkPath(file, allowedPaths);
    if (pathProblem) {
      rejected.push({ file, reason: pathProblem });
      continue;
    }
    if (file.startsWith(RCA_DIR)) {
      rejected.push({ file, reason: 'the RCA document is generated by Nagent, not the model' });
      continue;
    }
    const original = originals.get(file);
    if (original === undefined) {
      rejected.push({ file, reason: 'file was not read from the repository (model may only edit files it was shown)' });
      continue;
    }
    const entry = working.get(file) ?? { before: original, after: original, descriptions: [] };
    const count = entry.after.split(change.find).length - 1;
    if (count !== 1) {
      const squash = (t: string) => t.replace(/\s+/g, ' ').trim();
      const alreadyThere = count === 0 && change.replace.trim() !== '' && squash(entry.after).includes(squash(change.replace));
      rejected.push({
        file,
        reason: alreadyThere
          ? 'the text to replace is not in the file, and the file already contains the proposed replacement — the fix appears to be already applied in the repository'
          : count === 0
            ? 'the text to replace does not exist in the file (the model may have quoted the incident report instead of the code)'
            : `"find" text matched ${count} times (must match exactly once)`,
      });
      continue;
    }
    if (change.find === change.replace) {
      const uncommented = uncommentEdit(entry.after, change.find);
      if (!uncommented) {
        rejected.push({ file, reason: 'replacement is identical to the original text' });
        continue;
      }
      entry.after = uncommented;
      entry.descriptions.push(
        `${change.description} (Nagent: the model's replacement equalled text that is commented out in the file, so it was applied as uncommenting that line — review it.)`,
      );
      working.set(file, entry);
      continue;
    }
    const after = entry.after.replace(change.find, () => change.replace);
    if (!DOC_EXT.test(file) && codeOnly(after) === codeOnly(entry.after)) {
      rejected.push({ file, reason: 'the edit only adds or changes comments, so it does not fix anything' });
      continue;
    }
    entry.after = after;
    entry.descriptions.push(change.description);
    working.set(file, entry);
  }

  const changes = [...working.entries()].map(([path, e]) => ({
    path,
    description: e.descriptions.join(' '),
    before: e.before,
    after: e.after,
    diff: unifiedDiff(path, e.before, e.after),
  }));
  return { changes, rejected };
}

/** The file without comment-only and blank lines: equal before/after means an edit changed only comments. */
function codeOnly(content: string): string {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(#|\/\/|\/\*|\*|--|<!--)/.test(l))
    .join('\n');
}

/**
 * Small models often "uncomment" a line by returning find == replace == the text after the comment
 * marker (`#PORT=7000` → find/replace `PORT=7000`). When the single-line `find` is preceded on its line
 * only by a comment marker, returns the content with that marker removed; otherwise null.
 */
function uncommentEdit(content: string, find: string): string | null {
  if (!find.trim() || find.includes('\n')) return null;
  const at = content.indexOf(find);
  const lineStart = content.lastIndexOf('\n', at) + 1;
  const prefix = content.slice(lineStart, at).match(/^(\s*)(#|\/\/|--|;)\s?$/);
  if (!prefix) return null;
  return content.slice(0, lineStart) + prefix[1] + content.slice(at);
}

export function unifiedDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(before ? `a/${path}` : '/dev/null', `b/${path}`, before, after, '', '', { context: 3 });
}

// ---------- validation ----------

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ['GitLab token', /\bgl(pat|dt|ptt|rt|cbt)-[A-Za-z0-9_-]{20,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['hardcoded secret', /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[A-Za-z0-9/+_\-]{12,}/i],
];

function addedLines(before: string, after: string): string[] {
  const old = new Set(before.split('\n'));
  return after.split('\n').filter((l) => !old.has(l));
}

function syntaxCheck(path: string, content: string): ValidationCheck {
  const name = 'syntax';
  try {
    if (/\.json$/i.test(path)) {
      JSON.parse(content);
      return { name, file: path, status: 'passed', detail: 'Valid JSON' };
    }
    if (/\.ya?ml$/i.test(path)) {
      const errors = parseAllDocuments(content).flatMap((d) => ('errors' in d ? d.errors : []));
      return errors.length
        ? { name, file: path, status: 'failed', detail: `YAML error: ${errors[0].message}` }
        : { name, file: path, status: 'passed', detail: 'Valid YAML' };
    }
    if (/\.sh$/i.test(path)) {
      // `bash -n` only parses the script from stdin; nothing is executed.
      const r = spawnSync('bash', ['-n'], { input: content, timeout: 5000, env: {}, encoding: 'utf8' });
      if (r.error) return { name, file: path, status: 'skipped', detail: `bash unavailable: ${r.error.message}` };
      return r.status === 0
        ? { name, file: path, status: 'passed', detail: 'bash -n: no syntax errors' }
        : { name, file: path, status: 'failed', detail: `bash -n: ${r.stderr.trim().slice(0, 300)}` };
    }
    if (/\.(tf|tfvars|hcl)$/i.test(path)) {
      const balanced = [['{', '}'], ['[', ']'], ['(', ')']].every(
        ([o, c]) => content.split(o).length === content.split(c).length,
      );
      return balanced
        ? { name, file: path, status: 'passed', detail: 'Brackets balanced (terraform validate is not run)' }
        : { name, file: path, status: 'failed', detail: 'Unbalanced brackets' };
    }
  } catch (err) {
    return { name, file: path, status: 'failed', detail: (err as Error).message.slice(0, 300) };
  }
  if (/\.(md|txt)$/i.test(path)) return { name, file: path, status: 'passed', detail: 'Plain text' };
  return { name, file: path, status: 'skipped', detail: 'No local syntax checker for this file type' };
}

export function validateChanges(changes: FileChange[], allowedPaths: string[]): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  for (const c of changes) {
    const before = c.before ?? '';
    const after = c.after ?? '';
    const pathProblem = checkPath(c.path, allowedPaths);
    checks.push({
      name: 'allowed-path',
      file: c.path,
      status: pathProblem ? 'failed' : 'passed',
      detail: pathProblem ?? 'Path is inside the allowed paths',
    });
    checks.push({
      name: 'non-empty-change',
      file: c.path,
      status: before === after ? 'failed' : 'passed',
      detail: before === after ? 'File is unchanged' : 'File content changed',
    });
    const changed = c.diff.split('\n').filter((l) => /^[+-](?![+-])/.test(l)).length;
    const tooBig = changed > 300 || after.length > 200_000;
    checks.push({
      name: 'change-size',
      file: c.path,
      status: tooBig ? 'failed' : 'passed',
      detail: `${changed} changed line(s)${tooBig ? ' — exceeds the 300-line limit for an automated minimal fix' : ''}`,
    });
    const leaks = SECRET_PATTERNS.filter(([, re]) => addedLines(before, after).some((l) => re.test(l))).map(([n]) => n);
    checks.push({
      name: 'secret-scan',
      file: c.path,
      status: leaks.length ? 'failed' : 'passed',
      detail: leaks.length ? `Possible ${leaks.join(', ')} in added lines` : 'No secrets detected in added lines',
    });
    checks.push(syntaxCheck(c.path, after));
  }
  return checks;
}

// ---------- RCA document ----------

const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)');
const fence = (s: string) => s.replace(/```/g, "'''");

export function rcaMarkdown(incident: Incident, analysis: Analysis, mode: string, model?: string): string {
  const facts = analysis.evidence.filter((e) => e.type === 'fact');
  const hypotheses = analysis.evidence.filter((e) => e.type === 'hypothesis');
  return `# ${incident.id}: ${incident.title}

| Field | Value |
|---|---|
| Severity | ${incident.severity} |
| Service | ${incident.service ?? '—'} |
| Environment | ${incident.environment ?? '—'} |
| Reported | ${incident.createdAt} |
| Analysis | ${mode === 'demo' ? 'DEMO MODE (keyword heuristic, no AI)' : `Ollama \`${model}\``} |
| Confidence | ${analysis.confidence}% |

## Summary

${analysis.summary}

## Probable root cause

${analysis.probableRootCause}

## Evidence

**Verified facts** (quoted from the incident data or repository):
${facts.length ? facts.map((f) => `- ${f.source === 'report' ? '[from incident report] ' : f.source === 'repository' ? '[from repository] ' : ''}${f.statement}${f.quote ? `\n  \`\`\`\n  ${fence(f.quote)}\n  \`\`\`` : ''}`).join('\n') : '- (none)'}

**Hypotheses** (not verified):
${list(hypotheses.map((h) => h.statement))}

## Recommended fix

${analysis.recommendedFix || '(none)'}

## Validation plan

${list(analysis.validationPlan)}

## Preventive actions

${list(analysis.preventiveActions)}

## Limitations

${list(analysis.limitations)}

---
_Generated by Nagent. AI output can be wrong — review before merging._
`;
}
