import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setGitCommandRunnerForTesting } from '../src/git-fs/runner.js';
import { cliVersion, setInstallMetadataRootForTesting } from '../src/index.js';
import { installMetadataSource, packageVersion } from '../src/version/code-revision.js';

const INSTALL_REVISION = 'a'.repeat(40);
const CALLER_REVISION = 'b'.repeat(40);
const METADATA_COMMIT = 'c'.repeat(40);
const CONSUMER_COMMIT = 'd'.repeat(40);
const INSTALL_ROOT = resolve(import.meta.dir, '..');

afterEach(() => {
  setGitCommandRunnerForTesting(undefined);
  setInstallMetadataRootForTesting(undefined);
});

function withUnrelatedCaller<T>(run: () => T): T {
  const caller = mkdtempSync(join(tmpdir(), 'elanous-version-caller-'));
  const originalCwd = process.cwd();
  process.chdir(caller);
  try {
    return run();
  } finally {
    process.chdir(originalCwd);
    rmSync(caller, { recursive: true, force: true });
  }
}

function withInstallMetadata<T>(contents: string | undefined, run: () => T): T {
  const root = mkdtempSync(join(tmpdir(), 'elanous-install-meta-'));
  setInstallMetadataRootForTesting(root);
  try {
    if (contents !== undefined) {
      writeFileSync(join(root, 'install.json'), contents);
    }
    return run();
  } finally {
    setInstallMetadataRootForTesting(undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

function failGitAtInstallRoot(calls: string[]) {
  setGitCommandRunnerForTesting((cwd) => {
    calls.push(cwd);
    return cwd === INSTALL_ROOT
      ? { status: 1, stdout: '', stderr: 'not a git repository' }
      : { status: 0, stdout: `${CALLER_REVISION}\n`, stderr: '' };
  });
}

describe('install metadata source', () => {
  test('returns the exact source only when it is a string naming an existing directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-source-'));
    try {
      const source = join(root, 'repository');
      mkdirSync(source);
      writeFileSync(join(root, 'file'), 'not a directory');
      for (const invalid of [undefined, null, 42, {}, '', 'local', join(root, 'file')]) {
        writeFileSync(join(root, 'install.json'), JSON.stringify({ source: invalid }));
        expect(installMetadataSource(root)).toBeUndefined();
      }
      writeFileSync(join(root, 'install.json'), '{not-json');
      expect(installMetadataSource(root)).toBeUndefined();
      writeFileSync(join(root, 'install.json'), JSON.stringify({ source }));
      withUnrelatedCaller(() => expect(installMetadataSource(root)).toBe(source));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reads the installer prefix metadata only with the package installer shim', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'elanous-source-prefix-'));
    try {
      const packageRoot = join(prefix, 'node_modules', 'elanous');
      const source = join(prefix, 'repository');
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      mkdirSync(join(prefix, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      mkdirSync(source);
      writeFileSync(join(packageRoot, 'bin', 'elanous.mjs'), '');
      symlinkSync(join('..', 'elanous', 'bin', 'elanous.mjs'), join(prefix, 'node_modules', '.bin', 'elanous'));
      writeFileSync(join(prefix, 'install.json'), JSON.stringify({ source }));
      expect(installMetadataSource(packageRoot)).toBeUndefined();
      symlinkSync(join('..', 'node_modules', '.bin', 'elanous'), join(prefix, 'bin', 'elanous'));
      expect(installMetadataSource(packageRoot)).toBe(source);
      writeFileSync(join(packageRoot, 'install.json'), JSON.stringify({ source: 'local' }));
      expect(installMetadataSource(packageRoot)).toBe(source);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  test('reads versioned metadata rather than the last installed root metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-source-versioned-'));
    try {
      const versionDir = join(root, 'versions', '1.0.0-cccccccccccc');
      const packageRoot = join(versionDir, 'node_modules', 'elanous');
      const source = join(root, 'repository');
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(join(versionDir, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      mkdirSync(source);
      writeFileSync(join(packageRoot, 'bin', 'elanous.mjs'), '');
      symlinkSync(join('..', 'elanous', 'bin', 'elanous.mjs'), join(versionDir, 'node_modules', '.bin', 'elanous'));
      symlinkSync(join('versions', '1.0.0-cccccccccccc'), join(root, 'current'));
      symlinkSync(join('..', 'current', 'node_modules', '.bin', 'elanous'), join(root, 'bin', 'elanous'));
      writeFileSync(join(versionDir, 'install.json'), JSON.stringify({ source }));
      writeFileSync(join(root, 'install.json'), JSON.stringify({ source: root }));
      expect(installMetadataSource(packageRoot)).toBe(source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('CLI version revision', () => {
  test('uses the installed tool repository revision instead of a different caller repository revision', () => {
    const calls: string[] = [];
    setGitCommandRunnerForTesting((cwd) => {
      calls.push(cwd);
      return {
        status: 0,
        stdout: `${cwd === INSTALL_ROOT ? INSTALL_REVISION : CALLER_REVISION}\n`,
        stderr: '',
      };
    });

    withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} ${INSTALL_REVISION}`));
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('uses the installed tool repository revision when the caller is not a Git repository', () => {
    const calls: string[] = [];
    setGitCommandRunnerForTesting((cwd) => {
      calls.push(cwd);
      return {
        status: 0,
        stdout: `${cwd === INSTALL_ROOT ? INSTALL_REVISION : 'not-a-repository\n'}`,
        stderr: '',
      };
    });

    withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} ${INSTALL_REVISION}`));
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('returns unknown when the installed tool repository cannot resolve HEAD without falling back to the caller', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    withInstallMetadata(undefined, () => {
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} unknown`));
    });
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('uses install.json commit when git cannot resolve HEAD', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    withInstallMetadata(JSON.stringify({
      version: '1.0.0',
      source: 'local',
      installedAt: '2026-09-22T00:00:00Z',
      commit: METADATA_COMMIT,
    }), () => {
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} ${METADATA_COMMIT}`));
    });
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('prefers git revision over install.json commit', () => {
    const calls: string[] = [];
    setGitCommandRunnerForTesting((cwd) => {
      calls.push(cwd);
      return {
        status: 0,
        stdout: `${cwd === INSTALL_ROOT ? INSTALL_REVISION : CALLER_REVISION}\n`,
        stderr: '',
      };
    });

    withInstallMetadata(JSON.stringify({ commit: METADATA_COMMIT }), () => {
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} ${INSTALL_REVISION}`));
    });
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('returns unknown when install.json is malformed JSON', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    withInstallMetadata('{not-json', () => {
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} unknown`));
    });
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('does not use caller install.json when the installed tool cannot resolve HEAD', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    withInstallMetadata(undefined, () => {
      withUnrelatedCaller(() => {
        writeFileSync(join(process.cwd(), 'install.json'), JSON.stringify({ commit: METADATA_COMMIT }));
        expect(cliVersion()).toBe(`${packageVersion()} unknown`);
      });
    });
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('rejects install.json commit with embedded newline and stays one line', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    withInstallMetadata(JSON.stringify({ commit: 'abc\nforged' }), () => {
      const version = withUnrelatedCaller(() => cliVersion());
      expect(version).toBe(`${packageVersion()} unknown`);
      expect(version.includes('\n')).toBe(false);
      expect(version.split('\n')).toHaveLength(1);
    });
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('rejects install.json commit with internal whitespace and stays one line', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    withInstallMetadata(JSON.stringify({ commit: 'abc forged' }), () => {
      const version = withUnrelatedCaller(() => cliVersion());
      expect(version).toBe(`${packageVersion()} unknown`);
      expect(version.includes('\n')).toBe(false);
      expect(version.split('\n')).toHaveLength(1);
    });
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('does not use a consumer project install.json above node_modules when git cannot resolve HEAD', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    const consumer = mkdtempSync(join(tmpdir(), 'elanous-consumer-meta-'));
    try {
      writeFileSync(join(consumer, 'install.json'), JSON.stringify({
        version: '1.0.0',
        source: 'consumer',
        installedAt: '2026-09-22T00:00:00Z',
        commit: CONSUMER_COMMIT,
      }));
      const packageRoot = join(consumer, 'node_modules', 'elanous');
      mkdirSync(packageRoot, { recursive: true });
      setInstallMetadataRootForTesting(packageRoot);
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} unknown`));
    } finally {
      setInstallMetadataRootForTesting(undefined);
      rmSync(consumer, { recursive: true, force: true });
    }
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('uses installer prefix install.json when nested under node_modules with the installer shim', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    const prefix = mkdtempSync(join(tmpdir(), 'elanous-installer-prefix-'));
    try {
      const packageRoot = join(prefix, 'node_modules', 'elanous');
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      mkdirSync(join(prefix, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(join(packageRoot, 'bin', 'elanous.mjs'), '');
      symlinkSync(join('..', 'elanous', 'bin', 'elanous.mjs'), join(prefix, 'node_modules', '.bin', 'elanous'));
      symlinkSync(join('..', 'node_modules', '.bin', 'elanous'), join(prefix, 'bin', 'elanous'));
      writeFileSync(join(prefix, 'install.json'), JSON.stringify({
        version: '1.0.0',
        source: 'local',
        installedAt: '2026-09-22T00:00:00Z',
        commit: METADATA_COMMIT,
      }));
      setInstallMetadataRootForTesting(packageRoot);
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} ${METADATA_COMMIT}`));
    } finally {
      setInstallMetadataRootForTesting(undefined);
      rmSync(prefix, { recursive: true, force: true });
    }
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  // 🆕 2026-09-24 — 판 폴더 레이아웃(versions/<판> · current · bin/elanous). 종전엔 이 레이아웃에서 늘 `unknown` 이었다.
  test('versioned installer layout reads the running version folder install.json, not the root one', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    const root = mkdtempSync(join(tmpdir(), 'elanous-installer-versioned-'));
    try {
      const versionDir = join(root, 'versions', '1.0.0-cccccccccccc');
      const packageRoot = join(versionDir, 'node_modules', 'elanous');
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(join(versionDir, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(join(packageRoot, 'bin', 'elanous.mjs'), '');
      symlinkSync(join('..', 'elanous', 'bin', 'elanous.mjs'), join(versionDir, 'node_modules', '.bin', 'elanous'));
      symlinkSync(join('versions', '1.0.0-cccccccccccc'), join(root, 'current'));
      symlinkSync(join('..', 'current', 'node_modules', '.bin', 'elanous'), join(root, 'bin', 'elanous'));
      writeFileSync(join(versionDir, 'install.json'), JSON.stringify({ commit: METADATA_COMMIT }));
      writeFileSync(join(root, 'install.json'), JSON.stringify({ commit: CONSUMER_COMMIT }));   // 마지막 설치(다른 판)
      setInstallMetadataRootForTesting(packageRoot);
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} ${METADATA_COMMIT}`));
    } finally {
      setInstallMetadataRootForTesting(undefined);
      rmSync(root, { recursive: true, force: true });
    }
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('versioned layout without the installer root shim does not trust the version folder install.json', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    const root = mkdtempSync(join(tmpdir(), 'elanous-installer-versioned-'));
    try {
      const versionDir = join(root, 'versions', '1.0.0-cccccccccccc');
      const packageRoot = join(versionDir, 'node_modules', 'elanous');
      mkdirSync(join(versionDir, 'node_modules', '.bin'), { recursive: true });
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(join(packageRoot, 'bin', 'elanous.mjs'), '');
      symlinkSync(join('..', 'elanous', 'bin', 'elanous.mjs'), join(versionDir, 'node_modules', '.bin', 'elanous'));
      writeFileSync(join(versionDir, 'install.json'), JSON.stringify({ commit: METADATA_COMMIT }));
      setInstallMetadataRootForTesting(packageRoot);
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} unknown`));
    } finally {
      setInstallMetadataRootForTesting(undefined);
      rmSync(root, { recursive: true, force: true });
    }
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('uses installer prefix install.json when nested under node_modules with the windows installer shim', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    const prefix = mkdtempSync(join(tmpdir(), 'elanous-installer-cmd-'));
    try {
      const packageRoot = join(prefix, 'node_modules', 'elanous');
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(join(packageRoot, 'bin', 'elanous.mjs'), '');
      writeFileSync(join(prefix, 'bin', 'elanous.cmd'), '@echo off\r\nbun "%~dp0..\\node_modules\\elanous\\bin\\elanous.mjs" %*\r\n');
      writeFileSync(join(prefix, 'install.json'), JSON.stringify({
        version: '1.0.0',
        source: 'local',
        installedAt: '2026-09-22T00:00:00Z',
        commit: METADATA_COMMIT,
      }));
      setInstallMetadataRootForTesting(packageRoot);
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} ${METADATA_COMMIT}`));
    } finally {
      setInstallMetadataRootForTesting(undefined);
      rmSync(prefix, { recursive: true, force: true });
    }
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('does not use prefix install.json when bin/elanous is an unrelated file rather than the installer shim', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    const consumer = mkdtempSync(join(tmpdir(), 'elanous-unrelated-shim-'));
    try {
      const packageRoot = join(consumer, 'node_modules', 'elanous');
      mkdirSync(join(consumer, 'bin'), { recursive: true });
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(join(packageRoot, 'bin', 'elanous.mjs'), '');
      writeFileSync(join(consumer, 'bin', 'elanous'), '');
      writeFileSync(join(consumer, 'bin', 'elanous.cmd'), '@echo off\r\necho unrelated\r\n');
      writeFileSync(join(consumer, 'install.json'), JSON.stringify({
        version: '1.0.0',
        source: 'consumer',
        installedAt: '2026-09-22T00:00:00Z',
        commit: CONSUMER_COMMIT,
      }));
      setInstallMetadataRootForTesting(packageRoot);
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} unknown`));
    } finally {
      setInstallMetadataRootForTesting(undefined);
      rmSync(consumer, { recursive: true, force: true });
    }
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('does not use prefix install.json when bin/elanous is a consumer symlink that happens to resolve to this package', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    const consumer = mkdtempSync(join(tmpdir(), 'elanous-coincidental-shim-'));
    try {
      const packageRoot = join(consumer, 'node_modules', 'elanous');
      mkdirSync(join(consumer, 'bin'), { recursive: true });
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(join(packageRoot, 'bin', 'elanous.mjs'), '');
      symlinkSync(join('..', 'node_modules', 'elanous', 'bin', 'elanous.mjs'), join(consumer, 'bin', 'elanous'));
      writeFileSync(join(consumer, 'install.json'), JSON.stringify({
        version: '1.0.0',
        source: 'consumer',
        installedAt: '2026-09-22T00:00:00Z',
        commit: CONSUMER_COMMIT,
      }));
      setInstallMetadataRootForTesting(packageRoot);
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} unknown`));
    } finally {
      setInstallMetadataRootForTesting(undefined);
      rmSync(consumer, { recursive: true, force: true });
    }
    expect(calls).toEqual([INSTALL_ROOT]);
  });

  test('does not use prefix install.json when bin/elanous.cmd names the package without the installer-relative path', () => {
    const calls: string[] = [];
    failGitAtInstallRoot(calls);

    const consumer = mkdtempSync(join(tmpdir(), 'elanous-unrelated-cmd-path-'));
    try {
      const packageRoot = join(consumer, 'node_modules', 'elanous');
      mkdirSync(join(consumer, 'bin'), { recursive: true });
      mkdirSync(join(packageRoot, 'bin'), { recursive: true });
      writeFileSync(join(packageRoot, 'bin', 'elanous.mjs'), '');
      writeFileSync(
        join(consumer, 'bin', 'elanous.cmd'),
        '@echo off\r\nbun "C:\\caller\\node_modules\\elanous\\bin\\elanous.mjs" %*\r\n',
      );
      writeFileSync(join(consumer, 'install.json'), JSON.stringify({
        version: '1.0.0',
        source: 'consumer',
        installedAt: '2026-09-22T00:00:00Z',
        commit: CONSUMER_COMMIT,
      }));
      setInstallMetadataRootForTesting(packageRoot);
      withUnrelatedCaller(() => expect(cliVersion()).toBe(`${packageVersion()} unknown`));
    } finally {
      setInstallMetadataRootForTesting(undefined);
      rmSync(consumer, { recursive: true, force: true });
    }
    expect(calls).toEqual([INSTALL_ROOT]);
  });
});
