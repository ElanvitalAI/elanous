// MEMORY-TRIAGE-NO-LLM 문 ① — 쓰기 문 핵심(판정·횟수·하루 상한·원장·사건). 저장소는 메모리 안 가짜 · 원장만 임시 폴더.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_NEAR_DUP_JACCARD, MEMORY_SEAT_DAILY_CAP, MemoryWriteRefusedError,
  applyMemoryWriteGate, estimateJaccard, fileDailyLedger, memoryRowRef, memoryTextHash, memoryWordsDiffer, minhashSignature,
  type JevMemoryJudgement, type MemoryGateInput, type MemoryGateOutcome, type MemoryGateRow, type MemoryTriageLog,
} from './write-gate.js';

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), `tc-mtg-${prefix}-`)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const META = { kind: '교정', scope: 'seat', sourceEventId: 'repl:s1/request-1', reason: 'r' } as const;
const NOW = new Date('2026-11-17T10:00:00Z');
const distinct = (i: number): string => createHash('sha256').update(`distinct-${i}`).digest('hex');
const BASE = 'PR head 를 보고하기 전에 반드시 pregate 영수증을 받아 두고, 영수증이 없으면 게이트 큐에 올리지 않는다';

type Ev = { event: string; data: Record<string, unknown> };

/** 메모리 안 저장소 — 문의 결과를 호출부(saveMemory·saveSeatMemory)처럼 적용한다. */
function memStore(ledgerRoot = temp('ledger')) {
  const rows: MemoryGateRow[] = [];
  const events: Ev[] = [];
  const log: MemoryTriageLog = (_c, event, data) => { events.push({ event, data }); };
  const ledger = fileDailyLedger(ledgerRoot);
  let next = 0;
  const write = (input: Omit<MemoryGateInput, 'store' | 'origin'> & { text: string }): MemoryGateOutcome & { id?: string } => {
    const outcome = applyMemoryWriteGate({ store: 'seat', origin: 'test', seat: 'TC', now: NOW, mode: 'on', ...input }, { rows: () => rows, dailyLedger: ledger }, log);
    if (outcome.action === 'create') {
      const id = `row-${next += 1}`;
      rows.push({ id, text: input.text, ...(outcome.triage ? { triage: outcome.triage } : {}) });
      return { ...outcome, id };
    }
    if (outcome.action === 'increment') outcome.target.triage = outcome.triage;
    if (outcome.action === 'supersede') {
      const id = `row-${next += 1}`;
      rows.push({ id, text: input.text, triage: outcome.triage });
      if (outcome.demote) outcome.target.triage = { ...outcome.demoted, supersededBy: id };
      return { ...outcome, id };
    }
    return outcome;
  };
  return { rows, events, write, ledger };
}

describe('출처·필수 칸', () => {
  test('mode on — 출처 없는 쓰기는 구조화 코드로 거부 · refused 사건', () => {
    const s = memStore();
    expect(() => s.write({ text: 'x', mode: 'on' })).toThrow(MemoryWriteRefusedError);
    let code: string | undefined;
    try { s.write({ text: 'x', mode: 'on' }); } catch (e) { code = (e as MemoryWriteRefusedError).code; }
    expect(code).toBe('missing-source');
    expect(s.rows).toHaveLength(0);
    expect(s.events.filter(e => e.event === 'refused').map(e => e.data.code)).toEqual(['missing-source', 'missing-source']);
  });

  test('shadow — 거부했을 것을 남기고 새 줄(기록 없음)을 허락한다', () => {
    const s = memStore();
    const out = s.write({ text: 'x', mode: 'shadow' });
    expect(out).toMatchObject({ action: 'create', enforced: false });
    expect(s.rows[0]!.triage).toBeUndefined();
    expect(s.events.map(e => e.event)).toEqual(['refused', 'write-accepted']);
    expect(s.events[0]!.data).toMatchObject({ code: 'missing-source', would: 'refuse' });
  });

  test('출처는 있는데 종류·범위가 빠지면 missing-field', () => {
    const s = memStore();
    expect(() => s.write({ text: 'x', mode: 'on', meta: { sourceEventId: 'e', reason: 'r' } })).toThrow('missing-field');
  });

  test('고침(같은 줄)은 새 기억이 아니다 — 중복·상한을 보지 않는다', () => {
    const s = memStore();
    expect(s.write({ text: 'x', mode: 'on', updateTargetId: 'row-9' })).toMatchObject({ action: 'update' });
    expect(s.events[0]!.data).toMatchObject({ action: 'update', target: memoryRowRef('row-9') });
  });
});

