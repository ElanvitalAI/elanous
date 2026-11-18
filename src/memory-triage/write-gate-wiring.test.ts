// MEMORY-TRIAGE-NO-LLM 문 ① — 쓰기 문 배선(saveMemory·saveSeatMemory·자리 memory_save 도구). 전부 임시 폴더 · 가짜 Jev(실제 HTTP·키 읽기 0).
// 문 핵심 판정은 `write-gate.test.ts`, Jev 어댑터(검증·반출·떨어지기)는 `jev-adapter.test.ts` 가 맡는다.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { JEV_ENDPOINT, type JevRequest, type JevResponse } from '../decide/jev.js';
import { listMemories, saveMemory } from '../memory.js';
import { deleteSeatMemory, listSeatMemories, saveSeatMemory } from '../seat-memory/seat-memory.js';
import { applySeatMemoryTools, type SeatMemoryToolContext } from '../seat-memory/seat-memory-tools.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import {
  MEMORY_NEAR_DUP_JACCARD, MEMORY_SEAT_DAILY_CAP, MemoryWriteRefusedError,
  estimateJaccard, fileDailyLedger, memoryRowRef, memoryWordsDiffer, memoryTextHash, minhashSignature,
} from './write-gate.js';
import { MEMORY_JEV_QUESTION_TEXT, type MemoryJevDeps } from './jev-adapter.js';

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), `tc-mtg-${prefix}-`)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type Ev = { category: string; event: string; data: Record<string, unknown> };
let events: Ev[] = [];
beforeEach(() => {
  events = [];
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
    events.push({ category, event, data });
  }) as typeof debug.log);
});
afterEach(() => { spyOn(debug, 'log').mockRestore(); });
const triage = (event?: string): Ev[] => events.filter(e => e.category === 'memory.triage' && (!event || e.event === event));

const META = { kind: '교정', scope: 'seat', sourceEventId: 'repl:s1/request-1', reason: 'r' } as const;
const distinct = (i: number): string => createHash('sha256').update(`distinct-${i}`).digest('hex');

/** 가짜 Jev — 실제 HTTP·키 파일 0. 받은 요청을 남긴다. */
function fakeJev(answer: (req: JevRequest) => JevResponse | Promise<JevResponse>) {
  const calls: JevRequest[] = [];
  let accessReads = 0;
  const deps: MemoryJevDeps = {
    peekEndpoint: () => JEV_ENDPOINT,
    resolveAccess: () => { accessReads += 1; return { ok: true, access: { endpoint: JEV_ENDPOINT, endpointSource: 'default', key: 'fake-not-a-key' } }; },
    callJev: async (req) => { calls.push(req); return answer(req); },
  };
  return { deps, calls, accessReads: () => accessReads };
}
const durableAnswer = (noul: number, dup?: string): JevResponse => ({
  model: 'jev-fake',
  answers: {
    durable: { type: 'noul', noul },
    scope: { type: 'choice', choice: 'seat' },
    kind: { type: 'choice', choice: 'correction' },
    ...(dup ? { dup: { type: 'choice', choice: dup } } : {}),
  },
});

function seatTools(ctx: Partial<SeatMemoryToolContext> & { dir: string }) {
  const specs: LLMToolSpec[] = [];
  const dispatch = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  applySeatMemoryTools(specs, dispatch, { seat: 'TC', getSourceEventId: () => 'repl:s1/request-1', audience: 'hq-seat', mode: 'on', ...ctx });
  return (args: Record<string, unknown>) => dispatch.get('memory_save')!(args);
}

