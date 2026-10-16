import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { publishInsideEvent, startInsideEventRelay } from '../nexus/api/inside-events.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { updateTaskCard } from '../task-agent/task-hand.js';
import { collectTaRepairCompleted, parseTaRepairCompleted, startTaRepairEventCollector } from './ta-repair-event-collect.js';

const HEAD = 'a'.repeat(40);
const RUN = 'run-123';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ta-repair-event-'));
  const statePath = join(root, 'task-agent-actions.json');
  const resultPath = join(root, 'repair.json');
  const event = { kind: 'ta.repair.completed', schema: 1, card: 'ta-one', pr: 30, head: HEAD,
    runId: RUN, resultPath, completedAt: new Date(Date.now() - 100).toISOString() } as const;
  const card = { id: 'ta-one', text: 'repair', createdAt: new Date().toISOString(), status: 'launched', history: [],
    repairs: [{ pr: 30, head: HEAD, branch: 'pr-30', at: new Date().toISOString(), move: 'narrow-relaunch',
      runId: RUN, resultPath, fromModel: 'a', toModel: 'b', status: 'requested' }] };
  writeFileSync(statePath, JSON.stringify({ tasks: { 'ta-one': card, 'ta-other': { ...card, id: 'ta-other' } } }));
  writeFileSync(resultPath, JSON.stringify({ pr: 30, head: HEAD, runId: RUN, ok: false, reason: 'worker failed' }));
  return { root, statePath, resultPath, event };
}

