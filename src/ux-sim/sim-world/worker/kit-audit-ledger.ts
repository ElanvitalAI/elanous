// SIM-WORLD worker · kit/audit-ledger (PLATFORM-KITS-DUPLICATION-MAP-1127 §1-15): the one append-only JSONL writer driven
// against real files in the scenario's universe. Each scenario sweeps five seeds derived from ctx.seed (row counts and
// row sizes); no Math.random. Green = the production writer behaves as the kit promises for every derived seed.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendAudit, appendAuditLine, appendAuditLineSafe, appendAuditSafe, readAuditTail } from '../../../kit/audit-ledger/index.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioContext } from '../types.js';

interface AuditDir { readonly root: string; next(name: string): string }
export const simWorldDevices: readonly SimWorldDeviceDef<AuditDir>[] = [{
  id: 'KIT-AUDIT-DIR', title: 'scratch ledger directory inside the scenario universe',
  create: (ctx) => {
    const root = join(ctx.universeRoot, 'kit-audit');
    mkdirSync(root, { recursive: true });
    let n = 0;
    return { root, next: (name) => join(root, `${++n}-${name}`) };
  },
}];

const SEEDS = 5;
/** mulberry32 — deterministic per derived seed. */
const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

const sweep = (id: string, title: string, check: (dir: AuditDir, r: () => number, seed: number) => string | null): SimWorldScenario => ({
  id, title, devices: ['KIT-AUDIT-DIR'],
  async run(ctx: SimWorldScenarioContext) {
    const dir = ctx.device<AuditDir>('KIT-AUDIT-DIR');
    const fails: string[] = [];
    for (let k = 0; k < SEEDS; k++) {
      const seed = (ctx.seed * 1009 + k * 7919) >>> 0;
      let diff: string | null;
      try { diff = check(dir, prng(seed), seed); } catch (error) { diff = `threw ${error instanceof Error ? error.message : String(error)}`; }
      ctx.recorder.event('kit-audit:seed', { id, seed, diff });
      if (diff !== null) fails.push(`seed ${seed}: ${diff}`);
    }
    return fails.length === 0 ? { ok: true } : { ok: false, reason: 'audit ledger contract broken', diff: fails.join(' | ') };
  },
});

export const simWorldScenarios: readonly SimWorldScenario[] = [
  sweep('KIT-AUDIT-APPEND', 'N appends land as N whole lines in order', (dir, r) => {
    const p = dir.next('append.jsonl');
    const n = int(r, 3, 40);
    for (let i = 0; i < n; i++) appendAuditLine(p, JSON.stringify({ i, pad: 'p'.repeat(int(r, 0, 200)) }));
    const lines = readFileSync(p, 'utf8').split('\n');
    if (lines.pop() !== '') return 'file does not end with a newline';
    if (lines.length !== n) return `expected ${n} lines got ${lines.length}`;
    const order = lines.map(l => (JSON.parse(l) as { i: number }).i);
    return order.every((v, i) => v === i) ? null : `order broken: ${order.slice(0, 8).join(',')}`;
  }),
  sweep('KIT-AUDIT-SCHEMA', 'every row carries the schema tag first and keeps its own clock', (dir, r) => {
    const p = dir.next('schema.jsonl');
    const n = int(r, 2, 20);
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) appendAudit(p, 'sim.row/1', { i });
      else appendAudit(p, 'sim.row/1', { ts: `2026-11-27T00:00:${String(i % 60).padStart(2, '0')}.000Z`, i });
    }
    const rows = readAuditTail(p, 0);
    if (rows.length !== n) return `expected ${n} rows got ${rows.length}`;
    for (const [i, row] of rows.entries()) {
      const keys = Object.keys(row);
      if (keys[0] !== 'schema' || row.schema !== 'sim.row/1') return `row ${i} schema missing or not first: ${keys.join(',')}`;
      if (i % 2 === 0 && (typeof row.at !== 'string' || 'ts' in row)) return `row ${i} lacks its stamped at`;
      if (i % 2 === 1 && ('at' in row || typeof row.ts !== 'string')) return `row ${i} got a second clock`;
    }
    return null;
  }),
  sweep('KIT-AUDIT-ROTATE', 'rotation happens exactly when the next write would pass maxBytes; keep caps generations', (dir, r) => {
    const p = dir.next('rotate.jsonl');
    const lineLen = int(r, 5, 40);                // bytes per line including the newline
    const perFile = int(r, 2, 6);
    const keep = int(r, 1, 3);
    const writes = perFile * (keep + 2) + int(r, 0, perFile - 1);
    const opts = { maxBytes: lineLen * perFile, keep };
    for (let i = 0; i < writes; i++) appendAuditLine(p, String(i % 10).repeat(lineLen - 1), opts);
    const live = Math.ceil(writes / perFile) - 1;  // completed rotations
    const tail = writes - live * perFile;
    if (statSync(p).size !== tail * lineLen) return `live file ${statSync(p).size} bytes, expected ${tail * lineLen}`;
    for (let g = 1; g <= keep; g++) {
      const want = g <= live;
      if (existsSync(`${p}.${g}`) !== want) return `generation .${g} exists=${!want}`;
      if (want && statSync(`${p}.${g}`).size !== perFile * lineLen) return `generation .${g} is ${statSync(`${p}.${g}`).size} bytes`;
    }
    return existsSync(`${p}.${keep + 1}`) ? `generation .${keep + 1} kept past keep=${keep}` : null;
  }),
  sweep('KIT-AUDIT-MALFORMED-TAIL', 'the tail reader returns only whole object rows', (dir, r) => {
    const p = dir.next('tail.jsonl');
    const good = int(r, 1, 15);
    const parts: string[] = [];
    let want = 0;
    for (let i = 0; i < good; i++) {
      parts.push(JSON.stringify({ n: i })); want++;
      const junk = int(r, 0, 3);
      if (junk === 1) parts.push('not json');
      else if (junk === 2) parts.push('[1,2,3]');
      else if (junk === 3) parts.push('');
    }
    writeFileSync(p, `${parts.join('\n')}\n{"n":${good}`);   // half-written last line
    const rows = readAuditTail<{ n: number }>(p, 0);
    if (rows.length !== want) return `expected ${want} rows got ${rows.length}`;
    return rows.every((row, i) => row.n === i) ? null : `rows out of order: ${rows.map(x => x.n).join(',')}`;
  }),
  sweep('KIT-AUDIT-FAIL-SOFT', 'safe writers return false on an unwritable dir; strict writers throw', (dir, r, seed) => {
    if (process.getuid?.() === 0) return null;     // root ignores modes — nothing to observe
    const locked = join(dir.root, `locked-${seed}`);
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);
    try {
      const p = join(locked, 'sub'.repeat(int(r, 1, 3)), 'x.jsonl');
      if (appendAuditSafe(p, 'sim/1', { a: 1 }) !== false) return 'appendAuditSafe did not return false';
      if (appendAuditLineSafe(p, '{"a":1}') !== false) return 'appendAuditLineSafe did not return false';
      let threw = false;
      try { appendAudit(p, 'sim/1', { a: 1 }); } catch { threw = true; }
      return threw ? null : 'appendAudit did not throw';
    } finally { chmodSync(locked, 0o700); }
  }),
];
