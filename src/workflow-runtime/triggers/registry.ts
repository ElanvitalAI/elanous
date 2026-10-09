// Node-catalog v2 (2026-05-11) — trigger registry (pure scanner).
//
// Takes a list of `WorkflowEntry` and returns the trigger nodes
// declared across all of them. The daemon-side scheduler +
// webhook router consume this registry to wire dispatch.
//
// Pure: no I/O, no clock, no side effects. Tests pass a synthetic
// workflow list and assert the registry shape.

import { isScheduleTriggerNode, isWebhookTriggerNode } from '../schema.js';
import type {
  ScheduleTriggerNode,
  WebhookTriggerNode,
  WorkflowEntry,
} from '../types.js';

export interface ScheduleEntry {
  workflowName: string;
  nodeId: string;
  trigger: ScheduleTriggerNode['scheduleTrigger'];
}

// Graph schedules use the same ScheduleEntry shape as workflow nodes; the
// graph identity is namespaced so a workflow of the same name cannot collide.
export function graphScheduleEntries(document: unknown): ScheduleEntry[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid graph YAML');
  const graph = document as Record<string, unknown>;
  const triggers = graph.triggers;
  if (triggers === undefined) return [];
  if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) throw new Error('graph triggers must be an object');
  const schedule = (triggers as Record<string, unknown>).schedule;
  if (schedule === undefined) return [];
  if (typeof graph.graph_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(graph.graph_id) || graph.graph_id === '.' || graph.graph_id === '..') {
    throw new Error('graph schedule requires a valid graph_id');
  }
  const schedules = Array.isArray(schedule) ? schedule : [schedule];
  return schedules.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('graph triggers.schedule must contain schedule objects');
    const value = raw as Record<string, unknown>;
    if (value.type === 'cron' && typeof value.cron === 'string' && value.cron.trim()) {
      return { workflowName: `graph:${graph.graph_id}`, nodeId: `schedule:${index}`, trigger: { type: 'cron', cron: value.cron } };
    }
    if (value.type === 'interval' && typeof value.interval === 'number' && Number.isFinite(value.interval) && value.interval > 0) {
      return { workflowName: `graph:${graph.graph_id}`, nodeId: `schedule:${index}`, trigger: { type: 'interval', interval: value.interval } };
    }
    throw new Error(`invalid graph triggers.schedule[${index}]: expected cron or interval`);
  });
}

export interface WebhookEntry {
  workflowName: string;
  nodeId: string;
  trigger: WebhookTriggerNode['webhookTrigger'];
}

export interface TriggerRegistry {
  schedules: ScheduleEntry[];
  webhooks: WebhookEntry[];
}

/** Pure: scan workflows for scheduleTrigger + webhookTrigger nodes.
 *  Returns a flat registry keyed by `{workflowName, nodeId}` so each
 *  trigger node maps to exactly one entry. */
export function buildTriggerRegistry(workflows: WorkflowEntry[]): TriggerRegistry {
  const schedules: ScheduleEntry[] = [];
  const webhooks: WebhookEntry[] = [];
  for (const wf of workflows) {
    for (const node of wf.definition.nodes ?? []) {
      if (isScheduleTriggerNode(node)) {
        schedules.push({
          workflowName: wf.definition.name,
          nodeId: node.id,
          trigger: node.scheduleTrigger,
        });
      } else if (isWebhookTriggerNode(node)) {
        webhooks.push({
          workflowName: wf.definition.name,
          nodeId: node.id,
          trigger: node.webhookTrigger,
        });
      }
    }
  }
  return { schedules, webhooks };
}

/** Pure: detect collisions where the same `(method, path)` pair is
 *  registered by multiple webhooks. The router cannot wire conflicting
 *  routes, so callers should surface these to the user. */
export function findWebhookCollisions(registry: TriggerRegistry): Array<{
  method: string;
  path: string;
  entries: WebhookEntry[];
}> {
  const byKey = new Map<string, WebhookEntry[]>();
  for (const w of registry.webhooks) {
    const key = `${w.trigger.method} ${w.trigger.path}`;
    const arr = byKey.get(key) ?? [];
    arr.push(w);
    byKey.set(key, arr);
  }
  const collisions: Array<{ method: string; path: string; entries: WebhookEntry[] }> = [];
  for (const [key, entries] of byKey) {
    if (entries.length > 1) {
      const [method, path] = key.split(' ', 2);
      collisions.push({ method, path, entries });
    }
  }
  return collisions;
}
