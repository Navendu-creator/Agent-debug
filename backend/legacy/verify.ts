import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { runInWorkspace } from './workspace.js';

/**
 * Deterministic verification: picks checks from the files involved, so "tested" does not depend on
 * the LLM choosing (and running from the right directory) the right command.
 */

export interface CheckResult {
  command: string;
  exitCode: number;
  output: string;
}

function findUp(root: string, relFile: string, marker: string): string | undefined {
  let dir = dirname(relFile);
  while (true) {
    if (existsSync(join(root, dir, marker))) return dir;
    if (dir === '.' || dir === '' || dir === '/') return undefined;
    dir = dirname(dir);
  }
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function checksFor(root: string, files: string[]): string[] {
  const checks = new Set<string>();
  if (config.testCommand) checks.add(config.testCommand);

  for (const f of files) {
    const chart = findUp(root, f, 'Chart.yaml');
    if (chart) {
      checks.add(`helm lint ${q(chart)}`);
      checks.add(`helm template debugassist-check ${q(chart)} > /dev/null`);
      continue;
    }
    if (/\.(tf|tfvars)$/.test(f)) {
      const dir = dirname(f);
      checks.add(`terraform fmt -check -diff ${q(f)}`);
      checks.add(
        `terraform -chdir=${q(dir)} init -backend=false -input=false -no-color > /dev/null && terraform -chdir=${q(dir)} validate -no-color`,
      );
    } else if (/\.sh$/.test(f)) {
      checks.add(`bash -n ${q(f)}`);
    } else if (/\.ya?ml$/.test(f)) {
      checks.add(`python3 -c 'import sys,yaml; list(yaml.safe_load_all(open(sys.argv[1])))' ${q(f)}`);
      if (/(^|\/)k8s\//.test(f)) checks.add(`kubectl apply --dry-run=client --validate=false -f ${q(f)} -o name`);
    } else if (/\.json$/.test(f)) {
      checks.add(`python3 -m json.tool ${q(f)} > /dev/null`);
    } else if (/\.(java|gradle|xml)$/.test(f)) {
      const mvn = findUp(root, f, 'pom.xml');
      if (mvn) checks.add(`cd ${q(mvn)} && mvn -q -o test || mvn -q test`);
    }
  }
  return [...checks];
}

export async function runChecks(root: string, commands: string[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    const r = await runInWorkspace(root, command, 600_000);
    results.push({ command, exitCode: r.exitCode, output: r.output });
  }
  return results;
}

export function formatChecks(results: CheckResult[], maxPerCheck = 1500): string {
  return results
    .map((r) => {
      const out = r.output.trim();
      const tail = out.length > maxPerCheck ? `…${out.slice(-maxPerCheck)}` : out;
      return `$ ${r.command}\nexit ${r.exitCode}${tail ? `\n${tail}` : ''}`;
    })
    .join('\n\n');
}
