/**
 * RESOURCE-FACTS ratchet — no NEW hardcoded resource facts in src/, graphs/, packs/ or agent.yaml (CEO 11-27 10:4x «수호자가 원장으로 관리해야 할 것들을
 * 고정값으로 쓰는 게 큰 문제»). Facts are read from `src/kit/resource-facts` (world registry ⊕ policy file ⊕ defaults).
 *
 * Six kinds, counted per file on non-comment lines of text files (including tests and scenario data):
 *   host     — host names (node-b · minim5 · node-c · mbp · mshq · gcpN · awsN)
 *   account  — codex account names (team · third) as literals
 *   model    — model ids (gpt-N · grok-N · claude-opus/sonnet/haiku-… · glm-N) outside the tier map
 *   expiry   — ISO date literals on a line that reads as an expiry (expir · until · deadline · sunset · END)
 *   seat     — hand-seat identifiers
 *   path     — hardcoded headquarters and reference roots
 *
 * Same shape as the HQ-path ratchet (test/no-hardcoded-hq-paths-ratchet.test.ts): today's counts are frozen per file in
 * `resource-facts-literals.baseline.json`; a file may only go down. After migrating call sites, shrink the baseline:
 *   bun run scripts/ratchets/resource-facts-literals.ts            # check (exit 1 on growth)
 *   bun run scripts/ratchets/resource-facts-literals.ts --update   # re-snapshot (only ever lowers counts unless --grow)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const ROOT = join(import.meta.dir, '..', '..');
export const BASELINE_PATH = join(import.meta.dir, 'resource-facts-literals.baseline.json');

export const KINDS = ['host', 'account', 'model', 'expiry', 'seat', 'path'] as const;
export type Kind = typeof KINDS[number];
export type Counts = Record<Kind, Record<string, number>>;

/** Where a fact's value legitimately lives (the defaults of the accessor kit · the model tier SSOT). */
export const REGISTRY_FILES: Readonly<Record<Kind, ReadonlySet<string>>> = {
  host: new Set(['src/kit/resource-facts/defaults.ts']),
  account: new Set(['src/kit/resource-facts/defaults.ts']),
  model: new Set(['src/kit/resource-facts/defaults.ts', 'src/model-tier/llm-tier-map.ts']),
  expiry: new Set(['src/kit/resource-facts/defaults.ts']),
  seat: new Set(['src/kit/resource-facts/defaults.ts']),
  path: new Set(['src/kit/resource-facts/defaults.ts']),
};

