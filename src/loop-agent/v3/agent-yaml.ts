// LOOP-AGENT v3 YAML — one portable agent.yaml per loop agent (LOOP-AGENT-V3-YAML · 대표 11-27 11:2x «그래프러너 v2 처럼 yaml
// 로 정의 — 정책 로직 모두 포함» · 11:3x «yaml 정의가 가능하게 · 다른 사람에게 이전도 쉽다» · «마켓에서 유통 · 플러그인 형태»).
//
// S: a loop agent today is goal.yaml (half the card) ⊕ numbers in TS (thresholds · windows) ⊕ a trigger yaml elsewhere ⊕
//    bespoke loaders per agent — it cannot be copied to another install, and a policy change is a code change.
// C: the graph runner v2 already proved the shape (trigger predicates · nodes · edges · done-when as data); a loop agent must
//    become the same: one self-contained directory, no host / seat / path / account baked in, its requires checked loudly.
// Q: what is the smallest format that defines an agent fully and compiles to the runtime that exists, behaviour unchanged?
// A: `graphs/loop-agents/<id>/agent.yaml` (apiVersion elanous/loop-agent@3): manifest (plugin package: name · version ·
//    requires {executor · kits · node_kinds · facts} · provides {agent · kpis}) · identity (+ soul/knowhow refs inside the
//    dir) · supervisor by org DUTY · policies (the only numbers · literal or {fact, default}) · kpis ($policies refs) ·
//    wake (graph-runner `trigger` block, predicates parsed by the trigger registry's own parser) · body (graph-runner v2
//    nodes/edges; TS bodies are named node kinds) · voice · memory · subs · budget · levels · optional v3 hook nodes.
//    lintAgentDir() = parse + validate + requires-vs-install + portability; compile result feeds the agent's existing
//    runtime (land-steward: StewardCards.goal). A refused agent.yaml is reported to the agent's L0, never silently skipped.
//
// 세 얼굴: 관측 = lint result (errors · warnings · compiled) · `eln loop agent lint <id>` · 판단 근거 = node-kinds.ts (what
// this install runs) ⊕ org duties ⊕ trigger parser · 수복과 인계 = refusalReport() → L0 mail (deduped by error digest).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { parse } from 'yaml';
import { DUTY_ROLES, orgDuty, type OrgDeps } from '../../org/org-map.js';
import { parsePredicate, parseWhen, type Predicate } from '../../loops/trigger-conditions.js';
import { EXECUTOR, EXECUTOR_TAG, INSTALLED_KITS, nodeKind } from './node-kinds.js';
import type { SmartAction } from './smart.js';

export const AGENT_API_VERSION = 'elanous/loop-agent@3';
export const AGENT_FILE = 'agent.yaml';
const ID_RE = /^[a-z][a-z0-9-]{0,62}$/u;
const SEAT_RE = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const SEMVER_RE = /^\d+\.\d+\.\d+$/u;
const REF_RE = /^\$policies\.([a-z][a-z0-9_]*)$/u;

