import { describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { setTestStateRoot } from '../paths.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../../graph-runner/runner.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest, startNexusHttpServer } from './http-server.js';
import { handleInsideEvents, maskInsideEventValue, publishInsideEvent, startInsideEventRelay, subscribeInsideEvent } from './inside-events.js';

const path = 'http://localhost/v1/inside/events';
const node = { kind: 'node', graphId: 'g', runId: 'r', nodeId: 'n', phase: 'start', ts: '2026-10-03T00:00:00.000Z' } as const;

async function nextFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE frame timeout')), 1000)),
  ]);
  if (done || !value) throw new Error('stream closed');
  return new TextDecoder().decode(value);
}

function route(req: Request, wired = true) {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const opts = {
    state, registry: new TabRegistry(state), eventBus: bus,
    ...(wired ? { metaApi: { bearerToken: 'owner', noAuth: false } } : {}),
  };
  return routeRequest(req, opts, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
}

describe('GET /v1/inside/events', () => {
  test('daemon registration rejects anonymous, forged and unwired requests, and only allows GET', async () => {
    expect((await route(new Request(path, { headers: { 'sec-fetch-site': 'cross-site' } })))?.status).toBe(401);
    expect((await route(new Request(path, { headers: { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' } })))?.status).toBe(401);
    expect((await route(new Request(path, { headers: { authorization: 'Bearer owner' } }), false))?.status).toBe(401);
    const post = await route(new Request(path, { method: 'POST', headers: { authorization: 'Bearer owner' } }));
    expect(post?.status).toBe(405);
    expect(post?.headers.get('allow')).toBe('GET');
  });

  test('authenticated SSE emits node shape and ordered named events to every connected reader', async () => {
    const request = new Request(path, { headers: { authorization: 'Bearer owner' } });
    const first = (await route(request))!;
    const second = handleInsideEvents(new Request(path));
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    expect(first.headers.get('cache-control')).toContain('no-transform');
    const a = first.body!.getReader();
    const b = second.body!.getReader();
    expect(await nextFrame(a)).toBe(': inside events stream\n\n');
    expect(await nextFrame(b)).toBe(': inside events stream\n\n');
    publishInsideEvent(node);
    publishInsideEvent({ kind: 'verdict', graphId: 'g', runId: 'r', verdict: 'ok' });
    for (const reader of [a, b]) {
      expect(await nextFrame(reader)).toBe(`event: node\ndata: ${JSON.stringify(node)}\n\n`);
      const verdict = await nextFrame(reader);
      expect(verdict).toMatch(/^event: verdict\ndata: /);
      expect(JSON.parse(verdict.split('data: ')[1]!)).toMatchObject({ kind: 'verdict', graphId: 'g', runId: 'r', verdict: 'ok', ts: expect.any(String) });
    }
    await a.cancel();
    publishInsideEvent({ ...node, phase: 'ok', seconds: 2 });
    expect(await nextFrame(b)).toBe(`event: node\ndata: ${JSON.stringify({ ...node, phase: 'ok', seconds: 2 })}\n\n`);
    await b.cancel();
  });

  test('an actual graph run reaches the authenticated daemon SSE stream in execution order', async () => {
    const reader = (await route(new Request(path, { headers: { authorization: 'Bearer owner' } })))!.body!.getReader();
    await nextFrame(reader);
    const root = mkdtempSync(join(tmpdir(), 'inside-graph-'));
    const graph = join(root, 'graph.yaml');
    writeFileSync(graph, 'graph_id: inside-live\nversion: 1\nentry_node: work\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: work, kind: agent, recipe: "cmd:work", max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: work, on: outcome, map: { ok: done, fail: failed } }\n');
    writeFileSync(join(root, 'recipes.yaml'), 'work: { command: "echo ready" }\n');
    try {
      const run = await runGraph(graph, { runId: 'inside-sse', deps: { root, processStartMs: () => null, runBash: async () => ({ stdout: 'ready', stderr: '', exitCode: 0 }) } });
      expect(run.status).toBe('done');
      const events = await Promise.all(Array.from({ length: 7 }, () => nextFrame(reader)));
      const parsed = events.map(frame => JSON.parse(frame.split('data: ')[1]!));
      expect(parsed.map(ev => `${ev.kind}:${ev.nodeId ?? `${ev.from}->${ev.to}`}:${ev.phase ?? ev.verdict ?? ''}`)).toEqual([
        'node:work:start', 'node:work:ok', 'verdict:work:ok', 'edge:work->done:',
        'node:done:start', 'node:done:ok', 'verdict:done:ok',
      ]);
      expect(parsed[0]).toMatchObject({ graphId: 'inside-live', runId: 'inside-sse', ts: expect.any(String) });
      expect(events.every(frame => frame.startsWith('event: ') && frame.includes('\ndata: '))).toBe(true);
    } finally {
      await reader.cancel();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detached graph process sends node frames to a real authenticated daemon SSE connection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inside-detached-'));
    setElanousConfigDir(root);
    setTestStateRoot(root);
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    const server = startNexusHttpServer({ state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
      metaApi: { bearerToken: 'owner', noAuth: false }, startPort: 44000 + Math.floor(Math.random() * 1500), portRange: 10, portProbe: () => 'available' });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const url = `${server.url}/v1/inside/events`;
      expect((await fetch(url, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(401);
      const response = await fetch(url, { headers: { authorization: 'Bearer owner', 'sec-fetch-site': 'cross-site' }, signal: AbortSignal.timeout(10000) });
      expect(response.status).toBe(200);
      reader = response.body!.getReader();
      expect(await nextFrame(reader)).toBe(': inside events stream\n\n');
      const graph = join(root, 'graph.yaml');
      writeFileSync(graph, 'graph_id: detached-live\nversion: 1\nentry_node: work\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: work, kind: agent, recipe: "cmd:work", max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: work, on: outcome, map: { ok: done, fail: failed } }\n');
      writeFileSync(join(root, 'recipes.yaml'), 'work: { command: "echo ready" }\n');
      child = Bun.spawn([process.execPath, '-e', `const {runGraph}=await import('./src/graph-runner/runner.ts'); const run=await runGraph(${JSON.stringify(graph)}, {runId:'detached-run'}); console.log(run.status);`],
        { cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'pipe', stderr: 'pipe' });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream<Uint8Array>).text(), new Response(child.stderr as ReadableStream<Uint8Array>).text()]);
      expect({ code, output: output.trim(), errors: errors.includes('error:') ? errors : '' }).toEqual({ code: 0, output: 'done', errors: '' });
      let streamText = '';
      const deadline = Date.now() + 5000;
      while (streamText.split('event: ').length - 1 < 7 && Date.now() < deadline) {
        const { value, done } = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw new Error('detached SSE frame timeout'); })]);
        if (done) throw new Error('detached SSE stream closed');
        streamText += new TextDecoder().decode(value);
      }
      const frames = streamText.split('\n\n').filter(frame => frame.startsWith('event: '));
      expect(frames).toHaveLength(7);
      const events = frames.map(frame => JSON.parse(frame.split('data: ')[1]!));
      expect(events.filter(ev => ev.kind === 'node' && ev.runId === events[0].runId).map(ev => `${ev.nodeId}:${ev.phase}`))
        .toEqual(['work:start', 'work:ok', 'done:start', 'done:ok']);
      expect(events[0]).toMatchObject({ graphId: 'detached-live', runId: 'detached-run', kind: 'node' });
      expect(await child.exited).toBe(0);
    } finally {
      await reader?.cancel();
      child?.kill();
      server.stop();
      resetElanousConfigDir();
      setTestStateRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test('publisher masks nested credential fields and token-like values without mutating producer input', async () => {
    const response = handleInsideEvents(new Request(path));
    const reader = response.body!.getReader();
    await nextFrame(reader);
    const input = {
      kind: 'pty.decision', ts: node.ts, text: 'using Bearer abc123 and apiKey=supersecret',
      detail: { answer: 'done', token: 'supersecret', nested: [{ api_key: 'key-value', text: 'sk-abcdefghijklmnop' }] },
    };
    publishInsideEvent(input);
    const frame = await nextFrame(reader);
    expect(frame).not.toContain('supersecret');
    expect(frame).not.toContain('abc123');
    expect(frame).not.toContain('key-value');
    expect(frame).not.toContain('abcdefghijklmnop');
    const result = JSON.parse(frame.split('data: ')[1]!);
    expect(result).toMatchObject({ kind: 'pty.decision', detail: { answer: 'done', token: '[REDACTED]', nested: [{ api_key: '[REDACTED]' }] } });
    expect(input.detail.token).toBe('supersecret');
    await reader.cancel();
  });

  test('SSE masks Basic credentials and quoted password values without exposing them to subscribers', async () => {
    const reader = handleInsideEvents(new Request(path)).body!.getReader();
    await nextFrame(reader);
    const text = 'Authorization: Basic dXNlcjpwYXNz password="secret" password=\'other-secret\'';
    publishInsideEvent({ kind: 'pty.decision', ts: node.ts, text });
    const frame = await nextFrame(reader);
    expect(frame).not.toContain('dXNlcjpwYXNz');
    expect(frame).not.toContain('other-secret');
    expect(frame).not.toContain('"secret"');
    expect(JSON.parse(frame.split('data: ')[1]!).text).toContain('password="[REDACTED]"');
    expect(JSON.parse(frame.split('data: ')[1]!).text).toContain("password='[REDACTED]'");
    await reader.cancel();
  });

  test('PTY reason masks token assignments for subscribers and SSE readers', async () => {
    const observed: unknown[] = [];
    const unsubscribe = subscribeInsideEvent(event => observed.push(event));
    const reader = handleInsideEvents(new Request(path)).body!.getReader();
    await nextFrame(reader);
    try {
      publishInsideEvent({ kind: 'pty.decision', reason: 'declined: token=abcxyz; keep context' });
      const frame = await nextFrame(reader);
      expect(frame).not.toContain('abcxyz');
      expect(frame).toContain('token=[REDACTED]');
      expect(observed).toMatchObject([{ kind: 'pty.decision', reason: 'declined: token=[REDACTED]; keep context' }]);
    } finally {
      unsubscribe();
      await reader.cancel();
    }
  });

  test('a request aborted before subscribing closes its reader immediately', async () => {
    const abort = new AbortController();
    abort.abort();
    const reader = handleInsideEvents(new Request(path, { signal: abort.signal })).body!.getReader();
    expect((await reader.read()).done).toBe(true);
    publishInsideEvent(node);
    expect((await reader.read()).done).toBe(true);
    await reader.cancel();
  });

  test('an abort during subscription closes the stream before returning', async () => {
    const abort = new AbortController();
    const signal = abort.signal;
    const originalAddEventListener = signal.addEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
      if (args[0] === 'abort') abort.abort();
      return originalAddEventListener(...args);
    }) as AbortSignal['addEventListener'];
    try {
      const reader = handleInsideEvents({ method: 'GET', signal } as Request).body!.getReader();
      expect((await reader.read()).done).toBe(true);
      await reader.cancel();
    } finally {
      signal.addEventListener = originalAddEventListener;
    }
  });

  test('a slow client is closed when its bounded event queue fills', async () => {
    const reader = handleInsideEvents(new Request(path)).body!.getReader();
    for (let i = 0; i < 32; i++) publishInsideEvent({ ...node, nodeId: `node-${i}` });
    const frames: string[] = [];
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      frames.push(new TextDecoder().decode(result.value));
      if (frames.length > 32) throw new Error('slow stream failed to close');
    }
    expect(frames).toHaveLength(16);
    expect(frames[0]).toBe(': inside events stream\n\n');
    expect(frames.at(-1)).toContain('node-14');
    await reader.cancel();
  });

  test('disconnect and aborted requests unsubscribe without disrupting producers', async () => {
    const abort = new AbortController();
    const response = handleInsideEvents(new Request(path, { signal: abort.signal }));
    const reader = response.body!.getReader();
    await nextFrame(reader);
    abort.abort();
    expect((await reader.read()).done).toBe(true);
    await reader.cancel();
    const received: unknown[] = [];
    const unsubscribe = subscribeInsideEvent((event) => received.push(event));
    publishInsideEvent(node);
    unsubscribe();
    publishInsideEvent({ ...node, phase: 'ok' });
    expect(received).toEqual([node]);
    expect(maskInsideEventValue({ harmless: 'visible' })).toEqual({ harmless: 'visible' });
  });
});

describe('inside events cross-process relay', () => {
  const waitFor = async (check: () => boolean, ms = 2000) => {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) throw new Error('relay timeout');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const journalOf = (root: string) => {
    const { id } = JSON.parse(readFileSync(join(root, 'nexus', 'inside-events-relay.json'), 'utf8')) as { id: string };
    return join(root, 'nexus', `inside-events-${id}.jsonl`);
  };

  test('a multi-byte character split across two writes arrives intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inside-relay-'));
    setTestStateRoot(root);
    const stop = startInsideEventRelay();
    const received: Array<{ text?: string }> = [];
    const unsubscribe = subscribeInsideEvent((event) => received.push(event as { text?: string }));
    try {
      const line = Buffer.from(JSON.stringify({ origin: 'other-process', event: { kind: 'seat', text: '자리 루프 한 바퀴' } }) + '\n');
      const split = line.indexOf(Buffer.from('루')) + 1; // inside the 3-byte character
      const file = journalOf(root);
      appendFileSync(file, line.subarray(0, split));
      await new Promise((resolve) => setTimeout(resolve, 60)); // let the relay read the partial character
      appendFileSync(file, line.subarray(split));
      await waitFor(() => received.length > 0);
      expect(received[0]!.text).toBe('자리 루프 한 바퀴');
    } finally {
      unsubscribe();
      stop();
      setTestStateRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a consumed journal rotates, late records in the old journal still arrive, and the old file is removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inside-relay-'));
    setTestStateRoot(root);
    const stop = startInsideEventRelay({ rotateBytes: 200, retireGraceMs: 150 });
    const received: string[] = [];
    const unsubscribe = subscribeInsideEvent((event) => received.push(String((event as { text?: string }).text)));
    try {
      const first = journalOf(root);
      const record = (text: string) => JSON.stringify({ origin: 'other-process', event: { kind: 'seat', text } }) + '\n';
      for (let i = 0; i < 4; i++) appendFileSync(first, record(`before-${i}-${'x'.repeat(40)}`));
      await waitFor(() => journalOf(root) !== first);
      appendFileSync(first, record('late'));
      await waitFor(() => received.includes('late'));
      await waitFor(() => !existsSync(first));
      appendFileSync(journalOf(root), record('after'));
      await waitFor(() => received.includes('after'));
      expect(received.filter((text) => text.startsWith('before-'))).toHaveLength(4);
    } finally {
      unsubscribe();
      stop();
      setTestStateRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
