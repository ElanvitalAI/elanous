// ── 약속 원장 시험 — 등재·명시 전이·종단 충돌·깨우개 묶기·이벤트·영속·I2 이음매 (ELN-COMMITMENT-LEDGER · I1) ──
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMITMENT_CLOSED_EVENT, COMMITMENT_LEDGER_ENV, COMMITMENT_LOG_CATEGORY, COMMITMENT_RECORDED_EVENT, COMMITMENT_STATE_EVENT,
  COMMITMENT_WAKER_ATTACHED_EVENT, CommitmentLedger, CommitmentLifecycleConflict, isCommitmentLedgerRecordingEnabled,
  recordReplyCommitments,
} from './commitment-ledger.js';
import { TURN_OUTCOME_MISMATCH_EVENT } from './turn-outcome-shadow.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'commitment-ledger-'));
  roots.push(root);
  const events: { category: string; event: string; data: Record<string, unknown> }[] = [];
  let tick = 0;
  let seq = 0;
  const base = Date.parse('2026-11-17T08:00:00.000Z');
  const deps = {
    root,
    now: () => new Date(base + (tick++) * 1000),
    newId: () => `c-${++seq}`,
    emit: (category: string, event: string, data: Record<string, unknown>) => { events.push({ category, event, data }); },
  };
  return { root, events, deps, ledger: new CommitmentLedger(deps) };
}

const ADD = { seat: 'tc', sessionId: 's1', text: '#38049 착지 확인 후 보고', evidence: '다음 스텝: #38049 착지 확인 후 보고.' };

describe('commitment-ledger · 등재', () => {
  test('add = open 항목 ⊕ commitment.recorded · 자리 이름은 대문자로', () => {
    const { ledger, events } = harness();
    const { entry, created } = ledger.add(ADD);
    expect(created).toBe(true);
    expect(entry).toMatchObject({ id: 'c-1', layer: 'commitment', seat: 'TC', sessionId: 's1', status: 'open', wakers: [] });
    expect(events.map(e => [e.category, e.event])).toEqual([[COMMITMENT_LOG_CATEGORY, COMMITMENT_RECORDED_EVENT]]);
    expect(ledger.listOpen('TC').map(e => e.id)).toEqual(['c-1']);
  });

  test('같은 세션 같은 내용의 열린 항목은 다시 만들지 않는다(이벤트 0)', () => {
    const { ledger, events } = harness();
    ledger.add(ADD);
    const again = ledger.add({ ...ADD, text: `${ADD.text}.` });
    expect(again.created).toBe(false);
    expect(again.entry.id).toBe('c-1');
    expect(events).toHaveLength(1);
  });

  test('다른 세션이면 따로 · listOpen 세션 거르기', () => {
    const { ledger } = harness();
    ledger.add(ADD);
    ledger.add({ ...ADD, sessionId: 's2' });
    expect(ledger.listOpen('TC')).toHaveLength(2);
    expect(ledger.listOpen('TC', { sessionId: 's2' }).map(e => e.sessionId)).toEqual(['s2']);
  });

  test('빈 내용·빈 근거는 거부', () => {
    const { ledger } = harness();
    expect(() => ledger.add({ ...ADD, text: ' ' })).toThrow();
    expect(() => ledger.add({ ...ADD, evidence: '' })).toThrow();
  });

  test('영속 — 새 인스턴스가 같은 파일을 읽는다(자리 재기동)', () => {
    const { ledger, deps } = harness();
    ledger.add(ADD);
    expect(new CommitmentLedger(deps).listOpen('TC').map(e => e.text)).toEqual([ADD.text]);
  });
});

describe('commitment-ledger · 명시 전이만', () => {
  test('done 은 근거 필수 · commitment.closed', () => {
    const { ledger, events } = harness();
    const { entry } = ledger.add(ADD);
    expect(() => ledger.markDone('TC', entry.id, ' ')).toThrow();
    const done = ledger.markDone('TC', entry.id, 'pregate receipt node-b GATES_PASS');
    expect(done).toMatchObject({ status: 'done', doneEvidence: 'pregate receipt node-b GATES_PASS' });
    expect(events.at(-1)).toMatchObject({ event: COMMITMENT_CLOSED_EVENT, data: { from: 'open', to: 'done' } });
    expect(ledger.listOpen('TC')).toEqual([]);
  });

  test('dropped 는 사유 필수 · 종단 뒤 조작은 충돌(아무것도 안 바뀜)', () => {
    const { ledger } = harness();
    const { entry } = ledger.add(ADD);
    expect(() => ledger.markDropped('TC', entry.id, '')).toThrow();
    ledger.markDropped('TC', entry.id, 'OP 가 칸을 닫음');
    expect(() => ledger.markDone('TC', entry.id, 'x')).toThrow(CommitmentLifecycleConflict);
    expect(() => ledger.markBlocked('TC', entry.id, 'x')).toThrow(CommitmentLifecycleConflict);
    expect(ledger.get('TC', entry.id)!.status).toBe('dropped');
  });

  test('blocked → reopen → done · blocked 는 commitment.state · listOpen 에서 빠짐', () => {
    const { ledger, events } = harness();
    const { entry } = ledger.add(ADD);
    ledger.markBlocked('TC', entry.id, 'CROWN 승인 필요 · 오늘 18:00 까지');
    expect(events.at(-1)).toMatchObject({ event: COMMITMENT_STATE_EVENT, data: { from: 'open', to: 'blocked' } });
    expect(ledger.listOpen('TC')).toEqual([]);
    expect(ledger.list('TC', { status: 'blocked' })).toHaveLength(1);
    ledger.reopen('TC', entry.id);
    expect(() => ledger.reopen('TC', entry.id)).toThrow(CommitmentLifecycleConflict);
    expect(ledger.markDone('TC', entry.id, 'receipt').status).toBe('done');
  });

  test('없는 항목 조작 = 충돌', () => {
    const { ledger } = harness();
    expect(() => ledger.markDone('TC', 'c-missing', 'x')).toThrow(CommitmentLifecycleConflict);
  });

  test('종단 뒤 같은 내용 add 는 새 항목(닫힌 약속을 되살리지 않는다)', () => {
    const { ledger } = harness();
    const first = ledger.add(ADD).entry;
    ledger.markDone('TC', first.id, 'receipt');
    const second = ledger.add(ADD);
    expect(second.created).toBe(true);
    expect(second.entry.id).not.toBe(first.id);
  });
});

