import { spawnSync } from 'node:child_process';
import { createTwoFilesPatch, structuredPatch } from 'diff';
import { parseAllDocuments } from 'yaml';
import type { Analysis, FileChange, Incident, ProposedChange, ValidationCheck } from '../types.js';
import { k8sProblems } from './k8s.js';
import { checkPath, RCA_DIR, type FileRevision } from './repo.js';

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
  if (/\.ya?ml$/i.test(path)) findings.push(...k8sProblems(content).map((p) => `${path}: ${p.message}`));
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

/**
 * The fix Nagent can make without the model: the report names a block that no file declares
 * (`module.vpc` used, no `module "vpc"`), and exactly one block of that kind has an empty name — the one
 * whose body mentions the name (`module "" { source = ".../vpc/aws"`), or the only unnamed one.
 */
export function emptyNameFixes(
  files: Array<{ path: string; content: string }>,
  undeclared: Array<{ kind: string; name: string }>,
): Array<{ change: ProposedChange; line: string }> {
  const fixes: Array<{ change: ProposedChange; line: string }> = [];
  for (const { kind, name } of undeclared) {
    if (!/^[A-Za-z_][\w-]*$/.test(name)) continue;
    const blocks = files
      .filter((f) => /\.(tf|hcl)$/i.test(f.path))
      .flatMap((f) => {
        const lines = f.content.split('\n');
        return lines.flatMap((line, i) => {
          if (!new RegExp(`^\\s*${kind}\\s+(?:"[^"]*"\\s+)*""`).test(line)) return [];
          const end = lines.findIndex((l, j) => j > i && /^\}/.test(l));
          const blockLines = lines.slice(i, end < 0 ? undefined : end);
          return [{ file: f.path, content: f.content, line, blockLines, body: blockLines.slice(1).join('\n') }];
        });
      });
    const mentioning = blocks.filter((b) => b.body.toLowerCase().includes(name.toLowerCase()));
    const sameKind = undeclared.filter((u) => u.kind === kind).length;
    const pick = mentioning.length === 1 ? mentioning[0] : !mentioning.length && blocks.length === 1 && sameKind === 1 ? blocks[0] : undefined;
    if (!pick) continue;
    // `find` must occur exactly once: extend it with the block's next lines until it does.
    let find = '';
    for (let n = 1; n <= pick.blockLines.length; n++) {
      const snippet = pick.blockLines.slice(0, n).join('\n');
      if (pick.content.split(snippet).length === 2) {
        find = snippet;
        break;
      }
    }
    if (!find) continue;
    fixes.push({
      line: pick.line.trim(),
      change: {
        file: pick.file,
        description: `Name the empty ${kind} block "${name}": the incident and the code reference ${kind === 'variable' ? 'var' : kind}.${name}, which no file declares (fix derived by Nagent's static check).`,
        find,
        replace: find.replace('""', `"${name}"`),
      },
    });
  }
  return fixes;
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

