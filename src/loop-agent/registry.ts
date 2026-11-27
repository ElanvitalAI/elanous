// LOOP-AGENT v2 generic shell — body registry: card id → lazily loaded L1 body. A card without a registered body is listed
// («몸 없음») and refuses tick/voice — the card alone never acts.
import type { AgentCard } from './card.js';
import type { AgentBody } from './runtime.js';

export interface BodyEnv { readonly stateRoot: string; readonly card: AgentCard }
export type BodyFactory = (env: BodyEnv) => AgentBody | Promise<AgentBody>;

const BODIES = new Map<string, () => Promise<BodyFactory>>();

/** Register a body loader (lazy: the import runs only when this agent wakes). */
export function registerBody(id: string, load: () => Promise<BodyFactory>): void { BODIES.set(id, load); }
export const hasBody = (id: string): boolean => BODIES.has(id);
export const bodyIds = (): string[] => [...BODIES.keys()].sort();

export async function loadBodyFactory(id: string): Promise<BodyFactory> {
  const load = BODIES.get(id);
  if (!load) throw new Error(`loop agent ${id}: card exists but no body is registered (src/loop-agent/registry.ts)`);
  return load();
}

export async function loadBody(id: string, env: BodyEnv): Promise<AgentBody> {
  return (await loadBodyFactory(id))(env);
}

/** Bespoke v2 agents with their own doors (they share the memory home and the knowhow/lesson/memory subcommands). */
export const BESPOKE_AGENTS: Readonly<Record<string, string>> = { 'judge-butler': 'eln loop butler status|tick|voice' };

// SUPERVISOR-REVIVE-1127 — the supervisors' bodies (src/loop-agent/bodies/<id>.ts · each exports createBody(env)).
export const SUPERVISOR_BODIES = ['run-supervisor', 'run-doctor', 'autopsy', 'macrophage', 'watchers-check', 'silence-watch', 'train-manager', 'release-rocket', 'hand-steward'] as const;
for (const id of SUPERVISOR_BODIES) registerBody(id, async () => ((await import(`./bodies/${id}.js`)) as { createBody: BodyFactory }).createBody);
