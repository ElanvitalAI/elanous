#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ReleaseFile { name: string; sha256: string; bytes: number }
export interface ReleaseResult { version: string; files: ReleaseFile[]; tag?: string; prerelease: boolean }
export interface ReleaseOptions { root?: string; out: string; tag?: string }

export class InvalidReleaseTagError extends Error {}

export class NonemptyReleaseDirectoryError extends Error {
  constructor(out: string) { super(`refusing to overwrite nonempty output directory: ${out}`); }
}

/** Pack the supplied tree (normally the public-export output), never the script's own checkout. */
export function buildRelease(opts: ReleaseOptions): ReleaseResult {
  const root = resolve(opts.root ?? join(import.meta.dir, '..'));
  const out = resolve(opts.out);
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  if (opts.tag !== undefined) {
    const match = /^v(\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?)$/.exec(opts.tag);
    if (!match) throw new InvalidReleaseTagError(`invalid release tag format: ${opts.tag}`);
    if (match[1] !== version) throw new InvalidReleaseTagError(`release tag version ${match[1]} does not match package.json version ${version}`);
  }
  if (existsSync(out) && (!statSync(out).isDirectory() || readdirSync(out).length > 0)) {
    throw new NonemptyReleaseDirectoryError(out);
  }
  if (!existsSync(join(root, 'apps/pwa/out/index.html'))) console.error('웹 화면 없는 판');
  mkdirSync(out, { recursive: true });
  const packed = spawnSync('bun', ['pm', 'pack', '--destination', out, '--quiet'], {
    cwd: root, encoding: 'utf8',
  });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error(`bun pm pack failed (${packed.status}): ${packed.stderr.trim()}`);
  const tarballs = readdirSync(out).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error(`bun pm pack produced ${tarballs.length} tarballs`);
  renameSync(join(out, tarballs[0]!), join(out, 'elanous.tgz'));
  copyFileSync(join(root, 'scripts/install.sh'), join(out, 'install.sh'));
  const pinnedBunVersion = readFileSync(join(root, '.bun-version'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinnedBunVersion)) throw new Error(`invalid .bun-version: ${pinnedBunVersion}`);
  const powershellInstaller = readFileSync(join(root, 'scripts/install.ps1'), 'utf8');
  if (powershellInstaller.split('__ELANOUS_BUN_VERSION__').length !== 2) throw new Error('install.ps1 must contain exactly one Bun version placeholder');
  writeFileSync(join(out, 'install.ps1'), powershellInstaller.replace('__ELANOUS_BUN_VERSION__', pinnedBunVersion));
  // 2026-09-25: 설치기의 짝 — 공개 사용자가 `curl …/releases/latest/download/uninstall.sh | bash` 로 제거한다.
  copyFileSync(join(root, 'scripts/uninstall.sh'), join(out, 'uninstall.sh'));
  const files = ['install.ps1', 'install.sh', 'elanous.tgz', 'uninstall.sh'].map((name) => {
    const body = readFileSync(join(out, name));
    return { name, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.byteLength };
  });
  writeFileSync(join(out, 'SHA256SUMS'), files.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(''));
  return { version, files, ...(opts.tag !== undefined ? { tag: opts.tag } : {}), prerelease: version.includes('-') };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let root: string | undefined;
  let out: string | undefined;
  let tag: string | undefined;
  let valid = true;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--root' || args[i] === '--out' || args[i] === '--tag') && args[i + 1] && !args[i + 1]!.startsWith('--')) {
      if (args[i] === '--root') root = args[++i];
      else if (args[i] === '--out') out = args[++i];
      else tag = args[++i];
    } else valid = false;
  }
  if (!valid || !out) {
    console.error('usage: bun scripts/release-build.ts [--root <tree>] --out <directory> [--tag <tag>]');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(buildRelease({ root, out, tag }))); }
    catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = error instanceof NonemptyReleaseDirectoryError || error instanceof InvalidReleaseTagError ? 2 : 1;
    }
  }
}
