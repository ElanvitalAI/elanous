import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatFailureNotice, matchFailureText } from '../../self-health/signatures.js';
import { createInternalTurnGate, type StartTurnIfIdleOptions, type StartTurnIfIdleResult } from './internal-turn.js';
import {
  createSeatAutowake,
  decideSeatAutowake,
  parseSeatQueue,
  type SeatAutowakeDeps,
  type SeatAutowakeInput,
} from './seat-autowake.js';

const HOME = '/h';
const OPT_STATE = `${HOME}/elanous-hq/seat-state/OPT`;

const QUEUE_TWO = [
  '# OPT 일감 줄',
  '## 진행',
  '- #38 하는 중',
  '## 대기 (위가 먼저)',
  '- #30 첫 일 — 설명',
  '  이어지는 설명 줄',
  '- ~~#29~~ 폐기됨',
  '- #28 둘째 일',
  '## 끝',
  '- #21 끝난 일',
  '- #20 끝난 일',
].join('\n');

describe('parseSeatQueue — OP #9349 계약', () => {
  test('«## 대기» 아래 «- #N» 줄만 센다 · 취소선 줄과 «## 끝» 아래 줄은 남은 일이 아니다', () => {
    expect(parseSeatQueue(QUEUE_TWO)).toEqual({ known: true, count: 2, head: '#30' });
  });
  test('대기 절이 비었거나 전부 취소선이면 0(알고 있는 0)', () => {
    expect(parseSeatQueue('## 대기\n\n## 끝\n- #1 x')).toEqual({ known: true, count: 0, head: null });
    expect(parseSeatQueue('## 대기\n- ~~#3~~ 끝\n- ~~#4 폐기~~')).toEqual({ known: true, count: 0, head: null });
  });
  test('형식 모름 — 제목 없음 · 줄 꼴 모름 · 파일 없음은 known:false(0 이 아니다)', () => {
    expect(parseSeatQueue('# 일감\n- #1 첫 일')).toEqual({ known: false, reason: 'no-waiting-heading' });
    expect(parseSeatQueue('## 대기\n- 첫 일\n- 둘째 일')).toEqual({ known: false, reason: 'unrecognized-items' });
    expect(parseSeatQueue(null)).toEqual({ known: false, reason: 'absent' });
  });
  test('반증: «## 대기열» 같은 다른 제목은 대기 절이 아니다 · «- #N» 아닌 꼴(«#12abc» · «* #12» · 섞임)은 «모름»', () => {
    expect(parseSeatQueue('## 대기열\n- #1 x')).toEqual({ known: false, reason: 'no-waiting-heading' });
    expect(parseSeatQueue('## 대기\n- #12abc')).toEqual({ known: false, reason: 'unrecognized-items' });
    expect(parseSeatQueue('## 대기\n- #12한글')).toEqual({ known: false, reason: 'unrecognized-items' });
    expect(parseSeatQueue('## 대기\n- #12٣')).toEqual({ known: false, reason: 'unrecognized-items' });
    expect(parseSeatQueue('## 대기\n- #12 한글 · #13—설명\n- #13(괄호)')).toEqual({ known: true, count: 2, head: '#12' });
    expect(parseSeatQueue('## 대기\n* #12 별표 목록')).toEqual({ known: false, reason: 'unrecognized-items' });
    expect(parseSeatQueue('## 대기\n- #7 일\n- 꼴 모를 일')).toEqual({ known: false, reason: 'unrecognized-items' });
    expect(parseSeatQueue('## 대기\n- #7: 일\n- #8')).toEqual({ known: true, count: 2, head: '#7' });
    // 다른 형식의 작업 줄이 섞임(번호 목록 · 맨 #N · 글줄 · 들여 쓴 작업 줄) → 모름.
    for (const odd of ['1. #8 일', '#8 일', '할 일 하나', '  - #9 하위 작업', '  1) #9 하위 작업']) {
      expect(parseSeatQueue(`## 대기\n- #7 일\n${odd}`)).toEqual({ known: false, reason: 'unrecognized-items' });
    }
    // 들여 쓴 설명 줄 · 빈 줄은 이어쓰기로 허용.
    expect(parseSeatQueue('## 대기\n- #7 일\n  설명 줄 — #3 을 참고\n\n- #8')).toEqual({ known: true, count: 2, head: '#7' });
  });
});

