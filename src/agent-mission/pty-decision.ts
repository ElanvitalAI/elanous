import { debug } from '../debug/log.js';

type Identity = {
  ts: string;
  missionId: string;
  seq: number;
  sessionId: string;
  terminalId: string;
  agent: string;
  text: string;
};
type Detail = { keys?: string; row?: number };

export type PtyDecision = Identity & (
  | { step: 'read' | 'judge' | 'input'; detail?: Detail }
  | { step: 'answer'; detail: Detail & { question: string; answer: string } }
  | { step: 'recover'; detail: Detail & { blocked: string; action: string } }
  | { step: 'done'; detail: Detail & { result: { kind: 'pr' | 'file' | 'text'; ref: string } } }
);

export type DecisionInput = Omit<Identity, 'ts' | 'seq'> & (
  | { step: 'read' | 'judge' | 'input'; detail?: Detail }
  | { step: 'answer'; detail: Detail & { question: string; answer: string } }
  | { step: 'recover'; detail: Detail & { blocked: string; action: string } }
  | { step: 'done'; detail: Detail & { result: { kind: 'pr' | 'file' | 'text'; ref: string } } }
);

const missionStreams = new Map<string, { alias: string; seq: number }>();
export const PTY_DECISION_TEXT_MAX = 240;

function safe(value: string): string {
  const masked = value
    .replace(/\bBearer\s+(?:"[^"]*"|'[^']*'|[^\s"'<>]+)/gi, 'Bearer [redacted]')
    .replace(/\b([a-z0-9_]*(?:token|key(?:[_-]?id)?|secret|password|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"'<>]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk-[a-z0-9_-]+|gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|AIza[a-z0-9_-]+|xox[baprs]-[a-z0-9-]+)\b/gi, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .trim();
  const clipped = masked.slice(0, PTY_DECISION_TEXT_MAX);
  return clipped.replace(/[\uD800-\uDBFF]$/, '') || '[redacted]';
}

/** The only emission point for the inside-PTY decision stream. Never log unsanitized input. */
export function emitPtyDecision(input: DecisionInput, log: typeof debug.log = debug.log): PtyDecision {
  let stream = missionStreams.get(input.missionId);
  if (!stream) {
    stream = { alias: `mission-${missionStreams.size + 1}`, seq: -1 };
    missionStreams.set(input.missionId, stream);
  }
  stream.seq += 1;
  const base = {
    ts: new Date().toISOString(),
    missionId: stream.alias,
    seq: stream.seq,
    sessionId: safe(input.sessionId),
    terminalId: safe(input.terminalId),
    agent: safe(input.agent),
    text: safe(input.text),
  };
  const common = input.detail ? {
    ...(input.detail.keys !== undefined ? { keys: safe(input.detail.keys) } : {}),
    ...(input.detail.row !== undefined ? { row: input.detail.row } : {}),
  } : {};
  let decision: PtyDecision;
  if (input.step === 'answer') decision = { ...base, step: input.step, detail: { ...common, question: safe(input.detail.question), answer: safe(input.detail.answer) } };
  else if (input.step === 'recover') decision = { ...base, step: input.step, detail: { ...common, blocked: safe(input.detail.blocked), action: safe(input.detail.action) } };
  else if (input.step === 'done') decision = { ...base, step: input.step, detail: { ...common, result: { kind: input.detail.result.kind, ref: safe(input.detail.result.ref) } } };
  else decision = { ...base, step: input.step, ...(input.detail ? { detail: common } : {}) };
  log('pty.decision', decision.step, decision);
  return decision;
}
