// ── 약속 닫기 `commitment/close` (COMMITMENT-CLOSE · P0 · 2026-11-25) ──────────────────────────────────
//
// S: 깨우개 notice 는 «닫을 때는 근거와 함께 원장 done» 이라 말했지만 닫는 도구도 CLI 도 없었다.
// C: 11-25 REVIEW-1(#160639)·JUD(#160695)가 tool search 로 못 찾고(«commitment 약속 원장 상태 done» → memory_save·autopilot_set)
//    NEED HUMAN 을 올렸다.
// A: 닫기 한 함수 — 원장 전이(done 근거 · blocked 사유) ⊕ 그 약속의 armed 깨우개 cancelled. 문 둘이 같은 함수를 부른다:
//    seat tool `CommitmentClose` · `eln commitment done|blocked <id> --evidence "<한 줄>"`.
//
// 세 얼굴:
//   관측 = commitment.closed / commitment.state(원장) ⊕ self-timer.cancelled(깨우개)
//   판단 근거 = 항목의 doneEvidence(done) · reason(blocked) — 근거 한 줄 필수
//   수복과 인계 = 없는 id · 이중 닫기 · 잠금 시간 초과는 아무것도 바꾸지 않고 오류로 돌려준다(자리가 고쳐 다시 부른다)

import type { LLMToolSpec } from '../llm/tool-spec.js';
import { canonicalSeatId } from '../msg/msg-store.js';
import { cancelCommitmentWakers, type SelfTimerDeps, type WakerRecord } from '../msg/self-timer-watch.js';
import { CommitmentLedger, CommitmentLifecycleConflict, type CommitmentEntry } from './ledger.js';

export type CommitmentCloseStatus = 'done' | 'blocked';
export const COMMITMENT_CLOSE_STATUSES: readonly CommitmentCloseStatus[] = ['done', 'blocked'];
export const COMMITMENT_CLOSE_TOOL_NAME = 'CommitmentClose';

export interface CloseCommitmentInput {
  id: string;
  status: CommitmentCloseStatus;
  /** 한 줄 근거 — done 은 시험·영수증·PR 참조, blocked 는 무엇에 막혔나. */
  evidence: string;
  /** 자리를 알면 준다. 없으면 원장 디렉터리에서 id 로 찾는다. */
  seat?: string;
}

export interface CloseCommitmentDeps {
  ledger?: CommitmentLedger;
  timer?: SelfTimerDeps;
}

export interface CloseCommitmentResult {
  entry: CommitmentEntry;
  cancelledWakers: WakerRecord[];
}

/** 근거 검사 — 비지 않은 한 줄. 여러 줄은 거부(원장에는 요약 한 줄만 · 긴 글은 영수증 경로로). */
export function normalizeEvidence(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('evidence is required: one line (test result, receipt path, PR, or what blocks it)');
  const line = raw.trim();
  if (/[\r\n]/.test(line)) throw new Error('evidence must be one line');
  return line;
}

export function normalizeCloseStatus(raw: unknown): CommitmentCloseStatus {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'done' || v === 'blocked') return v;
  throw new Error(`status must be done or blocked (got ${JSON.stringify(raw)})`);
}

export function closeCommitment(input: CloseCommitmentInput, deps: CloseCommitmentDeps = {}): CloseCommitmentResult {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id) throw new Error('id is required (the commitment id from the waker notice, e.g. c-1a2b3c4d)');
  const status = normalizeCloseStatus(input.status);
  const evidence = normalizeEvidence(input.evidence);
  const ledger = deps.ledger ?? new CommitmentLedger();
  const seat = input.seat?.trim() ? canonicalSeatId(input.seat) : ledger.findSeat(id);
  if (!seat) throw new CommitmentLifecycleConflict(`commitment not found: ${id} (list open ones: eln commitment list)`);
  const entry = status === 'done' ? ledger.markDone(seat, id, evidence) : ledger.markBlocked(seat, id, evidence);
  const cancelledWakers = cancelCommitmentWakers(entry.seat, id, `commitment ${status}`, { ...deps.timer, ledger });
  return { entry, cancelledWakers };
}

// ── seat tool ───────────────────────────────────────────────────────────────────────

export function buildCommitmentCloseTool(): LLMToolSpec {
  return {
    name: COMMITMENT_CLOSE_TOOL_NAME,
    description:
      'Close a commitment (promise) in the commitment ledger — mark it done or blocked with one line of evidence, '
      + 'and cancel its follow-up waker. Use when a waker notice says a commitment should continue or be closed. '
      + 'CLI twin: `eln commitment done|blocked <id> --evidence "<line>"`. '
      + 'Keywords: commitment, promise, follow-up, waker, close, done, blocked, 약속, 원장, 닫기, 완료, 막힘.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Commitment id from the waker notice (e.g. c-1a2b3c4d).' },
        status: { type: 'string', enum: [...COMMITMENT_CLOSE_STATUSES], description: 'done = finished · blocked = cannot continue.' },
        evidence: { type: 'string', description: 'Required, one line: test result, receipt path or PR for done; what blocks it for blocked.' },
        seat: { type: 'string', description: 'Optional seat that owns the commitment; found by id when omitted.' },
      },
      required: ['id', 'status', 'evidence'],
      additionalProperties: false,
    },
  };
}

export interface CommitmentCloseToolResult extends Record<string, unknown> {
  output: string;
  ok: boolean;
  isError?: boolean;
  id?: string;
  seat?: string;
  status?: string;
  cancelledWakers?: string[];
}

export function dispatchCommitmentClose(args: Record<string, unknown>, deps: CloseCommitmentDeps = {}): CommitmentCloseToolResult {
  try {
    const { entry, cancelledWakers } = closeCommitment({
      id: typeof args.id === 'string' ? args.id : '',
      status: args.status as CommitmentCloseStatus,
      evidence: args.evidence as string,
      ...(typeof args.seat === 'string' ? { seat: args.seat } : {}),
    }, deps);
    const wakers = cancelledWakers.map(w => w.id);
    return {
      output: `Commitment ${entry.id} (${entry.seat}) → ${entry.status} · wakers cancelled: ${wakers.length === 0 ? 'none' : wakers.join(', ')}`,
      ok: true, id: entry.id, seat: entry.seat, status: entry.status, cancelledWakers: wakers,
    };
  } catch (error) {
    return { output: `CommitmentClose failed: ${error instanceof Error ? error.message : String(error)}`, ok: false, isError: true };
  }
}
