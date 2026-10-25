import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem } from '../release-loop/checklist.js';
import { allowedReadOnlyCli, parseBoundaryChecks, produceBoundaryProof } from './boundary-proof-producer.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const mainSha = 'a'.repeat(40);
const live = 'separate graph ledger result';
const mapping = '[{"kind":"graph-run","graphId":"fixture-live","runId":"prior-1","nodeId":"result","assertion":{"path":"outcome","equals":"pass"}}]';
const title = `완료 경계 실물: ${live}\n완료 경계 실물 검증: ${mapping}`;

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'boundary-producer-'));
  roots.push(stateRoot);
  const ledger = join(stateRoot, 'graph-runs', 'fixture-live');
  mkdirSync(ledger, { recursive: true });
  writeFileSync(join(ledger, 'prior-1.json'), JSON.stringify({ graphId: 'fixture-live', runId: 'prior-1',
    status: 'done', input: { cellId: 'CELL-1', mainSha },
    nodes: [{ nodeId: 'result', ok: true, exit: 0, output: { outcome: 'pass' } }] }));
  return { title, cellId: 'CELL-1', mainSha, mapRunId: 'map-1', cardId: 'card-1',
    graphRunId: 'graph-1', stateRoot, repoRoot: resolve(import.meta.dir, '../..') };
}

test('finite mapping rejects prose, shell, unknown verifier, and mutating CLI', () => {
  expect(parseBoundaryChecks(`완료 경계 실물: ${live}`)).toBeNull();
  expect(parseBoundaryChecks(`완료 경계 실물 검증: [{"kind":"test-run","command":"bun test src/a.test.ts; rm x"}]`)).toBeNull();
  expect(parseBoundaryChecks('완료 경계 실물 검증: [{"kind":"shell","command":"exit 0"}]')).toBeNull();
  expect(allowedReadOnlyCli(['bun', 'bin/elanous.mjs', 'release', 'checklist', 'status', '--version', '0.2.38'])).toBe(true);
  expect(allowedReadOnlyCli(['bun', 'bin/elanous.mjs', 'release', 'checklist', 'status', '--version', '1.0.0'])).toBe(true);
  expect(allowedReadOnlyCli(['bun', 'bin/elanous.mjs', 'release', 'checklist', 'set', '--version', '0.2.38'])).toBe(false);
  expect(parseBoundaryChecks('완료 경계 실물 검증: [{"kind":"test-run","command":"bun test src/a.test.ts"}]'))
    .toEqual([{ kind: 'test-run', command: 'bun test src/a.test.ts' }]);
});

test('produces one immutable proof bound to cell, main, map, card and graph runs', () => {
  const input = fixture();
  const result = produceBoundaryProof(input);
  expect(result).toMatchObject({ outcome: 'pass', proofRef: 'boundary-proofs/CELL-1/graph-1.json' });
  const proof = JSON.parse(readFileSync(join(input.stateRoot, result.proofRef!), 'utf8'));
  expect(proof).toMatchObject({ cellId: 'CELL-1', mainSha, mapRunId: 'map-1', cardId: 'card-1',
    graphRunId: 'graph-1', runId: 'graph-1', producer: 'green-close-boundary-producer/v1', outcome: 'pass' });
  expect(produceBoundaryProof(input)).toMatchObject({ outcome: 'hold', reason: 'boundary-unproven' });
  expect(produceBoundaryProof({ ...input, graphRunId: 'graph-2', mainSha: 'b'.repeat(40) }))
    .toMatchObject({ outcome: 'hold', reason: 'boundary-unproven' });
});

test('graph-run verifier reads the final structured JSON from a node log', () => {
  const input = fixture();
  const ledger = join(input.stateRoot, 'graph-runs', 'fixture-live', 'prior-1.json');
  const run = JSON.parse(readFileSync(ledger, 'utf8'));
  run.nodes[0].output = 'progress line\n{"outcome":"pass"}\n';
  writeFileSync(ledger, JSON.stringify(run));
  expect(produceBoundaryProof(input)).toMatchObject({ outcome: 'pass' });
});

test('failed graph assertion does not write a proof', () => {
  const input = fixture();
  const ledger = join(input.stateRoot, 'graph-runs', 'fixture-live', 'prior-1.json');
  const run = JSON.parse(readFileSync(ledger, 'utf8'));
  run.nodes[0].output.outcome = 'fail';
  writeFileSync(ledger, JSON.stringify(run));
  expect(produceBoundaryProof(input)).toMatchObject({ outcome: 'hold', reason: 'boundary-unproven' });
});

test('missing or relative state root cannot make a receipt in the worktree', () => {
  const input = fixture();
  expect(produceBoundaryProof({ ...input, stateRoot: '' }))
    .toMatchObject({ outcome: 'hold', reason: 'boundary-unproven' });
  expect(produceBoundaryProof({ ...input, stateRoot: '.' }))
    .toMatchObject({ outcome: 'hold', reason: 'boundary-unproven' });
});

test('read-only cli-json verifier is pinned to the isolated state', () => {
  const input = fixture();
  setElanousConfigDir(input.stateRoot);
  try { addItem('0.2.37', { id: 'BOUNDARY-CLI-ISOLATED-ONLY', title: '대상 경로: src/task-agent/boundary-proof-producer.ts\n- 완료 경계 실물: test state only' }); }
  finally { resetElanousConfigDir(); }
  const title = '완료 경계 실물: isolated checklist status JSON\n완료 경계 실물 검증: '
    + '[{"kind":"cli-json","argv":["bun","bin/elanous.mjs","release","checklist","status","--version","0.2.37"],'
    + '"assertion":{"path":"items.0.id","equals":"BOUNDARY-CLI-ISOLATED-ONLY"}}]';
  expect(produceBoundaryProof({ ...input, title, graphRunId: 'graph-cli' })).toMatchObject({ outcome: 'pass' });
});
