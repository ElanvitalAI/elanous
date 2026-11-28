import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveRehearsal, registerReleaseGraphCommands } from './release-graph-cli.js';
import { listRuns, type Mode } from '../release-loop/release-graph-exec.js';

let root: string;
let lines: string[];
const origWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'release-graph-cli-'));
  lines = [];
  process.stdout.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.exitCode = 0;
});
afterEach(() => { process.stdout.write = origWrite; rmSync(root, { recursive: true, force: true }); process.exitCode = 0; });

async function cli(args: string[], mode: Mode = 'shadow') {
  const program = new Command().exitOverride();
  registerReleaseGraphCommands(program.command('release'), {
    stateRoot: root,
    exec: () => ({ mode: () => mode, detect: async () => null, post: () => 'msg#0', start: () => { throw new Error('must not start'); } }),
  });
  await program.parseAsync(['node', 'elanous', 'release', 'graph', ...args]);
  return lines.map(l => JSON.parse(l) as Record<string, unknown>);
}

test('plan --json gives the quick DAG and its critical path', async () => {
  const [out] = await cli(['plan', '0.3.36', '--rehearsal-at', '2026-11-25T13:00:00Z', '--cut-at', '2026-11-25T19:00:00Z', '--publish-at', '2026-11-25T21:00:00Z', '--json']);
  expect((out!.steps as unknown[]).length).toBe(22); // 21 golden + board-flip (CURRENT-RELEASE-ONE-SOURCE)
  expect((out!.criticalPath as { minutes: number }).minutes).toBe(23.5);
});

test('first run without clock times is refused', async () => {
  const [out] = await cli(['run', '0.3.36', '--json']);
  expect(out!.ok).toBe(false);
  expect(out!.error).toBe('first run needs --cut-at and --publish-at (and --rehearsal-at)');
});

test('--at (virtual clock) is refused for a live version', async () => {
  const [out] = await cli(['run', '0.3.37', '--cut-at', '2026-11-26T07:00:00Z', '--publish-at', '2026-11-26T09:00:00Z', '--at', '2026-11-26T07:00:00Z', '--json'], 'live');
  expect(out!.error).toBe('--at is shadow-only; this version is configured live');
});

test('shadow run at cut time records would-run cut and starts nothing', async () => {
  const [out] = await cli(['run', '0.3.36', '--rehearsal-at', '2026-11-25T13:00:00Z', '--cut-at', '2026-11-25T19:00:00Z', '--publish-at', '2026-11-25T21:00:00Z', '--at', '2026-11-25T19:00:00Z', '--json']);
  expect(out!.mode).toBe('shadow');
  const kinds = (out!.events as Array<{ kind: string; step?: string }>).filter(e => e.kind === 'would-run').map(e => e.step);
  expect(kinds).toEqual(['notes', 'roster', 'schedule', 'cut']);
});

test('run with --rehearsal-at also creates the rehearsal run the tick fires', async () => {
  await cli(['run', '0.3.36', '--rehearsal-at', '2026-11-25T13:00:00Z', '--cut-at', '2026-11-25T19:00:00Z', '--publish-at', '2026-11-25T21:00:00Z', '--at', '2026-11-25T12:00:00Z', '--json']);
  expect(listRuns(root)).toEqual(['0.3.36', '0.3.36-rehearsal']);
});

test('rehearse --json reports the rehearsal key and receipt path', async () => {
  const [out] = await cli(['rehearse', '0.3.36', '--rehearsal-at', '2026-11-25T13:00:00Z', '--json']);
  expect(out!.version).toBe('0.3.36-rehearsal');
  expect(String(out!.receipt).endsWith('/release/0.3.36/rehearsal-receipt.json')).toBe(true);
});

test('archiveRehearsal moves only the rehearsal run aside; the release run stays', () => {
  const { mkdirSync, writeFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
  const rel = join(root, 'release-graph', '0.3.36');
  const reh = join(root, 'release-graph', '0.3.36-rehearsal');
  mkdirSync(rel, { recursive: true }); mkdirSync(reh, { recursive: true });
  writeFileSync(join(rel, 'state.json'), '{}'); writeFileSync(join(reh, 'state.json'), '{}');
  const to = archiveRehearsal(root, '0.3.36');
  expect(to).toBe(join(root, 'release-graph', '0.3.36-rehearsal#1'));
  expect(existsSync(reh)).toBe(false);
  expect(existsSync(join(rel, 'state.json'))).toBe(true);
  expect(archiveRehearsal(root, '0.3.36')).toBe(null);
  mkdirSync(reh); expect(archiveRehearsal(root, '0.3.36')).toBe(join(root, 'release-graph', '0.3.36-rehearsal#2'));
});
