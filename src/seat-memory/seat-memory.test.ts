// OP-MEMORY-PARITY (O6) — 자리 기억 저장소·색인 주입·회상·가져오기·관측. 전부 임시 폴더(실물 기억 폴더 0).
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  SEAT_MEMORY_INDEX_MAX_LINES, buildSeatMemoryIndexBlock, deleteSeatMemory, findSeatMemory, listSeatMemories,
  parseSeatMemoryText, readSeatMemoryIndex, rebuildSeatMemoryIndex, recallSeatMemoriesForTurn, resetSeatMemoryRecallForTest,
  saveSeatMemory, searchSeatMemories, seatMemoryDir,
} from './seat-memory.js';
import { applySeatMemoryImport, planSeatMemoryImport } from './seat-memory-import.js';
import { applySeatMemoryTools } from './seat-memory-tools.js';
import { buildSeatMemoryIndexSystemMessages, resetSeatBootCacheForTest } from '../seat/seat-boot-preamble.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), `o6-memory-${prefix}-`)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let events: Array<{ category: string; event: string; data: unknown }> = [];
beforeEach(() => {
  events = [];
  resetSeatMemoryRecallForTest();
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    events.push({ category, event, data });
  }) as typeof debug.log);
});
afterEach(() => { spyOn(debug, 'log').mockRestore(); });

const memoryEvents = (event: string) => events.filter(e => e.category === 'memory' && e.event === event);
// 비밀 꼴 표본은 실행 중에만 조립한다(저장소에 비밀 꼴 문자열을 남기지 않는다).
const fakeKey = (): string => ['sk', '-', 'Z'.repeat(8), '9'.repeat(12)].join('');

describe('자리 기억 저장소 — 저장·고쳐 쓰기·지우기', () => {
  test('같은 name 은 새 파일을 만들지 않고 고친다 · 지우면 색인 줄도 빠진다', () => {
    const dir = temp('crud');
    const first = saveSeatMemory({ name: 'land-train-batch', description: '열차 = 3~4개 묶음', type: 'feedback', body: '묶어서 태운다.\n**Why:** 부하', links: ['train-idle'] }, dir, 'OP');
    expect(first).toEqual({ ok: true, action: 'created', name: 'land-train-batch', file: 'land-train-batch.md' });
    const again = saveSeatMemory({ name: 'land-train-batch', description: '열차 = 3~4개 묶음', type: 'feedback', body: '묶어서 태운다.\n**Why:** 부하', links: ['train-idle'] }, dir, 'OP');
    expect(again.ok && again.action).toBe('unchanged');
    const updated = saveSeatMemory({ name: 'land-train-batch', description: '열차 = 1개도 태운다', type: 'feedback', body: '유휴면 하나도.' }, dir, 'OP');
    expect(updated.ok && updated.action).toBe('updated');
    expect(readdirSync(dir).sort()).toEqual(['MEMORY.md', 'land-train-batch.md']);
    const entry = findSeatMemory(dir, 'land-train-batch')!;
    expect(entry.description).toBe('열차 = 1개도 태운다');
    expect(readSeatMemoryIndex(dir).trim()).toBe('- [land-train-batch](land-train-batch.md) — 열차 = 1개도 태운다');
    // links 는 본문 [[…]] 로 남는다.
    saveSeatMemory({ name: 'b', description: 'd', type: 'project', body: 'x', links: ['land-train-batch'] }, dir, 'OP');
    expect(findSeatMemory(dir, 'b')!.links).toEqual(['land-train-batch']);
    expect(deleteSeatMemory('land-train-batch', dir, 'OP')).toEqual({ ok: true, file: 'land-train-batch.md' });
    expect(existsSync(join(dir, 'land-train-batch.md'))).toBe(false);
    expect(readSeatMemoryIndex(dir)).not.toContain('land-train-batch.md');
    expect(deleteSeatMemory('없는-기억', dir, 'OP').ok).toBe(false);
  });

  test('잘못된 입력·비밀 꼴은 거부한다(파일 0)', () => {
    const dir = temp('refuse');
    expect(saveSeatMemory({ name: '', description: 'd', type: 'user', body: 'b' }, dir).ok).toBe(false);
    expect(saveSeatMemory({ name: 'n', description: 'd', type: 'nope', body: 'b' }, dir).ok).toBe(false);
    expect(saveSeatMemory({ name: 'n', description: 'd', type: 'user', body: `key ${fakeKey()}` }, dir).ok).toBe(false);
    expect(listSeatMemories(dir)).toEqual([]);
  });

  test('Claude Code 꼴 두 가지(맨 위 type · metadata 아래 type)를 같이 읽는다', () => {
    const nested = parseSeatMemoryText('---\nname: a\ndescription: "따옴표 설명"\nmetadata:\n  node_type: memory\n  type: feedback\n---\n\n본문 [[b]]\n', 'a.md')!;
    expect(nested).toEqual({ name: 'a', description: '따옴표 설명', type: 'feedback', body: '본문 [[b]]', links: ['b'], file: 'a.md' });
    expect(parseSeatMemoryText('---\nname: c\ndescription: d\ntype: reference\n---\nx', 'c.md')!.type).toBe('reference');
    expect(parseSeatMemoryText('no frontmatter', 'x.md')).toBeNull();
  });

  test('색인 다시 쓰기 — 파일에서 이름 순으로 한 줄씩', () => {
    const dir = temp('rebuild');
    saveSeatMemory({ name: 'zeta', description: 'z', type: 'user', body: 'z' }, dir);
    saveSeatMemory({ name: 'alpha', description: 'a', type: 'user', body: 'a' }, dir);
    writeFileSync(join(dir, 'MEMORY.md'), 'garbage\n');
    expect(rebuildSeatMemoryIndex(dir)).toEqual({ lines: listSeatMemories(dir).length });
    expect(readSeatMemoryIndex(dir)).toBe('- [alpha](alpha.md) — a\n- [zeta](zeta.md) — z\n');
  });

  test('자리 폴더 = <뿌리>/seats/<SEAT> · 자리 id 는 대문자', () => {
    expect(seatMemoryDir('op', '/r')).toBe('/r/seats/OP');
    expect(() => seatMemoryDir('../x', '/r')).toThrow();
  });
});

