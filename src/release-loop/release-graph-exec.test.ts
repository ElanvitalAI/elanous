// Sim world for the release graph executor: a virtual clock walks the 0.3.36 countdown; commands are fake (rc files,
// log lines), mail is captured, detection is injected. Expectations are independent literals (QUICKPASS-GOLDEN ids,
// commands, counts). The golden-ledger scenario suite (48 assertions) runs through seat-state/REL/evidence/quickpass-sim.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConditionProbes } from '../loops/trigger-conditions.js';
import {
  compareTable, configuredMode, createRehearsal, createRun, criticalPath, loadRun, markDone, noGoWith, readLedger, rehearsalKey, rehearsalReceiptPath, releaseSteps, resumeFrom, stepsFor, tickRelease,
  type Detected, type ExecDeps, type Mode, type StepDef,
} from './release-graph-exec.js';

const CLOCK = { rehearsalAt: '2026-11-25T13:00:00.000Z', cutAt: '2026-11-25T19:00:00.000Z', publishAt: '2026-11-25T21:00:00.000Z' };
const V = '0.3.36';
const SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const OPTS = { seatState: '/hq/seat-state', uid: 501, cli: 'elanous', repo: '/r', instanceRoot: '/i' };

let root: string;
let now: Date;
let mail: Array<{ to: string; kind: string; body: string }>;
let started: string[];
let exits: Record<string, number>;
let hang: Set<string>;
let security: Set<string>;
let detected: Record<string, Detected>;
let pollRows: string[];
const procs = new Map<number, { step: string; logPath: string }>();

function probes(): ConditionProbes {
  return {
    now: () => now, watch: async () => null, mtimeMs: () => null,
    readJson: () => ({ sha: SHA, ok: true }),
    readLines: () => pollRows,
    cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0,
    publishedVersions: async () => [V], installedVersion: async () => null,
  };
}

function deps(mode: Mode): ExecDeps {
  let pid = 1000;
  return {
    now: () => now, stateRoot: root, mode: () => mode, probes: probes(),
    detect: async (_v: string, step: StepDef) => detected[step.id] ?? null,
    start: (step, _cmd, logPath, rcPath, secPath) => {
      started.push(step.id);
      const p = ++pid;
      writeFileSync(logPath, `start ${step.id}\n`);
      procs.set(p, { step: step.id, logPath });
      if (!hang.has(step.id)) {
        if (security.has(step.id)) writeFileSync(secPath, 'secret\n');
        writeFileSync(rcPath, `${exits[step.id] ?? 0}\n`);
      }
      return p;
    },
    alive: (p) => hang.has(procs.get(p)?.step ?? ''),
    post: (to, kind, body) => { mail.push({ to, kind, body }); return `msg#${mail.length}`; },
    planOptions: OPTS,
  };
}