describe('출처 없는 쓰기', () => {
  test('mode on — 구조화 오류로 거부하고 아무것도 쓰지 않는다', () => {
    const root = temp('on');
    let code: string | undefined;
    try { saveMemory({ type: 'feedback', name: 'n', description: 'd', body: '출처 없는 교훈' }, root, { mode: 'on', origin: 'test' }); }
    catch (error) { code = error instanceof MemoryWriteRefusedError ? error.code : 'other'; }
    expect(code).toBe('missing-source');
    expect(listMemories({}, root)).toHaveLength(0);
    expect(triage('refused').map(e => e.data.code)).toEqual(['missing-source']);
  });

  test('shadow(기본) — 거부했을 것을 남기고 그대로 쓴다', () => {
    const root = temp('shadow');
    saveMemory({ type: 'feedback', name: 'n', description: 'd', body: '출처 없는 교훈' }, root, { mode: 'shadow', origin: 'test' });
    expect(listMemories({}, root)).toHaveLength(1);
    expect(triage('refused')[0]!.data).toMatchObject({ code: 'missing-source', would: 'refuse', enforced: false });
    expect(triage('write-accepted')[0]!.data).toMatchObject({ action: 'create' });
    // 옛 쓰기의 파일 바이트는 바뀌지 않는다(triage 머리말 없음).
    expect(readFileSync(join(root, listMemories({}, root)[0]!.filename), 'utf8')).not.toContain('triage:');
  });

  test('자리 저장소 — on 이면 code 를 돌려준다', () => {
    const dir = temp('seat-on');
    const r = saveSeatMemory({ name: 'n', description: 'd', type: 'feedback', body: 'b' }, dir, 'TC', { mode: 'on' });
    expect(r).toMatchObject({ ok: false, code: 'missing-source' });
    expect(listSeatMemories(dir)).toHaveLength(0);
  });
});