export type PolicyValue = number | { readonly fact: string; readonly default?: number };
export interface AgentKpi { readonly name: string; readonly dir: 'at_least' | 'at_most'; readonly target: number; readonly unit: string; readonly ref: string | null }
export interface AgentNode { readonly node_id: string; readonly kind: string; readonly optional: boolean; readonly max_visits?: number }
export interface AgentEdge { readonly from: string; readonly on: string; readonly map: Readonly<Record<string, string>> }
export interface AgentWake {
  /** Graph id the trigger registry runs (graphs/triggers/<id>.yaml = the tick shim `loop.from_agent` · or a legacy full trigger). */
  readonly registeredAs: string | null;
  /** `wake.trigger.condition` predicate — null when the wake is a cron. */
  readonly predicate: Predicate | null;
  /** `wake.trigger.cron` (5-field) — null when the wake is a condition. */
  readonly cron: string | null;
  readonly cooldownMin: number;
  readonly maxWaitMin: number | null;
  readonly onMaxWait: 'fire' | 'card';
  /** `wake.failure` (goal deadline · attempts · backoff) for the registry · absent = the registry defaults. */
  readonly failure: { readonly goalDeadlineMin: number | null; readonly maxAttempts: number | null; readonly backoffSec: readonly number[] } | null;
}
/** YAML-SUPERVISORS-RUNTIME: the v2 card fields that live only here — graphs/loop-agents/<id>/goal.yaml is GENERATED from them. */
export interface AgentCardBlock {
  readonly name: string; readonly role: string; readonly temperament: string; readonly values: readonly string[];
  readonly subject: string; readonly actions: readonly string[]; readonly wakeEvents: readonly string[]; readonly voiceRole: string;
  /** L0 seat when the org map cannot resolve supervisor.duty (the generated goal.yaml · a refused agent.yaml's fallback). */
  readonly fallbackSeat: string;
}
/** LOOP-AGENT-V3-SMART-2 «영혼»: the agent's soul as data (soul.md stays the long human card) — plan and voice load it. */
export interface AgentSoul {
  /** Why the agent exists (one sentence). */
  readonly purpose: string;
  readonly values: readonly string[];
  /** What it never does — the plan refuses an action whose id is named here (exact id). */
  readonly doNot: readonly string[];
  /** How it speaks (voice style). */
  readonly voice: string;
  /** Who it serves (seats · duties · roles). */
  readonly serves: readonly string[];
}
export interface CompiledAgent {
  readonly id: string; readonly address: string; readonly name: string; readonly version: string; readonly description: string;
  readonly rank: string;
  /** L0 by org duty (portable) or a literal seat (warned). */
  readonly supervisor: { readonly duty?: string; readonly seat?: string };
  readonly goal: string;
  /** Resolved numbers (facts read now, defaults when a fact is absent). */
  readonly policies: Readonly<Record<string, number>>;
  readonly kpis: readonly AgentKpi[];
  readonly doneWhen: readonly string[];
  readonly neverAuto: readonly string[];
  readonly wake: AgentWake;
  readonly body: { readonly entry: string; readonly terminal: readonly string[]; readonly nodes: readonly AgentNode[]; readonly edges: readonly AgentEdge[] };
  readonly voice: { readonly channel: string; readonly speakOn: readonly string[]; readonly breachLineEveryMin: number | null; readonly mail: string; readonly terminalOwner: boolean; readonly perHourMax: number };
  readonly subs: readonly { readonly id: string; readonly node: string; readonly knowhow: string | null }[];
  readonly budget: { readonly llmTurnsPerHour: number };
  readonly levels: { readonly start: string; readonly values: readonly string[] };
  /** v3 `actions:` — what the plan node may choose (LOOP-AGENT-V3-SMART) · empty when the agent declares none. */
  readonly actions: readonly SmartAction[];
  readonly soulText: string;
  /** `soul:` block (required — LOOP-AGENT-V3-SMART-2). */
  readonly soul: AgentSoul;
  readonly knowhowText: string;
  /** `card:` — present for the v2-shell supervisors (goal.yaml generated from this file) · null otherwise. */
  readonly card: AgentCardBlock | null;
}
export interface LintResult { readonly ok: boolean; readonly id: string | null; readonly errors: string[]; readonly warnings: string[]; readonly compiled: CompiledAgent | null }

export interface LintEnv {
  /** Named facts for `{fact: …}` policy values (resource facts / trigger facts). Absent → default (warning) or error. */
  readonly facts?: (name: string) => number | undefined;
  /** Where graphs/triggers/<registered_as>.yaml lives (wake drift check). Absent dir / file → warning only. */
  readonly triggersDir?: string;
  /** Override what the install provides (sim: «missing kit» case). */
  readonly installedKits?: readonly string[];
  readonly nodeKindOk?: (kind: string) => boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()) : []);

