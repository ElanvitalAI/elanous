/**
 * Release Board replay — a test universe (temp state root) driven by synthetic events through the REAL graph code
 * (createRun · tickRelease · skipStep · the T−60m auto-switch). The fake executor never runs a command: it records the
 * start and writes the step's rc after the golden expectMin (± a seeded jitter) of virtual time.
 *
 *   demo: normal profile → pregate refuses (exit 1 · non-critical stop) → blocked → auto quick-surgery at T−60m
 *         → OP GO bound to the cut → OP skips docs → publish 06:00 → L-6..L-8 → finished.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConditionProbes } from '../loops/trigger-conditions.js';
import { createRun, loadRun, markDone, resumeFrom, skipStep, tickRelease, type ExecDeps, type PlanOptions, type Profile, type StepDef } from './release-graph-exec.js';

export const REPLAY_VERSION = '0.3.99';
/** Virtual minutes per replay tick. */
export const REPLAY_TICK_MIN = 1;
/** Real seconds the demo should take at speed 1. */
export const REPLAY_SECONDS = 180;

export interface ReplayScenario {
  readonly name: string;
  readonly profile: Profile;
  /** Step id → exit code (default 0). */
  readonly exits: Readonly<Record<string, number>>;
  /** Virtual minutes after rehearsalAt → synthetic operator event. */
  readonly events: ReadonlyArray<{ readonly atMin: number; readonly kind: 'skip' | 'mark' | 'resume' | 'go'; readonly step?: string; readonly reason?: string }>;
  /** Steps that take this multiple of their expectMin (the slow parallel branch). */
  readonly slow?: Readonly<Record<string, number>>;
}

/** rehearsalAt 03:40 KST · cut 04:00 · publish 06:00 (2026-11-26). */
export const REPLAY_CLOCK = { rehearsalAt: '2026-11-25T18:40:00.000Z', cutAt: '2026-11-25T19:00:00.000Z', publishAt: '2026-11-25T21:00:00.000Z' };

export const SCENARIOS: Readonly<Record<string, ReplayScenario>> = {
  demo: {
    name: 'demo', profile: 'normal', exits: { pregate: 1 },
    events: [{ atMin: 95, kind: 'skip', step: 'docs', reason: 'docs pages deploy moved to the next window' }, { atMin: 105, kind: 'go' }],
  },
  clean: { name: 'clean', profile: 'quick-surgery', exits: {}, events: [{ atMin: 100, kind: 'go' }] },
  'critical-stop': {
    name: 'critical-stop', profile: 'quick-surgery', exits: { prepare: 2 },
    events: [{ atMin: 40, kind: 'resume', step: 'prepare' }, { atMin: 100, kind: 'go' }],
  },
  'slow-lane': { name: 'slow-lane', profile: 'quick-surgery', exits: {}, slow: { prebuild: 6 }, events: [{ atMin: 100, kind: 'go' }] },
};

/** mulberry32 — deterministic jitter per seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface Replay {
  readonly root: string;
  readonly version: string;
  readonly deps: ExecDeps;
  now(): Date;
  /** Advance one tick: finish due fake processes, apply due synthetic events, tick the real graph. */
  step(): Promise<{ done: boolean }>;
  /** Started (virtual) steps with their exits — for the sim tests. */
  readonly started: ReadonlyArray<{ id: string; at: string }>;
}

