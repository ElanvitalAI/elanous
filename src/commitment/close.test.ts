// ── 약속 닫기 시험 — 도구로 닫기 · 깨우개 거둠 · blocked 근거 · 실패 경로(읽기·쓰기·없는 id·이중·동시) · 도구 찾기 (COMMITMENT-CLOSE) ──
// 기대값은 리터럴이다(제품 상수·렌더 함수로 만들지 않는다).
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchToolSearch } from '../skills/tools/tool-search.js';
import { armWaker, formatExpiredNotice, formatFiredNotice, listWakers, tickWakers, type SelfTimerDeps } from '../msg/self-timer-watch.js';
import { buildCommitmentCloseTool, closeCommitment, dispatchCommitmentClose } from './close.js';
import { CommitmentLedger, CommitmentLifecycleConflict, CommitmentLockTimeout } from './ledger.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) { try { chmodSync(r, 0o700); } catch { /* gone */ } rmSync(r, { recursive: true, force: true }); }
});

function harness(lockWaitMs?: number) {
  const root = mkdtempSync(join(tmpdir(), 'commitment-close-'));
  roots.push(root);
  let nowMs = Date.parse('2026-11-25T03:00:00.000Z');
  let cid = 0;
  let wid = 0;
  const now = () => new Date(nowMs);
  const events: string[] = [];
  const emit = (_c: string, event: string) => { events.push(event); };
  const ledgerRoot = join(root, 'ledger');
  const ledger = new CommitmentLedger({ root: ledgerRoot, now, emit, newId: () => `c-${++cid}`, ...(lockWaitMs === undefined ? {} : { lockWaitMs }) });
  const notices: string[] = [];
  const timer: SelfTimerDeps = {
    root: join(ledgerRoot, 'wakers'), ledger, now, emit, newId: () => `w-${++wid}`,
    probes: { prMerged: async () => true, reviewArrived: async () => false, mailReplied: async () => true, fileExists: async () => false },
    postNotice: async (_seat, body) => { notices.push(body); return notices.length; },
    isPidAlive: () => false,
  };
  const entry = ledger.add({ seat: 'REVIEW-1', sessionId: 'msg:160639', text: 'Follow up on message #160639 to JUD', evidence: 'MsgPost #160639' }).entry;
  armWaker({ seat: 'REVIEW-1', commitmentId: entry.id, condition: 'pr-merged:40050', withinMs: 30 * 60_000 }, timer);
  return { root, ledgerRoot, ledger, timer, entry, notices, events, advance: (ms: number) => { nowMs += ms; } };
}

