import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { claimScheduledGraphAction } from './scheduled-graph-claim.js';

function fixture() { return { path: join(mkdtempSync(join(tmpdir(), 'graph-claim-')), 'claims.sqlite'), version: '0.3.38', cutAt: '2026-11-27T09:00:00Z', phase: 'cut' as const }; }
test('one synthetic action wins concurrent calls and restart sees its durable claim', async () => {
  const f = fixture(); let calls = 0;
  const run = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); };
  const results = await Promise.all([claimScheduledGraphAction({ ...f, run }), claimScheduledGraphAction({ ...f, run })]);
  expect(results.sort()).toEqual(['already-claimed', 'done']);
  expect(await claimScheduledGraphAction({ ...f, run })).toBe('already-claimed');
  expect(calls).toBe(1);
  const db = new Database(f.path, { readonly: true });
  expect((db.query('SELECT status FROM scheduled_graph_claims').get() as { status: string }).status).toBe('done'); db.close();
});
test('failure is uncertain and never automatically retried', async () => {
  const f = fixture(); let calls = 0;
  const run = async () => { calls++; throw new Error('synthetic failure after possible side effect'); };
  await expect(claimScheduledGraphAction({ ...f, run })).rejects.toThrow('synthetic failure');
  expect(await claimScheduledGraphAction({ ...f, run })).toBe('already-claimed');
  expect(calls).toBe(1);
  const db = new Database(f.path, { readonly: true });
  expect((db.query('SELECT status FROM scheduled_graph_claims').get() as { status: string }).status).toBe('uncertain'); db.close();
});
