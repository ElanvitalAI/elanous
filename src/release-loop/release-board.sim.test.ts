// RELEASE-BOARD sim world — real release graph code on a virtual clock in a temp test universe, seeds 1·2·3.
// Expectations are literals (KST clock strings, step ids, statuses), never derived from the product's constants.
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSession, type BoardOptions } from '../cli/release-board-cli.js';
import { collectReleaseBoard, listInstances, readRun } from './release-board.js';
import { createReplay, SCENARIOS, type Replay } from './release-board-replay.js';
import { loadRun, noGo, readLedger, skipStep } from './release-graph-exec.js';

const SEEDS = [1, 2, 3];
const kst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(11, 16);

// 출처: #40190 the demo finishes ~160 virtual minutes after 03:39 — 400 ticks is a loop bound, not an expectation
async function runToEnd(r: Replay, max = 400, each?: (t: number) => void | Promise<void>): Promise<number> {
  for (let t = 0; t < max; t++) { await each?.(t); if ((await r.step()).done) return t; }
  return -1;
}
const opts = (stateRoot: string, role: string | null = 'OP'): BoardOptions => ({ stateRoot, mode: () => 'live', universe: 'test', trafficRoots: [], role });
const statusOf = (r: Replay, id: string) => {
  const c = collectReleaseBoard({ stateRoot: r.root, run: r.version, instances: [r.version], following: true, mode: 'live', universe: 'replay', now: r.now(), tick: 0, trafficRoots: [], ...(r.deps.planOptions ? { planOptions: r.deps.planOptions } : {}) });
  if (!c.ok) throw new Error(c.reason);
  return c.snapshot.steps.find(s => s.id === id)!.status;
};

describe.each(SEEDS)('seed %i', (seed) => {
  test('demo: normal → pregate stop → auto quick-surgery at 05:00 → skip docs → publish', async () => {
    const r = createReplay(SCENARIOS.demo!, seed);
    let sawStop = false;
    await runToEnd(r, 400, () => { if (loadRun(r.root, r.version)?.hardStop?.step === 'pregate') sawStop = true; });
    const ledger = readLedger(r.root, r.version);
    expect(sawStop).toBe(true);
    const auto = ledger.find(l => l.kind === 'auto-quick-surgery')!;
    expect(kst(auto.at)).toBe('05:00');
    expect(ledger.find(l => l.kind === 'skipped')?.step).toBe('docs');
    expect(kst(ledger.find(l => l.kind === 'started' && l.step === 'publish')!.at)).toBe('06:00');
    const s = loadRun(r.root, r.version)!;
    expect([s.done, s.profile, s.hardStop ?? null]).toEqual([true, 'quick-surgery', null]);
    expect([statusOf(r, 'pregate'), statusOf(r, 'docs'), statusOf(r, 'publish')]).toEqual(['soft-fail', 'skipped', 'done']);
  });

  test('clean publish: every step done, no stop', async () => {
    const r = createReplay(SCENARIOS.clean!, seed);
    // 출처: #40190 runToEnd returns -1 when the run never finishes — any finishing tick index passes
    expect(await runToEnd(r)).toBeGreaterThan(0);
    expect(readLedger(r.root, r.version).some(l => l.kind === 'hard-stop')).toBe(false);
    expect(statusOf(r, 'publish')).toBe('done');
  });

  test('critical stop (prepare exit 2) → board shows stop → REL resume → publish', async () => {
    const r = createReplay(SCENARIOS['critical-stop']!, seed);
    let stopSeen = false;
    await runToEnd(r, 400, () => { const h = loadRun(r.root, r.version)?.hardStop; if (h?.step === 'prepare' && !h.noncritical) { stopSeen = true; expect(statusOf(r, 'prepare')).toBe('stop'); } });
    expect(stopSeen).toBe(true);
    expect(readLedger(r.root, r.version).filter(l => l.kind === 'resumed').map(l => l.target)).toEqual(['prepare']);
    expect(statusOf(r, 'publish')).toBe('done');
  });

  test('parallel lanes with one slow branch: prebuild runs while pregate is done', async () => {
    const r = createReplay(SCENARIOS['slow-lane']!, seed);
    let both = false;
    await runToEnd(r, 400, () => { if (loadRun(r.root, r.version)?.steps.pregate?.status === 'done' && loadRun(r.root, r.version)?.steps.prebuild?.status === 'running') both = true; });
    expect(both).toBe(true);
    expect(statusOf(r, 'prebuild')).toBe('done');
  });
});

