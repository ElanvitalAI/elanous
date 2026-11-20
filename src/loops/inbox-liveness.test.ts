import { describe, expect, test } from 'bun:test';
import { inboxLiveness, classifySeatInbox, seatInboxAlivePath, writeInboxBeatAtomic, startInboxHeartbeat } from './inbox-liveness.js';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ID = { host: 'mbp.local', sessionId: 's-1' };
const NOW = Date.parse('2026-11-19T04:00:00Z');
const beat = (over: Record<string, unknown> = {}) => ({ pid: 12345, host: 'mbp.local', sessionId: 's-1', startedAt: '2026-11-19T03:00:00Z', beatAt: new Date(NOW - 89_999).toISOString(), ...over });

describe('inboxLiveness §2b 경계', () => {
  test('live: 89_999ms · 90_000ms(경계 포함)', () => {
    expect(inboxLiveness(beat({ beatAt: new Date(NOW - 89_999).toISOString() }), ID, NOW)).toEqual({ state: 'live', ageMs: 89_999 });
    expect(inboxLiveness(beat({ beatAt: new Date(NOW - 90_000).toISOString() }), ID, NOW)).toEqual({ state: 'live', ageMs: 90_000 });
  });
  test('stale: 90_001ms · 600_000ms(경계 포함)', () => {
    expect(inboxLiveness(beat({ beatAt: new Date(NOW - 90_001).toISOString() }), ID, NOW)).toEqual({ state: 'stale', ageMs: 90_001 });
    expect(inboxLiveness(beat({ beatAt: new Date(NOW - 600_000).toISOString() }), ID, NOW)).toEqual({ state: 'stale', ageMs: 600_000 });
  });
  test('down: 600_001ms 초과', () => {
    expect(inboxLiveness(beat({ beatAt: new Date(NOW - 600_001).toISOString() }), ID, NOW)).toEqual({ state: 'down', ageMs: 600_001 });
  });
  test('future-beat: beatAt이 now보다 미래', () => {
    expect(inboxLiveness(beat({ beatAt: new Date(NOW + 1).toISOString() }), ID, NOW)).toEqual({ state: 'unknown', reason: 'future-beat' });
  });
  test('identity-mismatch: host 불일치', () => {
    expect(inboxLiveness(beat({ host: 'other.local' }), ID, NOW)).toEqual({ state: 'unknown', reason: 'identity-mismatch' });
  });
  test('identity-mismatch: sessionId 불일치(identity에 sessionId 있을 때만 검증)', () => {
    expect(inboxLiveness(beat({ sessionId: 's-2' }), ID, NOW)).toEqual({ state: 'unknown', reason: 'identity-mismatch' });
    expect(inboxLiveness(beat({ sessionId: 's-2' }), { host: 'mbp.local' }, NOW).state).toBe('live');
  });
  test('invalid-beat: pid 누락 · startedAt>beatAt · beat 비객체', () => {
    expect(inboxLiveness(beat({ pid: undefined }), ID, NOW)).toEqual({ state: 'unknown', reason: 'invalid-beat' });
    expect(inboxLiveness(beat({ startedAt: new Date(NOW + 5).toISOString() }), ID, NOW)).toEqual({ state: 'unknown', reason: 'invalid-beat' });
    expect(inboxLiveness('junk', ID, NOW)).toEqual({ state: 'unknown', reason: 'invalid-beat' });
  });
});

describe('classifySeatInbox — 파일 없음 = down', () => {
  test('ENOENT → down/∞', () => {
    expect(classifySeatInbox(join(tmpdir(), 'no-such-inbox-alive'), ID, NOW)).toEqual({ state: 'down', ageMs: Number.POSITIVE_INFINITY });
  });
  test('읽기 실패는 파일 없음으로 오인하지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-read-error-'));
    expect(classifySeatInbox(dir, ID, NOW)).toEqual({ state: 'unknown', reason: 'read-error' });
  });
  test('깨진 JSON → invalid-beat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
    const p = join(dir, 'inbox.alive');
    require('node:fs').writeFileSync(p, '{oops', 'utf8');
    expect(classifySeatInbox(p, ID, NOW)).toEqual({ state: 'unknown', reason: 'invalid-beat' });
  });
  test('정상 beat → live', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
    const p = join(dir, 'inbox.alive');
    require('node:fs').writeFileSync(p, JSON.stringify(beat()), 'utf8');
    expect(classifySeatInbox(p, ID, NOW)).toEqual({ state: 'live', ageMs: 89_999 });
  });
});

describe('seatInboxAlivePath', () => {
  test('SEAT: 접두 제거 · 대문자 정규화', () => {
    expect(seatInboxAlivePath('/root', 'SEAT:tc-h-pool-2')).toBe(join('/root', 'TC-H-POOL-2', 'inbox.alive'));
    expect(seatInboxAlivePath('/root', ' OP ')).toBe(join('/root', 'OP', 'inbox.alive'));
  });
});

