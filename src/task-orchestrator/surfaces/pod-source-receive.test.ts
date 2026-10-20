import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packSourceBundle } from './pod-source-bundle.js';
import { podSourceScript, type PodSource } from './pod-source-receive.js';

describe('podSourceScript', () => {
  test('pinned image tree becomes a clean per-Pod checkout without cloning files', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-src-image-'));
    try {
      const origin = join(root, 'origin');
      const mirror = join(root, 'mirror.git');
      const image = join(root, 'image');
      const imageWithoutMirror = join(root, 'image-no-mirror');
      const imageGit = join(root, 'pin.git');
      const marker = join(root, 'image-commit');
      const cwd = join(root, 'job');
      for (const path of [origin, image, imageWithoutMirror, cwd]) execFileSync('mkdir', ['-p', path]);
      execFileSync('git', ['init', '-q', '-b', 'trunk', origin]);
      execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', origin, 'config', 'user.name', 'pod']);
      writeFileSync(join(origin, 'history.txt'), 'parent commit\n');
      execFileSync('git', ['-C', origin, 'add', 'history.txt']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'parent']);
      const parent = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      writeFileSync(join(origin, 'README'), 'pinned image contents\n');
      writeFileSync(join(origin, 'stable.txt'), 'unchanged lower-layer file\n');
      writeFileSync(join(origin, '.gitignore'), '*.tmp\n');
      execFileSync('git', ['-C', origin, 'add', 'README', 'stable.txt', '.gitignore']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'pin']);
      const head = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', '--bare', origin, mirror]);
      execFileSync('git', ['clone', '-q', '--bare', '--depth', '1', `file://${origin}`, imageGit]);
      expect(readFileSync(join(imageGit, 'shallow'), 'utf8').trim()).toBe(head);
      const packDir = join(imageGit, 'objects', 'pack');
      const realIndex = readdirSync(packDir).find((name) => name.endsWith('.idx'))!;
      const appleDoubleIndex = join(packDir, `._${realIndex}`);
      writeFileSync(appleDoubleIndex, 'not a pack index');
      for (const name of ['README', 'stable.txt', '.gitignore', 'history.txt']) {
        copyFileSync(join(origin, name), join(image, name));
        copyFileSync(join(origin, name), join(imageWithoutMirror, name));
      }
      const oldTime = new Date('2020-01-01T00:00:00.000Z');
      utimesSync(join(image, 'stable.txt'), oldTime, oldTime);
      writeFileSync(marker, `${head}\n`);
      writeFileSync(join(origin, 'README'), 'new main contents\n');
      execFileSync('git', ['-C', origin, 'commit', '-qam', 'advance']);
      const advanced = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', mirror, 'fetch', '-q', 'origin', '+refs/heads/trunk:refs/heads/trunk']);
      execFileSync('git', ['-C', mirror, 'update-ref', 'refs/heads/stale', head]);
      execFileSync('git', ['-C', mirror, 'symbolic-ref', 'HEAD', 'refs/heads/stale']);
      const options = { imageSourceDir: image, imageCommitFile: marker, imageGitDir: imageGit };
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, mirror, options)}`], { cwd });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(existsSync(appleDoubleIndex)).toBe(false);
      execFileSync('git', ['-C', imageGit, 'cat-file', '-e', `${head}^{commit}`], { stdio: 'pipe' });
      expect(result.stdout.toString()).toContain('ELANOUS_POD_SOURCE_VIA image\n');
      expect(result.stdout.toString()).toContain('ELANOUS_POD_SOURCE_DELTA mirror\n');
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE default ${advanced}`);
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
      expect(readFileSync(join(cwd, 'repo', 'README'), 'utf8')).toBe('new main contents\n');
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'rev-parse', 'origin/trunk'], { encoding: 'utf8' }).trim()).toBe(advanced);
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'symbolic-ref', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' }).trim()).toBe('refs/remotes/origin/trunk');
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { encoding: 'utf8' }).trim()).toBe('origin/trunk');
      execFileSync('git', ['-C', join(cwd, 'repo'), 'pull', '--ff-only'], { stdio: 'pipe' });
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('trunk');
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'branch', '-r'], { encoding: 'utf8' })).not.toContain('origin/main');
      expect(statSync(join(cwd, 'repo', 'stable.txt')).mtimeMs).toBe(oldTime.getTime());
      const pushOrigin = join(root, 'push.git');
      execFileSync('git', ['clone', '-q', '--bare', origin, pushOrigin]);
      execFileSync('git', ['-C', join(cwd, 'repo'), 'remote', 'set-url', '--push', 'origin', pushOrigin]);
      execFileSync('git', ['-C', join(cwd, 'repo'), 'config', 'push.default', 'simple']);
      execFileSync('git', ['-C', join(cwd, 'repo'), 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', join(cwd, 'repo'), 'config', 'user.name', 'pod']);
      writeFileSync(join(cwd, 'repo', 'push-proof.txt'), 'default push follows trunk\n');
      execFileSync('git', ['-C', join(cwd, 'repo'), 'add', 'push-proof.txt']);
      execFileSync('git', ['-C', join(cwd, 'repo'), 'commit', '-qm', 'push proof']);
      execFileSync('git', ['-C', join(cwd, 'repo'), 'push'], { stdio: 'pipe' });
      expect(execFileSync('git', ['-C', pushOrigin, 'rev-parse', 'refs/heads/trunk'], { encoding: 'utf8' }).trim())
        .toBe(execFileSync('git', ['-C', join(cwd, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
      execFileSync('git', ['-C', join(cwd, 'repo'), 'fetch', '--unshallow', 'origin'], { stdio: 'pipe' });
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'rev-parse', 'HEAD~3'], { encoding: 'utf8' }).trim()).toBe(parent);

      const corruptImage = join(root, 'corrupt-image');
      const corruptCwd = join(root, 'corrupt-job');
      execFileSync('mkdir', ['-p', corruptImage, corruptCwd]);
      copyFileSync(join(imageWithoutMirror, 'README'), join(corruptImage, 'README'));
      copyFileSync(join(imageWithoutMirror, 'stable.txt'), join(corruptImage, 'stable.txt'));
      copyFileSync(join(imageWithoutMirror, '.gitignore'), join(corruptImage, '.gitignore'));
      copyFileSync(join(imageWithoutMirror, 'history.txt'), join(corruptImage, 'history.txt'));
      writeFileSync(join(corruptImage, 'README'), 'wrong image bytes\n');
      const recovered = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, mirror, { ...options, imageSourceDir: corruptImage })}`], { cwd: corruptCwd });
      expect(recovered.exitCode, recovered.stderr.toString()).toBe(0);
      expect(recovered.stdout.toString()).toContain('ELANOUS_POD_SOURCE_IMAGE_SKIP source-tree-mismatch\n');
      expect(recovered.stdout.toString()).toContain('ELANOUS_POD_SOURCE_VIA mirror\n');
      expect(readFileSync(join(corruptCwd, 'repo', 'README'), 'utf8')).toBe('new main contents\n');

      const extraImage = join(root, 'extra-image');
      const extraCwd = join(root, 'extra-job');
      execFileSync('mkdir', ['-p', extraImage, extraCwd]);
      copyFileSync(join(imageWithoutMirror, 'README'), join(extraImage, 'README'));
      copyFileSync(join(imageWithoutMirror, 'stable.txt'), join(extraImage, 'stable.txt'));
      copyFileSync(join(imageWithoutMirror, '.gitignore'), join(extraImage, '.gitignore'));
      copyFileSync(join(imageWithoutMirror, 'history.txt'), join(extraImage, 'history.txt'));
      writeFileSync(join(extraImage, 'unexpected.tmp'), 'ignored but not in pinned tree\n');
      const extra = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, mirror, { ...options, imageSourceDir: extraImage })}`], { cwd: extraCwd });
      expect(extra.exitCode, extra.stderr.toString()).toBe(0);
      expect(extra.stdout.toString()).toContain('ELANOUS_POD_SOURCE_IMAGE_SKIP source-tree-mismatch\n');
      expect(extra.stdout.toString()).toContain('ELANOUS_POD_SOURCE_VIA mirror\n');
      expect(existsSync(join(extraCwd, 'repo', 'unexpected.tmp'))).toBe(false);

      const noMirrorCwd = join(root, 'no-mirror');
      execFileSync('mkdir', ['-p', noMirrorCwd]);
      const noMirror = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, join(root, 'absent'), { ...options, imageSourceDir: imageWithoutMirror })}`], { cwd: noMirrorCwd });
      expect(noMirror.exitCode, noMirror.stderr.toString()).toBe(0);
      expect(noMirror.stdout.toString()).toContain('ELANOUS_POD_SOURCE_VIA image\n');
      expect(noMirror.stdout.toString()).toContain('ELANOUS_POD_SOURCE_DELTA origin\n');
      expect(execFileSync('git', ['-C', join(noMirrorCwd, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(advanced);

      rmSync(join(imageGit, 'shallow'));
      const missingShallowCwd = join(root, 'missing-shallow');
      execFileSync('mkdir', ['-p', missingShallowCwd]);
      const missingShallow = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, mirror, options)}`], { cwd: missingShallowCwd });
      expect(missingShallow.exitCode, missingShallow.stderr.toString()).toBe(0);
      expect(missingShallow.stdout.toString()).toContain('ELANOUS_POD_SOURCE_IMAGE_SKIP pin-objects-mismatch\n');
      expect(missingShallow.stdout.toString()).toContain('ELANOUS_POD_SOURCE_VIA mirror\n');

      writeFileSync(marker, 'dirty\n');
      const fallback = join(root, 'fallback');
      execFileSync('mkdir', ['-p', fallback]);
      const old = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, mirror, options)}`], { cwd: fallback });
      expect(old.exitCode, old.stderr.toString()).toBe(0);
      expect(old.stdout.toString()).toContain('ELANOUS_POD_SOURCE_IMAGE_SKIP pin-objects-mismatch');
      expect(old.stdout.toString()).toContain('ELANOUS_POD_SOURCE_VIA mirror');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('default prefers the mirror, restores origin and reports its route', () => {
    const script = podSourceScript({ kind: 'default' }, 'https://github.com/o/r');
    expect(script).toContain("git clone -q --shared -- '/host-mirror' repo");
    expect(script).toContain("git -C repo remote set-url origin 'https://github.com/o/r'");
    expect(script).toContain("git clone -q --depth 50 'https://github.com/o/r' repo");
    expect(script).toContain("printf 'ELANOUS_POD_SOURCE_VIA %s\\n'");
    expect(script).toContain("printf 'ELANOUS_POD_SOURCE_MIRROR_SKIP %s\\n' \"$mirror_skip\"");
    for (const reason of ['no-mount', 'rev-parse-failed', 'clone-failed']) expect(script).toContain(`mirror_skip=${reason}`);
    expect(script).toContain("printf 'ELANOUS_POD_SOURCE default %s\\n'");
  });

  test('non-main clone base starts at its remote commit via mirror and fallback; missing base is refused before launch', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-src-base-'));
    try {
      const origin = join(root, 'origin');
      const mirror = join(root, 'mirror.git');
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', origin, 'config', 'user.name', 'pod']);
      writeFileSync(join(origin, 'README'), 'main\n');
      execFileSync('git', ['-C', origin, 'add', 'README']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'main']);
      const main = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', '--bare', origin, mirror]);
      execFileSync('git', ['-C', origin, 'checkout', '-qb', 'bench/sample']);
      writeFileSync(join(origin, 'README'), 'bench\n');
      execFileSync('git', ['-C', origin, 'commit', '-qam', 'bench']);
      const bench = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', origin, 'checkout', '-q', 'main']);
      const source: PodSource = { kind: 'default', base: 'bench/sample' };
      for (const [name, path, via] of [['mirror', mirror, 'mirror'], ['fallback', join(root, 'absent'), 'github']] as const) {
        const cwd = join(root, name);
        execFileSync('mkdir', ['-p', cwd]);
        const script = podSourceScript(source, origin, path, { imageCommitFile: join(root, 'absent-image-commit') });
        const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE_VIA ${via}\nELANOUS_POD_SOURCE default ${bench}`);
        expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(bench);
        expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('bench/sample');
      }
      expect(execFileSync('git', ['-C', mirror, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(main);
      expect(podSourceScript({ kind: 'default', base: 'main' }, origin, mirror)).toBe(podSourceScript({ kind: 'default' }, origin, mirror));
      expect(() => podSourceScript({ kind: 'default', base: 'bench/missing' }, origin, mirror)).toThrow('Pod base ref not found on origin: bench/missing');
      expect(() => podSourceScript({ kind: 'default', base: 'bench/sample;echo wrong' }, origin, mirror)).toThrow('invalid Pod base ref');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stageMarkers (si-task only): mirror start always, mirror end only when the mirror clone succeeded; off = byte-identical', () => {
    const plain = podSourceScript({ kind: 'default' }, 'https://github.com/o/r');
    expect(plain).not.toContain('ELANOUS_POD_STAGE');
    expect(podSourceScript({ kind: 'default' }, 'https://github.com/o/r', undefined, { stageMarkers: false })).toBe(plain);
    const root = mkdtempSync(join(tmpdir(), 'pod-src-stage-'));
    try {
      const origin = join(root, 'origin');
      const mirror = join(root, 'mirror.git');
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      execFileSync('git', ['-C', origin, '-c', 'user.email=pod@example.com', '-c', 'user.name=pod', 'commit', '-q', '--allow-empty', '-m', 'base']);
      execFileSync('git', ['clone', '-q', '--bare', origin, mirror]);
      const stageLines = (out: string) => out.split('\n').filter((line) => line.startsWith('ELANOUS_POD_STAGE '));
      for (const [name, path, ends] of [['via-mirror', mirror, true], ['via-github', join(root, 'absent'), false]] as const) {
        const cwd = join(root, name);
        execFileSync('mkdir', ['-p', cwd]);
        const result = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, path, { stageMarkers: true, imageCommitFile: join(root, 'absent-image-commit') })}`], { cwd });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const lines = stageLines(result.stdout.toString());
        expect(lines.map((line) => line.replace(/ \d+$/, ''))).toEqual(ends ? ['ELANOUS_POD_STAGE mirror start', 'ELANOUS_POD_STAGE mirror end'] : ['ELANOUS_POD_STAGE mirror start']);
        for (const line of lines) expect(line).toMatch(/^ELANOUS_POD_STAGE mirror (start|end) \d{9,12}$/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
        const script = podSourceScript(source, origin, useMirror ? mirror : join(root, 'absent'), { imageCommitFile: join(root, 'absent-image-commit') });
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
      const brokenResult = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, brokenMirror, { imageCommitFile: join(root, 'absent-image-commit') })}`], { cwd: brokenCwd });
      expect(brokenResult.exitCode).toBe(0);
      expect(brokenResult.stdout.toString()).toContain(`ELANOUS_POD_SOURCE_VIA github\nELANOUS_POD_SOURCE default ${head}`);
      // TA-POD-WARMBOOT-PARITY: each fallback names the step that failed, right before the route line.
      expect(fallback.output).toContain('ELANOUS_POD_SOURCE_MIRROR_SKIP no-mount\nELANOUS_POD_SOURCE_VIA github\n');
      expect(brokenResult.stdout.toString()).toContain('ELANOUS_POD_SOURCE_MIRROR_SKIP rev-parse-failed\nELANOUS_POD_SOURCE_VIA github\n');
      // A path git can resolve but cannot clone from (a work tree's subdirectory) → clone-failed, still a clean github fallback.
      const work = join(root, 'skip-work');
      execFileSync('git', ['init', '-q', work]);
      execFileSync('git', ['-C', work, '-c', 'user.email=pod@example.com', '-c', 'user.name=pod', 'commit', '-q', '--allow-empty', '-m', 'x']);
      execFileSync('mkdir', ['-p', join(work, 'sub'), join(root, 'clone-failed')]);
      const cloneFailed = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, join(work, 'sub'), { imageCommitFile: join(root, 'absent-image-commit') })}`], { cwd: join(root, 'clone-failed') });
      expect(cloneFailed.exitCode, cloneFailed.stderr.toString()).toBe(0);
      expect(cloneFailed.stdout.toString()).toContain(`ELANOUS_POD_SOURCE_MIRROR_SKIP clone-failed\nELANOUS_POD_SOURCE_VIA github\nELANOUS_POD_SOURCE default ${head}`);
      // The mirror route stays silent about skipping.
      expect(forcedCheckedOut.output).not.toContain('ELANOUS_POD_SOURCE_MIRROR_SKIP');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

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
