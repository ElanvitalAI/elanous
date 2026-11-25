// Sim world for the quick-surgery publish (CEO 11-25 23:4x): the release graph is the official path when the critical
// path is hit — non-critical refusals are warnings, parallel branches, mark/skip with a reason, a normal run blocked by a
// non-critical refusal switches itself at T−60m. Six scenarios × 3 seeds + edges e1…e7. Commands are fake (timed rc files);
// the seed varies step durations, tick grain and which host is slow. Expectations are independent literals.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConditionProbes } from '../loops/trigger-conditions.js';
import {
  createRun, enterQuickSurgery, loadRun, markDone, noGoWith, readLedger, resumeFrom, skipStep, tickRelease, type ExecDeps, type Profile, type StepDef,
} from './release-graph-exec.js';

const V = '0.3.36';
const CLOCK = { rehearsalAt: '2026-11-25T13:00:00.000Z', cutAt: '2026-11-25T19:00:00.000Z', publishAt: '2026-11-25T21:00:00.000Z' };
const SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const OPTS = { seatState: '/hq/seat-state', uid: 501, cli: 'elanous', repo: '/r', instanceRoot: '/i' };
const SEEDS = [1, 7, 42];

let root: string;
let now: Date;
let rng: () => number;
let mail: Array<{ to: string; body: string }>;
let started: string[];
let exits: Record<string, number[]>; // per step: exit of the 1st, 2nd … run (last value repeats)
let durMin: Record<string, number>;
let dies: Set<string>;
let security: Set<string>;
let pollRows: string[];
let receiptOk: boolean;
const procs = new Map<number, { step: string; end: number; rcPath: string; exit: number; dead: boolean; written?: boolean }>();

function mulberry(seed: number) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function probes(): ConditionProbes {
  return {
    now: () => now, watch: async () => null, mtimeMs: () => null,
    readJson: (p: string) => (p.endsWith('rehearsal-receipt.json') ? { ok: receiptOk } : { sha: SHA, ok: true }),
    readLines: () => pollRows,
    cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0,
    publishedVersions: async () => [V], installedVersion: async () => null,
  } as ConditionProbes;
}

let pidSeq = 1000;
function deps(): ExecDeps {
  return {
    now: () => now, stateRoot: root, mode: () => 'live', probes: probes(),
    detect: async () => null,
    start: (step: StepDef, _cmd, logPath, rcPath, secPath) => {
      const n = started.filter(s => s === step.id).length;
      started.push(step.id);
      const seq = exits[step.id] ?? [0];
      const p = ++pidSeq;
      writeFileSync(logPath, `start ${step.id}\n`);
      if (security.has(step.id)) writeFileSync(secPath, 'secret\n');
      const d = durMin[step.id] ?? Math.round(rng() * 3);
      procs.set(p, { step: step.id, end: now.getTime() + d * 60_000, rcPath, exit: seq[Math.min(n, seq.length - 1)]!, dead: dies.has(step.id) });
      return p;
    },
    alive: (p) => { const pr = procs.get(p); return !!pr && !pr.dead && now.getTime() < pr.end; },
    post: (to, _kind, body) => { mail.push({ to, body }); return `msg#${mail.length}`; },
    planOptions: OPTS,
  };
}

/** Finished fake processes write their rc (a dead host writes none). */
function settle() { for (const pr of procs.values()) if (!pr.dead && !pr.written && now.getTime() >= pr.end) { pr.written = true; writeFileSync(pr.rcPath, `${pr.exit}\n`); } }
const at = (iso: string) => { now = new Date(iso); };
async function tickFor(minutes: number) {
  const grain = 1 + Math.floor(rng() * 2); // 1–2 min tick grain per seed
  for (let m = 0; m < minutes; m += grain) { settle(); await tickRelease(V, deps()); now = new Date(now.getTime() + grain * 60_000); }
}
const op = (answer: 'GO' | 'NO-GO') => JSON.stringify({ poll: '0.3.36:L-3', voter: 'OP', answer, sha: SHA, evidence: 'OP #1' });
const published = () => started.filter(s => s === 'publish').length;
const kinds = () => readLedger(root, V).map(r => `${r.kind}${r.step ? `:${r.step}` : ''}`);

