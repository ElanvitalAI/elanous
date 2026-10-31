import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateChangedFiles } from '../../self-implement/seams.js';
import { packSourceBundle } from './pod-source-bundle.js';
import { podSourceScript, PodSourceShaFormatError, type PodSource } from './pod-source-receive.js';

function makeBaseShaFallbackFixture(root: string, options: { originHasBase: boolean; withMirror: boolean }) {
  const work = join(root, 'origin-work');
  const origin = join(root, 'origin.git');
  const mirror = join(root, 'mirror.git');
  const image = join(root, 'image');
  const imageGit = join(root, 'image.git');
  const marker = join(root, 'image-commit');
  for (const path of [work, image]) mkdirSync(path);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  execFileSync('git', ['-C', work, 'config', 'user.email', 'pod@example.com']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 'pod']);
  writeFileSync(join(work, 'README'), 'pinned image contents\n');
  execFileSync('git', ['-C', work, 'add', 'README']);
  execFileSync('git', ['-C', work, 'commit', '-qm', 'pin']);
  const pinSha = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['clone', '-q', '--bare', '--depth', '1', `file://${work}`, imageGit]);
  copyFileSync(join(work, 'README'), join(image, 'README'));
  writeFileSync(marker, `${pinSha}\n`);
  let baseSha = 'f'.repeat(40);
  if (options.originHasBase) {
    writeFileSync(join(work, 'next.txt'), 'next commit\n');
    execFileSync('git', ['-C', work, 'add', 'next.txt']);
    execFileSync('git', ['-C', work, 'commit', '-qm', 'next']);
    baseSha = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }
  execFileSync('git', ['clone', '-q', '--bare', work, origin]);
  if (options.withMirror) execFileSync('git', ['clone', '-q', '--bare', work, mirror]);
  return { baseSha, origin, mirror: options.withMirror ? mirror : null, imageOptions: { imageSourceDir: image, imageCommitFile: marker, imageGitDir: imageGit } };
}