describe('board session in the sim world', () => {
  test('hard stop appears and clears via the board skip (OP · reason · y)', async () => {
    const r = createReplay(SCENARIOS.demo!, 1);
    while (!loadRun(r.root, r.version)?.hardStop) await r.step();
    const s = boardSession(opts(r.root, 'OP'), r);
    s.refresh();
    expect(s.frame(120, 36)[2]).toStartWith('■ HARD STOP at pregate: pregate exited 1');
    for (let i = 0; i < 30 && !s.frame(120, 36).some(l => l.startsWith('› L-2 pregate')); i++) s.key('\x1b[B');
    s.key('s'); s.key('flaky pregate host'); s.key('\r'); s.key('y');
    s.refresh();
    expect(loadRun(r.root, r.version)!.hardStop ?? null).toBe(null);
    expect(readLedger(r.root, r.version).filter(l => l.kind === 'skipped').map(l => [l.step, l.by, l.reason])).toEqual([['pregate', 'OP', 'flaky pregate host']]);
    expect(s.frame(120, 36)[2]).toBe('Critical path: cut → prepare → publish → rail → els-restart → update-all');
  });

  test('read-only for a non-OP/REL seat: m does not change the run', async () => {
    const r = createReplay(SCENARIOS.clean!, 2);
    for (let i = 0; i < 25; i++) await r.step();
    const before = JSON.stringify(loadRun(r.root, r.version));
    const s = boardSession(opts(r.root, 'TC'), r);
    s.refresh(); s.key('m'); s.key('y');
    expect(s.ui.flash).toBeUndefined();
    expect(JSON.stringify(loadRun(r.root, r.version))).toBe(before);
    s.key('m');
    expect(s.ui.flash).toBe('Read-only: mark is for OP or REL (you are TC)');
  });

  test('instances: publish run vs rehearsal#1..#3 — follows the newest, Tab pins, f follows again', async () => {
    const r = createReplay(SCENARIOS.clean!, 3);
    for (let i = 0; i < 5; i++) await r.step();
    const dir = join(r.root, 'release-graph');
    for (const [n, at] of [[1, '2026-11-25T10:00:00.000Z'], [2, '2026-11-25T11:00:00.000Z'], [3, '2026-11-25T23:00:00.000Z']] as const) {
      const key = `${r.version}-rehearsal#${n}`;
      cpSync(join(dir, r.version), join(dir, key), { recursive: true });
      const st = JSON.parse(await Bun.file(join(dir, key, 'state.json')).text()) as Record<string, unknown>;
      writeFileSync(join(dir, key, 'state.json'), JSON.stringify({ ...st, createdAt: at }));
    }
    expect(listInstances(r.root, r.version)).toEqual(['0.3.99-rehearsal#1', '0.3.99-rehearsal#2', '0.3.99', '0.3.99-rehearsal#3']);
    const s = boardSession(opts(r.root), r);
    s.refresh();
    expect(s.run).toBe('0.3.99-rehearsal#3');
    s.key('\t');
    expect([s.run, s.following]).toEqual(['0.3.99-rehearsal#1', false]);
    expect(s.frame(120, 36)[0]).toContain('run 0.3.99-rehearsal#1 (1/4 · pinned)');
    s.key('f'); s.refresh();
    expect([s.run, s.following]).toEqual(['0.3.99-rehearsal#3', true]);
  });

  test('missing · partial · corrupt state → «no data», never a throw', () => {
    const root = mkdtempSync(join(tmpdir(), 'rb-bad-'));
    const s = boardSession({ ...opts(root), version: '0.3.36' });
    s.refresh();
    expect(s.frame(80, 24)[0]).toBe('○ Release 0.3.36 · no data');
    mkdirSync(join(root, 'release-graph', '0.3.36'), { recursive: true });
    writeFileSync(join(root, 'release-graph', '0.3.36', 'state.json'), '{"version":"0.3.36"');
    s.refresh();
    expect(s.frame(80, 24)[1]).toStartWith('state for 0.3.36 is unreadable');
    writeFileSync(join(root, 'release-graph', '0.3.36', 'state.json'), '{"version":"0.3.36","steps":{}}');
    s.refresh();
    expect(s.frame(80, 24)[1]).toBe('state for 0.3.36 is partial (version/clock/steps missing)');
    expect(readRun(root, 'nope')).toEqual({ ok: false, reason: `no state for nope (${join(root, 'release-graph', 'nope', 'state.json')})` });
    s.key('\x1b[A\r?pmsrzq');
  });

  test('host down mid-step (process gone, no rc) → soft step waived as exit -1', async () => {
    const r = createReplay(SCENARIOS.clean!, 1);
    while (loadRun(r.root, r.version)?.steps.pregate?.status !== 'running') await r.step();
    (r.deps as { alive: (p: number) => boolean }).alive = () => false;
    await r.step();
    const st = loadRun(r.root, r.version)!.steps.pregate!;
    expect([st.status, st.exit, st.by]).toEqual(['done', -1, 'graph(soft-fail)']);
    expect(statusOf(r, 'pregate')).toBe('soft-fail');
  });

  test('run aborted (NO-GO) and clock past publish render without overflow', async () => {
    const r = createReplay(SCENARIOS.clean!, 2);
    for (let i = 0; i < 30; i++) await r.step();
    noGo(r.root, r.version, 'OP', 'demo abort', r.now());
    for (let i = 0; i < 200; i++) await r.step();
    const s = boardSession(opts(r.root), r);
    s.refresh();
    expect(s.frame(120, 36)[2]).toBe('■ HARD STOP: demo abort');
    expect(s.frame(120, 36)[1]).toStartWith('cut 04:00 (3h29m ago) · publish 06:00 (1h29m ago)');
    for (const [w, h] of [[120, 36], [100, 30], [80, 24], [60, 20]] as const) for (const l of s.frame(w, h)) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(w);
  });

  test('preview (p) projects quick-surgery without writing the run', async () => {
    const r = createReplay(SCENARIOS.demo!, 1);
    while (!loadRun(r.root, r.version)?.hardStop) await r.step();
    const before = await Bun.file(join(r.root, 'release-graph', r.version, 'state.json')).text();
    const s = boardSession(opts(r.root), r);
    s.refresh(); s.key('p');
    const f = s.frame(120, 36);
    expect(f[0]).toContain('quick-surgery (preview)');
    expect(f[2]).toBe('Critical path: cut → prepare → publish → rail → els-restart → update-all');
    expect(await Bun.file(join(r.root, 'release-graph', r.version, 'state.json')).text()).toBe(before);
  });

  test('10 minutes of 2-second refreshes (300) with rapid keys: heap stays flat', async () => {
    const r = createReplay(SCENARIOS.demo!, 3);
    const s = boardSession(opts(r.root, 'TC'), r);
    const heap = () => { Bun.gc(true); return process.memoryUsage().heapUsed; };
    for (let i = 0; i < 50; i++) { await r.step(); s.refresh(); s.frame(120, 36); }
    const start = heap();
    for (let i = 0; i < 300; i++) { if (i % 2) await r.step(); s.refresh(); s.key('\x1b[B\x1b[Bjk?\x1b'); s.frame(i % 2 ? 80 : 120, i % 2 ? 24 : 36); }
    expect(heap() - start).toBeLessThan(16 * 1024 * 1024);
  }, 60_000);

  test('skip from the graph CLI shows in the ticker', async () => {
    const r = createReplay(SCENARIOS.clean!, 1);
    for (let i = 0; i < 3; i++) await r.step();
    skipStep(r.root, r.version, 'verify', 'REL', 'verify host busy', r.now());
    const s = boardSession(opts(r.root), r);
    s.refresh();
    expect(s.frame(120, 36).find(l => l.startsWith('Events'))).toBe('Events 03:42 skip verify by REL: verify host busy · 03:39 run created (quick-surgery)');
  });
});
