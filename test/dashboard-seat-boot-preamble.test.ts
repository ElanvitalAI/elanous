// 🪪 L1 시작 부트 — 자리 부트 카드 자동 주입 ⊕ «## 시작하면» 자동 제출(선택).

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSeatBootSystemMessages,
  describeSeatBoot,
  detectSeat,
  detectSeatTui,
  resetSeatBootCacheForTest,
  startSeatBootConversation,
} from '../src/dashboard/seat-boot-preamble.js';
import { buildDashboardTurnPreamble } from '../src/dashboard/turn-preamble.js';
import { MsgStore } from '../src/msg/msg-store.js';
import { debug } from '../src/debug/log.js';
import type { getUserConfig } from '../src/user-config.js';
import { tuiSourceText } from './helpers/dashboard-source.js';

// llm 블록 없는 부분 config — provider 해석을 안 타게(빈 HOME 게이트에서 NoLlmProvider 로 죽었다).
const fakeConfig = { chat: { conciseness: 'balanced' } } as unknown as ReturnType<typeof getUserConfig>;

let home: string;
let msgPath: string;
let seatCwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'seat-boot-tui-'));
  msgPath = join(home, 'state', 'messages.db');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
  writeFileSync(join(home, 'elanous-hq', 'seat-state', 'OP', 'HANDOFF.md'), '# 직전 인계 제목\n본문은 싣지 않는다\n');
  seatCwd = join(home, 'elanous-hq', 'seats', 'OP');
  mkdirSync(seatCwd, { recursive: true });
  resetSeatBootCacheForTest();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  resetSeatBootCacheForTest();
});

describe('detectSeat — cwd /seats/<자리> → COORD_ID', () => {
  test('cwd 의 seats 경로가 이긴다', () => {
    expect(detectSeat('/h/elanous-hq/seats/op/sub', { COORD_ID: 'OPC' })).toEqual({ seat: 'OP', source: 'cwd' });
  });
  test('seats 경로가 없으면 COORD_ID', () => {
    expect(detectSeat('/h/work/x', { COORD_ID: 'opc' })).toEqual({ seat: 'OPC', source: 'coord-id' });
  });
  test('둘 다 없으면 null', () => {
    expect(detectSeat('/h/work/x', {})).toBeNull();
  });
});