function input(over: Partial<SeatAutowakeInput> = {}): SeatAutowakeInput {
  return {
    seat: 'OPT', enabled: true, turnEnded: true,
    unread: { count: 0, maxId: null }, queue: { known: true, count: 2, head: '#30' },
    now: 1_000_000, lastHumanKeyAt: 0, lastFingerprint: null, consecutive: 0,
    ...over,
  };
}

describe('decideSeatAutowake — 순수 판정', () => {
  test('큐 2건 → start-turn · 문면에 우편·큐 수와 확인 명령', () => {
    const d = decideSeatAutowake(input());
    expect(d.action).toBe('start-turn');
    if (d.action !== 'start-turn') return;
    expect(d.reason).toBe('우편 0통 · 큐 2건');
    expect(d.prompt).toContain('[자동 재개] 남은 일: 우편 0통 · 큐 2건 — 이어서 처리');
    expect(d.prompt).toContain('eln msg list --to OPT');
    expect(d.fingerprint).toBe('msg:-|queue:#30');
  });
  test('남은 일 0 → nothing-pending · 자리 아님 → no-seat · 파일 없음 → disabled · 턴 끝 아님 → not-turn-end', () => {
    expect(decideSeatAutowake(input({ queue: { known: true, count: 0, head: null } })).reason).toBe('nothing-pending');
    expect(decideSeatAutowake(input({ seat: null })).reason).toBe('no-seat');
    expect(decideSeatAutowake(input({ enabled: false })).reason).toBe('disabled');
    expect(decideSeatAutowake(input({ turnEnded: false })).reason).toBe('not-turn-end');
  });
  test('큐 형식 모름 → 큐는 건너뛰고(0 아님 · queue:null) 우편만 본다', () => {
    const unknown = { known: false, reason: 'no-waiting-heading' } as const;
    const none = decideSeatAutowake(input({ queue: unknown }));
    expect(none).toEqual({ action: 'skip', reason: 'nothing-pending', unread: 0, queue: null });
    const mail = decideSeatAutowake(input({ queue: unknown, unread: { count: 3, maxId: 9250 } }));
    expect(mail).toMatchObject({ action: 'start-turn', unread: 3, queue: null, reason: '우편 3통 · 큐 모름', fingerprint: 'msg:9250|queue:-' });
  });
  test('같은 오더 → same-order · 연속 K → cap · 사람 입력 30초 안 → human-recent', () => {
    expect(decideSeatAutowake(input({ lastFingerprint: 'msg:-|queue:#30' })).reason).toBe('same-order');
    expect(decideSeatAutowake(input({ consecutive: 5 })).reason).toBe('cap');
    expect(decideSeatAutowake(input({ consecutive: 4 })).action).toBe('start-turn');
    expect(decideSeatAutowake(input({ lastHumanKeyAt: 1_000_000 - 10_000 })).reason).toBe('human-recent');
    expect(decideSeatAutowake(input({ lastHumanKeyAt: 1_000_000 - 31_000 })).action).toBe('start-turn');
  });
});

type Log = { category: string; event: string; data: Record<string, unknown> };

