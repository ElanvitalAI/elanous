// Scheduler retirement R2 (2026-05-11) — workflow-runtime daemon.
//
// Owns trigger source lifecycle: load workflows → subscribe schedule
// + webhook entries → start → ... → stop. Each emit dispatches a real
// `runWorkflow` against the workflow definition. Run results land in
// `~/.elanous/workflows-runs/<runId>/` (handled by `executor.ts` ·
// unchanged here).
//
// Pure orchestration — no global state, no boot-time side effects.
// Callers (CLI `elanous wf daemon`, NEXUS server, tests) instantiate +
// invoke `start()` / `stop()` explicitly.

import { findWorkflow } from './discovery.js';
import { runWorkflowToCompletion } from './executor.js';
import {
  readWorkflowLifecycle,
  type WorkflowLifecycleStatus,
} from './lifecycle.js';
import {
  isChatTriggerNode,
  isDiscordTriggerNode,
  isManualTriggerNode,
  isScheduleTriggerNode,
  isTelegramTriggerNode,
  isWebhookTriggerNode,
} from './schema.js';
import {
  createTriggerSkipRecorder,
  type TriggerSkipRecord,
} from './trigger-skip-emit.js';
import { createChatSource, type ChatSource } from './triggers/chat-source.js';
import type { ChatRouterRequest, ChatRouterResponse } from './triggers/chat-router.js';
import { createDiscordSource, type DiscordEvent, type DiscordSource } from './triggers/discord-source.js';
import { createScheduleSource, type ScheduleSource } from './triggers/schedule-source.js';
import { createTelegramSource, type TelegramEvent, type TelegramSource } from './triggers/telegram-source.js';
import { createWebhookSource, type WebhookSource } from './triggers/webhook-source.js';
import type { TriggerEmit, TriggerEmitResult, TriggerSubscription } from './triggers/source.js';
import type { WebhookRouterRequest, WebhookRouterResponse } from './triggers/webhook-router.js';
import type { WorkflowDeps, WorkflowEntry } from './types.js';

/** Surface-unification v2 (2026-05-11) — variant tag carried by the
 *  `onLifecycle` callback so SSE consumers can render variant icons
 *  without a second classify pass. Matches the PWA TriggerSnapshotEntry. */
export type DaemonTriggerVariant = 'schedule' | 'webhook' | 'discord' | 'telegram' | 'manual' | 'chat';

export interface WorkflowRuntimeDaemonOpts {
  /** Workflows to subscribe. Typically `discoverWorkflows()`. */
  workflows: WorkflowEntry[];
  /** Installed graph plugin assets registered with the daemon webhook router. */
  graphFiles?: readonly string[];
  /** WorkflowDeps to pass to `runWorkflowToCompletion` on each emit. */
  deps: WorkflowDeps;
  /** Inject for tests. Defaults to `runWorkflowToCompletion`. */
  runWorkflow?: typeof runWorkflowToCompletion;
  /** Inject schedule source (tests substitute fake timers). */
  scheduleSource?: ScheduleSource;
  /** Inject webhook source (tests substitute fake router). */
  webhookSource?: WebhookSource;
  /** Inject discord source (tests + AXON bridge wire). */
  discordSource?: DiscordSource;
  /** Inject telegram source (tests + AXON bridge wire). */
  telegramSource?: TelegramSource;
  /** Inject chat source (tests + chat trigger v2 daemon route). */
  chatSource?: ChatSource;
  /** M4-6.2 (FU8 PR #1 · 2026-05-12) — inject the lifecycle reader so
   *  tests can drive the gate without writing a real
   *  `.lifecycle.json`. Defaults to `readWorkflowLifecycle` from
   *  `lifecycle.js` (back-compat: missing entry → `'active'`). */
  readLifecycle?: (workflowName: string) => WorkflowLifecycleStatus;
  /** M4-6.2 — inject the 3-sink fan-out recorder for `draft` skips.
   *  Defaults to `createTriggerSkipRecorder()` which emits to the
   *  global signal bus + user-intent logger. Tests pass a capture
   *  array to assert per-event payload shape. */
  triggerSkipRecorder?: (record: TriggerSkipRecord) => void;
  /** Hook for telemetry. Called once per emit + every fail. */
  onEmit?: (info: { workflowName: string; nodeId: string; result: TriggerEmitResult }) => void;
  /** Surface-unification v2 (2026-05-11) — lifecycle fan-out for the
   *  PWA Active triggers panel. `subscribed` fires after start() per
   *  trigger node; `unsubscribed` fires before stop(); `fired` fires
   *  on every emit (alongside `onEmit`). Variant is the daemon's
   *  classification (schedule/webhook/discord/telegram) so the PWA
   *  doesn't have to re-scan the workflow definition. */
  onLifecycle?: (info:
    | { phase: 'subscribed' | 'unsubscribed'; workflowName: string; nodeId: string; variant: DaemonTriggerVariant }
    | { phase: 'fired'; workflowName: string; nodeId: string; variant: DaemonTriggerVariant; result: TriggerEmitResult }
  ) => void;
}