describe('CommitmentClose — 도구로 닫기', () => {
  test('done = 근거 저장 ⊕ armed 깨우개 cancelled ⊕ 이후 틱은 notice 0', async () => {
    const h = harness();
    const result = dispatchCommitmentClose({ id: 'c-1', status: 'done', evidence: 'PR #40050 merged, receipt pregate-40050.json' }, { ledger: h.ledger, timer: h.timer });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('Commitment c-1 (REVIEW-1) → done · wakers cancelled: w-1');
    expect(h.ledger.get('REVIEW-1', 'c-1')?.status).toBe('done');
    expect(h.ledger.get('REVIEW-1', 'c-1')?.doneEvidence).toBe('PR #40050 merged, receipt pregate-40050.json');
    const wakers = listWakers('REVIEW-1', h.timer);
    expect(wakers.map(w => [w.id, w.status, w.cancelReason])).toEqual([['w-1', 'cancelled', 'commitment done']]);
    expect(h.events).toContain('self-timer.cancelled');
    const ticks = await tickWakers('REVIEW-1', h.timer);
    expect(ticks).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  test('blocked = 근거가 reason 으로 남는다 ⊕ 깨우개 cancelled', () => {
    const h = harness();
    const { entry, cancelledWakers } = closeCommitment({ id: 'c-1', status: 'blocked', evidence: 'JUD has not answered; asked OP in #160700' }, { ledger: h.ledger, timer: h.timer });
    expect(entry.status).toBe('blocked');
    expect(entry.reason).toBe('JUD has not answered; asked OP in #160700');
    expect(h.ledger.get('REVIEW-1', 'c-1')?.reason).toBe('JUD has not answered; asked OP in #160700');
    expect(cancelledWakers.map(w => w.id)).toEqual(['w-1']);
    expect(listWakers('REVIEW-1', h.timer)[0]?.status).toBe('cancelled');
  });

  test('자리를 주면 그 자리에서 · 안 주면 id 로 찾는다', () => {
    const h = harness();
    expect(dispatchCommitmentClose({ id: 'c-1', status: 'done', evidence: 'ok', seat: 'review-1' }, { ledger: h.ledger, timer: h.timer }).seat).toBe('REVIEW-1');
  });

  test('근거 없음·여러 줄·틀린 상태는 거부 · 원장 그대로', () => {
    const h = harness();
    expect(dispatchCommitmentClose({ id: 'c-1', status: 'done', evidence: '  ' }, { ledger: h.ledger, timer: h.timer }).output)
      .toBe('CommitmentClose failed: evidence is required: one line (test result, receipt path, PR, or what blocks it)');
    expect(dispatchCommitmentClose({ id: 'c-1', status: 'done', evidence: 'a\nb' }, { ledger: h.ledger, timer: h.timer }).output)
      .toBe('CommitmentClose failed: evidence must be one line');
    expect(dispatchCommitmentClose({ id: 'c-1', status: 'dropped', evidence: 'x' }, { ledger: h.ledger, timer: h.timer }).ok).toBe(false);
    expect(h.ledger.get('REVIEW-1', 'c-1')?.status).toBe('open');
    expect(listWakers('REVIEW-1', h.timer)[0]?.status).toBe('armed');
  });
});

describe('CommitmentClose — 실패 경로', () => {
  test('없는 id = 충돌 오류 · 아무것도 안 바뀐다', () => {
    const h = harness();
    expect(() => closeCommitment({ id: 'c-404', status: 'done', evidence: 'x' }, { ledger: h.ledger, timer: h.timer })).toThrow(CommitmentLifecycleConflict);
    expect(dispatchCommitmentClose({ id: 'c-404', status: 'done', evidence: 'x' }, { ledger: h.ledger, timer: h.timer }).output)
      .toBe('CommitmentClose failed: commitment not found: c-404 (list open ones: eln commitment list)');
    expect(listWakers('REVIEW-1', h.timer)[0]?.status).toBe('armed');
  });

  test('이중 닫기 = 두 번째는 충돌 · 첫 근거 유지', () => {
    const h = harness();
    closeCommitment({ id: 'c-1', status: 'done', evidence: 'first' }, { ledger: h.ledger, timer: h.timer });
    expect(() => closeCommitment({ id: 'c-1', status: 'done', evidence: 'second' }, { ledger: h.ledger, timer: h.timer })).toThrow('commitment c-1 is done (terminal) — cannot move to done');
    expect(() => closeCommitment({ id: 'c-1', status: 'blocked', evidence: 'late' }, { ledger: h.ledger, timer: h.timer })).toThrow(CommitmentLifecycleConflict);
    expect(h.ledger.get('REVIEW-1', 'c-1')?.doneEvidence).toBe('first');
  });

  test('blocked 뒤 done 은 된다(막힘 풀림) · blocked 두 번은 충돌', () => {
    const h = harness();
    closeCommitment({ id: 'c-1', status: 'blocked', evidence: 'waiting on JUD' }, { ledger: h.ledger, timer: h.timer });
    expect(() => closeCommitment({ id: 'c-1', status: 'blocked', evidence: 'again' }, { ledger: h.ledger, timer: h.timer })).toThrow('commitment c-1 is already blocked');
    expect(closeCommitment({ id: 'c-1', status: 'done', evidence: 'JUD answered #160710' }, { ledger: h.ledger, timer: h.timer }).entry.status).toBe('done');
  });

  test('읽기 실패(깨진 원장) = 오류 · 파일 그대로', () => {
    const h = harness();
    const path = join(h.ledgerRoot, 'REVIEW-1.json');
    writeFileSync(path, '{ broken');
    expect(() => closeCommitment({ id: 'c-1', status: 'done', evidence: 'x', seat: 'REVIEW-1' }, { ledger: h.ledger, timer: h.timer })).toThrow();
    expect(() => closeCommitment({ id: 'c-1', status: 'done', evidence: 'x' }, { ledger: h.ledger, timer: h.timer })).toThrow('unreadable: REVIEW-1');
    expect(readFileSync(path, 'utf8')).toBe('{ broken');
  });

  test('쓰기 실패(원장 디렉터리 쓰기 금지) = 오류 · 상태 open 그대로', () => {
    if (process.getuid?.() === 0) return; // root 는 권한을 무시한다
    const h = harness();
    chmodSync(h.ledgerRoot, 0o500);
    try {
      expect(() => closeCommitment({ id: 'c-1', status: 'done', evidence: 'x' }, { ledger: h.ledger, timer: h.timer })).toThrow();
    } finally { chmodSync(h.ledgerRoot, 0o700); }
    expect(h.ledger.get('REVIEW-1', 'c-1')?.status).toBe('open');
  });

  test('동시 닫기 = 잡힌 잠금이면 시간 초과로 거부 · 바꾸지 않는다', () => {
    const h = harness(50);
    const lock = join(h.ledgerRoot, 'REVIEW-1.json.lock');
    writeFileSync(lock, '');
    expect(() => closeCommitment({ id: 'c-1', status: 'done', evidence: 'x' }, { ledger: h.ledger, timer: h.timer })).toThrow(CommitmentLockTimeout);
    expect(h.ledger.get('REVIEW-1', 'c-1')?.status).toBe('open');
  });

  test('동시 닫기 = 죽은 보유자의 오래된 잠금은 걷고 닫는다 · 잠금 파일 남지 않음', () => {
    const h = harness(50);
    const lock = join(h.ledgerRoot, 'REVIEW-1.json.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(closeCommitment({ id: 'c-1', status: 'done', evidence: 'x' }, { ledger: h.ledger, timer: h.timer }).entry.status).toBe('done');
    expect(() => readFileSync(lock)).toThrow();
  });

  test('동시 닫기 = 같은 원장을 보는 두 원장 객체 · 하나만 이긴다', () => {
    const h = harness();
    const other = new CommitmentLedger({ root: h.ledgerRoot, emit: () => {} });
    closeCommitment({ id: 'c-1', status: 'done', evidence: 'winner' }, { ledger: h.ledger, timer: h.timer });
    expect(() => closeCommitment({ id: 'c-1', status: 'done', evidence: 'loser' }, { ledger: other, timer: h.timer })).toThrow(CommitmentLifecycleConflict);
    expect(other.get('REVIEW-1', 'c-1')?.doneEvidence).toBe('winner');
  });
});

describe('깨우개 notice = 실제 닫는 문 이름', () => {
  test('발화·만료 글이 CommitmentClose 와 eln commitment 를 적는다', () => {
    const h = harness();
    const waker = listWakers('REVIEW-1', h.timer)[0]!;
    const fired = formatFiredNotice(waker, h.entry);
    expect(fired).toContain('조건이 찼다, 이 약속을 이어서 한다');
    expect(fired).toContain('닫기: CommitmentClose(id=c-1, status=done, evidence=<근거 한 줄>) 또는 eln commitment done c-1 --evidence "<근거>"');
    expect(fired).toContain('eln commitment blocked c-1 --evidence "<사유>"');
    expect(fired).not.toContain('원장 done');
    expect(formatExpiredNotice(waker, h.entry)).toContain('eln commitment blocked c-1 --evidence "<사유>"');
  });

  test('닫기 전에 발화하면 그 notice 에 닫는 문이 실린다', async () => {
    const h = harness();
    await tickWakers('REVIEW-1', h.timer);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('CommitmentClose(id=c-1, status=done');
  });

  test('닫기와 재기 사이 경합 — 원장이 이미 done 이면 notice 없이 거둔다', async () => {
    const h = harness();
    h.ledger.markDone('REVIEW-1', 'c-1', 'closed directly');
    const ticks = await tickWakers('REVIEW-1', h.timer);
    expect(ticks.map(t => [t.outcome, t.waker.status])).toEqual([['closed', 'cancelled']]);
    expect(h.notices).toEqual([]);
  });
});

describe('도구 찾기 — 한국어·영어 낱말', () => {
  const otherSpecs = [
    { name: 'memory_save', description: 'Save a durable memory for this seat.', parameters: { type: 'object', properties: {} } },
    { name: 'autopilot_set', description: 'Turn session autopilot on or off and set its goal state.', parameters: { type: 'object', properties: {} } },
  ];
  const specs = [...otherSpecs, buildCommitmentCloseTool()];
  for (const query of ['commitment 약속 원장 상태 done', 'promise close', '약속 닫기', 'commitment blocked', '원장 done', 'close commitment']) {
    test(`«${query}» → CommitmentClose 가 첫째`, () => {
      expect(dispatchToolSearch({ query }, { specs }).matched[0]).toBe('CommitmentClose');
      expect(dispatchToolSearch({ query }, { specs, requireQueryCoverage: true }).matched[0]).toBe('CommitmentClose');
    });
  }
  test('select:CommitmentClose 가 스키마를 준다', () => {
    const result = dispatchToolSearch({ query: 'select:CommitmentClose' }, { specs });
    expect(result.matched).toEqual(['CommitmentClose']);
    expect(result.content).toContain('"required":["id","status","evidence"]');
  });
});