const at = (iso: string) => { now = new Date(iso); };
const advance = (min: number) => { now = new Date(now.getTime() + min * 60_000); };
async function tickFor(mode: Mode, minutes: number, stepMin = 1) {
  for (let m = 0; m < minutes; m += stepMin) { await tickRelease(V, deps(mode)); advance(stepMin); }
}
const op = (answer: 'GO' | 'NO-GO') => JSON.stringify({ poll: '0.3.36:L-3', voter: 'OP', answer, sha: SHA, evidence: 'OP #1' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'release-graph-'));
  mail = []; started = []; exits = {}; hang = new Set(); security = new Set(); detected = {}; pollRows = [op('GO')]; procs.clear();
  at('2026-11-25T12:00:00.000Z');
  createRun(root, { version: V, quick: true, clock: CLOCK, notesFile: '/h/notes.md', prepDir: '/h/prep' }, now);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('plan', () => {
  test('quick path = the 21 golden steps; the full path adds the hard rehearsal and telemetry', () => {
    expect(stepsFor(loadRun(root, V)!, OPTS).map(s => s.id)).toEqual(['cli-fresh', 'notes', 'roster', 'schedule', 'cut', 'cut-push', 'pregate', 'prebuild',
      'prepare', 'rehearsal', 'go', 'notes-public', 'publish', 'npm', 'verify', 'docs', 'rail', 'els-restart', 'update-all', 'dev-bump', 'traffic-restore']);
    const full = releaseSteps(V, CLOCK, { notesFile: '/h/notes.md', prepDir: '/h/prep' }, OPTS);
    expect(full.filter(s => !s.quick).map(s => s.id)).toEqual(['rehearsal-hard', 'telemetry']);
  });

  test('stops only on build/publish steps; update-all waits for the els restart', () => {
    const steps = stepsFor(loadRun(root, V)!, OPTS);
    expect(steps.filter(s => s.hard).map(s => s.id)).toEqual(['cut', 'prepare', 'publish', 'npm']);
    expect(steps.find(s => s.id === 'update-all')!.needs).toEqual(['els-restart']);
    expect(steps.find(s => s.id === 'publish')!.needs).toEqual(['prepare', 'go', 'notes-public']);
    expect(steps.filter(s => s.always).map(s => s.id)).toEqual(['traffic-restore']);
  });

  test('commands are the golden ledger lines', () => {
    const byId = new Map(stepsFor(loadRun(root, V)!, OPTS).map(s => [s.id, s.cmd]));
    expect(byId.get('prepare')).toBe('cd /r/.claude/wt/release-0.3.36 && bun bin/elanous.mjs --config-dir /i release critpath --version 0.3.36 --cut-commit $(cat /h/cut.sha) --notes-file /h/notes.md --dry-run');
    expect(byId.get('publish')).toBe('cd /r/.claude/wt/release-0.3.36 && bun bin/elanous.mjs --config-dir /i release publish --dir /h/prep --notes-file /h/notes.public.md --yes');
    expect(byId.get('npm')).toBe('npm view elanous@0.3.36 version | grep -qx 0.3.36 || npm publish /h/prep/dist/elanous.tgz --ignore-scripts --access public --loglevel warn');
    expect(byId.get('cut-push')).toBe('cd /r/.claude/wt/release-0.3.36 && git push -q origin HEAD:refs/heads/release/0.3.36');
    expect(byId.get('els-restart')).toBe('launchctl kickstart -k gui/501/dev.elanous.els');
    expect(byId.get('rail')).toBe("RAIL_HOSTS='local mbp node-b minim5' zsh /hq/seat-state/OP/tools/rail-now.sh");
    expect(byId.get('traffic-restore')).toBe('zsh /hq/seat-state/OP/tools/traffic-knob.sh restore');
    expect(byId.get('go')).toBe(null);
  });

  test('critical path with the measured warm durations', () => {
    const cp = criticalPath(stepsFor(loadRun(root, V)!, OPTS));
    expect(cp.path).toEqual(['cut', 'prepare', 'publish', 'rail', 'els-restart', 'update-all']);
    expect(cp.minutes).toBe(23.5);
    expect(cp.serialMinutes).toBe(90);
  });

  test('mode is live only for the configured version', () => {
    expect(configuredMode('0.3.37', { release: { graph: { mode: 'live', version: '0.3.37' } } })).toBe('live');
    expect(configuredMode('0.3.36', { release: { graph: { mode: 'live', version: '0.3.37' } } })).toBe('shadow');
    expect(configuredMode('0.3.37', { release: { graph: { mode: 'live' } } })).toBe('shadow');
    expect(configuredMode('0.3.37', null)).toBe('shadow');
  });
});

