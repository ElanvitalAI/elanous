import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';

export interface DevProjectDeps {
  git?: (dir: string, args: readonly string[]) => string | null;
  stateDir?: string;
}

interface DevProjectRegistry {
  projects: Record<string, string>;
}

interface DevProjectCache {
  identityKey: string;
  devProject: string;
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function resolveDevProject(dir: string, deps: DevProjectDeps = {}): string {
  const suppliedDir = resolve(dir);
  const git = deps.git ?? runGit;
  const gitRoot = git(suppliedDir, ['rev-parse', '--show-toplevel'])?.trim();
  const root = gitRoot ? resolve(gitRoot) : suppliedDir;
  let identityKey: string;
  // A repo with no commit yet (`git init` only) has no first commit to anchor on — it falls back to
  // the path identity like a plain folder until its first commit exists.
  const rootCommits = gitRoot
    ? git(root, ['rev-list', '--max-parents=0', 'HEAD'])?.trim().split(/\s+/).filter(Boolean) ?? []
    : [];

  if (rootCommits.length > 0) {
    const firstCommit = rootCommits.length === 1 ? rootCommits[0]! : rootCommits
      .map((commit) => ({
        commit,
        timestamp: Number(git(root, ['show', '-s', '--format=%ct', commit])?.trim()),
      }))
      .filter(({ timestamp }) => Number.isFinite(timestamp))
      .sort((left, right) => left.timestamp - right.timestamp || left.commit.localeCompare(right.commit))[0]?.commit;
    if (!firstCommit) throw new Error(`Unable to resolve oldest root commit for git project at ${root}`);
    const remote = git(root, ['remote', 'get-url', 'origin']);
    identityKey = `git:${firstCommit}:${normalizeRemoteUrl(remote ?? '')}`;
  } else {
    identityKey = `path:${createHash('sha256').update(root).digest('hex')}`;
  }

  const stateDir = resolve(deps.stateDir ?? elanousStateRoot());
  const registryPath = join(stateDir, 'dev-projects.json');
  const registry = readRegistry(registryPath);
  const id = registry.projects[identityKey] ?? newDevProjectId();
  if (!registry.projects[identityKey]) {
    registry.projects[identityKey] = id;
    writeJsonAtomically(registryPath, registry);
  }

  // The cache is disposable (RFC §4f): a read-only root must not stop the id from resolving.
  try {
    writeJsonAtomically(join(root, '.elanous', 'project.json'), { identityKey, devProject: id } satisfies DevProjectCache);
  } catch { /* cache only */ }
  return id;
}

function runGit(dir: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function normalizeRemoteUrl(remote: string): string {
  const value = remote.trim();
  if (!value) return '';

  const scp = /^(?![a-z][a-z0-9+.-]*:\/\/)(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp) return normalizeRemotePath(`${scp[1]!.toLowerCase()}/${scp[2]}`);

  try {
    const url = new URL(value);
    return normalizeRemotePath(`${url.hostname.toLowerCase()}${url.pathname}`);
  } catch {
    return normalizeRemotePath(resolve(value));
  }
}

function normalizeRemotePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '');
}

/**
 * The registry is the source of truth for prj- ids. A missing file starts a fresh registry; an
 * existing but unreadable/corrupt one throws instead of silently re-issuing every project a new id.
 */
function readRegistry(path: string): DevProjectRegistry {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects: {} };
    throw error;
  }
  let parsed: Partial<DevProjectRegistry> | undefined;
  try { parsed = JSON.parse(raw) as Partial<DevProjectRegistry>; } catch { parsed = undefined; }
  if (parsed?.projects && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)) {
    return { projects: parsed.projects as Record<string, string> };
  }
  throw new Error(`dev-projects registry is corrupt: ${path}`);
}

function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${newDevProjectId()}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporaryPath, path);
}

function newDevProjectId(): string {
  const now = BigInt(Date.now());
  let timestamp = '';
  for (let index = 9; index >= 0; index -= 1) {
    timestamp += ULID_ALPHABET[Number((now >> BigInt(index * 5)) & 31n)];
  }

  const entropy = BigInt(`0x${randomBytes(10).toString('hex')}`);
  let random = '';
  for (let index = 15; index >= 0; index -= 1) {
    random += ULID_ALPHABET[Number((entropy >> BigInt(index * 5)) & 31n)];
  }
  return `prj-${timestamp}${random}`;
}