/** Portability: values that only make sense on one install (absolute paths · home · emails · tailnet / IP hosts). */
function nonPortable(s: string): string | null {
  if (/^(\/[\w.-]+\/|~\/|~$|[A-Za-z]:\\)/u.test(s)) return 'absolute or home path'; // «/h» (a unit) is not a path
  if (/[\w.+-]+@[A-Za-z][\w-]*\.[A-Za-z][\w.]*/u.test(s)) return 'email / account'; // «loop-agent@3.1» (executor) is not an email
  if (/\.ts\.net\b|\b\d{1,3}(\.\d{1,3}){3}\b|\blocalhost\b/u.test(s)) return 'host address';
  return null;
}
function walkStrings(v: unknown, at: string, out: Array<{ at: string; s: string }>): void {
  if (typeof v === 'string') out.push({ at, s: v });
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${at}[${i}]`, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) walkStrings(x, at ? `${at}.${k}` : k, out);
}

/** A ref inside the agent dir (soul.md · knowhow.md): relative, no `..`, must exist. */
function readRef(dir: string, ref: string, at: string, errors: string[]): string {
  if (!ref) return '';
  const n = normalize(ref);
  if (isAbsolute(ref) || n.startsWith('..')) { errors.push(`${at}: ref ${ref} must stay inside the agent dir (portable package)`); return ''; }
  const p = join(dir, n);
  if (!existsSync(p)) { errors.push(`${at}: ref ${ref} not found in the agent dir`); return ''; }
  return readFileSync(p, 'utf8');
}

/** Parse + validate one agent.yaml text. `dir` resolves soul/knowhow refs. Never throws. */
export function lintAgentYaml(text: string, dir: string, env: LintEnv = {}): LintResult {
  const errors: string[] = []; const warnings: string[] = [];
  let j: Record<string, unknown>;
  try { const v = parse(text) as unknown; j = isObj(v) ? v : {}; } catch (e) { return { ok: false, id: null, errors: [`bad yaml — ${e instanceof Error ? e.message : String(e)}`], warnings, compiled: null }; }
  if (j.apiVersion !== AGENT_API_VERSION) errors.push(`apiVersion must be ${AGENT_API_VERSION} (got ${String(j.apiVersion ?? '—')})`);

  // ── identity ──
  const ident = isObj(j.identity) ? j.identity : {};
  const id = str(ident.id);
  if (!ID_RE.test(id)) errors.push(`identity.id must match ${ID_RE}`);
  const address = (str(ident.address) || id.toUpperCase()).toUpperCase();
  if (!SEAT_RE.test(address)) errors.push(`identity.address ${address} is not a mail address`);

  // ── manifest (plugin package) ──
  const man = isObj(j.manifest) ? j.manifest : {};
  const name = str(man.name); const version = str(man.version);
  if (!name) errors.push('manifest.name is required');
  if (!SEMVER_RE.test(version)) errors.push(`manifest.version must be semver x.y.z (got ${version || '—'})`);
  const req = isObj(man.requires) ? man.requires : {};
  const exec = /^([a-z-]+)@(\d+)(?:\.(\d+))?$/u.exec(str(req.executor));
  if (!exec) errors.push(`manifest.requires.executor must be like ${EXECUTOR.name}@${EXECUTOR.major}`);
  else if (exec[1] !== EXECUTOR.name || Number(exec[2]) !== EXECUTOR.major || Number(exec[3] ?? 0) > EXECUTOR.minor)
    errors.push(`requires executor ${str(req.executor)} — this install runs ${EXECUTOR_TAG}`);
  const kits = env.installedKits ?? INSTALLED_KITS;
  for (const k of strs(req.kits)) if (!kits.includes(k)) errors.push(`requires kit ${k} — not installed here (installed: ${kits.join(', ') || 'none'})`);
  const reqKinds = new Set(strs(req.node_kinds));
  const reqFacts = new Set(strs(req.facts));
  const prov = isObj(man.provides) ? man.provides : {};
  if (str(prov.agent) !== id) errors.push(`manifest.provides.agent must equal identity.id (${id})`);
  if (name && name !== id) warnings.push(`manifest.name ${name} ≠ identity.id ${id}`);

  // ── supervisor (L0) by duty ──
  const sup = isObj(j.supervisor) ? j.supervisor : {};
  const supervisor: { duty?: string; seat?: string } = {};
  if (str(sup.duty)) {
    if (!Object.hasOwn(DUTY_ROLES, str(sup.duty))) errors.push(`supervisor.duty ${str(sup.duty)} is not an org duty`);
    supervisor.duty = str(sup.duty);
  } else if (SEAT_RE.test(str(sup.seat).toUpperCase())) {
    supervisor.seat = str(sup.seat).toUpperCase();
    warnings.push(`supervisor.seat ${supervisor.seat} is a seat id — use supervisor.duty to stay portable`);
  } else errors.push('supervisor.duty (org duty) is required — an agent without an L0 is unaccountable');

  // ── policies (the only numbers) ──
  const policies: Record<string, number> = {};
  const rawPol = isObj(j.policies) ? j.policies : {};
  for (const [k, v] of Object.entries(rawPol)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(k)) { errors.push(`policies.${k}: bad name`); continue; }
    if (typeof v === 'number' && Number.isFinite(v)) { policies[k] = v; continue; }
    if (isObj(v) && str(v.fact)) {
      const fact = str(v.fact);
      if (!reqFacts.has(fact)) errors.push(`policies.${k}: fact ${fact} is not declared in manifest.requires.facts`);
      const got = env.facts?.(fact);
      const dflt = typeof v.default === 'number' && Number.isFinite(v.default) ? v.default : undefined;
      if (typeof got === 'number' && Number.isFinite(got)) policies[k] = got;
      else if (dflt !== undefined) { policies[k] = dflt; warnings.push(`policies.${k}: fact ${fact} not available here — default ${dflt}`); }
      else errors.push(`policies.${k}: fact ${fact} not available and no default`);
      continue;
    }
    errors.push(`policies.${k}: must be a number or {fact, default}`);
  }
  const used = new Set<string>();
  const resolve = (v: unknown, at: string): { n: number; ref: string | null } | null => {
    if (typeof v === 'number' && Number.isFinite(v)) { warnings.push(`${at}: literal ${v} — put numbers under policies:`); return { n: v, ref: null }; }
    const m = REF_RE.exec(str(v));
    if (!m) { errors.push(`${at}: must be $policies.<name>`); return null; }
    used.add(m[1]!);
    if (!Object.hasOwn(policies, m[1]!)) { errors.push(`${at}: missing policy ref $policies.${m[1]}`); return null; }
    return { n: policies[m[1]!]!, ref: m[1]! };
  };

  // ── kpis ──
  const kpis: AgentKpi[] = [];
  (Array.isArray(j.kpis) ? j.kpis : []).forEach((raw, i) => {
    const k = isObj(raw) ? raw : {}; const at = `kpis[${i}]`;
    const kn = str(k.name);
    if (!/^[a-z][a-z0-9_]*$/u.test(kn)) { errors.push(`${at}.name is required`); return; }
    const dir = k.at_least !== undefined ? 'at_least' : k.at_most !== undefined ? 'at_most' : null;
    if (!dir) { errors.push(`${at}: needs at_least | at_most`); return; }
    const r = resolve(k[dir], `${at}.${dir}`);
    if (r) kpis.push({ name: kn, dir, target: r.n, unit: str(k.unit), ref: r.ref });
  });
  if (!kpis.length) errors.push('kpis: at least one KPI (the L0 is responsible for it)');
  for (const kn of strs(prov.kpis)) if (!kpis.some(k => k.name === kn)) errors.push(`manifest.provides.kpis names ${kn} but kpis: has no such KPI`);

  // ── wake (graph-runner trigger block · the registry's own predicate parser) ──
  let wake: AgentWake | null = null;
  const w = isObj(j.wake) ? j.wake : {};
  const trig = isObj(w.trigger) ? w.trigger : null;
  const cond = trig && isObj(trig.condition) ? trig.condition : null;
  const cron = trig && typeof trig.cron === 'string' ? trig.cron.trim() : null;
  const wf = isObj(w.failure) ? w.failure : null;
  const failure = wf ? { goalDeadlineMin: typeof wf.goal_deadline_min === 'number' ? wf.goal_deadline_min : null, maxAttempts: typeof wf.max_attempts === 'number' ? wf.max_attempts : null,
    backoffSec: Array.isArray(wf.backoff_sec) ? wf.backoff_sec.filter((n): n is number => typeof n === 'number' && n >= 0) : [] } : null;
  if (!cond === !cron) errors.push('wake.trigger needs exactly one of cron (5 fields) | condition (predicate | when · cooldown_min · max_wait_min)');
  else if (cron) {
    if (cron.split(/\s+/u).length !== 5) errors.push(`wake.trigger.cron must be a 5-field cron (got «${cron}»)`);
    else wake = { registeredAs: str(w.registered_as) || null, predicate: null, cron, cooldownMin: 0, maxWaitMin: null, onMaxWait: 'fire', failure };
  } else if (cond) {
    try {
      if ((cond.predicate === undefined) === (cond.when === undefined)) throw new Error('condition needs exactly one of predicate | when');
      const predicate = cond.when !== undefined ? parseWhen(cond.when, 'wake.trigger.condition.when') : parsePredicate(cond.predicate, 'wake.trigger.condition.predicate');
      wake = { registeredAs: str(w.registered_as) || null, predicate, cron: null, cooldownMin: typeof cond.cooldown_min === 'number' ? cond.cooldown_min : 0,
        maxWaitMin: typeof cond.max_wait_min === 'number' ? cond.max_wait_min : null, onMaxWait: cond.on_max_wait === 'card' ? 'card' : 'fire', failure };
    } catch (e) { errors.push(`wake: ${e instanceof Error ? e.message : String(e)}`); }
  }
  if (wake?.registeredAs) {
    const tf = env.triggersDir ? join(env.triggersDir, `${wake.registeredAs}.yaml`) : null;
    if (!tf || !existsSync(tf)) warnings.push(`wake.registered_as ${wake.registeredAs}: no trigger file here — the registry does not run this agent on this install yet`);
    else {
      try {
        const doc = parse(readFileSync(tf, 'utf8')) as { graph_id?: string; loop?: { from_agent?: string; trigger?: { condition?: Record<string, unknown>; cron?: string } } };
        if (doc.loop?.from_agent !== undefined) {
          // YAML-SUPERVISORS-RUNTIME: the shim runs this agent and has no trigger of its own — the wake above is the one definition
          if (doc.loop.from_agent !== id) errors.push(`${wake.registeredAs}.yaml: loop.from_agent ${String(doc.loop.from_agent)} ≠ ${id}`);
          if (doc.graph_id !== wake.registeredAs) errors.push(`${wake.registeredAs}.yaml: graph_id ${String(doc.graph_id)} ≠ wake.registered_as`);
          if (doc.loop.trigger !== undefined) errors.push(`two trigger definitions: ${wake.registeredAs}.yaml still has loop.trigger — the wake lives only in agent.yaml`);
        } else if (wake.predicate) {
          // a legacy full trigger file (not a shim): its condition must equal this wake
          const c = doc.loop?.trigger?.condition ?? {};
          const theirs = c.when !== undefined ? parseWhen(c.when) : parsePredicate(c.predicate);
          const same = JSON.stringify(theirs) === JSON.stringify(wake.predicate) && (c.cooldown_min ?? 0) === wake.cooldownMin && (c.max_wait_min ?? null) === wake.maxWaitMin;
          if (!same) errors.push(`wake drift: agent.yaml wake ≠ ${wake.registeredAs}.yaml trigger condition (one source of truth — fix one of them)`);
        } else if ((doc.loop?.trigger?.cron ?? '').trim() !== wake.cron) errors.push(`wake drift: agent.yaml wake cron ≠ ${wake.registeredAs}.yaml trigger cron`);
      } catch (e) { errors.push(`wake.registered_as ${wake.registeredAs}: trigger file unreadable — ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  // ── card (v2 card fields · goal.yaml is generated from them) ──
  let card: AgentCardBlock | null = null;
  if (isObj(j.card)) {
    const c = j.card;
    const actions = strs(c.actions);
    if (!actions.length) errors.push('card.actions needs at least one reversible action (the v2 card rights)');
    const fallbackSeat = str(c.fallback_seat).toUpperCase();
    if (!SEAT_RE.test(fallbackSeat)) errors.push('card.fallback_seat must be a seat id (the L0 when the org map cannot resolve supervisor.duty)');
    card = { name: str(c.name) || id, role: str(c.role), temperament: str(c.temperament), values: strs(c.values), subject: str(c.subject), actions,
      wakeEvents: strs(c.wake_events), voiceRole: str(c.voice_role) || 'coordinator', fallbackSeat };
  }

  // ── body (graph-runner v2 nodes · edges) ──
  const b = isObj(j.body) ? j.body : {};
  const nodes: AgentNode[] = []; const edges: AgentEdge[] = [];
  const kindOk = (k: string) => (env.nodeKindOk ? env.nodeKindOk(k) : nodeKind(k) !== null);
  const usedKinds = new Set<string>();
  (Array.isArray(b.nodes) ? b.nodes : []).forEach((raw, i) => {
    const n = isObj(raw) ? raw : {}; const at = `body.nodes[${i}]`;
    const nid = str(n.node_id); const kind = str(n.kind); const optional = n.optional === true;
    if (!nid) { errors.push(`${at}.node_id is required`); return; }
    if (nodes.some(x => x.node_id === nid)) errors.push(`${at}: duplicate node_id ${nid}`);
    if (!kindOk(kind)) errors.push(`${at}: unknown node kind ${kind || '—'} (this install: ${EXECUTOR_TAG})`);
    else if (nodeKind(kind)?.status === 'hook' && !optional) errors.push(`${at}: ${kind} is a v3 hook kind — mark it optional: true (${EXECUTOR_TAG} runs hooks as fail-open slots around the body)`);
    usedKinds.add(kind);
    nodes.push({ node_id: nid, kind, optional, ...(typeof n.max_visits === 'number' ? { max_visits: n.max_visits } : {}) });
  });
  const ids = new Set(nodes.map(n => n.node_id));
  const entry = str(b.entry_node); const terminal = strs(b.terminal_nodes);
  if (!ids.has(entry)) errors.push(`body.entry_node ${entry || '—'} is not a node`);
  if (!terminal.length) errors.push('body.terminal_nodes is required (done-when)');
  for (const t of terminal) if (!ids.has(t)) errors.push(`body.terminal_nodes: ${t} is not a node`);
  (Array.isArray(b.edges) ? b.edges : []).forEach((raw, i) => {
    const e = isObj(raw) ? raw : {}; const at = `body.edges[${i}]`;
    const from = str(e.from); const map: Record<string, string> = {};
    if (!ids.has(from)) errors.push(`${at}.from ${from || '—'} is not a node`);
    if (isObj(e.map)) for (const [k, v] of Object.entries(e.map)) { if (!ids.has(str(v))) errors.push(`${at}.map.${k} → ${String(v)} is not a node`); map[k] = str(v); }
    edges.push({ from, on: str(e.on) || 'outcome', map });
  });
  for (const n of nodes) if (!terminal.includes(n.node_id) && !n.optional && !edges.some(e => e.from === n.node_id)) errors.push(`body: node ${n.node_id} has no outgoing edge`);

  // ── subs (sub-loop agents run inside a body node) ──
  const subs = (Array.isArray(j.subs) ? j.subs : []).flatMap((raw, i) => {
    const s = isObj(raw) ? raw : {}; const sid = str(s.id); const node = str(s.node);
    if (!ID_RE.test(sid)) { errors.push(`subs[${i}].id is required`); return []; }
    if (node && !ids.has(node)) errors.push(`subs[${i}] ${sid}: node ${node} is not a body node`);
    const kh = str(s.knowhow);
    if (kh) readRef(dir, kh, `subs[${i}].knowhow`, errors);
    return [{ id: sid, node, knowhow: kh || null }];
  });

  // requires.node_kinds ⇔ kinds used (an undeclared kind is a package that lies about its requirements)
  for (const k of usedKinds) if (k && !reqKinds.has(k)) errors.push(`node kind ${k} is used but not declared in manifest.requires.node_kinds`);
  for (const k of reqKinds) if (!kindOk(k)) errors.push(`requires node kind ${k} — not available on this install (${EXECUTOR_TAG})`);
  for (const k of usedKinds) {
    const def = nodeKind(k);
    for (const kn of def?.needsKpis ?? []) if (!kpis.some(x => x.name === kn)) errors.push(`node kind ${k} needs KPI ${kn}`);
    for (const pn of def?.needsPolicies ?? []) if (!Object.hasOwn(policies, pn)) errors.push(`node kind ${k} needs policy ${pn}`);
  }

  // ── actions (v3 plan node · LOOP-AGENT-V3-SMART): id · channel · target · serves KPIs · cost = $policies ref · one default ──
  const CHANNELS = ['mail', 'channel', 'self', 'none'] as const; const TARGETS = ['receiver', 'l0', 'self', 'none'] as const;
  const actions: SmartAction[] = [];
  (Array.isArray(j.actions) ? j.actions : []).forEach((raw, i) => {
    const a = isObj(raw) ? raw : {}; const at = `actions[${i}]`;
    const aid = str(a.id);
    if (!ID_RE.test(aid)) { errors.push(`${at}.id is required (${ID_RE})`); return; }
    if (actions.some(x => x.id === aid)) errors.push(`${at}: duplicate action ${aid}`);
    const channel = str(a.channel) as SmartAction['channel']; const target = (str(a.target) || 'receiver') as SmartAction['target'];
    if (!(CHANNELS as readonly string[]).includes(channel)) errors.push(`${at}.channel must be ${CHANNELS.join('|')}`);
    if (!(TARGETS as readonly string[]).includes(target)) errors.push(`${at}.target must be ${TARGETS.join('|')}`);
    const serves = strs(a.serves);
    for (const k of serves) if (!kpis.some(x => x.name === k)) errors.push(`${at}.serves names KPI ${k} — not under kpis:`);
    const cost = a.cost === undefined ? null : resolve(a.cost, `${at}.cost`);
    if (a.cost === undefined) errors.push(`${at}.cost is required ($policies.<name>)`);
    const fallback = str(a.fallback);
    if (card && !card.actions.includes(aid)) errors.push(`${at}: ${aid} is not a card right (card.actions) — the shell cannot run it`);
    actions.push({ id: aid, channel, target, serves, cost: cost?.n ?? 0, isDefault: a.default === true, ...(fallback ? { fallback } : {}) });
  });
  // LOOP-AGENT-V3-SMART-2: `fallback:` = what the plan runs instead once a lesson / knowhow line says this action keeps failing
  for (const a of actions) if (a.fallback !== undefined) {
    if (a.fallback === a.id) errors.push(`actions ${a.id}: fallback must be another action`);
    else if (!actions.some(x => x.id === a.fallback)) errors.push(`actions ${a.id}: fallback ${a.fallback} is not a declared action`);
    else if (card && !card.actions.includes(a.fallback)) errors.push(`actions ${a.id}: fallback ${a.fallback} is not a card right (card.actions)`);
  }
  if (nodes.some(n => n.kind === 'plan')) {
    if (!actions.length) errors.push('plan node needs actions: (what the plan may choose)');
    else if (actions.filter(a => a.isDefault).length !== 1) errors.push('actions: exactly one action must be default: true (the plan\'s prior)');
  } else if (actions.length) warnings.push('actions: declared but no plan node — the default action always runs');

  // ── voice · memory · budget · levels ──
  const v = isObj(j.voice) ? j.voice : {};
  const ble = v.breach_line_every_min === undefined ? null : resolve(v.breach_line_every_min, 'voice.breach_line_every_min');
  const voice = { channel: str(v.channel) || `loop:${id}`, speakOn: strs(v.speak_on), breachLineEveryMin: ble?.n ?? null, mail: str(v.mail) || 'l0-only',
    terminalOwner: v.terminal_owner === true, perHourMax: typeof v.per_hour_max === 'number' ? v.per_hour_max : 0 };
  const mem = isObj(j.memory) ? j.memory : {};
  if (!str(ident.soul)) errors.push('identity.soul (soul.md in the agent dir) is required — an agent without a soul card is a script');
  const soulText = readRef(dir, str(ident.soul), 'identity.soul', errors);
  // ── soul block (LOOP-AGENT-V3-SMART-2 «영혼» · required): purpose · values · do_not · voice · serves ──
  const sb = isObj(j.soul) ? j.soul : null;
  const soul: AgentSoul = { purpose: str(sb?.purpose), values: strs(sb?.values), doNot: strs(sb?.do_not), voice: str(sb?.voice), serves: strs(sb?.serves) };
  if (!sb) errors.push('soul: block is required (purpose · values · do_not · voice · serves) — plan and voice load it');
  else {
    if (!soul.purpose) errors.push('soul.purpose is required (why this agent exists)');
    if (!soul.values.length) errors.push('soul.values needs at least one value');
    if (!soul.doNot.length) errors.push('soul.do_not needs at least one thing it never does');
    if (!soul.voice) errors.push('soul.voice is required (how it speaks)');
    if (!soul.serves.length) errors.push('soul.serves needs at least one seat / duty it serves');
  }
  const knowhowText = readRef(dir, str(mem.knowhow), 'memory.knowhow', errors);
  const bud = isObj(j.budget) ? j.budget : {};
  const lv = isObj(j.levels) ? j.levels : {};
  const levelValues = strs(lv.values).length ? strs(lv.values) : ['live', 'shadow', 'off'];
  const start = str(lv.start) || levelValues[0]!;
  if (!levelValues.includes(start)) errors.push(`levels.start ${start} is not one of ${levelValues.join('|')}`);
  for (const p of Object.keys(policies)) if (!used.has(p) && !nodes.some(n => nodeKind(n.kind)?.needsPolicies?.includes(p))) warnings.push(`policies.${p} is never referenced`);

  // ── portability: nothing install-specific anywhere in the package ──
  const all: Array<{ at: string; s: string }> = []; walkStrings(j, '', all);
  for (const { at, s } of all) { const why = nonPortable(s); if (why) errors.push(`${at}: «${s.slice(0, 60)}» is not portable (${why}) — use an org duty / fact / {stateRoot}-style template`); }

  const ok = errors.length === 0;
  const compiled: CompiledAgent | null = ok && wake ? {
    id, address, name: name || id, version, description: str(man.description), rank: str(ident.rank), supervisor, goal: str(j.goal),
    policies, kpis, doneWhen: strs(j.done_when), neverAuto: strs(j.never_auto), wake,
    body: { entry, terminal, nodes, edges }, voice, subs, budget: { llmTurnsPerHour: typeof bud.llm_turns_per_hour === 'number' ? bud.llm_turns_per_hour : 0 },
    levels: { start, values: levelValues }, actions, soulText, soul, knowhowText, card,
  } : null;
  return { ok: ok && !!compiled, id: id || null, errors, warnings, compiled };
}