describe('shadow', () => {
  test('walks every step once on clocks, executes nothing, posts nothing', async () => {
    await tickFor('shadow', 12 * 60, 2);
    const rows = readLedger(root, V);
    const would = rows.filter(r => r.kind === 'would-run').map(r => r.step);
    expect(would.length).toBe(20); // 21 − the go gate
    expect(new Set(would).size).toBe(20);
    expect(started).toEqual([]);
    expect(mail).toEqual([]);
    const wr = (id: string) => Date.parse(String(rows.find(r => r.kind === 'would-run' && r.step === id)!.at));
    expect(wr('cli-fresh')).toBe(Date.parse('2026-11-25T19:02:00.000Z')); // after cut: checked in the cut worktree (repo.git is bare)
    expect(wr('cut')).toBe(Date.parse('2026-11-25T19:00:00.000Z'));
    expect(wr('publish')).toBe(Date.parse('2026-11-25T21:00:00.000Z'));
    expect(wr('update-all')).toBeGreaterThan(wr('els-restart'));
    expect(loadRun(root, V)!.done).toBe(true);
  });

  test('REL actual is auto-detected and shown next to the graph time', async () => {
    at('2026-11-25T19:00:00.000Z');
    await tickRelease(V, deps('shadow'));
    detected.cut = { at: '2026-11-25T19:04:00.000Z', evidence: 'release/0.3.36=abc' };
    advance(4);
    await tickRelease(V, deps('shadow'));
    const row = compareTable(loadRun(root, V)!).find(r => r.step === 'cut')!;
    expect(row.relActual).toBe('2026-11-25T19:04:00.000Z');
    expect(row.graphAt).toBe('2026-11-25T19:00:00.000Z');
    expect(row.deltaMin).toBe(4);
    expect(row.by).toBe('REL(detected)');
  });
});