export interface WorkflowRuntimeDaemon {
  /** Connect all trigger sources. Idempotent. */
  start(): Promise<void>;
  /** Disconnect + release. Idempotent. */
  stop(): Promise<void>;
  /** V2.2-7 (2026-05-11) — register a new workflow after `start()` so
   *  it can fire without restarting the daemon. The TOX→workflow-runtime
   *  bridge (`task-orchestrator/task-to-workflow.ts`) calls this when a
   *  TOX task with a `scheduleText` is created.
   *
   *  v1 scope = schedule trigger nodes only (TOX bridge use case);
   *  webhook/discord/telegram/chat sources retain their boot-only
   *  subscribe contract because the live-subscribe path is needed only
   *  for schedule triggers in V2.2-7. Workflows containing other
   *  trigger kinds register silently for those — they simply will not
   *  fire until the next daemon restart. */
  registerWorkflow(entry: WorkflowEntry): void;
  /** Snapshot for `elanous wf daemon status`. */
  status(): {
    started: boolean;
    schedule: { active: number; activeIntervals: number; activeCrons: number; skipped: number };
    webhook: { collisions: Array<{ method: string; path: string }> };
    subscriptions: TriggerSubscription[];
  };
  /** Dispatch an inbound HTTP request through the webhook router. Used
   *  by `src/nexus/api/http-server.ts` to bridge `/v1/workflows/webhooks/*`. */
  dispatchWebhook(req: WebhookRouterRequest): Promise<WebhookRouterResponse | null>;
  /** NEXUS may defer to this exact authenticated graph webhook route's own credential check. */
  isSelfVerifiedGraphWebhookRoute(method: string, path: string): boolean;
  /** Dispatch a normalized Discord event (message · mention · reaction)
   *  through subscribed Discord trigger nodes. Used by the AXON
   *  Discord bridge follow-up that taps `src/discord.ts` MESSAGE_CREATE
   *  / MESSAGE_REACTION_ADD events. */
  dispatchDiscord(event: DiscordEvent): Promise<Array<{ workflowName: string; nodeId: string; ok: boolean; error?: string }>>;
  /** Dispatch a normalized Telegram event (message · command ·
   *  callback_query) through subscribed Telegram trigger nodes. Used
   *  by the AXON Telegram bridge follow-up that taps polling / webhook
   *  events in `src/telegram.ts`. */
  dispatchTelegram(event: TelegramEvent): Promise<Array<{ workflowName: string; nodeId: string; ok: boolean; error?: string }>>;
  /** Dispatch an inbound chat HTTP request through the chat router. v2
   *  daemon route. Returns null when called before start(). */
  dispatchChat(req: ChatRouterRequest): Promise<ChatRouterResponse | null>;
  /** V2.2-2 (2026-05-12) — chat trigger metadata for the hosted chat
   *  UI. Returns the workflow's first chat-trigger config or null
   *  when the workflow has no chat trigger / hostedUi opt-out. The
   *  hosted bearer is NOT returned (tokens stay server-side); the
   *  PWA carries it via URL param. */
  chatConfig(workflowName: string): {
    workflowName: string;
    nodeId: string;
    path: string;
    streaming: boolean;
    sessionMode: 'stateless' | 'per-session';
    hostedUi: { enabled: boolean; requiresBearer: boolean };
  } | null;
}

