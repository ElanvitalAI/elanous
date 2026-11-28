// 수호자 — the ONE definition (GUARDIAN-V3-SMART · GUARDIAN-SUBS · 대표 11-27 «모든 것 YAML 정의 · 플러그인 설치» · remove-first).
//
// S: the guardian's numbers lived in five TS files (SCALE_RATIO · SCALE_HEADROOM · cadences · TTLs · alert windows · the
//    host load limit twice) and its seven subs were a TS table; the nine supervisors already run from agent.yaml (#40516).
// C: a policy change was a code change, the subs had no detectors (they «saw» and mailed, nothing said what normal is,
//    what the ladder is and when it is the owner's), and the guardian could not be copied to another install.
// Q: how does the guardian read everything from graphs/loop-agents/guardian/agent.yaml without a second copy in code and
//    without stopping when the file cannot be read?
// A: guardianDef() lints the package once per process (the shared lintAgentDir — the same refusal rules as every agent) →
//    policies (gp()) · the seven subs as SubAgentSpec (+ detectors) · the smart config. A clean load is remembered in the
//    agent's home (agent.lkg.json); a refused agent.yaml runs on that last-known-good copy and the pulse posts ONE deduped
//    card to the L0 (refusalReport). No last-known-good either → gp() throws with the reason (the trigger registry's
//    exception lane — run-doctor LOOP-EXCEPTION-WATCH — retries and cards the owner): never a silent default.
//
// 세 얼굴: 관측 = GuardianDef.source (agent.yaml | last-known-good) ⊕ errors · `eln loop agent lint guardian` /
//          판단 근거 = the agent.yaml (policies · subs · detectors) / 수복과 인계 = last-known-good ⊕ one L0 card (pulse.ts).
import type { RollupSpec } from '../kit/kpi/rollup.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AgentSoul, AgentSubDetector, CompiledAgent } from '../loop-agent/v3/agent-yaml.js';
import type { ResourceCheckSpec } from '../loop-agent/v3/resource-check.js';
import type { SubAgentId, SubAgentSpec, WorldEventKind } from './subagents.js';

/** graphs/loop-agents/guardian — the shipped package (repo or install tree) · a function: no path work at module load (the PWA
 *  bundle type-checks this module through the guardian imports). */
export const guardianPkgDir = (): string => resolve(import.meta.dir, '../../graphs/loop-agents/guardian');
export const guardianLkgPath = (stateRoot: string): string => join(stateRoot, 'loop-agents', 'guardian', 'agent.lkg.json');

/** A sub with its detectors (the ladder executor reads these). */
export interface GuardianSub extends SubAgentSpec { readonly detectors: readonly AgentSubDetector[]; readonly policies: readonly string[]; readonly kpiName: string | null; readonly kpiTarget: number | null; readonly kpiRollup: RollupSpec | null;
  /** CODE-BODY-TO-KIND: the shared sub kind (kpi-rollup · resource-check) and its params · the spawn line's lease */
  readonly kind: string | null; readonly resourceCheck: ResourceCheckSpec | null; readonly resource: 'hosts' | 'local' }
export interface GuardianDef {
  readonly source: 'agent.yaml' | 'last-known-good' | 'none';
  readonly errors: readonly string[];
  readonly policies: Readonly<Record<string, number>>;
  readonly subs: readonly GuardianSub[];
  readonly soul: AgentSoul | null;
  readonly goal: string;
  readonly kpis: CompiledAgent['kpis'];
  readonly doneWhen: readonly string[];
  readonly neverAuto: readonly string[];
  readonly voicePerHour: number;
  /** The compiled agent (smartConfig · actions) — null when not linted clean this process. */
  readonly compiled: CompiledAgent | null;
}