const HOST = /\b(?:node-b|minim5|node-c|mbp|mshq|gcp\d|aws\d)\b/;
const ACCOUNT_LIT = /(['"`])(?:team|third)\1/;
const ACCOUNT_CTX = /codex|account/i;
const ACCOUNT_YAML = /^\s*(?:codex[_-]?)?account\s*:\s*(?:team|third)\s*(?:#.*)?$/i;
const ACCOUNT_JOINED = /\bcodex[-:/_](?:team|third)\b/;
const MODEL = /\b(?:gpt-\d+(?:\.\d+)?(?:-[a-z]+)?|grok-\d+(?:\.\d+)?(?:-[a-z-]+)?|claude-(?:opus|sonnet|haiku)-[\w.-]+|glm-\d+(?:\.\d+)?)\b/;
const DATE = /(['"`])20\d\d-[01]\d-[0-3]\d/;
const EXPIRY_CTX = /expir|until|deadline|sunset|\bEND\b|validTo|notAfter/i;
const SEAT = /\b(?:TC|OP|MK|UX|JUD|RES|REL)-H-(?:CX|CC|POOL)-\d+\b/;
const HQ_PATH = /\/elanous-hq\/|\/source\/ref\b|'elanous-hq'|'source',\s*'ref'/;

export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#');
}

/** Pure: which fact kinds a source line hardcodes. */
export function kindsInLine(line: string): Kind[] {
  if (isCommentLine(line)) return [];
  const code = line.replace(/\s\/\/\s.*$/u, ''); // trailing comment
  const out: Kind[] = [];
  if (HOST.test(code)) out.push('host');
  if (ACCOUNT_JOINED.test(code) || ACCOUNT_YAML.test(code) || (ACCOUNT_LIT.test(code) && ACCOUNT_CTX.test(code))) out.push('account');
  if (MODEL.test(code)) out.push('model');
  if (DATE.test(code) && EXPIRY_CTX.test(code)) out.push('expiry');
  if (SEAT.test(code)) out.push('seat');
  if (HQ_PATH.test(code)) out.push('path');
  return out;
}

export function emptyCounts(): Counts { return { host: {}, account: {}, model: {}, expiry: {}, seat: {}, path: {} }; }

/** Pure: per-kind counts for one file's source. */
export function countSource(rel: string, source: string, into: Counts = emptyCounts()): Counts {
  for (const line of source.split('\n')) {
    for (const k of kindsInLine(line)) {
      if (REGISTRY_FILES[k].has(rel)) continue;
      into[k][rel] = (into[k][rel] ?? 0) + 1;
    }
  }
  return into;
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) walk(p, out); }
    else if (e.isFile()) out.push(p);
  }
}

/** Simulated worlds spell host / model names as scenario data (a synthetic world), not as facts a caller routes by. */
export const SIM_WORLD_DIRS = ['src/ux-sim/sim-world/', 'src/ux-sim/worlds/'] as const;

export function scanRepo(root = ROOT): Counts {
  const files: string[] = [];
  walk(join(root, 'src'), files);
  walk(join(root, 'graphs'), files);
  walk(join(root, 'packs'), files);
  if (existsSync(join(root, 'agent.yaml'))) files.push(join(root, 'agent.yaml'));
  const c = emptyCounts();
  for (const f of files) {
    const rel = relative(root, f);
    const bytes = readFileSync(f);
    // Binary assets cannot express textual source configuration.
    if (bytes.includes(0)) continue;
    countSource(rel, bytes.toString('utf8'), c);
  }
  return c;
}

export function readBaseline(path = BASELINE_PATH): Counts {
  if (!existsSync(path)) return emptyCounts();
  const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<Counts>;
  return { ...emptyCounts(), ...j };
}

/** Pure: lines «file kind n > allowed» for every growth over the baseline. */
export function growth(now: Counts, base: Counts): string[] {
  const over: string[] = [];
  for (const k of KINDS) for (const [file, n] of Object.entries(now[k])) {
    const allowed = base[k][file] ?? 0;
    if (n > allowed) over.push(`${file}: ${k} ${n} > ${allowed}`);
  }
  return over.sort();
}

/** Pure: the shrunk baseline (min of current and baseline; files that reached 0 drop out). */
export function shrink(now: Counts, base: Counts, grow = false): Counts {
  const out = emptyCounts();
  for (const k of KINDS) {
    const files = new Set([...Object.keys(now[k]), ...(grow ? [] : Object.keys(base[k]))]);
    for (const f of [...files].sort()) {
      const n = now[k][f] ?? 0;
      // Without --grow nothing new is admitted: a file absent from the baseline has allowance 0.
      const v = grow ? n : Math.min(n, base[k][f] ?? 0);
      if (v > 0) out[k][f] = v;
    }
  }
  return out;
}

if (import.meta.main) {
  const now = scanRepo();
  const base = readBaseline();
  if (process.argv.includes('--update')) {
    const next = shrink(now, base, process.argv.includes('--grow'));
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`resource-facts baseline: ${KINDS.map(k => `${k} ${Object.values(next[k]).reduce((a, b) => a + b, 0)}`).join(' · ')}`);
  } else {
    const over = growth(now, base);
    if (over.length) { console.error(`resource-facts ratchet: ${over.length} new hardcoded fact(s) — read them from src/kit/resource-facts\n${over.join('\n')}`); process.exit(1); }
    console.log('resource-facts ratchet: no new hardcoded facts');
  }
}
