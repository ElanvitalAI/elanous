import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { canonicalMessageAddress, openMsgStore, type Message, type MsgStore } from '../msg/msg-store.js';
import { userConfigPath } from '../user-config.js';
import { debug } from '../debug/log.js';

export type ReleaseStageState = 'start' | 'ok' | 'fail' | 'skip' | 'wait' | 'stall';
export interface ReleaseStageMailInput { runId: string; nodeId: string; state: ReleaseStageState; recipient?: string; eventId?: string }

function eventKey(input: ReleaseStageMailInput): string {
  return Buffer.from(JSON.stringify(input.eventId === undefined
    ? [input.runId, input.nodeId, input.state] : [input.eventId])).toString('base64url');
}

export function emitReleaseStageTransition(graphId: string, dryRun: boolean, input: ReleaseStageMailInput,
  emit: (mail: ReleaseStageMailInput) => unknown = postReleaseStageMail, deliveryId?: string): boolean {
  if (graphId !== 'release-loop' || dryRun) return true;
  try { emit(deliveryId === undefined ? input : { ...input, eventId: deliveryId }); return true; }
  catch (error) {
    debug.log('release-loop.stage-mail', 'delivery-failed', { runId: input.runId, nodeId: input.nodeId, state: input.state, error: String(error).slice(0, 300) }, { level: 'warn' });
    return false;
  }
}

function configuredRecipient(configPath: string): string {
  if (!existsSync(configPath)) return 'OP';
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { release?: { loop?: { stageMailTo?: unknown } } };
    const configured = raw.release?.loop?.stageMailTo;
    return typeof configured === 'string' && configured.trim() ? canonicalMessageAddress(configured) : 'OP';
  } catch { return 'OP'; }
}

export function postReleaseStageMail(input: ReleaseStageMailInput, deps: {
  configPath?: string;
  openStore?: () => MsgStore;
} = {}): Message {
  const store = (deps.openStore ?? openMsgStore)();
  try { return appendReleaseStageMail(store, input, deps); }
  finally { store.close(); }
}

/** Write through a run-owned store when several event subscribers share the same mailbox connection. */
export function appendReleaseStageMail(store: MsgStore, input: ReleaseStageMailInput, deps: { configPath?: string } = {}): Message {
  const recipient = input.recipient ?? configuredRecipient(deps.configPath ?? (getElanousConfigDirOverride()
    ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath()));
  const identity = eventKey(input);
  const kind = input.state === 'fail' || input.state === 'stall' ? 'alert' : 'progress';
  return store.appendWithProvenance({ from: 'TC', to: recipient, kind,
    body: `release stage · run=${input.runId} · node=${input.nodeId} · state=${input.state}` }, `release-stage:${identity}:event`);
}

export function startReleaseStageStallWatch(input: Omit<ReleaseStageMailInput, 'state'>, deps: {
  graphId: string;
  dryRun: boolean;
  afterMs?: number;
  emit?: (input: ReleaseStageMailInput) => unknown;
  log?: (event: string, data: Record<string, unknown>) => void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}): () => void {
  const schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout> = deps.schedule ?? setTimeout;
  const cancel = deps.cancel ?? clearTimeout;
  let stopped = false;
  const log = deps.log ?? ((event: string, data: Record<string, unknown>) => debug.log('release-loop.stage-mail', event, data, { level: 'warn' }));
  const timer = schedule(() => {
    if (stopped) return;
    log('no-progress-stall', { runId: input.runId, nodeId: input.nodeId, afterMs: deps.afterMs ?? 5 * 60_000 });
    if (!emitReleaseStageTransition(deps.graphId, deps.dryRun, { ...input, state: 'stall' }, deps.emit ?? postReleaseStageMail)) {
      log('stall-delivery-failed', { runId: input.runId, nodeId: input.nodeId });
    }
  }, deps.afterMs ?? 5 * 60_000);
  return () => { stopped = true; cancel(timer); };
}
