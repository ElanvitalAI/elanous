// P2b — 크로스-프로세스 PTY 제어 IPC(SQLite 큐)의 핵심 acceptance. 같은 프로세스에서 요청자↔owner
// round-trip 을 검증한다(upsertPtyManifest 가 owner_pid=process.pid 로 등록하므로 동일 프로세스가 처리).
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';

// ⚠️ manifest/ipc DB 는 ELANOUS_STATE_DIR 스코프 — 실 데이터 오염 방지로 tmp 로 격리(import 前 설정).
// 갈림 ①: 모듈 최상위 설정을 유지한다. elanousStateRoot() 는 호출 시점에 env 를 읽지만
//   이 파일이 불러오는 manifest/ipc 소비자는 첫 db 오픈·import 설정 시점에 루트가 정해져
//   있어야 하고, 같은 폴더 선례(pty-manifest.test.ts · pty-event-log.test.ts)도 import 前 설정이다.
const previousStateDir = process.env.ELANOUS_STATE_DIR;
const stateDir = mkdtempSync(join(tmpdir(), 'pty-ipc-test-'));
process.env.ELANOUS_STATE_DIR = stateDir;

const { migratePtyControlSchema, requestRemotePtyControl, requestRemotePtyControlCapabilities, processPtyControlRequests, resetPtyControlIpcForTesting } = await import('./pty-control-ipc.js');
const { externalWriteProvenance } = await import('./pty-write-provenance.js');
const { upsertPtyManifest, ptyManifestDbPath, getPtyManifest } = await import('./pty-manifest.js');
const { resetPtyEventLogForTesting } = await import('./pty-event-log.js');
const { getPtyControlTarget, registerPtyControlTarget, resetForTesting, setPtyAdapterForTesting, startPty } = await import('./registry.js');
const { createTuiControlTarget, startTuiSelfReport } = await import('../capture/tui-self-report.js');
const { stopPtyRecording } = await import('./pty-recording.js');
const { readFileSync } = await import('node:fs');
const registryIds: string[] = [];

interface FakeHandle {
  isAlive: () => boolean;
  accessMode: 'auto' | 'write' | 'read';
  transitionPolicy: 'open' | 'locked';
  setAccessMode: (m: 'auto' | 'write' | 'read') => boolean;
  canWrite: (actor: 'human' | 'agent') => boolean;
  write: (chars: string, actor: 'human' | 'agent') => void;
  resize: (cols: number, rows: number) => void;
  renderScreen?: () => Promise<string>;
  kill: (signal?: NodeJS.Signals) => void;
}
function fakeHandle(over: Partial<FakeHandle> = {}): FakeHandle {
  const h: FakeHandle = {
    isAlive: () => true, accessMode: 'auto', transitionPolicy: 'open',
    setAccessMode(m) { h.accessMode = m; return true; },
    canWrite: (actor) => h.accessMode === 'write' && actor === 'human',
    write: () => false, resize: () => {}, kill: () => {},
    ...over,
  };
  return h;
}
let n = 0;
const freshId = () => `test-pty-${++n}`;
function register(id: string): void {
  upsertPtyManifest({ id, kind: 'test', cmd: 'test', startedAt: Date.now(), now: Date.now() });
}

// ⚠️ 모듈 스코프에 **하나만** 둔다. 종전엔 F3 describe 안에만 있어서 바깥 테스트가 못 닿았고,
//    그 결과 바깥 테스트들이 run anchor 를 **주변 env 에서 상속**했다 — 하니스 안에서 돌리면
//    통과하고 셸에서 돌리면 실패하는, 우주를 암묵 가정한 테스트다. 복제하면 그 복제본은
//    다시 닿지 않는 곳이 생긴다(P-a′ 선례).
const RUN_ENV = 'ELANOUS_RUN_ID';
function withRunId<T>(runId: string | undefined, fn: () => T): T {
  const prior = process.env[RUN_ENV];
  if (runId === undefined) delete process.env[RUN_ENV]; else process.env[RUN_ENV] = runId;
  try { return fn(); } finally { if (prior === undefined) delete process.env[RUN_ENV]; else process.env[RUN_ENV] = prior; }
}
/** 자식 PTY 를 특정 run 으로 등록 — upsert 가 등록 시점 env 의 run anchor 를 스탬프한다. */
function registerInRun(id: string, runId: string | undefined): void {
  withRunId(runId, () => register(id));
}

beforeEach(() => {
  resetForTesting();
  registryIds.length = 0;
  resetPtyControlIpcForTesting();
});
afterAll(() => {
  // 갈림 ②: 기존 레지스트리/IPC 캐시 정리와 tmp 삭제를 마친 뒤 env 를 복구한다.
  // 한 프로세스에서 다음 시험 파일이 순차로 불려 들어가도 삭제된 tmp 를 보지 않게 한다.
  // 호출 경로 = 이 afterAll (기존 정리 실행 경로). finally 로 앞선 정리가 예외여도 복구한다.
  try {
    resetForTesting();
    registryIds.length = 0;
    setPtyAdapterForTesting(null);
    resetPtyControlIpcForTesting();
    // upsertPtyManifest → appendPtyEvent 가 연 events.db 핸들을 닫는다.
    // env 만 되돌리면 캐시가 삭제된 tmp 를 붙잡아 다음 파일이 빈 원장을 본다.
    resetPtyEventLogForTesting();
    rmSync(stateDir, { recursive: true, force: true });
  } finally {
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
  }
});
function registryHandle(accessMode: 'auto' | 'write', write: (chars: string) => void) {
  setPtyAdapterForTesting(() => ({ pid: 7, write, kill() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) }));
  const handle = startPty({ cmd: 'test', accessMode, detach: true });
  register(handle.id);
  registryIds.push(handle.id);
  return handle;
}

