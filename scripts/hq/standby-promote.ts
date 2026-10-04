#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { debug } from '../../src/debug/log.js';
import type { Tier } from './standby-snapshot.js';

interface Generation { tier: Tier; name: string; dir: string; files: string[] }
interface Options { to: string; standby: string; tiers: Tier[]; hqConfig?: string; dryRun: boolean; json: boolean }

function contained(base: string, name: string): string {
  if (!name || isAbsolute(name) || name.includes('\\')) throw new Error(`invalid relative path: ${name}`);
  const path = resolve(base, name);
  const rel = relative(base, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`path escapes generation: ${name}`);
  return path;
}

function expand(path: string): string { return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path; }

export function parsePromoteArgs(argv: string[]): Options {
  const options: Options = { to: '', standby: join(homedir(), '.elanous-standby'), tiers: ['core', 'big'], dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') { options.dryRun = true; continue; }
    if (flag === '--json') { options.json = true; continue; }
    if (!['--to', '--standby', '--tiers', '--hq-config'].includes(flag)) throw new Error(`unknown option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--to') options.to = resolve(expand(value));
    if (flag === '--standby') options.standby = resolve(expand(value));
    if (flag === '--hq-config') options.hqConfig = resolve(expand(value));
    if (flag === '--tiers') {
      const tiers = value.split(',');
      if (tiers.some(t => !['core', 'big', 'obs'].includes(t)) || new Set(tiers).size !== tiers.length) throw new Error('--tiers must be core,big,obs without duplicates');
      options.tiers = tiers as Tier[];
    }
  }
  if (!options.to) throw new Error('--to is required');
  return options;
}

function isInside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function checkedFile(dir: string, name: string): string {
  const path = contained(dir, name);
  let current = dir;
  for (const part of relative(dir, path).split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink in generation: ${name}`);
  }
  if (!lstatSync(path).isFile()) throw new Error(`not a file: ${name}`);
  return path;
}

async function readGeneration(standby: string, tier: Tier): Promise<Generation> {
  const base = join(standby, tier);
  const name = readlinkSync(join(base, 'latest'));
  const dir = contained(base, name);
  if (relative(base, dir) !== name || !lstatSync(dir).isDirectory()) throw new Error(`${tier}: invalid latest`);
  const manifest = JSON.parse(readFileSync(checkedFile(dir, 'MANIFEST.json'), 'utf8')) as { generation?: string; tier?: string; entries?: Array<{ path: string; sha256: string }> };
  if (manifest.generation !== name || manifest.tier !== tier || !Array.isArray(manifest.entries)) throw new Error(`${tier}: invalid manifest`);
  const lines = readFileSync(checkedFile(dir, 'SHA256SUMS'), 'utf8').trimEnd().split('\n');
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64})  (.+)$/.exec(line);
    if (!match || seen.has(match[2]) || ['MANIFEST.json', 'SHA256SUMS'].includes(match[2])) throw new Error(`${tier}: invalid SHA256SUMS`);
    seen.add(match[2]);
    const file = checkedFile(dir, match[2]);
    if (await sha256(file) !== match[1].toLowerCase()) throw new Error(`${tier}: checksum mismatch: ${match[2]}`);
    files.push(match[2]);
  }
  if (manifest.entries.length !== files.length || manifest.entries.some(e => !e || !seen.has(e.path) || !lines.includes(`${e.sha256}  ${e.path}`))) throw new Error(`${tier}: manifest/checksum list mismatch`);
  return { tier, name, dir, files };
}

function objectConfig(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`config is not an object: ${path}`);
  return value as Record<string, unknown>;
}

function pollerOff(value: unknown): Record<string, unknown> {
  if (value === undefined) return { enabled: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('poller config is not an object');
  return { ...value, enabled: false };
}

export async function promote(options: Options, writeConfig: (path: string, contents: string) => void = writeFileSync): Promise<{ to: string; tiers: Record<string, string>; files: number; features: 'yes' | 'no'; pollers: 'off'; hq: string; seconds: number; dryRun: boolean }> {
  const started = Date.now();
  const to = resolve(options.to);
  const parent = realpathSync(dirname(to));
  const targetPath = join(parent, relative(dirname(to), to));
  if (isInside(realpathSync(options.standby), targetPath)) throw new Error('--to must be outside --standby');
  if (options.hqConfig && isInside(realpathSync(options.hqConfig), targetPath)) throw new Error('--to must be outside --hq-config');
  // Verify each tier before creating the target, so a bad big copy cannot leave a promoted core.
  const generations: Generation[] = [];
  for (const tier of options.tiers) generations.push(await readGeneration(options.standby, tier));
  try { lstatSync(to); throw new Error(`target already exists: ${to}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const files = generations.reduce((n, g) => n + g.files.length, 0);
  const tiers = Object.fromEntries(generations.map(g => [g.tier, g.name]));
  const configSource = [...generations].reverse().find(g => g.files.includes('config.json'));
  let config: Record<string, unknown> | undefined;
  let hq = '-';
  if (!options.dryRun && configSource) {
    config = objectConfig(checkedFile(configSource.dir, 'config.json'));
    config.telegram = pollerOff(config.telegram);
    config.discord = pollerOff(config.discord);
    if (options.hqConfig) {
      const hostConfig = objectConfig(join(options.hqConfig, 'config.json'));
      const block = hostConfig.hq;
      if (!block || typeof block !== 'object' || Array.isArray(block) || typeof (block as Record<string, unknown>).hostName !== 'string' || !(block as Record<string, unknown>).hostName) throw new Error('--hq-config has no hq.hostName');
      config.hq = block;
      hq = (block as { hostName: string }).hostName;
    }
  }
  const summary = { to, tiers, files, features: generations.some(g => g.files.includes('release/features.sqlite')) ? 'yes' as const : 'no' as const, pollers: 'off' as const, hq, seconds: 0, dryRun: options.dryRun };
  if (options.dryRun) return summary;
  mkdirSync(to, { mode: 0o700 });
  try {
    chmodSync(to, 0o700);
    for (const generation of generations) {
      for (const name of generation.files) {
        const source = checkedFile(generation.dir, name);
        const dest = contained(to, name);
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        copyFileSync(source, dest);
        const stats = statSync(source);
        chmodSync(dest, stats.mode);
        utimesSync(dest, stats.atime, stats.mtime);
      }
    }
    if (config && configSource) {
      copyFileSync(join(to, 'config.json'), join(to, 'config.json.pre-promote'));
      writeConfig(join(to, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    }
    summary.seconds = Math.round((Date.now() - started) / 1000);
    return summary;
  } catch (error) {
    rmSync(to, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  let options: Options | undefined;
  try {
    options = parsePromoteArgs(process.argv.slice(2));
    const result = await promote(options);
    if (!result.dryRun) debug.log('hq.standby', 'promoted', { tiers: result.tiers, files: result.files, reason: 'promoted' });
    console.log(options.json ? JSON.stringify(result) : result.dryRun
      ? `promotion plan ${result.to} ${Object.entries(result.tiers).map(([t, g]) => `${t}=${g}`).join(' ')} files=${result.files}`
      : `promoted ${result.to} core=${result.tiers.core ?? '-'} big=${result.tiers.big ?? '-'} files=${result.files} features=${result.features} pollers=off hq=${result.hq} ${result.seconds}s`);
  } catch (error) {
    const reason = String(error);
    debug.log('hq.standby', 'promote-refused', { tiers: options?.tiers ?? [], files: 0, reason });
    console.error(`promotion refused: ${reason}`);
    process.exitCode = 1;
  }
}