function rig(over: Partial<SeatAutowakeDeps> = {}) {
  const files = new Map<string, string>([[`${OPT_STATE}/autowake`, ''], [`${OPT_STATE}/queue.md`, QUEUE_TWO]]);
  const state = { unread: { count: 0, maxId: null as number | null } as { count: number; maxId: number | null } | null, humanAt: 0, now: 2_000_000 };
  const calls: Array<{ input: string; opts: StartTurnIfIdleOptions }> = [];
  let gateResult: StartTurnIfIdleResult = { opened: true, turnId: 'auto-1' };
  const logs: Log[] = [];
  const notices: string[] = [];
  const deferred: Array<{ fn: () => void; ms: number }> = [];
  const aw = createSeatAutowake({
    startTurnIfIdle: (text, opts) => { calls.push({ input: text, opts }); return gateResult; },
    getCwd: () => `${HOME}/elanous-hq/seats/OPT`,
    home: HOME,
    detectSeat: cwd => (cwd.includes('/seats/OPT') ? { seat: 'OPT', source: 'cwd' } : null),
    isRegularFile: path => files.has(path),
    readText: path => files.get(path) ?? null,
    readUnread: () => state.unread,
    lastHumanKeyAt: () => state.humanAt,
    now: () => state.now,
    notify: line => notices.push(line),
    defer: (fn, ms) => { deferred.push({ fn, ms }); },
    log: (category, event, data) => { logs.push({ category, event, data }); },
    ...over,
  });
  return {
    aw, files, state, calls, logs, notices, deferred,
    setGate: (r: StartTurnIfIdleResult) => { gateResult = r; },
    endTurn: () => { aw.noteTurnEnded(); return aw.check(); },
  };
}

