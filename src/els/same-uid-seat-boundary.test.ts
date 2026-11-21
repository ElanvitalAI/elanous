import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControl, type ControlTarget, type Principal } from './control.js';
import { sameUidSeatBoundary } from './seat-boundary.js';

// SAME-UID-SEAT-ISOLATION (0.3.32 P0) first slice: a seat of the same OS UID may not drive a pane
// that another seat owns, unless the owner shared it. Legacy human (no seat) callers are unchanged.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'els-seat-boundary-')); dirs.push(dir); return dir; };

const owned = (ownerSeat?: string, sharedWith?: readonly string[]): ControlTarget =>
  ({ workspace: 'ws', pane: 'p1', shell: false, ...(ownerSeat ? { ownerSeat } : {}), ...(sharedWith ? { sharedWith } : {}) });

describe('sameUidSeatBoundary(순수 결정기)', () => {
  test('같은 자리 → 허용', () => {
    expect(sameUidSeatBoundary('TC-A', owned('TC-A'))).toEqual({ allow: true, reason: 'same-seat' });
  });
  test('다른 자리 소유 pane → 거부', () => {
    const out = sameUidSeatBoundary('TC-A', owned('TC-B'));
    expect(out.allow).toBe(false);
    expect(out.reason).toContain('TC-B');
  });
  test('자리 없는 호출자(사람·legacy) → 변화 없음', () => {
    expect(sameUidSeatBoundary(undefined, owned('TC-B'))).toEqual({ allow: true, reason: 'no-seat-actor' });
  });
  test('소유 미상 pane → 기존 동작 유지(허용, 잔여로 기록)', () => {
    expect(sameUidSeatBoundary('TC-A', owned())).toEqual({ allow: true, reason: 'ownership-unknown' });
  });
  test('명시 공유 목록에 있으면 허용, 없으면 거부', () => {
    expect(sameUidSeatBoundary('TC-A', owned('TC-B', ['TC-A'])).allow).toBe(true);
    expect(sameUidSeatBoundary('TC-C', owned('TC-B', ['TC-A'])).allow).toBe(false);
  });
  test('OP 는 기존 기본 규칙대로 모든 pane 허용', () => {
    expect(sameUidSeatBoundary('OP', owned('TC-B'))).toEqual({ allow: true, reason: 'op-supervisor' });
  });
});

describe('제어 문 run() 배선', () => {
  const door = (dir: string) => {
    const ran: string[] = [];
    const control = createControl({
      stateDir: dir,
      execute: async (input) => { ran.push(input.text ?? ''); return { exitCode: 0, message: 'delivered' }; },
      now: () => 1_700_000_000_000,
    });
    return { control, ran };
  };
  const rows = (dir: string) => readFileSync(join(dir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { result: string; reason?: string });
  const seat = (name: string): Principal => ({ id: `els-pane:${name}`, kind: 'eln', seat: name, workspaces: ['ws'] });

  test('같은 자리 do → 실행', async () => {
    const dir = stateDir(); const { control, ran } = door(dir);
    const out = await control.run({ principal: seat('HAND-A'), action: 'do', target: owned('HAND-A'), text: 'ls' });
    expect(out.ok).toBe(true);
    expect(ran).toEqual(['ls']);
  });
  test('남의 자리 소유 pane do → 거부 · 실행 0 · 감사', async () => {
    const dir = stateDir(); const { control, ran } = door(dir);
    const out = await control.run({ principal: seat('HAND-A'), action: 'do', target: owned('HAND-B'), text: 'ls' });
    expect(out.ok).toBe(false);
    if (!out.ok) { expect(out.code).toBe('denied'); expect(out.reason).toContain('same-uid seat boundary'); }
    expect(ran).toEqual([]);
    expect(rows(dir).at(-1)?.result).toBe('denied');
  });
  test('callerSeat(소켓 peer 자리)도 같은 경계', async () => {
    const dir = stateDir(); const { control, ran } = door(dir);
    const peer: Principal = { id: 'local:501', kind: 'eln', seat: 'HAND-A', workspaces: ['ws'], callerPane: 'w1:p1', callerSeat: 'TC-A' };
    const out = await control.run({ principal: peer, action: 'do', target: owned('HAND-B'), text: 'ls' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('same-uid seat boundary');
    expect(ran).toEqual([]);
  });
  test('명시 공유 pane do → 실행', async () => {
    const dir = stateDir(); const { control, ran } = door(dir);
    const out = await control.run({ principal: seat('HAND-A'), action: 'do', target: owned('HAND-B', ['HAND-A']), text: 'ls' });
    expect(out.ok).toBe(true);
    expect(ran).toEqual(['ls']);
  });
  test('자리 없는 principal 은 경계 영향 없음(기존 allow 규칙 판단 그대로 not in control-allow.json)', async () => {
    const dir = stateDir(); const { control } = door(dir);
    const out = await control.run({ principal: { id: 'local:501', kind: 'cli' }, action: 'do', target: owned('HAND-B'), text: 'ls' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('not in control-allow.json');
  });
});
