// SCHEDULE-TRIGGER-HOOK-IN (GRAPH-SCHEDULER §1-1 ④, §1-3, §6-1) — a verified els HOOK-IN envelope
// becomes a graph event envelope and fires the declared graph through the one dispatch entrance.
// The door owns the signature proof (#39168): a wrong signature is refused before any dispatch.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchHookInGraphTrigger, hookInGraphEventEnvelope, HOOK_IN_EVENT_TYPE, type GraphExternalTriggerDispatchResult } from './graph-events.js';
import { listGraphRuns } from './runner.js';
import { routeElsHook, signHook, type HookConfig, type HookDeps } from '../els/webhook-in.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOW = 1_700_000_000_000;
const SECRET = 'whsec-GRAPH-TEST-3b7f';

/** A minimal runnable graph that declares the hook.in external event (§1-1 ④ col 5). */
function graphFixture(id = 'hook-fixture', declareEvent = true): { file: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'hook-in-graph-'));
  dirs.push(root);
  const file = join(root, `${id}.yaml`);
  writeFileSync(file, `graph_id: ${id}\nversion: 1\nentry_node: done\nterminal_nodes: [done]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n${declareEvent ? `loop:\n  trigger:\n    events: [${HOOK_IN_EVENT_TYPE}]\n` : ''}`); // 출처: #33859 · #24814 graph.yaml fixture 스키마 관례(version 1 · max_visits 1) — research-graph-hand-node.test.ts:15 · child-universe-pin.test.ts:41 · 내부 문서 `RFC-smart-wizard-to-loop-collective-2026-10-08` §41
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  return { file, root };
}

/** The els door side: hooks.json with a graph-target hook (§1-3: hook name ↔ graph, risk class declared). */
function doorFixture(hook: Partial<HookConfig>, dispatch?: HookDeps['dispatchHookInGraphTrigger']): { stateDir: string; deps: HookDeps } {
  const stateDir = mkdtempSync(join(tmpdir(), 'els-hook-'));
  dirs.push(stateDir);
  writeFileSync(join(stateDir, 'hook-ci.secret'), `${SECRET}\n`);
  writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules: [] }));
  const row: Record<string, unknown> = { secretRef: 'hook-ci.secret', ...hook };
  writeFileSync(join(stateDir, 'hooks.json'), JSON.stringify({ hooks: { ci: row } }));
  const deps: HookDeps = {
    stateDir,
    execute: async () => { throw new Error('a graph hook never types a pane'); },
    nonces: new Map(),
    now: () => NOW,
    ...(dispatch ? { dispatchHookInGraphTrigger: dispatch } : {}),
  };
  return { stateDir, deps };
}

const envelope = (graphPath: string, nonce = 'nonce-000001') => ({
  hookName: 'ci', nonce, at: new Date(NOW).toISOString(), body: { status: 'green', run: 42 },
  graphPath, danger: 'read' as const,
});

/** Narrows the dispatch result union to the fired branch — the ignored branch carries no runId. */
const fired = (result: GraphExternalTriggerDispatchResult) => {
  if (result.disposition === 'ignored') throw new Error(`expected a fired graph, got ignored (${result.reason})`);
  return result;
};

const signedRequest = (nonce: string, body = JSON.stringify({ status: 'green', run: 42 })) => ({
  name: 'ci', body, timestamp: String(NOW / 1000), nonce,
  signature: signHook(SECRET, 'ci', String(NOW / 1000), nonce, body),
  source: '127.0.0.1',
});

test('a verified HOOK-IN envelope becomes a graph event envelope with the hook dedupe key (§1-1 ④)', () => {
  const at = new Date(NOW).toISOString();
  const converted = hookInGraphEventEnvelope({ hookName: 'ci', nonce: 'nonce-000001', at, body: { status: 'green' }, graphPath: '/graphs/hook-fixture.yaml', danger: 'read' });
  expect(converted).toEqual({
    eventId: 'hook:ci:nonce-000001', type: HOOK_IN_EVENT_TYPE, dedupeKey: 'hook:ci:nonce-000001',
    at, payload: { status: 'green' },
  });
  expect(converted.type).toBe(HOOK_IN_EVENT_TYPE);
});

