import { randomUUID } from 'node:crypto';
import { createMissionOutStore, type MissionReplyMessageFields } from './mission-out.js';
import { postMissionLineEvent } from './mission-line.js';
import { sanitizeForPtyInput } from './provision.js';
import { requestRemotePtyControl } from '../pty-shell/pty-control-ipc.js';

export interface MissionHandReplyTarget {
  missionId: string;
  attemptId: string;
  agent: 'codex' | 'claude';
  token: string;
  nexusUrl: string;
  ptyId?: string;
  runId?: string;
}

export type MissionHandReplyResult =
  | { ok: true; recorded: true; delivered: true; delivery: 'pty-arbiter'; lineId: string }
  | { ok: true; recorded: true; delivered: false; delivery: 'ask-ledger' | 'record-only'; lineId: string }
  | { ok: false; recorded: boolean; delivered: false; reason: string; lineId?: string };

/** Persist headless answers/corrections for the waiting mission worker; never write to a PTY. */
export async function recordHeadlessMissionHandReply(input: {
  missionId: string;
  kind: 'answer' | 'correct';
  text: string;
  replyTo: number;
  scope?: string;
  stop?: boolean;
  priority?: string;
}, store: ReturnType<typeof createMissionOutStore>): Promise<MissionHandReplyResult> {
  const record = store.read(input.missionId);
  if (!record) return { ok: false, recorded: false, delivered: false, reason: 'mission not found' };
  if (record.status !== 'running') return { ok: false, recorded: false, delivered: false, reason: `mission is ${record.status}` };
  const lineId = randomUUID();
  const fields: MissionReplyMessageFields = {
    lineId, kind: input.kind, replyTo: input.replyTo, source: 'parent-hand-reply',
    ...(input.kind === 'correct' ? {
      state: 'correct 미적용(headless record-only)',
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.stop !== undefined ? { stop: input.stop } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
    } : {}),
  };
  try {
    await store.reply(input.missionId, input.text, false, fields);
    return { ok: true, recorded: true, delivered: false, delivery: 'record-only', lineId };
  } catch (error) {
    return { ok: false, recorded: false, delivered: false, reason: error instanceof Error ? error.message : String(error), lineId };
  }
}

/** Record a parent answer/correction on the scoped mission line before routing it through the PTY arbiter. */
export async function recordAndDeliverMissionHandReply(input: {
  target: MissionHandReplyTarget;
  kind: 'answer' | 'correct';
  text: string;
  actor: 'agent' | 'human';
  replyTo: number;
  runId?: string;
  scope?: string;
  stop?: boolean;
  priority?: string;
}, deps: {
  postLine?: typeof postMissionLineEvent;
  control?: typeof requestRemotePtyControl;
} = {}): Promise<MissionHandReplyResult> {
  const { target } = input;
  const lineId = randomUUID();
  const postLine = deps.postLine ?? postMissionLineEvent;
  const control = deps.control ?? requestRemotePtyControl;
  const correctIdentityMissing = input.kind === 'correct'
    && (!input.runId || !target.runId || !target.ptyId || input.actor !== 'agent');
  const runMismatch = input.kind === 'correct' && !correctIdentityMissing && input.runId !== target.runId;
  const state = correctIdentityMissing ? 'correct 미적용(ptyId/runId 없음 또는 actor!=agent)'
    : runMismatch ? 'correct 미적용(child runId 불일치)' : undefined;
  let ingressState: string | undefined;
  try {
    const recorded = await postLine({
      lineId, missionId: target.missionId, attemptId: target.attemptId, agent: target.agent,
      ...(input.runId ? { runId: input.runId } : {}), ...(target.ptyId ? { ptyId: target.ptyId } : {}),
      replyTo: input.replyTo,
      type: input.kind, source: 'parent-hand-reply', text: input.text,
      ...(state ? { state } : {}),
      ...(input.kind === 'correct' ? {
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.stop !== undefined ? { stop: input.stop } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
      } : {}),
    }, { env: {
      ELANOUS_HAND_TOKEN: target.token,
      ELANOUS_HAND_ATTEMPT_ID: target.attemptId,
      ELANOUS_NEXUS_URL: target.nexusUrl,
    } });
    ingressState = recorded.state;
  } catch (error) {
    return { ok: false, recorded: false, delivered: false, reason: error instanceof Error ? error.message : String(error), lineId };
  }
  if (input.kind === 'correct' && ingressState?.startsWith('correct 미적용')) {
    return { ok: false, recorded: true, delivered: false, reason: ingressState, lineId };
  }
  if (state) return { ok: false, recorded: true, delivered: false, reason: state, lineId };
  // Answers are delivered asynchronously through the mission ledger: the
  // matching ask waiter consumes kind=answer + replyTo. They do not need PTY
  // identity and this call cannot claim that a waiter has already consumed it.
  if (input.kind === 'answer') return { ok: true, recorded: true, delivered: false, delivery: 'ask-ledger', lineId };
  if (!target.ptyId || !target.runId || input.runId !== target.runId || input.actor !== 'agent') {
    return { ok: false, recorded: true, delivered: false, reason: 'ptyId/runId 없음 또는 불일치', lineId };
  }
  const label = '[Elanous correction]';
  const safeText = sanitizeForPtyInput(input.text, 4_000);
  if (!safeText) return { ok: false, recorded: true, delivered: false, reason: 'reply text empty after PTY sanitization', lineId };
  const result = await control(target.ptyId, 'input-text', { chars: `${label} ${safeText}\r` }, {
    actor: 'agent', requesterRunId: target.runId, timeoutMs: 2_000,
  });
  if (result.status !== 'success') return { ok: false, recorded: true, delivered: false, reason: `PTY arbiter ${result.status}`, lineId };
  return { ok: true, recorded: true, delivered: true, delivery: 'pty-arbiter', lineId };
}
