import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRunLedgerEntry } from '../../src/self-implement/run-ledger.js';
import { roleResult } from './run-role.js';

test('observe-deeper resolves release-loop/<uuid> through the run-ledger namespace parser', () => {
  const uuid = '334fcc6a-dc0c-4dbe-84c7-2b6a37c6b240';
  let lookedUp = '';
  const result = roleResult('observe-deeper', { input: { runId: `release-loop/${uuid}`, failure: { failedTests: 1 } } }, {
    loadLedger: (runId) => {
      lookedUp = runId;
      return [{ runId, event: 'gate', data: { errorText: 'gate diagnostic' } }];
    },
  });
  expect(lookedUp).toBe(uuid);
  expect(result).toMatchObject({ outcome: 'ok', signature: { errorText: 'gate diagnostic' }, addedFacts: ['errorText'] });
});

test('observe-deeper reads the UUID-named JSONL ledger for the incident graph reference', () => {
  const root = mkdtempSync(join(tmpdir(), 'heal-namespaced-ledger-'));
  const uuid = '334fcc6a-dc0c-4dbe-84c7-2b6a37c6b240';
  const ledgerDir = join(root, 'run-ledger');
  try {
    appendRunLedgerEntry({ runId: uuid, event: 'gate', data: { errorText: 'real ledger diagnostic' } }, ledgerDir);
    const result = roleResult('observe-deeper', { input: { runId: `release-loop/${uuid}`, failure: { failedTests: 1 } } }, { ledgerDir });
    expect(result).toMatchObject({ outcome: 'ok', signature: { errorText: 'real ledger diagnostic' }, addedFacts: ['errorText'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('observe-deeper fails closed for an unknown or malformed namespace', () => {
  let loads = 0;
  for (const runId of ['other/334fcc6a-dc0c-4dbe-84c7-2b6a37c6b240', 'release-loop/../../etc/passwd']) {
    const result = roleResult('observe-deeper', { input: { runId, failure: { failedTests: 1 } } }, {
      loadLedger: () => { loads++; return []; },
    });
    expect(result).toMatchObject({ outcome: 'fail', reason: `unsupported-namespaced-runId:${runId}` });
  }
  expect(loads).toBe(0);
});
