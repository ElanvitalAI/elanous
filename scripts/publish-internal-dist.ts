#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSyncText } from '../src/util/spawn-sync-output.js';

export function publishInternalDist(checkout: string, out: string, keep = 3): { ok: true; version: string; commit: string; sha256: string; out: string; pwaBuild: 'present' | 'missing' } {
  checkout = resolve(checkout);
  out = resolve(out);
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('--keep must be a positive integer');
  const pkg = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (pkg.name !== 'elanous' || !pkg.version || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(pkg.version)) throw new Error('invalid elanous package version');
  if (!existsSync(join(checkout, 'scripts/install.sh')) || !existsSync(join(checkout, 'scripts/botlab/bot-canary.ts'))) {
    throw new Error('checkout must contain scripts/install.sh and scripts/botlab/bot-canary.ts');
  }
  const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: checkout, encoding: 'utf8' });
  const commit = git.stdout?.trim() ?? '';
  if (git.status !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`checkout commit unavailable: ${git.stderr}`);
  const name = `v${pkg.version}-${commit.slice(0, 12)}`;
  const download = join(out, 'download');
  const target = join(download, name);
  mkdirSync(download, { recursive: true });
  const staging = mkdtempSync(join(download, '.publish-'));
  let link: string | undefined;
  try {
    const packed = spawnSync('bun', ['pm', 'pack', '--destination', staging], { cwd: checkout, encoding: 'utf8' });
    if (packed.status !== 0) throw new Error(`bun pm pack failed: ${packed.stderr || packed.stdout}`);
    const tgz = readdirSync(staging).find((file) => file.endsWith('.tgz'));
    if (!tgz) throw new Error('bun pm pack produced no tgz');
    const archive = join(staging, tgz);
    const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    if (listed.status !== 0 || !listed.stdout.split('\n').includes('package/scripts/botlab/bot-canary.ts')) {
      throw new Error('packed archive is missing scripts/botlab/bot-canary.ts');
    }
    const packedPaths = listed.stdout.split('\n')
      .filter((path) => path.startsWith('package/') && !path.endsWith('/'))
      .map((path) => path.slice('package/'.length));
    // The separately served installer is also part of this release, even if bun excludes it from the tarball.
    // 빌드 산출물(PWA 정적 export)은 커밋되지 않는 것이 정상이다 — 설치기(`scripts/install.sh`)도 그것을 싣고 «없으면 말한다».
    //   🩸 09-27 운영 체크아웃 실측: 04:33 설치가 PWA 를 먼저 빌드해 `apps/pwa/out/**` 가 있고, 커밋 검사가 그것을 막았다.
    //   `src/version/packed-revision.json` 은 `bun pm pack` 의 prepack 훅이 «그 HEAD» 를 새기고 postpack 이 지우는 산출물이다(package.json scripts).
    const isBuildOutput = (path: string): boolean => path.startsWith('apps/pwa/out/') || path === 'src/version/packed-revision.json';
    const publishedPaths = [...new Set([...packedPaths, 'scripts/install.sh'])].filter((path) => !isBuildOutput(path));
    const pwaBuild: 'present' | 'missing' = packedPaths.includes('apps/pwa/out/index.html') ? 'present' : 'missing';
    const committed = new Set(spawnSyncText('git', ['ls-files', '--cached', '-z'], { cwd: checkout, encoding: 'utf8' }).split('\0').filter(Boolean));
    const uncommitted = publishedPaths.filter((path) => !committed.has(path));
    if (uncommitted.length) throw new Error(`packed files not committed at HEAD: ${uncommitted.join(', ')}`);
    const changed = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', ...publishedPaths], { cwd: checkout, encoding: 'utf8' });
    if (changed.status !== 0) {
      if (changed.status === 1) throw new Error('packed files differ from HEAD');
      throw new Error(`cannot verify packed files against HEAD: ${changed.stderr}`);
    }
    // Ignore rules can change what bun packs without themselves appearing in the archive.
    // ⛔ `--ignored` 를 쓰지 않는다 — 무시된 폴더(node_modules · .elanous-test) 안의 ignore 파일은 묶음에 안 들어가 결과를 못 바꾼다.
    //   🩸 09-27 운영 체크아웃 실측: `--ignored` 가 node_modules 안 `.npmignore` 28개를 «pack 입력 변경»으로 잡아 늘 실패했다.
    const packInputs = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'package.json', '.npmignore', ':(glob)**/.npmignore', '.gitignore', ':(glob)**/.gitignore'], { cwd: checkout, encoding: 'utf8' });
    if (packInputs.status !== 0) throw new Error(`cannot verify pack inputs against HEAD: ${packInputs.stderr}`);
    if (packInputs.stdout.trim()) throw new Error(`pack inputs differ from HEAD: ${packInputs.stdout.trim()}`);
    renameSync(archive, join(staging, 'elanous.tgz'));
    const sha256 = createHash('sha256').update(readFileSync(join(staging, 'elanous.tgz'))).digest('hex');
    writeFileSync(join(staging, 'SHA256SUMS'), `${sha256}  elanous.tgz\n`);
    writeFileSync(join(staging, 'install.sh'), readFileSync(join(checkout, 'scripts/install.sh')));
    if (existsSync(target)) {
      const existing = join(target, 'elanous.tgz');
      const publishedHash = createHash('sha256').update(readFileSync(existing)).digest('hex');
      if (readFileSync(join(target, 'SHA256SUMS'), 'utf8') !== `${publishedHash}  elanous.tgz\n` ||
        !existsSync(join(target, 'install.sh')) ||
        !readFileSync(join(target, 'install.sh')).equals(readFileSync(join(staging, 'install.sh'))) ||
        !spawnSync('tar', ['-tzf', existing], { encoding: 'utf8' }).stdout.split('\n').includes('package/scripts/botlab/bot-canary.ts')) {
        throw new Error(`published version is incomplete or has invalid checksum: ${name}`);
      }
      if (sha256 !== publishedHash) throw new Error(`checkout contents differ from published version: ${name}`);
    } else {
      renameSync(staging, target);
    }
    mkdirSync(join(out, 'latest'), { recursive: true });
    link = join(out, 'latest', `.download-${process.pid}-${Date.now()}`);
    symlinkSync(`../download/${name}`, link, 'dir');
    renameSync(link, join(out, 'latest', 'download'));
    link = undefined;
    const versions = readdirSync(download, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^v[0-9A-Za-z][0-9A-Za-z._-]*-[0-9a-f]{12}$/.test(entry.name))
      .map((entry) => ({ name: entry.name, mtime: statSync(join(download, entry.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const retained = new Set([name, ...versions.filter((version) => version.name !== name).slice(0, keep - 1).map((version) => version.name)]);
    for (const version of versions) {
      if (!retained.has(version.name)) rmSync(join(download, version.name), { recursive: true });
    }
    return { ok: true, version: pkg.version, commit, sha256, out, pwaBuild };
  } finally {
    if (link) rmSync(link, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    let checkout: string | undefined;
    let out: string | undefined;
    let keep = 3;
    while (args.length) {
      const flag = args.shift();
      const value = args.shift();
      if (!value) throw new Error(`missing value for ${flag}`);
      if (flag === '--checkout') checkout = value;
      else if (flag === '--out') out = value;
      else if (flag === '--keep') keep = Number(value);
      else throw new Error(`unknown option: ${flag}`);
    }
    if (!checkout || !out) throw new Error('usage: bun scripts/publish-internal-dist.ts --checkout <checkout> --out <folder> [--keep 3]');
    console.log(JSON.stringify(publishInternalDist(checkout, out, keep)));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
