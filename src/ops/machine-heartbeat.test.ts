import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORPHAN_STALL_MS, runMachineHeartbeat as runTick } from './machine-heartbeat.js';
import { CardStore } from '../task-cards/card-store.js';
import { bunVersion, cliFingerprint, gcTools, oneShotCommand, orphanCandidates, processSnapshot, scheduledPeriodMinutes, type CliProcess } from '../hq/fence.js';
import { readRunExits } from '../harness/harness-incidents.js';
import { buildUserConfig } from '../user-config.js';

const now = new Date('2026-10-09T10:00:00Z');
const command = 'bun bin/elanous.mjs hq fence --role cron';
const schedules = [{ command, cron: '*/10 * * * *' }];
const rootProcess = (ageSeconds = 1801): CliProcess => ({ pid: 101, ppid: 1, ageSeconds, cpuSeconds: 2, command });
const child: CliProcess = { pid: 102, ppid: 101, ageSeconds: 1800, cpuSeconds: 1, command: 'bun scripts/cron-run.ts' };
/** The i-th distinct hung tree (its own PIDs) — a cause card needs three different hangs, not one PID seen thrice. */
const hang = (i: number, proc: CliProcess = rootProcess()): CliProcess[] => [{ ...proc, pid: proc.pid + i * 10 }, { ...child, pid: child.pid + i * 10, ppid: proc.pid + i * 10 }];

/** A real stall needs two guardian ticks: one that first sees the tree, one ≥ ORPHAN_STALL_MS later at the same CPU. */
async function runMachineHeartbeat(...[jobs, deps]: Parameters<typeof runTick>): ReturnType<typeof runTick> {
  const at = deps?.now ?? new Date();
  const first = await runTick(jobs, { mode: 'on', ...deps, now: new Date(at.getTime() - ORPHAN_STALL_MS) });
  expect(first.terminated).toBe(0);
  return runTick(jobs, { mode: 'on', ...deps });
}

