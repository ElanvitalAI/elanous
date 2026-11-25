// SPACE-ADVISOR live wiring — writer-check steward port (fake ports) · one advise run · the trigger graph declaration.
import { afterAll, afterEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../../msg/msg-store.js';
import { buildFederationLadder, handClosedOn, readHandMail } from '../../msg/hand-raise-ladder.js';
import { readTriggerDecl } from '../../loops/trigger-registry.js';
import { runAdvise } from './advisor-live.js';
import type { WriterCheckPorts } from './writer-resolver.js';

const root = mkdtempSync(join(tmpdir(), 'advisor-live-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { setSystemTime(); });
const T0 = Date.parse('2026-11-25T15:00:00.000Z');
const ladder = buildFederationLadder({ spaces: [{ coordinator: 'TC', seats: ['TC', 'TC-ADV', 'TC-H-1'] }, { coordinator: 'OP', seats: ['OP'] }] });
const ports: WriterCheckPorts = {
  worktreeOf: () => '/wt/tc-h-1', uncommitted: () => [],
  openPrs: () => [{ number: 40111, branch: 'feat/x', files: ['src/a.ts'] }], recentCommits: () => [],
};

test('writer ✋ with an open PR on its path → the writer-check steward resolves it; the advisor never sees it', () => {
  setSystemTime(new Date(T0));
  const store = new MsgStore(join(root, 'a.db'));
  const h = store.append({ from: 'TC-H-1', to: 'TC', kind: 'request', intent: 'decision', body: '[✋ NEED HUMAN] who writes src/a.ts?',
    refs: ['block:w1', 'seat:TC-H-1', 'reason:OWNER_UNKNOWN', 'cause:writer-handover', 'path:src/a.ts'] });
  const run = runAdvise(store, { ladder, now: () => T0, raiseDecision: () => {}, coordinator: 'TC', live: true, ports, base: join(root, 'b1') });
  expect(run.steps).toEqual([{ kind: 'steward', handId: h.id, cause: 'writer-handover' }]);
  expect(handClosedOn(store, readHandMail(store, h.id)!)).toBe('resolved');
  const row = store.db.query("SELECT body FROM msg_messages WHERE refs_json LIKE '%hand-outcome:resolve%'").get() as { body: string };
  expect(row.body).toContain('open PR #40111');
});

test('a scope ✋ is not the writer-check family → the advisor writes one card to TC', () => {
  setSystemTime(new Date(T0));
  const store = new MsgStore(join(root, 'c.db'));
  const h = store.append({ from: 'TC-H-1', to: 'TC', kind: 'request', intent: 'decision', body: '[✋ NEED HUMAN] split PR?',
    refs: ['block:s1', 'seat:TC-H-1', 'reason:scope'] });
  const run = runAdvise(store, { ladder, now: () => T0, raiseDecision: () => {}, coordinator: 'TC', live: true, ports, base: join(root, 'b2') });
  expect(run.steps.map((s) => [s.kind, s.handId])).toEqual([['recommended', h.id]]);
});

test('trigger graph: space-advisor-tc runs every 2 min, owner TC, goal ledger per window', () => {
  const decl = readTriggerDecl('graphs/triggers/space-advisor-tc.yaml', join(import.meta.dir, '../../..'));
  expect(decl.graphId).toBe('space-advisor-tc');
  expect(decl.cron).toBe('*/2 * * * *');
  expect(decl.owner).toBe('TC');
});
