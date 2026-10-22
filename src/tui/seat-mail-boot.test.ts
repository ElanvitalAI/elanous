import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { readSeatMailSnapshot, seatMailLine } from './seat-mail-boot.js';

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
    expect(seatMailLine(first)).toBe('OPC · 우편 1');
    expect(store.getCursor('OPC')).toBe(0);

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
    expect(seatMailLine(snapshot)).toBe('OPC · 우편 확인 불가');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