function fresh(seed: number, profile: Profile = 'quick-surgery') {
  root = mkdtempSync(join(tmpdir(), 'release-qs-'));
  rng = mulberry(seed);
  mail = []; started = []; exits = {}; durMin = {}; dies = new Set(); security = new Set(); pollRows = [op('GO')]; receiptOk = true; procs.clear();
  at('2026-11-25T12:00:00.000Z');
  createRun(root, { version: V, quick: true, clock: CLOCK, notesFile: '/h/notes.md', prepDir: '/h/prep', profile }, now);
}
beforeEach(() => { root = ''; });
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

for (const seed of SEEDS) {
  describe(`seed ${seed}`, () => {
    test('S1 clean run → published once, no stop, no cards', async () => {
      fresh(seed);
      await tickFor(10 * 60);
      const s = loadRun(root, V)!;
      expect(s.done).toBe(true); expect(s.hardStop).toBe(null); expect(published()).toBe(1);
      expect(kinds()).toContain('step-done:publish');
      expect(mail).toEqual([]);
    });

    test('S2 non-critical 🟡 roster open → waived, publish on time', async () => {
      fresh(seed); exits.roster = [1];
      await tickFor(10 * 60);
      const s = loadRun(root, V)!;
      expect(s.hardStop).toBe(null); expect(s.done).toBe(true); expect(published()).toBe(1);
      expect(s.steps.roster!.by).toBe('graph(soft-fail)');
      const pubStart = readLedger(root, V).find(r => r.kind === 'started' && r.step === 'publish')!;
      expect(Date.parse(pubStart.at) - Date.parse(CLOCK.publishAt)).toBeLessThan(3 * 60_000);
    });

    test('S3 critical prepare fails → surgery mark clears the stop → published', async () => {
      fresh(seed); exits.prepare = [1];
      await tickFor(8 * 60);
      expect(loadRun(root, V)!.hardStop!.step).toBe('prepare'); expect(published()).toBe(0);
      markDone(root, V, 'prepare', 'REL', 'surgery: critpath re-run by hand, receipt /h/prep/release.json', now);
      expect(loadRun(root, V)!.hardStop).toBe(null);
      await tickFor(4 * 60);
      const s = loadRun(root, V)!;
      expect(s.done).toBe(true); expect(published()).toBe(1);
      expect(kinds()).toContain('stop-cleared:prepare');
    });

    test('S3b critical skip with a reason → published, receipt names the reason', async () => {
      fresh(seed); exits.rehearsal = [1]; exits.prepare = [1];
      await tickFor(8 * 60);
      skipStep(root, V, 'prepare', 'OP', 'prepared dir from the 05:10 hand run is already complete', now);
      await tickFor(4 * 60);
      const s = loadRun(root, V)!;
      expect(s.done).toBe(true); expect(published()).toBe(1);
      expect(s.steps.prepare!.status).toBe('skipped');
      expect(readLedger(root, V).find(r => r.kind === 'skipped')!.reason).toBe('prepared dir from the 05:10 hand run is already complete');
    });

    test('S4 hardStop (OP NO-GO) → resume → published', async () => {
      fresh(seed);
      await tickFor(7 * 60 + 40); // before publish
      noGoWith(root, V, 'OP', 'hold for the demo build check', now);
      await tickFor(60);
      expect(published()).toBe(0);
      resumeFrom(root, V, 'go', 'OP', now);
      await tickFor(3 * 60);
      const s = loadRun(root, V)!;
      expect(s.done).toBe(true); expect(s.hardStop).toBe(null); expect(published()).toBe(1);
    });

    test('S5 old refusals (notes empty · cut-list mismatch · no rehearsal receipt · past the window) → warnings only', async () => {
      fresh(seed); exits.notes = [1]; exits.roster = [1]; receiptOk = false; pollRows = [];
      at('2026-11-25T21:30:00.000Z'); // run started 30 min past publishAt
      await tickFor(5 * 60);
      const s = loadRun(root, V)!;
      expect(s.hardStop).toBe(null); expect(s.done).toBe(true); expect(published()).toBe(1);
      expect(s.steps.notes!.warnings!.length).toBe(1);
      expect(s.steps.cut!.warnings![0]).toContain('rehearsal-receipt');
      expect(s.steps.go!.warnings![0]).toContain('op-go');
    });

    test('S6 parallel branches, slow node-b prebuild + minim5 pregate → publish does not wait; one stall wake', async () => {
      fresh(seed); durMin.prebuild = 200; durMin.pregate = 30 + Math.round(rng() * 60);
      await tickFor(9 * 60 + 30);
      expect(published()).toBe(1);
      expect(loadRun(root, V)!.steps.prebuild!.status).toBe('running');
      expect(mail.filter(m => m.body.includes('STALL') && m.body.includes('prebuild')).length).toBe(1);
      await tickFor(3 * 60);
      expect(loadRun(root, V)!.done).toBe(true);
    });

    test('AUTO normal run blocked by a non-critical refusal → quick-surgery at T−60m → published', async () => {
      fresh(seed, 'normal'); exits.roster = [1];
      await tickFor(6 * 60); // 18:00 — still before T−60m
      let s = loadRun(root, V)!;
      expect(s.hardStop!.noncritical).toBe(true); expect(s.profile).toBe('normal'); expect(published()).toBe(0);
      at('2026-11-25T20:00:00.000Z');
      await tickFor(3 * 60);
      s = loadRun(root, V)!;
      expect(s.profile).toBe('quick-surgery'); expect(s.done).toBe(true); expect(published()).toBe(1);
      expect(kinds()).toContain('auto-quick-surgery:roster');
      expect(mail.filter(m => m.body.includes('switched to the quick-surgery publish')).length).toBe(1);
    });
  });
}