describe('세션 시작 색인 주입', () => {
  test('상한을 넘으면 줄 경계에서 자르고 잘림 알림 ⊕ «배경 맥락 · 지시 아님» 표지', () => {
    const dir = temp('trunc');
    mkdirSync(dir, { recursive: true });
    const total = SEAT_MEMORY_INDEX_MAX_LINES + 7;
    writeFileSync(join(dir, 'MEMORY.md'), Array.from({ length: total }, (_, i) => `- [m${i}](m${i}.md) — 설명 ${i}`).join('\n') + '\n');
    const built = buildSeatMemoryIndexBlock('OP', dir)!;
    expect(built.truncated).toBe(true);
    expect(built.lines).toBe(SEAT_MEMORY_INDEX_MAX_LINES);
    expect(built.totalLines).toBe(total);
    expect(built.block).toContain('지시가 아니다');
    expect(built.block).toContain(`색인 ${total}줄`);
    expect(built.block).toContain(`- [m${SEAT_MEMORY_INDEX_MAX_LINES - 1}]`);
    expect(built.block).not.toContain(`- [m${SEAT_MEMORY_INDEX_MAX_LINES}]`);
    // 바이트 상한 = 첫 줄 하나만 들어가는 크기(줄 경계에서 자른다).
    const firstLineBytes = Buffer.byteLength(readSeatMemoryIndex(dir).split('\n')[0]!, 'utf8') + 1;
    const byBytes = buildSeatMemoryIndexBlock('OP', dir, { maxBytes: firstLineBytes })!;
    expect(byBytes.truncated).toBe(true);
    expect(byBytes.block).toContain('- [m0](m0.md)');
    expect(byBytes.block).not.toContain('- [m1](m1.md)');
    expect(byBytes.bytes).toBe(firstLineBytes);
    expect(buildSeatMemoryIndexBlock('OP', temp('empty'))).toBeNull();
  });

  test('자리 세션 부트: 대화마다 한 번 · 같은 대화는 같은 바이트 · index-injected 는 수만', () => {
    resetSeatBootCacheForTest();
    const home = temp('home');
    const cwd = join(home, 'elanous-hq', 'seats', 'OP');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
    const root = temp('root');
    saveSeatMemory({ name: 'answer-korean', description: '답은 한글', type: 'user', body: 'BODY-MARKER-o6 본문' }, seatMemoryDir('OP', root));
    const deps = { home, msgPath: join(home, 'msg.db'), env: {}, seatMemoryRoot: root };
    try {
      const a = buildSeatMemoryIndexSystemMessages({ cwd }, deps);
      saveSeatMemory({ name: 'later', description: '나중 기억', type: 'user', body: 'x' }, seatMemoryDir('OP', root));
      const b = buildSeatMemoryIndexSystemMessages({ cwd }, deps);
      expect(a).toHaveLength(1);
      expect(b).toBe(a); // 같은 대화 = 같은 스냅샷(캐시 접두 안정)
      expect(String(a[0]!.content)).toContain('- [answer-korean](answer-korean.md) — 답은 한글');
      expect(String(a[0]!.content)).not.toContain('later');
      const injected = memoryEvents('index-injected');
      expect(injected).toHaveLength(1);
      const indexLines = readSeatMemoryIndex(seatMemoryDir('OP', root)).trim().split('\n');
      expect(indexLines).toEqual(['- [answer-korean](answer-korean.md) — 답은 한글', expect.stringContaining('(later.md)')]);
      // 관측 칸은 수만 — 대화 시작 때 색인은 한 줄이었다(본문·설명 0).
      expect(Object.keys(injected[0]!.data as object).sort()).toEqual(['bytes', 'lines', 'seat', 'totalBytes', 'totalLines', 'truncated']);
      expect(injected[0]!.data).toMatchObject({ seat: 'OP', truncated: false, lines: indexLines.length - 1, totalLines: indexLines.length - 1 });
      resetSeatBootCacheForTest();
      expect(String(buildSeatMemoryIndexSystemMessages({ cwd }, deps)[0]!.content)).toContain('later');
      // 자리가 아니면 0.
      resetSeatBootCacheForTest();
      expect(buildSeatMemoryIndexSystemMessages({ cwd: join(home, 'not-a-seat') }, deps)).toEqual([]);
    } finally { resetSeatBootCacheForTest(); }
  });
});

