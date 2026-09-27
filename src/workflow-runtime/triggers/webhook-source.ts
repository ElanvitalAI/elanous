// Scheduler retirement R2 — concrete TriggerSource for webhooks.
//
// Wraps `buildWebhookRouter` behind the generic `TriggerSource`
// interface. The daemon hosts the router on `/v1/workflows/webhooks/*`
// of the NEXUS HTTP server (see `src/nexus/api/http-server.ts`); this
// module just adapts subscriptions → router + collision reporting.

import { debug } from '../../debug/log.js';
import { isWebhookTriggerNode } from '../schema.js';
import type { WebhookTriggerNode, WorkflowEntry } from '../types.js';
import { findWebhookCollisions } from './registry.js';
import type { WebhookEntry } from './registry.js';
import {
  buildWebhookRouter,
  type WebhookRouter,
  type WebhookRouterRequest,
  type WebhookRouterResponse,
} from './webhook-router.js';
import type { TriggerEmit, TriggerSource, TriggerSubscription } from './source.js';

interface Binding {
  entry: WorkflowEntry;
  node: WebhookTriggerNode;
  webhookEntry: WebhookEntry;
  onEmit: TriggerEmit;
}

export interface WebhookSource extends TriggerSource {
  readonly kind: 'webhook';
  /** Route an inbound HTTP request through the registry. Returns a
   *  404 / 401 / 202 / 500 response per spec. Returns null when called
   *  before `start()` (caller should 503). */
  dispatch(req: WebhookRouterRequest): Promise<WebhookRouterResponse | null>;
  /** Detected route collisions ((method, path) registered more than
   *  once). Populated after `start()`. Empty array if none. */
  collisions(): Array<{ method: string; path: string }>;
  subscriptions(): TriggerSubscription[];
}

export interface WebhookSourceOpts {
  /** Secret lookup for `hmac` routes. Default = the NEXUS secret store. */
  resolveSecret?: (ref: string) => string | undefined | Promise<string | undefined>;
}

async function secretStoreLookup(ref: string): Promise<string | undefined> {
  const { getSecretAsync } = await import('../../nexus/config/secrets/index.js');
  return await getSecretAsync(ref);
}

export function createWebhookSource(sourceOpts: WebhookSourceOpts = {}): WebhookSource {
  const bindings: Binding[] = [];
  let router: WebhookRouter | null = null;
  let collisionList: Array<{ method: string; path: string }> = [];

  return {
    kind: 'webhook',
    subscribe(entry, onEmit) {
      // 2026-05-12 — post-start subscribe now wires into the router
      // via `router.register`, so a workflow YAML dropped after
      // daemon boot can serve `/v1/workflows/webhooks/...` requests
      // without a restart.
      for (const node of entry.definition.nodes ?? []) {
        if (!isWebhookTriggerNode(node)) continue;
        const webhookEntry: WebhookEntry = {
          workflowName: entry.definition.name,
          nodeId: node.id,
          trigger: node.webhookTrigger,
        };
        if (bindings.some(b => b.webhookEntry.workflowName === webhookEntry.workflowName
          && b.webhookEntry.nodeId === webhookEntry.nodeId)) {
          continue;
        }
        bindings.push({ entry, node, webhookEntry, onEmit });
        if (router !== null) router.register(webhookEntry);
      }
    },
    async start() {
      if (router !== null) return;
      const collisions = findWebhookCollisions({
        schedules: [],
        webhooks: bindings.map(b => b.webhookEntry),
      });
      collisionList = collisions.map(c => ({ method: c.method, path: c.path }));
      router = buildWebhookRouter({
        registry: bindings.map(b => b.webhookEntry),
        resolveSecret: sourceOpts.resolveSecret ?? secretStoreLookup,
        onAuthRejected: (webhookEntry, res) => debug.log('workflow.webhook', 'auth-rejected', {
          method: webhookEntry.trigger.method,
          path: webhookEntry.trigger.path,
          status: res.status,
          authType: webhookEntry.trigger.auth?.type,
        }),
        runWorkflow: async (webhookEntry, body) => {
          const binding = bindings.find(b =>
            b.webhookEntry.workflowName === webhookEntry.workflowName
            && b.webhookEntry.nodeId === webhookEntry.nodeId);
          if (!binding) return { ok: false as const, error: 'no binding for entry' };
          const result = await binding.onEmit(
            webhookEntry.workflowName,
            webhookEntry.nodeId,
            { kind: 'webhook', method: webhookEntry.trigger.method, path: webhookEntry.trigger.path, body },
          );
          return result.ok && result.runId
            ? { ok: true as const, runId: result.runId }
            : { ok: false as const, error: result.error ?? 'workflow dispatch failed' };
        },
      });
    },
    async stop() {
      router = null;
      bindings.length = 0;
      collisionList = [];
    },
    async dispatch(req) {
      if (!router) return null;
      return await router(req);
    },
    collisions: () => [...collisionList],
    subscriptions: () => bindings.map(b => ({
      kind: 'webhook' as const,
      workflowName: b.webhookEntry.workflowName,
      nodeId: b.webhookEntry.nodeId,
      summary: `${b.webhookEntry.trigger.method} ${b.webhookEntry.trigger.path}`,
    })),
  };
}
