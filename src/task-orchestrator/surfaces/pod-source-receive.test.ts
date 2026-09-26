import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { podSourceScript, type PodSource } from './pod-source-receive.js';

const PRIOR_CLONE = "git clone -q --depth 50 'https://github.com/o/r' repo";

describe('podSourceScript', () => {
  test('default is byte-identical to the prior clone line', () => {
    const script = podSourceScript({ kind: 'default' }, 'https://github.com/o/r');
    expect(script.split('\n')[0]).toBe(`${PRIOR_CLONE} && cd repo || exit 5`);
    expect(script).toContain("printf 'ELANOUS_POD_SOURCE default %s\\n'");
  });

  test('rejects a non-40-hex sha and a non-positive PR before interpolation', () => {
    expect(() => podSourceScript({ kind: 'commit', sha: 'abc;rm -rf /' }, 'https://github.com/o/r')).toThrow(/40 hex/);
    expect(() => podSourceScript({ kind: 'pr', number: Number('1;x') }, 'https://github.com/o/r')).toThrow(/positive integer/);
    const sha = 'a'.repeat(40);
    const commit = podSourceScript({ kind: 'commit', sha }, 'https://github.com/o/r');
    expect(commit).toContain(`git fetch --depth 1 origin ${sha}`);
    expect(commit).toContain(`git checkout --detach ${sha}`);
    expect(commit).not.toContain('rm -rf');
    const pr = podSourceScript({ kind: 'pr', number: 7 }, 'https://github.com/o/r');
    expect(pr).toContain('git fetch --depth 50 origin pull/7/head:pr-7');
    expect(pr).toContain('git checkout pr-7');
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
