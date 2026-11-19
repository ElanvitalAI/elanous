// Pane reports describe the running TUI, not the els server or its working tree.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export type BuildAge = 'current' | 'older' | 'different' | 'unknown';
export function desiredSha(path = join(homedir(), 'elanous-hq/seat-state/OP/rail/DESIRED.json')): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8')).sha;
    return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : undefined;
  } catch { return undefined; }
}
export function buildAge(sha: string | undefined, desired: string | undefined, ancestor: (a: string, b: string) => boolean | undefined): BuildAge {
  if (!sha || !desired || !/^[a-f0-9]{40}$/i.test(sha)) return 'unknown';
  if (sha.toLowerCase() === desired.toLowerCase()) return 'current';
  const older = ancestor(sha, desired);
  return older === true ? 'older' : older === false ? 'different' : 'unknown';
}
const ages = new Map<string, boolean | undefined>();
export function gitAncestor(a: string, b: string): boolean | undefined {
  const key = `${a}:${b}`;
  if (ages.has(key)) return ages.get(key);
  const gitDir = join(homedir(), 'elanous-hq/repo.git');
  const result = spawnSync('git', ['--git-dir', gitDir, 'merge-base', '--is-ancestor', a, b], { timeout: 1000, stdio: 'ignore' });
  const value = result.status === 0 ? true : result.status === 1 ? false : undefined;
  if (value !== undefined) ages.set(key, value);
  return value;
}