export function createReplay(scenario: ReplayScenario, seed: number, root?: string): Replay {
  const base = root ?? mkdtempSync(join(tmpdir(), 'release-board-replay-'));
  const stateRoot = join(base, 'state');
  const seatState = join(base, 'seat-state');
  const home = join(base, 'release', REPLAY_VERSION);
  mkdirSync(home, { recursive: true });
  mkdirSync(join(seatState, 'REL'), { recursive: true });
  // The rehearsal ran (test universe): its receipt is the advisory input of `cut`.
  writeFileSync(join(home, 'rehearsal-receipt.json'), `${JSON.stringify({ version: REPLAY_VERSION, kind: 'rehearsal', ok: true })}\n`);
  let nowMs = Date.parse(REPLAY_CLOCK.rehearsalAt) - 60_000;
  const rand = rng(seed);
  const exits: Record<string, number> = { ...scenario.exits };
  const procs = new Map<number, { step: StepDef; endMs: number; log: string; rc: string }>();
  const started: Array<{ id: string; at: string }> = [];
  let pid = 4000;
  const planOptions: PlanOptions & { repo: string; instanceRoot: string } = { seatState, repo: join(base, 'repo'), instanceRoot: base, cli: 'elanous' };
  const readText = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
  const probes: ConditionProbes = {
    now: () => new Date(nowMs),
    watch: async () => null,
    mtimeMs: () => null,
    readJson: (p) => { const t = readText(p); try { return t ? JSON.parse(t) : null; } catch { return null; } },
    readLines: (p) => (readText(p) ?? '').split('\n').filter(Boolean),
    cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0,
    publishedVersions: async () => [], installedVersion: async () => null,
  };
  const deps: ExecDeps = {
    now: () => new Date(nowMs), stateRoot, mode: () => 'live', probes,
    detect: async () => null,
    start: (step, cmd, logPath, rcPath) => {
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, `replay (test universe) — not executed: ${cmd}\n`);
      const mult = scenario.slow?.[step.id] ?? 1;
      const minutes = Math.max(0.5, step.expectMin * mult * (0.85 + 0.3 * rand()));
      pid += 1;
      procs.set(pid, { step, endMs: nowMs + minutes * 60_000, log: logPath, rc: rcPath });
      started.push({ id: step.id, at: new Date(nowMs).toISOString() });
      return pid;
    },
    alive: (p) => procs.has(p),
    post: (to, kind) => `replay-${to}-${kind}`,
    planOptions,
  };
  createRun(stateRoot, { version: REPLAY_VERSION, quick: true, clock: REPLAY_CLOCK, notesFile: join(home, `notes-${REPLAY_VERSION}-final.md`), prepDir: join(home, 'critpath-prepared'), profile: scenario.profile }, new Date(nowMs));
  const fired = new Set<number>();
  const minuteOf = () => (nowMs - Date.parse(REPLAY_CLOCK.rehearsalAt)) / 60_000;
  return {
    root: stateRoot, version: REPLAY_VERSION, deps, started,
    now: () => new Date(nowMs),
    async step() {
      nowMs += REPLAY_TICK_MIN * 60_000;
      for (const [p, proc] of procs) {
        if (proc.endMs > nowMs) { appendFileSync(proc.log, `· ${new Date(nowMs).toISOString()}\n`); continue; }
        if (proc.step.id === 'cut') {
          writeFileSync(join(home, 'cut.sha'), 'replay0000cut\n');
          writeFileSync(join(home, 'cut.json'), `${JSON.stringify({ sha: 'replay0000cut' })}\n`);
        }
        writeFileSync(proc.rc, `${exits[proc.step.id] ?? 0}\n`);
        procs.delete(p);
      }
      scenario.events.forEach((e, i) => {
        if (fired.has(i) || minuteOf() < e.atMin) return;
        fired.add(i);
        const at = new Date(nowMs);
        if (e.kind === 'go') appendFileSync(join(seatState, 'REL', `poll-${REPLAY_VERSION}.jsonl`), `${JSON.stringify({ poll: `${REPLAY_VERSION}:L-3`, voter: 'OP', answer: 'GO', sha: 'replay0000cut', evidence: 'replay: OP GO bound to the cut', at: at.toISOString() })}\n`);
        else if (e.kind === 'skip') skipStep(stateRoot, REPLAY_VERSION, e.step!, 'OP', e.reason ?? 'replay', at, planOptions);
        else if (e.kind === 'mark') markDone(stateRoot, REPLAY_VERSION, e.step!, 'REL', 'replay receipt', at, planOptions);
        else if (e.kind === 'resume') {
          // REL fixed it by hand: the retry exits 0.
          exits[e.step!] = 0;
          resumeFrom(stateRoot, REPLAY_VERSION, e.step!, 'REL', at, planOptions);
        }
      });
      await tickRelease(REPLAY_VERSION, deps);
      return { done: !!loadRun(stateRoot, REPLAY_VERSION)?.done };
    },
  };
}
