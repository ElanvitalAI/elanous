#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { debug } from '../../src/debug/log.js';
import type { Manifest, Tier } from './standby-snapshot.js';

export interface TierVerification {
  tier: Tier;
  generation: string | null;
  ageMin: number | null;
  host: string | null;
  entries: number | null;
  checked: number;
  mismatches: number;
  missing: number;
  unreadable: boolean;
  reasons: string[];
}

export interface StandbyVerification {
  tiers: TierVerification[];
  marker?: number | 'missing' | 'unreadable';
  ok: boolean;
  reasons: string[];
}

export interface VerifyOptions { root: string; tiers: Tier[]; marker?: string; maxAgeMin?: number | Partial<Record<Tier, number>>; now?: Date }

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function safeFile(base: string, name: string): string | null {
  if (!name || isAbsolute(name)) return null;
  const path = resolve(base, name);
  const rel = relative(base, path);
  return !rel || rel === '..' || rel.startsWith(`..${sep}`) ? null : path;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyTier(root: string, tier: Tier, maxAgeMin: number | undefined, now: Date): Promise<TierVerification> {
  const result: TierVerification = { tier, generation: null, ageMin: null, host: null, entries: null, checked: 0, mismatches: 0, missing: 0, unreadable: false, reasons: [] };
  const base = join(root, tier);
  try {
    await stat(base);
  } catch {
    result.unreadable = true;
    result.reasons.push(`${tier}:unreadable`);
    return result;
  }
  let target: string;
  try {
    target = await readlink(join(base, 'latest'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EINVAL') result.reasons.push(`${tier}:latest missing`);
    else {
      result.unreadable = true;
      result.reasons.push(`${tier}:unreadable`);
    }
    return result;
  }
  const dir = safeFile(base, target);
  if (!dir || relative(base, dir) !== target) {
    result.reasons.push(`${tier}:invalid latest`);
    return result;
  }
  result.generation = target;
  let manifest: Manifest;
  let sums: string;
  try {
    [manifest, sums] = await Promise.all([
      readFile(join(dir, 'MANIFEST.json'), 'utf8').then(text => JSON.parse(text) as Manifest),
      readFile(join(dir, 'SHA256SUMS'), 'utf8'),
    ]);
  } catch (error) {
    if (error instanceof SyntaxError) result.reasons.push(`${tier}:invalid manifest`);
    else {
      result.unreadable = true;
      result.reasons.push(`${tier}:unreadable`);
    }
    return result;
  }
  if (manifest?.generation !== target || manifest.tier !== tier || !Array.isArray(manifest.entries)
    || typeof manifest.host !== 'string' || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) {
    result.reasons.push(`${tier}:invalid manifest`);
    return result;
  }
  result.host = manifest.host;
  result.entries = manifest.entries.length;
  const elapsedMs = now.getTime() - Date.parse(manifest.createdAt);
  result.ageMin = Math.floor(elapsedMs / 60_000);
  if (maxAgeMin !== undefined && elapsedMs > maxAgeMin * 60_000) result.reasons.push(`${tier}:age exceeded`);
  const expected = new Map<string, string>();
  for (const line of sums.split('\n').filter(Boolean)) {
    const match = /^([a-fA-F0-9]{64})  (.+)$/.exec(line);
    if (!match || !safeFile(dir, match[2]) || expected.has(match[2])) {
      result.reasons.push(`${tier}:invalid SHA256SUMS`);
      continue;
    }
    expected.set(match[2], match[1].toLowerCase());
  }
  if (expected.size !== manifest.entries.length || manifest.entries.some(e => !e || typeof e.path !== 'string' || typeof e.sha256 !== 'string' || expected.get(e.path) !== e.sha256.toLowerCase())) {
    result.reasons.push(`${tier}:manifest/checksum list mismatch`);
  }
  for (const [name, digest] of expected) {
    const path = safeFile(dir, name)!;
    try {
      if ((await hashFile(path)) !== digest) result.mismatches++;
      else result.checked++;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') result.missing++;
      else result.unreadable = true;
    }
  }
  if (result.mismatches) result.reasons.push(`${tier}:checksum mismatch ${result.mismatches}`);
  if (result.missing) result.reasons.push(`${tier}:missing files ${result.missing}`);
  if (result.unreadable) result.reasons.push(`${tier}:unreadable`);
  return result;
}

export async function verifyStandby(opts: VerifyOptions): Promise<StandbyVerification> {
  const tiers = await Promise.all(opts.tiers.map(tier => verifyTier(opts.root, tier,
    typeof opts.maxAgeMin === 'number' ? opts.maxAgeMin : opts.maxAgeMin?.[tier], opts.now ?? new Date())));
  const reasons = tiers.flatMap(tier => tier.reasons);
  let marker: StandbyVerification['marker'];
  if (opts.marker !== undefined) {
    const core = tiers.find(tier => tier.tier === 'core');
    if (!core || core.unreadable) marker = 'unreadable';
    else if (!core.generation) marker = 'missing';
    else {
      try {
        const lines = (await readFile(join(opts.root, 'core', core.generation, 'hq-drill', 'round-trip.jsonl'), 'utf8')).split('\n');
        marker = lines.filter(line => line.includes(opts.marker!)).length;
      } catch (error) {
        marker = errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable';
      }
    }
    if (marker !== 1) reasons.push(`marker:${marker === 0 ? 'not found' : typeof marker === 'number' ? `count ${marker}` : marker}`);
  }
  return { tiers, ...(opts.marker === undefined ? {} : { marker }), ok: reasons.length === 0, reasons };
}

export function formatVerification(result: StandbyVerification): string {
  const parts = result.tiers.map(t => `${t.tier}=${t.unreadable && !t.generation ? 'unreadable' : t.generation ?? 'missing'}(${t.ageMin === null ? '?' : t.ageMin}m · ${t.host ?? '?'} · ok ${t.checked}/${t.entries ?? '?'}${t.mismatches ? ` · mismatch ${t.mismatches}` : ''}${t.missing ? ` · missing ${t.missing}` : ''}${t.unreadable ? ' · unreadable' : ''})`);
  if (result.marker !== undefined) parts.push(`marker=${result.marker}`);
  return `hq-standby verify ${parts.join(' ')} ${result.ok ? 'OK' : `FAIL ${result.reasons.join(', ')}`}`;
}

export function parseVerifyArgs(argv: string[]): { options: VerifyOptions; json: boolean } {
  let root = join(homedir(), '.elanous-standby');
  let tiers: Tier[] = ['core', 'big', 'obs'];
  let marker: string | undefined;
  let maxAgeMin: VerifyOptions['maxAgeMin'];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') { json = true; continue; }
    if (!['--root', '--tier', '--marker', '--max-age-min'].includes(flag)) throw new Error(`unknown option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--root') root = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
    if (flag === '--tier') {
      const parsed = value.split(',');
      if (!parsed.length || parsed.some(t => !['core', 'big', 'obs'].includes(t)) || new Set(parsed).size !== parsed.length) throw new Error('--tier must be core,big,obs (no duplicates)');
      tiers = parsed as Tier[];
    }
    if (flag === '--marker') marker = value;
    if (flag === '--max-age-min') {
      if (!value.includes('=') && !value.includes(',')) {
        maxAgeMin = Number(value);
        if (!Number.isFinite(maxAgeMin) || maxAgeMin < 0) throw new Error('--max-age-min must be a non-negative number');
      } else {
        const limits: Partial<Record<Tier, number>> = {};
        for (const item of value.split(',')) {
          const match = /^(core|big|obs)=(.+)$/.exec(item);
          if (!match || Object.hasOwn(limits, match[1]) || !match[2].trim() || !Number.isFinite(Number(match[2])) || Number(match[2]) < 0)
            throw new Error('--max-age-min must be a non-negative number or tier=minutes comma list (no duplicates)');
          limits[match[1] as Tier] = Number(match[2]);
        }
        maxAgeMin = limits;
      }
    }
  }
  if (marker !== undefined && !tiers.includes('core')) tiers = [...tiers, 'core'];
  return { options: { root, tiers, ...(marker === undefined ? {} : { marker }), ...(maxAgeMin === undefined ? {} : { maxAgeMin }) }, json };
}

if (import.meta.main) {
  let parsed: ReturnType<typeof parseVerifyArgs> | undefined;
  try {
    parsed = parseVerifyArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`hq-standby verify: ${String(error)}`);
    process.exitCode = 2;
  }
  if (parsed) {
    try {
      const result = await verifyStandby(parsed.options);
      debug.log('hq.standby', 'verify', { tiers: result.tiers, ok: result.ok, reasons: result.reasons });
      if (!result.ok) debug.log('hq.standby', 'verify-failed', { reasons: result.reasons });
      console.log(parsed.json ? JSON.stringify(result) : formatVerification(result));
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      const reasons = [`unreadable:${String(error)}`];
      debug.log('hq.standby', 'verify', { tiers: parsed.options.tiers, ok: false, reasons });
      debug.log('hq.standby', 'verify-failed', { reasons });
      console.log(parsed.json ? JSON.stringify({ tiers: [], ok: false, reasons }) : `hq-standby verify FAIL ${reasons[0]}`);
      process.exitCode = 1;
    }
  }
}
