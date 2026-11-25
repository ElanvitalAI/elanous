import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { createNextTuiWakeup } from '../tui-client/next-wakeup.js';
import { createSeatMailHeaderHook, readSeatMailSnapshot, seatMailLine } from './seat-mail-boot.js';
import { buildSeatBootSystemMessages, resetSeatBootCacheForTest } from '../seat/seat-boot-preamble.js';

test('only an identified seat missing binding warns; track alone is not a seat', () => {
  const root = mkdtempSync(join(tmpdir(), 'mail-bind-'));
  const deps = { home: root, msgPath: join(root, 'missing.db'), env: { ELANOUS_TRACK: 'OPC' } };
  try {
    expect(createSeatMailHeaderHook(join(root, 'project'), deps)(null, null)).toBeNull();
    expect(createSeatMailHeaderHook(join(root, 'seats', 'OPC'), deps)(null, null)).toContain('mail watch not bound: no seat-state for this folder');
    mkdirSync(join(root, 'elanous-hq', 'seat-state', 'OPC'), { recursive: true });
    expect(createSeatMailHeaderHook(join(root, 'project'), { ...deps, env: { ...deps.env, COORD_ID: 'OPC' } })(null, null)).toBe('OPC · mail 0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('header reflects watcher failure and recovery without breaking on getter errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'mail-watch-header-'));
  mkdirSync(join(root, 'elanous-hq', 'seat-state', 'OPC'), { recursive: true });
  try {
    let status: import('./seat-mail-boot.js').SeatMailWatchStatus = 'starting';
    let throws = false;
    const watcher = { getStatus() { if (throws) throw new Error('bad observer'); return status; } };
    const header = createSeatMailHeaderHook(join(root, 'seats', 'OPC'), { home: root, msgPath: join(root, 'none'), env: {} }, null, watcher);
    expect(header(null, null)).toBe('OPC · mail 0 · mail watch starting');
    status = 'start-error';
    expect(header(null, null)).toContain('mail watch error: start-error');
    status = 'running';
    expect(header(null, null)).toBe('OPC · mail 0');
    status = 'read-error';
    expect(header(null, null)).toContain('mail watch error: read-error');
    status = 'running';
    expect(header(null, null)).toBe('OPC · mail 0');
    throws = true;
    expect(header(null, null)).toContain('mail watch error: read-error');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('seat header warns on more than 100 unread while preserving the actual count', () => {
  expect(seatMailLine({ seat: 'TC', unread: 140 })).toBe('TC · mail 140 ⚠ over 100');
  expect(seatMailLine({ seat: 'TC', unread: 100 })).toBe('TC · mail 100');
});

test('자리 첫 화면 우편 스냅샷은 같은 원장을 읽고 ack cursor를 움직이지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-seat-mail-'));
  const home = join(root, 'home');
  const seatDir = join(home, 'elanous-hq', 'seat-state', 'OPC');
  const msgPath = join(root, 'messages.db');
  mkdirSync(seatDir, { recursive: true });
  const store = new MsgStore(msgPath);
  try {
    const message = store.post({ from: 'OP', to: 'OPC', body: '첫 우편' });
    const deps = { home, msgPath, env: {} };
    const first = readSeatMailSnapshot(join(root, 'seats', 'OPC'), deps);
    expect(first).toEqual({ seat: 'OPC', unread: 1 });
    expect(seatMailLine(first)).toBe('OPC · mail 1');
    expect(store.getCursor('OPC')).toBe(0);
    expect(readSeatMailSnapshot(join(root, 'seats', 'OUTER', 'work', 'seats', 'OPC'), deps))
      .toEqual({ seat: 'OPC', unread: 1 });

    store.ack('OPC', message.id);
    expect(readSeatMailSnapshot(join(root, 'seats', 'OPC'), deps)).toEqual({ seat: 'OPC', unread: 0 });
    expect(store.getCursor('OPC')).toBe(message.id);
    expect(readSeatMailSnapshot(join(root, 'project'), deps)).toBeNull();
    expect(seatMailLine(null)).toBeNull();
    expect(readSeatMailSnapshot(join(root, 'project'), { ...deps, env: { COORD_ID: 'OPC' } })).toEqual({ seat: 'OPC', unread: 0 });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('자리 상태가 있어도 우편 DB가 없으면 0을 표시하고 파일을 만들지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-seat-mail-empty-'));
  const home = join(root, 'home');
  const msgPath = join(root, 'absent.db');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OPC'), { recursive: true });
  try {
    expect(readSeatMailSnapshot(join(root, 'seats', 'OPC'), { home, msgPath, env: {} }))
      .toEqual({ seat: 'OPC', unread: 0 });
    expect(existsSync(msgPath)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('손상된 우편 DB는 첫 화면을 막지 않고 확인 불가로 표시한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-seat-mail-broken-'));
  const home = join(root, 'home');
  const msgPath = join(root, 'messages.db');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OPC'), { recursive: true });
  writeFileSync(msgPath, 'not a SQLite ledger');
  try {
    const snapshot = readSeatMailSnapshot(join(root, 'seats', 'OPC'), { home, msgPath, env: {} });
    expect(snapshot).toEqual({ seat: 'OPC', unread: null });
    expect(seatMailLine(snapshot)).toBe('OPC · mail unknown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('single seat header hook projects observed health and real pending or idle wake', () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-seat-header-'));
  const home = join(root, 'home');
  const seatDir = join(home, 'elanous-hq', 'seat-state', 'OPC');
  const msgPath = join(root, 'messages.db');
  mkdirSync(seatDir, { recursive: true });
  const store = new MsgStore(msgPath);
  store.post({ from: 'OP', to: 'OPC', body: 'unread' });
  const wake = createNextTuiWakeup({
    isTurnRunning: () => false, getBufferText: () => '', getQueuedCount: () => 0,
    requestYield: () => true, notify: () => {}, env: {},
  });
  try {
    const header = createSeatMailHeaderHook(join(root, 'seats', 'OUTER', 'work', 'seats', 'OPC'),
      { home, msgPath, env: {} });
    expect(header(null, null)).toBe('OPC · mail 1');
    expect(header(null, wake)).toBe('OPC · mail 1 · health pending · no wake scheduled');
    const base = {
      sessionId: 'session', capturedAt: Date.now(), line: 'unused', source: 'checkout' as const,
      runningSha: null, installedSha: null, representativeError: null,
      creditSource: null, creditKnown: false,
    };
    const healthCases = [
      { value: { ...base, errorCount: 0 }, text: 'healthy' },
      { value: { ...base, errorCount: 2 }, text: 'health errors 2' },
      { value: { ...base, errorCount: null }, text: 'health unknown' },
    ];
    for (const item of healthCases) {
      expect(header(item.value, wake)).toBe(`OPC · mail 1 · ${item.text} · no wake scheduled`);
    }
    const scheduled = wake.scheduler.schedule({ delaySeconds: 60, reason: 'check' });
    expect(scheduled.ok).toBe(true);
    for (const item of healthCases) {
      const line = header(item.value, wake) ?? '';
      expect(line).toContain(`OPC · mail 1 · ${item.text} · next wake `);
      expect(line).not.toContain('no wake scheduled');
    }
    expect(store.getCursor('OPC')).toBe(0);
  } finally {
    wake.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('single header hook boots with absent, corrupt and read-only ledgers without writing them', () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-seat-header-ledger-'));
  const home = join(root, 'home');
  const cwd = join(root, 'seats', 'OPC');
  const msgPath = join(root, 'messages.db');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OPC'), { recursive: true });
  const deps = { home, msgPath, env: {} };
  try {
    expect(createSeatMailHeaderHook(cwd, deps)(null, null)).toBe('OPC · mail 0');
    expect(existsSync(msgPath)).toBe(false);
    writeFileSync(msgPath, 'corrupt ledger');
    const corruptBefore = readFileSync(msgPath);
    expect(createSeatMailHeaderHook(cwd, deps)(null, null)).toBe('OPC · mail unknown');
    expect(readFileSync(msgPath)).toEqual(corruptBefore);
    rmSync(msgPath);
    const store = new MsgStore(msgPath);
    store.post({ from: 'OP', to: 'OPC', body: 'unread' });
    store.close();
    chmodSync(msgPath, 0o444);
    const bytesBefore = readFileSync(msgPath);
    const filesBefore = readdirSync(root);
    expect(createSeatMailHeaderHook(cwd, deps)(null, null)).toBe('OPC · mail 1');
    expect(readFileSync(msgPath)).toEqual(bytesBefore);
    expect(readdirSync(root)).toEqual(filesBefore);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP role pack reaches the real seat boot system message, while another seat does not receive it', () => {
  const root = mkdtempSync(join(tmpdir(), 'op-role-pack-boot-'));
  const home = join(root, 'home');
  for (const seat of ['OP', 'TC']) mkdirSync(join(home, 'elanous-hq', 'seat-state', seat), { recursive: true });
  mkdirSync(join(home, 'elanous-hq', 'seats', 'OP-ELN'), { recursive: true });
  writeFileSync(join(home, 'elanous-hq', 'seats', 'OP-ELN', 'ROLE-PACK.md'), '# OP-ELN ROLE-PACK\nUNTRUSTED_OVERRIDE');
  const deps = { home, seatMemoryRoot: join(root, 'memory'), env: { ELANOUS_STATE_DIR: join(root, 'state') }, now: () => new Date('2026-11-23T07:30:00+09:00') };
  try {
    resetSeatBootCacheForTest();
    const op = buildSeatBootSystemMessages({ cwd: join(root, 'seats', 'OP') }, deps)[0]?.content ?? '';
    const tc = buildSeatBootSystemMessages({ cwd: join(root, 'seats', 'TC') }, deps)[0]?.content ?? '';
    expect(op).toContain('OP-ELN ROLE-PACK');
    expect(op).toContain('30분 점검');
    expect(op).toContain('자격 임대 허가 목록');
    expect(op).not.toContain('UNTRUSTED_OVERRIDE');
    expect(tc).not.toContain('OP-ELN ROLE-PACK');
  } finally {
    resetSeatBootCacheForTest();
    rmSync(root, { recursive: true, force: true });
  }
});