describe('createSeatAutowake — 배선 판정(H2 호출자)', () => {
  const codex400 = (callId: string) => {
    const errorDetail = `Codex API 400: No tool call found for function call output with call_id ${callId}.`;
    return { lastLine: formatFailureNotice(matchFailureText(errorDetail)!, { rawHint: '/detail open' }), errorDetail };
  };

  test('같은 세션·call_id Codex 400 두 번째에서 terminal 1회, 다음 자동 턴 0 · 다른 세션은 계속', () => {
    const r = rig();
    const failure = codex400('call_4eb412c398564aa486d3b17096e5bb7f');
    r.aw.noteTurnEnded({ sessionId: 'broken-session', ...failure });
    expect(r.aw.check()).toMatchObject({ opened: true });
    expect(r.calls).toHaveLength(1);

    // A changed queue would normally open another internal turn. The second
    // identical provider failure must stop that session before the H2 gate.
    r.state.unread = { count: 1, maxId: 42 };
    r.aw.noteTurnEnded({ sessionId: 'broken-session', ...failure });
    expect(r.aw.check()).toMatchObject({ action: 'skip', reason: 'terminal-codex-400' });
    expect(r.calls).toHaveLength(1);
    expect(r.logs.filter(row => row.event === 'terminal')).toEqual([{
      category: 'tui.autowake', event: 'terminal', data: {
        seat: 'OPT', sessionId: 'broken-session', errorKind: 'codex-orphan-tool-output-400',
        callId: 'call_4eb412c398564aa486d3b17096e5bb7f', recommendedAction: '/session new',
      },
    }]);
    expect(r.notices).toHaveLength(1);
    r.aw.noteTurnEnded({ sessionId: 'broken-session', ...failure });
    expect(r.logs.filter(row => row.event === 'terminal')).toHaveLength(1);

    r.aw.noteTurnEnded({ sessionId: 'healthy-session', lastLine: 'response complete' });
    expect(r.aw.check()).toMatchObject({ opened: true });
    expect(r.calls).toHaveLength(2);
  });

  test('서로 다른 call_id와 일시 오류는 누적하지 않는다', () => {
    const r = rig();
    r.aw.noteTurnEnded({ sessionId: 's1', ...codex400('call_a') });
    r.aw.noteTurnEnded({ sessionId: 's1', ...codex400('call_b') });
    r.aw.noteTurnEnded({ sessionId: 's1', lastLine: 'Error: temporary network timeout' });
    r.aw.noteTurnEnded({ sessionId: 's1', ...codex400('call_b') });
    expect(r.logs.filter(row => row.event === 'terminal')).toHaveLength(0);
    expect(r.aw.check()).toMatchObject({ opened: true });
  });

  test('Codex API 400 축약 안내는 /detail 원문의 같은 call_id로 센다', () => {
    const r = rig();
    r.aw.noteTurnEnded({ sessionId: 's1', ...codex400('call_same') });
    r.aw.noteTurnEnded({ sessionId: 's1', ...codex400('call_same') });
    expect(r.aw.check()).toMatchObject({ action: 'skip', reason: 'terminal-codex-400' });
    expect(r.logs.filter(row => row.event === 'terminal')).toHaveLength(1);
    expect(r.calls).toHaveLength(0);
  });

  test('정상 답변의 동일 API 오류 인용문은 종료로 세지 않는다', () => {
    const r = rig();
    const quoted = 'Codex API 400: No tool call found for function call output with call_id call_same.';
    r.aw.noteTurnEnded({ sessionId: 's1', lastLine: quoted });
    r.aw.noteTurnEnded({ sessionId: 's1', lastLine: quoted });
    expect(r.logs.filter(row => row.event === 'terminal')).toHaveLength(0);
    expect(r.aw.check()).toMatchObject({ opened: true });
  });

  test('앞 턴 400 뒤 정상 답변이 축약 안내를 인용해도 이전 /detail 원문을 재사용하지 않는다', () => {
    const r = rig();
    const failure = codex400('call_same');
    r.aw.noteTurnEnded({ sessionId: 's1', ...failure });
    r.aw.noteTurnEnded({ sessionId: 's1', lastLine: failure.lastLine });
    expect(r.logs.filter(row => row.event === 'terminal')).toHaveLength(0);
    expect(r.aw.check()).toMatchObject({ opened: true });
  });

  test('남은 일 있음 → startTurnIfIdle 1회(origin autowake) ⊕ decided 로그', () => {
    const r = rig();
    const d = r.endTurn();
    expect(d).toMatchObject({ action: 'start-turn', opened: true });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.opts).toEqual({ origin: 'autowake', reason: '우편 0통 · 큐 2건' });
    expect(r.calls[0]!.input).toContain('[자동 재개] 남은 일: 우편 0통 · 큐 2건');
    expect(r.logs).toEqual([{ category: 'tui.autowake', event: 'decided', data: {
      seat: 'OPT', unread: 0, queue: 2, fingerprint: 'msg:-|queue:#30', consecutive: 1, opened: true, reason: '우편 0통 · 큐 2건', turnId: 'auto-1',
    } }]);
  });

  test('남은 일 0 → 0회', () => {
    const r = rig();
    r.files.set(`${OPT_STATE}/queue.md`, '## 대기\n## 끝\n- #1 x');
    expect(r.endTurn()).toMatchObject({ action: 'skip', reason: 'nothing-pending' });
    expect(r.calls).toHaveLength(0);
    expect(r.logs[0]).toMatchObject({ event: 'decided', data: { rejected: true, reason: 'nothing-pending' } });
  });

  test('같은 오더 두 번째 → 안 엶 · 오더가 바뀌면(새 우편) 다시 연다', () => {
    const r = rig();
    r.endTurn();
    expect(r.endTurn()).toMatchObject({ action: 'skip', reason: 'same-order' });
    expect(r.calls).toHaveLength(1);
    r.state.unread = { count: 1, maxId: 9300 };
    expect(r.endTurn()).toMatchObject({ action: 'start-turn', opened: true });
    expect(r.calls).toHaveLength(2);
  });

  test('사람 입력 없이 K=5 연속 → cap 이벤트 1회 ⊕ 화면 한 줄 · 사람 키 하나 뒤 다시 연다', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      r.state.unread = { count: 1, maxId: 100 + i }; // 매번 다른 오더
      r.state.now += 1_000;
      expect(r.endTurn()).toMatchObject({ opened: true });
    }
    r.state.unread = { count: 1, maxId: 200 };
    expect(r.endTurn()).toMatchObject({ action: 'skip', reason: 'cap' });
    expect(r.endTurn()).toMatchObject({ action: 'skip', reason: 'cap' });
    expect(r.calls).toHaveLength(5);
    expect(r.logs.filter(l => l.event === 'cap')).toHaveLength(1);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain('사람 확인 필요');
    // 사람 키(조용창 30초도 지난 뒤) → 연속 카운터 0.
    r.state.humanAt = r.state.now + 1;
    r.state.now += 40_000;
    expect(r.endTurn()).toMatchObject({ action: 'start-turn', opened: true });
    expect(r.calls).toHaveLength(6);
  });

  test('큐 형식 모름 → 큐는 건너뜀(0 으로 안 읽음) · 로그에 queueUnknown', () => {
    const r = rig();
    r.files.set(`${OPT_STATE}/queue.md`, '# 형식 다른 큐\n- 할 일');
    expect(r.endTurn()).toMatchObject({ action: 'skip', reason: 'nothing-pending', queue: null });
    expect(r.logs[0]!.data).toMatchObject({ queue: null, queueUnknown: 'no-waiting-heading' });
    r.state.unread = { count: 2, maxId: 9 };
    expect(r.endTurn()).toMatchObject({ action: 'start-turn', reason: '우편 2통 · 큐 모름' });
  });

  test('우편 원장 «모름»(null) → 우편 0통으로 단정하지 않는다 · 큐만으로 열되 문면은 «우편 모름»', () => {
    const r = rig();
    r.state.unread = null;
    const d = r.endTurn();
    expect(d).toMatchObject({ action: 'start-turn', opened: true, unread: null, reason: '우편 모름 · 큐 2건' });
    expect(r.calls[0]!.input).toContain('[자동 재개] 남은 일: 우편 모름 · 큐 2건');
    expect(r.calls[0]!.input).not.toContain('우편 0통');
    expect(r.logs[0]!.data).toMatchObject({ unread: null, queue: 2 });
  });

  test('자리 아님 / autowake 파일 없음 → 0회 ⊕ 로그 0(사람 대화 TUI 비용 0)', () => {
    const noSeat = rig({ getCwd: () => '/tmp/somewhere' });
    expect(noSeat.endTurn()).toMatchObject({ action: 'skip', reason: 'no-seat' });
    const off = rig();
    off.files.delete(`${OPT_STATE}/autowake`);
    expect(off.endTurn()).toMatchObject({ action: 'skip', reason: 'disabled' });
    expect(noSeat.calls.length + off.calls.length).toBe(0);
    expect(noSeat.logs.length + off.logs.length).toBe(0);
  });

  test('seats/<자리>/autowake 도 켬 스위치로 받는다', () => {
    const r = rig();
    r.files.delete(`${OPT_STATE}/autowake`);
    r.files.set(`${HOME}/elanous-hq/seats/OPT/autowake`, '');
    expect(r.endTurn()).toMatchObject({ opened: true });
  });

  test('사람 입력 30초 안 → human-recent · 조용창 뒤 재판정 1회 예약', () => {
    const r = rig();
    r.state.humanAt = r.state.now - 5_000;
    expect(r.endTurn()).toMatchObject({ action: 'skip', reason: 'human-recent' });
    expect(r.calls).toHaveLength(0);
    expect(r.deferred).toHaveLength(1);
    expect(r.deferred[0]!.ms).toBe(25_050);
    r.state.now += 26_000;
    r.deferred[0]!.fn();
    expect(r.calls).toHaveLength(1);
  });

  test('H2 거부 사유는 그대로 로그 · 무장은 남아 다음 마운트에서 다시 잰다', () => {
    const r = rig();
    r.setGate({ opened: false, reason: 'HumanTyping', detail: 'buffer' });
    expect(r.endTurn()).toMatchObject({ opened: false, rejected: 'HumanTyping' });
    expect(r.logs[0]!.data).toMatchObject({ rejected: true, reason: 'HumanTyping', detail: 'buffer' });
    r.setGate({ opened: true, turnId: 'auto-2' });
    expect(r.aw.check()).toMatchObject({ opened: true });
    // 턴 끝이 아니면(부팅·화면 재진입) 열지 않는다.
    expect(r.aw.check()).toMatchObject({ action: 'skip', reason: 'not-turn-end' });
    expect(r.calls).toHaveLength(2);
  });

  test('wrapPort — 턴 끝 뒤 입력칸 마운트에서만 판정 · attach/detach/declined 는 그대로 넘긴다', () => {
    const r = rig();
    const seen: string[] = [];
    const port = r.aw.wrapPort({
      attach: () => { seen.push('attach'); },
      detach: o => { seen.push(`detach:${o?.yielded === true}`); },
      declined: d => { seen.push(`declined:${d}`); },
    });
    port.attach(() => true);
    expect(r.deferred).toHaveLength(0); // 턴 끝 아님 — 판정 0
    r.aw.noteTurnEnded();
    port.attach(() => true);
    expect(r.deferred).toHaveLength(1);
    r.deferred[0]!.fn();
    expect(r.calls).toHaveLength(1);
    port.detach({ yielded: true });
    port.declined?.('buffer');
    expect(seen).toEqual(['attach', 'attach', 'detach:true', 'declined:buffer']);
  });
});

