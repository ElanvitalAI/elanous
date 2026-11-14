import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../runner.js';
import { createAsideCapabilityProvider, createAsideCapabilityRegistry } from './aside.js';

const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeAside(mode: 'success' | 'no-login' | 'timeout') {
  const root = mkdtempSync(join(tmpdir(), 'aside-bridge-'));
  roots.push(root);
  const script = `#!/bin/sh
printf '%s\n' "$1|$2|$3" > '${join(root, 'argv.txt')}'
${mode === 'success' ? `printf '%s\n' '{"sessionId":"fake-session-1","outcome":"success","answer":"Public result","links":["https://example.org/item"]}'` : mode === 'no-login' ? `printf '%s\n' 'login required' >&2
exit 1` : 'sleep 2'}
`;
  writeFileSync(join(root, 'aside'), script);
  chmodSync(join(root, 'aside'), 0o755);
  process.env.PATH = `${root}:${originalPath ?? ''}`;
  return root;
}

function fakeScript(body: (root: string) => string): string {
  const root = mkdtempSync(join(tmpdir(), 'aside-bridge-extra-'));
  roots.push(root);
  writeFileSync(join(root, 'aside'), '#!/bin/sh\n' + body(root) + '\n');
  chmodSync(join(root, 'aside'), 0o755);
  process.env.PATH = root + ':' + (originalPath ?? '');
  return root;
}

function graph(root: string): string {
  const path = join(root, 'graph.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(path, `graph_id: aside-bridge-sim\nversion: 1\nentry_node: aside\nterminal_nodes: [done, failed]\nnodes:\n  - node_id: aside\n    kind: capability\n    recipe: none\n    requires: aside.exec@1\n    max_visits: 1\n    input: {"task":"public task","timeoutMs":5000}\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: aside, on: outcome, map: { done: done, failed: failed } }\n`);
  return path;
}

describe('Aside bridge with fake PATH binary', () => {
  test('records node input, result and session ID in the graph run receipt', async () => {
    const root = fakeAside('success');
    const state = await runGraph(graph(root), {
      input: { unrelated: true }, quiet: true,
      deps: { root: join(root, 'state'), capabilityProviders: createAsideCapabilityRegistry() },
    });
    expect(state.status).toBe('done');
    expect(readFileSync(join(root, 'argv.txt'), 'utf8').trim()).toBe('exec|--json|public task');
    expect(readFileSync(join(root, 'graph.yaml'), 'utf8')).toContain('input: {"task":"public task"');
    expect(JSON.parse(state.nodes[0]!.output as string)).toMatchObject({
      outcome: 'done', result: { sessionId: 'fake-session-1', outcome: 'success', answer: 'Public result', links: ['https://example.org/item'] },
      evidence: { sessionId: 'fake-session-1' },
    });
  });

  test('times out and fails closed', async () => {
    fakeAside('timeout');
    // 출처: #35632 MK row 1 timeout case; fakeAside('timeout') sleeps 2 seconds, beyond this synthetic deadline.
    const result = await createAsideCapabilityProvider()({ graphId: 'g', runId: 'r', nodeId: 'n', input: { task: 'public task', timeoutMs: 20 }, outputs: {} });
    expect(result).toMatchObject({ ok: false, outcome: 'failed', error: 'Aside 연결 필요' });
  });

  test('reports an unavailable login as a failure without exposing stderr', async () => {
    fakeAside('no-login');
    const result = await createAsideCapabilityProvider()({ graphId: 'g', runId: 'r', nodeId: 'n', input: { task: 'public task' }, outputs: {} });
    expect(result).toMatchObject({ ok: false, outcome: 'failed', error: 'Aside 연결 필요' });
    expect(JSON.stringify(result)).not.toContain('login required');
  });

  test('fails when Aside is not installed on PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aside-missing-'));
    roots.push(root);
    process.env.PATH = root;
    const result = await createAsideCapabilityProvider()({ graphId: 'g', runId: 'r', nodeId: 'n', input: { task: 'public task' }, outputs: {} });
    expect(result).toMatchObject({ ok: false, outcome: 'failed', error: 'Aside 연결 필요' });
  });

  test('cancels an in-flight task', async () => {
    fakeAside('timeout');
    const controller = new AbortController();
    const pending = createAsideCapabilityProvider()({
      // 출처: #35632 MK row 1 cancellation case; abort is sent before the fake sleep completes.
      graphId: 'g', runId: 'r', nodeId: 'n', input: { task: 'public task', timeoutMs: 2000 }, outputs: {}, signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, outcome: 'failed', error: 'Aside 연결 필요' });
  });

  test('kills descendants and settles before their held stdout closes', async () => {
    const root = fakeScript((dir) => '(sleep 0.5; printf alive > ' + JSON.stringify(join(dir, 'descendant-alive')) + '; sleep 2) &\nexit 0');
    const started = performance.now();
    // 출처: #36403 MF1; the fake descendant holds stdout after its parent exits.
    const result = await createAsideCapabilityProvider()({ graphId: 'g', runId: 'r', nodeId: 'n', input: { task: 'public task', timeoutMs: 30 }, outputs: {} });
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ ok: false, outcome: 'failed', error: 'Aside 연결 필요' });
    // 출처: #36403 MF1; this bound is below the fake descendant's 2.5-second pipe hold.
    expect(elapsed).toBeLessThan(1000);
    // 출처: #36403 MF1; wait beyond the fake descendant's 0.5-second marker delay.
    await Bun.sleep(700);
    expect(existsSync(join(root, 'descendant-alive'))).toBe(false);
  });

  test('Windows fails before spawning Aside', async () => {
    const root = fakeScript((dir) => 'printf spawned > ' + JSON.stringify(join(dir, 'aside-spawned')));
    const result = await createAsideCapabilityProvider({ platform: 'win32' })({
      graphId: 'g', runId: 'r', nodeId: 'n', input: { task: 'public task' }, outputs: {},
    });
    expect(result).toMatchObject({ ok: false, outcome: 'failed', error: 'Windows 미지원 · 0.3.18' });
    expect(existsSync(join(root, 'aside-spawned'))).toBe(false);
  });

  test('decodes a multibyte JSON answer split across stdout chunks', async () => {
    fakeScript(() => [
      "printf '%s' '{\"sessionId\":\"fake-utf8\",\"outcome\":\"success\",\"answer\":\"'",
      "printf '\\355'; sleep 0.02",
      "printf '\\225'; sleep 0.02",
      "printf '\\234'",
      "printf '%s\\n' '\",\"links\":[]}'",
    ].join('\n'));
    const result = await createAsideCapabilityProvider()({ graphId: 'g', runId: 'r', nodeId: 'n', input: { task: 'public task' }, outputs: {} });
    expect(result).toMatchObject({ ok: true, outcome: 'done', result: { sessionId: 'fake-utf8', answer: '한' } });
  });
});
