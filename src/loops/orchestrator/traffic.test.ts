import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTraffic, seatOfTree, trafficLine, trafficTick, withFinishAdvice, type TrafficProcess } from './traffic.js';
import { ORCHESTRATOR_DEFAULTS, buildUserConfig, saveUserConfig } from '../../user-config.js';

const roots: string[] = [];
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'orch-traffic-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('marker walks up to git root, overrides configured trees, and unknown trees stay unassigned', () => {
  const root = temp();
  const tree = join(root, 'tc');
  mkdirSync(join(tree, '.claude'), { recursive: true });
  writeFileSync(join(tree, '.git'), 'gitdir: elsewhere\n');
  writeFileSync(join(tree, '.claude', 'seat'), 'TC\n');
  const nested = join(tree, 'a', 'b'); mkdirSync(nested, { recursive: true });
  const cfg = { seatTrees: { MK: [tree], UX: [join(root, 'ux')] } };
  expect(seatOfTree(nested, cfg)).toBe('TC');
  expect(seatOfTree(join(root, 'ux', 'src'), cfg)).toBe('UX');
  expect(seatOfTree(join(root, 'unknown'), cfg)).toBeNull();
  writeFileSync(join(tree, '.claude', 'seat'), 'not-a-seat');
  expect(seatOfTree(nested, cfg)).toBeNull();
});