test('a signed webhook fires the declared graph exactly once; a replay is a duplicate; an undeclared graph is ignored', async () => {
  const { file, root } = graphFixture();
  const first = fired(await dispatchHookInGraphTrigger(envelope(file), { registryRoot: root, stateRoot: root }));
  expect(first.disposition).toBe('started');
  expect(first.graphId).toBe('hook-fixture');
  const replay = fired(await dispatchHookInGraphTrigger(envelope(file), { registryRoot: root, stateRoot: root }));
  expect(replay.disposition).toBe('duplicate');
  expect(replay.runId).toBe(first.runId);
  const runs = listGraphRuns(root).runs.filter(run => run.graphId === 'hook-fixture');
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status).toBe('done');
  const state = JSON.parse(readFileSync(join(root, 'graph-runs', 'hook-fixture', `${first.runId}.json`), 'utf8')) as { status: string };
  expect(state.status).toBe('done');
  const quiet = graphFixture('quiet-graph', false);
  const ignored = await dispatchHookInGraphTrigger(envelope(quiet.file, 'nonce-000002'), { registryRoot: quiet.root, stateRoot: quiet.root });
  expect(ignored).toEqual({ disposition: 'ignored', reason: 'event-not-declared', graphId: 'quiet-graph', eventId: 'hook:ci:nonce-000002' });
});

