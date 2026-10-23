import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTaskAgentNeedsOwnerVisit } from './doctor-visit.js';
import { appendRunLedgerEntry, loadRunLedger } from './run-ledger.js';
import { handTask, updateTaskCard } from '../task-agent/task-hand.js';

const RUN = 'run-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const transition = { cardId: 'task-1', at: '2026-10-23T00:00:00.000Z', reason: 'failed/needs-owner — exit 1', transitionIndex: 2 };

test('TA needs-owner: missing ledger 0, existing 1, same transition retry 0', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'ta-doctor-')), 'run-ledger');
  expect(recordTaskAgentNeedsOwnerVisit({ runId: RUN, ...transition, dir })).toEqual({ status: 'missing-ledger' });
  expect(loadRunLedger(RUN, dir)).toBeNull();
  appendRunLedgerEntry({ runId: RUN, timestamp: transition.at, event: 'start', data: {} }, dir);
  expect(recordTaskAgentNeedsOwnerVisit({ runId: RUN, ...transition, dir })).toEqual({ status: 'recorded' });
  expect(recordTaskAgentNeedsOwnerVisit({ runId: RUN, ...transition, dir })).toEqual({ status: 'already-recorded' });
  expect(loadRunLedger(RUN, dir)?.filter((row) => row.event === 'doctor-visit')).toEqual([
    expect.objectContaining({ runId: RUN, data: expect.objectContaining({ from: 'task-agent', symptom: 'needs-owner', cardId: 'task-1', transitionAt: transition.at, transitionIndex: 2, evidence: transition.reason }) }),
  ]);
});

test('TA card transition writes a visit after the card update, then retries do not append', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-doctor-card-'));
  const path = join(root, 'task-agent-actions.json');
  const dir = join(root, 'run-ledger');
  const { card } = await handTask({ text: 'repair run', live: true, statePath: path,
    launcher: (_args, _cwd, context) => ({ runId: context!.runId }) });
  const runId = card.runId!;
  const fail = (current: typeof card | undefined) => current?.status === 'launched' && ({ ...current, status: 'failed' as const,
    history: [...current.history, { at: transition.at, event: 'failed', detail: transition.reason, runId }] });
  updateTaskCard(path, card.id, fail, { doctorLedgerDir: dir });
  expect(loadRunLedger(runId, dir)).toBeNull();
  appendRunLedgerEntry({ runId, timestamp: transition.at, event: 'start', data: {} }, dir);
  updateTaskCard(path, card.id, (current) => current && ({ ...current, status: 'launched' as const }), { doctorLedgerDir: dir });
  updateTaskCard(path, card.id, fail, { doctorLedgerDir: dir });
  updateTaskCard(path, card.id, fail, { doctorLedgerDir: dir });
  expect(loadRunLedger(runId, dir)?.filter((row) => row.event === 'doctor-visit')).toHaveLength(1);
});
