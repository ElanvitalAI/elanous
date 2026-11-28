// LOOP-AGENT v2 generic shell — the card (내부 문서 `LOOP-AGENT` §1 ① 목표 ⊕ ② 영혼).
//
// S: judge-butler and guardian each carry a bespoke goal/soul loader; the nine supervisors of SUPERVISOR-REVIVE-1127 need the
//    same shape (subject · event wake · one reversible action · KPI · heartbeat · L0) without nine more copies.
// C: a card must be readable by a person (yaml ⊕ soul.md) and strict enough that a missing L0 or KPI is a load error, not a
//    silent «돌기만».
// Q: what is the smallest card every v2 agent shares?
// A: `graphs/loop-agents/<id>/goal.yaml` with `runtime: v2` (machine card: soul fields · subject · goal · KPI · done-when ·
//    rights · wake · heartbeat · voice) ⊕ optional `soul.md` (free text put first in every voice turn). Bespoke agents
//    (judge-butler · guardian) keep their own loaders — a goal.yaml without `runtime: v2` is not listed here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { dirGlyph, kpiOk as kitKpiOk, type KpiDir } from '../kit/kpi/index.js';

export type { KpiDir };
export interface KpiSpec { readonly name: string; readonly target: number; readonly dir: KpiDir; readonly unit: string }

export interface AgentCard {
  readonly id: string;
  /** Mail seat id (alias `loop:<id>`). */
  readonly address: string;
  readonly name: string;
  readonly role: string;
  readonly temperament: string;
  readonly values: readonly string[];
  /** What it watches (the «환자»). */
  readonly subject: string;
  /** L0 supervisor seat — the KPI is this seat's responsibility. */
  readonly supervisor: string;
  readonly goal: string;
  readonly kpi: KpiSpec;
  readonly doneWhen: readonly string[];
  readonly rights: { readonly actions: readonly string[]; readonly neverAuto: readonly string[]; readonly maxPerTick: number; readonly cooldownMin: number };
  readonly wake: { readonly events: readonly string[]; readonly maxWaitMin: number };
  readonly heartbeatEveryMin: number;
  readonly voice: { readonly perHourMax: number; readonly role: string };
  /** KPI breach lasting this long → one card to L0. */
  readonly escalateAfterMin: number;
  /** soul.md (may be empty). */
  readonly soulText: string;
  /** Operator focus note set through a policy change (empty by default). */
  readonly focus: string;
  /** Level before any L0/HQ sets one (level.json absent): a new body with a destructive action starts in shadow. */
  readonly startLevel: 'live' | 'L1' | 'shadow';
  /** YAML-MIGRATION-WAVE1 ②: the body policies (agent.yaml `policies:` · the generated goal.yaml carries a copy for the
   *  refused-agent.yaml fallback) — the tick and the voice run under these when no compiled agent.yaml supplies them. */
  readonly policies?: Readonly<Record<string, number>>;
  /** SUPERVISORS-EXECUTE-NOT-PROPOSE: agent.yaml `authority:` (acts it runs itself · undo · limits · HOLD) — absent = none. */
  readonly authority?: import('./v3/agent-yaml.js').AgentAuthority;
}

export const CARD_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
/** Seats that may change any agent's level / policy besides its own L0. */
export const HQ_POLICY_SEATS: readonly string[] = ['OP', 'CLAUDE-OP', 'CEO'];

export const cardsRoot = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'loop-agents');

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v.trim() : d);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()) : []);