test('the door refuses a wrong signature before any graph dispatch, and a signed one starts the graph', async () => {
  const { file, root } = graphFixture();
  const dispatched: Parameters<NonNullable<HookDeps['dispatchHookInGraphTrigger']>>[0][] = [];
  const dispatch: HookDeps['dispatchHookInGraphTrigger'] = async (input) => {
    dispatched.push(input);
    return dispatchHookInGraphTrigger(input, { registryRoot: root, stateRoot: root });
  };
  const { deps } = doorFixture({ graph: file, danger: 'read' }, dispatch);
  const wrong = await routeElsHook(deps, { ...signedRequest('nonce-000001'), signature: `sha256=${'0'.repeat(64)}` });
  expect(wrong.status).toBe(401);
  expect(dispatched).toHaveLength(0);
  expect(listGraphRuns(root).runs.filter(run => run.graphId === 'hook-fixture')).toHaveLength(0);
  const right = await routeElsHook(deps, signedRequest('nonce-000002'));
  expect(right.status).toBe(202);
  expect(JSON.parse(right.body)).toEqual({ ok: true, disposition: 'started', graphId: 'hook-fixture', runId: expect.any(String) });
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toEqual(envelope(file, 'nonce-000002'));
  expect(listGraphRuns(root).runs.filter(run => run.graphId === 'hook-fixture')).toHaveLength(1);
  const audit = readFileSync(join(deps.stateDir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  expect(audit.at(-1)).toMatchObject({ principal: 'hook:ci', kind: 'webhook', action: 'do', result: 'executed' });
});

test('a write-danger hook is held for a person on its first firing, recorded on approval, and never asked again', async () => {
  const { file, root } = graphFixture();
  const dispatched: Parameters<NonNullable<HookDeps['dispatchHookInGraphTrigger']>>[0][] = [];
  const dispatch: HookDeps['dispatchHookInGraphTrigger'] = async (input) => {
    dispatched.push(input);
    return dispatchHookInGraphTrigger(input, { registryRoot: root, stateRoot: root });
  };
  const answers: ('approve' | 'deny' | 'timeout')[] = ['deny'];
  const asks: unknown[] = [];
  const ask: NonNullable<HookDeps['askGraphFirstFiring']> = async (request) => { asks.push(request); return answers.shift() ?? 'approve'; };
  const { deps } = doorFixture({ graph: file, danger: 'write' }, dispatch);
  (deps as { askGraphFirstFiring?: unknown }).askGraphFirstFiring = ask;
  const denied = await routeElsHook(deps, signedRequest('nonce-000001'));
  expect(denied.status).toBe(403);
  expect(JSON.parse(denied.body)).toEqual({ error: 'held for a person', code: 'graph-first-firing' });
  expect(dispatched).toHaveLength(0);
  expect(asks).toHaveLength(1);
  answers.push('approve');
  const approved = await routeElsHook(deps, signedRequest('nonce-000002'));
  expect(approved.status).toBe(202);
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toEqual({ ...envelope(file, 'nonce-000002'), danger: 'write' });
  const record = JSON.parse(readFileSync(join(deps.stateDir, 'hook-trigger-first-firing.json'), 'utf8')) as Record<string, unknown>;
  expect(record).toMatchObject({ ci: { graphPath: file, danger: 'write' } });
  const again = await routeElsHook(deps, signedRequest('nonce-000003'));
  expect(again.status).toBe(202);
  expect(asks).toHaveLength(2);
  expect(dispatched).toHaveLength(2);
});

test('a recorded approval binds name·graphPath·danger — a repointed graph or a changed risk class asks the person again (#39687)', async () => {
  const a = graphFixture('pairing-a');
  const b = graphFixture('pairing-b');
  const dispatched: Parameters<NonNullable<HookDeps['dispatchHookInGraphTrigger']>>[0][] = [];
  const dispatch: HookDeps['dispatchHookInGraphTrigger'] = async (input) => {
    dispatched.push(input);
    return dispatchHookInGraphTrigger(input, { registryRoot: b.root, stateRoot: b.root });
  };
  const answers: ('approve' | 'deny' | 'timeout')[] = [];
  const asks: unknown[] = [];
  const ask: NonNullable<HookDeps['askGraphFirstFiring']> = async (request) => { asks.push(request); return answers.shift() ?? 'approve'; };
  const { deps, stateDir } = doorFixture({ graph: a.file, danger: 'write' }, dispatch);
  (deps as { askGraphFirstFiring?: unknown }).askGraphFirstFiring = ask;
  const record = (): Record<string, unknown> => JSON.parse(readFileSync(join(stateDir, 'hook-trigger-first-firing.json'), 'utf8')) as Record<string, unknown>;
  const repoint = (graph: string, danger: 'read' | 'write' | 'external-send') =>
    writeFileSync(join(stateDir, 'hooks.json'), JSON.stringify({ hooks: { ci: { secretRef: 'hook-ci.secret', graph, danger } } }));

  // The person approves (ci · graph a · write) once; the pairing is recorded with its risk class.
  answers.push('approve');
  const one = await routeElsHook(deps, signedRequest('nonce-000001'));
  expect(one.status).toBe(202);
  expect(asks).toHaveLength(1);
  expect(record()).toMatchObject({ ci: { graphPath: a.file, danger: 'write' } });

  // The same hook name repointed at a different graph is a different pairing: the approval must not carry over.
  repoint(b.file, 'write');
  answers.push('deny');
  const repointed = await routeElsHook(deps, signedRequest('nonce-000002'));
  expect(repointed.status).toBe(403);
  expect(JSON.parse(repointed.body)).toEqual({ error: 'held for a person', code: 'graph-first-firing' });
  expect(asks[1]).toMatchObject({ hookName: 'ci', graphPath: b.file, danger: 'write' });
  expect(dispatched).toHaveLength(1);

  // A fresh approval records the new pairing; the same pairing fires again without asking.
  answers.push('approve');
  const two = await routeElsHook(deps, signedRequest('nonce-000003'));
  expect(two.status).toBe(202);
  expect(asks).toHaveLength(3);
  expect(record()).toMatchObject({ ci: { graphPath: b.file, danger: 'write' } });
  const samePairing = await routeElsHook(deps, signedRequest('nonce-000004'));
  expect(samePairing.status).toBe(202);
  expect(asks).toHaveLength(3);
  expect(dispatched).toHaveLength(3);

  // The same graph under a raised risk class is a different pairing too: it asks the person again.
  repoint(b.file, 'external-send');
  answers.push('deny');
  const escalated = await routeElsHook(deps, signedRequest('nonce-000005'));
  expect(escalated.status).toBe(403);
  expect(asks[3]).toMatchObject({ hookName: 'ci', graphPath: b.file, danger: 'external-send' });
  expect(dispatched).toHaveLength(3);
});

test('a graph hook with no risk class, or a template and a graph together, is not a hook (fail closed)', async () => {
  const noDanger = doorFixture({ graph: '/graphs/x.yaml' });
  expect((await routeElsHook(noDanger.deps, signedRequest('nonce-000001'))).status).toBe(404);
  const both = doorFixture({ graph: '/graphs/x.yaml', danger: 'read', workspace: 'HQ', pane: 'p1', template: 'echo' });
  expect((await routeElsHook(both.deps, signedRequest('nonce-000001'))).status).toBe(404);
});