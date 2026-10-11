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

const WEBHOOK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function parseGraphWebhookAuth(raw: unknown, label: string): WebhookEntry['trigger']['auth'] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label}.auth must be an object`);
  const auth = raw as Record<string, unknown>;
  if (auth.type === 'bearer' && typeof auth.token === 'string') return { type: 'bearer', token: auth.token };
  if (auth.type === 'basic' && typeof auth.username === 'string' && typeof auth.password === 'string') {
    return { type: 'basic', username: auth.username, password: auth.password };
  }
  if (auth.type === 'hmac' && typeof auth.header === 'string' && auth.header.trim()
    && typeof auth.secretRef === 'string' && auth.secretRef.trim()) {
    const { algorithm, encoding, prefix } = auth;
    if (algorithm !== undefined && algorithm !== 'sha256' && algorithm !== 'sha1') throw new Error(`${label}.auth.algorithm must be sha256 or sha1`);
    if (encoding !== undefined && encoding !== 'hex' && encoding !== 'base64') throw new Error(`${label}.auth.encoding must be hex or base64`);
    if (prefix !== undefined && typeof prefix !== 'string') throw new Error(`${label}.auth.prefix must be a string`);
    return {
      type: 'hmac', header: auth.header, secretRef: auth.secretRef,
      ...(algorithm !== undefined ? { algorithm: algorithm as 'sha256' | 'sha1' } : {}),
      ...(encoding !== undefined ? { encoding: encoding as 'hex' | 'base64' } : {}),
      ...(prefix !== undefined ? { prefix: prefix as string } : {}),
    };
  }
  throw new Error(`${label}.auth must be a valid bearer, basic or hmac auth`);
}

// Graph webhooks use the same WebhookEntry shape as workflow nodes, namespaced like graph schedules.
// Routes that two declarations share are refused here so the router never holds an ambiguous path.
export function graphWebhookEntries(document: unknown): WebhookEntry[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid graph YAML');
  const graph = document as Record<string, unknown>;
  const triggers = graph.triggers;
  if (triggers === undefined) return [];
  if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) throw new Error('graph triggers must be an object');
  const webhook = (triggers as Record<string, unknown>).webhook;
  if (webhook === undefined) return [];
  if (typeof graph.graph_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(graph.graph_id) || graph.graph_id === '.' || graph.graph_id === '..') {
    throw new Error('graph webhook requires a valid graph_id');
  }
  const webhooks = Array.isArray(webhook) ? webhook : [webhook];
  const entries = webhooks.map((raw, index): WebhookEntry => {
    const label = `graph triggers.webhook[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be a webhook object`);
    const value = raw as Record<string, unknown>;
    const method = value.method === undefined ? 'POST' : value.method;
    if (typeof method !== 'string' || !WEBHOOK_METHODS.includes(method)) throw new Error(`${label}.method must be one of: ${WEBHOOK_METHODS.join(' | ')}`);
    if (typeof value.path !== 'string' || !value.path.startsWith('/')) throw new Error(`${label}.path is required and must start with '/'`);
    const auth = parseGraphWebhookAuth(value.auth, label);
    return {
      workflowName: `graph:${graph.graph_id}`,
      nodeId: `webhook:${index}`,
      trigger: { method: method as WebhookEntry['trigger']['method'], path: value.path, ...(auth ? { auth } : {}) },
    };
  });
  const collisions = findWebhookCollisions({ schedules: [], webhooks: entries });
  if (collisions.length) throw new Error(`graph triggers.webhook route collision: ${collisions.map(c => `${c.method} ${c.path}`).join(', ')}`);
  return entries;
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