describe('중복은 새 줄 대신 횟수 +1', () => {
  test('정확 중복(정규화 해시) — 대소문자·공백만 다른 문장', () => {
    const dir = temp('exact');
    expect(saveSeatMemory({ name: 'a', description: 'd', type: 'feedback', body: 'Pregate  receipt before HEAD report' }, dir, 'TC', { meta: META, mode: 'on' as const })).toMatchObject({ ok: true, action: 'created' });
    expect(saveSeatMemory({ name: 'b', description: 'd', type: 'feedback', body: 'pregate receipt before head report' }, dir, 'TC', { meta: META, mode: 'on' as const }))
      .toMatchObject({ ok: true, action: 'deduped', name: 'a', count: 2, match: 'exact' });
    const rows = listSeatMemories(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.triage).toMatchObject({ count: 2, kind: '교정', scope: 'seat', source: META.sourceEventId });
    expect(triage('deduped')[0]!.data).toMatchObject({ match: 'exact', target: memoryRowRef('a.md'), count: 2 });
  });

  test('근접 중복(MinHash Jaccard ≥ 문턱)', () => {
    const dir = temp('near');
    const base = 'PR head 를 보고하기 전에 반드시 pregate 영수증을 받아 두고, 영수증이 없으면 게이트 큐에 올리지 않는다';
    const near = `${base}.`;
    expect(memoryTextHash(base)).not.toBe(memoryTextHash(near));
    expect(estimateJaccard(minhashSignature(base), minhashSignature(near))).toBeGreaterThanOrEqual(MEMORY_NEAR_DUP_JACCARD);
    saveSeatMemory({ name: 'a', description: 'd', type: 'feedback', body: base }, dir, 'TC', { meta: META, mode: 'on' as const });
    expect(saveSeatMemory({ name: 'b', description: 'd', type: 'feedback', body: near }, dir, 'TC', { meta: META, mode: 'on' as const }))
      .toMatchObject({ ok: true, action: 'deduped', match: 'near', count: 2 });
    expect(listSeatMemories(dir)).toHaveLength(1);
  });

  test('부정어만 다른 교정은 접지 않는다 — 새 줄 ⊕ supersedes · 옛 줄 강등', () => {
    const dir = temp('negate');
    const before = 'PR head 를 보고하기 전에 반드시 pregate 영수증을 받아 두고, 영수증이 없으면 게이트 큐에 올린다';
    const after = 'PR head 를 보고하기 전에 반드시 pregate 영수증을 받아 두고, 영수증이 없으면 게이트 큐에 올리지 않는다';
    expect(estimateJaccard(minhashSignature(before), minhashSignature(after))).toBeGreaterThanOrEqual(MEMORY_NEAR_DUP_JACCARD);
    expect(memoryWordsDiffer(before, after)).toBe(true);
    expect(memoryWordsDiffer(before, `${before}.`)).toBe(false);
    saveSeatMemory({ name: 'a', description: 'd', type: 'feedback', body: before }, dir, 'TC', { meta: META, mode: 'on' as const });
    expect(saveSeatMemory({ name: 'b', description: 'd', type: 'feedback', body: after }, dir, 'TC', { meta: META, mode: 'on' as const }))
      .toMatchObject({ ok: true, action: 'superseded', name: 'b', match: 'near', count: 2, supersedes: 'a' });
    const rows = listSeatMemories(dir);
    expect(rows.map(r => r.body).sort()).toEqual([after, before].sort());
    expect(rows.find(r => r.name === 'b')!.triage).toMatchObject({ supersedes: 'a.md', count: 2 });
    expect(rows.find(r => r.name === 'a')!.triage).toMatchObject({ supersededBy: 'b.md' });
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).not.toContain('](a.md)');
    expect(triage('superseded')[0]!.data).toMatchObject({ match: 'near', target: memoryRowRef('a.md') });
    // 강등된 줄은 다시 중복 후보가 되지 않는다 — 옛 문장을 다시 말하면 지금 줄을 대신한다.
    expect(saveSeatMemory({ name: 'c', description: 'd', type: 'feedback', body: before }, dir, 'TC', { meta: META, mode: 'on' as const }))
      .toMatchObject({ ok: true, action: 'superseded', supersedes: 'b' });
  });

  test('낱말 하나씩 바꾼 supersede 도 하루 상한에 걸린다', () => {
    const dir = temp('supersede-cap');
    const now = new Date('2026-11-17T10:00:00Z');
    const base = 'PR head 를 보고하기 전에 반드시 pregate 영수증을 받아 두고, 영수증이 없으면 게이트 큐에 올리지 않는다 단계';
    expect(saveSeatMemory({ name: 'v0', description: 'd', type: 'feedback', body: `${base} v0` }, dir, 'TC', { meta: META, mode: 'on' as const, now })).toMatchObject({ action: 'created' });
    for (let i = 1; i < MEMORY_SEAT_DAILY_CAP; i += 1) {
      expect(saveSeatMemory({ name: `v${i}`, description: 'd', type: 'feedback', body: `${base} v${i}` }, dir, 'TC', { meta: META, mode: 'on' as const, now }))
        .toMatchObject({ ok: true, action: 'superseded', match: 'near' });
    }
    expect(saveSeatMemory({ name: 'over', description: 'd', type: 'feedback', body: `${base} over` }, dir, 'TC', { meta: META, mode: 'on' as const, now }))
      .toMatchObject({ ok: false, code: 'daily-cap' });
    expect(triage('capped')).toHaveLength(1);
  });

  test('전역 — 부정 교정 보존 · 옛 줄은 고정이 풀린다', () => {
    const root = temp('global-negate');
    const gate = { meta: META, mode: 'on' as const, seat: 'TC', origin: 'test' };
    const before = '배포 전에는 반드시 착지 도구로 main 병합 판정을 받고 나서 가지를 따라잡는다';
    const after = '배포 전에는 반드시 착지 도구로 main 병합 판정을 받고 나서 가지를 따라잡지 않는다';
    const first = saveMemory({ type: 'feedback', name: 'x', description: 'd', body: before, pinned: true }, root, gate);
    const second = saveMemory({ type: 'feedback', name: 'y', description: 'd', body: after }, root, gate);
    expect(second.id).not.toBe(first.id);
    const rows = listMemories({}, root);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.id === second.id)!.triage).toMatchObject({ supersedes: first.id, count: 2 });
    const old = rows.find(r => r.id === first.id)!;
    expect(old.body.trim()).toBe(before);
    expect(old.pinned).toBe(false);
    expect(old.triage).toMatchObject({ supersededBy: second.id });
  });

  test('전역 저장소도 같은 문 — 횟수가 머리말에 남는다', () => {
    const root = temp('global-dup');
    const gate = { meta: META, mode: 'on' as const, seat: 'TC', origin: 'test' };
    const first = saveMemory({ type: 'feedback', name: 'x', description: 'd', body: '같은 교훈' }, root, gate);
    const second = saveMemory({ type: 'feedback', name: 'y', description: 'd', body: '같은  교훈' }, root, gate);
    expect(second.id).toBe(first.id);
    expect(listMemories({}, root)).toHaveLength(1);
    expect(listMemories({}, root)[0]!.triage?.count).toBe(2);
  });
});