describe('live', () => {
  test('golden path: every step once, publish once, no cards, no wakes', async () => {
    await tickFor('live', 10 * 60);
    expect(started.length).toBe(20);
    expect(started.filter(s => s === 'publish')).toEqual(['publish']);
    const s = loadRun(root, V)!;
    expect(s.done).toBe(true);
    expect(s.hardStop).toBe(null);
    expect(mail).toEqual([]);
  });

  test('advisory: rehearsal exits 1 → warning + card, publish still runs', async () => {
    exits.rehearsal = 1;
    await tickFor('live', 10 * 60);
    const s = loadRun(root, V)!;
    expect(s.hardStop).toBe(null);
    expect(s.steps.rehearsal!.by).toBe('graph(soft-fail)');
    expect(started).toContain('publish');
    expect(mail.filter(m => m.to === 'OP' && m.body.startsWith('[release graph warning · 0.3.36] rehearsal exited 1')).length).toBe(1);
  });

  test('missing OP poll row (unverified approval) → card on go, publish still runs', async () => {
    pollRows = [];
    await tickFor('live', 10 * 60);
    expect(loadRun(root, V)!.steps.go!.warnings!.length).toBe(1);
    expect(started).toContain('publish');
  });

  test('hard stop: prepare exits 1 → REL wake + OP card, publish never runs, traffic-restore still runs; resume continues', async () => {
    exits.prepare = 1;
    await tickFor('live', 10 * 60);
    const s = loadRun(root, V)!;
    expect(s.hardStop!.step).toBe('prepare');
    expect(s.hardStop!.reason).toBe('prepare exited 1');
    expect(started).not.toContain('publish');
    expect(started).toContain('traffic-restore');
    expect(mail.filter(m => m.to === 'REL').length).toBe(1);
    expect(mail.filter(m => m.to === 'OP' && m.body.startsWith('[release graph NO-GO')).length).toBe(1);
    delete exits.prepare;
    resumeFrom(root, V, 'prepare', 'REL', now);
    await tickFor('live', 4 * 60);
    expect(loadRun(root, V)!.done).toBe(true);
    expect(started.filter(x => x === 'prepare').length).toBe(2);
    expect(started.filter(x => x === 'cut').length).toBe(1);
    expect(started.filter(x => x === 'publish').length).toBe(1);
  });

  test('security-4 marker written by a step stops the run at that step', async () => {
    security.add('roster');
    await tickFor('live', 10 * 60);
    const s = loadRun(root, V)!;
    expect(s.hardStop!.step).toBe('roster');
    expect(s.hardStop!.reason).toBe('security-4 finding surfaced by roster');
    expect(started).not.toContain('publish');
  });

  test('nogo --security stops; resume clears it', async () => {
    noGoWith(root, V, 'JUD', 'token in bundle', now, 'secret');
    await tickFor('live', 10 * 60);
    expect(started).toEqual(['traffic-restore']);
    expect(loadRun(root, V)!.hardStop!.reason).toBe('security-4 secret: token in bundle');
    resumeFrom(root, V, 'cli-fresh', 'OP', now);
    expect(loadRun(root, V)!.hardStop).toBe(null);
  });

  test('explicit NO-GO in the poll ledger stops at go', async () => {
    pollRows = [op('NO-GO')];
    await tickFor('live', 10 * 60);
    const s = loadRun(root, V)!;
    expect(s.hardStop!.step).toBe('go');
    expect(started).not.toContain('publish');
  });

  test('stall: an active step with no output for 15 min wakes REL once, stamped start + 15', async () => {
    hang.add('update-all');
    await tickFor('live', 10 * 60);
    const s = loadRun(root, V)!;
    const stall = readLedger(root, V).filter(r => r.kind === 'wake');
    expect(stall.length).toBe(1);
    expect(stall[0]!.step).toBe('update-all');
    expect(Date.parse(String(stall[0]!.stallAt)) - Date.parse(s.steps['update-all']!.startedAt!)).toBe(15 * 60_000);
    expect(mail.filter(m => m.to === 'REL' && m.body.startsWith('[release graph STALL · 0.3.36] update-all:running')).length).toBe(1);
  });

  test('a long step that keeps printing output is not a stall', async () => {
    hang.add('docs');
    for (let m = 0; m < 10 * 60; m += 1) {
      for (const p of procs.values()) if (p.step === 'docs') appendFileSync(p.logPath, `${m}\n`);
      await tickRelease(V, deps('live')); advance(1);
    }
    expect(readLedger(root, V).filter(r => r.kind === 'wake')).toEqual([]);
  });

  test('manual parity: a publish REL already did is detected and never re-run', async () => {
    detected.publish = { at: '2026-11-25T21:01:00.000Z', evidence: 'GH v0.3.36 published' };
    await tickFor('live', 10 * 60);
    expect(started).not.toContain('publish');
    expect(started).toContain('npm');
    expect(loadRun(root, V)!.steps.publish!.by).toBe('REL(detected)');
  });

  test('mark by phase: REL marks L-4 by hand, the graph continues downstream', async () => {
    at('2026-11-25T19:00:00.000Z');
    markDone(root, V, 'L-4', 'REL', 'receipt QP-01', now);
    await tickFor('live', 3 * 60);
    expect(started).not.toContain('prepare');
    expect(started).not.toContain('rehearsal');
    expect(started).toContain('publish');
    expect(readLedger(root, V).filter(r => r.kind === 'marked').map(r => r.step)).toEqual(['prepare', 'rehearsal', 'notes-public']);
  });

  test('resume from rail: only rail and its descendants run', async () => {
    resumeFrom(root, V, 'rail', 'REL', now);
    await tickFor('live', 10 * 60);
    expect([...started].sort()).toEqual(['els-restart', 'rail', 'update-all']);
  });

  test('mark refuses without --ref', () => {
    expect(() => markDone(root, V, 'cut', 'REL', '', now)).toThrow('--by and --ref are required');
  });

  test('a finished shadow run still records REL actual on later ticks', async () => {
    await tickFor('shadow', 12 * 60, 2);
    expect(loadRun(root, V)!.done).toBe(true);
    detected.rail = { at: '2026-11-26T00:30:00.000Z', evidence: 'REL mail #9: rail done' };
    await tickRelease(V, deps('shadow'));
    const row = compareTable(loadRun(root, V)!).find(r => r.step === 'rail')!;
    expect(row.relActual).toBe('2026-11-26T00:30:00.000Z');
  });

  test('a concurrent tick (lock held) does nothing', async () => {
    at('2026-11-25T19:00:00.000Z');
    writeFileSync(join(root, 'release-graph', V, 'tick.lock'), `1 ${Date.now()}\n`);
    const r = await tickRelease(V, deps('live'));
    expect(r.events).toEqual([]);
    expect(started).toEqual([]);
  });
});