test('TC full, MK 2/6 idle for 40 minutes, UX unknown and OP unassigned; live hourly idempotency and shadow no writes', () => {
  const root = temp();
  const shadowRoot = temp();
  const now = new Date('2026-10-04T15:05:00.000Z');
  const launch = (seat: TrafficProcess['seat'], seconds: number): TrafficProcess => ({
    seat, elapsedSeconds: seconds, cwd: '/example', command: 'bun bin/elanous.mjs harness ask goal.md',
  });
  const processes = [
    ...Array.from({ length: 8 }, () => launch('TC', 3600)),
    launch('MK', 3600), launch('MK', 2400), launch(null, 7200),
    { ...launch('MK', 400), command: 'bun bin/elanous.mjs harness processes' },
  ];
  const cells = [
    { id: 'MK-1', title: 'first cell', status: 'yellow' as const, owner: 'MK' },
    { id: 'MK-2', title: 'second cell', status: 'red' as const, owner: 'MK/sub' },
    { id: 'TC-1', title: 'unrelated', status: 'yellow' as const, owner: 'TC' },
  ];
  const result = trafficTick({ processes, now, caps: ORCHESTRATOR_DEFAULTS.seatCaps, openCells: cells });
  const [op, tc, mk, ux] = result.seats;
  expect([op?.running, tc?.running, mk?.running, ux?.running, result.unassigned]).toEqual([0, 8, 2, 0, 1]);
  expect(tc?.idle).toBe(false);
  expect(mk).toMatchObject({ cap: 6, idleFor: 40, idle: true, nextCell: cells[0] });
  expect(ux).toMatchObject({ idleFor: null, idle: false, nextCell: null });
  expect(op).toMatchObject({ idleFor: null, idle: false });
  expect(trafficTick({ processes: [], now, caps: ORCHESTRATOR_DEFAULTS.seatCaps, openCells: cells,
    lastLaunchAt: { UX: new Date('2026-10-04T12:00:00Z') } }).seats[3]?.idle).toBe(false);
  expect(trafficLine(result, 'shadow')).toBe('traffic OP 0/4 · TC 8/8 · MK 2/6 · UX 0/6 · idle=MK · mode=shadow');
  const log: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const record = (category: string, event: string, data: Record<string, unknown>) => log.push({ category, event, data });
  expect(applyTraffic(result, { mode: 'live', root, log: record })).toBe(1);
  expect(applyTraffic(result, { mode: 'live', root, log: record })).toBe(0);
  const journal = join(root, 'seat-requests', 'requests.jsonl');
  const lines = readFileSync(journal, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({ key: 'orch-traffic:MK:2026-10-04T15', receiptId: 'orch-traffic:MK:2026-10-04T15', seat: 'MK',
    text: '다음 칸 쏘라: MK-1 first cell (지금 2/6 · 40분 놂)', status: 'queued',
    queuedAt: now.toISOString(), source: 'orchestrator-traffic' });
  expect(applyTraffic(result, { root: shadowRoot, log: record })).toBe(0);
  expect(existsSync(join(shadowRoot, 'seat-requests'))).toBe(false);
  expect(log.filter(row => row.event === 'would-nudge' && row.category === 'loop.orchestrator')).toHaveLength(1);
  expect(log.filter(row => row.event === 'exchange').map(row => row.data.outcome)).toEqual(['queued', 'duplicate']);
});

test('exact 30 minutes does not nudge; a later launch resets the clock, without a cell no request is queued', () => {
  const now = new Date('2026-10-04T15:00:00Z');
  const mk = (elapsedSeconds: number): TrafficProcess => ({ seat: 'MK', command: 'bun bin/elanous.mjs harness say next', elapsedSeconds });
  const tick = (processes: TrafficProcess[]) => trafficTick({ processes, now, caps: ORCHESTRATOR_DEFAULTS.seatCaps, openCells: [] });
  expect(tick([mk(1800)]).seats[2]?.idle).toBe(false);
  expect(tick([mk(2400), mk(60)]).seats[2]?.idleFor).toBe(1);
  const result = tick([mk(2400)]);
  expect(result.seats[2]).toMatchObject({ idle: true, nextCell: null });
  const root = temp();
  expect(applyTraffic(result, { mode: 'live', root, log: () => {} })).toBe(0);
  expect(existsSync(join(root, 'seat-requests'))).toBe(false);
});

test('live only appends to an existing journal; shadow leaves its bytes unchanged', () => {
  const root = temp();
  const dir = join(root, 'seat-requests'); mkdirSync(dir);
  const path = join(dir, 'requests.jsonl');
  const existing = JSON.stringify({ key: 'previous', receiptId: 'previous', seat: 'TC', text: 'prior', status: 'queued', queuedAt: '2026-10-04T13:00:00Z' }) + '\n';
  writeFileSync(path, existing);
  const now = new Date('2026-10-04T15:05:00Z');
  const result = trafficTick({ processes: [{ seat: 'MK', command: 'bun bin/elanous.mjs harness ask goal.md', elapsedSeconds: 2400 }],
    now, caps: ORCHESTRATOR_DEFAULTS.seatCaps, openCells: [{ id: 'MK-1', title: 'one', status: 'yellow', owner: 'MK' }] });
  expect(applyTraffic(result, { root, log: () => {} })).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(existing);
  expect(applyTraffic(result, { root, mode: 'live', log: () => {} })).toBe(1);
  expect(readFileSync(path, 'utf8').startsWith(existing)).toBe(true);
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
});

test('config defaults and explicit seat trees, caps, mode survive parsing and saving', () => {
  const root = temp(); const path = join(root, 'config.json');
  expect(buildUserConfig(path).loops?.orchestrator).toEqual(ORCHESTRATOR_DEFAULTS);
  writeFileSync(path, JSON.stringify({ loops: { orchestrator: { seatTrees: { MK: ['/tmp/mk', 42], UX: ['relative'] }, seatCaps: { TC: 4, MK: 3, UX: -1 }, trafficMode: 'live' } } }));
  const cfg = buildUserConfig(path);
  expect(cfg.loops?.orchestrator).toEqual({ mode: 'shadow', seatTrees: { MK: ['/tmp/mk'], UX: [] }, seatCaps: { TC: 4, MK: 3, UX: 6, OP: 4 }, trafficMode: 'live' });
  saveUserConfig(cfg, path);
  expect(buildUserConfig(path).loops?.orchestrator).toEqual(cfg.loops?.orchestrator);
});

test('fake collectors append finish advice without changing seat decisions, and both modes only log rebalance', () => {
  const now = new Date('2026-10-04T16:00:00Z');
  const original = trafficTick({ processes: [{ seat: 'MK', command: 'bun bin/elanous.mjs harness ask goal.md', elapsedSeconds: 2400 }],
    now, caps: { ...ORCHESTRATOR_DEFAULTS.seatCaps, TC: 4 }, openCells: [{ id: 'MK-1', title: 'one', status: 'yellow', owner: 'MK' }] });
  const result = withFinishAdvice(original, {
    listStarts: () => ({ starts: Array.from({ length: 40 }, (_, i) => ({ runId: `run-${i}`, startedAt: now.toISOString() })), unreadable: [] }),
    runGh: args => JSON.stringify(args.includes('merged')
      ? Array.from({ length: 12 }, (_, i) => ({ number: i, headRefName: `self-impl/${i}`, mergedAt: now.toISOString() }))
      : args.includes('--draft')
        ? Array.from({ length: 30 }, (_, i) => ({ number: i, headRefName: `self-impl/${i}`, createdAt: '2026-10-03T15:00:00Z', labels: i < 5 ? [{ name: 'elanous:superseded' }] : [] }))
        : Array.from({ length: 50 }, (_, i) => ({ number: i, headRefName: `self-impl/${i}`, mergeable: i < 30 ? 'CONFLICTING' : i < 40 ? 'MERGEABLE' : 'UNKNOWN' }))),
  });
  expect(result.seats).toEqual(original.seats);
  expect(result.unassigned).toBe(original.unassigned);
  expect(trafficLine(result, 'shadow')).toBe('traffic OP 0/4 · TC 0/4 · MK 1/6 · UX 0/6 · idle=MK · mode=shadow · finish rate=0.30 stale=25 conflict=0.75 → finish=6/20');
  expect(JSON.parse(JSON.stringify(result)).finish).toMatchObject({ metrics: { unknownMergeable: 10 }, advice: { state: 'backlogged', finishSlots: 6, launchSlots: 14 } });
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const mode of ['shadow', 'live'] as const) {
    applyTraffic(result, { mode, root: temp(), log: (_category, event, data) => { events.push({ event, data }); } });
  }
  expect(events.filter(row => row.event === 'would-rebalance').map(row => row.data)).toEqual(Array(2).fill({ finishSlots: 6, launchSlots: 14, state: 'backlogged', reasons: ['landingRate below threshold', 'staleDrafts above threshold', 'conflictRatio above threshold'] }));
  const unavailable = withFinishAdvice(original, { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => { throw new Error('gh offline'); } });
  expect(trafficLine(unavailable, 'shadow')).toEndWith('finish rate=? stale=? conflict=? → finish=6/20');
  expect(unavailable.finish?.advice.state).toBe('unknown');
});

test('seat trees match by real path — a /private/var cwd matches a configured /var/folders tree (macOS)', () => {
  const base = mkdtempSync(join(tmpdir(), 'traffic-realpath-'));
  try {
    const tree = join(base, 'harvest');
    mkdirSync(tree);
    const link = join(base, 'link');
    symlinkSync(base, link);
    // configured through a symlinked path, observed as the real path (and the other way round)
    expect(seatOfTree(realpathSync(tree), { seatTrees: { UX: [join(link, 'harvest')] } })).toBe('UX');
    expect(seatOfTree(join(link, 'harvest'), { seatTrees: { UX: [realpathSync(tree)] } })).toBe('UX');
    expect(seatOfTree(join(base, 'other'), { seatTrees: { UX: [tree] } })).toBeNull();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