describe('writeInboxBeatAtomic — 원자적 쓰기', () => {
  test('tmp 쓰기 → rename 1회 · 디렉터리 생성', () => {
    const writes: string[] = []; const renames: [string, string][] = [];
    const mk = (dir: string) => { require('node:fs').mkdirSync(dir, { recursive: true }); return join(dir, 'inbox.alive'); };
    const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
    const p = mk(dir);
    const fakeWrite = ((_p: string, _b: unknown) => { writes.push(_p); }) as typeof import('node:fs').writeFileSync;
    const fakeRename = ((from: string, to: string) => { renames.push([from, to]); }) as typeof import('node:fs').renameSync;
    writeInboxBeatAtomic(p, { pid: 1 }, fakeWrite, fakeRename);
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toBe(p);
    expect(renames).toEqual([[writes[0], p]]);
  });
  test('실제 fs — 최종 파일에 JSON+개행 존재', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
    const p = join(dir, 'inbox.alive');
    writeInboxBeatAtomic(p, { pid: 7, host: 'h' });
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8').endsWith('\n')).toBe(true);
  });
});

describe('startInboxHeartbeat — 30초 박동', () => {
  test('즉시 1회 + 30_000ms 등록 · stop → cancel · beatAt 갱신', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
    const p = join(dir, 'inbox.alive');
    const fired: number[] = []; const intervals: Array<() => void> = []; let tick = 0;
    let fakeNow = Date.parse('2026-11-19T04:00:00Z');
    const handle = startInboxHeartbeat(p, { pid: 42, host: 'mbp.local', sessionId: 's-1' }, {
      now: () => fakeNow,
      schedule: (fn, ms) => { fired.push(ms); intervals.push(fn); return fn as unknown as ReturnType<typeof setInterval>; },
      cancel: () => { intervals.length = 0; },
    });
    expect(fired).toEqual([30_000]);          // 등록 간격
    expect(intervals).toHaveLength(1);         // 즉시 1회는 timer 아님
    const first = JSON.parse(readFileSync(p, 'utf8'));
    expect(first.pid).toBe(42);
    fakeNow += 30_000;
    (intervals[0] as unknown as () => void)();
    const second = JSON.parse(readFileSync(p, 'utf8'));
    expect(Date.parse(second.beatAt)).toBe(fakeNow);  // beatAt 갱신
    handle.stop();
    expect(intervals).toHaveLength(0);         // cancel 호출
  });
});

// ── OP #93799 sessionId 실측 리터럴 ── 빈 id로는 박동을 쓰지 않는다 · 실측 세션 id로 liveness 판정 live.
describe('startInboxHeartbeat — sessionId 실측(OP #93799)', () => {
  test('① getSessionId 공급 실측 세션 id → beat.sessionId 에 실려 classifySeatInbox 판정 live', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-hb-live-'));
    const p = join(dir, 'inbox.alive');
    const handle = startInboxHeartbeat(p, { pid: 42, host: 'mbp.local', sessionId: '' }, { getSessionId: () => 'sess-77' });
    try {
      const beat = JSON.parse(readFileSync(p, 'utf8')) as { sessionId: string; host: string };
      expect(beat.sessionId).toBe('sess-77'); // identity.sessionId('') 말고 공급원 값
      expect(classifySeatInbox(p, { host: 'mbp.local', sessionId: 'sess-77' }, Date.now()).state).toBe('live');
    } finally { handle.stop(); }
  });

  test('② 세션 id 부재/빈 값 → 박동 미기록 + no-session-id 로그 1회 · id 확정 후 회복해 박동 재개', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-hb-empty-'));
    const p = join(dir, 'inbox.alive');
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
    let supply: string | null = null;
    let fire: (() => void) | null = null;
    const handle = startInboxHeartbeat(p, { pid: 42, host: 'mbp.local', sessionId: '' }, {
      getSessionId: () => supply,
      log: (event, data) => { logs.push({ event, data }); },
      schedule: (fn) => { fire = fn; return fn as unknown as ReturnType<typeof setInterval>; },
      cancel: () => { fire = null; },
    });
    try {
      expect(existsSync(p)).toBe(false); // 빈 id로는 박동 파일이 생기지 않는다
      expect(logs).toEqual([{ event: 'heartbeat-skipped-no-session-id', data: { reason: 'no-session-id', path: p, host: 'mbp.local' } }]);
      supply = 'sess-9'; // 세션 id 확정 → 다음 박동부터 회복
      (fire as unknown as () => void)();
      const beat = JSON.parse(readFileSync(p, 'utf8')) as { sessionId: string };
      expect(beat.sessionId).toBe('sess-9');
      expect(classifySeatInbox(p, { host: 'mbp.local', sessionId: 'sess-9' }, Date.now()).state).toBe('live');
    } finally { handle.stop(); }
  });
});
