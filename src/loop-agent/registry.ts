// LOOP-AGENT v2 generic shell — body registry: card id → lazily loaded L1 body. A card without a registered body is listed
// («몸 없음») and refuses tick/voice — the card alone never acts.
import type { AgentCard } from './card.js';
import type { AgentBody } from './runtime.js';

export interface BodyEnv { readonly stateRoot: string; readonly card: AgentCard }
export type BodyFactory = (env: BodyEnv) => AgentBody | Promise<AgentBody>;

const BODIES = new Map<string, () => Promise<BodyFactory>>();
/** LOOP-AGENTS-AS-PLUGINS (대표 11-28 08:4x «신규 감독 = 플러그인»): a shared executor kind that IS a whole body — any agent.yaml
 *  whose body entry node is that kind runs it (no per-agent TS · no id here). src/loop-agent/v3/node-kinds.ts declares the kind. */
const KIND_BODIES = new Map<string, () => Promise<BodyFactory>>();

/** Register a body loader (lazy: the import runs only when this agent wakes). */
export function registerBody(id: string, load: () => Promise<BodyFactory>): void { BODIES.set(id, load); }
/** Register the body of a shared executor kind (lazy). */
export function registerKindBody(kind: string, load: () => Promise<BodyFactory>): void { KIND_BODIES.set(kind, load); }

/** The kind of the body entry node of graphs/loop-agents/<id>/agent.yaml when that kind carries a whole body (null otherwise · unreadable). */
export function kindBodyOf(id: string): string | null {
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const { cardsRoot } = require('./card.js') as typeof import('./card.js');
    const doc = (require('yaml') as typeof import('yaml')).parse(readFileSync(join(cardsRoot(), id, 'agent.yaml'), 'utf8')) as { body?: { entry_node?: string; nodes?: Array<{ node_id?: string; kind?: string }> } } | null;
    const entry = doc?.body?.nodes?.find(n => n.node_id === doc.body?.entry_node)?.kind;
    return typeof entry === 'string' && KIND_BODIES.has(entry) ? entry : null;
  } catch { return null; }
}
export const hasBody = (id: string): boolean => BODIES.has(id) || kindBodyOf(id) !== null;
export const bodyIds = (): string[] => [...BODIES.keys()].sort();

export async function loadBodyFactory(id: string): Promise<BodyFactory> {
  const kind = BODIES.has(id) ? null : kindBodyOf(id);
  const load = BODIES.get(id) ?? (kind ? KIND_BODIES.get(kind) : undefined);
  if (!load) throw new Error(`loop agent ${id}: card exists but no body is registered (src/loop-agent/registry.ts)`);
  return load();
}

export async function loadBody(id: string, env: BodyEnv): Promise<AgentBody> {
  return (await loadBodyFactory(id))(env);
}

/** Bespoke v2 agents with their own doors (they share the memory home and the knowhow/lesson/memory subcommands). */
export const BESPOKE_AGENTS: Readonly<Record<string, string>> = { 'judge-butler': 'eln loop butler status|tick|voice', 'land-steward': 'eln land steward status|tick|voice' };

/** ELS-LOOP-AGENT-CHAT: loop agents whose voice is their own door (argv after the eln program). `eln loop agent <id> voice`
 *  handles the chat intents (기억해 · 정책 · 팩 · 승인 · 왜 실패) itself and hands every other line to this door. */
export const VOICE_DOORS: Readonly<Record<string, readonly string[]>> = {
  'judge-butler': ['loop', 'butler', 'voice'],
  guardian: ['loop', 'guardian', 'voice'],
};

// SUPERVISOR-REVIVE-1127 — the supervisors' bodies (src/loop-agent/bodies/<id>.ts · each exports createBody(env)).
export const SUPERVISOR_BODIES = ['run-supervisor', 'run-doctor', 'autopsy', 'macrophage', 'watchers-check', 'silence-watch', 'train-manager', 'release-rocket', 'hand-steward', 'fed-analyst'] as const;
for (const id of SUPERVISOR_BODIES) registerBody(id, async () => ((await import(`./bodies/${id}.js`)) as { createBody: BodyFactory }).createBody);

// SUPERVISOR-AUDITOR-LOOP — shared executor kinds that carry a whole body (agent.yaml instances only · src/loop-agent/v3/<kind>.ts).
registerKindBody('fleet-audit.observe', async () => ((await import('./v3/fleet-audit-kind.js')) as { createFleetAuditBody: BodyFactory }).createFleetAuditBody);
// RAIL-CANARY-AUTO-ROLLBACK — measure a build swap · roll back once per sha (agent.yaml ⊕ graphs/policies/<pack>.yaml · src/loop-agent/v3/canary-kind.ts).
registerKindBody('canary.check', async () => ((await import('./v3/canary-kind.js')) as { createCanaryBody: BodyFactory }).createCanaryBody);