describe('detectSeatTui — 자리 판정 ⊕ seat-state 실재 (TUI-H1-SEAT-GOALLOOP)', () => {
  test('seat-state/<자리> 가 있으면 자리, 없으면 null(사람 대화 TUI)', () => {
    const home = mkdtempSync(join(tmpdir(), 'seat-tui-'));
    try {
      mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OPT'), { recursive: true });
      expect(detectSeatTui('/h/elanous-hq/seats/OPT', { home, env: {} })).toEqual({ seat: 'OPT', source: 'cwd' });
      expect(detectSeatTui('/h/elanous-hq/seats/NOPE', { home, env: {} })).toBeNull();
      expect(detectSeatTui('/h/work/x', { home, env: {} })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test('ENOTDIR 는 «자리 아님», 권한 오류 같은 조회 실패는 던진다 (review r2)', () => {
    const home = mkdtempSync(join(tmpdir(), 'seat-tui-err-'));
    const hq = join(home, 'elanous-hq');
    try {
      mkdirSync(hq, { recursive: true });
      writeFileSync(join(hq, 'seat-state'), 'not a dir');
      expect(detectSeatTui('/h/elanous-hq/seats/OPT', { home, env: {} })).toBeNull();
      rmSync(join(hq, 'seat-state'));
      // 권한 오류는 stat 주입으로 만든다 — root 에서도 같은 단언이 선다(review r3).
      const eacces = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
      expect(() => detectSeatTui('/h/elanous-hq/seats/OPT', { home, env: {}, stat: eacces })).toThrow('EACCES');
      const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
      expect(detectSeatTui('/h/elanous-hq/seats/OPT', { home, env: {}, stat: enoent })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('buildSeatBootSystemMessages — 자리 부트 카드', () => {
  test('자리면 카드 한 장 — 자리·안 읽은 우편 수·HANDOFF 제목(본문 없음)', () => {
    const store = new MsgStore(msgPath);
    try {
      store.post({ from: 'MK', to: 'OP', body: 'secret-body' });
      store.post({ from: 'TC', to: 'OP', body: 'secret-body-2' });
    } finally { store.close(); }
    const msgs = buildSeatBootSystemMessages({ cwd: seatCwd, sessionId: 's1' }, { home, msgPath, env: {} });
    expect(msgs).toHaveLength(1);
    const text = msgs[0]!.content as string;
    expect(text).toContain('너는 이 작업 디렉터리의 OP 자리에서 일한다');
    expect(text).toContain('안 읽은 msg 2 (OP)');
    expect(text).toContain('직전 인계 제목');
    expect(text).not.toContain('secret-body');
    expect(text).not.toContain('본문은 싣지 않는다');
    // contextNow 절은 생략(턴 경로에서 버스를 안 읽는다)
    expect(text).not.toContain('elanous://context-now');
  });

  test('자리가 아니거나 seat-state 가 없으면 주입 0 ⊕ card-skipped 관측', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'dashboard.seat-boot') events.push({ event, data });
    }) as typeof debug.log);
    try {
      expect(buildSeatBootSystemMessages({ cwd: join(home, 'work'), sessionId: 'a' }, { home, msgPath, env: {} })).toEqual([]);
      expect(buildSeatBootSystemMessages({ cwd: join(home, 'seats', 'ZZ'), sessionId: 'b' }, { home, msgPath, env: {} })).toEqual([]);
      buildSeatBootSystemMessages({ cwd: seatCwd, sessionId: 'c' }, { home, msgPath, env: {} });
    } finally { spy.mockRestore(); }
    expect(events.map(e => [e.event, e.data.reason ?? null])).toEqual([
      ['card-skipped', 'no-seat'],
      ['card-skipped', 'no-seat-state'],
      // TUI-SEAT-MEMORY-RECALL — 카드를 만들 때 직전 인계 회상을 한 번 잰다(이 시험엔 손 인계가 없어 hit:false).
      ['memory-recall', null],
      // TUI-SEAT-MEMORY-IMPORT — 세션 시작에 읽기 전용 자리 기억 스냅샷을 한 번 만든다.
      ['memory-import', null],
      ['card-injected', null],
      // TUI-SELFIMPLEMENT-UNDERUSE-MEASURE — 카드를 실은 대화는 의도 승격 흐름도 실었다고 남긴다.
      ['intent.escalate', null],
    ]);
    expect(events[2]!.data).toEqual({ source: null, chars: 0, hit: false });
    expect(events[3]!.data).toEqual(expect.objectContaining({ seat: 'OP', chars: expect.any(Number) }));
    expect(events[4]!.data).toEqual(expect.objectContaining({ seat: 'OP', source: 'cwd', unread: null }));
  });

  test('대화마다 한 번 — 같은 대화는 같은 문면(세션이 많아도 축출 없음), 새 대화(/session new)는 새 카드', () => {
    const first = buildSeatBootSystemMessages({ cwd: seatCwd, sessionId: 's1' }, { home, msgPath, env: {} });
    for (let i = 0; i < 40; i++) buildSeatBootSystemMessages({ cwd: seatCwd, sessionId: `other-${i}` }, { home, msgPath, env: {} });
    const store = new MsgStore(msgPath);
    try { store.post({ from: 'MK', to: 'OP', body: 'x' }); } finally { store.close(); }
    const again = buildSeatBootSystemMessages({ cwd: seatCwd, sessionId: 's1' }, { home, msgPath, env: {} });
    expect(again).toBe(first);
    // 대시보드 ACP sessionId 는 TUI 수명 내내 같다 — 새 대화는 startSeatBootConversation 이 캐시를 비운다.
    startSeatBootConversation({ reason: 'session-new' });
    const fresh = buildSeatBootSystemMessages({ cwd: seatCwd, sessionId: 's1' }, { home, msgPath, env: {} });
    expect(fresh).not.toBe(first);
    expect(fresh[0]!.content as string).toContain('안 읽은 msg 1 (OP)');
  });

  test('부팅 순서 — 유휴 getPreamble → 첫 화면 → boot 시작 → 첫 턴: 카드는 한 번만 만들고 첫 화면과 같은 스냅샷', () => {
    const events: string[] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      if (category === 'dashboard.seat-boot') events.push(event);
    }) as typeof debug.log);
    const deps = { home, msgPath, env: {} };
    try {
      const idle = buildSeatBootSystemMessages({ cwd: seatCwd, sessionId: 'acp-1' }, deps);
      const store = new MsgStore(msgPath);
      try { store.post({ from: 'MK', to: 'OP', body: 'late' }); } finally { store.close(); }
      expect(describeSeatBoot(seatCwd, deps)).toEqual({ seat: 'OP', unread: null });
      startSeatBootConversation({ reason: 'boot' });
      const firstTurn = buildSeatBootSystemMessages({ cwd: seatCwd, sessionId: 'acp-1' }, deps);
      expect(firstTurn).toBe(idle);
    } finally { spy.mockRestore(); }
    expect(events.filter(e => e === 'card-injected')).toHaveLength(1);
  });

  test('describeSeatBoot — 첫 화면 한 줄 재료', () => {
    expect(describeSeatBoot(seatCwd, { home, msgPath, env: {} })).toEqual({ seat: 'OP', unread: null });
    expect(describeSeatBoot(join(home, 'work'), { home, msgPath, env: {} })).toBeNull();
  });
});

describe('buildDashboardTurnPreamble — seatBoot 는 대화형 TUI 호출부만 켠다', () => {
  test('seatBoot 를 안 주면 카드 0(셸 COORD_ID 와 무관)', () => {
    const prev = process.env.COORD_ID;
    process.env.COORD_ID = 'OP';
    try {
      const msgs = buildDashboardTurnPreamble({ userText: 'hi', cwd: seatCwd, userConfig: fakeConfig, sessionId: 'p1', controlEnv: {} });
      expect(msgs.some(m => String(m.content).includes('자리 부트 카드'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.COORD_ID; else process.env.COORD_ID = prev;
    }
  });

  test('seatBoot 를 켜면 캐시 사전 주입 없이 실제 seat-state·우편 원장을 읽어 카드가 실린다', () => {
    writeFileSync(join(home, 'elanous-hq', 'seat-state', 'OP', 'HANDOFF.md'), '# 고유-인계-제목-7f3a\n');
    const store = new MsgStore(msgPath);
    try {
      for (let i = 0; i < 3; i++) store.post({ from: 'MK', to: 'OP', body: `b${i}` });
    } finally { store.close(); }
    const msgs = buildDashboardTurnPreamble({ userText: 'hi', cwd: seatCwd, userConfig: fakeConfig, sessionId: 'p2', seatBoot: { home, msgPath, env: {} }, controlEnv: {} });
    const card = msgs.find(m => String(m.content).includes('자리 부트 카드'));
    expect(card).toBeDefined();
    expect(String(card!.content)).toContain('고유-인계-제목-7f3a');
    expect(String(card!.content)).toContain('안 읽은 msg 3 (OP)');
  });
});

describe('배선 — 대시보드 호출부', () => {
  // 대시보드는 19K 줄 클로저라 단위로 못 띄운다 — 호출부가 빠지면 이 기능이 «조용히» 꺼지므로 문면으로 문다.
  test('/session new·clear 가 새 대화를 알리고, TUI 턴 preamble 두 곳이 seatBoot 를 켠다', () => {
    const handlers = readFileSync(join(import.meta.dir, '../src/dashboard/slash-runtime/dashboard-handlers.ts'), 'utf8');
    const branch = handlers.slice(handlers.indexOf("if (seSub === 'new' || seSub === 'clear')"), handlers.indexOf("if (seSub === 'fork')"));
    expect(branch).toContain("startSeatBootConversation({ reason: seSub === 'new' ? 'session-new' : 'session-clear' })");
    // 동기 — history 를 비운 같은 틱에 세대·캐시를 바꾼다(r5 must-fix).
    expect(branch).not.toContain("await import('../seat-boot-preamble.js')");
    expect(handlers).toContain("import { startSeatBootConversation } from '../seat-boot-preamble.js';");
    const afterClear = branch.slice(branch.indexOf('chatHistory.length = 0'));
    expect(afterClear.slice(0, afterClear.indexOf('startSeatBootConversation(')).includes('await ')).toBe(false);
    const index = tuiSourceText();
    expect(index.match(/seatBoot: true,/g)?.length).toBe(2);
    expect(index).toContain("startSeatBootConversation({ reason: 'boot' })");
  });
});
