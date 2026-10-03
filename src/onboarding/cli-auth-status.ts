import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type SkillCli = 'gh' | 'gws' | 'op' | 'himalaya';

export interface CliAuthStatus {
  cli: SkillCli;
  found: boolean;
  authenticated: boolean;
  skippedReason?: string;
}

export interface CliAuthStatusDeps {
  path?: string;
  findExecutable?: (name: SkillCli, path: string) => string | null;
  runStatus?: (executable: string, args: readonly string[]) => { status: number | null; stdout?: string; error?: unknown };
}

const STATUS_COMMANDS: readonly { cli: SkillCli; args: readonly string[] }[] = [
  { cli: 'gh', args: ['auth', 'status'] },
  { cli: 'gws', args: ['auth', 'status'] },
  { cli: 'op', args: ['whoami'] },
  { cli: 'himalaya', args: ['account', 'check'] },
];

function findOnPath(name: SkillCli, path: string): string | null {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const executable = join(directory, name);
    try {
      accessSync(executable, constants.X_OK);
      if (statSync(executable).isFile()) return executable;
    } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

function runReadOnlyStatus(executable: string, args: readonly string[]) {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return { status: result.status, stdout: result.stdout, error: result.error };
}

function gwsHasSession(stdout: string | undefined): boolean {
  try {
    const status: unknown = JSON.parse(stdout ?? '');
    if (!status || typeof status !== 'object' || Array.isArray(status)) return false;
    const auth = status as Record<string, unknown>;
    return auth.token_valid === true;
  } catch {
    return false;
  }
}

/** No credential-file reads, login calls, prompts, or token-bearing output leave this probe. */
export function detectSkillCliAuth(deps: CliAuthStatusDeps = {}): CliAuthStatus[] {
  const path = deps.path ?? process.env.PATH ?? '';
  const find = deps.findExecutable ?? findOnPath;
  const run = deps.runStatus ?? runReadOnlyStatus;
  return STATUS_COMMANDS.map(({ cli, args }) => {
    let executable: string | null;
    try { executable = find(cli, path); }
    catch { executable = null; }
    if (!executable) return { cli, found: false, authenticated: false, skippedReason: 'not on PATH' };
    try {
      const result = run(executable, args);
      if (result.error || result.status === null) {
        return { cli, found: true, authenticated: false, skippedReason: 'status check unavailable' };
      }
      if (result.status !== 0 || (cli === 'gws' && !gwsHasSession(result.stdout))) {
        return { cli, found: true, authenticated: false, skippedReason: 'not authenticated' };
      }
      return { cli, found: true, authenticated: true };
    } catch {
      return { cli, found: true, authenticated: false, skippedReason: 'status check unavailable' };
    }
  });
}