function subsOf(c: CompiledAgent): GuardianSub[] {
  return c.subs.filter(s => s.duty).map(s => ({
    id: s.id as SubAgentId, name: s.name ?? s.id, duty: s.duty ?? '', absorbs: s.absorbs ?? [], kpi: s.kpi?.text ?? '', rights: s.actions ?? [],
    everyMin: s.everyMin ?? null, events: (s.events ?? []) as WorldEventKind[], ttlMin: s.ttlMin ?? 5,
    detectors: s.detectors ?? [], policies: s.policies ?? [], kpiName: s.kpi?.name ?? null, kpiTarget: s.kpi?.target ?? null, kpiRollup: s.kpiRollup ?? null,
    kind: s.kind ?? null, resourceCheck: s.resourceCheck ?? null, resource: s.resource ?? 'local',
  }));
}
function defOf(c: CompiledAgent, source: GuardianDef['source'], errors: readonly string[]): GuardianDef {
  return { source, errors, policies: c.policies, subs: subsOf(c), soul: c.soul, goal: c.goal, kpis: c.kpis, doneWhen: c.doneWhen, neverAuto: c.neverAuto,
    voicePerHour: c.voice.perHourMax, compiled: source === 'agent.yaml' ? c : null };
}

let cache: { dir: string; def: GuardianDef } | null = null;

/** The guardian's definition (memoized per process and package dir). `stateRoot` = where the last-known-good copy lives (the
 *  pulse passes its own; read-only callers leave it out). */
export function guardianDef(opts: { dir?: string; stateRoot?: string; fresh?: boolean } = {}): GuardianDef {
  const dir = opts.dir ?? guardianPkgDir();
  if (!opts.fresh && cache?.dir === dir && (cache.def.source === 'agent.yaml' || !opts.stateRoot)) return cache.def;
  const { lintAgentDir } = require('../loop-agent/v3/agent-yaml.js') as typeof import('../loop-agent/v3/agent-yaml.js');
  const r = lintAgentDir(dir, { triggersDir: join(dir, '..', '..', 'triggers') });
  let def: GuardianDef;
  if (r.ok && r.compiled) {
    def = defOf(r.compiled, 'agent.yaml', []);
    if (opts.stateRoot) rememberGuardianDef(opts.stateRoot, r.compiled);
  } else {
    const errors = r.present ? r.errors : [`no agent.yaml in ${dir}`];
    const lkg = opts.stateRoot ? readLkg(opts.stateRoot) : null;
    def = lkg ? defOf(lkg, 'last-known-good', errors)
      : { source: 'none', errors, policies: {}, subs: [], soul: null, goal: '', kpis: [], doneWhen: [], neverAuto: [], voicePerHour: 0, compiled: null };
  }
  cache = { dir, def };
  return def;
}
/** Tests: forget the memoized definition. */
export function resetGuardianDef(): void { cache = null; }

/** One policy number (agent.yaml `policies:`). Missing = the definition is refused with no last-known-good → throw with why. */
export function gp(name: string): number {
  const def = cache?.def ?? guardianDef(); // the definition this process loaded (the pulse loads it first, with its state root)
  const v = def.policies[name];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new Error(`guardian policy ${name} unavailable (${def.source}${def.errors.length ? ` · ${def.errors.slice(0, 2).join(' · ')}` : ''}) — eln loop agent lint guardian`);
}

/** The sub table (agent.yaml `subs:` with a duty) — the body spawns these. */
export const guardianSubs = (): readonly GuardianSub[] => guardianDef().subs;

function rememberGuardianDef(stateRoot: string, c: CompiledAgent): void {
  try {
    const p = guardianLkgPath(stateRoot); mkdirSync(dirname(p), { recursive: true });
    const text = JSON.stringify(c);
    if (existsSync(p) && readFileSync(p, 'utf8') === text) return;
    writeFileSync(`${p}.${process.pid}.tmp`, text); renameSync(`${p}.${process.pid}.tmp`, p);
  } catch { /* fail-open: the next clean load writes it */ }
}
function readLkg(stateRoot: string): CompiledAgent | null {
  try { const c = JSON.parse(readFileSync(guardianLkgPath(stateRoot), 'utf8')) as CompiledAgent; return c && c.id === 'guardian' && c.policies ? c : null; } catch { return null; }
}