describe('podSourceScript', () => {
  test('default source uses the parent-resolved base SHA from the host mirror without Pod origin calls', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-parent-base-sha-'));
    try {
      const work = join(root, 'work');
      const mirror = join(root, 'host-mirror.git');
      const cwd = join(root, 'job');
      mkdirSync(work); mkdirSync(cwd);
      execFileSync('git', ['init', '-q', '-b', 'main', work]);
      execFileSync('git', ['-C', work, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', work, 'config', 'user.name', 'pod']);
      writeFileSync(join(work, 'README'), 'base\n');
      execFileSync('git', ['-C', work, 'add', 'README']);
      execFileSync('git', ['-C', work, 'commit', '-qm', 'base']);
      const baseSha = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', '--bare', work, mirror]);

      // 부재 commit 파일로 image 라우트를 끈다. 실제 Pod 이미지의 /opt/elanous-source 는 존재할 수 있고,
      // image 라우트를 켜 두면 테스트 repo 를 가로채 공용 object store alternates 를 오염시킬 수 있다.
      const script = podSourceScript({ kind: 'default', baseSha }, 'https://github.com/unused/repo', mirror, { imageCommitFile: join(root, 'absent-image-commit') });
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toContain('ELANOUS_POD_SOURCE_VIA mirror');
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE default ${baseSha}`);
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(baseSha);
      const io = /^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1];
      expect(io).toBeTruthy();
      expect(JSON.parse(io!)).toMatchObject({ originCalls: 0, sourceVia: 'mirror', sourceStatus: 'complete' });
      const outcome = /^ELANOUS_POD_SOURCE_RESULT (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1];
      expect(outcome).toBeTruthy();
      expect(JSON.parse(outcome!)).toMatchObject({ sourceStage: 'source-complete', sourceKind: 'default', sourceVia: 'mirror', sourceStatus: 'complete', baseSha, exitCode: 0, failureCode: null });
      expect(script).not.toContain('git ls-remote');
      expect(script).not.toContain('git clone -q --depth 50');
      expect(script).not.toContain('git fetch --depth 50 origin');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('rejects an invalid resolved default base SHA before any source-receive script is constructed', () => {
    const metachar = `$(touch ${'pwned'})`;
    expect(() => podSourceScript({ kind: 'default', baseSha: metachar }, 'https://github.com/unused/repo', '/host-mirror')).toThrow(PodSourceShaFormatError);
    expect(() => podSourceScript({ kind: 'default', baseSha: metachar }, 'https://github.com/unused/repo', '/host-mirror')).toThrow(/base sha must be 40 hex characters/);
    expect(() => podSourceScript({ kind: 'default', baseSha: 'ABCDEF0123456789abcdef0123456789abcdef01' }, 'https://github.com/unused/repo')).toThrow(PodSourceShaFormatError);
    expect(() => podSourceScript({ kind: 'default', baseSha: `${'a'.repeat(39)}G` }, 'https://github.com/unused/repo')).toThrow(PodSourceShaFormatError);
    // 형식이 틀린 값이 어떤 git 명령 줄에도 삽입되지 않는다 — 거부는 검증 단계에서 끝난다.
    expect(() => podSourceScript({ kind: 'default', baseSha: `${metachar}\\n` }, 'https://github.com/unused/repo')).toThrow(PodSourceShaFormatError);
  });

  test('parent-resolved SHA missing from image and mirror is fetched once from origin and recorded', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-parent-base-origin-fallback-'));
    try {
      const fixture = makeBaseShaFallbackFixture(root, { originHasBase: true, withMirror: false });
      const cwd = join(root, 'job');
      mkdirSync(cwd);
      const script = podSourceScript({ kind: 'default', baseSha: fixture.baseSha }, fixture.origin, join(root, 'missing-mirror'), fixture.imageOptions);
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE_BASE_SHA_ORIGIN_FETCH complete ${fixture.baseSha}`);
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE default ${fixture.baseSha}`);
      const io = /^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1];
      expect(JSON.parse(io!)).toMatchObject({ originCalls: 1, baseShaOriginFallback: true, sourceVia: 'origin', sourceStatus: 'complete' });
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(fixture.baseSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('parent-resolved SHA absent from both mirror and origin still exits 5 after one origin attempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-parent-base-origin-missing-'));
    try {
      const fixture = makeBaseShaFallbackFixture(root, { originHasBase: false, withMirror: true });
      const cwd = join(root, 'job');
      mkdirSync(cwd);
      const script = podSourceScript({ kind: 'default', baseSha: fixture.baseSha }, fixture.origin, fixture.mirror!, fixture.imageOptions);
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd });
      expect(result.exitCode).toBe(5);
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE_BASE_SHA_MIRROR_FETCH failed ${fixture.baseSha}`);
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE_BASE_SHA_ORIGIN_FETCH failed ${fixture.baseSha}`);
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE_BASE_SHA_UNAVAILABLE ${fixture.baseSha}`);
      const io = /^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1];
      expect(JSON.parse(io!)).toMatchObject({ originCalls: 1, baseShaOriginFallback: true, sourceStatus: 'incomplete' });
      const resultLine = /^ELANOUS_POD_SOURCE_RESULT (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1];
      expect(JSON.parse(resultLine!)).toMatchObject({ sourceStage: 'base-sha', sourceStatus: 'failed', baseSha: fixture.baseSha, exitCode: 5, failureCode: 'base-sha-unavailable' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('PR source from a one-commit image pin obtains a real main merge-base', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-pr-base-'));
    try {
      const origin = join(root, 'origin');
      const remote = join(root, 'remote.git');
      const image = join(root, 'image');
      const pinGit = join(root, 'pin.git');
      const pinFile = join(root, 'image-commit');
      const cwd = join(root, 'job');
      mkdirSync(origin); mkdirSync(image); mkdirSync(cwd);
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', origin, 'config', 'user.name', 'pod']);
      writeFileSync(join(origin, 'README'), 'shared\n');
      execFileSync('git', ['-C', origin, 'add', 'README']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'shared']);
      const shared = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', origin, 'branch', 'pin', shared]);
      writeFileSync(join(origin, 'main.txt'), 'first main\n');
      execFileSync('git', ['-C', origin, 'add', 'main.txt']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'main before PR']);
      const fork = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', origin, 'checkout', '-qb', 'feature']);
      writeFileSync(join(origin, 'feature.txt'), 'PR\n');
      execFileSync('git', ['-C', origin, 'add', 'feature.txt']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'PR']);
      for (let i = 0; i < 60; i++) execFileSync('git', ['-C', origin, 'commit', '--allow-empty', '-qm', `PR depth ${i}`]);
      const pr = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', origin, 'checkout', '-q', 'main']);
      writeFileSync(join(origin, 'main.txt'), 'latest main\n');
      execFileSync('git', ['-C', origin, 'add', 'main.txt']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'main']);
      for (let i = 0; i < 60; i++) execFileSync('git', ['-C', origin, 'commit', '--allow-empty', '-qm', `main depth ${i}`]);
      const main = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', '--bare', origin, remote]);
      execFileSync('git', ['-C', remote, 'update-ref', 'refs/pull/7/head', pr]);
      execFileSync('git', ['clone', '-q', '--bare', '--depth', '1', '--branch', 'pin', `file://${remote}`, pinGit]);
      expect(readFileSync(join(pinGit, 'shallow'), 'utf8').trim()).toBe(shared);
      copyFileSync(join(origin, 'README'), join(image, 'README'));
      writeFileSync(pinFile, `${shared}\n`);
      const before = join(root, 'before');
      execFileSync('git', ['init', '-q', '-b', 'main', before]);
      mkdirSync(join(before, '.git', 'objects', 'info'), { recursive: true });
      writeFileSync(join(before, '.git', 'objects', 'info', 'alternates'), `${join(pinGit, 'objects')}\n`);
      copyFileSync(join(pinGit, 'shallow'), join(before, '.git', 'shallow'));
      execFileSync('git', ['-C', before, 'update-ref', 'refs/heads/main', shared]);
      execFileSync('git', ['-C', before, 'remote', 'add', 'origin', `file://${remote}`]);
      execFileSync('git', ['-C', before, 'fetch', '--depth', '50', 'origin', 'refs/pull/7/head']);
      execFileSync('git', ['-C', before, 'checkout', '-q', '-B', 'pr-7', pr]);
      execFileSync('git', ['-C', before, 'fetch', '--depth', '50', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
      const missingFork = Bun.spawnSync(['git', '-C', before, 'merge-base', 'HEAD', 'origin/main']);
      expect(missingFork.exitCode).toBe(1);
      const script = podSourceScript({ kind: 'pr', number: 7 }, `file://${remote}`, join(root, 'no-mirror'),
        { imageSourceDir: image, imageCommitFile: pinFile, imageGitDir: pinGit });
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toContain('ELANOUS_POD_SOURCE_VIA image');
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE pr ${pr}`);
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'symbolic-ref', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' }).trim())
        .toBe('refs/remotes/origin/main');
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim()).toBe(main);
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' }).trim()).toBe(fork);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('PR source refuses an unadvertised remote default instead of trusting a stale base', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-pr-no-default-'));
    try {
      const origin = join(root, 'origin');
      const remote = join(root, 'remote.git');
      const cwd = join(root, 'job');
      mkdirSync(origin); mkdirSync(cwd);
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', origin, 'config', 'user.name', 'pod']);
      writeFileSync(join(origin, 'README'), 'shared\n');
      execFileSync('git', ['-C', origin, 'add', 'README']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'shared']);
      const pr = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', '--bare', origin, remote]);
      execFileSync('git', ['-C', remote, 'update-ref', 'refs/pull/7/head', pr]);
      execFileSync('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/absent']);
      const script = podSourceScript({ kind: 'pr', number: 7 }, `file://${remote}`, join(root, 'no-mirror'), { imageCommitFile: join(root, 'absent-image-commit') });
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd });
      expect(result.exitCode).toBe(5);
      expect(result.stdout.toString()).toContain('ELANOUS_POD_COMPARISON_BASE unavailable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('unrelated PR and advertised main remain explicitly unmeasured', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-pr-unrelated-'));
    try {
      const origin = join(root, 'origin');
      const remote = join(root, 'remote.git');
      const cwd = join(root, 'job');
      mkdirSync(origin); mkdirSync(cwd);
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', origin, 'config', 'user.name', 'pod']);
      writeFileSync(join(origin, 'main.txt'), 'main\n');
      execFileSync('git', ['-C', origin, 'add', 'main.txt']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'main']);
      execFileSync('git', ['-C', origin, 'checkout', '-q', '--orphan', 'unrelated']);
      execFileSync('git', ['-C', origin, 'rm', '-q', '-rf', '.']);
      writeFileSync(join(origin, 'pr.txt'), 'unrelated\n');
      execFileSync('git', ['-C', origin, 'add', 'pr.txt']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'unrelated PR']);
      const pr = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', origin, 'checkout', '-q', 'main']);
      execFileSync('git', ['clone', '-q', '--bare', origin, remote]);
      execFileSync('git', ['-C', remote, 'update-ref', 'refs/pull/7/head', pr]);
      const script = podSourceScript({ kind: 'pr', number: 7 }, `file://${remote}`, join(root, 'no-mirror'), { imageCommitFile: join(root, 'absent-image-commit') });
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toContain('ELANOUS_POD_COMPARISON_BASE unavailable');
      const repo = join(cwd, 'repo');
      const fork = Bun.spawnSync(['git', '-C', repo, 'merge-base', 'HEAD', 'origin/main']);
      expect(fork.exitCode).toBe(1);
      expect(gateChangedFiles(repo, null).comparisonBaseStatus).toBe('unavailable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

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
      // 호스트가 전역 pre-push guard([pod] git-guard — core.hooksPath)를 깔아 둔 환경에서도
      // fixture push 가 그 guard 에 걸리지 않게 이 repo 의 hook 을 끈다(pod-source-bundle.test.ts 관례).
      execFileSync('git', ['-C', join(cwd, 'repo'), 'config', 'core.hooksPath', '/dev/null']);
      execFileSync('git', ['-C', join(cwd, 'repo'), 'config', 'push.default', 'simple']);
      execFileSync('git', ['-C', join(cwd, 'repo'), 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', join(cwd, 'repo'), 'config', 'user.name', 'pod']);
      writeFileSync(join(cwd, 'repo', 'push-proof.txt'), 'default push follows trunk\n');
      execFileSync('git', ['-C', join(cwd, 'repo'), 'add', 'push-proof.txt']);
      execFileSync('git', ['-C', join(cwd, 'repo'), 'commit', '-qm', 'push proof']);
      // 호스트 pre-push git-guard 훅(K-TC-24)은 임시 픽스처 refs/heads/trunk push 를 거부한다 — 증명 대상은 브랜치 배선이지 훅이 아니므로 core.hooksPath= 로 끈다.
      execFileSync('git', ['-c', 'core.hooksPath=', '-C', join(cwd, 'repo'), 'push'], { stdio: 'pipe' });
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
  }, 30_000);

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
        expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE_VIA ${via}\n`);
        expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE default ${bench}\n`);
        const io = /^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1];
        expect(JSON.parse(io!).originCalls).toBe(via === 'mirror' ? 1 : 2); // Pod origin fetches only; host preflight is outside this interval.
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
  }, 30_000);

  test('stageMarkers (si-task only): mirror start always, mirror end only when the mirror clone succeeded; off = byte-identical', () => {
    const plain = podSourceScript({ kind: 'default' }, 'https://github.com/o/r');
    expect(plain).not.toContain('ELANOUS_POD_STAGE');
    expect(podSourceScript({ kind: 'default' }, 'https://github.com/o/r', undefined, { stageMarkers: false })).toBe(plain);
    const root = mkdtempSync(join(tmpdir(), 'pod-src-stage-'));
    try {
      const origin = join(root, 'origin');
      const mirror = join(root, 'mirror.git');
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      writeFileSync(join(origin, 'tracked.txt'), 'tracked\n');
      execFileSync('git', ['-C', origin, 'add', 'tracked.txt']);
      execFileSync('git', ['-C', origin, '-c', 'user.email=pod@example.com', '-c', 'user.name=pod', 'commit', '-q', '-m', 'base']);
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
        const io = /^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1];
        expect(io).toBeDefined();
        expect(JSON.parse(io!)).toMatchObject({
          originCalls: 1,
          checkoutFiles: 1,
          sourceVia: ends ? 'mirror' : 'github',
          sourceStatus: 'complete',
          pushCalls: null,
          installRan: null,
          installSeconds: null,
        });
        expect(JSON.parse(io!).sourceSeconds).toEqual(expect.any(Number));
      }
      const failedCwd = join(root, 'source-failed');
      execFileSync('mkdir', ['-p', join(failedCwd, 'repo')]);
      const failed = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default' }, origin, mirror, { stageMarkers: true })}`], { cwd: failedCwd });
      expect(failed.exitCode).toBe(5);
      const failedIo = /^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(failed.stdout.toString())?.[1];
      expect(JSON.parse(failedIo!)).toMatchObject({ checkoutFiles: null, sourceStatus: 'incomplete', sourceVia: 'unknown' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

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

  test('mirror freshness and SHA membership select source fetches while PR base refreshes without writing to mirror', () => {
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
      expect(existsSync(join(cachedPr.cwd, 'repo', '.git', 'FETCH_HEAD'))).toBe(true);
      expect(execFileSync('git', ['-C', join(cachedPr.cwd, 'repo'), 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim()).toBe(head);
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
      // 호스트가 전역 pre-push guard([pod] git-guard — core.hooksPath)를 깔아 둔 환경에서도
      // fixture push 가 그 guard 에 걸리지 않게 이 repo 의 hook 을 끈다(pod-source-bundle.test.ts 관례).
      execFileSync('git', ['-C', origin, 'config', 'core.hooksPath', '/dev/null']);
      writeFileSync(join(origin, 'README'), 'mirror base\n');
      execFileSync('git', ['-C', origin, 'add', 'README']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'base']);
      execFileSync('git', ['-C', origin, 'remote', 'add', 'origin', remote]);
      // 픽스처 setup push 도 같은 이유로 호스트 git-guard 훅을 끈다(K-TC-24).
      execFileSync('git', ['-c', 'core.hooksPath=', '-C', origin, 'push', '-q', 'origin', 'main']);
      execFileSync('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
      const mirrorHead = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', '--bare', remote, mirror]);
      writeFileSync(join(origin, 'README'), 'new base\n');
      execFileSync('git', ['-C', origin, 'commit', '-qam', 'advance']);
      execFileSync('git', ['-c', 'core.hooksPath=', '-C', origin, 'push', '-q', 'origin', 'main']);
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
  }, 30_000);

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
  }, 30_000);

  test('POD-REUSE-MIN-SYNC: 같은 웜 Pod 재사용 — 둘째 요청 GitHub 호출 0 · 바뀐 파일 수 = 두 base diff 수 · 소요 ≤ 새 Pod의 1/3', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-min-sync-'));
    try {
      // 무대: 격리 임시 git ⊕ fake clock·fake bun(fake-bin) — 같은 웜 Pod 요청 2회 사건 주입 시뮬.
      const fakeBin = join(root, 'fake-bin');
      const clockState = join(root, 'clock');
      const bunCalls = join(root, 'bun-calls');
      mkdirSync(fakeBin); mkdirSync(clockState);
      writeFileSync(join(clockState, 'base'), '1000\n');
      const setClock = (step: number) => {
        writeFileSync(join(clockState, 'step'), `${step}\n`);
        writeFileSync(join(clockState, 'n'), '0\n');
      };
      writeFileSync(join(fakeBin, 'date'), [
        '#!/bin/sh',
        `n=$(cat '${clockState}/n' 2>/dev/null || echo 0)`,
        `base=$(cat '${clockState}/base' 2>/dev/null || echo 1000)`,
        `step=$(cat '${clockState}/step' 2>/dev/null || echo 0)`,
        'echo $((base + n * step))',
        `echo $((n + 1)) > '${clockState}/n'`,
        '',
      ].join('\n'));
      writeFileSync(join(fakeBin, 'bun'), `#!/bin/sh\necho called >> '${bunCalls}'\nexit 0\n`);
      chmodSync(join(fakeBin, 'date'), 0o755);
      chmodSync(join(fakeBin, 'bun'), 0o755);
      const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };

      const origin = join(root, 'origin');
      const mirror = join(root, 'mirror.git');
      const warm = join(root, 'warm');
      mkdirSync(origin); mkdirSync(join(origin, 'src')); mkdirSync(join(origin, 'docs')); mkdirSync(warm);
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', origin, 'config', 'user.name', 'pod']);
      const commitAll = (message: string) => {
        execFileSync('git', ['-C', origin, 'add', '-A']);
        execFileSync('git', ['-C', origin, 'commit', '-qm', message]);
      };
      writeFileSync(join(origin, 'README'), 'base-one\n');
      writeFileSync(join(origin, 'src/keep.ts'), 'keep-one\n');
      writeFileSync(join(origin, 'docs/guide.md'), 'unchanged\n');
      writeFileSync(join(origin, 'old.txt'), 'gone-soon\n');
      writeFileSync(join(origin, 'bun.lock'), 'pinned-lock-1\n');
      writeFileSync(join(origin, '.gitignore'), 'node_modules/\n');
      execFileSync('git', ['-C', origin, 'add', '-A']);
      commitAll('base one');
      const base1 = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', '--bare', origin, mirror]);
      const lockHash = createHash('sha256').update('pinned-lock-1\n').digest('hex');

      // 요청 1 — 새 Pod 첫 수신(호스트 미러 복제 · GitHub 호출 0). fake clock 한 걸음 9초 → 소요 9초.
      // imageCommitFile 을 없는 경로로: 이 무대가 Pod 안에서 돌 때 /opt/elanous-source(이미지 고정 트리)
      // 로 우연히 image 갈래가 켜지지 않게 — 기존 시험들의 같은 관례.
      setClock(9);
      const first = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'default', baseSha: base1 }, 'https://github.com/unused/repo', mirror, { imageCommitFile: join(root, 'absent-image-commit') })}`], { cwd: warm, env });
      expect(first.exitCode, first.stderr.toString()).toBe(0);
      const firstIo = /^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(first.stdout.toString())?.[1];
      expect(JSON.parse(firstIo!)).toMatchObject({ originCalls: 0, sourceVia: 'mirror', sourceStatus: 'complete' });
      const newPodSeconds = (JSON.parse(firstIo!) as { sourceSeconds: number }).sourceSeconds;
      expect(newPodSeconds).toBe(9);

      // 같은 웜 Pod 의 상주 상태: 첫 수신 때 깔린 node_modules · 요청 사이 빌드 찌꺼기
      const repo = join(warm, 'repo');
      mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(repo, 'node_modules', 'dep', 'keep.txt'), 'installed at first receive');
      writeFileSync(join(repo, 'node_modules', '.elanous-installed-lock-hash'), `${lockHash}\n`);
      writeFileSync(join(repo, 'build-artifact.tmp'), 'build residue');
      const unchanged = join(repo, 'docs', 'guide.md');
      const oldTime = new Date('2020-01-01T00:00:00.000Z');
      utimesSync(unchanged, oldTime, oldTime);

      // 미러를 새 base 로 진전(호스트 시드) — 이 시뮬 안에서 GitHub 원격 호출은 0이어야 한다.
      writeFileSync(join(origin, 'README'), 'base-two\n');
      writeFileSync(join(origin, 'src/keep.ts'), 'keep-two\n');
      rmSync(join(origin, 'old.txt'));
      writeFileSync(join(origin, 'src/new.ts'), 'new-file\n');
      commitAll('base two');
      const base2 = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', mirror, 'fetch', '-q', origin, '+refs/heads/main:refs/heads/main']);
      const diffFiles = execFileSync('git', ['-C', origin, 'diff', '--name-only', base1, base2], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      expect(diffFiles.length).toBe(4);

      // 요청 2 — 같은 웜 Pod 재사용 min-sync. fake clock 한 걸음 1초 → 새 Pod 9초의 1/3 이하.
      setClock(1);
      const script = podSourceScript({ kind: 'min-sync', baseSha: base2, previousHead: base1, lockHash }, 'https://github.com/unused/repo', mirror);
      expect(script).not.toContain('ls-remote');
      expect(script).not.toContain('git fetch --depth');
      const second = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd: warm, env });
      expect(second.exitCode, second.stderr.toString()).toBe(0);
      const out = second.stdout.toString();
      const stage = /^ELANOUS_POD_STAGE min-sync (\d+) (\d+) (\d+)$/m.exec(out);
      expect(stage).toBeTruthy();
      expect(Number(stage![1])).toBe(0);                                    // 둘째 요청 GitHub 호출 0
      expect(Number(stage![2])).toBe(diffFiles.length);                     // 바뀐 파일 수 = 두 base diff 수
      expect(Number(stage![3]) * 3).toBeLessThanOrEqual(newPodSeconds);     // 소요 ≤ 새 Pod 의 1/3
      expect(out).toContain(`ELANOUS_POD_SOURCE min-sync ${base2}`);
      const io = /^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(out)?.[1];
      expect(JSON.parse(io!)).toMatchObject({
        originCalls: 0, checkoutFiles: diffFiles.length, sourceVia: 'min-sync',
        sourceStatus: 'complete', installRan: false, installSeconds: null,
      });
      expect(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(base2);
      expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
      expect(readFileSync(join(repo, 'README'), 'utf8')).toBe('base-two\n');
      expect(readFileSync(join(repo, 'src', 'keep.ts'), 'utf8')).toBe('keep-two\n');
      expect(readFileSync(join(repo, 'src', 'new.ts'), 'utf8')).toBe('new-file\n');
      expect(existsSync(join(repo, 'old.txt'))).toBe(false);
      expect(existsSync(join(repo, 'build-artifact.tmp'))).toBe(false);     // 남은 untracked·빌드 산출만 clean
      expect(readFileSync(join(repo, 'node_modules', 'dep', 'keep.txt'), 'utf8')).toBe('installed at first receive');
      expect(statSync(unchanged).mtimeMs).toBe(oldTime.getTime());          // 기존 작업 트리를 지우지 않는다
      expect(existsSync(bunCalls)).toBe(false);                             // lockfile 해시가 같으면 설치를 건너뛴다

      // 요청 3 — lockfile 해시가 다른 새 base → 재설치한다(installRan) · node_modules 는 clean 보존 목록에 든다.
      writeFileSync(join(origin, 'bun.lock'), 'pinned-lock-2\n');
      commitAll('base three');
      const base3 = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const lockHash2 = createHash('sha256').update('pinned-lock-2\n').digest('hex');
      execFileSync('git', ['-C', mirror, 'fetch', '-q', origin, '+refs/heads/main:refs/heads/main']);
      setClock(1);
      const third = Bun.spawnSync(['bash', '-c', `set -e\n${podSourceScript({ kind: 'min-sync', baseSha: base3, previousHead: base2, lockHash: lockHash2 }, 'https://github.com/unused/repo', mirror)}`], { cwd: warm, env });
      expect(third.exitCode, third.stderr.toString()).toBe(0);
      expect(existsSync(bunCalls)).toBe(true);
      expect(readFileSync(join(repo, 'node_modules', '.elanous-installed-lock-hash'), 'utf8').trim()).toBe(lockHash2);
      const thirdIo = /^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(third.stdout.toString())?.[1];
      expect(JSON.parse(thirdIo!)).toMatchObject({ originCalls: 0, checkoutFiles: 1, installRan: true });
      expect(readFileSync(join(repo, 'node_modules', 'dep', 'keep.txt'), 'utf8')).toBe('installed at first receive');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('POD-REUSE-MIN-SYNC: 미러·bundle 어디에도 base 가 없으면 GitHub 폴백 없이 fail-closed 된다', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-min-sync-absent-'));
    try {
      const origin = join(root, 'origin');
      const warm = join(root, 'warm');
      mkdirSync(origin); mkdirSync(warm);
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', origin, 'config', 'user.name', 'pod']);
      writeFileSync(join(origin, 'README'), 'base\n');
      execFileSync('git', ['-C', origin, 'add', 'README']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'base']);
      const base1 = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', origin, join(warm, 'repo')]);
      const missing = 'e'.repeat(40);
      const script = podSourceScript({ kind: 'min-sync', baseSha: missing, previousHead: base1 }, 'https://github.com/unused/repo', join(root, 'absent'));
      expect(script).not.toContain('ls-remote');
      expect(script).not.toContain('git fetch --depth');
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd: warm });
      expect(result.exitCode).toBe(5);
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE_BASE_SHA_UNAVAILABLE ${missing}`);
      const io = /^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1];
      expect(JSON.parse(io!)).toMatchObject({ originCalls: 0, sourceStatus: 'incomplete', sourceVia: 'min-sync' });
      expect(execFileSync('git', ['-C', join(warm, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(base1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

/** 저장소의 upload-pack 설정 재정 목록. 프로덕션 기본값(재정 없음)이면 빈 문자열이다. */
function uploadPackOverrides(repo: string): string {
  try {
    return execFileSync('git', ['-C', repo, 'config', '--get-regexp', '^uploadpack\\.'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

type PodGithubObservation = {
  /** Pod 프로세스에 넘길 환경 — PATH 와 GIT_EXEC_PATH 가 관측 심으로 향한다. */
  env: Record<string, string | undefined>;
  /** 차단기에 잡힌 원격 전송 호출 = Pod 의 GitHub 접촉. 배열 하나 = 호출 하나. */
  githubCalls(): string[][];
  /** 래퍼에 잡힌 git 호출 전부 — 로컬 라우트가 실제로 흘렀는지 대조한다. */
  gitCalls(): string[][];
};

/** Pod GitHub 접촉의 외부 관측자. 스크립트 마커가 아니라 프로세스 «밖»에서 실제 전송 시도를 본다.
 *  PATH·GIT_EXEC_PATH 에 git 래퍼(호출 기록)와 git-remote-https·git-remote-http 차단기를 심는다 —
 *  로컬 전송(경로 미러·file://)은 실제 git 으로 통과시키고 원격 전송만 기록 후 실패시킨다. */
function observePodGithubTraffic(dir: string): PodGithubObservation {
  const bin = join(dir, 'observer-bin');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const execPath = execFileSync(realGit, ['--exec-path'], { encoding: 'utf8' }).trim();
  const gitTrace = join(dir, 'git-calls.log');
  const githubTrace = join(dir, 'github-calls.log');
  const record = (traceVar: string) => `printf "%s\\n" "$@" >> "$${traceVar}"\nprintf "\\036\\n" >> "$${traceVar}"`;
  for (const name of readdirSync(execPath)) {
    if (name === 'git' || name === 'git-remote-http' || name === 'git-remote-https') continue;
    symlinkSync(join(execPath, name), join(bin, name));
  }
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${record('ELANOUS_POD_OBSERVER_GIT_TRACE')}\nexec "${realGit}" "$@"\n`);
  const blocked = `#!/bin/sh\n${record('ELANOUS_POD_OBSERVER_GITHUB_TRACE')}\necho "fatal: external observer blocked a Pod GitHub call" >&2\nexit 128\n`;
  writeFileSync(join(bin, 'git-remote-https'), blocked);
  writeFileSync(join(bin, 'git-remote-http'), blocked);
  chmodSync(join(bin, 'git'), 0o755);
  chmodSync(join(bin, 'git-remote-https'), 0o755);
  chmodSync(join(bin, 'git-remote-http'), 0o755);
  const read = (path: string): string[][] => existsSync(path)
    ? readFileSync(path, 'utf8').split('\u001e').map((entry) => entry.split('\n').filter((arg) => arg !== '')).filter((argv) => argv.length > 0)
    : [];
  return {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GIT_EXEC_PATH: bin,
      GIT_TERMINAL_PROMPT: '0',
      ELANOUS_POD_OBSERVER_GIT_TRACE: gitTrace,
      ELANOUS_POD_OBSERVER_GITHUB_TRACE: githubTrace,
    },
    githubCalls: () => read(githubTrace),
    gitCalls: () => read(gitTrace),
  };
}

describe('podSourceScript under an external GitHub traffic observer', () => {
  test('a parent-resolved SHA reaches the checkout through the host mirror with zero Pod GitHub calls observed outside the Pod', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-external-obs-'));
    try {
      const observation = observePodGithubTraffic(root);
      const work = join(root, 'work');
      const mirror = join(root, 'host-mirror.git');
      const cwd = join(root, 'job');
      mkdirSync(work); mkdirSync(cwd);
      execFileSync('git', ['init', '-q', '-b', 'main', work]);
      execFileSync('git', ['-C', work, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', work, 'config', 'user.name', 'pod']);
      writeFileSync(join(work, 'README'), 'base\n');
      execFileSync('git', ['-C', work, 'add', 'README']);
      execFileSync('git', ['-C', work, 'commit', '-qm', 'base']);
      const baseSha = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', '--bare', work, mirror]);
      expect(uploadPackOverrides(mirror)).toBe('');

      const script = podSourceScript({ kind: 'default', baseSha }, 'https://github.com/elanous/elanous.git', mirror, { imageCommitFile: join(root, 'absent-image-commit') });
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd, env: observation.env });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toContain('ELANOUS_POD_SOURCE_VIA mirror');
      expect(result.stdout.toString()).toContain('ELANOUS_POD_SOURCE_BASE_SHA_FROM mirror');
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE default ${baseSha}`);
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(baseSha);
      const summary = JSON.parse(/^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1] ?? 'null') as { originCalls: number; sourceVia: string; sourceStatus: string };
      expect(summary).toMatchObject({ originCalls: 0, sourceVia: 'mirror', sourceStatus: 'complete' });
      // 외부 관측과 io-summary 정합: 밖에서 본 GitHub 전송 호출 수 == Pod 가 보고한 origin 호출 수 == 0.
      expect(observation.githubCalls()).toEqual([]);
      expect(observation.githubCalls().length).toBe(summary.originCalls);
      // 관측기가 git 자체를 막은 게 아니다 — 로컬 미러 라우트는 실제로 흘렀다.
      expect(observation.gitCalls().some((argv) => argv.includes('--no-write-fetch-head') && argv.includes(baseSha))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('a resolved SHA already inside the pinned image object store checks out with zero Pod GitHub calls observed outside the Pod', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-external-obs-image-'));
    try {
      const observation = observePodGithubTraffic(root);
      const origin = join(root, 'origin');
      const mirror = join(root, 'host-mirror.git');
      const image = join(root, 'image');
      const imageGit = join(root, 'pin.git');
      const marker = join(root, 'image-commit');
      const cwd = join(root, 'job');
      for (const path of [origin, image, cwd]) execFileSync('mkdir', ['-p', path]);
      execFileSync('git', ['init', '-q', '-b', 'main', origin]);
      execFileSync('git', ['-C', origin, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', origin, 'config', 'user.name', 'pod']);
      writeFileSync(join(origin, 'README'), 'pinned image contents\n');
      execFileSync('git', ['-C', origin, 'add', 'README']);
      execFileSync('git', ['-C', origin, 'commit', '-qm', 'pin']);
      const baseSha = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['clone', '-q', '--bare', origin, mirror]);
      execFileSync('git', ['clone', '-q', '--bare', '--depth', '1', `file://${origin}`, imageGit]);
      expect(readFileSync(join(imageGit, 'shallow'), 'utf8').trim()).toBe(baseSha);
      copyFileSync(join(origin, 'README'), join(image, 'README'));
      writeFileSync(marker, `${baseSha}\n`);
      expect(uploadPackOverrides(mirror)).toBe('');

      const script = podSourceScript({ kind: 'default', baseSha }, 'https://github.com/elanous/elanous.git', mirror, { imageSourceDir: image, imageCommitFile: marker, imageGitDir: imageGit });
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd, env: observation.env });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toContain('ELANOUS_POD_SOURCE_VIA image\n');
      // «실제 객체 출처» 마커 — 해결된 SHA 는 image 핀 객체에서 왔고 미러 clone 은 일어나지 않았다.
      expect(result.stdout.toString()).toContain('ELANOUS_POD_SOURCE_BASE_SHA_FROM image\n');
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE default ${baseSha}`);
      expect(readFileSync(join(cwd, 'repo', 'README'), 'utf8')).toBe('pinned image contents\n');
      expect(execFileSync('git', ['-C', join(cwd, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(baseSha);
      const summary = JSON.parse(/^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1] ?? 'null') as { originCalls: number; sourceVia: string; sourceStatus: string };
      expect(summary).toMatchObject({ originCalls: 0, sourceVia: 'image', sourceStatus: 'complete' });
      expect(observation.githubCalls()).toEqual([]);
      expect(observation.githubCalls().length).toBe(summary.originCalls);
      expect(observation.gitCalls().some((argv) => argv.includes('--shared'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('without a resolved SHA the legacy origin clone still runs and the same observer sees the Pod GitHub call it counts', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-external-obs-legacy-'));
    try {
      const observation = observePodGithubTraffic(root);
      const cwd = join(root, 'job');
      mkdirSync(cwd);
      const repoUrl = 'https://github.com/elanous/elanous.git';
      // 미러 부재 + image 핀 부재 + 해결된 SHA 없음 = 문서화된 legacy 분기(origin clone)만 남는다.
      const script = podSourceScript({ kind: 'default' }, repoUrl, join(root, 'absent-mirror'), { imageCommitFile: join(root, 'absent-image-commit') });
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd, env: observation.env });
      // 관측기가 전송을 끊었으니 clone 이 실패한다 — legacy 경로가 실제로 origin 을 불렀다는 증거.
      expect(result.exitCode).toBe(5);
      expect(`${result.stdout.toString()}${result.stderr.toString()}`).toContain('external observer blocked a Pod GitHub call');
      expect(result.stdout.toString()).toContain('ELANOUS_POD_SOURCE_MIRROR_SKIP no-mount');
      const summary = JSON.parse(/^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1] ?? 'null') as { originCalls: number; sourceVia: string; sourceStatus: string };
      expect(summary).toMatchObject({ originCalls: 1, sourceStatus: 'incomplete' });
      // clone 이 라우트를 확정하기 전에 끝났으므로 sourceVia 는 미확정으로 남는다.
      expect(summary.sourceVia).toBe('unknown');
      const githubCalls = observation.githubCalls();
      expect(githubCalls.length).toBe(1);
      expect(githubCalls[0]!).toContain(repoUrl);
      expect(githubCalls.length).toBe(summary.originCalls);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