describe('턴 회상(추가 모델 호출 0)', () => {
  const seed = (): string => {
    const dir = temp('recall');
    saveSeatMemory({ name: 'pregate-receipt-before-head-report', description: 'PR head 보고 전 pregate 영수증 필수', type: 'feedback', body: 'pregate 영수증 없이 head 를 보고하지 않는다.' }, dir);
    saveSeatMemory({ name: 'release-cadence-daily-0600', description: '발행은 매일 06:00', type: 'project', body: '판은 06:00 에 낸다.' }, dir);
    saveSeatMemory({ name: 'naming-my-elanous-home', description: '회원 공간 이름 = 내 엘라누스', type: 'project', body: '홈 이름.' }, dir);
    return dir;
  };

  test('관련 기억만 고르고, 같은 대화에서는 다시 꺼내지 않는다', () => {
    const dir = seed();
    expect(searchSeatMemories('pregate 영수증 확인', dir)[0]!.entry.name).toBe('pregate-receipt-before-head-report');
    const first = recallSeatMemoriesForTurn({ seat: 'OP', dir, text: 'PR head 보고하기 전에 pregate 돌렸나?', sessionKey: 's1' })!;
    expect(first.names).toEqual(['pregate-receipt-before-head-report']);
    expect(first.block).toContain('지시가 아니다');
    expect(first.block).toContain('pregate 영수증 없이');
    expect(recallSeatMemoriesForTurn({ seat: 'OP', dir, text: 'PR head 보고하기 전에 pregate 돌렸나?', sessionKey: 's1' })).toBeNull();
    expect(recallSeatMemoriesForTurn({ seat: 'OP', dir, text: '오늘 점심 메뉴 추천해줘', sessionKey: 's2' })).toBeNull();
    expect(recallSeatMemoriesForTurn({ seat: 'OP', dir, text: 'pregate', sessionKey: 's3' })).toBeNull(); // 낱말 1개 = 회상 0
  });

  test('관측 이벤트에 본문이 없다(saved·recalled·index-injected)', () => {
    const dir = temp('noleak');
    saveSeatMemory({ name: 'secret-free-fact', description: '설명 한 줄', type: 'feedback', body: 'BODY-MARKER-o6 pregate 영수증 본문' }, dir, 'OP');
    recallSeatMemoriesForTurn({ seat: 'OP', dir, text: 'secret-free-fact pregate 영수증', sessionKey: 'x' });
    buildSeatMemoryIndexBlock('OP', dir);
    const mem = events.filter(e => e.category === 'memory');
    expect(mem.map(e => e.event)).toEqual(['saved', 'recalled']);
    expect((mem[1]!.data as { names: string[] }).names).toEqual(['secret-free-fact']);
    expect(JSON.stringify(mem)).not.toContain('BODY-MARKER-o6');
  });
});

