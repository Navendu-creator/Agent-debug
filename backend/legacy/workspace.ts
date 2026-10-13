import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';

/**
 * Git checkout + sandboxed command execution for the local agent.
 * Each incident gets its own clone under WORKSPACE_DIR; agent commands run inside bubblewrap with
 * the host filesystem read-only, $HOME and /tmp hidden, and an empty environment (no secrets).
 */

export interface Workspace {
  dir: string;
  branch: string;
}

export interface CommandResult {
  exitCode: number;
  output: string;
}

const hasBwrap = spawnSync('bwrap', ['--version']).status === 0;

export function sandboxMode(): 'bwrap' | 'none' {
  if (config.sandbox === 'none') return 'none';
  if (config.sandbox === 'bwrap' && !hasBwrap) {
    throw new Error('SANDBOX=bwrap but bubblewrap (bwrap) is not installed');
  }
  return hasBwrap ? 'bwrap' : 'none';
}

function githubAuthArgs(): string[] {
  if (!config.githubToken || !/github\.com/i.test(config.githubRepoUrl)) return [];
  const basic = Buffer.from(`x-access-token:${config.githubToken}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

export function git(dir: string | undefined, args: string[], withAuth = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...(withAuth ? githubAuthArgs() : []), ...args],
      { cwd: dir, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        // Never echo the auth header back into errors/timelines.
        if (err) reject(new Error(`git ${args[0]} failed: ${stderr.replace(/Basic \S+/g, 'Basic ***').trim()}`));
        else resolve(stdout);
      },
    );
  });
}

export async function prepareWorkspace(incidentId: string, branch: string): Promise<Workspace> {
  const dir = join(config.workspaceDir, incidentId.toLowerCase());
  await mkdir(config.workspaceDir, { recursive: true });
  await rm(dir, { recursive: true, force: true });
  await git(undefined, ['clone', '--depth', '50', '--branch', config.githubRepoRef, config.githubRepoUrl, dir], true);
  await git(dir, ['checkout', '-b', branch]);
  await git(dir, ['config', 'user.name', 'DebugAssist']);
  await git(dir, ['config', 'user.email', 'debugassist@users.noreply.github.com']);
  return { dir, branch };
}

export function runInWorkspace(dir: string, command: string, timeoutMs = 300_000): Promise<CommandResult> {
  const mode = sandboxMode();
  const home = homedir();
  const [cmd, args] =
    mode === 'bwrap'
      ? [
          'bwrap',
          [
            '--ro-bind', '/', '/',
            '--dev', '/dev',
            '--proc', '/proc',
            '--tmpfs', '/tmp',
            '--tmpfs', home,
            '--bind', dir, dir,
            '--chdir', dir,
            '--unshare-pid',
            '--die-with-parent',
            '--clearenv',
            '--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            '--setenv', 'HOME', home,
            '--setenv', 'TF_IN_AUTOMATION', '1',
            '--setenv', 'CI', 'true',
            'bash', '-lc', command,
          ],
        ]
      : ['bash', ['-lc', command]];

  return new Promise((resolve) => {
    const child = spawn(cmd as string, args as string[], {
      cwd: dir,
      env: mode === 'bwrap' ? {} : { PATH: process.env.PATH ?? '', HOME: home, CI: 'true' },
    });
    let output = '';
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      output += `\n[killed: exceeded ${timeoutMs / 1000}s]`;
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 137, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, output: err.message });
    });
  });
}

export async function changedFiles(dir: string): Promise<string[]> {
  const out = await git(dir, ['status', '--porcelain', '--untracked-files=all']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, ''));
}

export async function diffStat(dir: string): Promise<string> {
  await git(dir, ['add', '-A']);
  return git(dir, ['diff', '--cached', '--stat']);
}

export async function fullDiff(dir: string): Promise<string> {
  await git(dir, ['add', '-A']);
  return git(dir, ['diff', '--cached']);
}

/** Drops every working-tree change (used when the agent could not produce a passing fix). */
export async function discardChanges(dir: string): Promise<void> {
  await git(dir, ['reset', '--hard', 'HEAD']);
  await git(dir, ['clean', '-fdx']);
}

/** Commits everything; returns false when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, ['add', '-A']);
  const staged = await git(dir, ['diff', '--cached', '--name-only']);
  if (!staged.trim()) return false;
  await git(dir, ['commit', '-m', message]);
  return true;
}

export async function pushBranch(ws: Workspace): Promise<void> {
  await git(ws.dir, ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${ws.branch}`], true);
}

function githubRepoSlug(): string {
  const m = config.githubRepoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  if (!m) throw new Error(`Not a GitHub repo URL: ${config.githubRepoUrl}`);
  return `${m[1]}/${m[2]}`;
}

export async function openPullRequest(input: {
  branch: string;
  title: string;
  body: string;
  draft: boolean;
}): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${githubRepoSlug()}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'debugassist',
    },
    body: JSON.stringify({
      title: input.title,
      head: input.branch,
      base: config.githubRepoRef,
      body: input.body,
      draft: input.draft,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { html_url?: string; message?: string; errors?: unknown };
  if (!res.ok || !data.html_url) {
    throw new Error(`GitHub PR creation failed (HTTP ${res.status}): ${data.message ?? ''} ${JSON.stringify(data.errors ?? '')}`);
  }
  return data.html_url;
}

export async function removeWorkspace(ws: Workspace): Promise<void> {
  await rm(ws.dir, { recursive: true, force: true });
}