test('자리당 하루 상한 — 넘으면 capped · 다음 날은 다시 받는다', () => {
  const dir = temp('cap');
  const day1 = new Date('2026-11-17T10:00:00Z');
  for (let i = 0; i < MEMORY_SEAT_DAILY_CAP; i += 1) {
    expect(saveSeatMemory({ name: `m${i}`, description: 'd', type: 'feedback', body: distinct(i) }, dir, 'TC', { meta: META, mode: 'on' as const, now: day1 }))
      .toMatchObject({ ok: true, action: 'created' });
  }
  expect(saveSeatMemory({ name: 'over', description: 'd', type: 'feedback', body: distinct(MEMORY_SEAT_DAILY_CAP) }, dir, 'TC', { meta: META, mode: 'on' as const, now: day1 }))
    .toMatchObject({ ok: false, code: 'daily-cap' });
  expect(triage('capped')).toHaveLength(1);
  expect(saveSeatMemory({ name: 'over', description: 'd', type: 'feedback', body: distinct(MEMORY_SEAT_DAILY_CAP) }, dir, 'TC', { meta: META, mode: 'on' as const, now: new Date('2026-11-18T10:00:00Z') }))
    .toMatchObject({ ok: true, action: 'created' });
});

test('하루 상한은 전역·자리 저장소가 함께 세고, 줄을 지워도 줄지 않는다', () => {
  const root = temp('cap-shared');
  const seatDir = join(root, 'seats', 'TC');
  const now = new Date('2026-11-17T10:00:00Z');
  saveMemory({ type: 'feedback', name: 'g', description: 'd', body: distinct(100) }, root, { meta: META, mode: 'on' as const, seat: 'TC', origin: 'test', now });
  for (let i = 1; i < MEMORY_SEAT_DAILY_CAP; i += 1) {
    expect(saveSeatMemory({ name: `m${i}`, description: 'd', type: 'feedback', body: distinct(i) }, seatDir, 'TC', { meta: META, mode: 'on' as const, now })).toMatchObject({ ok: true });
  }
  expect(deleteSeatMemory('m1', seatDir, 'TC').ok).toBe(true);
  expect(saveSeatMemory({ name: 'over', description: 'd', type: 'feedback', body: distinct(200) }, seatDir, 'TC', { meta: META, mode: 'on' as const, now }))
    .toMatchObject({ ok: false, code: 'daily-cap' });
});

describe('고침은 새 기억이 아니다', () => {
  test('자리 — 같은 이름·본문에 설명만 바꾸면 고침(횟수로 접어 변경을 버리지 않는다)', () => {
    const dir = temp('meta-edit');
    saveSeatMemory({ name: 'a', description: 'old', type: 'feedback', body: '같은 본문' }, dir, 'TC', { meta: META, mode: 'on' as const });
    expect(saveSeatMemory({ name: 'a', description: 'new', type: 'feedback', body: '같은 본문' }, dir, 'TC', { meta: META, mode: 'on' as const })).toMatchObject({ ok: true, action: 'updated' });
    expect(listSeatMemories(dir)[0]).toMatchObject({ description: 'new' });
  });

  test('전역 — 같은 id 의 이름 변경은 on 에서도 고침이다', () => {
    const root = temp('rename');
    saveMemory({ id: 'fixed-id', type: 'feedback', name: 'old name', description: 'd', body: 'b' }, root, { meta: META, mode: 'on' as const, seat: 'TC', origin: 'test' });
    expect(() => saveMemory({ id: 'fixed-id', type: 'feedback', name: 'new name', description: 'd', body: 'b' }, root, { mode: 'on', origin: 'test' })).not.toThrow();
    expect(triage('write-accepted').at(-1)!.data).toMatchObject({ action: 'update' });
  });

  test('전역 — 이름 변경은 옛 파일의 트리아지 기록(횟수·출처)을 잇는다', () => {
    const root = temp('rename-triage');
    const gate = { meta: META, mode: 'on' as const, seat: 'TC', origin: 'test' };
    saveMemory({ id: 'fixed-id', type: 'feedback', name: 'old name', description: 'd', body: '같은 교훈 둘' }, root, gate);
    saveMemory({ type: 'feedback', name: 'other', description: 'd', body: '같은  교훈 둘' }, root, gate);
    const renamed = saveMemory({ id: 'fixed-id', type: 'feedback', name: 'new name', description: 'd', body: '같은 교훈 둘' }, root, { origin: 'test' });
    expect(renamed.filename).toBe('fixed-id-new-name.md');
    expect(renamed.triage).toMatchObject({ count: 2, source: META.sourceEventId });
    expect(readFileSync(join(root, renamed.filename), 'utf8')).toContain('"count":2');
  });
});

