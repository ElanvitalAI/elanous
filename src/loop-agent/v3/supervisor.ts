// LOOP-AGENT v3 — run a v2-shell supervisor from its agent.yaml (YAML-SUPERVISORS-DEF · 대표 11-27 12:0x).
// The agent.yaml is the definition: its policies override every number of the v2 card and are in force for the tick
// (`pv()` in the body), its body graph is the order of the tick steps, its supervisor is an org duty. No agent.yaml → the
// v2 card as before. A refused agent.yaml → the v2 card AND one deduped L0 card with the lint errors (never silent).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { goalYamlParity } from './card-gen.js';
import type { AgentCard } from '../card.js';
import { cardsRoot } from '../card.js';
import { tickAgent, type AgentBody, type AgentPorts, type ShellSmart, type TickGraph, type TickReport, type TickStep } from '../runtime.js';
import { lintAgentDir, refusalReport, supervisorSeat, type AgentSoul, type CompiledAgent, type LintResult } from './agent-yaml.js';
import { smartConfig } from './smart.js';
import { nodeKind } from './node-kinds.js';

/** `opts.parity` (lint CLI · rail · OP world card): also refuse a goal.yaml that is not what agent.yaml generates. The tick
 *  path leaves it off — agent.yaml is the truth; a stale fallback card must not stop the agent (it is a lint failure). */
export function lintSupervisor(id: string, root = cardsRoot(), opts: { parity?: boolean } = {}): LintResult & { present: boolean } {
  const r = lintAgentDir(join(root, id), { triggersDir: join(root, '..', 'triggers') });
  if (!opts.parity || !r.ok || !r.compiled?.card) return r;
  // YAML-SUPERVISORS-RUNTIME: goal.yaml is generated from agent.yaml — a hand edit (drift) is a second definition
  const gp = join(root, id, 'goal.yaml');
  const parity = goalYamlParity(r.compiled, existsSync(gp) ? readFileSync(gp, 'utf8') : null);
  return parity.length ? { ...r, ok: false, errors: [...r.errors, ...parity], compiled: null } : r;
}

/** agent.yaml body → the tick graph (node kinds with a v2-shell step · `gate` = terminal/join). */
export function graphOf(c: CompiledAgent): TickGraph {
  return {
    entry: c.body.entry, terminal: c.body.terminal,
    nodes: c.body.nodes.map(n => ({ node_id: n.node_id, step: (nodeKind(n.kind)?.step ?? 'gate') as TickStep | 'gate', ...(n.max_visits !== undefined ? { max_visits: n.max_visits } : {}) })),
    edges: c.body.edges.map(e => ({ from: e.from, map: e.map })),
  };
}

const num = (p: Readonly<Record<string, number>>, k: string, d: number): number => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k]! : d);

/** The v2 card with the agent.yaml numbers and L0 (duty → seat now). */
export function cardFromCompiled(card: AgentCard, c: CompiledAgent, orgPath?: string): AgentCard {
  const p = c.policies;
  const kpi = c.kpis.find(k => k.name === card.kpi.name) ?? c.kpis[0];
  return {
    ...card,
    supervisor: supervisorSeat(c.supervisor, card.supervisor, orgPath ? { path: orgPath } : {}),
    goal: c.goal || card.goal,
    kpi: kpi ? { name: kpi.name, target: kpi.target, dir: kpi.dir, unit: kpi.unit || card.kpi.unit } : card.kpi,
    rights: { ...card.rights, maxPerTick: num(p, 'max_per_tick', card.rights.maxPerTick), cooldownMin: num(p, 'cooldown_min', card.rights.cooldownMin) },
    escalateAfterMin: num(p, 'escalate_after_min', card.escalateAfterMin),
    heartbeatEveryMin: num(p, 'heartbeat_every_min', card.heartbeatEveryMin),
    voice: { ...card.voice, perHourMax: c.voice.perHourMax },
    startLevel: c.levels.start === 'shadow' || c.levels.start === 'L1' ? c.levels.start : 'live',
  };
}

export interface SupervisorDef {
  readonly card: AgentCard; readonly graph?: TickGraph; readonly policies?: Readonly<Record<string, number>>; readonly refused?: { key: string; to: string; body: string };
  /** LOOP-AGENT-V3-SMART-2: the hook nodes the shell runs (null = the agent.yaml declares none) · the soul block voice loads. */
  readonly smart?: ShellSmart | null; readonly soul?: AgentSoul;
}

/** What `eln loop agent <id> tick|voice` runs: the agent.yaml when present and clean, else the v2 card (+ a refusal card). */
export function supervisorDef(card: AgentCard, root = cardsRoot(), orgPath?: string): SupervisorDef {
  const r = lintSupervisor(card.id, root);
  if (!r.present) return { card };
  if (!r.ok || !r.compiled) return { card, refused: refusalReport(card.id, r.errors, card.supervisor) };
  const cfg = smartConfig(r.compiled);
  return { card: cardFromCompiled(card, r.compiled, orgPath), graph: graphOf(r.compiled), policies: r.compiled.policies, smart: cfg ? { cfg } : null, soul: r.compiled.soul };
}

/** The tick entry the trigger runs (`eln loop agent <id> tick`): resolve the definition → a refused agent.yaml posts its one
 *  deduped L0 card through the runtime's post port → tick (v3 graph ⊕ policies when clean, else the v2 card). The CLI and
 *  the sims call this one function, so «one L0 card on refusal» is proven on the real path (Terra #40447 r2). */
export async function supervisorTick(card: AgentCard, body: AgentBody, ports: AgentPorts, now: Date, root = cardsRoot(), orgPath?: string): Promise<{ def: SupervisorDef; report: TickReport }> {
  const def = supervisorDef(card, root, orgPath);
  if (def.refused) ports.post(def.refused.key, def.refused.to, def.refused.body, 'request');
  const report = await tickAgent(def.card, body, ports, now, { ...(def.graph ? { graph: def.graph } : {}), ...(def.policies ? { policies: def.policies } : {}), ...(def.smart ? { smart: def.smart } : {}) });
  return { def, report };
}
