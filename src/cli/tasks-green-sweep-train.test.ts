import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerTasksCommands } from './tasks-cli.js';
import { writeTaskCards, type TaskCard } from '../task-agent/task-hand.js';
import type { Checklist } from '../release-loop/checklist.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);
const URL = 'https://github.com/example/repo/pull/123';

async function sweep(trainMergeSha: string) {
  const root = mkdtempSync(join(tmpdir(), 'ta-train-green-'));
  const statePath = join(root, 'task-agent-actions.json');
  const trafficPath = join(root, 'traffic.json');
  writeFileSync(trafficPath, JSON.stringify({ hold: [] }));
  const card: TaskCard = {
    id: 'ta-train', text: 'train component', createdAt: '2026-10-15T12:00:00.000Z', status: 'done', history: [
      { at: '2026-10-15T12:00:00.000Z', event: 'landed-via-train', pr: 123, detail: `train #456 merged ${SHA}` },
    ], checklistId: 'CELL', checklistVersion: '0.2.30', pr: { number: 123, url: URL },
    prTerminal: { pr: 123, url: URL, head: OTHER, state: 'CLOSED', at: '2026-10-15T12:00:00.000Z' },
    trainLanding: { componentPr: 123, integrationPr: 456, mergeSha: SHA, train: 'c2', at: '2026-10-15T12:00:00.000Z' },
  };
  writeTaskCards(statePath, [card]);
  const checklist: Checklist = { version: '0.2.30', released: '0.2.29', dev: '0.2.30', history: [], items: [
    { id: 'CELL', title: '대상 경로: src/task-agent/train-landing.ts', status: 'yellow', evidence: '',
      updatedAt: '2026-10-15T12:00:00.000Z', updatedBy: 'test' },
  ] };
  const lines: string[] = [];
  const program = new Command();
  registerTasksCommands(program, {
    taskStatePath: statePath, output: (line) => lines.push(line), greenSweepChecklist: () => checklist,
    greenSweepRun: (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === 'git remote get-url origin') return { status: 0, stdout: 'git@github.com:example/repo.git\n' };
      if (key === 'git rev-parse origin/main') return { status: 0, stdout: `${MAIN}\n` };
      if (key === 'git ls-remote origin refs/heads/main') return { status: 0, stdout: `${MAIN}\trefs/heads/main\n` };
      if (key === `git merge-base --is-ancestor ${SHA} origin/main`) return { status: 0, stdout: '' };
      if (key.startsWith('gh pr view 123 ')) return { status: 0, stdout: JSON.stringify({ number: 123, state: 'CLOSED', url: URL }) };
      if (key.startsWith('gh pr view 456 ')) return { status: 0, stdout: JSON.stringify({ number: 456, state: 'MERGED', mergeCommit: { oid: trainMergeSha } }) };
      return { status: 1, stdout: '' };
    },
  });
  await program.parseAsync(['tasks', 'green-sweep', '--version', '0.2.30', '--traffic', trafficPath, '--json'], { from: 'user' });
  return { result: JSON.parse(lines.at(-1)!) as { decisions: Array<{ verdict: string; reason: string; evidence: string }> }, checklist };
}

describe('tasks green-sweep train entrypoint', () => {
  test('a mismatched integration merge SHA cannot turn a CLOSED component green', async () => {
    const { result, checklist } = await sweep(OTHER);
    expect(result.decisions[0]).toMatchObject({ verdict: 'skip', reason: 'pr-closed' });
    expect(result.decisions[0]!.evidence).not.toContain('· green ·');
    expect(checklist.items[0]!.status).toBe('yellow');
    expect(checklist.items[0]!.evidence).toBe('');
  });

  test('the same entrypoint uses the verified integration SHA as train landing evidence', async () => {
    const { result, checklist } = await sweep(SHA);
    expect(result.decisions[0]).toMatchObject({ verdict: 'green', reason: 'bound-card-train-merged' });
    expect(result.decisions[0]!.evidence).toContain(`PR #123 via train #456 merged ${SHA}`);
    expect(checklist.items[0]!.status).toBe('yellow'); // dry-run never writes the ledger
  });
});
