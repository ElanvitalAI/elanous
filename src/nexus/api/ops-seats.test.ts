import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { resetUserConfig } from '../../user-config.js';
import type { ChecklistItem } from '../../release-loop/checklist.js';
import { buildSeatsBoard, createSeatsCache, kstDayRange, type SeatsSources } from './ops-seats.js';
import { liveSeatsSources } from './ops-seats-sources.js';
import { openSurfaceEventsDb, surfaceEventsDbPath } from '../../domains/surface-events.js';
import { recordCoordEvent, listCoordEvents } from '../../context-bus/coord-events.js';

const item = (id: string, owner: string, status: ChecklistItem['status'], title = id): ChecklistItem => ({ id, title, owner, status, updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'T' });
const sources = (over: Partial<SeatsSources> = {}): SeatsSources => ({
  channel: async () => [
    { body: '**[UX]** 2026-10-02 12:38 KST → OP · first line\nsecond line', createdAt: '2026-10-02T03:38:00Z' },
    { body: '**[UX]** older', createdAt: '2026-10-02T01:00:00Z' },
    { body: '**[TC]** 2026-10-02 12:20 KST → OP · TC line', createdAt: '2026-10-02T03:20:00Z' },
    { body: 'no prefix', createdAt: '2026-10-02T04:00:00Z' },
  ],
  merged: async () => [
    { number: 22741, title: 'OPS1·OPS2 화면', body: '', mergedAt: '2026-10-02T03:30:00Z' },
    { number: 22734, title: 'notes (REL7)', body: '', mergedAt: '2026-10-02T03:10:00Z' },
    { number: 1, title: 'no id here', body: 'mentions nothing', mergedAt: '2026-10-02T02:00:00Z' },
  ],
  checklist: () => ({ current: [item('OPS1', 'UX', 'green'), item('HS1', 'TC', 'red', 'stop leaves job'), item('REL7b', 'O', 'red')], all: [item('OPS1', 'UX', 'green'), item('REL7', 'TC', 'green'), item('HS1', 'TC', 'red')] }),
  openDecisionRaisers: () => ['TC', 'O', 'MK'],
  ...over,
});

test('contract: one row per seat with now, landed by checklist owner (not author), red items, open decisions and counts', async () => {
  const board = await buildSeatsBoard('2026-10-02', sources());
  expect(board.date).toBe('2026-10-02');
  expect(board.seats.map((row) => row.seat)).toEqual(['OP', 'TC', 'MK', 'UX']);
  const ux = board.seats.find((row) => row.seat === 'UX')!;
  expect(ux).toEqual({
    seat: 'UX', role: 'CXO', channelSource: 'unknown', now: { text: '**[UX]** 2026-10-02 12:38 KST → OP · first line', at: '2026-10-02T03:38:00Z' },
    landed: [{ pr: 22741, title: 'OPS1·OPS2 화면', at: '2026-10-02T03:30:00Z', checklistId: 'OPS1' }],
    blocked: [], pendingDecisions: 0, checklist: { green: 1, yellow: 0, red: 0, done: 0 },
  });
  const tc = board.seats.find((row) => row.seat === 'TC')!;
  expect(tc.landed).toEqual([{ pr: 22734, title: 'notes (REL7)', at: '2026-10-02T03:10:00Z', checklistId: 'REL7' }]);
  expect(tc.blocked).toEqual([{ id: 'HS1', title: 'stop leaves job', status: 'red' }, { id: 'REL7b', title: 'REL7b', status: 'red' }]);
  expect(tc.pendingDecisions).toBe(2); // 'O' is the old name of TC
  expect(board.seats.find((row) => row.seat === 'OP')!.now).toBeNull();
});

test('하위 자리의 빨강 칸과 연결 PR 은 상위 자리 행에 합쳐지고 응답 모양은 그대로다', async () => {
  const board = await buildSeatsBoard('2026-10-02', sources({ checklist: () => ({
    current: [item('REL7', 'TC/rel', 'red'), item('DOC1', 'TC/docs', 'yellow'), item('HS1', 'TC', 'green')],
    all: [item('REL7', 'TC/rel', 'red'), item('DOC1', 'TC/docs', 'yellow'), item('HS1', 'TC', 'green')],
  }) }));
  const tc = board.seats.find((row) => row.seat === 'TC')!;
  expect(tc.blocked).toEqual([{ id: 'REL7', title: 'REL7', status: 'red' }]);
  expect(tc.checklist).toEqual({ green: 1, yellow: 1, red: 1, done: 0 });
  expect(tc.landed).toEqual([{ pr: 22734, title: 'notes (REL7)', at: '2026-10-02T03:10:00Z', checklistId: 'REL7' }]);
  expect(Object.keys(tc).sort()).toEqual(['blocked', 'channelSource', 'checklist', 'landed', 'now', 'pendingDecisions', 'role', 'seat'].sort());
});

