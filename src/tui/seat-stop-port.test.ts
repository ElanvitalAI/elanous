import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createSeatControl, type SeatControlMode } from '../seat/seat-control.js';
import { createSeatStopDriver, requestSeatStop, setSeatStopHandler } from './seat-stop-port.js';

describe('seat-stop port — one door from the control channel to the running TUI', () => {
  test('no TUI registered → no-tui (refused, never queued)', async () => {
    expect(await requestSeatStop({ requestId: 'r-1', mode: 'quit' })).toBe('no-tui');
  });

  test('the registered TUI answers; a throwing handler is failed; unregister only removes its own handler', async () => {
    const seen: string[] = [];
    const off = setSeatStopHandler(async (request) => { seen.push(`${request.requestId}:${request.mode}`); return 'waiting'; });
    expect(await requestSeatStop({ requestId: 'r-2', mode: 'migrate' })).toBe('waiting');
    const offLater = setSeatStopHandler(async () => { throw new Error('checkpoint disk full'); });
    off();
    expect(await requestSeatStop({ requestId: 'r-3', mode: 'force' })).toBe('failed');
    offLater();
    expect(await requestSeatStop({ requestId: 'r-4', mode: 'quit' })).toBe('no-tui');
    expect(seen).toEqual(['r-2:migrate']);
  });
});

describe('entry wires the seat stop (Ctrl+Q unchanged)', () => {
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');

  test('Ctrl+Q is still abort → wait → break, byte for byte (TC #89986: the key stays the last rung)', () => {
    expect(entry.includes("      if (key.ctrl && key.name === 'q') {\n        turnAbort?.abort();\n        await turnDone;\n        break;\n      }\n")).toBe(true);
  });

  test('the seat-stop key leaves the loop before the queue door, and a turn end runs a waiting quit/migrate', () => {
    const stopAt = entry.indexOf('if (key === seatStopKey) {');
    const wakeAt = entry.indexOf('if (key === queueWake) {');
    expect(stopAt).not.toBe(-1);
    expect(wakeAt).toBeGreaterThan(stopAt);
    expect(entry.includes('if (!next && seatStopRef.current) void seatStopRef.current.turnEnded()')).toBe(true);
    expect(entry.includes('offSeatStop();')).toBe(true);
  });

  test('migrate asks for a same-session restart before leaving; force aborts the turn', () => {
    expect(entry.includes('migrate: (sessionId) => { const requestId = driver.liveRequestId(); requestTuiSelfRestart(`seat-stop:migrate:${sessionId}`, Date.now(), requestId ? { requestId } : undefined); injectKey(seatStopKey); },')).toBe(true);
    expect(entry.includes('abort: () => { turnAbort?.abort(); },')).toBe(true);
  });

  test('JUD-B #38765 ⓜ: no global requestId the handler overwrites per request — the driver owns the live one', () => {
    expect(entry.includes('let seatStopRequestId')).toBe(false);
    expect(entry.includes('seatStopRequestId = request.requestId')).toBe(false);
  });
});

/** JUD #38658 ⓑ — the real seat control with a checkpoint that has not finished writing yet. */
function rig() {
  const events: string[] = [];
  let release!: () => void;
  let fail!: (error: Error) => void;
  let busy = true;
  const control = createSeatControl({
    checkpoint: (mode: SeatControlMode) => new Promise<void>((resolve, reject) => {
      events.push(`checkpoint:${mode}`);
      release = resolve;
      fail = reject;
    }),
    exit: () => { events.push('exit'); },
    migrate: (session: string) => { events.push(`migrate:${session}`); },
    abort: () => { events.push('abort'); },
  });
  const driver = createSeatStopDriver({ control, busy: () => busy });
  return { driver, events, setBusy: (next: boolean) => { busy = next; }, release: () => release(), fail: (e: Error) => fail(e) };
}

