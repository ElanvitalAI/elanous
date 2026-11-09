// ── Mission route-decision evidence (R3 · durable TaskStore notes) ─────────
//
// Phase notes are the existing durable evidence surface for PR, critique and
// diagnosis.  Keep route evidence there too rather than introducing a new DB.
// Only the runner that actually owns a model decision writes this record.

import type { RouteDecision } from '../llm/route-decision.js';
import type { LLMProviderName } from '../user-config/types.js';
import { TaskStore } from '../task-orchestrator/store.js';

const PREFIX = '[ROUTE-DECISION] ';

/** Adapter backend is execution evidence, not a policy prediction. */
export function routeDecisionFromExecutionBackend(backend: string): RouteDecision {
  const model = backend.includes(':') ? backend.slice(backend.indexOf(':') + 1) : backend;
  const low = backend.toLowerCase();
  const provider: LLMProviderName = low.includes('claude') || low.includes('anthropic') ? 'anthropic'
    : low.includes('gemini') ? 'gemini' : low.includes('grok') ? 'grok'
      : low.includes('codex') || low.includes('gpt-') ? 'openai-codex' : 'auto';
  return { provider, model, source: 'execution-backend', rationale: `adapter executed ${backend}`, mission: 'build' };
}

export function formatRouteDecisionNote(decision: RouteDecision): string {
  return PREFIX + JSON.stringify({
    provider: decision.provider, model: decision.model, ...(decision.effort ? { effort: decision.effort } : {}),
    source: decision.source, rationale: decision.rationale, mission: decision.mission,
    ...(decision.escalation ? { escalation: decision.escalation } : {}),
  });
}

export function parseRouteDecisionNote(note: string): RouteDecision | null {
  if (!note.startsWith(PREFIX)) return null;
  try {
    const v = JSON.parse(note.slice(PREFIX.length)) as Partial<RouteDecision>;
    if (typeof v.provider !== 'string' || typeof v.model !== 'string' || typeof v.source !== 'string' || typeof v.rationale !== 'string' || typeof v.mission !== 'string') return null;
    return v as RouteDecision;
  } catch { return null; }
}

/** Replaces prior evidence for the phase: a rerun must show its latest lane. */
export function persistMissionRouteDecision(phaseId: string, decision: RouteDecision, opts: { store?: TaskStore } = {}): void {
  const store = opts.store ?? new TaskStore();
  try {
    const task = store.getTask(phaseId);
    if (!task) return;
    store.saveTask({ ...task, notes: [...task.notes.filter((n) => !n.startsWith(PREFIX)), formatRouteDecisionNote(decision)], updatedAt: Date.now() });
  } finally { if (!opts.store) store.close(); }
}

/** Latest phase decision is the mission-level briefing evidence. */
export function latestMissionRouteDecision(missionId: string, opts: { store?: TaskStore } = {}): RouteDecision | null {
  const store = opts.store ?? new TaskStore();
  try {
    const tasks = store.listTasks({ goalSlug: missionId }).filter((t) => t.surface.kind === 'subagent').sort((a, b) => b.updatedAt - a.updatedAt);
    for (const task of tasks) for (let i = task.notes.length - 1; i >= 0; i--) {
      const d = parseRouteDecisionNote(task.notes[i]!);
      if (d) return d;
    }
    return null;
  } finally { if (!opts.store) store.close(); }
}
