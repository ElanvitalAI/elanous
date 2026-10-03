type Detail = { keys?: string; row?: number };
export type PtyDecision = {
  ts: string;
  missionId: string;
  seq: number;
  sessionId: string;
  terminalId: string;
  agent: string;
  text: string;
} & (
  | { step: 'read' | 'judge' | 'input'; detail?: Detail }
  | { step: 'answer'; detail: Detail & { question: string; answer: string } }
  | { step: 'recover'; detail: Detail & { blocked: string; action: string } }
  | { step: 'done'; detail: Detail & { result: { kind: 'pr' | 'file' | 'text'; ref: string } } }
);

export interface DecisionsState {
  currentMissionId: string | null;
  missions: Record<string, PtyDecision[]>;
}

export const EMPTY_DECISIONS: DecisionsState = { currentMissionId: null, missions: {} };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function parseDecision(json: unknown): PtyDecision | null {
  if (!record(json)) return null;
  const { ts, missionId, seq, sessionId, terminalId, agent, step, text, detail } = json;
  if (!nonempty(ts) || !Number.isFinite(Date.parse(ts)) || !nonempty(missionId)
    || !Number.isSafeInteger(seq) || (seq as number) < 0 || !nonempty(sessionId)
    || !nonempty(terminalId) || !nonempty(agent) || !nonempty(text)
    || (detail !== undefined && !record(detail))) return null;
  if (record(detail) && ((detail.keys !== undefined && typeof detail.keys !== 'string')
    || (detail.row !== undefined && (!Number.isSafeInteger(detail.row) || (detail.row as number) < 0)))) return null;
  const base = { ts, missionId, seq: seq as number, sessionId, terminalId, agent, text };
  const extra = record(detail) ? {
    ...(detail.keys !== undefined ? { keys: detail.keys as string } : {}),
    ...(detail.row !== undefined ? { row: detail.row as number } : {}),
  } : {};
  if (step === 'answer') {
    if (!record(detail) || !nonempty(detail.question) || !nonempty(detail.answer)) return null;
    return { ...base, step, detail: { ...extra, question: detail.question, answer: detail.answer } };
  }
  if (step === 'recover') {
    if (!record(detail) || !nonempty(detail.blocked) || !nonempty(detail.action)) return null;
    return { ...base, step, detail: { ...extra, blocked: detail.blocked, action: detail.action } };
  }
  if (step === 'done') {
    if (!record(detail) || !record(detail.result) || !nonempty(detail.result.ref)
      || (detail.result.kind !== 'pr' && detail.result.kind !== 'file' && detail.result.kind !== 'text')) return null;
    return { ...base, step, detail: { ...extra, result: { kind: detail.result.kind, ref: detail.result.ref } } };
  }
  if (step === 'read' || step === 'judge' || step === 'input') {
    return { ...base, step, ...(detail !== undefined ? { detail: extra } : {}) };
  }
  return null;
}

export function reduceDecisions(state: DecisionsState, ev: PtyDecision): DecisionsState {
  const previous = Object.hasOwn(state.missions, ev.missionId) ? state.missions[ev.missionId] : [];
  if (previous.some((entry) => entry.seq === ev.seq)) return state;
  const next = [...previous, ev].sort((a, b) => a.seq - b.seq);
  const missions = { ...state.missions, [ev.missionId]: next };
  const current = state.currentMissionId ? missions[state.currentMissionId] : undefined;
  const latest = next.at(-1)!;
  const latestCurrent = current?.at(-1);
  const currentMissionId = !latestCurrent || Date.parse(latest.ts) > Date.parse(latestCurrent.ts)
    ? ev.missionId : state.currentMissionId;
  return { missions, currentMissionId };
}
