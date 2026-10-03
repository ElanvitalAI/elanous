import { setDefaultTimeout, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const entry = resolve(import.meta.dir, 'publish-internal-dist.ts');

test('two checkout revisions publish verified bot archives; latest switches and old versions are pruned', () => {
  const root = mkdtempSync(join(tmpdir(), 'internal-dist-'));
  const checkout = join(root, 'checkout');
  const out = join(root, 'out');
  mkdirSync(join(checkout, 'scripts/botlab'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'elanous', version: '0.2.3', files: ['scripts/'], private: true }));
  writeFileSync(join(checkout, 'scripts/install.sh'), '#!/usr/bin/env bash\necho install\n');
  writeFileSync(join(checkout, 'scripts/botlab/bot-canary.ts'), 'export const revision = 1;\n');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  const publish = (keep = 3) => {
    const run = spawnSync('bun', [entry, '--checkout', checkout, '--out', out, '--keep', String(keep)], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { ok: boolean; version: string; commit: string; sha256: string; out: string };
  };
  try {
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'first');
    const first = publish(1);
    writeFileSync(join(checkout, 'scripts/botlab/bot-canary.ts'), 'export const revision = 2;\n');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'second');
    const second = publish(1);
    expect(first.commit).not.toBe(second.commit);
    expect(second).toMatchObject({ ok: true, version: '0.2.3', out });
    const dir = join(out, 'download', `v0.2.3-${second.commit.slice(0, 12)}`);
    expect(readlinkSync(join(out, 'latest/download'))).toBe(`../download/v0.2.3-${second.commit.slice(0, 12)}`);
    expect(readlinkSync(join(out, 'download/v0.2.3'))).toBe(`v0.2.3-${second.commit.slice(0, 12)}`);
    expect(readFileSync(join(out, 'download/v0.2.3/install.sh'), 'utf8')).toContain('echo install');
    const archive = join(dir, 'elanous.tgz');
    const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
    expect(second.sha256).toBe(actual);
    expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8')).toBe(`${actual}  elanous.tgz\n`);
    expect(readFileSync(join(out, 'latest/download/SHA256SUMS'), 'utf8')).toBe(`${actual}  elanous.tgz\n`);
    expect(readFileSync(join(dir, 'install.sh'), 'utf8')).toContain('echo install');
    expect(readFileSync(join(out, 'latest/download/install.sh'), 'utf8')).toContain('echo install');
    expect(spawnSync('tar', ['-xzOf', archive, 'package/scripts/botlab/bot-canary.ts'], { encoding: 'utf8' }).stdout).toContain('revision = 2');
    expect(spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: dir, encoding: 'utf8' }).status).toBe(0);
    expect(publish(1)).toMatchObject(second);
    const installerContents = readFileSync(join(dir, 'install.sh'), 'utf8');
    writeFileSync(join(dir, 'install.sh'), '#!/bin/sh\necho compromised\n');
    const tamperedInstaller = spawnSync('bun', [entry, '--checkout', checkout, '--out', out], { encoding: 'utf8' });
    expect(tamperedInstaller.status).toBe(1);
    expect(tamperedInstaller.stderr).toContain('incomplete or has invalid checksum');
    expect(readlinkSync(join(out, 'latest/download'))).toBe(`../download/v0.2.3-${second.commit.slice(0, 12)}`);
    writeFileSync(join(dir, 'install.sh'), installerContents);
    expect(publish(1)).toMatchObject(second);
    writeFileSync(join(dir, 'SHA256SUMS'), `${'0'.repeat(64)}  elanous.tgz\n`);
    expect(spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: dir, encoding: 'utf8' }).status).toBe(1);
    const corrupted = spawnSync('bun', [entry, '--checkout', checkout, '--out', out], { encoding: 'utf8' });
    expect(corrupted.status).toBe(1);
    expect(existsSync(join(out, 'download', `v0.2.3-${first.commit.slice(0, 12)}`))).toBe(false);
    expect(readlinkSync(join(out, 'download/v0.2.3'))).toBe(`v0.2.3-${second.commit.slice(0, 12)}`);
    rmSync(join(checkout, 'scripts/botlab/bot-canary.ts'));
    const bad = spawnSync('bun', [entry, '--checkout', checkout, '--out', out], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(readlinkSync(join(out, 'latest/download'))).toBe(`../download/v0.2.3-${second.commit.slice(0, 12)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI refuses untracked and modified packed files before publishing latest', () => {
  const root = mkdtempSync(join(tmpdir(), 'internal-dist-dirty-'));
  const checkout = join(root, 'checkout');
  const out = join(root, 'out');
  mkdirSync(join(checkout, 'scripts/botlab'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'elanous', version: '0.2.3', files: ['scripts/'], private: true }));
  writeFileSync(join(checkout, 'scripts/install.sh'), '#!/bin/sh\necho install\n');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
    expect(result.status).toBe(0);
  };
  const publish = () => spawnSync('bun', [entry, '--checkout', checkout, '--out', out], { encoding: 'utf8' });
  try {
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
    writeFileSync(join(checkout, 'scripts/botlab/bot-canary.ts'), 'export const revision = 1;\n');
    const untracked = publish();
    expect(untracked.status).toBe(1);
    expect(untracked.stderr).toContain('not committed');
    expect(existsSync(join(out, 'latest/download'))).toBe(false);

    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'canary');
    writeFileSync(join(checkout, 'scripts/botlab/bot-canary.ts'), 'export const revision = 2;\n');
    const modified = publish();
    expect(modified.status).toBe(1);
    expect(modified.stderr).toContain('differ from HEAD');
    expect(existsSync(join(out, 'latest/download'))).toBe(false);
    git('add', '.');
    const staged = publish();
    expect(staged.status).toBe(1);
    expect(existsSync(join(out, 'latest/download'))).toBe(false);
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'revision');
    writeFileSync(join(checkout, 'scripts/install.sh'), '#!/bin/sh\necho different installer\n');
    const installer = publish();
    expect(installer.status).toBe(1);
    expect(installer.stderr).toContain('differ from HEAD');
    expect(existsSync(join(out, 'latest/download'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI refuses uncommitted pack ignore rules without moving latest', () => {
  const root = mkdtempSync(join(tmpdir(), 'internal-dist-ignore-'));
  const checkout = join(root, 'checkout');
  const out = join(root, 'out');
  mkdirSync(join(checkout, 'scripts/botlab'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'elanous', version: '0.2.3', files: ['scripts/'], private: true }));
  writeFileSync(join(checkout, 'scripts/install.sh'), '#!/bin/sh\necho install\n');
  writeFileSync(join(checkout, 'scripts/botlab/bot-canary.ts'), 'export const revision = 1;\n');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
    expect(result.status).toBe(0);
  };
  const publish = () => spawnSync('bun', [entry, '--checkout', checkout, '--out', out], { encoding: 'utf8' });
  try {
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
    expect(publish().status).toBe(0);
    const latest = readlinkSync(join(out, 'latest/download'));
    writeFileSync(join(checkout, '.npmignore'), 'scripts/install.sh\n');
    const untracked = publish();
    expect(untracked.status).toBe(1);
    expect(untracked.stderr).toContain('pack inputs differ from HEAD');
    expect(readlinkSync(join(out, 'latest/download'))).toBe(latest);
    git('add', '.npmignore');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'ignore rules');
    writeFileSync(join(checkout, '.npmignore'), 'scripts/botlab/unused.ts\n');
    const modified = publish();
    expect(modified.status).toBe(1);
    expect(modified.stderr).toContain('pack inputs differ from HEAD');
    expect(readlinkSync(join(out, 'latest/download'))).toBe(latest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an uncommitted PWA build output is packed (build artifact) while other uncommitted packed files still fail', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'internal-dist-pwa-'));
  const out = mkdtempSync(join(tmpdir(), 'internal-dist-pwa-out-'));
  try {
    mkdirSync(join(checkout, 'scripts/botlab'), { recursive: true });
    mkdirSync(join(checkout, 'apps/pwa/out'), { recursive: true });
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'elanous', version: '0.2.3', files: ['scripts/', 'apps/pwa/out/'], private: true }));
    writeFileSync(join(checkout, '.gitignore'), 'apps/pwa/out/\n');
    writeFileSync(join(checkout, 'scripts/install.sh'), '#!/usr/bin/env bash\necho install\n');
    writeFileSync(join(checkout, 'scripts/botlab/bot-canary.ts'), 'export const revision = 1;\n');
    const git = (...args: string[]) => spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'first');
    // 04:33 설치처럼 PWA 를 빌드한 뒤 — 산출물은 커밋되지 않는다.
    writeFileSync(join(checkout, 'apps/pwa/out/index.html'), '<html></html>\n');
    const ok = spawnSync('bun', [entry, '--checkout', checkout, '--out', out], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout.trim().split('\n').at(-1)!)).toMatchObject({ ok: true, pwaBuild: 'present' });
    // 빌드 산출물이 아닌 커밋 안 된 파일은 여전히 막는다.
    writeFileSync(join(checkout, 'scripts/botlab/extra.ts'), 'export {};\n');
    const refused = spawnSync('bun', [entry, '--checkout', checkout, '--out', out], { encoding: 'utf8' });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain('scripts/botlab/extra.ts');
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