export function createWorkflowRuntimeDaemon(
  opts: WorkflowRuntimeDaemonOpts,
): WorkflowRuntimeDaemon {
  const scheduleSource = opts.scheduleSource ?? createScheduleSource();
  const webhookSource = opts.webhookSource ?? createWebhookSource();
  const discordSource = opts.discordSource ?? createDiscordSource();
  const telegramSource = opts.telegramSource ?? createTelegramSource();
  // Surface-unification v2.1 (2026-05-11) — pass workflowDeps so the
  // chat-source streaming path can drive runWorkflow directly.
  const chatSource = opts.chatSource ?? createChatSource({ workflowDeps: opts.deps });
  const runFn = opts.runWorkflow ?? runWorkflowToCompletion;
  // M4-6.2 (FU8 PR #1 · 2026-05-12) — lifecycle gate dependencies.
  // Both DI seams default to the production singletons so production
  // wiring remains zero-config; tests override `readLifecycle` to
  // drive the gate and `triggerSkipRecorder` to capture the fan-out.
  const readLifecycleFn = opts.readLifecycle ?? readWorkflowLifecycle;
  const recordSkip = opts.triggerSkipRecorder ?? createTriggerSkipRecorder();
  // V2.2-7 (2026-05-11) — mutable entry list backs `registerWorkflow`.
  // Boot-time entries from `opts.workflows` seed the list; live calls
  // to `registerWorkflow` push more so `variantOf` and the lifecycle
  // fan-out keep finding the workflow definition.
  const entries: WorkflowEntry[] = [...opts.workflows];
  let started = false;

  // Surface-unification v2 — classify a node to its variant for the
  // lifecycle callback. Mirrors `previewTriggerCard`'s dispatch but
  // returns the short variant tag instead of a string.
  function variantOf(workflowName: string, nodeId: string): DaemonTriggerVariant | null {
    const wf = entries.find((w) => w.definition.name === workflowName);
    if (!wf) return null;
    const node = wf.definition.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    if (isScheduleTriggerNode(node)) return 'schedule';
    if (isWebhookTriggerNode(node)) return 'webhook';
    if (isDiscordTriggerNode(node)) return 'discord';
    if (isTelegramTriggerNode(node)) return 'telegram';
    if (isManualTriggerNode(node)) return 'manual';
    if (isChatTriggerNode(node)) return 'chat';
    return null;
  }

  const emit: TriggerEmit = async (workflowName, nodeId, payload) => {
    const entry = entries.find(w => w.definition.name === workflowName);
    if (!entry) {
      const result: TriggerEmitResult = { ok: false, error: `workflow not found: ${workflowName}` };
      opts.onEmit?.({ workflowName, nodeId, result });
      return result;
    }
    // M4-6.2 (FU8 PR #1 · 2026-05-12) — lifecycle gate. When the
    // workflow is marked `'draft'`, suppress the run at the dispatch
    // boundary so the user can edit it without scheduled/webhook/
    // chat/discord/telegram fires escaping. The skip is observable
    // through the same `onEmit` / `onLifecycle` callbacks the
    // dispatched runs use, plus a 3-sink fan-out (signal bus +
    // user-intent log) so Patcher / Thinker / dashboards can
    // surface a stable `system.workflow.trigger_skipped` stream.
    //
    // Back-compat: `readWorkflowLifecycle` defaults to `'active'`
    // when the side-file is missing or the workflow has no entry,
    // so existing workflows continue to fire untouched.
    let lifecycle: WorkflowLifecycleStatus;
    try {
      lifecycle = readLifecycleFn(workflowName);
    } catch {
      // Best-effort: a corrupt `.lifecycle.json` should never
      // strand a workflow. Treat read failure as `'active'` (the
      // same back-compat default `readWorkflowLifecycle` returns
      // when the file is missing).
      lifecycle = 'active';
    }
    if (lifecycle === 'draft') {
      const variant = variantOf(workflowName, nodeId);
      try {
        recordSkip({ workflowName, nodeId, variant, reason: 'draft' });
      } catch { /* best-effort */ }
      const result: TriggerEmitResult = {
        ok: false,
        error: 'workflow is draft',
      };
      opts.onEmit?.({ workflowName, nodeId, result });
      if (variant) opts.onLifecycle?.({ phase: 'fired', workflowName, nodeId, variant, result });
      return result;
    }
    // Generate runId up-front so the webhook acks can return it.
    // Mirrors `runWorkflow`'s `generateRunId` (timestamp + 6-hex
    // pattern); duplicating here keeps the daemon stand-alone.
    const runId = `wf-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      const argumentsJson = JSON.stringify({ trigger: payload, nodeId });
      const runResult = await runFn(
        { workflow: entry.definition, arguments: argumentsJson, runId },
        opts.deps,
      );
      // Surface-unification v2.1 (2026-05-11) — capture the last node's
      // output so chat triggers can return the actual reply. Convention
      // = workflow author puts the response-producing node last; the
      // daemon picks `outputs[lastDeclaredNodeId]?.output` stringified.
      const lastNodeId = entry.definition.nodes[entry.definition.nodes.length - 1]?.id;
      const lastOutput = lastNodeId && runResult.outputs[lastNodeId]?.ok
        ? runResult.outputs[lastNodeId]?.output
        : undefined;
      const outputStr = typeof lastOutput === 'string'
        ? lastOutput
        : lastOutput !== undefined ? JSON.stringify(lastOutput) : undefined;
      const result: TriggerEmitResult = runResult.ok
        ? { ok: true, runId, ...(outputStr !== undefined ? { output: outputStr } : {}) }
        : { ok: false, error: 'workflow failed' };
      opts.onEmit?.({ workflowName, nodeId, result });
      const v = variantOf(workflowName, nodeId);
      if (v) opts.onLifecycle?.({ phase: 'fired', workflowName, nodeId, variant: v, result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: TriggerEmitResult = { ok: false, error: message };
      opts.onEmit?.({ workflowName, nodeId, result });
      const v = variantOf(workflowName, nodeId);
      if (v) opts.onLifecycle?.({ phase: 'fired', workflowName, nodeId, variant: v, result });
      return result;
    }
  };

  return {
    async start() {
      if (started) return;
      for (const file of opts.graphFiles ?? []) webhookSource.subscribeGraph(file, async request => {
        const { handlePluginGraphWebhook } = await import('../graph-runner/plugin-graph-entry.js');
        return handlePluginGraphWebhook(file, request);
      });
      for (const entry of entries) {
        scheduleSource.subscribe(entry, emit);
        webhookSource.subscribe(entry, emit);
        discordSource.subscribe(entry, emit);
        telegramSource.subscribe(entry, emit);
        chatSource.subscribe(entry, emit);
      }
      await scheduleSource.start();
      await webhookSource.start();
      await discordSource.start();
      await telegramSource.start();
      await chatSource.start();
      started = true;
      // Surface-unification v2 — fan subscribed events after every source
      // is live so the PWA panel sees a clean batch.
      if (opts.onLifecycle) {
        for (const sub of [
          ...scheduleSource.subscriptions(),
          ...webhookSource.subscriptions(),
          ...discordSource.subscriptions(),
          ...telegramSource.subscriptions(),
          ...chatSource.subscriptions(),
        ]) {
          const v = variantOf(sub.workflowName, sub.nodeId);
          if (v) opts.onLifecycle({ phase: 'subscribed', workflowName: sub.workflowName, nodeId: sub.nodeId, variant: v });
        }
      }
    },
    async stop() {
      // Surface-unification v2 — fan unsubscribed events before tearing
      // down so the PWA panel transitions cleanly (live list → empty).
      if (started && opts.onLifecycle) {
        for (const sub of [
          ...scheduleSource.subscriptions(),
          ...webhookSource.subscriptions(),
          ...discordSource.subscriptions(),
          ...telegramSource.subscriptions(),
          ...chatSource.subscriptions(),
        ]) {
          const v = variantOf(sub.workflowName, sub.nodeId);
          if (v) opts.onLifecycle({ phase: 'unsubscribed', workflowName: sub.workflowName, nodeId: sub.nodeId, variant: v });
        }
      }
      if (!started) {
        await scheduleSource.stop();
        await webhookSource.stop();
        await discordSource.stop();
        await telegramSource.stop();
        await chatSource.stop();
        return;
      }
      await scheduleSource.stop();
      await webhookSource.stop();
      await discordSource.stop();
      await telegramSource.stop();
      await chatSource.stop();
      started = false;
    },
    status() {
      const handle = scheduleSource.handle();
      return {
        started,
        schedule: handle
          ? {
              active: handle.active,
              activeIntervals: handle.activeIntervals,
              activeCrons: handle.activeCrons,
              skipped: handle.skipped.length,
            }
          : { active: 0, activeIntervals: 0, activeCrons: 0, skipped: 0 },
        webhook: { collisions: webhookSource.collisions() },
        subscriptions: [
          ...scheduleSource.subscriptions(),
          ...webhookSource.subscriptions(),
          ...discordSource.subscriptions(),
          ...telegramSource.subscriptions(),
          ...chatSource.subscriptions(),
        ],
      };
    },
    async dispatchWebhook(req) {
      return await webhookSource.dispatch(req);
    },
    isSelfVerifiedGraphWebhookRoute(method, path) {
      return started && webhookSource.isSelfVerifiedGraphRoute(method, path);
    },
    async dispatchDiscord(event) {
      return await discordSource.dispatch(event);
    },
    async dispatchTelegram(event) {
      return await telegramSource.dispatch(event);
    },
    async dispatchChat(req) {
      return await chatSource.dispatch(req);
    },
    chatConfig(workflowName) {
      // V2.2-2 (2026-05-12) — inspect the workflow's chatTrigger
      // node (first match wins · workflows realistically declare at
      // most one). Returns null when no chat trigger or hostedUi is
      // disabled — the hosted page renders an explanatory 404.
      //
      // 2026-05-12 follow-up — when the workflow isn't in the entry
      // cache (yaml dropped after daemon boot), fall back to a fresh
      // disk scan via `findWorkflow` AND auto-register the entry
      // through the public `registerWorkflow` path so the chat
      // dispatcher also picks it up on the very next request.
      let wf = entries.find((w) => w.definition.name === workflowName);
      if (!wf) {
        const fresh = findWorkflow(workflowName);
        if (!fresh) return null;
        // Mutate `entries` + fan into all trigger sources so dispatch
        // works without a daemon restart. Mirrors what
        // registerWorkflow does — kept inline to avoid the
        // self-reference into the returned object.
        entries.push(fresh);
        scheduleSource.subscribe(fresh, emit);
        webhookSource.subscribe(fresh, emit);
        discordSource.subscribe(fresh, emit);
        telegramSource.subscribe(fresh, emit);
        chatSource.subscribe(fresh, emit);
        wf = fresh;
      }
      const node = wf.definition.nodes.find((n) => isChatTriggerNode(n));
      if (!node || !isChatTriggerNode(node)) return null;
      const ct = node.chatTrigger;
      const hostedEnabled = ct.hostedUi?.enabled === true;
      if (!hostedEnabled) return null;
      const requiresBearer = (ct.auth?.type === 'bearer' && ct.auth.token.length > 0)
        || (typeof ct.hostedUi?.bearer === 'string' && ct.hostedUi.bearer.length > 0);
      return {
        workflowName,
        nodeId: node.id,
        path: ct.path,
        streaming: ct.streaming === true,
        sessionMode: ct.sessionMode ?? 'stateless',
        hostedUi: { enabled: true, requiresBearer },
      };
    },
    registerWorkflow(entry) {
      // Dedupe: if a workflow with the same name is already known, the
      // caller (TOX bridge / lazy disk discovery) is re-registering
      // after a task update or restart cycle — replace the definition
      // so emits resolve the freshest body.
      const existingIdx = entries.findIndex((e) => e.definition.name === entry.definition.name);
      if (existingIdx >= 0) {
        entries[existingIdx] = entry;
      } else {
        entries.push(entry);
      }
      // 2026-05-12 — every trigger source now supports post-start
      // subscribe, so fan the new entry into all of them. The chat
      // and webhook sources mutate their router's path/method index
      // in place; discord/telegram dispatch loops read bindings
      // dynamically; schedule was already live-subscribe capable.
      scheduleSource.subscribe(entry, emit);
      webhookSource.subscribe(entry, emit);
      discordSource.subscribe(entry, emit);
      telegramSource.subscribe(entry, emit);
      chatSource.subscribe(entry, emit);
      // Fan a `subscribed` lifecycle event for every trigger node in
      // the entry so the PWA Active triggers panel reflects the new
      // surface without waiting for a daemon restart.
      if (started && opts.onLifecycle) {
        for (const sub of [
          ...scheduleSource.subscriptions(),
          ...webhookSource.subscriptions(),
          ...discordSource.subscriptions(),
          ...telegramSource.subscriptions(),
          ...chatSource.subscriptions(),
        ]) {
          if (sub.workflowName !== entry.definition.name) continue;
          const v = variantOf(sub.workflowName, sub.nodeId);
          if (v) opts.onLifecycle({ phase: 'subscribed', workflowName: sub.workflowName, nodeId: sub.nodeId, variant: v });
        }
      }
    },
  };
}