describe('local guardian orphan CLI collector', () => {
  test('parses a real local ps snapshot without signalling any process', () => {
    const rows = processSnapshot();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(row => row.pid === process.pid)).toBe(true);
    expect(rows.every(row => Number.isFinite(row.cpuSeconds))).toBe(true);
  });

  test('real stack diagnostic yields a non-empty sample of a live same-user process', () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    const target = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const sample = gcTools().run('sample', [String(target.pid), '1']);
      expect(sample.trim().length).toBeGreaterThan(0);
      expect(sample).toMatch(process.platform === 'linux' ? /tid=\d+ state=/ : /sleep|Call graph|Sampling/i);
    } finally { target.kill(); }
  }, 30_000);

  test('detects real cron-wrapped invocations without matching the wrong job or guessing a timezone', () => {
    const wrapped = `cd /repo && /usr/local/bin/bun bin/elanous.mjs hq fence --role cron -- bun bin/elanous.mjs away tick >> /tmp/job.log 2>&1`;
    const actual = '/usr/local/bin/bun bin/elanous.mjs hq fence --role cron -- bun bin/elanous.mjs away tick';
    const wrappedJobs = [{ command: wrapped, cron: '*/10 * * * *' }];
    expect(scheduledPeriodMinutes(actual, wrappedJobs, now, 'Asia/Seoul')).toBe(10);
    expect(scheduledPeriodMinutes(actual, [{ command: "hq-fence cron 'bun bin/elanous.mjs away tick'", cron: '*/10 * * * *' }], now, 'Asia/Seoul')).toBe(10);
    expect(scheduledPeriodMinutes(actual, [{ command: wrapped.replace('away tick', 'away x tick'), cron: '*/10 * * * *' }], now, 'Asia/Seoul')).toBeNull();
    expect(cliFingerprint('/usr/local/bin/bun bin/elanous.mjs away tick')).toBe('elanous away tick');
    expect(bunVersion(process.pid, (bin, args) => bin === 'ps' ? `${process.execPath}\n` : `${bin}:${args.join(' ')}`)).toContain('--version');
    expect(bunVersion(process.pid, gcTools().run)).toMatch(/^\d+\.\d+\.\d+/);
    expect(scheduledPeriodMinutes(command, [{ command, cron: '0 0 * * *' }], now, 'Asia/Seoul')).toBe(1440);
    expect(scheduledPeriodMinutes(command, [{ command, cron: '0 9,18 * * *' }], now, 'Asia/Seoul')).toBeNull();
  });

  test('requires an eligible one-shot, >3 periods, and zero child progress', () => {
    expect(oneShotCommand('bun bin/elanous.mjs nexus run')).toBe(false);
    expect(oneShotCommand('bun scripts/mission.ts --once')).toBe(false);
    expect(oneShotCommand('bun bin/elanous.mjs --test guardian tick')).toBe(false);
    expect(oneShotCommand('sh -c "bun bin/elanous.mjs hq fence --role cron"')).toBe(false);
    expect(oneShotCommand(command)).toBe(true);
    expect(oneShotCommand('bun bin/elanous.mjs hq fence --role cron -- bun bin/elanous.mjs away tick')).toBe(true);
    expect(oneShotCommand('bun bin/elanous.mjs seat loop --once')).toBe(true);
    expect(oneShotCommand('bun bin/elanous.mjs hq fence --role cron -- sh -c "long running daemon"')).toBe(false);
    expect(oneShotCommand('bun bin/elanous.mjs hq fence --role cron -- sh -c "bun bin/elanous.mjs seat loop --once"')).toBe(true);
    expect(oneShotCommand('bun bin/elanous.mjs hq fence --role cron -- sh -c "bun bin/elanous.mjs nexus run --once"')).toBe(false);
    expect(oneShotCommand('bun bin/elanous.mjs hq fence --role cron -- sh -c "echo --once; daemon start"')).toBe(false);
    expect(oneShotCommand('bun bin/elanous.mjs away tick')).toBe(true);
    expect(oneShotCommand('bun bin/elanous.mjs hq seat --refresh')).toBe(true);
    expect(oneShotCommand('bun bin/elanous.mjs loop status --notify')).toBe(true);
    expect(oneShotCommand('bun bin/elanous.mjs nexus run --once')).toBe(false);
    expect(oneShotCommand('bun bin/elanous.mjs hq fence --role cron -- bun bin/elanous.mjs --test away tick')).toBe(false);
    expect(oneShotCommand('bun bin/elanous.mjs hq fence --role cron -- bun bin/elanous.mjs away tick --help')).toBe(false);
    expect(oneShotCommand('bun bin/elanous.mjs hq fence --role cron -- sh -c "bun bin/elanous.mjs --test seat loop --once"')).toBe(false);
    expect(oneShotCommand('bun bin/elanous.mjs hq fence --role cron -- bun bin/elanous.mjs nexus run --once')).toBe(false);
    expect(oneShotCommand('bun bin/elanous.mjs hq fence --role cron -- sh -c "bun bin/elanous.mjs away tick && bun bin/elanous.mjs nexus start"')).toBe(false);
    expect(oneShotCommand('bun bin/elanous.mjs hq fence --role cron -- bun bin/elanous.mjs away tick && sleep 99999')).toBe(false);
    expect(orphanCandidates([rootProcess(1800), child], [rootProcess(1800), child], schedules, now)).toHaveLength(0);
    expect(orphanCandidates([rootProcess(), child], [{ ...rootProcess(), cpuSeconds: 3 }, child], schedules, now)).toHaveLength(0);
    expect(orphanCandidates([rootProcess(), child], [rootProcess(), { ...child, cpuSeconds: 2 }], schedules, now)).toHaveLength(0);
    expect(orphanCandidates([rootProcess()], [rootProcess(), child], schedules, now)).toHaveLength(0);
    expect(orphanCandidates([rootProcess(), child], [rootProcess(), child], [], now)).toHaveLength(0);
    expect(orphanCandidates([rootProcess(), child], [rootProcess(), child], [{ command, cron: 'invalid cron' }], now)).toHaveLength(0);
    expect(orphanCandidates([rootProcess(), child], [rootProcess(), child], schedules, now)).toHaveLength(1);
    expect(orphanCandidates([rootProcess(), child], [rootProcess(), child], [schedules[0]!, schedules[0]!], now)).toHaveLength(0);
    expect(orphanCandidates([rootProcess(), child], [rootProcess(), child], [{ command: 'bun bin/elanous.mjs hq fence --role cron OTHER', cron: '*/10 * * * *' }], now)).toHaveLength(0);
  });

  test('persists diagnostic evidence and incident before tree signals; repeats publish one TC cause card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-gc-'));
    const events: string[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const result = await runMachineHeartbeat(schedules, {
          root, now: new Date(now.getTime() + i * 60_000), snapshot: () => hang(i), sleep: async () => {},
          run: (bin, args) => { events.push(`${bin}:${args.join(' ')}`); return `${bin} output`; },
          kill: pid => {
            // Evidence is committed before any signal; the run-exit row comes after, with the signal outcome.
            expect(readRunExits(root)).toHaveLength(i);
            expect(readdirSync(join(root, 'incidents')).some(file => file.endsWith('.json'))).toBe(true);
            events.push(`kill:${pid}`);
          },
          version: (_pid, run) => run(process.execPath, ['--version']),
          log: (_category, event) => { events.push(event); },
        });
        expect(result).toEqual({ collected: 1, terminated: 1, cards: i === 2 ? 1 : 0 });
      }
      expect(readRunExits(root).map((row) => row.signal)).toEqual(['SIGTERM', 'SIGTERM', 'SIGTERM']);
      expect(events.indexOf('evidence-before-termination')).toBeLessThan(events.indexOf('kill:102'));
      expect(events.indexOf('sample:101 1')).toBeLessThan(events.indexOf('kill:102'));
      expect(events.indexOf('lsof:-p 101,102')).toBeLessThan(events.indexOf('kill:102'));
      expect(events.indexOf('kill:102')).toBeLessThan(events.indexOf('kill:101'));
      expect(events.findIndex(event => event.includes('--version'))).toBeLessThan(events.indexOf('kill:102'));
      const evidence = JSON.parse(readFileSync(join(root, 'incidents', readdirSync(join(root, 'incidents')).find(file => file.endsWith('.json') && file.includes('-101-'))!), 'utf8'));
      expect(evidence).toMatchObject({ command, pid: 101, ageSeconds: 1801, periodMinutes: 10, tree: [101, 102], lsof: 'lsof output', sample: 'sample output' });
      expect(evidence.bunVersion).toContain('output');
      const requests = readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0].seat).toBe('TC');
      expect(requests[0].text).toContain('가설(미확정): bun fs.watch');
      expect(requests[0].text).toContain('incidents/orphan-cli-');
      const cards = new CardStore(root);
      try {
        const entries = cards.listCards();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.title).toContain('TC 원인 조사');
        expect(entries[0]!.sections[0]!.owner).toBe('TC');
        expect(entries[0]!.sections).toHaveLength(3);
        expect(entries[0]!.sections[0]!.content).toContain('incidents/orphan-cli-');
      } finally { cards.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('one guardian tick clears a simulated two-hour one-shot tree without touching unrelated CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-two-hour-'));
    const killed: number[] = [];
    const unrelated: CliProcess = { pid: 103, ppid: 1, command: 'bun bin/elanous.mjs nexus run', ageSeconds: 7201, cpuSeconds: 0 };
    try {
      const snapshot = () => [rootProcess(7201), { ...child, ageSeconds: 7200 }, unrelated].filter(row => !killed.includes(row.pid));
      const result = await runMachineHeartbeat(schedules, { root, now, snapshot, sleep: async () => {},
        run: bin => `${bin} output`, version: () => '1.4.2', kill: pid => { killed.push(pid); }, log: () => {} });
      expect(result.terminated).toBe(1);
      expect(killed).toEqual([102, 101]);
      expect(snapshot().filter(row => row.ageSeconds > 7200 && oneShotCommand(row.command))).toHaveLength(0);
      expect(snapshot()).toContainEqual(unrelated);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('repeated cause checks update an existing card with the latest incident evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-fourth-'));
    try {
      for (let i = 0; i < 4; i++) await runMachineHeartbeat(schedules, { root, now: new Date(now.getTime() + i * 60_000),
        snapshot: () => hang(i), sleep: async () => {}, run: bin => `${bin} output`, version: () => '1.4.2', kill: () => {}, log: () => {} });
      const cards = new CardStore(root);
      try {
        expect(cards.listCards()).toHaveLength(1);
        expect(cards.listCards()[0]!.sections).toHaveLength(4);
      } finally { cards.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('same command reaches the three-hang threshold across Bun paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-bun-paths-'));
    try {
      for (let i = 0; i < 3; i++) {
        const cmd = i === 0 ? command : `/opt/bun/bin/bun bin/elanous.mjs hq fence --role cron`;
        const proc = { ...rootProcess(), command: cmd };
        const result = await runMachineHeartbeat(schedules, { root, now: new Date(now.getTime() + i * 60_000),
          snapshot: () => hang(i, proc), sleep: async () => {}, run: bin => `${bin} output`,
          version: () => '1.4.2', kill: () => {}, log: () => {} });
        expect(result.terminated).toBe(1);
        expect(result.cards).toBe(i === 2 ? 1 : 0);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('a new day starts a new three-hang threshold without reusing yesterday’s card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-day-boundary-'));
    try {
      const times = ['2026-10-09T14:57:00Z', '2026-10-09T14:58:00Z', '2026-10-09T14:59:00Z', '2026-10-09T15:00:00Z'];
      for (let i = 0; i < times.length; i++) {
        const result = await runMachineHeartbeat(schedules, { root, now: new Date(times[i]!),
          snapshot: () => hang(i), sleep: async () => {}, run: bin => `${bin} output`,
          version: () => '1.4.2', kill: () => {}, log: () => {} });
        expect(result.cards).toBe(i === 2 ? 1 : 0);
      }
      const cards = new CardStore(root);
      try { expect(cards.listCards()).toHaveLength(1); } finally { cards.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('one PID recorded on three ticks is one hang — no cause card until three different processes hung', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-same-pid-'));
    try {
      const run = (i: number, rows: CliProcess[]) => runMachineHeartbeat(schedules, { root, now: new Date(now.getTime() + i * 60_000),
        snapshot: () => rows, sleep: async () => {}, run: bin => `${bin} output`, version: () => '1.4.2', kill: () => {}, log: () => {} });
      // SIGTERM did not take: the very same tree is seen again on the next ticks.
      for (let i = 0; i < 3; i++) expect((await run(i, hang(0))).cards).toBe(0);
      expect((await run(3, hang(1))).cards).toBe(0);
      expect((await run(4, hang(2))).cards).toBe(1);
      const cards = new CardStore(root);
      try { expect(cards.listCards()).toHaveLength(1); } finally { cards.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('a single tick never terminates; the same tree must stay at the same CPU across the stall window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-stall-'));
    const killed: number[] = [];
    try {
      const tick = (at: number, rows: CliProcess[]) => runTick(schedules, { mode: 'on', root, now: new Date(at), snapshot: () => rows,
        sleep: async () => {}, run: bin => `${bin} output`, version: () => '1.4.2', kill: pid => { killed.push(pid); }, log: () => {} });
      const t0 = now.getTime();
      expect((await tick(t0, hang(0))).terminated).toBe(0);
      expect((await tick(t0 + ORPHAN_STALL_MS - 60_000, hang(0))).terminated).toBe(0);
      // CPU moved (whole-second Linux resolution catches it across ticks): the watch restarts.
      const moved = hang(0).map(row => row.pid === 102 ? { ...row, cpuSeconds: 2 } : row);
      expect((await tick(t0 + ORPHAN_STALL_MS, moved)).terminated).toBe(0);
      expect((await tick(t0 + 2 * ORPHAN_STALL_MS - 60_000, moved)).terminated).toBe(0);
      expect(killed).toEqual([]);
      expect((await tick(t0 + 2 * ORPHAN_STALL_MS, moved)).terminated).toBe(1);
      expect(killed).toEqual([102, 101]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('a signal that fails is logged beside the ledger row and not counted as terminated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-signal-fail-'));
    const events: string[] = [];
    try {
      const result = await runMachineHeartbeat(schedules, { root, now, snapshot: () => hang(0), sleep: async () => {},
        run: bin => `${bin} output`, version: () => '1.4.2', kill: () => { throw new Error('EPERM'); }, log: (_c, event) => { events.push(event); } });
      expect(result.terminated).toBe(0);
      expect(events).toContain('termination-failed');
      // The ledger does not claim a SIGTERM that never landed.
      const [row] = readRunExits(root);
      expect(row?.signal ?? null).toBeNull();
      expect(row?.lastLines?.some((line) => line.startsWith('termination-failed pid='))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('a partly failed tree signal is not terminated; three evidenced hangs still raise the cause card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-partial-'));
    const events: string[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const [parent] = hang(i);
        // Only the child's SIGTERM fails (EPERM); the parent's lands.
        const result = await runMachineHeartbeat(schedules, { root, now: new Date(now.getTime() + i * 60_000), snapshot: () => hang(i),
          sleep: async () => {}, run: bin => `${bin} output`, version: () => '1.4.2', log: (_c, event) => { events.push(event); },
          kill: pid => { if (pid !== parent!.pid) throw new Error('EPERM'); } });
        expect(result).toEqual({ collected: 1, terminated: 0, cards: i === 2 ? 1 : 0 });
        expect(readRunExits(root).at(-1)?.signal ?? null).toBeNull();
      }
      expect(events.filter(event => event === 'termination-failed')).toHaveLength(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('a period is the one gap shared by every fire in 7 days: hourly yes, weekday hours and weekly no', () => {
    expect(scheduledPeriodMinutes(command, [{ command, cron: '0 * * * *' }], now, 'Asia/Seoul')).toBe(60);
    expect(scheduledPeriodMinutes(command, [{ command, cron: '0 9-17 * * 1-5' }], now, 'Asia/Seoul')).toBeNull();
    expect(scheduledPeriodMinutes(command, [{ command, cron: '0 3 * * 1' }], now, 'Asia/Seoul')).toBeNull();
  });

  test('a tree holding the collector itself or one of its ancestors is never a candidate', () => {
    const [root, kid] = hang(5);
    // The collector runs inside the hung-looking tree (as the root's child) …
    const withSelf: CliProcess[] = [root!, { ...kid!, pid: process.pid }];
    expect(orphanCandidates(withSelf, withSelf, schedules, now)).toHaveLength(0);
    // … or below it, so the tree holds one of its ancestors.
    const ancestor: CliProcess[] = [root!, kid!, { pid: process.pid, ppid: kid!.pid, ageSeconds: 10, cpuSeconds: 0, command: 'bun bin/elanous.mjs guardian tick' }];
    expect(orphanCandidates(ancestor, ancestor, schedules, now)).toHaveLength(0);
    expect(orphanCandidates(hang(5), hang(5), schedules, now)).toHaveLength(1);
  });

  test('a reused PID (age restarted between snapshots) is not the old process', () => {
    expect(orphanCandidates([rootProcess(), child], [{ ...rootProcess(), ageSeconds: 3 }, child], schedules, now)).toHaveLength(0);
  });

  test('new child progress during diagnostics prevents termination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-progress-'));
    let reads = 0;
    const killed: number[] = [];
    try {
      const result = await runMachineHeartbeat(schedules, { root, now,
        snapshot: () => (++reads < 5 ? [rootProcess(), child] : [rootProcess(), { ...child, cpuSeconds: 4 }]),
        sleep: async () => {}, run: bin => `${bin} output`, version: () => '1.4.2',
        kill: pid => { killed.push(pid); }, log: () => {} });
      expect(result).toEqual({ collected: 0, terminated: 0, cards: 0 });
      expect(killed).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('collector keeps evidence log before termination even when later card publication fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-publish-fail-'));
    const killed: number[] = [];
    try {
      for (let i = 0; i < 3; i++) await runMachineHeartbeat(schedules, { root, now: new Date(now.getTime() + i * 60_000),
        snapshot: () => hang(i), sleep: async () => {}, run: bin => `${bin} output`, version: () => '1.4.2',
        kill: pid => { killed.push(pid); }, log: () => {}, card: () => { if (i === 2) throw new Error('card unavailable'); } });
      expect(killed).toHaveLength(6);
      expect(readRunExits(root)).toHaveLength(3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('a dead target PID during version collection fails closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-dead-pid-'));
    const killed: number[] = [];
    try {
      const result = await runMachineHeartbeat(schedules, { root, now,
        snapshot: () => [rootProcess(), child], sleep: async () => {}, run: bin => `${bin} output`,
        version: bunVersion, kill: pid => { killed.push(pid); }, log: () => {} });
      expect(result.terminated).toBe(0);
      expect(killed).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('diagnostic evidence write failure blocks signals and records an observation error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-write-fail-'));
    const killed: number[] = [];
    const errors: string[] = [];
    try {
      // A regular file at the incidents directory prevents the evidence file being committed.
      writeFileSync(join(root, 'incidents'), 'not a directory');
      const result = await runMachineHeartbeat(schedules, { root, now,
        snapshot: () => [rootProcess(), child], sleep: async () => {}, run: bin => `${bin} output`,
        version: () => '1.4.2', kill: pid => { killed.push(pid); }, log: (_category, event) => { errors.push(event); } });
      expect(result.terminated).toBe(0);
      expect(killed).toHaveLength(0);
      expect(errors).toContain('observation-failed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('shadow mode records candidates and evidence but sends no signal and records no run exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-shadow-'));
    const killed: number[] = [];
    const events: string[] = [];
    let cardCalls = 0;
    try {
      for (let i = 0; i < 3; i++) {
        const result = await runMachineHeartbeat(schedules, { mode: 'shadow', root, now: new Date(now.getTime() + i * 60_000),
          snapshot: () => hang(i), sleep: async () => {}, run: bin => `${bin} output`, version: () => '1.4.2',
          kill: pid => { killed.push(pid); }, card: () => { cardCalls++; }, log: (_c, event) => { events.push(event); } });
        expect(result).toEqual({ collected: 1, terminated: 0, cards: 0 });
      }
      expect(killed).toEqual([]);
      expect(cardCalls).toBe(0);
      expect(readRunExits(root)).toHaveLength(0);
      expect(readdirSync(join(root, 'incidents')).filter(file => file.endsWith('.json'))).toHaveLength(3);
      expect(events).toContain('shadow-evidence');
      expect(events).not.toContain('evidence-before-termination');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('shadow is the default when no mode is given', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-default-'));
    const killed: number[] = [];
    try {
      const result = await runMachineHeartbeat(schedules, { mode: undefined, root, now, snapshot: () => hang(0), sleep: async () => {},
        run: bin => `${bin} output`, version: () => '1.4.2', kill: pid => { killed.push(pid); }, log: () => {} });
      expect(result).toEqual({ collected: 1, terminated: 0, cards: 0 });
      expect(killed).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('off mode collects nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-off-'));
    let snapshots = 0;
    const events: string[] = [];
    try {
      const result = await runMachineHeartbeat(schedules, { mode: 'off', root, now, snapshot: () => { snapshots++; return hang(0); },
        sleep: async () => {}, run: bin => `${bin} output`, version: () => '1.4.2', kill: () => {}, log: (_c, event) => { events.push(event); } });
      expect(result).toEqual({ collected: 0, terminated: 0, cards: 0 });
      expect(snapshots).toBe(0);
      expect(events).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('decision line carries mode, candidates, killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-decision-'));
    const decisions: Array<Record<string, unknown>> = [];
    try {
      const log = ((_category: string, event: string, data?: Record<string, unknown>) => { if (event === 'decision') decisions.push(data ?? {}); }) as never;
      const base = { root, sleep: async () => {}, run: (bin: string) => `${bin} output`, version: () => '1.4.2', kill: () => {}, log };
      await runTick(schedules, { ...base, mode: 'on', now, snapshot: () => [] });
      await runTick(schedules, { ...base, mode: 'on', now: new Date(now.getTime() - ORPHAN_STALL_MS), snapshot: () => hang(0) });
      await runTick(schedules, { ...base, mode: 'on', now, snapshot: () => hang(0) });
      await runTick(schedules, { ...base, mode: 'shadow', now: new Date(now.getTime() + 1_000), snapshot: () => hang(1) });
      expect(decisions).toEqual([
        { mode: 'on', candidates: 0, collected: 0, alreadyEvidenced: 0, killed: 0 },
        { mode: 'on', candidates: 0, collected: 0, alreadyEvidenced: 0, killed: 0 },
        { mode: 'on', candidates: 1, collected: 1, alreadyEvidenced: 0, killed: 1 },
        { mode: 'shadow', candidates: 0, collected: 0, alreadyEvidenced: 0, killed: 0 },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('shadow evidences one stalled hang once, not on every later tick, and on still terminates it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-shadow-once-'));
    const decisions: Array<Record<string, unknown>> = [];
    const killed: number[] = [];
    let diagnostics = 0;
    try {
      const log = ((_category: string, event: string, data?: Record<string, unknown>) => { if (event === 'decision') decisions.push(data ?? {}); }) as never;
      const base = { root, sleep: async () => {}, snapshot: () => hang(0), run: (bin: string) => { diagnostics++; return `${bin} output`; },
        version: () => '1.4.2', kill: (pid: number) => { killed.push(pid); }, log };
      await runTick(schedules, { ...base, mode: 'shadow', now: new Date(now.getTime() - ORPHAN_STALL_MS) });
      for (let i = 0; i < 4; i++) await runTick(schedules, { ...base, mode: 'shadow', now: new Date(now.getTime() + i * 60_000) });
      expect(readdirSync(join(root, 'incidents')).filter(file => file.startsWith('orphan-cli-'))).toHaveLength(1);
      expect(decisions.slice(1).map(row => [row.collected, row.alreadyEvidenced])).toEqual([[1, 0], [0, 1], [0, 1], [0, 1]]);
      const afterShadow = diagnostics;
      await runTick(schedules, { ...base, mode: 'shadow', now: new Date(now.getTime() + 5 * 60_000) });
      expect(diagnostics).toBe(afterShadow);
      expect(killed).toEqual([]);
      // The shadow mark never shields the tree once OP switches the GC on.
      const on = await runTick(schedules, { ...base, mode: 'on', now: new Date(now.getTime() + 6 * 60_000) });
      expect(on.terminated).toBe(1);
      expect(killed.length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test('unknown guardian.orphanGc falls back to shadow with a drop warning', () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-config-'));
    const path = join(root, 'config.json');
    const written: string[] = [];
    const original = process.stderr.write;
    try {
      process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
      writeFileSync(path, JSON.stringify({ guardian: { orphanGc: 'maybe' } }));
      expect(buildUserConfig(path).guardian?.orphanGc).toBeUndefined();
      writeFileSync(path, JSON.stringify({ guardian: { mode: 'shadow', orphanGc: 'on' } }));
      expect(buildUserConfig(path).guardian).toEqual({ mode: 'shadow', orphanGc: 'on' });
    } finally {
      process.stderr.write = original;
      rmSync(root, { recursive: true, force: true });
    }
    expect(written.join('')).toContain('[user-config] guardian.orphanGc');
  });

  test('missing diagnostics never terminate or write a false incident', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orphan-fail-'));
    let killed = false;
    try {
      const result = await runMachineHeartbeat(schedules, { root, now, snapshot: () => [rootProcess(), child], sleep: async () => {},
        run: () => { throw new Error('sample unavailable'); }, kill: () => { killed = true; }, log: () => {} });
      expect(result).toEqual({ collected: 0, terminated: 0, cards: 0 });
      expect(killed).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
