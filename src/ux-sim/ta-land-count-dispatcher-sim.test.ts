import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTasksCommands, type TasksCliDeps } from '../cli/tasks-cli.js';
import { appendRunLedgerEntry } from '../self-implement/run-ledger.js';
import { writeTaskCards, type TaskCard } from '../task-agent/task-hand.js';
import { simulateTaLandCountDispatch, type LandCountCommandEvidence } from './ta-land-count-dispatcher-sim.js';

async function runTasksCli(args: string[], deps: TasksCliDeps): Promise<{ lines: string[]; code: number | undefined }> {
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, { handOpenPrRun: () => ({ status: 0, stdout: '[]' }),
    handOriginRepo: () => 'https://github.com/ElanvitalAI/elanous', ...deps, output: (line) => lines.push(line) });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', ...args]);
    return { lines, code: process.exitCode };
  } finally { process.exitCode = previous ?? 0; }
}

function commandFromCli(result: { lines: string[]; code: number | undefined }): LandCountCommandEvidence {
  return { argv: ['eln', 'tasks', 'land-count', '--json'], exitCode: result.code ?? 0,
    stdout: result.lines[0] ?? '', stderr: '' };
}

const command = (stdout: string, exitCode = 0): LandCountCommandEvidence => ({
  argv: ['eln', 'tasks', 'land-count', '--json'],
  exitCode,
  stdout,
  stderr: '',
});

test('dispatcher counts live launched parents and excludes completed orphans with raw CLI evidence', () => {
  const raw = JSON.stringify({ count: 1, active: ['ta-live'], terminal: ['ta-completed-orphan'], unknown: [] });
  const result = simulateTaLandCountDispatch({ target: 2, command: command(raw) });

  expect(result.decision).toEqual({ dispatch: true, activeCount: 1, remaining: 1, reason: 'capacity-available' });
  expect(result.evidence.command).toEqual({ argv: ['eln', 'tasks', 'land-count', '--json'], exitCode: 0, stdout: raw, stderr: '' });
  expect(result.evidence.parsed?.active).toEqual(['ta-live']);
  expect(result.evidence.parsed?.terminal).toEqual(['ta-completed-orphan']);
  expect(result.evidence.countedIds).toEqual(['ta-live']);
  expect(result.evidence.countedIds).not.toContain('ta-completed-orphan');
});

test('missing or unreadable ledger command results fail closed without dispatch or a fabricated count', () => {
  const failures = [
    command(JSON.stringify({ count: null, active: [], terminal: [], unknown: [], error: 'TA cards ledger missing' }), 1),
    command(JSON.stringify({ count: null, active: [], terminal: [], unknown: ['ta-parent'] }), 1),
  ];

  for (const input of failures) {
    const result = simulateTaLandCountDispatch({ target: 4, command: input });
    expect(result.decision.dispatch).toBe(false);
    expect(result.decision.activeCount).toBeNull();
    expect(result.decision.remaining).toBeNull();
    expect(result.decision.reason).toBe('count-unavailable');
    expect(result.evidence.command).toEqual(input);
    expect(result.evidence.countedIds).toEqual([]);
  }
});

test('malformed or inconsistent count evidence cannot authorize a launch', () => {
  const raw = JSON.stringify({ count: 0, active: ['ta-live'], terminal: [], unknown: [] });
  const result = simulateTaLandCountDispatch({ target: 4, command: command(raw) });

  expect(result.decision).toEqual({ dispatch: false, activeCount: null, remaining: null, reason: 'invalid-count-evidence' });
  expect(result.evidence.command.stdout).toBe(raw);
  expect(result.evidence.countedIds).toEqual([]);
});