test('잘못 저장된 하위 owner 는 TC 칸·연결 PR 에 포함하지 않고 기존 짧은 자리 별칭은 보존한다', async () => {
  const board = await buildSeatsBoard('2026-10-02', sources({ checklist: () => ({
    current: [item('BAD1', 'TC/', 'red'), item('BAD2', 'TC/rel/extra', 'red'), item('REL7', 'TC/rel', 'red'), item('HS1', 'O', 'green')],
    all: [item('BAD1', 'TC/', 'red'), item('BAD2', 'TC/rel/extra', 'red'), item('REL7', 'TC/rel', 'red'), item('HS1', 'O', 'green')],
  }) }));
  const tc = board.seats.find((row) => row.seat === 'TC')!;
  expect(tc.blocked).toEqual([{ id: 'REL7', title: 'REL7', status: 'red' }]);
  expect(tc.checklist).toEqual({ green: 1, yellow: 0, red: 1, done: 0 });
  expect(tc.landed).toEqual([{ pr: 22734, title: 'notes (REL7)', at: '2026-10-02T03:10:00Z', checklistId: 'REL7' }]);
});

test('an unreadable source is null for its fields, never 0 or []', async () => {
  const board = await buildSeatsBoard('2026-10-02', sources({ channel: async () => null, merged: async () => { throw new Error('gh down'); }, checklist: () => null, openDecisionRaisers: () => { throw new Error('locked'); } }));
  for (const row of board.seats) expect(row).toMatchObject({ channelSource: 'unreadable', now: null, landed: null, blocked: null, pendingDecisions: null, checklist: null });
});

test('KST day range and a 60 s cache shared by concurrent requests', async () => {
  expect(kstDayRange('2026-10-02')).toEqual({ start: '2026-10-01T15:00:00.000Z', end: '2026-10-02T15:00:00.000Z' });
  let clock = 0; let calls = 0;
  const cache = createSeatsCache(sources({ channel: async () => { calls++; return []; } }), () => clock);
  await Promise.all([cache('2026-10-02'), cache('2026-10-02')]);
  expect(calls).toBe(1);
  clock += 60_000;
  await cache('2026-10-02');
  expect(calls).toBe(2);
});

test('ledger first; empty or unreadable ledger falls back to GitHub without changing other seat fields', async () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    let ghCalls = 0;
    const githubChannel = async () => { ghCalls++; return [{ body: '**[TC]** github', createdAt: '2026-10-02T01:00:00Z', url: 'https://github.com/o/r/issues/1#issuecomment-2' }]; };
    const listEvents = (opts: { since: string; seat?: string }) => listCoordEvents(opts, { db });
    const live = liveSeatsSources({ listEvents, githubChannel });
    const fallback = await live.channel('2026-10-02');
    expect(fallback).toMatchObject({ source: 'github' });
    expect(ghCalls).toBe(1);
    recordCoordEvent({ seat: 'TC', recipients: ['UX'], all: false, kind: '요청', slot: 'K6', deadline: '기한 06:30',
      url: 'https://github.com/o/r/issues/1#issuecomment-3', headline: '→ UX · 요청 · K6 · 기한 06:30', at: '2026-10-02T02:00:00Z' }, { db });
    const ledger = await live.channel('2026-10-02');
    expect(ledger).toMatchObject({ source: 'ledger', comments: [{ body: '**[TC]** → UX · 요청 · K6 · 기한 06:30',
      createdAt: '2026-10-02T02:00:00Z', url: 'https://github.com/o/r/issues/1#issuecomment-3' }] });
    expect(ghCalls).toBe(1); // a nonempty ledger serves the channel without GitHub
    const board = await buildSeatsBoard('2026-10-02', sources({ channel: live.channel }));
    expect(board.seats.find((row) => row.seat === 'TC')).toMatchObject({ channelSource: 'ledger',
      now: { text: '**[TC]** → UX · 요청 · K6 · 기한 06:30', at: '2026-10-02T02:00:00Z' } });
    expect(board.seats.find((row) => row.seat === 'UX')).toMatchObject({ channelSource: 'unknown', now: null });
    const broken = liveSeatsSources({ listEvents: () => { throw new Error('unreadable'); }, githubChannel });
    expect(await broken.channel('2026-10-02')).toMatchObject({ source: 'github' });
    expect(ghCalls).toBe(2);
  } finally { db.close(); }
});