describe('Jev 판정(가짜 클라이언트)', () => {
  test('durable < 0.6 이면 버린다', async () => {
    const dir = temp('jev-drop');
    const jev = fakeJev(() => durableAnswer(0.3));
    const save = seatTools({ dir, jevDeps: jev.deps });
    expect(await save({ name: 'tmp', description: '오늘 상태', type: 'project', body: '지금 3번 탭에서 빌드 중' })).toMatchObject({ saved: false, code: 'jev-not-durable' });
    expect(listSeatMemories(dir)).toHaveLength(0);
    expect(jev.calls).toHaveLength(1);
    // 질문 문면은 고정 · state 경계 표시 · score 질문 없음 · 후보가 없으면 dup 질문도 없다.
    const req = jev.calls[0]!;
    expect(req.questions.durable).toMatchObject({ type: 'noul', instructions: MEMORY_JEV_QUESTION_TEXT.durable });
    expect(Object.values(req.questions).map(q => q.type)).not.toContain('score');
    expect(req.questions.dup).toBeUndefined();
    expect(JSON.stringify(req.state)).toContain('BEGIN UNTRUSTED MEMORY STATE');
    expect(JSON.stringify(req.state)).toContain('END UNTRUSTED MEMORY STATE');
  });

  test('dup 를 골라도 낱말이 다르면 새 본문을 버리지 않는다 — 새 줄 ⊕ supersedes', async () => {
    const dir = temp('jev-dup');
    saveSeatMemory({ name: 'land-rule', description: 'd', type: 'feedback', body: '착지는 pr land 하나로만 한다' }, dir, 'TC', { meta: META, mode: 'on' as const });
    const jev = fakeJev(() => durableAnswer(0.9, 'cand_1'));
    const save = seatTools({ dir, jevDeps: jev.deps });
    expect(await save({ name: 'merge-rule', description: 'd', type: 'feedback', body: 'gh pr merge 를 직접 치지 말 것' }))
      .toMatchObject({ saved: true, action: 'superseded', name: 'merge-rule', supersedes: 'land-rule', count: 2 });
    expect(Object.keys((jev.calls[0]!.questions.dup as { criteria: Record<string, unknown> }).criteria)).toEqual(['cand_1', 'none']);
    expect(triage('superseded')[0]!.data).toMatchObject({ match: 'jev' });
    expect(listSeatMemories(dir).map(r => r.body).sort()).toEqual(['gh pr merge 를 직접 치지 말 것', '착지는 pr land 하나로만 한다'].sort());
    // Jev 만의 근거로는 옛 줄을 강등하지 않는다 — 색인에 남고 supersededBy 도 없다(새 줄의 링크만).
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toContain('](land-rule.md)');
    expect(listSeatMemories(dir).find(r => r.name === 'land-rule')!.triage?.supersededBy).toBeUndefined();
    expect(listSeatMemories(dir).find(r => r.name === 'merge-rule')!.triage).toMatchObject({ supersedes: 'land-rule.md' });
  });

  test('Jev 오류 → 결정적 규칙으로 떨어지고 jev-fallback 을 남긴다', async () => {
    const dir = temp('jev-error');
    const jev = fakeJev(() => { throw new Error('Jev HTTP 503'); });
    const save = seatTools({ dir, jevDeps: jev.deps });
    expect(await save({ name: 'a', description: 'd', type: 'feedback', body: '교훈 하나', kind: '교정', scope: 'seat' })).toMatchObject({ saved: true, action: 'created' });
    expect(triage('jev-fallback')[0]!.data).toMatchObject({ cause: 'request-failed' });
    expect(listSeatMemories(dir)[0]!.triage).toMatchObject({ kind: '교정', scope: 'seat' });
    // 결정적 규칙도 그대로 돈다 — 같은 문장은 횟수로 접힌다.
    expect(await save({ name: 'b', description: 'd', type: 'feedback', body: '교훈 하나', kind: '교정', scope: 'seat' })).toMatchObject({ action: 'deduped', count: 2 });
  });

  test('Jev 도 모델도 kind·scope 를 안 주면 추정하지 않는다 — 모름으로 남긴다', async () => {
    const dir = temp('jev-unknown');
    const save = seatTools({ dir, mode: 'shadow', jevDeps: fakeJev(() => { throw new Error('down'); }).deps });
    expect(await save({ name: 'a', description: 'd', type: 'feedback', body: '교훈 하나' })).toMatchObject({ saved: true, action: 'created' });
    expect(listSeatMemories(dir)[0]!.triage).toBeUndefined();
    expect(triage('refused')[0]!.data).toMatchObject({ code: 'missing-field', would: 'refuse' });
    expect(await seatTools({ dir: temp('jev-unknown-on'), mode: 'on', jevDeps: fakeJev(() => { throw new Error('down'); }).deps })({ name: 'a', description: 'd', type: 'feedback', body: '교훈 하나' }))
      .toMatchObject({ saved: false, code: 'missing-field' });
  });

  test('회원 기억은 기본으로 Jev 를 부르지 않는다(키도 읽지 않는다) · 로컬 서버면 부른다', async () => {
    const dir = temp('member');
    const remote = fakeJev(() => durableAnswer(0.9));
    await seatTools({ dir, audience: 'member', jevDeps: remote.deps })({ name: 'a', description: 'd', type: 'feedback', body: '회원 교훈' });
    expect(remote.calls).toHaveLength(0);
    expect(remote.accessReads()).toBe(0);
    expect(triage('jev-fallback')[0]!.data).toMatchObject({ cause: 'egress-not-allowed' });
    const local = fakeJev(() => durableAnswer(0.9));
    const localDeps: MemoryJevDeps = {
      ...local.deps, peekEndpoint: () => 'http://127.0.0.1:8787/v1/systemone',
      resolveAccess: () => ({ ok: true, access: { endpoint: 'http://127.0.0.1:8787/v1/systemone', endpointSource: 'config' } }),
    };
    await seatTools({ dir: temp('member-local'), audience: 'member', jevDeps: localDeps })({ name: 'b', description: 'd', type: 'feedback', body: '회원 교훈 둘' });
    expect(local.calls).toHaveLength(1);
  });
});