describe('실물 H2 문과 맞물림 — 입력칸 무접촉', () => {
  test('빈 입력칸 → 물러남 1회 ⊕ 요청 origin autowake · 글자 있는 입력칸 → HumanTyping 거부 ⊕ 버퍼 불변', () => {
    let buffer = '';
    let yields = 0;
    const gate = createInternalTurnGate({
      isEnabled: () => true,
      isTurnRunning: () => false,
      getBufferText: () => buffer,
      getTypeaheadCount: () => 0,
      pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0,
      log: () => {},
    });
    const r = rig({ startTurnIfIdle: (text, opts) => gate.startTurnIfIdle(text, opts) });
    const port = r.aw.wrapPort(gate.port);
    r.aw.noteTurnEnded();
    port.attach(() => { if (buffer.length > 0) return false; yields++; return true; });
    r.deferred.shift()!.fn();
    expect(yields).toBe(1);
    expect(gate.takePending()).toMatchObject({ origin: 'autowake', reason: '우편 0통 · 큐 2건' });
    gate.noteTurnSettled();
    port.detach({ yielded: true });
    // 사람이 글자를 넣어 둔 입력칸 — 문이 거부하고 버퍼는 그대로.
    buffer = '사람 글';
    r.state.unread = { count: 1, maxId: 5 };
    r.aw.noteTurnEnded();
    port.attach(() => { if (buffer.length > 0) return false; yields++; return true; });
    r.deferred.shift()!.fn();
    expect(yields).toBe(1);
    expect(buffer).toBe('사람 글');
    expect(r.logs.at(-1)!.data).toMatchObject({ rejected: true, reason: 'HumanTyping' });
  });

  test('모듈은 입력칸 주입 길(injectKey · submit · pty)을 부르지 않는다', () => {
    const src = readFileSync(resolve(import.meta.dir, 'seat-autowake.ts'), 'utf8')
      .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    expect(src).not.toMatch(/injectKey\(|\.submit\(|pty text|routeExternalInput/);
  });
});

describe('대시보드 배선 — 글자로 문다(showDashboard 지역 루프는 단위 시험이 닿지 않는다 · 라이브는 착지 뒤 TF)', () => {
  const src = readFileSync(resolve(import.meta.dir, '../index.ts'), 'utf8');
  test('H2 문으로만 연다 · 턴 정리(finally)에서 무장 · 입력칸 port 를 감싼다', () => {
    expect(src).toContain('startTurnIfIdle: (text, opts) => internalTurnGate.startTurnIfIdle(text, opts),');
    expect(src.match(/seatAutowake\.noteTurnEnded\(\{ sessionId: currentChatPersonaSessionId\(\), lastLine: chatLines\.at\(-1\) \?\? '', errorDetail: failedTurnRaw \?\? undefined \}\);/g)).toHaveLength(1);
    const idleAt = src.indexOf("reportTuiTurn('idle');\n        const failedTurnRaw = autowakeTurnFailureRaw;");
    expect(idleAt).toBeGreaterThan(0);
    expect(src).toContain('autowakeTurnFailureRaw = raw;');
    expect(src).toContain('autowakeTurnFailureRaw = null;');
    expect(src).toContain('internalTurnYield: internalTurnYieldPort,');
  });
});