describe('commitment-ledger · 깨우개 묶기', () => {
  test('attachWaker = 참조 추가 · 같은 wakerId 멱등 · 이벤트 1회', () => {
    const { ledger, events } = harness();
    const { entry } = ledger.add(ADD);
    ledger.attachWaker('TC', entry.id, { wakerId: 'w-1', condition: 'pr-merged:38049' });
    const again = ledger.attachWaker('TC', entry.id, { wakerId: 'w-1', condition: 'pr-merged:38049' });
    expect(again.wakers.map(w => w.wakerId)).toEqual(['w-1']);
    expect(events.filter(e => e.event === COMMITMENT_WAKER_ATTACHED_EVENT)).toHaveLength(1);
  });

  test('종단 항목엔 못 묶는다', () => {
    const { ledger } = harness();
    const { entry } = ledger.add(ADD);
    ledger.markDone('TC', entry.id, 'receipt');
    expect(() => ledger.attachWaker('TC', entry.id, { wakerId: 'w-1', condition: 'time:30m' })).toThrow(CommitmentLifecycleConflict);
  });
});

describe('commitment-ledger · I2 이음매 recordReplyCommitments', () => {
  const REPLY = '#38013 리뷰 반영을 끝냈습니다.\n다음 스텝: #38049 착지 확인 후 보고.\n이대로 갈까요?';

  test('기본 꺼짐 — 아무것도 안 쓴다', () => {
    const { ledger, events } = harness();
    const result = recordReplyCommitments({ seat: 'TC', sessionId: 's1', finalText: REPLY }, { ledger, env: {} });
    expect(result).toEqual({ enabled: false, recorded: [], existing: [] });
    expect(ledger.list('TC')).toEqual([]);
    expect(events).toEqual([]);
  });

  test('v2 — env 로 켜도 원장에 쓰지 않는다 · 계획 상태와 비교만(그림자)', () => {
    const { ledger, events } = harness();
    const env = { [COMMITMENT_LEDGER_ENV]: 'record' };
    expect(isCommitmentLedgerRecordingEnabled(env)).toBe(true);
    expect(isCommitmentLedgerRecordingEnabled({ [COMMITMENT_LEDGER_ENV]: 'shadow' })).toBe(true);
    const emitted: { event: string; data: Record<string, unknown> }[] = [];
    const emit = (_c: string, event: string, data: Record<string, unknown>) => { emitted.push({ event, data }); };
    // 계획엔 할 일이 없는데(전부 done) 답엔 «다음 스텝» — spurious.
    const result = recordReplyCommitments(
      { seat: 'tc', sessionId: 's1', turnId: 't-7', finalText: REPLY, plan: { items: [{ id: 'p1', status: 'done' }] } },
      { ledger, env, emit },
    );
    expect(result).toEqual({ enabled: true, mode: 'shadow', verdict: 'spurious', recorded: [], existing: [] });
    expect(ledger.list('TC')).toEqual([]);
    expect(events).toEqual([]);
    expect(emitted).toEqual([{ event: TURN_OUTCOME_MISMATCH_EVENT, data: { kind: 'spurious', seat: 'TC', turnId: 't-7', pattern: 'declared-next-step', extracted: 1, open: 0 } }]);
    // 계획 상태가 없으면 비교 기준이 없다 — 이벤트 0.
    const none = recordReplyCommitments({ seat: 'TC', sessionId: 's1', finalText: REPLY }, { ledger, env, emit });
    expect(none.verdict).toBe('no-structure');
    expect(emitted.length).toBe(1);
  });

  test('꺼짐 값들', () => {
    for (const v of ['', 'off', '0', 'false']) expect(isCommitmentLedgerRecordingEnabled({ [COMMITMENT_LEDGER_ENV]: v })).toBe(false);
  });
});