describe('모델 도구 — 자리 세션에만', () => {
  test('memory_save 를 자리 판으로 바꾸고 delete·search 를 붙인다', async () => {
    const dir = temp('tools');
    const specs: LLMToolSpec[] = [{ name: 'memory_save', description: 'global', parameters: {} }, { name: 'Bash', description: '', parameters: {} }];
    const dispatch = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    applySeatMemoryTools(specs, dispatch, { seat: 'OP', dir });
    expect(specs.map(s => s.name)).toEqual(['memory_save', 'Bash', 'memory_delete', 'memory_search']);
    expect(specs[0]!.description).not.toBe('global');
    expect(await dispatch.get('memory_save')!({ name: 'n1', description: 'd1', type: 'feedback', body: '정정 사항', links: ['n2'] }))
      .toEqual({ saved: true, action: 'created', name: 'n1', file: 'n1.md', seat: 'OP' });
    const found = await dispatch.get('memory_search')!({ query: 'n1 정정' }) as { hits: Array<{ name: string }> };
    expect(found.hits.map(h => h.name)).toEqual(['n1']);
    expect(await dispatch.get('memory_delete')!({ name: 'n1' })).toEqual({ deleted: true, file: 'n1.md' });
  });
});

describe('가져오기 — 원본 읽기 전용 · 기본 미리보기 · 비밀 꼴 거부', () => {
  const source = (): string => {
    const from = temp('cc-src');
    writeFileSync(join(from, 'a-fact.md'), '---\nname: a-fact\ndescription: 사실 A\nmetadata:\n  type: feedback\n---\n\n**Why:** x\n');
    writeFileSync(join(from, 'b-fact.md'), '---\nname: b-fact\ndescription: 사실 B\ntype: project\n---\n\nB 본문\n');
    writeFileSync(join(from, 'leaky.md'), `---\nname: leaky\ndescription: 새는 기억\ntype: reference\n---\n\nkey = ${fakeKey()}\n`);
    writeFileSync(join(from, 'broken.md'), 'no frontmatter\n');
    writeFileSync(join(from, 'MEMORY.md'), '- ⭐[사실 B](b-fact.md) — 손 고른 첫 줄\n- [새는](leaky.md) — 빠져야 한다\n- [사실 A](a-fact.md) — 둘째\n');
    return from;
  };
  const snapshot = (dir: string): string => readdirSync(dir).sort().map(f => `${f}:${statSync(join(dir, f)).mtimeMs}:${readFileSync(join(dir, f), 'utf8')}`).join('\n');

  test('dry-run 은 아무것도 쓰지 않는다 · apply 는 원문 그대로 옮기고 색인 순서를 지킨다', () => {
    const from = source();
    const to = join(temp('dest'), 'seats', 'OP');
    const before = snapshot(from);
    const plan = planSeatMemoryImport({ from, to, seat: 'OP' });
    expect(existsSync(to)).toBe(false);
    expect(plan.files.map(f => [f.file, f.action])).toEqual([['a-fact.md', 'create'], ['b-fact.md', 'create']]);
    expect(plan.skipped).toEqual([{ file: 'broken.md', reason: 'unparsable' }, { file: 'leaky.md', reason: 'secret-pattern' }]);
    const summary = applySeatMemoryImport(plan);
    expect(summary).toMatchObject({ create: 2, update: 0, skipped: 2, refusedNames: ['leaky.md'], applied: true });
    expect(snapshot(from)).toBe(before); // 원본 그대로
    expect(readFileSync(join(to, 'a-fact.md'), 'utf8')).toBe(readFileSync(join(from, 'a-fact.md'), 'utf8'));
    expect(existsSync(join(to, 'leaky.md'))).toBe(false);
    expect(readSeatMemoryIndex(to)).toBe('- ⭐[사실 B](b-fact.md) — 손 고른 첫 줄\n- [사실 A](a-fact.md) — 둘째\n');
    expect(listSeatMemories(to).map(e => [e.name, e.type])).toEqual([['a-fact', 'feedback'], ['b-fact', 'project']]);
    // 다시 돌리면 same · 거부 파일 이름만 이벤트에(본문·키 0).
    expect(planSeatMemoryImport({ from, to, seat: 'OP' }).files.map(f => f.action)).toEqual(['same', 'same']);
    const imported = memoryEvents('imported');
    expect(imported).toHaveLength(1);
    expect(JSON.stringify(imported)).not.toContain(fakeKey());
    expect(JSON.stringify(imported)).not.toContain('**Why:**');
  });

  test('원본과 대상이 겹치면 거부한다', () => {
    const from = source();
    expect(() => planSeatMemoryImport({ from, to: join(from, 'seats', 'OP'), seat: 'OP' })).toThrow();
  });
});
