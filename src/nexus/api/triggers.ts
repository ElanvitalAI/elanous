// Surface-unification ROADMAP §E1 (2026-05-11) — daemon /v1/triggers
// snapshot endpoint. Returns every active trigger node across the
// discovered workflows, grouped by variant. v1 = REST snapshot only.
// SSE event stream (subscribe / unsubscribe / fire) is the v2 wire
// (registry emitter hook + nexus event bus fan-out); the PWA panel
// (E2) builds on the snapshot first and polls for now.

import { discoverWorkflows } from '../../workflow-runtime/discovery.js';
import {
  isChatTriggerNode,
  isDiscordTriggerNode,
  isManualTriggerNode,
  isScheduleTriggerNode,
  isTelegramTriggerNode,
  isWebhookTriggerNode,
} from '../../workflow-runtime/schema.js';
import { jsonResponse } from './json-response.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';

export interface TriggerSnapshotEntry {
  workflowName: string;
  nodeId: string;
  variant: 'schedule' | 'webhook' | 'discord' | 'telegram' | 'manual' | 'chat';
  payload: Record<string, unknown>;
}

export interface TriggerSnapshot {
  triggers: TriggerSnapshotEntry[];
  /** Workflow count contributing entries — useful for the PWA panel's
   *  "N workflows · M triggers active" header. */
  workflowsScanned: number;
}

/** Pure: convert the discovered workflow list into a flat trigger
 *  inventory. Exported for unit testability. */
export function buildTriggerSnapshot(
  workflows: ReturnType<typeof discoverWorkflows>,
): TriggerSnapshot {
  const triggers: TriggerSnapshotEntry[] = [];
  for (const wf of workflows) {
    for (const node of wf.definition.nodes ?? []) {
      const workflowName = wf.definition.name;
      const nodeId = node.id;
      if (isScheduleTriggerNode(node)) {
        triggers.push({ workflowName, nodeId, variant: 'schedule', payload: node.scheduleTrigger });
      } else if (isWebhookTriggerNode(node)) {
        triggers.push({ workflowName, nodeId, variant: 'webhook', payload: node.webhookTrigger });
      } else if (isDiscordTriggerNode(node)) {
        triggers.push({ workflowName, nodeId, variant: 'discord', payload: node.discordTrigger as Record<string, unknown> });
      } else if (isTelegramTriggerNode(node)) {
        triggers.push({ workflowName, nodeId, variant: 'telegram', payload: node.telegramTrigger as Record<string, unknown> });
      } else if (isManualTriggerNode(node)) {
        triggers.push({ workflowName, nodeId, variant: 'manual', payload: (node.manualTrigger ?? {}) as Record<string, unknown> });
      } else if (isChatTriggerNode(node)) {
        triggers.push({ workflowName, nodeId, variant: 'chat', payload: node.chatTrigger as Record<string, unknown> });
      }
    }
  }
  return { triggers, workflowsScanned: workflows.length };
}

/** GET /v1/triggers — snapshot of every trigger node in the discovered
 *  workflow set. Each entry is keyed by (workflowName, nodeId) so the
 *  PWA can render an "Active triggers" panel + click-through to the
 *  graph for each one. */
export async function handleTriggersSnapshot(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const snapshot = buildTriggerSnapshot(discoverWorkflows());
  return jsonResponse(snapshot, 200);
}