test('ledger is jsonl with one created row', () => {
  const first = readFileSync(join(root, 'release-graph', V, 'ledger.jsonl'), 'utf8').split('\n')[0]!;
  expect(JSON.parse(first).kind).toBe('created');
});

describe('rehearsal = the dry-run subset of the same DAG', () => {
  const RK = '0.3.36-rehearsal';
  const tickR = async (minutes: number) => { for (let m = 0; m < minutes; m += 1) { await tickRelease(RK, deps('live')); advance(1); } };

  test('11 steps, none hard, nothing after the dry-runs; rehearsal ref and its own instance root', () => {
    const r = createRehearsal(root, { version: V, clock: CLOCK }, now);
    expect(rehearsalKey(V)).toBe(RK);
    const steps = stepsFor(r, OPTS);
    expect(steps.map(s => s.id)).toEqual(['cli-fresh', 'notes', 'roster', 'schedule', 'cut', 'cut-push', 'pregate', 'prebuild', 'prepare', 'rehearsal', 'notes-public']);
    expect(steps.filter(s => s.hard)).toEqual([]);
    const byId = new Map(steps.map(s => [s.id, s.cmd!]));
    expect(byId.get('cut-push')).toContain('git push -q origin HEAD:refs/heads/rehearsal/0.3.36-$(cut -c1-12 ');
    expect(byId.get('cut')!.startsWith('(git -C /r worktree remove --force /r/.claude/wt/release-0.3.36-rehearsal 2>/dev/null; true) && cd /r && git fetch -q origin main && git worktree add --detach /r/.claude/wt/release-0.3.36-rehearsal origin/main')).toBe(true);
    expect(byId.get('prepare')).toContain('--dry-run');
    expect(byId.get('prepare')).toContain('/rehearsal/instance release critpath --version 0.3.36');
    for (const cmd of byId.values()) expect(cmd).not.toContain('release publish');
  });

  test('live: fires at rehearsalAt, runs once, writes an ok receipt', async () => {
    createRehearsal(root, { version: V, clock: CLOCK }, now);
    await tickR(60);
    expect(started).toEqual([]); // 12:00–13:00: before rehearsalAt
    await tickR(60);
    expect(started.length).toBe(11);
    const r = loadRun(root, RK)!;
    expect(r.done).toBe(true);
    const receipt = JSON.parse(readFileSync(rehearsalReceiptPath(V), 'utf8')) as { ok: boolean; kind: string; steps: unknown[] };
    expect(receipt.kind).toBe('rehearsal');
    expect(receipt.ok).toBe(true);
    expect(receipt.steps.length).toBe(11);
  });

  test('a failing prepare in the rehearsal never stops it; the receipt says ok=false', async () => {
    exits.prepare = 1;
    createRehearsal(root, { version: V, clock: CLOCK }, now);
    at('2026-11-25T13:00:00.000Z');
    await tickR(60);
    const r = loadRun(root, RK)!;
    expect(r.hardStop).toBe(null);
    expect(r.done).toBe(true);
    expect(started).toContain('notes-public');
    expect((JSON.parse(readFileSync(rehearsalReceiptPath(V), 'utf8')) as { ok: boolean }).ok).toBe(false);
  });
});

test('release: a missing/failed rehearsal receipt is an advisory card on cut, never a stop', async () => {
  const live = deps('live');
  live.probes = { ...live.probes, readJson: () => ({ sha: SHA, ok: false }) };
  for (let m = 0; m < 10 * 60; m += 1) { await tickRelease(V, live); advance(1); }
  const s = loadRun(root, V)!;
  expect(s.hardStop).toBe(null);
  expect(s.steps.cut!.warnings!.length).toBe(1);
  expect(s.steps.cut!.warnings![0]).toContain('rehearsal-receipt');
  expect(started).toContain('publish');
});