describe('pty-control-ipc round-trip', () => {
  test('record-start and record-stop cross the owner queue and save timed PTY output', async () => {
    let onData: ((chunk: string) => void) | undefined;
    setPtyAdapterForTesting(() => ({ pid: 7, write() {}, kill() {},
      onData(callback) { onData = callback; return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
    }));
    const handle = startPty({ cmd: 'fake', cols: 100, rows: 27 });
    register(handle.id);
    const owner = () => processPtyControlRequests(getPtyControlTarget, () => false);
    const start = requestRemotePtyControl(handle.id, 'record-start', undefined, { timeoutMs: 2000 });
    await Bun.sleep(60); await owner();
    const started = await start;
    expect(started).toEqual({ status: 'success', path: expect.any(String), recordingId: expect.any(String) });
    if (!started.path) throw new Error(`record-start did not return a path: ${JSON.stringify(started)}`);
    const duplicate = requestRemotePtyControl(handle.id, 'record-start', undefined, { timeoutMs: 2000 });
    await Bun.sleep(60); await owner();
    expect(await duplicate).toEqual({ status: 'denied', reason: 'already-recording' });
    const invalid = requestRemotePtyControl(handle.id, 'record-start', { cols: -1, rows: 27 }, { timeoutMs: 2000 });
    await Bun.sleep(60); await owner();
    expect(await invalid).toEqual({ status: 'denied', reason: 'invalid-record-payload' });
    onData?.('hello');
    await Bun.sleep(20);
    onData?.('hello');
    const stop = requestRemotePtyControl(handle.id, 'record-stop', undefined, { timeoutMs: 2000 });
    await Bun.sleep(60); await owner();
    const stopped = await stop;
    expect(stopped).toMatchObject({ status: 'success', path: started.path, bytes: expect.any(Number), durationMs: expect.any(Number) });
    const lines = readFileSync(started.path!, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ version: 2, width: 100, height: 27 });
    expect(lines.slice(1).map((frame) => frame.slice(1))).toEqual([['o', 'hello'], ['o', 'hello']]);
    expect(lines[2][0]).toBeGreaterThan(lines[1][0]);
    expect(stopped.bytes).toEqual(Buffer.byteLength(readFileSync(started.path!, 'utf8'), 'utf8'));
    expect(stopPtyRecording(handle.id)).toEqual({ ok: false, reason: 'not-recording' });
  });

  test('record-start refuses a target whose size is unknown instead of writing a guessed 80x24 header', async () => {
    const id = `tui:${process.pid}`;
    const target = createTuiControlTarget(id, { dims: () => undefined });
    const original = process.stdout.write;
    const unregister = registerPtyControlTarget(target);
    try {
      register(id);
      const start = requestRemotePtyControl(id, 'record-start', undefined, { timeoutMs: 2000 });
      await Bun.sleep(60);
      await processPtyControlRequests(getPtyControlTarget, () => false);
      expect(await start).toEqual({ status: 'denied', reason: 'dimensions-unknown' });
      // A caller-supplied size does not stand in for the owner's unknown one.
      const claimed = requestRemotePtyControl(id, 'record-start', { cols: 200, rows: 50 }, { timeoutMs: 2000 });
      await Bun.sleep(60);
      await processPtyControlRequests(getPtyControlTarget, () => false);
      expect(await claimed).toEqual({ status: 'denied', reason: 'dimensions-unknown' });
      expect(stopPtyRecording(id)).toEqual({ ok: false, reason: 'not-recording' });
    } finally {
      unregister();
      process.stdout.write = original;
    }
  });

  test('foreground TUI owner starts remotely, records stdout and auto-stops on unregister', async () => {
    const id = `tui:${process.pid}`;
    const target = createTuiControlTarget(id, { dims: () => ({ cols: 120, rows: 40 }) });
    const original = process.stdout.write;
    const unregister = registerPtyControlTarget(target);
    try {
      register(id);
      const start = requestRemotePtyControl(id, 'record-start', undefined, { timeoutMs: 2000 });
      await Bun.sleep(60);
      await processPtyControlRequests(getPtyControlTarget, () => false);
      const started = await start;
      if (typeof started.path !== 'string') throw new Error(`invalid cast path: ${JSON.stringify(started)}`);
      const castPath = started.path;
      expect(started).toMatchObject({ status: 'success', path: expect.any(String) });
      const writer = process.stdout.write;
      try {
        process.stdout.write = (() => true) as typeof process.stdout.write;
        writer.call(process.stdout, 'hello');
        // One multibyte character split across two Buffer writes must survive intact.
        const han = Buffer.from('한', 'utf8');
        writer.call(process.stdout, han.subarray(0, 1));
        writer.call(process.stdout, han.subarray(1));
      } finally {
        process.stdout.write = writer;
      }
      unregister();
      expect(process.stdout.write).toBe(original);
      expect(readFileSync(castPath, 'utf8')).toContain('"o","hello"');
      expect(readFileSync(castPath, 'utf8')).toContain('한');
      expect(readFileSync(castPath, 'utf8')).not.toContain('\ufffd');
      expect(JSON.parse(readFileSync(castPath, 'utf8').split('\n')[0]!)).toMatchObject({ width: 120, height: 40 });
      expect(stopPtyRecording(id)).toEqual({ ok: false, reason: 'not-recording' });
    } finally {
      unregister();
      process.stdout.write = original;
    }
  });

  test('input-mouse owner round-trip: adapter output enables click, disables it, and takeover denies it', async () => {
    const written: string[] = [];
    let onData: ((chunk: string) => void) | undefined;
    setPtyAdapterForTesting(() => ({
      pid: 7, write: (chars) => { written.push(chars); }, kill() {},
      onData: (callback) => { onData = callback; return { dispose() {} }; },
      onExit: () => ({ dispose() {} }),
    }));
    const h = startPty({ cmd: 'test', accessMode: 'write', detach: true });
    register(h.id);
    registryIds.push(h.id);
    const click = { x: 10, y: 5, kind: 'click' as const };
    const dispatch = async (payload = click) => {
      const pending = requestRemotePtyControl(h.id, 'input-mouse', payload, { actor: 'human', timeoutMs: 2000 });
      await Bun.sleep(60);
      await processPtyControlRequests(getPtyControlTarget, () => true);
      return pending;
    };
    expect((await dispatch()).reason).toContain('mouse mode is off');
    onData?.('\x1b[?1000;1006h');
    expect(await dispatch()).toEqual({ status: 'success' });
    expect(written).toEqual(['\x1b[<0;10;5M\x1b[<0;10;5m']);
    onData?.('\x1b[?1000l');
    expect((await dispatch()).reason).toContain('mouse mode is off');
    const bad = await dispatch({ x: 0, y: 5, kind: 'click' });
    expect(bad).toEqual({ status: 'denied', reason: 'invalid-mouse-payload' });
    onData?.('\x1b[?1000h');
    h.setAccessMode('auto');
    expect(await dispatch()).toEqual({ status: 'denied', reason: 'write-arbiter' });
    expect(written).toHaveLength(1);
  }, 30_000);

  test('unknown-pty — manifest 미등록 id 는 즉시 unknown-pty', async () => {
    const r = await requestRemotePtyControl(freshId(), 'takeover', 300);
    expect(r.status).toBe('unknown-pty');
  });

  test('takeover — owner 가 처리하면 success + 모드 전이 반영', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'auto' });
    const reqP = requestRemotePtyControl(id, 'takeover', 2000);
    await Bun.sleep(60); // owner 폴 시뮬 前 요청이 pending 으로 안착
    processPtyControlRequests((i) => (i === id ? (h as never) : undefined), (i, a) => { expect(a).toBe('human'); h.setAccessMode('write'); return true; });
    const r = await reqP;
    expect(r.status).toBe('success');
    expect(r.to).toBe('write');
    expect(getPtyManifest(id)?.lastControlAt).toEqual(expect.any(Number));
  });

  // ⭐ 무인 리뷰 must-fix/should-fix(2026-07-29) — snapshot 으로 이 프로세서가 async 가 되면서
  //    느린 renderScreen() 을 await 하는 동안 **다음 폴링이 뒤 요청을 먼저 집을 수** 있었다.
  //    원자적 claim 은 **중복**만 막지 **순서**는 못 막는다(그게 내 첫 반론이 놓친 축이다).
  //    ⇒ in-flight 가드로 직렬화했고, 이 테스트가 그 계약을 고정한다.
  test('직렬화 — 느린 snapshot 중 겹쳐 부른 프로세서가 뒤 요청을 앞지르지 않는다', async () => {
    const slowId = freshId(); register(slowId);
    const fastId = freshId(); register(fastId);
    const order: string[] = [];
    let releaseSlow: (() => void) | null = null;
    const slowScreen = new Promise<string>((res) => { releaseSlow = () => res('slow screen'); });

    const slow = fakeHandle({ accessMode: 'auto' });
    (slow as unknown as { renderScreen: () => Promise<string> }).renderScreen = () => {
      order.push('slow:start');
      return slowScreen.then((v) => { order.push('slow:end'); return v; });
    };
    const fast = fakeHandle({ accessMode: 'auto' });
    (fast as unknown as { renderScreen: () => Promise<string> }).renderScreen = async () => {
      order.push('fast');
      return 'fast screen';
    };

    const slowReq = requestRemotePtyControl(slowId, 'snapshot', 3000);
    await Bun.sleep(60);
    const getHandle = (i: string) => (i === slowId ? (slow as never) : i === fastId ? (fast as never) : undefined);

    const firstPass = processPtyControlRequests(getHandle, () => true);   // slow 를 집고 await 에서 멈춘다
    await Bun.sleep(30);
    const fastReq = requestRemotePtyControl(fastId, 'snapshot', 3000);
    await Bun.sleep(30);
    // ⭐ 겹쳐 부른다 — 직렬화가 없으면 여기서 fast 가 slow 를 앞지른다.
    const secondPass = processPtyControlRequests(getHandle, () => true);
    await Bun.sleep(30);
    expect(order).toEqual(['slow:start']);            // ⛔ 아직 fast 가 돌면 안 된다

    releaseSlow!();
    await firstPass; await secondPass;
    await Bun.sleep(60);
    await processPtyControlRequests(getHandle, () => true);
    const [a, b] = [await slowReq, await fastReq];
    expect(a.status).toBe('success');
    expect(b.status).toBe('success');
    expect(order.indexOf('slow:end')).toBeLessThan(order.indexOf('fast'));   // ⭐ FIFO 유지
  });

  // ⭐ 무인 리뷰 must-fix(2026-07-29) ① — 원격 renderScreen 거부가 프로세서를 통째로
  //    reject 시키면 이 요청 행이 'processing' 인 채 남는다(요청자 타임아웃 · 행 유실).
  test('원격 렌더 거부 — 프로세서가 reject 하지 않고 결과로 정규화한다', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'auto' });
    (h as unknown as { renderScreen: () => Promise<string> }).renderScreen = async () => { throw new Error('emulator exploded'); };
    const reqP = requestRemotePtyControl(id, 'snapshot', 3000);
    await Bun.sleep(60);
    // ⛔ 여기서 reject 면 이 await 이 던지고 테스트가 죽는다 — 그게 이 테스트의 요점이다.
    await processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => true);
    const r = await reqP;
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('screen-render-failed');
  });

  // ⭐ 무인 리뷰 must-fix(2026-07-29) ② — 영원히 pending 인 렌더가 직렬화 가드를 고정하면
  //    **기존 5개 액션까지 영구 차단**된다. 내가 넣은 가드가 만든 새 위험이라 상한이 필수다.
  test('영원한 렌더 — 상한이 걸려 프로세서가 풀리고 다른 액션이 막히지 않는다', async () => {
    const stuckId = freshId(); register(stuckId);
    const otherId = freshId(); register(otherId);
    const stuck = fakeHandle({ accessMode: 'auto' });
    (stuck as unknown as { renderScreen: () => Promise<string> }).renderScreen = () => new Promise<string>(() => { /* 영원히 pending */ });
    const other = fakeHandle({ accessMode: 'auto' });

    const stuckP = requestRemotePtyControl(stuckId, 'snapshot', 20_000);
    await Bun.sleep(60);
    const getHandle = (i: string) => (i === stuckId ? (stuck as never) : i === otherId ? (other as never) : undefined);
    const pass1 = processPtyControlRequests(getHandle, () => true);

    // 상한(5s) 안에 반드시 풀린다 — 안 풀리면 이 await 이 테스트 타임아웃으로 죽는다.
    await pass1;
    const stuckR = await stuckP;
    expect(stuckR.status).toBe('failed');
    expect(stuckR.reason).toBe('screen-render-timeout');

    // ⭐ 그리고 그 뒤 기존 액션이 정상 처리된다(전역 차단이 안 남았다).
    const otherP = requestRemotePtyControl(otherId, 'takeover', 3000);
    await Bun.sleep(60);
    await processPtyControlRequests(getHandle, () => { other.setAccessMode('write'); return true; });
    expect((await otherP).status).toBe('success');
  }, 15_000);

  test('takeover then release restores the original read mode', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'read' });
    const takeover = requestRemotePtyControl(id, 'takeover', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => h.setAccessMode('write'));
    await expect(takeover).resolves.toMatchObject({ status: 'success', from: 'read', to: 'write' });
    const release = requestRemotePtyControl(id, 'release', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => true);
    await expect(release).resolves.toMatchObject({ status: 'success', from: 'write', to: 'read' });
    expect(h.accessMode).toBe('read');
  });

  test('expired takeover restores the original mode, logs it, and leaves release with no loan', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'read' });
    const takeover = requestRemotePtyControl(id, 'takeover', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => h.setAccessMode('write'), { now: () => 1_000, takeoverTtlMs: 30_000 });
    await expect(takeover).resolves.toMatchObject({ status: 'success', to: 'write' });

    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as typeof debug.log;
    try {
      await processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => true, { now: () => 61_000, takeoverTtlMs: 30_000 });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(h.accessMode).toBe('read');
    expect(events).toContainEqual({ category: 'pty.takeover', event: 'takeover-expired', data: { id, from: 'write', to: 'read', heldMs: 60_000 } });

    const release = requestRemotePtyControl(id, 'release', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => true);
    await expect(release).resolves.toMatchObject({ status: 'denied', reason: 'no-takeover-to-release' });
  });

  test('takeover remains active before its TTL and preserves its first timestamp across repeated takeovers', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'read' });
    const first = requestRemotePtyControl(id, 'takeover', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => h.setAccessMode('write'), { now: () => 1_000, takeoverTtlMs: 30_000 });
    await first;
    const second = requestRemotePtyControl(id, 'takeover', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => true, { now: () => 10_000, takeoverTtlMs: 30_000 });
    await second;
    const database = new Database(ptyManifestDbPath());
    try {
      expect(database.query('SELECT previous_mode, taken_over_at FROM pty_takeover_previous_modes WHERE pty_id=?').get(id)).toEqual({ previous_mode: 'read', taken_over_at: 1_000 });
    } finally {
      database.close();
    }
    await processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => true, { now: () => 11_000, takeoverTtlMs: 30_000 });
    expect(h.accessMode).toBe('write');
  });

  test('legacy zero timestamp is retained, while expired invalid and denied loans log and remain', async () => {
    const legacyId = freshId(); register(legacyId);
    const invalidId = freshId(); register(invalidId);
    const deniedId = freshId(); register(deniedId);
    const legacy = fakeHandle({ accessMode: 'write' });
    const invalid = fakeHandle({ accessMode: 'write' });
    const denied = fakeHandle({ accessMode: 'write', setAccessMode: () => false });
    const database = new Database(ptyManifestDbPath());
    try {
      database.run('INSERT INTO pty_takeover_previous_modes (pty_id, previous_mode, taken_over_at) VALUES (?, ?, ?)', [legacyId, 'read', 0]);
      database.run('INSERT INTO pty_takeover_previous_modes (pty_id, previous_mode, taken_over_at) VALUES (?, ?, ?)', [invalidId, 'corrupt-mode', 1]);
      database.run('INSERT INTO pty_takeover_previous_modes (pty_id, previous_mode, taken_over_at) VALUES (?, ?, ?)', [deniedId, 'read', 1]);
    } finally {
      database.close();
    }
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((_category: string, event: string, data: Record<string, unknown>) => {
      events.push({ event, data });
    }) as typeof debug.log;
    try {
      await processPtyControlRequests((id) => id === legacyId ? (legacy as never) : id === invalidId ? (invalid as never) : id === deniedId ? (denied as never) : undefined, () => true, { now: () => Number.MAX_SAFE_INTEGER, takeoverTtlMs: 1 });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(legacy.accessMode).toBe('write');
    expect(events).toContainEqual({ event: 'takeover-expire-denied', data: { id: invalidId, reason: 'invalid-previous-mode' } });
    expect(events).toContainEqual({ event: 'takeover-expire-denied', data: { id: deniedId, reason: 'transition-policy' } });
    const remaining = new Database(ptyManifestDbPath());
    try {
      expect(remaining.query('SELECT pty_id FROM pty_takeover_previous_modes WHERE pty_id IN (?, ?, ?)').all(legacyId, invalidId, deniedId)).toEqual(expect.arrayContaining([{ pty_id: legacyId }, { pty_id: invalidId }, { pty_id: deniedId }]));
    } finally {
      remaining.close();
    }
  });

  test('takeover timestamp migration is idempotent and invalid explicit TTL overrides ignore a valid environment TTL', async () => {
    const legacy = new Database(':memory:');
    legacy.run('CREATE TABLE pty_control_requests (request_id TEXT PRIMARY KEY, pty_id TEXT NOT NULL, action TEXT NOT NULL, owner_pid INTEGER NOT NULL, status TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    legacy.run('CREATE TABLE pty_takeover_previous_modes (pty_id TEXT PRIMARY KEY, previous_mode TEXT NOT NULL)');
    migratePtyControlSchema(legacy); migratePtyControlSchema(legacy);
    expect(legacy.query("SELECT name FROM pragma_table_info('pty_takeover_previous_modes') WHERE name='taken_over_at'").get()).not.toBeNull();
    legacy.close();

    const prior = process.env.ELANOUS_PTY_TAKEOVER_TTL_MS;
    process.env.ELANOUS_PTY_TAKEOVER_TTL_MS = '1';
    try {
      for (const takeoverTtlMs of [0, -1, Number.NaN]) {
        const id = freshId(); register(id);
        const h = fakeHandle({ accessMode: 'write' });
        const database = new Database(ptyManifestDbPath());
        try {
          database.run('INSERT INTO pty_takeover_previous_modes (pty_id, previous_mode, taken_over_at) VALUES (?, ?, ?)', [id, 'read', 1]);
        } finally {
          database.close();
        }
        await processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => true, { now: () => 2, takeoverTtlMs });
        expect(h.accessMode).toBe('write');
      }

      const envId = freshId(); register(envId);
      const envHandle = fakeHandle({ accessMode: 'write' });
      const database = new Database(ptyManifestDbPath());
      try {
        database.run('INSERT INTO pty_takeover_previous_modes (pty_id, previous_mode, taken_over_at) VALUES (?, ?, ?)', [envId, 'read', 1]);
      } finally {
        database.close();
      }
      await processPtyControlRequests((i) => i === envId ? (envHandle as never) : undefined, () => true, { now: () => 2 });
      expect(envHandle.accessMode).toBe('read');
    } finally {
      if (prior === undefined) delete process.env.ELANOUS_PTY_TAKEOVER_TTL_MS; else process.env.ELANOUS_PTY_TAKEOVER_TTL_MS = prior;
    }
  });

  test('release without takeover is denied without changing the mode', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'write' });
    const release = requestRemotePtyControl(id, 'release', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => true);
    await expect(release).resolves.toMatchObject({ status: 'denied', reason: 'no-takeover-to-release', from: 'write' });
    expect(h.accessMode).toBe('write');
  });

  test('corrupt saved previous mode is denied without changing the active mode', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'read' });
    const takeover = requestRemotePtyControl(id, 'takeover', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => h.setAccessMode('write'));
    await expect(takeover).resolves.toMatchObject({ status: 'success', to: 'write' });

    const database = new Database(ptyManifestDbPath());
    try {
      expect(database.run('UPDATE pty_takeover_previous_modes SET previous_mode=? WHERE pty_id=?', ['corrupt-mode', id]).changes).toBe(1);
    } finally {
      database.close();
    }

    const release = requestRemotePtyControl(id, 'release', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => true);
    await expect(release).resolves.toMatchObject({ status: 'denied', reason: 'invalid-previous-mode', from: 'write' });
    expect(h.accessMode).toBe('write');
  });

  test('denied release keeps its saved previous mode for a later successful retry', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'auto' });
    const takeover = requestRemotePtyControl(id, 'takeover', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => h.setAccessMode('write'));
    await takeover;
    h.setAccessMode = () => false;
    const denied = requestRemotePtyControl(id, 'release', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => true);
    await expect(denied).resolves.toMatchObject({ status: 'denied', reason: 'transition-policy', from: 'write' });
    h.setAccessMode = (mode) => { h.accessMode = mode; return true; };
    const retry = requestRemotePtyControl(id, 'release', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => true);
    await expect(retry).resolves.toMatchObject({ status: 'success', to: 'auto' });
  });

  test('denied — transition-policy 거부면 denied', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ transitionPolicy: 'locked', setAccessMode: () => false });
    const reqP = requestRemotePtyControl(id, 'takeover', 2000);
    await Bun.sleep(60);
    processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => false); // takeover 거부
    const r = await reqP;
    expect(r.status).toBe('denied');
  });

  test('timeout — owner 가 처리하지 않으면 owner-unreachable', async () => {
    const id = freshId(); register(id);
    const r = await requestRemotePtyControl(id, 'takeover', 200); // 아무도 process 안 함
    expect(r.status).toBe('owner-unreachable');
  });

  test('race 해소 — 요청자가 타임아웃 취소한 요청은 owner 가 mutation 하지 않는다(불일치 없음)', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'auto' });
    let mutated = false;
    // 요청자가 먼저 타임아웃 → pending 조건부 DELETE 로 취소(claim 前). owner 가 뒤늦게 폴해도 행이 없어
    // claim/mutation 하지 않는다 — 요청자가 받은 owner-unreachable 과 실제 상태(불변)가 일치한다.
    const r = await requestRemotePtyControl(id, 'takeover', 30);
    expect(r.status).toBe('owner-unreachable');
    processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => { mutated = true; h.setAccessMode('write'); return true; });
    expect(mutated).toBe(false);
    expect(h.accessMode).toBe('auto'); // 모드 불변 — 취소가 실제로 mutation 을 막았다
  });

  test('owner 가 처리하는데 handle 이 죽었으면 unknown-pty', async () => {
    const id = freshId(); register(id);
    const reqP = requestRemotePtyControl(id, 'takeover', 2000);
    await Bun.sleep(60);
    processPtyControlRequests((i) => (i === id ? (fakeHandle({ isAlive: () => false }) as never) : undefined), () => true);
    const r = await reqP;
    expect(r.status).toBe('unknown-pty');
  });

  test('snapshot reports screen-unavailable when its owner has no renderer', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'auto' });
    (h as unknown as { renderScreen?: undefined }).renderScreen = undefined;
    const request = requestRemotePtyControl(id, 'snapshot', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => false);
    await expect(request).resolves.toEqual({ status: 'failed', reason: 'screen-unavailable' });
  });

  test('snapshot reads the remote screen without an arbiter transition or payload', async () => {
    const id = freshId(); register(id);
    let takeoverCalls = 0;
    const h = fakeHandle({
      accessMode: 'auto',
      renderScreen: async () => 'approval modal\n[y]es [n]o',
    });
    const request = requestRemotePtyControl(id, 'snapshot', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => { takeoverCalls++; return false; });
    await expect(request).resolves.toEqual({ status: 'success', screen: 'approval modal\n[y]es [n]o', source: 'live' });
    expect(h.accessMode).toBe('auto');
    expect(takeoverCalls).toBe(0);
  });

  test('input은 auto에서 denied, takeover 뒤 human write로 전달된다', async () => {
    const writes: string[] = [];
    const h = registryHandle('auto', (chars) => { writes.push(chars); });
    const denied = requestRemotePtyControl(h.id, 'input-text', { chars: 'secret' }, 2000);
    await Bun.sleep(60); processPtyControlRequests((i) => i === h.id ? h : undefined, () => false);
    await expect(denied).resolves.toMatchObject({ status: 'denied', reason: 'write-arbiter' });
    expect(writes).toEqual([]);

    const takeover = requestRemotePtyControl(h.id, 'takeover', 2000);
    await Bun.sleep(60); processPtyControlRequests((i) => i === h.id ? h : undefined, (i, actor) => i === h.id && actor === 'human' && h.setAccessMode('write'));
    await expect(takeover).resolves.toMatchObject({ status: 'success', to: 'write' });
    const input = requestRemotePtyControl(h.id, 'input-text', { chars: 'ok' }, 2000);
    await Bun.sleep(60); processPtyControlRequests((i) => i === h.id ? h : undefined, () => false);
    await expect(input).resolves.toMatchObject({ status: 'success' });
    expect(writes).toEqual(['ok']);
  });

  test('adapter write failures are failed, not arbiter denials', async () => {
    const h = registryHandle('write', () => { throw new Error('closed fd'); });
    const req = requestRemotePtyControl(h.id, 'input-text', { chars: 'secret' }, 2000);
    await Bun.sleep(60); processPtyControlRequests((i) => i === h.id ? h : undefined, () => false);
    await expect(req).resolves.toMatchObject({ status: 'write-failed', reason: 'adapter-write' });
  });

  // ⛔⭐⭐⭐ 외부 쓰기 출처 — `RUN-S25`(밖에서 쓴 문장이 자식의 완료 선언으로 읽힌다)의 «관측» 층.
  //   ⚠️ 판정을 바꾸지 않는다. 바꾸는 것은 「사후에 셀 수 있나」뿐이다.
  describe('externalWriteProvenance', () => {
    test('쓴 적이 없으면 undefined — 호출자가 절을 «생략»할 수 있다', () => {
      expect(externalWriteProvenance(freshId())).toBeUndefined();
    });

    test('성공한 외부 쓰기만 센다 — 거부·실패는 «안» 센다', async () => {
      // ⓐ 거부(auto 모드) — 자식은 아무것도 «못 봤다»
      const denied = registryHandle('auto', () => { /* 도달 안 함 */ });
      const d = requestRemotePtyControl(denied.id, 'input-text', { chars: 'nope' }, 2000);
      await Bun.sleep(60); processPtyControlRequests((i) => i === denied.id ? denied : undefined, () => false);
      await expect(d).resolves.toMatchObject({ status: 'denied' });
      expect(externalWriteProvenance(denied.id)).toBeUndefined();

      // ⓑ 어댑터 실패 — 역시 «못 봤다»
      const failed = registryHandle('write', () => { throw new Error('closed fd'); });
      const f = requestRemotePtyControl(failed.id, 'input-text', { chars: 'nope' }, 2000);
      await Bun.sleep(60); processPtyControlRequests((i) => i === failed.id ? failed : undefined, () => false);
      await expect(f).resolves.toMatchObject({ status: 'write-failed' });
      expect(externalWriteProvenance(failed.id)).toBeUndefined();

      // ⓒ 성공 — 이때만 센다
      const ok = registryHandle('write', () => { /* 성공 */ });
      const o = requestRemotePtyControl(ok.id, 'input-text', { chars: 'GOAL-COMPLETE' }, 2000);
      await Bun.sleep(60); processPtyControlRequests((i) => i === ok.id ? ok : undefined, () => false);
      await expect(o).resolves.toMatchObject({ status: 'success' });
      expect(externalWriteProvenance(ok.id)).toMatchObject({ externalWrites: 1 });
    });

    // ⛔⭐⭐⭐ `[S]` 리뷰(2026-08-07)가 잡은 구멍 — 종전 계기는 **크로스-프로세스 IPC 층**에만 있어
    //   ***같은 프로세스에서 핸들에 직접 쓰면 안 세졌다.*** 정작 감독(autoAssist)이 그 경로다.
    //   ⇒ 계기를 `registry.write`(진짜 초크포인트)로 옮겼다. 이 검사가 그것을 못 박는다.
    test('⭐ 같은 프로세스에서 «핸들에 직접» 써도 세어진다 (IPC 경유 아님)', () => {
      const h = registryHandle('write', () => { /* 성공 */ });
      expect(externalWriteProvenance(h.id)).toBeUndefined();
      h.write('GOAL-COMPLETE\r', 'human');           // ⛔ requestRemotePtyControl 을 «안» 쓴다
      expect(externalWriteProvenance(h.id)).toMatchObject({ externalWrites: 1, externalWriteActor: 'human' });
    });

    test('⛔ 중재가 «거부»한 직접 쓰기는 안 세어진다 (자식이 못 봤다)', () => {
      // ⚠️ `auto` 는 **자율(agent)이 쓰는** 모드다 — 거부되는 쪽은 `human` 이다(접근 매트릭스).
      //   첫 판은 반대로 알고 `agent` 로 썼다가 «세어져서» 틀렸다. 실측대로 고쳤다.
      const h = registryHandle('auto', () => { /* 도달 안 함 */ });
      h.write('nope', 'human');
      expect(externalWriteProvenance(h.id)).toBeUndefined();
    });

    test('여러 번 쓰면 누적되고 «마지막» 시각을 낸다', async () => {
      const h = registryHandle('write', () => { /* 성공 */ });
      for (const chars of ['a', 'b', 'c']) {
        const r = requestRemotePtyControl(h.id, 'input-text', { chars }, 2000);
        await Bun.sleep(60); processPtyControlRequests((i) => i === h.id ? h : undefined, () => false);
        await expect(r).resolves.toMatchObject({ status: 'success' });
      }
      const prov = externalWriteProvenance(h.id, Date.now() + 5_000);
      expect(prov?.externalWrites).toBe(3);
      expect(prov?.externalWriteAgoMs).toBeGreaterThanOrEqual(5_000);
    });
  });

  test('TUI self-report registers its control target, polls the request, and injects requested text', async () => {
    const id = freshId();
    const injected: string[] = [];
    const target = createTuiControlTarget(id, {
      splitKeys: (chars) => [...chars].map((name) => ({ name, ctrl: false, shift: false })),
      injectKey: (key) => { injected.push(key.name); return true; },
    });
    const stop = startTuiSelfReport({
      surfaceId: id,
      createControlTarget: () => target,
      createMirror: () => null,
      register: () => {},
      registerRow: () => register(id),
      publishFrame: () => {},
      writeFrame: () => {},
      writeScreen: () => {},
      heartbeat: () => {},
      markClosed: () => {},
      onExit: () => {},
    });
    expect(getPtyControlTarget(id)).toBe(target);
    await expect(requestRemotePtyControl(id, 'input-text', { chars: 'hi' }, 2000)).resolves.toEqual({ status: 'success' });
    expect(injected).toEqual(['h', 'i']);
    stop();
    expect(getPtyControlTarget(id)).toBeUndefined();
  });

  test('TUI input-key decodes terminal bytes into the corresponding named key', async () => {
    const id = freshId();
    register(id);
    const injected: string[] = [];
    const unregister = registerPtyControlTarget(createTuiControlTarget(id, {
      injectKey: (key) => { injected.push(key.name); return true; },
    }));
    const request = requestRemotePtyControl(id, 'input-key', { chars: '\x1b[A' }, 2000);
    await Bun.sleep(60);
    processPtyControlRequests(getPtyControlTarget, () => false);
    await expect(request).resolves.toEqual({ status: 'success' });
    expect(injected).toEqual(['up']);
    unregister();
  });

  test('TUI raw-mode refusal settles as write-failed and never reports success', async () => {
    const id = freshId();
    register(id);
    const unregister = registerPtyControlTarget(createTuiControlTarget(id, {
      splitKeys: () => [{ name: 'x', ctrl: false, shift: false }],
      injectKey: () => false,
    }));
    const request = requestRemotePtyControl(id, 'input-text', { chars: 'x' }, 2000);
    await Bun.sleep(60);
    processPtyControlRequests(getPtyControlTarget, () => false);
    await expect(request).resolves.toMatchObject({ status: 'write-failed', reason: 'adapter-write' });
    unregister();
  });

  test('TUI injection exception settles as write-failed rather than remaining pending', async () => {
    const id = freshId();
    register(id);
    const unregister = registerPtyControlTarget(createTuiControlTarget(id, {
      splitKeys: () => [{ name: 'x', ctrl: false, shift: false }],
      injectKey: () => { throw new Error('injection failed'); },
    }));
    const request = requestRemotePtyControl(id, 'input-text', { chars: 'x' }, 2000);
    await Bun.sleep(60);
    processPtyControlRequests(getPtyControlTarget, () => false);
    await expect(request).resolves.toMatchObject({ status: 'write-failed', reason: 'adapter-write' });
    unregister();
  });

  test('TUI target retains arbiter denial and does not inject for an agent actor', async () => {
    const id = freshId();
    // ⚠️ Declare the run universe instead of inheriting it. Without this the
    // request carries whatever `ELANOUS_RUN_ID` the surrounding process happens
    // to have: inside the harness it matches and the arbiter is what denies
    // (what this test is about), in a plain shell it is empty and the request
    // is rejected earlier as `agent-run-unidentified` — so the test passed in
    // one environment and failed in the other while asserting nothing about
    // that difference.
    registerInRun(id, 'run-tui-arbiter');
    let injections = 0;
    const unregister = registerPtyControlTarget(createTuiControlTarget(id, {
      splitKeys: () => [{ name: 'x', ctrl: false, shift: false }],
      injectKey: () => { injections++; return true; },
    }));
    const request = withRunId('run-tui-arbiter', () =>
      requestRemotePtyControl(id, 'input-text', { chars: 'x' }, { actor: 'agent', timeoutMs: 2000 }));
    await Bun.sleep(60);
    processPtyControlRequests(getPtyControlTarget, () => false);
    await expect(request).resolves.toMatchObject({ status: 'denied', reason: 'write-arbiter' });
    expect(injections).toBe(0);
    unregister();
  });

  test('resize payload reaches owner after takeover and payload migration is idempotent for legacy table', async () => {
    const legacy = new Database(':memory:');
    legacy.run('CREATE TABLE pty_control_requests (request_id TEXT PRIMARY KEY, pty_id TEXT NOT NULL, action TEXT NOT NULL, owner_pid INTEGER NOT NULL, status TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    migratePtyControlSchema(legacy); migratePtyControlSchema(legacy);
    expect(legacy.query("SELECT name FROM pragma_table_info('pty_control_requests') WHERE name='payload_json'").get()).not.toBeNull();
    legacy.close();

    const id = freshId(); register(id); const resized: Array<[number, number]> = [];
    const h = fakeHandle({ accessMode: 'write', resize: (cols, rows) => resized.push([cols, rows]) });
    const req = requestRemotePtyControl(id, 'resize', { cols: 120, rows: 40 }, 2000);
    await Bun.sleep(60); processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => false);
    await expect(req).resolves.toMatchObject({ status: 'success' });
    expect(resized).toEqual([[120, 40]]);
  });

  test('auto resize is denied without calling resize, then takeover permits the same request', async () => {
    const id = freshId(); register(id); const resized: Array<[number, number]> = [];
    const h = fakeHandle({ resize: (cols, rows) => resized.push([cols, rows]) });
    const denied = requestRemotePtyControl(id, 'resize', { cols: 120, rows: 40 }, 2000);
    await Bun.sleep(60); processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => false);
    await expect(denied).resolves.toEqual({ status: 'denied', reason: 'write-arbiter' });
    expect(resized).toEqual([]);

    const takeover = requestRemotePtyControl(id, 'takeover', 2000);
    await Bun.sleep(60); processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => h.setAccessMode('write'));
    await expect(takeover).resolves.toMatchObject({ status: 'success', to: 'write' });
    const allowed = requestRemotePtyControl(id, 'resize', { cols: 120, rows: 40 }, 2000);
    await Bun.sleep(60); processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => false);
    await expect(allowed).resolves.toEqual({ status: 'success' });
    expect(resized).toEqual([[120, 40]]);
  });

  test('resize exceptions settle as failed instead of remaining processing', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'write', resize: () => { throw new Error('adapter internals'); } });
    const req = requestRemotePtyControl(id, 'resize', { cols: 120, rows: 40 }, 2000);
    await Bun.sleep(60);
    processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => false);
    await expect(req).resolves.toEqual({ status: 'failed', reason: 'resize-error' });
  });

  test('capabilities are reported by the responding owner and permit a following rename', async () => {
    const handle = registryHandle('write', () => {});
    const owner = () => processPtyControlRequests(getPtyControlTarget, () => false);

    const capabilityRequest = requestRemotePtyControlCapabilities(handle.id, { timeoutMs: 2000 });
    await Bun.sleep(60); await owner();
    const capabilities = await capabilityRequest;
    expect(capabilities.status).toBe('success');
    if (capabilities.status !== 'success') throw new Error('expected owner capability list');
    expect(capabilities.actions).toContain('rename');

    const renamed = requestRemotePtyControl(handle.id, 'rename', { nickname: 'capability-owner' }, 2000);
    await Bun.sleep(60); await owner();
    await expect(renamed).resolves.toEqual({ status: 'success' });
    expect(handle.nickname).toBe('capability-owner');
  });

  test('capability query preserves a newer owner action unknown to the requester', async () => {
    const id = freshId(); register(id);
    const request = requestRemotePtyControlCapabilities(id, { timeoutMs: 2000 });
    await Bun.sleep(60);
    expect(settlePendingCapability({ status: 'success', actions: ['rename', 'future-owner-action'] })).toBe(1);
    await expect(request).resolves.toEqual({ status: 'success', actions: ['rename', 'future-owner-action'] });
  });

  test('capability query distinguishes a legacy rejection from an unresponsive owner', async () => {
    const legacyId = freshId(); register(legacyId);
    const legacy = requestRemotePtyControlCapabilities(legacyId, { timeoutMs: 2000 });
    await Bun.sleep(60);
    expect(patchPendingAction('legacy-capabilities')).toBe(1);
    await processPtyControlRequests((id) => id === legacyId ? (fakeHandle() as never) : undefined, () => false);
    await expect(legacy).resolves.toEqual({ status: 'unsupported' });

    const unavailableId = freshId(); register(unavailableId);
    await expect(requestRemotePtyControlCapabilities(unavailableId, { timeoutMs: 200 })).resolves.toEqual({ status: 'no-response' });
  });

  test('capability query preserves owner errors and marks malformed replies as protocol errors', async () => {
    const unknownId = freshId(); register(unknownId);
    const unknown = requestRemotePtyControlCapabilities(unknownId, { timeoutMs: 2000 });
    await Bun.sleep(60);
    await processPtyControlRequests(() => undefined, () => false);
    await expect(unknown).resolves.toEqual({ status: 'owner-result', result: { status: 'unknown-pty' } });

    const rejectedId = freshId(); register(rejectedId);
    const rejected = requestRemotePtyControlCapabilities(rejectedId, { timeoutMs: 2000 });
    await Bun.sleep(60);
    expect(patchPendingAction('resize')).toBe(1);
    await processPtyControlRequests((id) => id === rejectedId ? (fakeHandle() as never) : undefined, () => false);
    await expect(rejected).resolves.toEqual({ status: 'owner-result', result: { status: 'denied', reason: 'invalid-payload' } });

    const malformedId = freshId(); register(malformedId);
    const malformed = requestRemotePtyControlCapabilities(malformedId, { timeoutMs: 2000 });
    await Bun.sleep(60);
    expect(settlePendingCapability({ status: 'success', actions: ['rename', 42] })).toBe(1);
    await expect(malformed).resolves.toEqual({ status: 'protocol-error', result: { status: 'success', actions: ['rename', 42] } });
  });

  test('terminate is advertised by the owner, kills the registry target, and leaves it not alive', async () => {
    let signal: string | undefined;
    let exit: ((event: { exitCode: number | null; signal?: number }) => void) | undefined;
    setPtyAdapterForTesting(() => ({
      pid: 7,
      write() {},
      kill: (nextSignal) => { signal = nextSignal; exit?.({ exitCode: null }); },
      onData: () => ({ dispose() {} }),
      onExit: (listener) => { exit = listener; return { dispose() {} }; },
    }));
    const handle = startPty({ cmd: 'test', detach: true });
    register(handle.id);
    registryIds.push(handle.id);
    const owner = () => processPtyControlRequests(getPtyControlTarget, () => false);

    const capabilities = requestRemotePtyControlCapabilities(handle.id, { timeoutMs: 2000 });
    await Bun.sleep(60); await owner();
    await expect(capabilities).resolves.toMatchObject({ status: 'success', actions: expect.arrayContaining(['terminate']) });

    const terminated = requestRemotePtyControl(handle.id, 'terminate', 2000);
    await Bun.sleep(60); await owner();
    await expect(terminated).resolves.toEqual({ status: 'success' });
    expect(signal).toBe('SIGTERM');
    expect(handle.isAlive()).toBeFalse();
  });

  test('terminate distinguishes a missing target from a failed termination', async () => {
    const missingId = freshId(); register(missingId);
    const missing = requestRemotePtyControl(missingId, 'terminate', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests(() => undefined, () => false);
    await expect(missing).resolves.toEqual({ status: 'unknown-pty' });

    const failingId = freshId(); register(failingId);
    const failing = requestRemotePtyControl(failingId, 'terminate', 2000);
    await Bun.sleep(60);
    await processPtyControlRequests((candidate) => candidate === failingId ? (fakeHandle({ kill: () => {} }) as never) : undefined, () => false);
    await expect(failing).resolves.toEqual({ status: 'failed', reason: 'termination-failed' });
  });

  test('rename reaches the registry owner, preserves trim/blank clearing, and does not regress input-text', async () => {
    const writes: string[] = [];
    const handle = registryHandle('write', (chars) => writes.push(chars));
    const owner = () => processPtyControlRequests(getPtyControlTarget, () => false);

    const named = requestRemotePtyControl(handle.id, 'rename', { nickname: '  remote-name  ' }, 2000);
    await Bun.sleep(60); await owner();
    await expect(named).resolves.toEqual({ status: 'success' });
    expect(handle.nickname).toBe('remote-name');

    const cleared = requestRemotePtyControl(handle.id, 'rename', { nickname: '   ' }, 2000);
    await Bun.sleep(60); await owner();
    await expect(cleared).resolves.toEqual({ status: 'success' });
    expect(handle.nickname).toBeUndefined();

    const input = requestRemotePtyControl(handle.id, 'input-text', { chars: 'still-works' }, 2000);
    await Bun.sleep(60); await owner();
    await expect(input).resolves.toEqual({ status: 'success' });
    expect(writes).toEqual(['still-works']);
  });

  function patchPendingAction(action: string, payloadJson?: string | null): number {
    const d = new Database(ptyManifestDbPath());
    try {
      return payloadJson === undefined
        ? d.run("UPDATE pty_control_requests SET action=? WHERE status='pending'", [action]).changes ?? 0
        : d.run("UPDATE pty_control_requests SET action=?, payload_json=? WHERE status='pending'", [action, payloadJson]).changes ?? 0;
    } finally { d.close(); }
  }

  function settlePendingCapability(result: object): number {
    const d = new Database(ptyManifestDbPath());
    try {
      return d.run("UPDATE pty_control_requests SET status='success', result_json=? WHERE status='pending' AND action='capabilities'", [JSON.stringify(result)]).changes ?? 0;
    } finally { d.close(); }
  }

  test('unknown request-table actions are rejected independently of payload and remain distinct from invalid input payloads', async () => {
    const id = freshId(); register(id);
    const h = fakeHandle({ accessMode: 'write' });
    const owner = () => processPtyControlRequests((i) => i === id ? (h as never) : undefined, () => false);

    const unknownWithPayload = requestRemotePtyControl(id, 'input-text', { chars: 'future' }, 2000);
    await Bun.sleep(60);
    expect(patchPendingAction('future-action')).toBe(1);
    await owner();
    await expect(unknownWithPayload).resolves.toEqual({ status: 'denied', reason: 'unsupported-action' });

    const unknownWithoutPayload = requestRemotePtyControl(id, 'input-text', undefined, 2000);
    await Bun.sleep(60);
    expect(patchPendingAction('future-action', null)).toBe(1);
    await owner();
    await expect(unknownWithoutPayload).resolves.toEqual({ status: 'denied', reason: 'unsupported-action' });

    const invalidInput = requestRemotePtyControl(id, 'input-text', undefined, 2000);
    await Bun.sleep(60);
    await owner();
    await expect(invalidInput).resolves.toEqual({ status: 'denied', reason: 'invalid-payload' });
  });

  test('rename rejects missing, non-string, and primitive payloads without changing the existing nickname', async () => {
    const handle = registryHandle('write', () => {});
    handle.setNickname('preserved');
    const owner = () => processPtyControlRequests(getPtyControlTarget, () => false);

    const missing = requestRemotePtyControl(handle.id, 'rename', undefined, 2000);
    await Bun.sleep(60); await owner();
    await expect(missing).resolves.toEqual({ status: 'denied', reason: 'invalid-rename-payload' });
    expect(handle.nickname).toBe('preserved');

    const invalid = requestRemotePtyControl(handle.id, 'rename', { nickname: 42 } as unknown as { nickname: string }, 2000);
    await Bun.sleep(60); await owner();
    await expect(invalid).resolves.toEqual({ status: 'denied', reason: 'invalid-rename-payload' });
    expect(handle.nickname).toBe('preserved');

    for (const payload of ['raw nickname', 42, true]) {
      const primitive = requestRemotePtyControl(handle.id, 'rename', { nickname: 'placeholder' }, 2000);
      const database = new Database(ptyManifestDbPath());
      try {
        expect(database.run("UPDATE pty_control_requests SET payload_json=? WHERE status='pending'", [JSON.stringify(payload)]).changes).toBe(1);
      } finally { database.close(); }
      await Bun.sleep(60); await owner();
      await expect(primitive).resolves.toEqual({ status: 'denied', reason: 'invalid-rename-payload' });
      expect(handle.nickname).toBe('preserved');
    }
  });
});