/** Parse one card. Throws on what would make the agent unaccountable: no id · no L0 · no KPI · no reversible action. */
export function parseCard(goalYaml: string, soulText = '', where = 'card'): AgentCard {
  let j: Record<string, unknown>;
  try { j = (parse(goalYaml) ?? {}) as Record<string, unknown>; } catch (e) { throw new Error(`${where}: bad yaml — ${e instanceof Error ? e.message : String(e)}`); }
  if (j.runtime !== 'v2') throw new Error(`${where}: not a v2 card (runtime: v2 missing)`);
  const id = str(j.id);
  if (!CARD_ID_RE.test(id)) throw new Error(`${where}: id must match ${CARD_ID_RE}`);
  const supervisor = str(j.supervisor).toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(supervisor)) throw new Error(`${where}: supervisor (L0 seat) is required`);
  const soul = (j.soul ?? {}) as Record<string, unknown>;
  const k = (j.kpi ?? {}) as Record<string, unknown>;
  const kpiName = str(k.name);
  const dir: KpiDir | null = typeof k.at_most === 'number' ? 'at_most' : typeof k.at_least === 'number' ? 'at_least' : null;
  if (!kpiName || !dir) throw new Error(`${where}: kpi needs name and at_most|at_least`);
  const rights = (j.rights ?? {}) as Record<string, unknown>;
  const actions = strs(rights.actions);
  if (!actions.length) throw new Error(`${where}: rights.actions needs at least one reversible action (SUPERVISOR-REVIVE «행동권 기본»)`);
  const wake = (j.wake ?? {}) as Record<string, unknown>;
  const voice = (j.voice ?? {}) as Record<string, unknown>;
  const address = (str(j.address) || id.toUpperCase()).toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(address)) throw new Error(`${where}: bad address ${address}`);
  return {
    id, address, supervisor,
    name: str(soul.name, id) || id, role: str(soul.role), temperament: str(soul.temperament), values: strs(soul.values),
    subject: str(j.subject), goal: str(j.goal),
    kpi: { name: kpiName, target: (dir === 'at_most' ? k.at_most : k.at_least) as number, dir, unit: str(k.unit) },
    doneWhen: strs(j.done_when),
    rights: { actions, neverAuto: strs(rights.never_auto), maxPerTick: Math.max(0, Math.floor(num(rights.max_per_tick, 3))), cooldownMin: Math.max(1, num(rights.cooldown_min, 30)) },
    wake: { events: strs(wake.events), maxWaitMin: Math.max(1, num(wake.max_wait_min, 10)) },
    heartbeatEveryMin: Math.max(1, num(j.heartbeat_every_min, num(wake.max_wait_min, 10))),
    voice: { perHourMax: Math.max(0, Math.floor(num(voice.per_hour_max, 6))), role: str(voice.role, 'coordinator') || 'coordinator' },
    escalateAfterMin: Math.max(5, num(j.escalate_after_min, 60)),
    soulText: soulText.trim(), focus: '',
    startLevel: j.start_level === 'shadow' || j.start_level === 'L1' ? j.start_level : 'live',
    ...((): { policies?: Record<string, number> } => {
      const p = j.policies && typeof j.policies === 'object' && !Array.isArray(j.policies) ? j.policies as Record<string, unknown> : null;
      if (!p) return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(p)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      return { policies: out };
    })(),
    ...((): { authority?: NonNullable<AgentCard['authority']> } => {
      const a = j.authority && typeof j.authority === 'object' && !Array.isArray(j.authority) ? j.authority as Record<string, unknown> : null;
      if (!a) return {};
      const undo = a.undo && typeof a.undo === 'object' && !Array.isArray(a.undo) ? Object.fromEntries(Object.entries(a.undo as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};
      return { authority: { executes: strs(a.executes), undo, limits: strs(a.limits), respectHold: a.respect_hold !== false } };
    })(),
  };
}

export function loadCard(id: string, root = cardsRoot()): AgentCard {
  if (!CARD_ID_RE.test(id)) throw new Error(`bad loop agent id ${JSON.stringify(id)}`);
  const dir = join(root, id);
  const goalPath = join(dir, 'goal.yaml');
  if (!existsSync(goalPath)) throw new Error(`no card ${goalPath}`);
  const soulPath = join(dir, 'soul.md');
  return parseCard(readFileSync(goalPath, 'utf8'), existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '', goalPath);
}