describe('중복', () => {
  test('정확 중복(정규화 해시) → 횟수 +1', () => {
    const s = memStore();
    s.write({ text: 'Pregate  receipt before HEAD report', meta: META });
    expect(s.write({ text: 'pregate receipt before head report', meta: META })).toMatchObject({ action: 'increment', match: 'exact' });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]!.triage).toMatchObject({ count: 2, source: META.sourceEventId });
  });

  test('근접 중복 ⊕ 같은 낱말 → 횟수 +1', () => {
    const s = memStore();
    expect(estimateJaccard(minhashSignature(BASE), minhashSignature(`${BASE}.`))).toBeGreaterThanOrEqual(MEMORY_NEAR_DUP_JACCARD);
    s.write({ text: BASE, meta: META });
    expect(s.write({ text: `${BASE}.`, meta: META })).toMatchObject({ action: 'increment', match: 'near' });
    expect(s.rows).toHaveLength(1);
  });

  test('근접 중복 ⊕ 낱말이 다름 → 새 줄 ⊕ supersedes · 옛 줄 강등(결정적 근거)', () => {
    const s = memStore();
    const before = BASE.replace('올리지 않는다', '올린다');
    expect(memoryWordsDiffer(before, BASE)).toBe(true);
    s.write({ text: before, meta: META });
    const out = s.write({ text: BASE, meta: META });
    expect(out).toMatchObject({ action: 'supersede', match: 'near', demote: true });
    expect(s.rows[1]!.triage).toMatchObject({ supersedes: 'row-1', count: 2 });
    expect(s.rows[0]!.triage).toMatchObject({ supersededBy: 'row-2' });
  });
});

describe('Jev 판정을 입력으로', () => {
  const jev = (durable: number, dupTargetId: string | null = null): JevMemoryJudgement => ({ ok: true, durable, scope: 'seat', kind: '교정', dupTargetId });

  test('durable < 0.6 → jev-not-durable', () => {
    const s = memStore();
    expect(() => s.write({ text: 'x', meta: META, jev: jev(0.3) })).toThrow('jev-not-durable');
  });

  test('Jev 만의 dup ⊕ 낱말이 다름 → 새 줄 ⊕ supersedes 링크만 · 옛 줄은 강등하지 않는다', () => {
    const s = memStore();
    s.write({ text: '착지는 pr land 하나로만 한다', meta: META });
    const out = s.write({ text: 'gh pr merge 를 직접 치지 말 것', meta: META, jev: jev(0.9, 'row-1') });
    expect(out).toMatchObject({ action: 'supersede', match: 'jev', demote: false });
    expect(s.rows[0]!.triage?.supersededBy).toBeUndefined();
    expect(s.rows[1]!.triage).toMatchObject({ supersedes: 'row-1' });
  });

  test('Jev 실패 판정({ok:false})이면 결정적 규칙만 쓴다', () => {
    const s = memStore();
    s.write({ text: 'a b c d e f', meta: META });
    expect(s.write({ text: 'a b c d e f', meta: META, jev: { ok: false, reason: 'no-key' } })).toMatchObject({ action: 'increment', match: 'exact' });
  });
});

