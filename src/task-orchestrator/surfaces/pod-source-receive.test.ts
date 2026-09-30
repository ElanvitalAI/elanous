import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packSourceBundle } from './pod-source-bundle.js';
import { podSourceScript, type PodSource } from './pod-source-receive.js';

describe('podSourceScript', () => {
  test('default prefers the mirror, restores origin and reports its route', () => {
    const script = podSourceScript({ kind: 'default' }, 'https://github.com/o/r');
    expect(script).toContain("git clone -q --shared -- '/host-mirror' repo");
    expect(script).toContain("git -C repo remote set-url origin 'https://github.com/o/r'");
    expect(script).toContain("git clone -q --depth 50 'https://github.com/o/r' repo");
    expect(script).toContain("printf 'ELANOUS_POD_SOURCE_VIA %s\\n'");
    expect(script).toContain("printf 'ELANOUS_POD_SOURCE default %s\\n'");
  });

  test('rejects a non-40-hex sha and a non-positive PR before interpolation', () => {
    expect(() => podSourceScript({ kind: 'commit', sha: 'abc;rm -rf /' }, 'https://github.com/o/r')).toThrow(/40 hex/);
    expect(() => podSourceScript({ kind: 'pr', number: Number('1;x') }, 'https://github.com/o/r')).toThrow(/positive integer/);
    const sha = 'a'.repeat(40);
    const commit = podSourceScript({ kind: 'commit', sha }, 'https://github.com/o/r');
    expect(commit).toContain(`git cat-file -e '${sha}^{commit}'`);
    expect(commit).toContain(`git fetch --depth 1 origin ${sha}`);
    expect(commit).toContain(`git checkout --detach ${sha}`);
    expect(commit).not.toContain('rm -rf');
    const pr = podSourceScript({ kind: 'pr', number: 7 }, 'https://github.com/o/r');
    expect(pr).toContain('git fetch --depth 50 origin pull/7/head');
    expect(pr).toContain('git checkout -B pr-7 "$pr_sha"');
  });

  test('mirror freshness and SHA membership select fetch only when needed without writing to mirror', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-src-mirror-'));
    try {
      const origin = join(root, 'origin');
      const mirror = join(root, 'mirror.git');
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', origin, 'config', 'user.name', 'pod']);
      writeFileSync(join(origin, 'README'), 'base\n');
      execFileSync('git', ['-C', origin, 'add', 'README']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'base']);
      const base = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', '--bare', origin, mirror]);
      const run = (name: string, source: PodSource, useMirror = true) => {
        const cwd = join(root, name);
        execFileSync('mkdir', ['-p', cwd]);
        const script = podSourceScript(source, origin, useMirror ? mirror : join(root, 'absent'));
        const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        return { cwd, output: result.stdout.toString() };
      };
      const fresh = run('fresh', { kind: 'default' });
      expect(fresh.output).not.toContain('ELANOUS_POD_SOURCE_VIA github');
      expect(fresh.output).toContain(`ELANOUS_POD_SOURCE_VIA mirror\nELANOUS_POD_SOURCE default ${base}`);
      expect(execFileSync('git', ['-C', join(fresh.cwd, 'repo'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()).toBe(origin);
      writeFileSync(join(origin, 'README'), 'new\n');
      execFileSync('git', ['-C', origin, 'commit', '-qam', 'new']);
      const head = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const stale = run('stale', { kind: 'default' });
      expect(stale.output).toContain(`ELANOUS_POD_SOURCE default ${head}`);
      expect(execFileSync('git', ['-C', mirror, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(base);
      const present = run('present', { kind: 'commit', sha: base });
      expect(present.output).toContain(`ELANOUS_POD_SOURCE commit ${base}`);
      const missing = run('missing', { kind: 'commit', sha: head });
      expect(missing.output).toContain(`ELANOUS_POD_SOURCE commit ${head}`);
      expect(existsSync(join(present.cwd, 'repo', '.git', 'FETCH_HEAD'))).toBe(false);
      expect(existsSync(join(missing.cwd, 'repo', '.git', 'FETCH_HEAD'))).toBe(true);
      expect(existsSync(join(fresh.cwd, 'repo', '.git', 'FETCH_HEAD'))).toBe(false);
      expect(existsSync(join(stale.cwd, 'repo', '.git', 'FETCH_HEAD'))).toBe(true);
      execFileSync('git', ['-C', origin, 'update-ref', 'refs/pull/7/head', head]);
      const pr = run('pr-present', { kind: 'pr', number: 7 });
      expect(pr.output).toContain(`ELANOUS_POD_SOURCE pr ${head}`);
      expect(existsSync(join(pr.cwd, 'repo', '.git', 'FETCH_HEAD'))).toBe(true);
      execFileSync('git', ['-C', mirror, 'fetch', '-q', origin, 'refs/pull/7/head:refs/heads/pr-7']);
      const cachedPr = run('pr-cached', { kind: 'pr', number: 7 });
      expect(cachedPr.output).toContain(`ELANOUS_POD_SOURCE pr ${head}`);
      expect(existsSync(join(cachedPr.cwd, 'repo', '.git', 'FETCH_HEAD'))).toBe(false);
      execFileSync('git', ['-C', origin, 'checkout', '-q', '--detach', base]);
      writeFileSync(join(origin, 'README'), 'forced PR\n');
      execFileSync('git', ['-C', origin, 'commit', '-qam', 'forced PR']);
      const forcedPrSha = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', origin, 'update-ref', 'refs/pull/7/head', forcedPrSha]);
      execFileSync('git', ['-C', origin, 'checkout', '-q', 'main']);
      expect(execFileSync('git', ['-C', mirror, 'rev-parse', 'refs/heads/pr-7'], { encoding: 'utf8' }).trim()).toBe(head);
      expect(execFileSync('git', ['-C', mirror, 'symbolic-ref', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('refs/heads/main');
      const forcedPr = run('pr-forced', { kind: 'pr', number: 7 });
      expect(forcedPr.output).toContain(`ELANOUS_POD_SOURCE pr ${forcedPrSha}`);
      expect(execFileSync('git', ['-C', join(forcedPr.cwd, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(forcedPrSha);
      expect(existsSync(join(forcedPr.cwd, 'repo', '.git', 'FETCH_HEAD'))).toBe(true);
      expect(execFileSync('git', ['-C', mirror, 'rev-parse', 'refs/heads/pr-7'], { encoding: 'utf8' }).trim()).toBe(head);
      expect(execFileSync('git', ['-C', mirror, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(base);
      expect(execFileSync('git', ['-C', join(forcedPr.cwd, 'repo'), 'rev-parse', 'refs/heads/pr-7'], { encoding: 'utf8' }).trim()).toBe(forcedPrSha);
      execFileSync('git', ['-C', mirror, 'symbolic-ref', 'HEAD', 'refs/heads/pr-7']);
      const forcedCheckedOut = run('pr-forced-checked-out', { kind: 'pr', number: 7 });
      expect(forcedCheckedOut.output).toContain('ELANOUS_POD_SOURCE_VIA mirror\n');
      expect(forcedCheckedOut.output).toContain(`ELANOUS_POD_SOURCE pr ${forcedPrSha}`);
      expect(execFileSync('git', ['-C', join(forcedCheckedOut.cwd, 'repo'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()).toBe(origin);
      expect(execFileSync('git', ['-C', join(forcedCheckedOut.cwd, 'repo'), 'rev-parse', 'refs/heads/pr-7'], { encoding: 'utf8' }).trim()).toBe(forcedPrSha);
      expect(execFileSync('git', ['-C', mirror, 'rev-parse', 'refs/heads/pr-7'], { encoding: 'utf8' }).trim()).toBe(head);
      execFileSync('git', ['-C', mirror, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
      const fallback = run('fallback', { kind: 'default' }, false);
      expect(fallback.output).toContain(`ELANOUS_POD_SOURCE_VIA github\nELANOUS_POD_SOURCE default ${head}`);
      const brokenMirror = join(root, 'broken-mirror');
      execFileSync('git', ['init', '-q', '--bare', brokenMirror]);
      const brokenCwd = join(root, 'broken');
      execFileSync('mkdir', ['-p', brokenCwd]);
      const brokenResult = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, brokenMirror)}`], { cwd: brokenCwd });
      expect(brokenResult.exitCode).toBe(0);
      expect(brokenResult.stdout.toString()).toContain(`ELANOUS_POD_SOURCE_VIA github\nELANOUS_POD_SOURCE default ${head}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fetches a thin bundle into a mirror clone and checks out the packed commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-src-thin-'));
    try {
      const remote = join(root, 'origin.git');
      const origin = join(root, 'origin');
      const mirror = join(root, 'mirror.git');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', origin, 'config', 'user.name', 'pod']);
      writeFileSync(join(origin, 'README'), 'mirror base\n');
      execFileSync('git', ['-C', origin, 'add', 'README']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'base']);
      execFileSync('git', ['-C', origin, 'remote', 'add', 'origin', remote]);
      execFileSync('git', ['-C', origin, 'push', '-q', 'origin', 'main']);
      execFileSync('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
      const mirrorHead = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', '--bare', remote, mirror]);
      writeFileSync(join(origin, 'README'), 'new base\n');
      execFileSync('git', ['-C', origin, 'commit', '-qam', 'advance']);
      execFileSync('git', ['-C', origin, 'push', '-q', 'origin', 'main']);
      const base = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      writeFileSync(join(origin, 'README'), 'local contents\n');
      const packed = packSourceBundle({ repoDir: origin, kind: 'worktree', base, mirrorHead, outDir: join(root, 'out') });
      const source: PodSource = { kind: 'bundle', ...packed };
      const empty = join(root, 'empty');
      execFileSync('git', ['init', '-q', empty]);
      expect(() => execFileSync('git', ['-C', empty, 'bundle', 'verify', packed.bundlePath], { stdio: 'pipe' })).toThrow();
      const run = (name: string, path: string) => {
        const cwd = join(root, name);
        execFileSync('mkdir', ['-p', join(cwd, 'tmp')]);
        const script = podSourceScript(source, remote, path).replaceAll('/tmp/source.', `${cwd}/tmp/source.`);
        writeFileSync(join(cwd, 'tmp', 'source.bundle'), readFileSync(packed.bundlePath));
        writeFileSync(join(cwd, 'tmp', 'source.ready'), '');
        return { cwd, result: Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd }) };
      };
      const thin = run('thin', mirror);
      expect(thin.result.exitCode, thin.result.stderr.toString()).toBe(0);
      expect(thin.result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE bundle ${packed.headCommit}`);
      expect(execFileSync('git', ['-C', join(thin.cwd, 'repo'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()).toBe(remote);
      expect(execFileSync('git', ['-C', join(thin.cwd, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(packed.headCommit);
      expect(readFileSync(join(thin.cwd, 'repo', 'README'), 'utf8')).toBe('local contents\n');
      expect(execFileSync('git', ['-C', mirror, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(mirrorHead);
      const noMirror = run('no-mirror-thin', join(root, 'absent'));
      expect(noMirror.result.exitCode).not.toBe(0);
      expect(noMirror.result.stdout.toString()).not.toContain('ELANOUS_POD_SOURCE bundle');
      const unrelated = join(root, 'unrelated');
      const missingBaseMirror = join(root, 'missing-base.git');
      execFileSync('git', ['init', '-q', '-b', 'main', unrelated]);
      execFileSync('git', ['-C', unrelated, '-c', 'user.name=pod', '-c', 'user.email=pod@example.com', 'commit', '-qm', 'unrelated', '--allow-empty']);
      execFileSync('git', ['clone', '-q', '--bare', unrelated, missingBaseMirror]);
      const missingBaseThin = run('missing-base-thin', missingBaseMirror);
      expect(missingBaseThin.result.exitCode).not.toBe(0);
      expect(missingBaseThin.result.stdout.toString()).not.toContain('ELANOUS_POD_SOURCE bundle');
      expect(() => execFileSync('git', ['-C', missingBaseMirror, 'bundle', 'verify', packed.bundlePath], { stdio: 'pipe' })).toThrow();
      const full = packSourceBundle({ repoDir: origin, kind: 'worktree', base, outDir: join(root, 'full-out') });
      expect(execFileSync('git', ['-C', missingBaseMirror, 'bundle', 'verify', full.bundlePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toContain('complete history');
      const fullSource: PodSource = { kind: 'bundle', ...full };
      for (const [name, path] of [['absent', join(root, 'absent')], ['missing-base', missingBaseMirror]] as const) {
        const cwd = join(root, name);
        execFileSync('mkdir', ['-p', join(cwd, 'tmp')]);
        writeFileSync(join(cwd, 'tmp', 'source.bundle'), readFileSync(full.bundlePath));
        writeFileSync(join(cwd, 'tmp', 'source.ready'), '');
        const script = podSourceScript(fullSource, remote, path).replaceAll('/tmp/source.', `${cwd}/tmp/source.`);
        const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE bundle ${full.headCommit}`);
        expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(full.headCommit);
        expect(readFileSync(join(cwd, 'repo', 'README'), 'utf8')).toBe('local contents\n');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bundle script clones the verified bundle and refuses a one-character sha256 change', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-src-'));
    const work = mkdtempSync(join(tmpdir(), 'pod-src-run-'));
    try {
      const origin = join(root, 'origin');
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', origin, 'config', 'user.name', 'pod']);
      writeFileSync(join(origin, 'README'), 'base\n');
      execFileSync('git', ['-C', origin, 'add', 'README']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'base']);
      writeFileSync(join(origin, 'README'), 'head\n');
      execFileSync('git', ['-C', origin, 'add', 'README']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'head']);
      const headCommit = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const bundlePath = join(root, 'source.bundle');
      execFileSync('git', ['-C', origin, 'bundle', 'create', bundlePath, 'HEAD', '--']);
      const bytes = readFileSync(bundlePath);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const source: PodSource = { kind: 'bundle', bundlePath, sha256, sizeBytes: statSync(bundlePath).size, headCommit };
      const script = podSourceScript(source, 'https://github.com/o/r');
      const good = join(work, 'good');
      execFileSync('mkdir', ['-p', join(good, 'tmp')]);
      const staged = script.replaceAll('/tmp/', `${good}/tmp/`);
      writeFileSync(join(good, 'run.sh'), `cp ${bundlePath} ${good}/tmp/source.bundle\ntouch ${good}/tmp/source.ready\n${staged}\n`);
      const ok = Bun.spawnSync(['bash', join(good, 'run.sh')], { cwd: good });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.toString()).toContain(`ELANOUS_POD_SOURCE bundle ${headCommit}`);
      expect(execFileSync('git', ['-C', join(good, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(headCommit);

      const bad = join(work, 'bad');
      execFileSync('mkdir', ['-p', join(bad, 'tmp')]);
      const flipped = `${sha256.slice(0, -1)}${sha256.endsWith('a') ? 'b' : 'a'}`;
      const mismatch = podSourceScript({ ...source, sha256: flipped }, 'https://github.com/o/r').replaceAll('/tmp/', `${bad}/tmp/`);
      writeFileSync(join(bad, 'run.sh'), `cp ${bundlePath} ${bad}/tmp/source.bundle\ntouch ${bad}/tmp/source.ready\n${mismatch}\n`);
      const fail = Bun.spawnSync(['bash', join(bad, 'run.sh')], { cwd: bad });
      expect(fail.exitCode).toBe(3);
      expect(fail.stdout.toString()).toContain('ELANOUS_POD_SOURCE_MISMATCH');
      expect(fail.stdout.toString()).not.toContain('ELANOUS_POD_SOURCE bundle');
      let repoExists = true;
      try { statSync(join(bad, 'repo')); } catch { repoExists = false; }
      expect(repoExists).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
