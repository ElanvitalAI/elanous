import type { LLMToolSpec } from '../llm.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { debug } from '../debug/log.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { buildSeatsBoard, todayKst, type SeatsSources } from '../nexus/api/ops-seats.js';
import { liveSeatsSources } from '../nexus/api/ops-seats-sources.js';

export const OPS_SEATS_SPEC: LLMToolSpec = {
  name: 'ops_seats',
  description: '오너 전용 읽기 — 지금 자리(OP·TC·MK·UX)별 진행(now), 오늘 착지(landed), 빨강(red), 미결 결정 수를 원장에서 확인한다. null은 못 읽은 원천이며 0이나 빈 목록이 아니다.',
  parameters: { type: 'object', properties: { date: { type: 'string', description: '조회할 KST 날짜 YYYY-MM-DD. 생략하면 KST 오늘.' } }, required: [] },
};

export const DECISIONS_PENDING_SPEC: LLMToolSpec = {
  name: 'decisions_pending',
  description: '오너 전용 읽기 — 결정 원장의 열린 결정을 기한 순으로 조회한다. 결정 선택·기록은 하지 않는다.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export interface OpsFactsDeps {
  seatsSources?: () => SeatsSources;
  listDecisions?: (filters: { status: 'open' }) => DecisionEntry[];
  today?: () => string;
}

function ownerVerified(context?: ToolRuntimeContext): boolean {
  return context?.requestOrigin !== 'external-agent' && !!context?.sessionId && !!context?.verifiedOwner?.id.trim();
}

function logCall(tool: 'ops_seats' | 'decisions_pending', ok: boolean, nulls: number): void {
  debug.log('ops.facts', 'call', { tool, ok, nulls });
}

/** Unreadable seat sources remain null; only rename the board's `blocked` field to `red` for this tool. */
export async function dispatchOpsSeats(args: Record<string, unknown>, context?: ToolRuntimeContext, deps: OpsFactsDeps = {}) {
  if (!ownerVerified(context)) {
    logCall('ops_seats', false, 0);
    return { error: '오너 확인이 필요한 조회다' };
  }
  const date = args.date === undefined ? (deps.today ?? todayKst)() : args.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    logCall('ops_seats', false, 0);
    return { error: 'KST 날짜는 YYYY-MM-DD 여야 한다' };
  }
  try {
    const board = await buildSeatsBoard(date, (deps.seatsSources ?? liveSeatsSources)());
    const seats = board.seats.map(({ seat, role, now, landed, blocked, pendingDecisions }) =>
      ({ seat, role, now, landed, red: blocked, pendingDecisions }));
    const nulls = seats.reduce((n, row) => n + [row.now, row.landed, row.red, row.pendingDecisions].filter(v => v === null).length, 0);
    logCall('ops_seats', true, nulls);
    return { note: 'null = 못 읽음(없다가 아님); now는 오늘 기록이 없어도 null일 수 있다.', date: board.date, seats };
  } catch {
    logCall('ops_seats', false, 1);
    return { error: '자리 현황을 읽지 못했다', seats: null };
  }
}

/** Only the five requested fields leave the decision ledger. Undated entries follow dated entries. */
export function dispatchDecisionsPending(context?: ToolRuntimeContext, deps: OpsFactsDeps = {}) {
  if (!ownerVerified(context)) {
    logCall('decisions_pending', false, 0);
    return { error: '오너 확인이 필요한 조회다' };
  }
  try {
    const entries = (deps.listDecisions ?? ((filters) => new DecisionLedger().list(filters)))({ status: 'open' });
    const items = entries.filter(e => e.status === 'open')
      .sort((a, b) => (a.dueAt ?? '\uffff').localeCompare(b.dueAt ?? '\uffff') || a.id.localeCompare(b.id))
      .map(({ id, title, category, dueAt, raisedBy }) => ({ id, title, category, dueAt: dueAt ?? null, raisedBy: { track: raisedBy.track ?? null } }));
    logCall('decisions_pending', true, items.reduce((n, item) => n + Number(item.dueAt === null) + Number(item.raisedBy.track === null), 0));
    return { items };
  } catch {
    logCall('decisions_pending', false, 1);
    return { error: '결정 원장을 읽지 못했다', items: null };
  }
}