const COMMENT = /^(#|\/\/)\s*/;
/** Whitespace-, spacing- and comment-marker-insensitive form of a code line. */
const normLine = (t: string) => t.replace(/\s+/g, ' ').trim().replace(COMMENT, '').replace(/\s*=\s*/, ' = ');
const isCommented = (t: string) => COMMENT.test(t.trim());

/**
 * Code the reporter quoted: lines that look like code (`#enable_nat_gateway = true`, `replicas: 2`,
 * `resource "aws_vpc" "this" {`), assignments inside a sentence or a pasted line that lost its line breaks
 * (`terraform { # required_version = ">= 1.6.0" is commented` → `# required_version = ">= 1.6.0"`), and
 * distinctive identifiers (`enable_nat_gateway`, `maxConnections`). Used to find the file that contains them.
 */
export function quotedCode(incident: Incident): { lines: string[]; identifiers: string[] } {
  const text = [incident.title, incident.description, incident.logs ?? ''].join('\n');
  const lines = new Map<string, string>(); // commented-state + normalized form → original
  const add = (line: string) => {
    const key = `${isCommented(line)}|${normLine(line)}`;
    if (!lines.has(key)) lines.set(key, line); // keep the reporter's own form
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length < 6 || line.length > 200 || /\bline \d+\b/i.test(line)) continue; // not "run.sh: line 14: …" log prose
    // A whole line: key = value / key: value / block opener, optionally commented out.
    if (/^(#|\/\/)?\s*[A-Za-z_][\w.-]*(\s*=\s*\S|:\s+\S+$|\s+"[^"]*"(\s+"[^"]*")?\s*\{)/.test(line)) add(line);
    // Assignments anywhere in the line, cut after their value.
    for (const m of line.matchAll(/(?:^|[\s{;,])((?:#|\/\/)\s*)?([A-Za-z_][\w.-]{2,})\s*=\s*("[^"]*"|'[^']*'|\[[^\]]*\]|[\w.:\/-]+)/g)) {
      add(`${m[1] ? `${m[1].trim()} ` : ''}${m[2]} = ${m[3]}`);
    }
  }
  const identifiers = new Set<string>();
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) {
    if (m[0].length >= 8) identifiers.add(m[0]);
  }
  return { lines: [...lines.values()].slice(0, 20), identifiers: [...identifiers].slice(0, 20) };
}

/** Distinct quoted lines, ignoring whether they are commented out: a file "has all of them" at 10 points each. */
export function quotedLineCount(quoted: { lines: string[] }): number {
  return new Set(quoted.lines.map(normLine)).size;
}

/**
 * Per distinct quoted line that is a whole line of the file (ignoring indentation, spacing and a trailing
 * comment, so `type: Cluster` does not match `type: ClusterIP`): 10 when it is commented out (or not)
 * exactly as quoted, 6 when only the opposite exists (`required_version = …` for a quoted
 * `# required_version = …`). Plus 1 per identifier.
 */
export function quotedCodeScore(content: string, quoted: { lines: string[]; identifiers: string[] }): number {
  const fileLines = content.split('\n').map((l) => ({ n: normLine(l), c: isCommented(l) }));
  const has = (n: string, c?: boolean) =>
    fileLines.some((l) => (l.n === n || l.n.startsWith(`${n} #`) || l.n.startsWith(`${n} //`)) && (c === undefined || l.c === c));
  const groups = new Map<string, boolean[]>();
  for (const q of quoted.lines) groups.set(normLine(q), [...(groups.get(normLine(q)) ?? []), isCommented(q)]);
  let score = 0;
  for (const [n, states] of groups) score += states.some((c) => has(n, c)) ? 10 : has(n) ? 6 : 0;
  return score + quoted.identifiers.filter((i) => new RegExp(`\\b${i}\\b`).test(content)).length;
}

/** "it's commented", "uncomment this" — but not "comment it out" / "should be commented". */
export function wantsUncomment(incident: Incident): boolean {
  const text = [incident.title, incident.description, incident.logs ?? ''].join(' ');
  if (/\buncomment/i.test(text)) return true;
  return /\bcommented\b/i.test(text) && !/comment(ed)?\s+(it\s+|this\s+|that\s+)?out\b|(should|must|needs?\s+to)\s+be\s+commented/i.test(text);
}

/**
 * The report quotes a line and says it is commented out: when exactly one of the files has that line
 * commented out (once), uncommenting it is the fix — no model needed.
 */
export function uncommentFixes(
  files: Array<{ path: string; content: string }>,
  incident: Incident,
): Array<{ change: ProposedChange; line: string; lineNo: number }> {
  if (!wantsUncomment(incident)) return [];
  const fixes: Array<{ change: ProposedChange; line: string; lineNo: number }> = [];
  for (const n of new Set(quotedCode(incident).lines.map(normLine))) {
    const hits = files.flatMap((f) =>
      f.content.split('\n').flatMap((line, i) => (isCommented(line) && normLine(line) === n ? [{ f, line, lineNo: i + 1 }] : [])),
    );
    if (hits.length !== 1 || hits[0].f.content.split(hits[0].line).length !== 2) continue;
    const { f, line, lineNo } = hits[0];
    if (fixes.some((x) => x.change.file === f.path && x.line === line.trim())) continue;
    fixes.push({
      line: line.trim(),
      lineNo,
      change: {
        file: f.path,
        description: `Uncomment \`${n}\` (line ${lineNo}): the incident reports it is commented out (fix derived by Nagent's static check).`,
        find: line,
        replace: line.replace(/^(\s*)(#|\/\/)\s?/, '$1'),
      },
    });
  }
  return fixes;
}

const keyLine = (key: string) => new RegExp(`^\\s*(?:-\\s+)?["']?${escapeRe(key)}["']?\\s*[:=]`);

/**
 * A commit removed lines that declare a key the error says is required (`containers: Required value`,
 * and a recent commit deleted `containers:` with the container's name and image): restoring that hunk —
 * only that hunk, not the whole commit — is the fix. Searches the file's newest commits, newest first.
 */
export function restoreFixes(
  files: Array<{ path: string; content: string }>,
  history: Map<string, FileRevision[]>,
  keys: string[],
): Array<{ change: ProposedChange; revision: FileRevision; removed: string[]; keys: string[]; diff: string | null }> {
  const fixes: ReturnType<typeof restoreFixes> = [];
  if (!keys.length) return fixes;
  for (const f of files) {
    const revisions = history.get(f.path) ?? [];
    // Only keys that are missing now: declared nowhere in the file, or reported missing by the Kubernetes check.
    const k8sMissing = /\.ya?ml$/i.test(f.path) ? k8sProblems(f.content).flatMap((p) => (p.missing ? [p.missing] : [])) : [];
    const missing = keys.filter((k) => k8sMissing.includes(k) || !f.content.split('\n').some((l) => keyLine(k).test(l)));
    if (!missing.length) continue;
    for (const [i, r] of revisions.entries()) {
      const after = i === 0 ? f.content : revisions[i - 1].before;
      if (r.before === null || after === null) break;
      const hunks = structuredPatch(f.path, f.path, r.before, after, '', '', { context: 3 }).hunks.flatMap((h) => {
        // Split the hunk into runs of changed lines; only a run that removed a missing key is reverted, so a
        // nearby unrelated edit of the same commit stays as it is.
        const runs: Array<{ removed: string[]; added: string[] } | string> = [];
        for (const l of h.lines) {
          if (l[0] === ' ') runs.push(l.slice(1));
          else if (l[0] === '-' || l[0] === '+') {
            let run = runs.at(-1);
            if (typeof run !== 'object') runs.push((run = { removed: [], added: [] }));
            (l[0] === '-' ? run.removed : run.added).push(l.slice(1));
          }
        }
        const restoring = (run: { removed: string[]; added: string[] }) =>
          missing.filter((k) => run.removed.some((l) => keyLine(k).test(l)) && !run.added.some((l) => keyLine(k).test(l)));
        const restores = [...new Set(runs.flatMap((run) => (typeof run === 'object' ? restoring(run) : [])))];
        if (!restores.length) return [];
        const find = runs.flatMap((run) => (typeof run === 'object' ? run.added : [run])).join('\n');
        const replace = runs.flatMap((run) => (typeof run !== 'object' ? [run] : restoring(run).length ? run.removed : run.added)).join('\n');
        const removed = runs.flatMap((run) => (typeof run === 'object' && restoring(run).length ? run.removed : []));
        // The hunk must still be in the file as that commit left it, exactly once.
        return find.trim() && f.content.split(find).length === 2 ? [{ find, replace, removed, restores }] : [];
      });
      if (!hunks.length) continue;
      for (const h of hunks) {
        const lines = h.removed.map((l) => l.trim()).filter(Boolean);
        fixes.push({
          revision: r,
          removed: lines,
          keys: h.restores,
          diff: recentChange(f.path, after, r),
          change: {
            file: f.path,
            description:
              `Restore the line(s) commit ${r.sha.slice(0, 7)} ("${r.message}") removed: ${lines.join(' / ')} ` +
              `(fix derived by Nagent from the repository history).`,
            find: h.find,
            replace: h.replace,
          },
        });
      }
      break;
    }
  }
  return fixes;
}

/** The newest commit's diff to a file, for the model: what changed right before things broke. */
export function recentChange(path: string, content: string, r: FileRevision): string | null {
  if (r.before === null || r.before === content) return null;
  const diff = unifiedDiff(path, r.before, content).split('\n').slice(2).join('\n');
  const text = diff.length > 3000 ? `${diff.slice(0, 3000)}\n…[truncated]` : diff;
  return `--- RECENT CHANGE: ${path}, commit ${r.sha.slice(0, 7)} "${r.message}" (the newest commit that changed this file) ---\n${text}\n--- END CHANGE ---`;
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
    if (/\.ya?ml$/i.test(c.path) && /^apiVersion:/m.test(after) && /^kind:/m.test(after) && !after.includes('{{')) {
      const problems = k8sProblems(after);
      checks.push({
        name: 'kubernetes',
        file: c.path,
        status: problems.length ? 'failed' : 'passed',
        detail: problems.length
          ? `The Kubernetes API would still reject this manifest: ${problems.map((p) => p.message).join('; ').slice(0, 600)}`
          : 'Every object has a kind and metadata.name; workloads have containers with a name and image; no probes on plain init containers',
      });
    }
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
