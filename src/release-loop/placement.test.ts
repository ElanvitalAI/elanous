import { afterEach, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, checklistHistory, listChecklist, setItem } from './checklist.js';
import { mergedPrsLast24h, placeCell, rebalance, seatMove } from './placement.js';
import { move } from './feature-store.js';
import { setSchedule } from './release-schedule.js';

let dir = '';
const now = new Date('2026-10-04T00:00:00.000Z');
function setup() {
  dir = mkdtempSync(join(tmpdir(), 'release-placement-'));
  setElanousConfigDir(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ release: { placement: { seatCap: { TC: 2, MK: 2 } } } }));
  for (const [version, deadline] of [['0.2.14', '05T02'], ['0.2.15', '05T12'], ['0.2.16', '06T02'], ['0.2.17', '07T02']] as const)
    setSchedule(version, { cutAt: `2026-10-${deadline}:00Z`, landBy: `2026-10-${deadline}:00Z` }, 'OP');
}
afterEach(() => { resetElanousConfigDir(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
const cell = (id: string, priority: 'P0' | 'P1' | 'P2' = 'P2') => ({ id, title: id, owner: 'TC', priority, predecessors: [] });
const deps = () => ({ now, merged24h: 2 });

test('merged PR throughput is measured from the first-class query within the exact last 24 hours', () => {
  setup();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "[{\\"number\\":1,\\"mergedAt\\":\\"2026-10-03T01:00:00Z\\"},{\\"number\\":2,\\"mergedAt\\":\\"2026-10-02T23:59:59Z\\"}]"\n');
  chmodSync(gh, 0o700);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ''}`;
  try { expect(mergedPrsLast24h(now)).toBe(1); }
  finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; }
});

test('P0 next; P1 named deadline; P2 earliest capacity, seat cap and predecessor after its release', () => {
  setup();
  expect(placeCell(cell('incident', 'P0'), deps()).version).toBe('0.2.14');
  expect(placeCell({ ...cell('event', 'P1'), owner: 'MK', deadlineVersion: '0.2.15' }, deps()).version).toBe('0.2.15');
  expect(placeCell(cell('ordinary'), deps()).version).toBe('0.2.15');
  expect(placeCell({ ...cell('dependent'), predecessors: ['ordinary'] }, deps()).version).toBe('0.2.16');
  expect(() => placeCell({ ...cell('blocked', 'P0'), predecessors: ['ordinary'] }, deps())).toThrow('배치할 판이 없다');
  expect(listChecklist('0.2.16').items[0]).toMatchObject({ priority: 'P2', predecessors: ['ordinary'] });
  expect(placeCell(cell('overflow'), { ...deps(), seatCap: { TC: 1 } }).version).toBe('0.2.17');
});

test('P0 incident goes to next release even if its old P2 deadline has expired', () => {
  setup();
  addItem('0.2.14', { ...cell('incident'), deadlineVersion: '0.2.14' });
  const later = new Date('2026-10-05T03:00:00Z');
  expect(placeCell({ ...cell('incident', 'P0'), deadlineVersion: '0.2.14' }, { now: later, merged24h: 10 }).version).toBe('0.2.15');
});

test('P1 displaces P2 into next release, with persisted move reason; dry run leaves ledger untouched', () => {
  setup();
  addItem('0.2.15', { ...cell('flex') });
  addItem('0.2.15', { id: 'existing', title: 'existing', owner: 'MK' });
  const p1 = { ...cell('urgent', 'P1'), deadlineVersion: '0.2.15' };
  const preview = placeCell(p1, { ...deps(), dryRun: true });
  expect(preview.displaced).toMatchObject([{ id: 'flex', from: '0.2.15', to: '0.2.16' }]);
  expect(listChecklist('0.2.15').items.map((item) => item.id)).toEqual(['flex', 'existing']);
  expect(placeCell(p1, deps()).displaced).toEqual(preview.displaced);
  expect(checklistHistory('flex').at(-1)).toMatchObject({ field: 'move', from: '0.2.15', to: '0.2.16', reason: expect.stringContaining('P1 urgent') });
  expect(listChecklist('0.2.15').items.map((item) => item.id)).toEqual(['existing', 'urgent']);
});

test('release without landing deadline cannot borrow its cut time as placement capacity', () => {
  setup();
  const schedules = [setSchedule('0.2.18', { cutAt: '2026-10-07T12:00Z' }, 'OP')];
  expect(() => placeCell(cell('no-deadline'), { ...deps(), schedules })).toThrow('배치할 판이 없다');
});

test('one displacement cannot hide an overfull release or exceed the destination seat cap', () => {
  setup();
  addItem('0.2.15', { ...cell('flex') });
  addItem('0.2.15', { ...cell('extra') });
  addItem('0.2.15', { id: 'other', title: 'other', owner: 'MK' });
  const before = listChecklist('0.2.15').items.map((item) => item.id);
  expect(() => placeCell({ ...cell('urgent', 'P1'), deadlineVersion: '0.2.15' }, deps())).toThrow('배치할 판이 없다');
  expect(listChecklist('0.2.15').items.map((item) => item.id)).toEqual(before);
  move('extra', '0.2.15', '0.2.17', 'OP', undefined, undefined, 'free one slot');
  addItem('0.2.16', { ...cell('seat-full') });
  expect(() => placeCell({ ...cell('urgent', 'P1'), deadlineVersion: '0.2.15' }, { ...deps(), seatCap: { TC: 1 } })).toThrow('배치할 판이 없다');
  expect(listChecklist('0.2.15').items.map((item) => item.id)).toEqual(['flex', 'other']);
});

test('P1 cannot displace a P2 predecessor onto its dependent in the next release', () => {
  setup();
  addItem('0.2.15', { ...cell('base') });
  addItem('0.2.15', { id: 'other', title: 'other', owner: 'MK', priority: 'P1' });
  addItem('0.2.16', { ...cell('dependent'), owner: 'MK', predecessors: ['base'] });
  expect(() => placeCell({ ...cell('urgent', 'P1'), deadlineVersion: '0.2.15' }, deps())).toThrow('배치할 판이 없다');
  expect(listChecklist('0.2.15').items.map((item) => item.id)).toEqual(['base', 'other']);
  expect(listChecklist('0.2.16').items.map((item) => item.id)).toEqual(['dependent']);
  expect(checklistHistory('base').filter((row) => row.field === 'move')).toHaveLength(0);
});

test('P1 displaces an independent P2, not a predecessor of a cell in a later release', () => {
  setup();
  addItem('0.2.15', { ...cell('flex') });
  addItem('0.2.15', { ...cell('base') });
  addItem('0.2.16', { ...cell('dependent'), owner: 'MK', predecessors: ['base'] });
  const decision = placeCell({ ...cell('urgent', 'P1'), deadlineVersion: '0.2.15' }, { ...deps(), merged24h: 3 });
  expect(decision.displaced).toMatchObject([{ id: 'flex', from: '0.2.15', to: '0.2.16' }]);
  expect(listChecklist('0.2.15').items.map((item) => item.id)).toEqual(['base', 'urgent']);
  expect(listChecklist('0.2.16').items.map((item) => item.id).sort()).toEqual(['dependent', 'flex']);
  expect(checklistHistory('base').filter((row) => row.field === 'move')).toHaveLength(0);
  expect(checklistHistory('flex').at(-1)).toMatchObject({ field: 'move', reason: expect.stringContaining('P1 urgent') });
});

test('existing cell cannot move onto or past a dependent in a later release', () => {
  setup();
  addItem('0.2.14', { ...cell('base') });
  addItem('0.2.15', { ...cell('dependent'), owner: 'MK', predecessors: ['base'] });
  const later = new Date('2026-10-05T03:00:00Z');
  expect(() => placeCell(cell('base', 'P0'), { now: later, merged24h: 10 })).toThrow('배치할 판이 없다');
  expect(() => placeCell(cell('base'), { now: later, merged24h: 10 })).toThrow('배치할 판이 없다');
  expect(listChecklist('0.2.14').items.map((item) => item.id)).toEqual(['base']);
  expect(checklistHistory('base').filter((row) => row.field === 'move')).toHaveLength(0);
});

test('existing cell priority override persists in the checklist and capacity rule uses the next release', () => {
  setup();
  addItem('0.2.14', { id: 'existing', title: 'existing', owner: 'TC', priority: 'P2' });
  expect(placeCell(cell('existing', 'P0'), deps()).version).toBe('0.2.14');
  expect(listChecklist('0.2.14').items[0]?.priority).toBe('P0');
  expect(checklistHistory('existing').find((row) => row.field === 'priority')).toMatchObject({ field: 'priority', from: 'P2', to: 'P0' });
});

test('freeze window holds operational rollout only — the frozen release still takes cells, including a P1 deadline', () => {
  setup();
  setSchedule('0.2.15', { freezeFrom: '2026-10-05T01:00Z', freezeUntil: '2026-10-05T03:00Z' }, 'OP');
  const duringFreeze = new Date('2026-10-05T01:30:00Z');
  expect(placeCell(cell('ordinary'), { now: duringFreeze, merged24h: 10 }).version).toBe('0.2.15');
  expect(listChecklist('0.2.15').items.map((item) => item.id)).toContain('ordinary');
  expect(placeCell({ ...cell('event', 'P1'), deadlineVersion: '0.2.15' }, { now: duringFreeze, merged24h: 10 }).version).toBe('0.2.15');
});

test('backlog 0.9.0 is a placement source only: its cell moves out to a dated release and nothing is placed into it', () => {
  setup();
  setSchedule('0.9.0', { cutAt: '2026-12-31T00:00Z', landBy: '2026-12-31T00:00Z' }, 'OP');
  addItem('0.9.0', { id: 'later', title: 'later', owner: 'TC', priority: 'P2' });
  const decision = placeCell(cell('later'), { ...deps(), merged24h: 10 });
  expect(decision).toMatchObject({ from: '0.9.0', version: '0.2.14' });
  expect(listChecklist('0.9.0').items.map((item) => item.id)).not.toContain('later');
  expect(listChecklist('0.2.14').items.map((item) => item.id)).toContain('later');
  for (const version of ['0.2.14', '0.2.15', '0.2.16', '0.2.17']) for (let i = 0; i < 2; i++) addItem(version, { id: `fill-${version}-${i}`, title: 'fill', owner: 'MK' });
  expect(() => placeCell(cell('nowhere'), { ...deps(), merged24h: 1, seatCap: {} })).toThrow('배치할 판이 없다');
  expect(listChecklist('0.9.0').items.map((item) => item.id)).not.toContain('nowhere');
});

test('seat moves only its own cell one release with reason; other owner pull denied with COO request', () => {
  setup();
  addItem('0.2.14', { id: 'mk', title: 'MK cell', owner: 'MK' });
  expect(() => seatMove('mk', '0.2.14', '0.2.15', 'TC', 'pull')).toThrow('COO 에 요청');
  expect(() => seatMove('mk', '0.2.14', '0.2.15', 'MK', ' ')).toThrow('이유');
  expect(() => seatMove('mk', '0.2.14', '0.2.16', 'MK', 'skip')).toThrow('COO 에 요청');
  seatMove('mk', '0.2.14', '0.2.15', 'MK/sub', 'capacity', { ...deps(), merged24h: 10 });
  expect(checklistHistory('mk').at(-1)).toMatchObject({ reason: 'capacity', by: 'MK/sub' });
});

test('CLI place/rebalance dry runs preserve ledger; seat CLI denies foreign pull with COO request', async () => {
  setup();
  const lines: string[] = [];
  const output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  const previous = process.env.ELANOUS_TRACK;
  const path = process.env.PATH;
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(join(bin, 'pr.json'), JSON.stringify(Array.from({ length: 40 }, (_, number) => ({ number, mergedAt: recent }))));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat '${join(bin, 'pr.json')}'\n`);
  chmodSync(join(bin, 'gh'), 0o700);
  process.env.PATH = `${bin}:${path ?? ''}`;
  // The CLI reads the real clock, so its schedule must stay in the future whenever the suite runs.
  for (const [index, version] of ['0.2.14', '0.2.15', '0.2.16', '0.2.17'].entries()) {
    const at = new Date(Date.now() + (index + 1) * 86_400_000).toISOString();
    setSchedule(version, { cutAt: at, landBy: at }, 'OP');
  }
  try {
    addItem('0.2.14', { id: 'K', title: 'K', owner: 'MK', priority: 'P2' });

    const cmd = new Command(); registerReleaseCommands(cmd);
    const run = async (...args: string[]) => cmd.parseAsync(['release', ...args], { from: 'user' });
    await run('checklist', 'set', 'K', '--version', '0.2.14', '--deadline-version', '0.2.16');
    expect(listChecklist('0.2.14').items[0]?.deadlineVersion).toBe('0.2.16');
    delete process.env.ELANOUS_TRACK;
    await expect(run('checklist', 'move', 'K', '--from', '0.2.14', '--to', '0.2.15')).rejects.toThrow('이동 이유');
    await expect(run('place', 'K', '--priority', 'P0')).rejects.toThrow('COO 에 요청');
    process.env.ELANOUS_TRACK = 'TC';
    await expect(run('checklist', 'move', 'K', '--from', '0.2.14', '--to', '0.2.15', '--reason', 'pull')).rejects.toThrow('COO 에 요청');
    expect(listChecklist('0.2.14').items.map((item) => item.id)).toEqual(['K']);
    process.env.ELANOUS_TRACK = 'OP';
    await run('place', 'K', '--priority', 'P0', '--dry-run');
    expect(lines.at(-1)).toContain('드라이런');
    expect(listChecklist('0.2.14').history.filter((row) => row.id === 'K')).toHaveLength(2);
    await run('rebalance', '--version', '0.2.14', '--dry-run');
    expect(listChecklist('0.2.14').items.map((item) => item.id)).toEqual(['K']);
    delete process.env.ELANOUS_TRACK;
    await run('checklist', 'move', 'K', '--from', '0.2.14', '--to', '0.2.15', '--reason', 'anonymous session');
    expect(listChecklist('0.2.15').items.map((item) => item.id)).toEqual(['K']);
  } finally {
    output.mockRestore();
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    if (previous === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = previous;
  }
});

test('CLI refuses to assert P2 for a cell without recorded priority', async () => {
  setup();
  addItem('0.2.14', { id: 'unknown', title: 'unknown', owner: 'TC' });
  const previous = process.env.ELANOUS_TRACK;
  process.env.ELANOUS_TRACK = 'OP';
  const lines: string[] = [];
  const output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  try {
    const cmd = new Command(); registerReleaseCommands(cmd);
    await expect(cmd.parseAsync(['release', 'place', 'unknown', '--dry-run'], { from: 'user' })).rejects.toThrow('--priority P0|P1|P2');
    expect(lines.join(' ')).not.toContain('P2');
    expect(listChecklist('0.2.14').items[0]?.priority).toBeUndefined();
  } finally {
    output.mockRestore();
    if (previous === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = previous;
  }
});

test('rebalance checks cumulative PR/seat capacity and does not move a predecessor onto its dependent', () => {
  setup();
  const near = new Date('2026-10-05T01:00:00Z');
  addItem('0.2.14', { ...cell('first') });
  addItem('0.2.14', { ...cell('second') });
  expect(rebalance('0.2.14', { now: near, merged24h: 4, seatCap: { TC: 1 } }).decisions.map((row) => row.id)).toEqual(['first']);
  expect(listChecklist('0.2.14').items.map((item) => item.id)).toEqual(['second']);
  expect(listChecklist('0.2.15').items.map((item) => item.id)).toEqual(['first']);
  addItem('0.2.14', { ...cell('base') });
  addItem('0.2.15', { ...cell('dependent'), owner: 'MK', predecessors: ['base'] });
  expect(rebalance('0.2.14', { now: near, merged24h: 20 }).decisions.map((row) => row.id)).toEqual(['second']);
  expect(listChecklist('0.2.14').items.map((item) => item.id)).toEqual(['base']);
  expect(checklistHistory('base').filter((row) => row.field === 'move')).toHaveLength(0);
});

test('CEO load blocks rebalance with named adjustments and CLI never calls the blocked cell absent', async () => {
  setup();
  const current = new Date(Date.now() + 3_600_000).toISOString();
  const destination = new Date(Date.now() + 86_400_000).toISOString();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(destination));
  setSchedule('0.2.14', { cutAt: current, landBy: current }, 'OP');
  setSchedule('0.2.15', { cutAt: destination, landBy: destination }, 'OP');
  addItem('0.2.14', { ...cell('sns'), owner: 'MK', ceoMinutes: 20, ceoDate: day });
  addItem('0.2.15', { ...cell('youtube'), owner: 'MK', ceoMinutes: 20, ceoDate: day });
  const preview = rebalance('0.2.14', { merged24h: 40, dryRun: true });
  expect(preview.decisions).toEqual([]);
  const blocked = preview.blocked[0]!;
  expect([blocked.id, blocked.from, blocked.to]).toEqual(['sns', '0.2.14', '0.2.15']);
  expect(blocked.reason.includes('대표 손 과부하')).toBe(true);
  expect(blocked.reason.includes('40분 > 하루 상한 30분')).toBe(true);
  for (const alternative of ['늦추기', '자리 대행', '묶기']) expect(blocked.reason.includes(alternative)).toBe(true);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const recent = new Date().toISOString();
  writeFileSync(join(bin, 'pr.json'), JSON.stringify(Array.from({ length: 40 }, (_, number) => ({ number, mergedAt: recent }))));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat '${join(bin, 'pr.json')}'\n`);
  chmodSync(join(bin, 'gh'), 0o700);
  const path = process.env.PATH;
  const track = process.env.ELANOUS_TRACK;
  const lines: string[] = [];
  const output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  try {
    process.env.PATH = `${bin}:${path ?? ''}`;
    process.env.ELANOUS_TRACK = 'OP';
    const cmd = new Command(); registerReleaseCommands(cmd);
    await cmd.parseAsync(['release', 'rebalance', '--version', '0.2.14'], { from: 'user' });
    expect(lines.join('\n')).toContain('⛔ sns 0.2.14 → 0.2.15 이월 거부');
    for (const alternative of ['늦추기', '자리 대행', '묶기']) expect(lines.join('\n')).toContain(alternative);
    expect(lines.join('\n')).not.toContain('이월할 미시작 칸 없음');
    expect(listChecklist('0.2.14').items.map((item) => item.id)).toEqual(['sns']);
    expect(checklistHistory('sns').filter((row) => row.field === 'move')).toHaveLength(0);
  } finally {
    output.mockRestore();
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    if (track === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = track;
  }
});

test('rebalance enforces cumulative destination PR capacity across seats', () => {
  setup();
  const near = new Date('2026-10-05T01:00:00Z');
  addItem('0.2.14', { ...cell('tc') });
  addItem('0.2.14', { ...cell('mk'), owner: 'MK' });
  expect(rebalance('0.2.14', { now: near, merged24h: 4, dryRun: true }).decisions.map((row) => row.id)).toEqual(['tc']);
  expect(listChecklist('0.2.15').items).toHaveLength(0);
  expect(rebalance('0.2.14', { now: near, merged24h: 4 }).decisions.map((row) => row.id)).toEqual(['tc']);
  expect(listChecklist('0.2.14').items.map((item) => item.id)).toEqual(['mk']);
});

test('seat move rejects deadline, capacity, and dependent constraints before writing history (a freeze window does not block it)', () => {
  setup();
  const options = { ...deps(), merged24h: 10 };
  addItem('0.2.14', { ...cell('base'), deadlineVersion: '0.2.14' });
  expect(() => seatMove('base', '0.2.14', '0.2.15', 'TC', 'delay', options)).toThrow('마감 판');
  setSchedule('0.2.15', { freezeFrom: '2026-10-04T00:00Z', freezeUntil: '2026-10-04T01:00Z' }, 'OP');
  addItem('0.2.14', { ...cell('flex') });
  addItem('0.2.15', { ...cell('full') });
  expect(() => seatMove('flex', '0.2.14', '0.2.15', 'TC', 'delay', { ...options, seatCap: { TC: 1 } })).toThrow('자리 용량');
  expect(() => seatMove('flex', '0.2.14', '0.2.15', 'TC', 'delay', { ...options, merged24h: 1 })).toThrow('PR 용량');
  addItem('0.2.15', { ...cell('dependent'), owner: 'MK', predecessors: ['flex'] });
  expect(() => seatMove('flex', '0.2.14', '0.2.15', 'TC', 'delay', options)).toThrow('의존 칸');
  expect(checklistHistory('flex').filter((row) => row.field === 'move')).toHaveLength(0);
});

test('same priority places the accelerator cell first by displacing an unmarked peer', () => {
  setup();
  addItem('0.2.14', { ...cell('ordinary'), title: '일반 칸' });
  const decision = placeCell({ ...cell('accel'), title: '스마트 머지', accelerator: true }, { ...deps(), seatCap: { TC: 1 }, merged24h: 2 });
  expect(decision.version).toBe('0.2.14');
  expect(decision.displaced.map((row) => row.id)).toEqual(['ordinary']);
  expect(decision.reason).toContain('가속 등급');
  expect(listChecklist('0.2.14').items.map((item) => item.id)).toEqual(['accel']);
  expect(listChecklist('0.2.14').items[0]?.accelerator).toBe(true);
  expect(checklistHistory('ordinary').at(-1)).toMatchObject({ field: 'move', reason: expect.stringContaining('가속 등급 accel') });
});

test('an accelerator cell still takes the earliest version with room and displaces nobody', () => {
  setup();
  const decision = placeCell({ ...cell('accel'), accelerator: true }, { ...deps(), seatCap: { TC: 2 }, merged24h: 2 });
  expect(decision.version).toBe('0.2.14');
  expect(decision.displaced).toEqual([]);
  expect(listChecklist('0.2.14').items[0]?.accelerator).toBe(true);
});

test('a P1 accelerator keeps the P1 rule of pushing a P2 cell', () => {
  setup();
  addItem('0.2.14', { ...cell('low', 'P2'), title: 'low' });
  const decision = placeCell({ ...cell('accel', 'P1'), deadlineVersion: '0.2.14', accelerator: true }, { ...deps(), seatCap: { TC: 1 }, merged24h: 2 });
  expect(decision.version).toBe('0.2.14');
  expect(decision.displaced.map((row) => row.id)).toEqual(['low']);
});

test('the accelerator flag round-trips on the ledger and can be cleared', () => {
  setup();
  addItem('0.2.16', { id: 'X', title: 'x', owner: 'TC', priority: 'P2' });
  setItem('0.2.16', 'X', { accelerator: true }, 'OP');
  expect(listChecklist('0.2.16').items[0]?.accelerator).toBe(true);
  expect(checklistHistory('X').find((row) => row.field === 'accelerator')).toMatchObject({ from: null, to: true, by: 'OP' });
  setItem('0.2.16', 'X', { accelerator: null }, 'OP');
  expect(listChecklist('0.2.16').items[0]?.accelerator).toBeUndefined();
});

test('rebalance moves only unstarted yellow cells in two-hour pre-deadline window', () => {
  setup();
  addItem('0.2.14', { id: 'new', title: 'new', owner: 'TC' });
  addItem('0.2.14', { id: 'started', title: 'started', owner: 'MK' });
  setItem('0.2.14', 'started', { evidence: 'started' }, 'MK');
  const near = new Date('2026-10-05T01:00:00Z');
  expect(rebalance('0.2.14', { now, dryRun: true })).toEqual({ decisions: [], blocked: [] });
  expect(rebalance('0.2.14', { now: near, merged24h: 10, dryRun: true }).decisions.map((row) => row.id)).toEqual(['new']);
  expect(listChecklist('0.2.14').items).toHaveLength(2);
  rebalance('0.2.14', { now: near, merged24h: 10 });
  expect(checklistHistory('new').at(-1)).toMatchObject({ field: 'move', reason: expect.stringContaining('2시간 전') });
  expect(listChecklist('0.2.14').items.map((item) => item.id)).toEqual(['started']);
  addItem('0.2.15', { id: 'late', title: 'late', owner: 'MK', deadlineVersion: '0.2.15' });
  const before = listChecklist('0.2.15').items.map((item) => item.id);
  expect(rebalance('0.2.15', { now: new Date('2026-10-05T11:00:00Z'), merged24h: 10 }).decisions.map((row) => row.id)).toEqual(['new']);
  expect(listChecklist('0.2.15').items.map((item) => item.id)).toEqual(['late']);
  expect(before).toEqual(['new', 'late']);
});