describe('기본(그림자)은 기록만 — 기억이 조용히 줄지 않는다', () => {
  test('같은 날 상한을 넘는 저장도 saved:true ⊕ would capped · on 이면 거부', () => {
    const now = new Date('2026-11-17T10:00:00Z');
    for (const mode of ['shadow', 'on'] as const) {
      const dir = temp(`shadow-cap-${mode}`);
      for (let i = 0; i < MEMORY_SEAT_DAILY_CAP; i += 1) saveSeatMemory({ name: `m${i}`, description: 'd', type: 'feedback', body: distinct(i) }, dir, 'TC', { meta: META, mode, now });
      const over = saveSeatMemory({ name: 'over', description: 'd', type: 'feedback', body: distinct(MEMORY_SEAT_DAILY_CAP) }, dir, 'TC', { meta: META, mode, now });
      if (mode === 'shadow') {
        expect(over).toMatchObject({ ok: true, action: 'created' });
        expect(triage('capped').at(-1)!.data).toMatchObject({ code: 'daily-cap', would: 'refuse' });
        // 측정을 잃지 않는다 — 넘친 줄도 기록을 달고 원장에 센다.
        expect(listSeatMemories(dir).find(r => r.name === 'over')!.triage).toMatchObject({ kind: '교정', day: '2026-11-17' });
        expect(fileDailyLedger(dir).count('TC', '2026-11-17')).toBe(MEMORY_SEAT_DAILY_CAP + 1);
      } else {
        expect(over).toMatchObject({ ok: false, code: 'daily-cap' });
      }
    }
  });

  test('Jev durable 0.3 도 saved:true ⊕ would 버림 · on 이면 거부', async () => {
    const shadow = seatTools({ dir: temp('shadow-drop'), mode: 'shadow', jevDeps: fakeJev(() => durableAnswer(0.3)).deps });
    expect(await shadow({ name: 'tmp', description: 'd', type: 'project', body: '지금 3번 탭에서 빌드 중' })).toMatchObject({ saved: true, action: 'created' });
    expect(triage('refused').at(-1)!.data).toMatchObject({ code: 'jev-not-durable', would: 'refuse' });
    const on = seatTools({ dir: temp('on-drop'), mode: 'on', jevDeps: fakeJev(() => durableAnswer(0.3)).deps });
    expect(await on({ name: 'tmp', description: 'd', type: 'project', body: '지금 3번 탭에서 빌드 중' })).toMatchObject({ saved: false, code: 'jev-not-durable' });
  });

  test('전역 저장소도 — 그림자는 중복이어도 새 줄(would increment)', () => {
    const root = temp('global-shadow');
    const gate = { meta: META, mode: 'shadow' as const, seat: 'TC', origin: 'test' };
    saveMemory({ type: 'feedback', name: 'x', description: 'd', body: '같은 교훈' }, root, gate);
    saveMemory({ type: 'feedback', name: 'y', description: 'd', body: '같은  교훈' }, root, gate);
    expect(listMemories({}, root)).toHaveLength(2);
    expect(triage('deduped').at(-1)!.data).toMatchObject({ match: 'exact', would: 'increment' });
    expect(listMemories({}, root).every(r => r.triage?.kind === '교정')).toBe(true);
  });

  test('자리 저장소 — 그림자 중복도 새 줄에 기록이 붙는다(would increment)', () => {
    const dir = temp('seat-shadow-dup');
    saveSeatMemory({ name: 'a', description: 'd', type: 'feedback', body: '같은 교훈 셋' }, dir, 'TC', { meta: META, mode: 'shadow' });
    expect(saveSeatMemory({ name: 'b', description: 'd', type: 'feedback', body: '같은  교훈 셋' }, dir, 'TC', { meta: META, mode: 'shadow' }))
      .toMatchObject({ ok: true, action: 'created' });
    expect(listSeatMemories(dir).find(r => r.name === 'b')!.triage).toMatchObject({ kind: '교정', source: META.sourceEventId, count: 1 });
    expect(triage('deduped').at(-1)!.data).toMatchObject({ match: 'exact', would: 'increment' });
  });
});