describe('createSeatStopDriver — no new turn while the seat is stopping (JUD #38658 ⓑ)', () => {
  test('quit during a turn: the turn end closes the door at once, before the checkpoint finishes; then exit', async () => {
    const r = rig();
    expect(await r.driver.request({ requestId: 'q-1', mode: 'quit' })).toBe('waiting');
    expect(r.driver.allowsNewTurn()).toBe(true);
    r.setBusy(false);
    const ended = r.driver.turnEnded();
    // The turn-end knocks reach the loop in this window — the door must already be closed.
    expect(r.driver.allowsNewTurn()).toBe(false);
    expect(r.events).toEqual(['checkpoint:quit']);
    r.release();
    await ended;
    expect(r.events).toEqual(['checkpoint:quit', 'exit']);
    expect(r.driver.allowsNewTurn()).toBe(false);
  });

  test('migrate on an idle seat closes the door before its checkpoint resolves', async () => {
    const r = rig();
    r.setBusy(false);
    const asked = r.driver.request({ requestId: 'm-1', mode: 'migrate' }, 'session-7');
    expect(r.driver.allowsNewTurn()).toBe(false);
    r.release();
    expect(await asked).toBe('accepted');
    expect(r.events).toEqual(['checkpoint:migrate', 'migrate:session-7']);
  });

  test('a failed checkpoint opens the door again — the seat keeps working', async () => {
    const r = rig();
    r.setBusy(false);
    const asked = r.driver.request({ requestId: 'q-2', mode: 'quit' });
    expect(r.driver.allowsNewTurn()).toBe(false);
    r.fail(new Error('disk full'));
    await expect(asked).rejects.toThrow('disk full');
    expect(r.driver.allowsNewTurn()).toBe(true);
  });

  test('a refused request (migrate without a session) leaves the door open', async () => {
    const r = rig();
    r.setBusy(false);
    expect(await r.driver.request({ requestId: 'm-2', mode: 'migrate' })).toBe('missing-session');
    expect(r.driver.allowsNewTurn()).toBe(true);
  });

  test('a turn end with no waiting stop changes nothing', async () => {
    const r = rig();
    r.setBusy(false);
    await r.driver.turnEnded();
    expect(r.driver.allowsNewTurn()).toBe(true);
    expect(r.events).toEqual([]);
  });
});

/** JUD-B #38765 ⓜ — the rig that answers what the migrate/checkpoint metadata saw: the driver-pinned requestId at port time. */
function pinRig() {
  const seen: string[] = [];
  let release!: () => void;
  let busy = true;
  const driver = createSeatStopDriver({
    control: createSeatControl({
      checkpoint: () => new Promise<void>((resolve) => { release = resolve; }),
      exit: () => { seen.push(`exit:${driver.liveRequestId()}`); },
      migrate: (session: string) => { seen.push(`migrate:${session}:${driver.liveRequestId()}`); },
      abort: () => { seen.push(`abort:${driver.liveRequestId()}`); },
    }),
    busy: () => busy,
  });
  return { driver, seen, setBusy: (next: boolean) => { busy = next; }, release: () => release() };
}

describe('createSeatStopDriver — the requestId of the stop that owns the door (JUD-B #38765 ⓜ)', () => {
  test('an accepted R1 records its own requestId in the migrate metadata', async () => {
    const r = pinRig();
    r.setBusy(false);
    const asked = r.driver.request({ requestId: 'r1', mode: 'migrate' }, 'session-a');
    r.release();
    expect(await asked).toBe('accepted');
    expect(r.seen).toEqual(['migrate:session-a:r1']);
  });

  test('a refused duplicate R2 after R1 leaves the migrate metadata on R1 — the JUD-B defect', async () => {
    const r = pinRig();
    expect(await r.driver.request({ requestId: 'r1', mode: 'migrate' }, 'session-a')).toBe('waiting');
    expect(await r.driver.request({ requestId: 'r2', mode: 'migrate' }, 'session-a')).toBe('already-requested');
    expect(r.driver.liveRequestId()).toBe('r1');
    r.setBusy(false);
    const ended = r.driver.turnEnded();
    r.release();
    await ended;
    expect(r.seen).toEqual(['migrate:session-a:r1']);
  });

  test('a normally accepted R2 supersedes — its own requestId is used', async () => {
    const r = pinRig();
    r.setBusy(false);
    expect(await r.driver.request({ requestId: 'r-old', mode: 'migrate' })).toBe('missing-session');
    const asked = r.driver.request({ requestId: 'r2', mode: 'migrate' }, 'session-b');
    r.release();
    expect(await asked).toBe('accepted');
    expect(r.seen).toEqual(['migrate:session-b:r2']);
  });
});

describe('entry holds every opener while stopping', () => {
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
  test('queueWake · internalWake are held before the door, and a person line is queued, not started', () => {
    const held = entry.indexOf("if ((key === queueWake || key === internalWake) && seatStopRef.current && !seatStopRef.current.allowsNewTurn()) {");
    expect(held).not.toBe(-1);
    expect(entry.indexOf('if (key === queueWake) {')).toBeGreaterThan(held);
    expect(entry.includes("if (seatStopRef.current && !seatStopRef.current.allowsNewTurn()) {\n          queue.enqueue(submittedFull);")).toBe(true);
  });
});