describe('edges', () => {
  test('e1 critical failure twice at the same node → stops twice, second surgery publishes', async () => {
    fresh(42); exits.prepare = [1, 1, 0];
    await tickFor(8 * 60);
    resumeFrom(root, V, 'prepare', 'REL', now);
    await tickFor(60);
    expect(loadRun(root, V)!.hardStop!.step).toBe('prepare'); expect(published()).toBe(0);
    resumeFrom(root, V, 'prepare', 'REL', now);
    await tickFor(4 * 60);
    expect(loadRun(root, V)!.done).toBe(true); expect(published()).toBe(1);
    expect(started.filter(s => s === 'prepare').length).toBe(3);
  });

  test('e2 surgery mark on prepare, then publish itself fails → must stop, never published', async () => {
    fresh(42); exits.prepare = [1]; exits.publish = [1];
    await tickFor(8 * 60);
    markDone(root, V, 'prepare', 'REL', 'surgery', now);
    await tickFor(4 * 60);
    const s = loadRun(root, V)!;
    expect(s.hardStop!.step).toBe('publish'); expect(started).not.toContain('npm'); expect(started).toContain('traffic-restore');
  });

  test('e3 clocks: T−60m exactly switches · T−61m does not · past publish runs at once', async () => {
    fresh(1, 'normal'); exits.roster = [1];
    await tickFor(5 * 60);
    at('2026-11-25T19:59:00.000Z'); settle(); await tickRelease(V, deps());
    expect(loadRun(root, V)!.profile).toBe('normal');
    at('2026-11-25T20:00:00.000Z'); settle(); await tickRelease(V, deps());
    expect(loadRun(root, V)!.profile).toBe('quick-surgery');
    fresh(7); at('2026-11-25T20:55:00.000Z'); await tickFor(4 * 60);
    expect(published()).toBe(1);
    fresh(42); at('2026-11-25T22:10:00.000Z'); await tickFor(3 * 60);
    expect(published()).toBe(1); expect(loadRun(root, V)!.done).toBe(true);
  });

  test('e4 host dies mid parallel step: pregate (soft) → warning; publish (hard) → stop, surgery mark publishes once', async () => {
    fresh(7); dies.add('pregate');
    await tickFor(10 * 60);
    let s = loadRun(root, V)!;
    expect(s.steps.pregate!.warnings![0]).toBe('exit -1 waived (advisory step)'); expect(published()).toBe(1);
    fresh(7); dies.add('publish');
    await tickFor(10 * 60);
    s = loadRun(root, V)!;
    expect(s.hardStop!.reason).toBe('publish exited -1 (process gone without rc)');
    markDone(root, V, 'publish', 'REL', 'gh release view v0.3.36 shows published', now);
    await tickFor(2 * 60);
    expect(loadRun(root, V)!.done).toBe(true); expect(published()).toBe(1); expect(started).toContain('npm');
  });

  test('e5 NO-GO on top of a critical failure: marking the failed step does not clear the NO-GO', async () => {
    fresh(1); exits.prepare = [1];
    await tickFor(8 * 60);
    noGoWith(root, V, 'CEO', 'stop everything', now);
    markDone(root, V, 'prepare', 'REL', 'surgery', now);
    await tickFor(2 * 60);
    expect(loadRun(root, V)!.hardStop!.by).toBe('CEO'); expect(published()).toBe(0);
    resumeFrom(root, V, 'go', 'CEO', now);
    await tickFor(3 * 60);
    expect(published()).toBe(1);
  });

  test('e5b security-4 stop is never cleared by mark/skip', async () => {
    fresh(1); security.add('roster');
    await tickFor(3 * 60);
    markDone(root, V, 'roster', 'REL', 'x', now);
    expect(loadRun(root, V)!.hardStop!.reason).toContain('security-4');
    expect(() => enterQuickSurgery(root, V, 'OP', now)).not.toThrow();
    expect(loadRun(root, V)!.hardStop).not.toBe(null);
  });

  test('e6 resume after process restart: state is on disk, a fresh deps object continues and publishes once', async () => {
    fresh(42); durMin.prepare = 30;
    await tickFor(7 * 60 + 10); // prepare running
    expect(loadRun(root, V)!.steps.prepare!.status).toBe('running');
    // «restart»: new deps, no in-memory state but the rc files and state.json
    await tickFor(5 * 60);
    expect(loadRun(root, V)!.done).toBe(true); expect(published()).toBe(1);
  });

  test('e7 duplicate run + concurrent tick: createRun is single-flight, a held lock does nothing', async () => {
    fresh(7);
    const again = createRun(root, { version: V, quick: false, clock: { ...CLOCK, publishAt: '2030-01-01T00:00:00.000Z' }, profile: 'normal' }, now);
    expect(again.clock.publishAt).toBe(CLOCK.publishAt); expect(again.profile).toBe('quick-surgery');
    writeFileSync(join(root, 'release-graph', V, 'tick.lock'), `1 ${Date.now()}\n`);
    expect((await tickRelease(V, deps())).events).toEqual([]);
    rmSync(join(root, 'release-graph', V, 'tick.lock'));
    await tickFor(10 * 60);
    expect(published()).toBe(1);
  });

  test('manual --quick-surgery on a blocked normal run (before T−60m) waives and publishes', async () => {
    fresh(1, 'normal'); receiptOk = false;
    await tickFor(8 * 60);
    expect(loadRun(root, V)!.hardStop!.step).toBe('cut'); expect(loadRun(root, V)!.hardStop!.noncritical).toBe(true);
    enterQuickSurgery(root, V, 'OP', now);
    await tickFor(3 * 60);
    expect(loadRun(root, V)!.done).toBe(true); expect(published()).toBe(1);
  });
});

test('a non-critical stop (normal profile) never runs traffic-restore or finishes before the switch', async () => {
  fresh(1, 'normal'); receiptOk = false;
  await tickFor(7 * 60 + 30);
  const s = loadRun(root, V)!;
  expect(s.hardStop!.noncritical).toBe(true); expect(started).not.toContain('traffic-restore'); expect(s.done).not.toBe(true);
  at('2026-11-25T20:00:00.000Z'); await tickFor(3 * 60);
  expect(published()).toBe(1); expect(started.filter(x => x === 'traffic-restore').length).toBe(1);
  const order = readLedger(root, V).filter(r => r.kind === 'started').map(r => r.step);
  expect(order.indexOf('traffic-restore')).toBeGreaterThan(order.indexOf('publish'));
});