test('collector validates the bound card and atomic result, then rejudges only that card once', async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const observations: Record<string, unknown>[] = [];
    const run = async (id: string) => {
      calls.push(id);
      updateTaskCard(f.statePath, id, card => card ? { ...card, repairs: card.repairs?.map(repair => ({ ...repair, status: 'failed' as const })) } : undefined);
      return { code: 0, output: JSON.stringify([{ card: f.event.card, pr: f.event.pr, repairRunId: f.event.runId,
        repairHead: f.event.head, step: 'repair', decision: 'repair-failed' }]) };
    };
    expect(await collectTaRepairCompleted(f.event, { statePath: f.statePath, run, log: row => observations.push(row) })).toBe('collected');
    expect(await collectTaRepairCompleted(f.event, { statePath: f.statePath, run, log: row => observations.push(row) })).toBe('duplicate');
    expect(calls).toEqual(['ta-one']);
    expect(observations[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(observations[1]).not.toHaveProperty('latencyMs');
    const state = JSON.parse(readFileSync(f.statePath, 'utf8'));
    expect(state.tasks['ta-other'].repairs[0].status).toBe('requested');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('wrong binding or unreadable result never spawns a rejudge; periodic fallback keeps the card', async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const observations: Record<string, unknown>[] = [];
    const deps = { statePath: f.statePath, run: async (id: string) => { calls.push(id); return { code: 0, output: '' }; },
      log: (row: Record<string, unknown>) => observations.push(row) };
    expect(await collectTaRepairCompleted({ ...f.event, pr: 31 }, deps)).toBe('invalid');
    expect(await collectTaRepairCompleted({ ...f.event, resultPath: join(f.root, 'elsewhere') }, deps)).toBe('invalid');
    writeFileSync(f.resultPath, '{partial');
    expect(await collectTaRepairCompleted(f.event, deps)).toBe('deferred');
    expect(observations.map(row => row.outcome)).toEqual(['invalid', 'invalid', 'deferred']);
    expect(observations.every(row => !Object.hasOwn(row, 'latencyMs'))).toBe(true);
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(f.statePath, 'utf8')).tasks['ta-one'].repairs[0].status).toBe('requested');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('corrupt repair binding is rejected without an unhandled subscriber rejection', async () => {
  const f = fixture();
  try {
    const state = JSON.parse(readFileSync(f.statePath, 'utf8'));
    state.tasks['ta-one'].repairs[0].head = null;
    writeFileSync(f.statePath, JSON.stringify(state));
    const calls: string[] = [];
    const outcomes: string[] = [];
    const stop = startTaRepairEventCollector(new NexusEventBus(), { statePath: f.statePath,
      run: async id => { calls.push(id); return { code: 0, output: '' }; }, log: row => outcomes.push(String(row.outcome)) });
    try { publishInsideEvent(f.event); await Bun.sleep(10); }
    finally { stop(); }
    expect(calls).toEqual([]);
    expect(outcomes).toEqual(['invalid']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('dead daemon lock is reclaimed so the next completion can be collected', async () => {
  const f = fixture();
  try {
    const lock = join(f.root, 'steward', 'ta-repair-collect', 'ta-one.lock');
    mkdirSync(join(f.root, 'steward', 'ta-repair-collect'), { recursive: true });
    writeFileSync(lock, '999999999\n');
    const outcome = await collectTaRepairCompleted(f.event, { statePath: f.statePath, run: async id => {
      updateTaskCard(f.statePath, id, card => card ? { ...card,
        repairs: card.repairs?.map(repair => ({ ...repair, status: 'failed' as const })) } : undefined);
      return { code: 0, output: JSON.stringify([{ card: f.event.card, pr: f.event.pr, repairRunId: f.event.runId,
        repairHead: f.event.head, step: 'repair', decision: 'repair-failed' }]) };
    } });
    expect(outcome).toBe('collected');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('periodic collector winning the race is observed as duplicate, not event latency', async () => {
  const f = fixture();
  const observations: Record<string, unknown>[] = [];
  try {
    const result = await collectTaRepairCompleted(f.event, { statePath: f.statePath,
      run: async id => {
        updateTaskCard(f.statePath, id, card => card ? { ...card,
          repairs: card.repairs?.map(repair => ({ ...repair, status: 'failed' as const })) } : undefined);
        return { code: 0, output: JSON.stringify([{ card: f.event.card, pr: f.event.pr, repairRunId: 'run-other',
          repairHead: f.event.head, step: 'repair', decision: 'repair-failed' }]) };
      }, log: row => observations.push(row) });
    expect(result).toBe('duplicate');
    expect(observations.map(row => row.outcome)).toEqual(['duplicate']);
    expect(observations[0]).not.toHaveProperty('latencyMs');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('oversized child output leaves event attribution unmeasured without a false latency', async () => {
  const f = fixture();
  const observations: Record<string, unknown>[] = [];
  try {
    const outcome = await collectTaRepairCompleted(f.event, { statePath: f.statePath,
      run: async id => {
        updateTaskCard(f.statePath, id, card => card ? { ...card,
          repairs: card.repairs?.map(repair => ({ ...repair, status: 'failed' as const })) } : undefined);
        return { code: 0, output: 'partial JSON', truncated: true };
      }, log: row => observations.push(row) });
    expect(outcome).toBe('deferred');
    expect(observations[0]?.outcome).toBe('deferred');
    expect(observations[0]).not.toHaveProperty('latencyMs');
    expect(observations[0]?.reason).toContain('output exceeded');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('inside event bridge dispatches through the Nexus bus without blocking the publisher', async () => {
  const f = fixture();
  const bus = new NexusEventBus();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const stop = startTaRepairEventCollector(bus, { statePath: f.statePath, run: async id => {
    calls.push(id); await pending; return { code: 0, output: '' };
  } });
  try {
    publishInsideEvent(f.event);
    publishInsideEvent(f.event);
    expect(parseTaRepairCompleted(f.event)?.card).toBe('ta-one');
    await Bun.sleep(20);
    expect(calls).toEqual(['ta-one']);
  } finally { release(); stop(); await Bun.sleep(5); rmSync(f.root, { recursive: true, force: true }); }
});

test('separate worker crosses the real relay and real tasks rejudge CLI to consume one repair', async () => {
  const f = fixture();
  const COMMIT = 'b'.repeat(40);
  const HASH = 'c'.repeat(64);
  const artifactDir = join(f.root, 'pod-artifacts', 'si-test', 'repair');
  mkdirSync(artifactDir, { recursive: true });
  const artifact = { pr: 30, baseHead: HEAD, runId: RUN, commit: COMMIT, bundleSha256: HASH };
  writeFileSync(join(artifactDir, 'result.json'), JSON.stringify(artifact));
  writeFileSync(join(artifactDir, 'commit.bundle'), 'test-only bundle; CAS is injected in the isolated CLI');
  const marker = { ...artifact, job: 'si-test', artifactDir };
  const harnessBin = join(f.root, 'harness-child.ts');
  writeFileSync(harnessBin, `console.log('ELANOUS_POD_REPAIR_RESULT ' + JSON.stringify(${JSON.stringify(marker)}));`);
  const workerBin = join(f.root, 'worker-child.ts');
  writeFileSync(workerBin, `import { runRepairWorker } from ${JSON.stringify(join(import.meta.dir, '../task-agent/repair-worker.ts'))};\n` +
    `await runRepairWorker(${JSON.stringify({ card: 'ta-one', pr: 30, head: HEAD, repo: f.root, resultPath: f.resultPath,
      entry: harnessBin, configDir: f.root, runId: RUN, goal: 'repair', model: { provider: 'openrouter', model: 'test' } })});`);
  const cliBin = join(f.root, 'tasks-child.ts');
  writeFileSync(cliBin, `import { Command } from ${JSON.stringify(join(import.meta.dir, '../../node_modules/commander/index.js'))};\n` +
    `import { registerTasksCommands } from ${JSON.stringify(join(import.meta.dir, '../cli/tasks-cli.ts'))};\n` +
    `const program = new Command().name('elanous');\n` +
    `registerTasksCommands(program, { taskStatePath: ${JSON.stringify(f.statePath)}, registerSink: async () => {}, output: console.log,` +
    ` rejudge: { liveMoves: new Set(), live: { repoCandidates: () => [{ source: 'host', cwd: ${JSON.stringify(f.root)} }],` +
    ` prHead: async () => ({ head: ${JSON.stringify(HEAD)}, state: 'OPEN', url: 'https://github.com/o/r/pull/30', branch: 'feature' }) },` +
    ` applyRepair: () => ({ ok: true, fromHead: ${JSON.stringify(HEAD)}, toHead: ${JSON.stringify(COMMIT)}, branch: 'feature' }) } });\n` +
    `await program.parseAsync(['bun', 'elanous', ...process.argv.slice(2)]);\n`);
  updateTaskCard(f.statePath, 'ta-one', card => card ? { ...card,
    pr: { number: 30, url: 'https://github.com/o/r/pull/30' },
    adoptedPr: { pr: 30, url: 'https://github.com/o/r/pull/30', head: HEAD, at: new Date().toISOString() },
    history: [{ at: new Date().toISOString(), event: 'live-move-result', kind: 'review', pr: 30,
      head: HEAD, verdict: 'fail', reviewed: true, mustFix: 1 }] } : undefined);
  const previousRoot = getTestStateRoot();
  setTestStateRoot(f.root);
  const stopRelay = startInsideEventRelay();
  const recorded: Array<Record<string, unknown>> = [];
  const stopCollector = startTaRepairEventCollector(new NexusEventBus(), { statePath: f.statePath,
    cliBin, log: row => recorded.push(row) });
  try {
    const child = Bun.spawn([process.execPath, workerBin], { cwd: f.root, stdout: 'ignore', stderr: 'pipe',
      env: { ...process.env, ELANOUS_NEXUS_DIR: join(f.root, 'nexus'), ELANOUS_STATE_DIR: f.root } });
    expect(await child.exited).toBe(0);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = JSON.parse(readFileSync(f.statePath, 'utf8'));
      if (state.tasks['ta-one'].repairs[0].status !== 'requested'
        && recorded.some(row => row.outcome === 'collected' && row.card === 'ta-one' && row.runId === RUN)) break;
      await Bun.sleep(20);
    }
    const state = JSON.parse(readFileSync(f.statePath, 'utf8'));
    expect(state.tasks['ta-one'].repairs[0].status).toBe('applied');
    expect(state.tasks['ta-other'].repairs[0].status).toBe('requested');
    expect(recorded.some(row => row.outcome === 'collected' && row.card === 'ta-one' && row.runId === RUN)).toBe(true);
  } finally { stopCollector(); stopRelay(); setTestStateRoot(previousRoot ?? null); rmSync(f.root, { recursive: true, force: true }); }
}, 30_000);