/** Every v2 card under graphs/loop-agents (bespoke agents without `runtime: v2` are skipped, broken v2 cards are reported). */
export function listCards(root = cardsRoot()): { cards: AgentCard[]; errors: string[] } {
  const cards: AgentCard[] = []; const errors: string[] = [];
  if (!existsSync(root)) return { cards, errors };
  for (const name of readdirSync(root).sort()) {
    const goalPath = join(root, name, 'goal.yaml');
    if (!existsSync(goalPath)) continue;
    const text = readFileSync(goalPath, 'utf8');
    if (!/^runtime:\s*v2\b/mu.test(text)) continue;
    try { cards.push(loadCard(name, root)); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  return { cards, errors };
}

/** Raw-value judgment — kit/kpi is the one implementation (PLATFORM-KITS §1-13). */
export const kpiOk = (kpi: KpiSpec, value: number | null): boolean | null => kitKpiOk(kpi, value);
export const kpiLine = (kpi: KpiSpec, value: number | null): string =>
  `${kpi.name} ${value ?? '?'}${kpi.unit ? ` ${kpi.unit}` : ''} (목표 ${dirGlyph(kpi.dir)} ${kpi.target}) ${kpiOk(kpi, value) === null ? '모름' : kpiOk(kpi, value) ? '충족' : '위반'}`;
/** Seats that may change level / policy / lessons of this agent: its L0 ⊕ HQ. */
export const policySeats = (card: AgentCard): Set<string> => new Set([card.supervisor, ...HQ_POLICY_SEATS]);

// ── policy overlay (bounded · audited in memory) ─────────────────────────────────────────────────────────────────────
/** The only knobs a conversation may turn. Rights can be narrowed (`rights.disable`), never widened. */
export const POLICY_KEYS = {
  'kpi.target': { min: 0, max: 100_000 },
  'wake.max_wait_min': { min: 1, max: 1440 },
  'rights.max_per_tick': { min: 0, max: 10 },
  'rights.cooldown_min': { min: 1, max: 1440 },
  'voice.per_hour_max': { min: 0, max: 60 },
  'escalate_after_min': { min: 5, max: 1440 },
} as const;
export type PolicyKey = keyof typeof POLICY_KEYS | 'rights.disable' | 'focus';
export interface Policy { readonly values: Partial<Record<keyof typeof POLICY_KEYS, number>>; readonly disabled: readonly string[]; readonly focus: string }
export const emptyPolicy = (): Policy => ({ values: {}, disabled: [], focus: '' });

/** Validate one change; returns the new policy or an error line. */
export function applyPolicyChange(card: AgentCard, policy: Policy, key: string, value: unknown): { ok: true; policy: Policy } | { ok: false; why: string } {
  if (key === 'focus') {
    const v = typeof value === 'string' ? value.trim().slice(0, 300) : '';
    return { ok: true, policy: { ...policy, focus: v } };
  }
  if (key === 'rights.disable' || key === 'rights.enable') {
    const names = (Array.isArray(value) ? value : [value]).map(String).map(s => s.trim()).filter(Boolean);
    const unknown = names.filter(n => !card.rights.actions.includes(n));
    if (unknown.length) return { ok: false, why: `없는 행동 ${unknown.join(',')} — 권한은 좁히기만 된다(카드의 rights.actions 안에서)` };
    const set = new Set(policy.disabled);
    for (const n of names) { if (key === 'rights.disable') set.add(n); else set.delete(n); }
    return { ok: true, policy: { ...policy, disabled: [...set].sort() } };
  }
  if (!Object.hasOwn(POLICY_KEYS, key)) return { ok: false, why: `바꿀 수 없는 정책 ${key} — 허용: ${[...Object.keys(POLICY_KEYS), 'rights.disable', 'rights.enable', 'focus'].join(' · ')}` };
  const n = typeof value === 'number' ? value : Number(value);
  const b = POLICY_KEYS[key as keyof typeof POLICY_KEYS];
  if (!Number.isFinite(n) || n < b.min || n > b.max) return { ok: false, why: `${key} 값 ${String(value)} 범위 밖 [${b.min}, ${b.max}]` };
  return { ok: true, policy: { ...policy, values: { ...policy.values, [key]: n } } };
}

/** The card the runtime acts on: the yaml card with the policy overlay applied. */
export function effectiveCard(card: AgentCard, policy: Policy): AgentCard {
  const v = policy.values;
  return {
    ...card,
    kpi: { ...card.kpi, target: v['kpi.target'] ?? card.kpi.target },
    rights: { ...card.rights, actions: card.rights.actions.filter(a => !policy.disabled.includes(a)), maxPerTick: v['rights.max_per_tick'] ?? card.rights.maxPerTick, cooldownMin: v['rights.cooldown_min'] ?? card.rights.cooldownMin },
    wake: { ...card.wake, maxWaitMin: v['wake.max_wait_min'] ?? card.wake.maxWaitMin },
    voice: { ...card.voice, perHourMax: v['voice.per_hour_max'] ?? card.voice.perHourMax },
    escalateAfterMin: v['escalate_after_min'] ?? card.escalateAfterMin,
    focus: policy.focus,
  };
}