// ── F3 `agent` 슬라이스 — 크로스-프로세스 감독 주입(#F3-agent) ──
//
// `human` 슬라이스는 `auto`(=brain 소유·보호된 자율) 자식에 **거부되는 것이 옳다**(takeover 선행).
// 그래서 부모/감독은 그 채널로 자식에 넣을 수 없었다. `agent` 는 접근 매트릭스상 `auto` 에 쓸 수
// 있지만, 크로스-프로세스에서 아무나 주장하면 보호가 무력화되므로 **같은 run** 을 요구한다.
describe('pty-control-ipc agent 슬라이스', () => {
  test('⭐ 같은 run 의 감독은 auto 자식에 주입한다 — human 은 같은 요청에서 거부된다', async () => {
    const id = freshId(); registerInRun(id, 'run-alpha');
    const writes: Array<[string, string]> = [];
    const h = fakeHandle({
      accessMode: 'auto',
      canWrite: (actor) => actor === 'agent',       // auto = brain 소유(접근 매트릭스 그대로)
      write: (chars, actor) => { writes.push([chars, actor]); },
    });
    const owner = () => processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => false);

    // ⚠️ 대조군 먼저 — 같은 PTY·같은 페이로드인데 human 이면 막힌다(agent 통과가 arbiter 무력화가 아님을 고정).
    const asHuman = withRunId('run-alpha', () => requestRemotePtyControl(id, 'input-text', { chars: 'nope' }, { timeoutMs: 2000 }));
    await Bun.sleep(60); owner();
    await expect(asHuman).resolves.toMatchObject({ status: 'denied', reason: 'write-arbiter' });
    expect(writes).toEqual([]);

    const asAgent = withRunId('run-alpha', () => requestRemotePtyControl(id, 'input-text', { chars: 'supervise' }, { actor: 'agent', timeoutMs: 2000 }));
    await Bun.sleep(60); owner();
    await expect(asAgent).resolves.toMatchObject({ status: 'success' });
    expect(writes).toEqual([['supervise', 'agent']]);
  });

  test('다른 run 의 프로세스는 agent 를 주장해도 거부되고 write 가 아예 불리지 않는다', async () => {
    const id = freshId(); registerInRun(id, 'run-alpha');
    const writes: string[] = [];
    const h = fakeHandle({ accessMode: 'auto', canWrite: () => true, write: (chars) => { writes.push(chars); } });
    const req = withRunId('run-beta', () => requestRemotePtyControl(id, 'input-text', { chars: 'intruder' }, { actor: 'agent', timeoutMs: 2000 }));
    await Bun.sleep(60);
    processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => false);
    await expect(req).resolves.toEqual({ status: 'denied', reason: 'run-mismatch' });
    expect(writes).toEqual([]);   // canWrite 가 전부 허용이어도 인가가 앞에서 끊는다
  });

  test('run 이 안 찍힌 프로세스/자식은 fail-closed — 사유가 양쪽으로 갈린다', async () => {
    const anonymousRequester = freshId(); registerInRun(anonymousRequester, 'run-alpha');
    const h = fakeHandle({ accessMode: 'auto', canWrite: () => true });
    const noRequesterRun = withRunId(undefined, () => requestRemotePtyControl(anonymousRequester, 'input-text', { chars: 'x' }, { actor: 'agent', timeoutMs: 2000 }));
    await Bun.sleep(60);
    processPtyControlRequests((i) => (i === anonymousRequester ? (h as never) : undefined), () => false);
    await expect(noRequesterRun).resolves.toEqual({ status: 'denied', reason: 'agent-run-unidentified' });

    const anonymousTarget = freshId(); registerInRun(anonymousTarget, undefined);
    const noTargetRun = withRunId('run-alpha', () => requestRemotePtyControl(anonymousTarget, 'input-text', { chars: 'x' }, { actor: 'agent', timeoutMs: 2000 }));
    await Bun.sleep(60);
    processPtyControlRequests((i) => (i === anonymousTarget ? (h as never) : undefined), () => false);
    await expect(noTargetRun).resolves.toEqual({ status: 'denied', reason: 'target-run-unidentified' });
  });

  test('resize 도 같은 인가를 지난다 — 입력만 막고 리사이즈가 새면 반쪽 게이트다', async () => {
    const id = freshId(); registerInRun(id, 'run-alpha');
    const resized: Array<[number, number]> = [];
    const h = fakeHandle({ accessMode: 'auto', canWrite: () => true, resize: (cols, rows) => resized.push([cols, rows]) });
    const denied = withRunId('run-beta', () => requestRemotePtyControl(id, 'resize', { cols: 120, rows: 40 }, { actor: 'agent', timeoutMs: 2000 }));
    await Bun.sleep(60); processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => false);
    await expect(denied).resolves.toEqual({ status: 'denied', reason: 'run-mismatch' });
    expect(resized).toEqual([]);

    const allowed = withRunId('run-alpha', () => requestRemotePtyControl(id, 'resize', { cols: 120, rows: 40 }, { actor: 'agent', timeoutMs: 2000 }));
    await Bun.sleep(60); processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => false);
    await expect(allowed).resolves.toEqual({ status: 'success' });
    expect(resized).toEqual([[120, 40]]);
  });

  test('agent takeover 는 human 으로 조용히 강등되지 않고 거부된다', async () => {
    const id = freshId(); registerInRun(id, 'run-alpha');
    const h = fakeHandle({ accessMode: 'auto' });
    let humanTakeoverCalls = 0;
    // ⚠️ 페이로드 없는 액션은 3번째 인자를 비워야 옵션이 4번째로 간다(3번째는 payload|timeout 자리).
    const req = withRunId('run-alpha', () => requestRemotePtyControl(id, 'takeover', undefined, { actor: 'agent', timeoutMs: 2000 }));
    await Bun.sleep(60);
    processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => { humanTakeoverCalls += 1; return true; });
    await expect(req).resolves.toEqual({ status: 'denied', reason: 'agent-takeover-unsupported' });
    expect(humanTakeoverCalls).toBe(0);
    expect(h.accessMode).toBe('auto');
  });

  test('agent rename is allowed because it changes a label rather than ownership', async () => {
    const handle = registryHandle('auto', () => {});
    const request = withRunId('run-unrelated', () =>
      requestRemotePtyControl(handle.id, 'rename', { nickname: 'agent-name' }, { actor: 'agent', timeoutMs: 2000 }));
    await Bun.sleep(60);
    await processPtyControlRequests(getPtyControlTarget, () => false);
    await expect(request).resolves.toEqual({ status: 'success' });
    expect(handle.nickname).toBe('agent-name');
  });

  /** pending 행의 actor 컬럼을 직접 바꾼다 — API 로는 만들 수 없는 상태(NULL·미지원 값)를 재현한다.
   *  ⚠️ 이 채널은 **신뢰 경계 밖**이라 다른 빌드·손상된 행이 그런 값을 실제로 심을 수 있다. */
  function patchPendingActor(value: string | null): number {
    const d = new Database(ptyManifestDbPath());
    try { return d.run("UPDATE pty_control_requests SET actor=? WHERE status='pending'", [value]).changes ?? 0; }
    finally { d.close(); }
  }

  test('⭐ 컬럼이 NULL 인 legacy 행은 human 으로 읽힌다(미지정 = 종전 동작)', async () => {
    const id = freshId(); registerInRun(id, 'run-alpha');
    const h = fakeHandle({ accessMode: 'auto', canWrite: (actor) => actor === 'agent' });
    // agent 로 보낸 뒤 컬럼을 NULL 로 되돌린다 = 마이그레이션 前에 쌓여 있던 행과 같은 상태.
    const req = withRunId('run-alpha', () => requestRemotePtyControl(id, 'input-text', { chars: 'x' }, { actor: 'agent', timeoutMs: 2000 }));
    await Bun.sleep(60);
    expect(patchPendingActor(null)).toBe(1);   // 행을 실제로 바꿨는지 먼저 확인(안 바뀌면 이 테스트는 무의미)
    processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => false);
    // human 으로 읽혔으므로 auto 자식에서 arbiter 가 막는다 — agent 로 읽혔다면 통과했을 것이다.
    await expect(req).resolves.toMatchObject({ status: 'denied', reason: 'write-arbiter' });
  });

  test('⭐ 아는 값이 아닌 actor 는 human 으로 강등되지 않고 거부된다 — 강등되면 소유권 탈취 권한이 생긴다', async () => {
    const id = freshId(); registerInRun(id, 'run-alpha');
    const h = fakeHandle({ accessMode: 'auto' });
    let humanTakeoverCalls = 0;
    const req = withRunId('run-alpha', () => requestRemotePtyControl(id, 'takeover', undefined, { timeoutMs: 2000 }));
    await Bun.sleep(60);
    expect(patchPendingActor('brain')).toBe(1);
    processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => { humanTakeoverCalls += 1; return true; });
    await expect(req).resolves.toEqual({ status: 'denied', reason: 'invalid-actor' });
    expect(humanTakeoverCalls).toBe(0);
    expect(h.accessMode).toBe('auto');   // 손상된 값이 auto 자식의 소유권을 못 뺏는다
  });

  test('actor/run 컬럼 마이그레이션은 idempotent 하다', async () => {
    const legacy = new Database(':memory:');
    legacy.run('CREATE TABLE pty_control_requests (request_id TEXT PRIMARY KEY, pty_id TEXT NOT NULL, action TEXT NOT NULL, owner_pid INTEGER NOT NULL, status TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    migratePtyControlSchema(legacy); migratePtyControlSchema(legacy);
    for (const column of ['payload_json', 'actor', 'requester_run_id']) {
      expect(legacy.query(`SELECT name FROM pragma_table_info('pty_control_requests') WHERE name='${column}'`).get()).not.toBeNull();
    }
    legacy.close();

    // actor 옵션을 아예 안 준 요청(3번째 인자 = 종전 timeout 시그니처) → human 경로 그대로.
    const id = freshId(); registerInRun(id, 'run-alpha');
    const h = fakeHandle({ accessMode: 'auto', canWrite: (actor) => actor === 'agent' });
    const req = withRunId('run-alpha', () => requestRemotePtyControl(id, 'input-text', { chars: 'x' }, 2000));
    await Bun.sleep(60); processPtyControlRequests((i) => (i === id ? (h as never) : undefined), () => false);
    await expect(req).resolves.toMatchObject({ status: 'denied', reason: 'write-arbiter' });
  });
});