describe('하루 상한(원장)', () => {
  test('상한을 넘으면 capped · 다음 날은 다시 받는다', () => {
    const s = memStore();
    for (let i = 0; i < MEMORY_SEAT_DAILY_CAP; i += 1) expect(s.write({ text: distinct(i), meta: META })).toMatchObject({ action: 'create' });
    expect(() => s.write({ text: distinct(MEMORY_SEAT_DAILY_CAP), meta: META })).toThrow('daily-cap');
    expect(s.events.filter(e => e.event === 'capped')).toHaveLength(1);
    expect(s.write({ text: distinct(MEMORY_SEAT_DAILY_CAP), meta: META, now: new Date('2026-11-18T10:00:00Z') })).toMatchObject({ action: 'create' });
  });

  test('줄을 지워도 원장 수는 줄지 않는다', () => {
    const s = memStore();
    for (let i = 0; i < MEMORY_SEAT_DAILY_CAP; i += 1) s.write({ text: distinct(i), meta: META });
    s.rows.length = 0;
    expect(() => s.write({ text: distinct(MEMORY_SEAT_DAILY_CAP), meta: META })).toThrow('daily-cap');
  });

  test('낱말 하나씩 바꾼 supersede 도 상한에 걸리고 원장에 센다', () => {
    const s = memStore();
    s.write({ text: `${BASE} v0`, meta: META });
    for (let i = 1; i < MEMORY_SEAT_DAILY_CAP; i += 1) expect(s.write({ text: `${BASE} v${i}`, meta: META })).toMatchObject({ action: 'supersede' });
    expect(s.ledger.count('TC', '2026-11-17')).toBe(MEMORY_SEAT_DAILY_CAP);
    expect(() => s.write({ text: `${BASE} over`, meta: META })).toThrow('daily-cap');
  });

  test('깨진 원장 → store-read-failed(강제) · 그림자면 «거부했을 것»을 남기고 새 줄', () => {
    const root = temp('broken');
    writeFileSync(join(root, '.triage-daily.json'), '[not json');
    const s = memStore(root);
    expect(() => s.write({ text: 'x', meta: META })).toThrow('store-read-failed');
    s.events.length = 0;
    // 그림자는 필수 칸 누락을 남긴 뒤에도 원장을 읽는다 — 깨진 원장은 would:refuse 로 남고 쓰기는 허락된다.
    expect(s.write({ text: 'x', mode: 'shadow', meta: { sourceEventId: 'e' } })).toMatchObject({ action: 'create', enforced: false });
    expect(s.events.map(e => [e.event, e.data.code, e.data.would])).toEqual([
      ['refused', 'missing-field', 'refuse'], ['refused', 'store-read-failed', 'refuse'], ['write-accepted', undefined, undefined],
    ]);
  });

  test('그림자 — 중복·상한도 «했을 일»로 재고 쓰기는 허락한다', () => {
    const s = memStore();
    s.write({ text: 'Pregate receipt before head report', meta: META });
    s.events.length = 0;
    expect(s.write({ text: 'pregate  receipt before HEAD report', mode: 'shadow' })).toMatchObject({ action: 'create', enforced: false });
    expect(s.events.find(e => e.event === 'deduped')!.data).toMatchObject({ match: 'exact', would: 'increment' });
    for (let i = 1; i < MEMORY_SEAT_DAILY_CAP; i += 1) s.write({ text: distinct(i), meta: META });
    s.events.length = 0;
    expect(s.write({ text: distinct(MEMORY_SEAT_DAILY_CAP), mode: 'shadow' })).toMatchObject({ action: 'create' });
    expect(s.events.find(e => e.event === 'capped')!.data).toMatchObject({ code: 'daily-cap', would: 'refuse' });
    // 그림자 쓰기는 원장에 세지 않는다.
    expect(s.ledger.count('TC', '2026-11-17')).toBe(MEMORY_SEAT_DAILY_CAP);
  });
});

test('저장소 읽기 실패 — 강제면 거부, 그림자면 «거부했을 것»을 남기고 새 줄', () => {
  const failing = { rows: (): MemoryGateRow[] => { throw new Error('EIO'); } };
  const events: Ev[] = [];
  const log: MemoryTriageLog = (_c, event, data) => { events.push({ event, data }); };
  expect(() => applyMemoryWriteGate({ store: 'seat', origin: 't', text: 'x', meta: META, mode: 'on' }, failing, log)).toThrow('store-read-failed');
  events.length = 0;
  expect(applyMemoryWriteGate({ store: 'seat', origin: 't', text: 'x', mode: 'shadow' }, failing, log)).toMatchObject({ action: 'create', enforced: false });
  expect(events.map(e => [e.event, e.data.code])).toEqual([['refused', 'missing-source'], ['refused', 'store-read-failed'], ['write-accepted', undefined]]);
});

test('사건에는 본문·이유가 없고 줄 참조는 해시다', () => {
  const s = memStore();
  s.write({ text: 'BODY-MARK-core 교훈', meta: { ...META, reason: 'REASON-MARK-core' } });
  s.write({ text: 'BODY-MARK-core 교훈', meta: { ...META, reason: 'REASON-MARK-core' } });
  s.write({ text: 'BODY-MARK-core', mode: 'shadow' });
  const all = JSON.stringify(s.events);
  expect(all).not.toContain('BODY-MARK');
  expect(all).not.toContain('REASON-MARK');
  expect(s.events.find(e => e.event === 'deduped')!.data.target).toBe(memoryRowRef('row-1'));
  expect(memoryTextHash('row-1')).not.toBe('row-1');
});
