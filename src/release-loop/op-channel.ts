import type { Message, MsgStore } from '../msg/msg-store.js';
import type { ReleaseStageState } from './stage-mail.js';

export type ReleaseOpCommand =
  | { verb: 'status' }
  | { verb: 'why'; node: string }
  | { verb: 'hold' | 'resume' }
  | { verb: 'go' | 'no-go'; phase: string; reason: string }
  | { verb: 'prefer'; choice: string }
  | { verb: 'emergency'; reason: string };

export interface ReleaseOpState {
  held: boolean;
  phaseDecisions: Record<string, { decision: 'go' | 'no-go'; reason: string }>;
  preferences: string[];
  bufferedEvents: Array<{ runId: string; nodeId: string; state: ReleaseStageState; eventId: string }>;
  queriedNode?: string;
  emergencyReason?: string;
}

export interface ReleaseOpEvent {
  runId: string; nodeId: string; state: ReleaseStageState; held: boolean; eventId?: string;
}

const releaseStageStates = new Set<ReleaseStageState>(['start', 'ok', 'fail', 'skip', 'wait', 'stall']);

/** Parse durable held-stage mail without widening the validated state to string. */
export function parseReleaseOpBufferedEvent(body: string): ReleaseOpState['bufferedEvents'][number] {
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== 'object') throw new Error('invalid RLA held event');
  const event = value as Record<string, unknown>;
  if (typeof event.runId !== 'string' || !event.runId || typeof event.nodeId !== 'string' || !event.nodeId ||
      typeof event.eventId !== 'string' || !event.eventId || typeof event.state !== 'string' ||
      !releaseStageStates.has(event.state as ReleaseStageState)) {
    throw new Error('invalid RLA held event');
  }
  return { runId: event.runId, nodeId: event.nodeId, eventId: event.eventId,
    state: event.state as ReleaseStageState };
}

export function parseReleaseOpCommand(body: string): ReleaseOpCommand {
  const [verb, ...parts] = body.trim().split(/\s+/);
  const required = (label: string): string => {
    const value = parts.join(' ').trim();
    if (!value) throw new Error(`${verb} requires ${label}`);
    return value;
  };
  switch (verb) {
    case 'status': return { verb };
    case 'why': return { verb, node: required('<노드>') };
    case 'hold': case 'resume': return { verb };
    case 'go': case 'no-go': {
      const [phase, ...reason] = parts;
      if (!phase || !reason.join(' ').trim()) throw new Error(`${verb} requires <페이즈> <사유>`);
      return { verb, phase, reason: reason.join(' ').trim() };
    }
    case 'prefer': return { verb, choice: required('<선택지>') };
    case 'emergency': return { verb, reason: required('<사유>') };
    default: throw new Error('RLA command must be status, why, hold, resume, go, no-go, prefer, or emergency');
  }
}

export function emptyReleaseOpState(): ReleaseOpState {
  return { held: false, phaseDecisions: {}, preferences: [], bufferedEvents: [] };
}

export function applyReleaseOpCommand(state: ReleaseOpState, command: ReleaseOpCommand): ReleaseOpState {
  switch (command.verb) {
    case 'hold': return { ...state, held: true };
    case 'resume': return { ...state, held: false, bufferedEvents: [] };
    case 'go': case 'no-go': return { ...state, phaseDecisions: { ...state.phaseDecisions,
      [command.phase]: { decision: command.verb, reason: command.reason } } };
    case 'prefer': return { ...state, preferences: [...state.preferences, command.choice] };
    case 'why': return { ...state, queriedNode: command.node };
    case 'emergency': return { ...state, emergencyReason: command.reason };
    default: return state;
  }
}

export function recordReleaseOpEvent(store: MsgStore, event: ReleaseOpEvent): Message | undefined {
  const eventId = event.eventId ?? `${event.runId}:${event.nodeId}:${event.state}`;
  const key = Buffer.from(eventId).toString('base64url');
  if (event.held) return store.appendWithProvenance({ from: 'RLA', to: 'RLA', kind: 'rla-held-event',
    body: JSON.stringify({ runId: event.runId, nodeId: event.nodeId, state: event.state, eventId }) }, `rla-held-event:${key}:RLA`);
  return store.appendWithProvenance({ from: 'RLA', to: 'OP', kind: 'progress',
    body: `release event · run=${event.runId} · node=${event.nodeId} · state=${event.state}` }, `release-event:${key}:OP`);
}

export function postReleaseOpCommand(store: MsgStore, from: string, body: string): Message {
  if (from !== 'OP') throw new Error('only OP can send RLA commands');
  parseReleaseOpCommand(body);
  return store.post({ from, to: 'RLA', kind: 'rla-command', body: body.trim() });
}

export function postReleaseOpQuestion(store: MsgStore, from: string, body: string): Message {
  if (from !== 'OP') throw new Error('only OP can ask RLA questions');
  if (!body.trim()) throw new Error('RLA question must be nonempty');
  return store.post({ from, to: 'RLA', kind: 'rla-question', body: body.trim() });
}

/** Independently replay the durable OP command stream for the shadow decision at one node. */
export function shadowReleaseOpDecision(store: MsgStore, nodeId: string): 'go' | 'no-go' {
  let state = emptyReleaseOpState();
  let cursor = 0;
  let page = store.listByRecipient('RLA', cursor);
  while (page.length > 0) {
    for (const message of page) {
      if (message.from === 'OP' && message.kind === 'rla-command') {
        try { state = applyReleaseOpCommand(state, parseReleaseOpCommand(message.body)); }
        catch { /* invalid commands do not contribute to the shadow verdict */ }
      }
      cursor = message.id;
    }
    page = store.listByRecipient('RLA', cursor);
  }
  return state.phaseDecisions[nodeId]?.decision ?? 'go';
}