test('empty ledger uses the default GitHub lookup and returns the comment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-seats-gh-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls');
  const url = 'https://github.com/o/r/issues/1#issuecomment-42';
  const comment = { body: '**[TC]** 2026-10-02 11:00 KST → UX · 보고 · K6',
    createdAt: '2026-10-02T02:00:00Z', url };
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nprintf '%s\\n' '${JSON.stringify(comment)}'\n`);
  chmodSync(gh, 0o755);
  const previousPath = process.env.PATH;
  const previousAppConfig = process.env.ELANOUS_GITHUB_APP_CONFIG_PATH;
  const previousState = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = dir;
    expect(surfaceEventsDbPath()).toBe(join(dir, 'surface_events.db'));
    setElanousConfigDir(dir);
    resetUserConfig();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ decisions: { replyGhPr: 'o/r#1' } }));
    resetUserConfig();
    process.env.ELANOUS_GITHUB_APP_CONFIG_PATH = join(dir, 'no-app-config');
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    const result = await liveSeatsSources().channel('2026-10-02');
    expect(result).toMatchObject({ source: 'github', comments: [comment] });
    const board = await buildSeatsBoard('2026-10-02', sources({ channel: liveSeatsSources().channel }));
    expect(board.seats.find((row) => row.seat === 'TC')).toMatchObject({ channelSource: 'github',
      now: { text: comment.body, at: comment.createdAt } });
    expect(readFileSync(calls, 'utf8')).toContain('api --paginate repos/o/r/issues/1/comments?since=2026-10-01T15:00:00.000Z&per_page=100');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousAppConfig === undefined) delete process.env.ELANOUS_GITHUB_APP_CONFIG_PATH;
    else process.env.ELANOUS_GITHUB_APP_CONFIG_PATH = previousAppConfig;
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousState;
    resetUserConfig();
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complete ledger serves all four seats without querying GitHub', async () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    for (const seat of ['OP', 'TC', 'MK', 'UX']) {
      recordCoordEvent({ seat, recipients: [], all: true, kind: '보고', slot: 'K6', deadline: null,
        url: `https://github.com/o/r/issues/1#issuecomment-${seat}`, headline: `→ 전원 · 보고 · K6 ${seat}`,
        at: '2026-10-02T02:00:00Z' }, { db });
    }
    let calls = 0;
    const live = liveSeatsSources({ listEvents: (opts) => listCoordEvents(opts, { db }), githubChannel: async () => { calls++; return []; } });
    const board = await buildSeatsBoard('2026-10-02', sources({ channel: live.channel }));
    expect(calls).toBe(0);
    for (const row of board.seats) expect(row).toMatchObject({ channelSource: 'ledger', now: { text: `**[${row.seat}]** → 전원 · 보고 · K6 ${row.seat}` } });
  } finally { db.close(); }
});

test('a partial ledger does not guess missing seats and does not call GitHub', async () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    recordCoordEvent({ seat: 'TC', recipients: ['UX'], all: false, kind: '요청', slot: 'K6', deadline: '기한 06:30',
      url: 'https://github.com/o/r/issues/1#issuecomment-3', headline: '→ UX · 요청 · K6 · 기한 06:30', at: '2026-10-02T02:00:00Z' }, { db });
    let calls = 0;
    const live = liveSeatsSources({ listEvents: (opts) => listCoordEvents(opts, { db }), githubChannel: async () => {
      calls++;
      return [
        { body: '**[TC]** older GitHub line', createdAt: '2026-10-02T01:00:00Z', url: 'https://github.com/o/r/issues/1#issuecomment-1' },
        { body: '**[UX]** existing GitHub line', createdAt: '2026-10-02T03:00:00Z', url: 'https://github.com/o/r/issues/1#issuecomment-2' },
      ];
    } });
    const board = await buildSeatsBoard('2026-10-02', sources({ channel: live.channel }));
    expect(calls).toBe(0);
    expect(board.seats.find((row) => row.seat === 'TC')).toMatchObject({ channelSource: 'ledger',
      now: { text: '**[TC]** → UX · 요청 · K6 · 기한 06:30' } });
    expect(board.seats.find((row) => row.seat === 'UX')).toMatchObject({ channelSource: 'unknown', now: null });
    const withoutSeatSources = await buildSeatsBoard('2026-10-02', sources({ channel: async () => ({
      source: 'ledger', comments: [{ body: '**[TC]** one line', createdAt: '2026-10-02T02:00:00Z' }],
    }) }));
    expect(withoutSeatSources.seats.find((row) => row.seat === 'TC')).toMatchObject({ channelSource: 'unknown' });
    expect(withoutSeatSources.seats.find((row) => row.seat === 'UX')).toMatchObject({ channelSource: 'unknown', now: null });
  } finally { db.close(); }
});
