import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import type { ChecklistItem } from './checklist.js';
import { tickP0Stall } from './p0-stall-observer.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const cells: ChecklistItem[] = [
  { id: 'P0-WIRED', title: 'p0 wired', status: 'yellow', owner: 'MK', priority: 'P0', evidence: '진행: PR #39236 리뷰 중',
    updatedAt: '2026-11-20T00:00:00.000Z', updatedBy: 'OP' },
  { id: 'P1-SKIP', title: 'p1', status: 'yellow', owner: 'TC', priority: 'P1', evidence: 'PR #1', updatedAt: '2026-11-20T00:00:00.000Z', updatedBy: 'OP' },
] as ChecklistItem[];
const schedules = () => [{ version: '9.9.9', cutAt: '2026-11-21T00:00:00.000Z' }, { version: '9.9.8', cutAt: '2026-11-19T00:00:00.000Z' }];

function harness(view: { current: string | Error }) {
  const dir = mkdtempSync(join(tmpdir(), 'p0-stall-observer-'));
  dirs.push(dir);
  const store = new MsgStore(join(dir, 'msg', 'messages.db'));
  const calls: string[][] = [];
  const gh = (args: string[]) => { calls.push(args); if (view.current instanceof Error) throw view.current; return view.current; };
  const tick = (now: string) => tickP0Stall({ gh, now: new Date(now) }, { root: dir, schedules, shipped: () => '', items: () => cells, store });
  const mails = () => store.list('OP', 0, 100, { includeAcked: true });
  return { dir, store, calls, tick, mails };
}
const headA = '{"headRefOid":"aaaaaaaaaaaa1111111111111111111111111111","headRefName":"mk/op-stall-p0-hourly"}';
const headB = '{"headRefOid":"bbbbbbbbbbbb2222222222222222222222222222","headRefName":"mk/op-stall-p0-hourly"}';

test('unchanged head over two ticks 61 minutes apart → one RLA→OP alert; gh reads the E1-linked PR', () => {
  const view = { current: headA as string | Error };
  const { dir, store, calls, tick, mails } = harness(view);
  try {
    const first = tick('2026-11-20T10:00:00.000Z');
    expect(first.map((row) => row.version)).toEqual(['9.9.9']);
    expect(first[0]!.alerts).toEqual([]);
    expect(calls).toEqual([['pr', 'view', '39236', '--json', 'headRefOid,headRefName']]);
    expect(existsSync(join(dir, 'release', '9.9.9', 'p0-stall-heads.json'))).toBe(true);
    const second = tick('2026-11-20T11:01:00.000Z');
    expect(second[0]!.alerts.map((alert) => alert.id)).toEqual(['P0-WIRED']);
    expect(mails().length).toBe(1);
    expect(mails()[0]!.from).toBe('RLA');
    expect(mails()[0]!.body).toBe('정체 P0 · 칸 P0-WIRED · 주인 MK · head aaaaaaaaaaaa · 가지 mk/op-stall-p0-hourly · 마지막 변화 2026-11-20T10:00:00.000Z · 61분 무변화 → OP 재배정 판단');
  } finally { store.close(); }
});

test('head change clears the alert and restarts the clock; no new mail', () => {
  const view = { current: headA as string | Error };
  const { dir, store, tick, mails } = harness(view);
  try {
    tick('2026-11-20T10:00:00.000Z');
    tick('2026-11-20T11:01:00.000Z');
    view.current = headB;
    const moved = tick('2026-11-20T11:31:00.000Z');
    expect(moved[0]!.cleared).toEqual(['P0-WIRED']);
    expect(mails().length).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, 'release', '9.9.9', 'p0-stall-alerts.json'), 'utf8'))).toEqual({});
    expect(JSON.parse(readFileSync(join(dir, 'release', '9.9.9', 'p0-stall-heads.json'), 'utf8'))['P0-WIRED'].lastChangedAt).toBe('2026-11-20T11:31:00.000Z');
  } finally { store.close(); }
});

test('gh failure → no mail and no clear; the alert and first-seen time survive the failed tick', () => {
  const view = { current: headA as string | Error };
  const { dir, store, tick, mails } = harness(view);
  try {
    tick('2026-11-20T10:00:00.000Z');
    tick('2026-11-20T11:01:00.000Z');
    view.current = new Error('gh pr view failed: HTTP 502');
    const failed = tick('2026-11-20T11:31:00.000Z');
    expect(failed[0]!.alerts).toEqual([]);
    expect(failed[0]!.cleared).toEqual([]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'release', '9.9.9', 'p0-stall-alerts.json'), 'utf8')))).toEqual(['P0-WIRED']);
    expect(mails().length).toBe(1);
    view.current = headA;
    expect(tick('2026-11-20T12:01:00.000Z')[0]!.alerts).toEqual([]);
    expect(mails().length).toBe(1);
  } finally { store.close(); }
});

test('the tick posts for the current release version (cut ahead, unshipped) only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p0-stall-observer-'));
  dirs.push(dir);
  const seen: string[] = [];
  tickP0Stall({ gh: () => headA, now: new Date('2026-11-20T10:00:00.000Z') }, {
    root: dir, schedules: () => [...schedules(), { version: '9.9.10', cutAt: '2026-11-22T00:00:00.000Z' }], shipped: () => '9.9.9', items: () => cells,
    post: (input) => { seen.push(input.version); return { alerts: [], cleared: [], alerted: {} }; },
  });
  expect(seen).toEqual(['9.9.10']);
});
