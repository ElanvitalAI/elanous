// GH-MIRROR-ORIGIN-URL-SAFE — a repo whose origin fetch is rewritten to a local mirror (url.<mirror>.insteadOf, as the GH proxy
// sets on ~/elanous-hq/repo.git) still names its GitHub repository to every reader. Real temp repos · literal expectations (rule 11).
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRemoteUrl, remoteUrlShell, remoteUrlVia, remoteUrlViaAsync } from './origin-url.js';
import { resolveLandRepo } from '../cli/land-graph-cli.js';
import { listOpenCellPullRequests } from '../cli/release-manual-seat-claim.js';
import { inspectHarnessCommandWriteTargets } from '../harness/harness-write-boundary.js';

const UPSTREAM = 'https://github.com/acme/widget.git';
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
/** A checkout (or bare repo) with origin = UPSTREAM, fetch mirrored to a local path · push kept on GitHub (pushInsteadOf). */
function mirrored(opts: { bare?: boolean; pushInsteadOf?: boolean } = {}): { dir: string; mirror: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'origin-url-')));
  const dir = join(base, opts.bare ? 'repo.git' : 'work'); const mirror = join(base, 'mirror', 'elanous-agent.git');
  spawnSync('git', ['init', '-q', ...(opts.bare ? ['--bare'] : []), dir]);
  git(dir, 'remote', 'add', 'origin', UPSTREAM);
  git(dir, 'config', `url.${mirror}.insteadOf`, UPSTREAM);
  if (opts.pushInsteadOf !== false) git(dir, 'config', `url.${UPSTREAM}.pushInsteadOf`, UPSTREAM);
  return { dir, mirror };
}

describe('origin URL door (src/git-fs/origin-url.ts)', () => {
  test('insteadOf on: get-url names the mirror path, the door names GitHub (checkout · bare · no pushInsteadOf)', () => {
    const { dir, mirror } = mirrored();
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(mirror); // the failure mode, as observed on repo.git
    expect(readRemoteUrl(dir)).toBe('https://github.com/acme/widget.git');
    expect(readRemoteUrl(mirrored({ bare: true }).dir)).toBe('https://github.com/acme/widget.git');
    expect(readRemoteUrl(mirrored({ pushInsteadOf: false }).dir)).toBe('https://github.com/acme/widget.git');
  });
  test('no origin → null · another remote name is read the same way', () => {
    const { dir } = mirrored();
    expect(readRemoteUrl(dir, { remote: 'upstream' })).toBeNull();
    git(dir, 'remote', 'add', 'upstream', 'git@github.com:acme/upstream.git');
    expect(readRemoteUrl(dir, { remote: 'upstream' })).toBe('git@github.com:acme/upstream.git');
  });
  test('runner form: raw config first · push URL when the config read fails · a throwing runner is a failure', async () => {
    const asked: string[] = [];
    expect(remoteUrlVia((argv) => { asked.push(argv.join(' ')); return argv[0] === 'config' ? 'https://github.com/acme/widget.git\n' : 'x'; })).toBe('https://github.com/acme/widget.git');
    expect(asked).toEqual(['config --get remote.origin.url']);
    asked.length = 0;
    expect(remoteUrlVia((argv) => { asked.push(argv.join(' ')); return argv[0] === 'config' ? null : 'git@github.com:acme/widget.git\n'; })).toBe('git@github.com:acme/widget.git');
    expect(asked).toEqual(['config --get remote.origin.url', 'remote get-url --push origin']);
    expect(remoteUrlVia(() => { throw new Error('spawn failed'); })).toBeNull();
    expect(await remoteUrlViaAsync(async (argv) => (argv[0] === 'config' ? '' : 'https://github.com/acme/widget.git'))).toBe('https://github.com/acme/widget.git');
  });
  test('shell form for remote hosts', () => {
    expect(remoteUrlShell('"$repo"')).toBe('{ git --git-dir="$repo" config --get remote.origin.url || git --git-dir="$repo" remote get-url --push origin; }');
    const { dir } = mirrored({ bare: true });
    const r = spawnSync('sh', ['-c', `repo='${dir}'; printf '%s' "$(${remoteUrlShell('"$repo"')})"`], { encoding: 'utf8' });
    expect(r.stdout).toBe('https://github.com/acme/widget.git');
  });
});

describe('readers on a mirrored repo name the GitHub repository', () => {
  test('land graph: resolveLandRepo slug', () => {
    const { dir } = mirrored({ bare: true });
    expect(resolveLandRepo({ env: {}, defaultRoot: dir })).toEqual({ root: dir, slug: 'acme/widget' });
  });
  test('release manual seat claim: gh pr list is pinned to acme/widget (was «origin is not a supported GitHub repository URL»)', () => {
    const { dir } = mirrored();
    const gh: string[][] = [];
    const rows = listOpenCellPullRequests('CELL-X', dir, (command, args, cwd) => {
      if (command === 'git') { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return { status: r.status, stdout: r.stdout ?? '' }; }
      gh.push([...args]); return { status: 0, stdout: '[]' };
    });
    expect(rows).toEqual([]);
    expect(gh[0]!.slice(0, 4)).toEqual(['pr', 'list', '--repo', 'acme/widget']);
  });
  test('harness write boundary: the door\'s read is observation · a config write stays undecided', () => {
    const { dir } = mirrored();
    expect(inspectHarnessCommandWriteTargets(['git', 'config', '--get', 'remote.origin.url'], dir)).toEqual({ targets: [], known: true });
    expect(inspectHarnessCommandWriteTargets(['git', 'remote', 'get-url', '--push', 'origin'], dir)).toEqual({ targets: [], known: true });
    expect(inspectHarnessCommandWriteTargets(['git', 'config', 'remote.origin.url', 'x'], dir).known).toBe(false);
    expect(inspectHarnessCommandWriteTargets(['git', 'config', '--get', '--file=/tmp/x', 'a.b'], dir).known).toBe(false);
  });
});
