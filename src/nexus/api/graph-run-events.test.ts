import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendGraphRunEvent, graphRunEventLedgerPath } from '../../graph-runner/graph-run-event-ledger.js';
import { handleGraphRunEvents } from './graph-run-events.js';

test('Nexus replays a remote host run with subscriber type and resume cursor', async () => {
  const remoteRoot = mkdtempSync(join(tmpdir(), 'remote-graph-events-'));
  const path = graphRunEventLedgerPath(remoteRoot, 'remote-graph', 'remote-run');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(join(dirname(path), 'remote-run.json'), JSON.stringify({ graphId: 'remote-graph', runId: 'remote-run', startedAt: new Date().toISOString(),
      status: 'done', path: [], nodes: [], executed: 0, dryRun: false, statePath: join(dirname(path), 'remote-run.json') }));
    for (let sequence = 1; sequence <= 10; sequence++) appendGraphRunEvent(path, {
      eventId: `remote-graph:remote-run:${sequence}`, sequence, emittedAt: new Date(sequence * 1000).toISOString(),
      graphId: 'remote-graph', runId: 'remote-run', type: sequence % 2 ? 'node-start' : 'node-end',
      source: { kind: 'node', nodeId: 'remote-node' },
      data: { token: 'sensitive', outcome: sequence % 2 ? 'start' : 'ok' },
    });
    const url = new URL('https://remote.example/v1/graph-runs/remote-run/events?type=node-end');
    const response = handleGraphRunEvents(new Request(url, { headers: { 'last-event-id': '4' } }), url, remoteRoot)!;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body.match(/event: graph-event/g)?.length).toBe(3);
    expect(body).toContain('id: 6\n');
    expect(body).toContain('id: 10\n');
    expect(body).not.toContain('id: 4\n');
    expect(body).not.toContain('sensitive');
    const slowUrl = new URL('https://remote.example/v1/graph-runs/remote-run/events');
    const slow = handleGraphRunEvents(new Request(slowUrl), slowUrl, remoteRoot)!;
    const reader = slow.body!.getReader();
    const seen: string[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      seen.push(new TextDecoder().decode(next.value));
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(seen.join('').match(/event: graph-event/g)?.length).toBe(10);
  } finally {
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('Nexus closes a backpressured follow stream when the request disconnects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-graph-follow-'));
  const path = graphRunEventLedgerPath(root, 'remote-graph', 'live-run');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(join(dirname(path), 'live-run.json'), JSON.stringify({ graphId: 'remote-graph', runId: 'live-run',
      startedAt: new Date().toISOString(), status: 'running', path: [], nodes: [], executed: 0,
      dryRun: false, statePath: join(dirname(path), 'live-run.json') }));
    for (let sequence = 1; sequence <= 10; sequence++) appendGraphRunEvent(path, {
      eventId: `remote-graph:live-run:${sequence}`, sequence, emittedAt: new Date().toISOString(),
      graphId: 'remote-graph', runId: 'live-run', type: 'node-start',
      source: { kind: 'node', nodeId: 'remote-node' },
    });
    const url = new URL('https://remote.example/v1/graph-runs/live-run/events');
    const disconnect = new AbortController();
    const response = handleGraphRunEvents(new Request(url, { signal: disconnect.signal }), url, root)!;
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    // The producer is waiting for the one-frame queue to drain here.
    disconnect.abort();
    const remaining = await reader.read();
    if (!remaining.done) expect((await reader.read()).done).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