test('사건에는 본문·이름·이유가 없다', async () => {
  const dir = temp('noleak');
  // 두 번째 저장에는 후보가 있어 dup 질문이 간다 — 물은 답을 다 줘야 판정이 쓰인다.
  const jev = fakeJev(() => durableAnswer(0.9, 'none'));
  const save = seatTools({ dir, jevDeps: jev.deps });
  await save({ name: 'NAME-MARK-mtg', description: 'DESC-MARK-mtg', type: 'feedback', body: 'BODY-MARK-mtg 교훈', reason: 'REASON-MARK-mtg' });
  await save({ name: 'NAME-MARK-mtg-2', description: 'DESC-MARK-mtg', type: 'feedback', body: 'BODY-MARK-mtg 교훈', reason: 'REASON-MARK-mtg' });
  saveMemory({ type: 'feedback', name: 'NAME-MARK-mtg', description: 'DESC-MARK-mtg', body: 'BODY-MARK-mtg' }, temp('noleak-g'), { mode: 'shadow' });
  const all = JSON.stringify(triage());
  expect(triage().map(e => e.event)).toEqual(expect.arrayContaining(['write-accepted', 'deduped', 'refused']));
  for (const mark of ['NAME-MARK', 'DESC-MARK', 'BODY-MARK', 'REASON-MARK']) expect(all).not.toContain(mark);
});

test('한 프로세스 동시 쓰기 — 같은 문장 두 번이면 한 줄 ⊕ 횟수 2', async () => {
  const dir = temp('concurrent');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const jev = fakeJev(async () => { await gate; return durableAnswer(0.9); });
  const save = seatTools({ dir, jevDeps: jev.deps });
  const a = save({ name: 'same', description: 'd', type: 'feedback', body: '동시에 저장된 같은 교훈' });
  const b = save({ name: 'same', description: 'd', type: 'feedback', body: '동시에 저장된 같은 교훈' });
  release();
  const results = await Promise.all([a, b]) as Array<{ action: string }>;
  expect(results.map(r => r.action).sort()).toEqual(['created', 'deduped']);
  const rows = listSeatMemories(dir);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.triage?.count).toBe(2);
});