test('empty task identifiers remain invalid after using the shared string array guard', () => {
  for (const field of ['active', 'terminal', 'unknown'] as const) {
    const receipt: { count: number; active: string[]; terminal: string[]; unknown: string[] } =
      { count: 0, active: [], terminal: [], unknown: [] };
    receipt[field] = [''];
    const result = simulateTaLandCountDispatch({ target: 2, command: command(JSON.stringify(receipt)) });
    expect(result.decision).toEqual({ dispatch: false, activeCount: null, remaining: null, reason: 'invalid-count-evidence' });
  }
});

test('a successful process exit with an error payload still fails closed', () => {
  const raw = JSON.stringify({ count: 0, active: [], terminal: [], unknown: [], error: 'ledger unreadable' });
  const result = simulateTaLandCountDispatch({ target: 4, command: command(raw) });

  expect(result.decision).toEqual({ dispatch: false, activeCount: null, remaining: null, reason: 'count-unavailable' });
  expect(result.evidence.command.stdout).toBe(raw);
  expect(result.evidence.countedIds).toEqual([]);
});

test('production tasks land-count receipt drives the live tasks hand admission and refusal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-land-count-e2e-'));
  const statePath = join(root, 'task-agent-actions.json');
  const ledgerDir = join(root, 'run-ledger');
  mkdirSync(ledgerDir, { recursive: true });
  const card = (id: string, runId: string): TaskCard => ({ id, text: id, createdAt: '2026-11-08T00:00:00Z',
    status: 'launched', taLand: true, runId, history: [] });
  const launches: string[][] = [];
  const deps: TasksCliDeps = { taskStatePath: statePath, registerSink: async () => true,
    taskLauncher: (args) => { launches.push([...args]); } };
  try {
    writeTaskCards(statePath, [card('ta-active', 'run-active'), card('ta-orphan', 'run-orphan')]);
    appendRunLedgerEntry({ runId: 'run-active', event: 'node-enter', data: { node: 'implementation' } }, ledgerDir);
    appendRunLedgerEntry({ runId: 'run-orphan', event: 'run-status', data: { runStatus: 'completed' } }, ledgerDir);
    const actualReceipt = commandFromCli(await runTasksCli(['tasks', 'land-count', '--json'], deps));
    const available = simulateTaLandCountDispatch({ target: 2, command: actualReceipt });
    expect(available.decision).toMatchObject({ dispatch: true, activeCount: 1, remaining: 1, reason: 'capacity-available' });
    expect(available.evidence.countedIds).toEqual(['ta-active']);
    expect(available.evidence.parsed?.terminal).toEqual(['ta-orphan']);

    const full = await runTasksCli(['tasks', 'hand', 'must not launch at capacity', '--ta-land', '--ta-land-max', '1', '--live'], deps);
    expect(full.code).toBe(1);
    expect(full.lines.join('\n')).toContain('capacity-full');
    expect(launches).toHaveLength(0);
    const admitted = await runTasksCli(['tasks', 'hand', 'launch with measured capacity', '--ta-land', '--ta-land-max', '2', '--live'], deps);
    expect(admitted.code ?? 0).toBe(0);
    expect(launches).toHaveLength(1);

    const unknownRoot = join(root, 'unknown');
    const unknownState = join(unknownRoot, 'task-agent-actions.json');
    mkdirSync(unknownRoot, { recursive: true });
    writeTaskCards(unknownState, [card('ta-unknown', 'run-no-ledger')]);
    const unknownDeps = { ...deps, taskStatePath: unknownState };
    const unavailableReceipt = commandFromCli(await runTasksCli(['tasks', 'land-count', '--json'], unknownDeps));
    const unavailable = simulateTaLandCountDispatch({ target: 2, command: unavailableReceipt });
    expect(unavailable.decision).toMatchObject({ dispatch: false, activeCount: null, reason: 'count-unavailable' });
    const refused = await runTasksCli(['tasks', 'hand', 'must fail closed on unknown count', '--ta-land', '--ta-land-max', '2', '--live'], unknownDeps);
    expect(refused.code).toBe(1);
    expect(refused.lines.join('\n')).toContain('count-unavailable');
    expect(launches).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
