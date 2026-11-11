import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createGraphEventBus } from './graph-events.js';
import { graphRunEventLedgerPath } from './graph-run-event-ledger.js';
import { registerGraphRunMsgSubscribers, saveGraphRunMsgSubscriber } from './graph-run-msg-subscriptions.js';
import { openMsgStore } from '../msg/msg-store.js';
import { readGraphRunEvents } from './graph-run-event-ledger.js';
import { runGraph } from './runner.js';
import { simCli } from '../ux-sim/in-process-cli.js';

test('ten fake run events deliver per-recipient filters once through eln msg', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-msg-subscription-'));
  const path = graphRunEventLedgerPath(root, 'fake-graph', 'fake-run');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(join(dirname(path), 'fake-run.json'), JSON.stringify({ graphId: 'fake-graph', runId: 'fake-run' }));
    saveGraphRunMsgSubscriber(root, 'fake-graph', 'fake-run', { to: 'OP', type: 'node-end', match: { outcome: 'fail' } });
    saveGraphRunMsgSubscriber(root, 'fake-graph', 'fake-run', { to: 'TC', type: 'node-start' });
    writeFileSync(join(dirname(path), 'fake-run.subscribers', 'broken.json'), '{');
    const bus = createGraphEventBus();
    const dispose = registerGraphRunMsgSubscribers(bus, { graphId: 'fake-graph', runId: 'fake-run' }, root);
    try {
      for (let sequence = 1; sequence <= 10; sequence++) {
        const type = sequence % 2 ? 'node-start' : 'node-end';
        const event = { graphId: 'fake-graph', runId: 'fake-run', eventId: `fake-graph:fake-run:${sequence}`,
          sequence, emittedAt: new Date(sequence * 1000).toISOString(), type,
          source: { kind: 'node' as const, nodeId: 'node-a' },
          data: { outcome: sequence % 4 === 2 ? 'ok' : 'fail' } };
        await bus.publish(event);
        if (sequence === 10) await bus.publish(event); // outbox retry must not duplicate mail
      }
    } finally { dispose(); }
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      const failed = store.listByRecipient('OP', 0, 20).map(message => message.body);
      expect(failed).toHaveLength(2);
      expect(failed.every(body => body.includes('outcome=fail') && body.includes('sequence='))).toBe(true);
      expect(store.listByRecipient('TC', 0, 20).map(message => message.body)).toHaveLength(5);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a real runner journals lifecycle events and delivers a newly declared live subscriber', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-run-msg-live-'));
  try {
    const graphDir = join(root, 'graphs');
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, 'recipes.yaml'), '{}\n');
    const graph = join(graphDir, 'graph.yaml');
    writeFileSync(graph, [
      'graph_id: live-graph', 'version: 1', 'entry_node: done', 'terminal_nodes: [done, failed]',
      'nodes:', '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', '',
    ].join('\n'));
    const bus = createGraphEventBus();
    bus.subscribe(event => {
      if (event.type === 'node-start') saveGraphRunMsgSubscriber(root, 'live-graph', 'live-run',
        { to: 'OP', type: 'node-end' });
    }, { type: 'node-start' });
    const state = await runGraph(graph, { runId: 'live-run', eventBus: bus, deps: { root } });
    expect(state.status).toBe('done');
    const cliOptions = { stateRoot: root, allowPaths: [['graph', 'runs', 'subscribe']] };
    const defaultSubscription = await simCli(['graph', 'runs', 'subscribe', 'live-run', '--to', 'TC'], cliOptions);
    expect(defaultSubscription.exitCode).toBe(0);
    const subscriberPath = join(root, 'graph-runs', 'live-graph', 'live-run.subscribers', 'TC.json');
    expect(JSON.parse(readFileSync(subscriberPath, 'utf8'))).toMatchObject({
      to: 'TC', type: 'node-end', match: { outcome: 'fail' },
    });
    const replacement = await simCli(['graph', 'runs', 'subscribe', 'live-run', '--to', 'TC',
      '--type', 'node-end', '--node', 'done', '--outcome', 'ok'], cliOptions);
    expect(replacement.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(subscriberPath, 'utf8'))).toMatchObject({
      to: 'TC', type: 'node-end', match: { nodeId: 'done', outcome: 'ok' },
    });
    const journal = readGraphRunEvents(graphRunEventLedgerPath(root, 'live-graph', 'live-run'));
    expect(journal.some(event => event.type === 'node-start')).toBe(true);
    expect(journal.some(event => event.type === 'node-end')).toBe(true);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try { expect(store.listByRecipient('OP', 0, 20).some(message => message.body.includes('node-end'))).toBe(true); }
    finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