/** Lint `<dir>/agent.yaml`. A missing file is not an error here (the agent has no YAML definition yet) — `ok: false, errors: []`. */
export function lintAgentDir(dir: string, env: LintEnv = {}): LintResult & { present: boolean } {
  const p = join(dir, AGENT_FILE);
  if (!existsSync(p)) return { ok: false, id: null, errors: [], warnings: [], compiled: null, present: false };
  let text: string;
  try { text = readFileSync(p, 'utf8'); } catch (e) { return { ok: false, id: null, errors: [`unreadable ${AGENT_FILE} — ${e instanceof Error ? e.message : String(e)}`], warnings: [], compiled: null, present: true }; }
  return { ...lintAgentYaml(text, dir, env), present: true };
}

export const kpiOf = (c: CompiledAgent, name: string): AgentKpi | null => c.kpis.find(k => k.name === name) ?? null;

/** Seat that holds the agent's L0 now (duty through the org map · fallback when the YAML is too broken to say). */
export function supervisorSeat(sup: CompiledAgent['supervisor'] | null, fallback: string, org: OrgDeps = {}): string {
  if (sup?.seat) return sup.seat;
  if (sup?.duty) { try { return orgDuty(sup.duty, org); } catch { return fallback; } }
  return fallback;
}

/** The L0 card for a refused agent.yaml: one per distinct error set (key = digest), so a storm of ticks mails once. */
export function refusalReport(id: string, errors: readonly string[], to: string): { key: string; to: string; body: string } {
  const digest = createHash('sha256').update(errors.join('\n')).digest('hex').slice(0, 12);
  return {
    key: `agent-yaml-refused:${id}:${digest}`, to,
    body: `[${id} → L0 ${to}] agent.yaml 거부 — 이 정의로는 돌지 않는다(정의 전 기본 몸으로만 돈다) · 오류 ${errors.length}: ${errors.slice(0, 4).join(' · ').slice(0, 600)} · 확인: eln loop agent lint ${id}`,
  };
}
