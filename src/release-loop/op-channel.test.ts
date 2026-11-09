import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalMessageAddress, MsgStore } from '../msg/msg-store.js';
import { postReleaseStageMail } from './stage-mail.js';
import { parseReleaseOpBufferedEvent, postReleaseOpCommand, postReleaseOpQuestion, recordReleaseOpEvent } from './op-channel.js';
import { runGraph } from '../graph-runner/runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('RLA held stage records reject invalid states before release mail dispatch', () => {
  expect(parseReleaseOpBufferedEvent(JSON.stringify({ runId: 'r1', nodeId: 'gate', state: 'wait', eventId: 'e1' })))
    .toEqual({ runId: 'r1', nodeId: 'gate', state: 'wait', eventId: 'e1' });
  expect(() => parseReleaseOpBufferedEvent(JSON.stringify({ runId: 'r1', nodeId: 'gate', state: 'unknown', eventId: 'e2' })))
    .toThrow('invalid RLA held event');
  expect(() => parseReleaseOpBufferedEvent('{broken')) .toThrow();
});

function releaseGraph(root: string, content: string): string {
  const graph = join(root, 'release-loop.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(graph, content);
  return graph;
}

test('RLA shadow to operational transition runs three shadow matches then holds, recovers, and resumes through runGraph', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-op-channel-sim-')); roots.push(root);
  const graph = releaseGraph(root, [
    'graph_id: release-loop-sim', 'version: 1', 'entry_node: shadow-a', 'terminal_nodes: [done, failed]', 'nodes:',
    '  - { node_id: shadow-a, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: shadow-b, kind: gate, recipe: none, max_visits: 1 }',
    "  - { node_id: shadow-c, kind: agent, recipe: 'handler:inject-no-go', max_visits: 1 }",
    '  - { node_id: target, kind: gate, recipe: none, max_visits: 2 }',
    "  - { node_id: recovery, kind: agent, recipe: 'handler:recover', max_visits: 1 }",
    '  - { node_id: finish, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', 'edges:',
    '  - { from: shadow-a, on: outcome, map: { ok: shadow-b, fail: failed } }',
    '  - { from: shadow-b, on: outcome, map: { ok: shadow-c, fail: failed } }',
    '  - { from: shadow-c, on: outcome, map: { ok: target, fail: failed } }',
    '  - { from: target, on: outcome, map: { ok: finish, fail: recovery } }',
    '  - { from: recovery, on: outcome, map: { ok: target, fail: failed } }', '',
    '  - { from: finish, on: outcome, map: { ok: done, fail: failed } }', '',
  ].join('\n'));
  const shadowRoot = mkdtempSync(join(tmpdir(), 'rla-op-channel-shadow-')); roots.push(shadowRoot);
  const shadowGraph = releaseGraph(shadowRoot, [
    'graph_id: release-loop-sim', 'version: 1', 'entry_node: target', 'terminal_nodes: [done, failed]', 'nodes:',
    '  - { node_id: target, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', 'edges:',
    '  - { from: target, on: outcome, map: { ok: done, fail: failed } }', '',
  ].join('\n'));
  const shadowStore = new MsgStore(join(shadowRoot, 'msg', 'messages.db'));
  try { postReleaseOpCommand(shadowStore, 'OP', 'no-go target regression observed'); } finally { shadowStore.close(); }
  const independentShadowObservations: Array<{ nodeId: string; decision: 'go' | 'no-go'; mode: 'shadow' | 'operational' }> = [];
  const shadowState = await runGraph(shadowGraph, { runId: 'rla-independent-shadow', deps: {
    root: shadowRoot, releaseOpChannel: true, releaseOpMode: 'shadow',
    releaseOpDecisionObserver: observation => independentShadowObservations.push(observation),
  } });
  expect(shadowState.status).toBe('done'); // shadow observes the same no-go but does not gate the graph.
  expect(independentShadowObservations[0]).toEqual({ nodeId: 'target', decision: 'no-go', mode: 'shadow' });

  const store = new MsgStore(join(root, 'msg', 'messages.db'));
  try {
    expect(canonicalMessageAddress('RLA')).toBe('RLA');
    for (const question of ['status', 'why shadow-a', 'hold status', 'where are we', 'why target'])
      postReleaseOpQuestion(store, 'OP', question);
    for (const command of ['status', 'why second', 'prefer node-c', 'emergency test-only escalation', 'hold'])
      postReleaseOpCommand(store, 'OP', command);
  } finally { store.close(); }

  let mode: 'shadow' | 'operational' = 'shadow';
  let deferredMailAttempts = 0;
  let failFirstDeferredLedgerWrite = true;
  let deferredLedgerRetrySucceeded = false;
  const shadowObservations: Array<{ nodeId: string; decision: 'go' | 'no-go'; mode: 'shadow' | 'operational' }> = [];
  const operationalObservations: Array<{ nodeId: string; decision: 'go' | 'no-go'; mode: 'shadow' | 'operational' }> = [];
  const state = await runGraph(graph, { runId: 'rla-shadow-to-operational', deps: { root, releaseOpChannel: true,
    releaseOpEventWriter: (eventStore, event) => {
      if (!event.held && event.nodeId === 'shadow-a' && event.state === 'start') {
        if (failFirstDeferredLedgerWrite) { failFirstDeferredLedgerWrite = false; throw new Error('temporary event ledger failure'); }
        deferredLedgerRetrySucceeded = true;
      }
      return recordReleaseOpEvent(eventStore, event);
    },
    releaseStageMail: mail => {
      if (mail.nodeId === 'shadow-a' && mail.state === 'start') {
        deferredMailAttempts++;
      }
      const stageStore = new MsgStore(join(root, 'msg', 'messages.db'));
      try { postReleaseStageMail(mail, { configPath: join(root, 'missing-config.json'), openStore: () => stageStore }); }
      finally { stageStore.close(); }
    },
    releaseOpMode: () => mode, releaseOpDecisionObserver: observation => {
      (mode === 'shadow' ? shadowObservations : operationalObservations).push(observation);
      if (mode === 'shadow' && ['shadow-a', 'shadow-b', 'shadow-c'].includes(observation.nodeId)) {
        const matchesSoFar = shadowObservations.filter(item => ['shadow-a', 'shadow-b', 'shadow-c'].includes(item.nodeId)).length;
        if (matchesSoFar === 3) mode = 'operational';
      }
    }, inProcessHandlers: {
    'inject-no-go': async () => {
      const inbox = new MsgStore(join(root, 'msg', 'messages.db'));
      try { postReleaseOpCommand(inbox, 'OP', 'no-go target regression observed'); } finally { inbox.close(); }
      return { ok: true, outcome: 'ok' };
    },
    recover: async () => {
      const inbox = new MsgStore(join(root, 'msg', 'messages.db'));
      try {
        postReleaseOpCommand(inbox, 'OP', 'go target regression repaired');
        postReleaseOpCommand(inbox, 'OP', 'resume');
      } finally { inbox.close(); }
      return { ok: true, outcome: 'ok' };
    },
  } } });
  expect(state.status).toBe('done');
  // Synthetic graphs exercise the RLA ledger but must not dispatch real release-stage mail.
  expect(deferredMailAttempts).toBe(0);
  expect(deferredLedgerRetrySucceeded).toBe(true);
  expect(state.path).toEqual(['shadow-a', 'shadow-b', 'shadow-c', 'target', 'recovery', 'target', 'finish', 'done']);
  expect(shadowObservations.slice(0, 3).map(({ nodeId, decision }) => ({ nodeId, decision }))).toEqual(
    state.nodes.slice(0, 3).map(({ nodeId, ok }) => ({ nodeId, decision: ok ? 'go' : 'no-go' })));
  expect(shadowObservations.slice(0, 3).every(observation => observation.mode === 'shadow')).toBe(true);
  expect(operationalObservations.find(observation => observation.nodeId === 'target')?.decision).toBe('no-go');
  expect(operationalObservations.filter(observation => observation.nodeId === 'target').at(-1)?.decision).toBe('go');
  expect(independentShadowObservations.find(observation => observation.nodeId === 'target')?.decision)
    .toBe(operationalObservations.find(observation => observation.nodeId === 'target')?.decision);
  const ledger = new MsgStore(join(root, 'msg', 'messages.db'));
  try {
    const toOp = ledger.listByRecipient('OP').filter(message => message.from === 'RLA');
    const answers = toOp.filter(message => message.replyTo !== undefined && message.kind === 'report');
    expect(answers).toHaveLength(5);
    const askedQuestions = ledger.listByRecipient('RLA').filter(message => message.from === 'OP' && message.kind === 'rla-question');
    expect(answers.map(answer => answer.replyTo).sort((a, b) => a! - b!)).toEqual(askedQuestions.map(question => question.id).sort((a, b) => a - b));
    const answerByQuestion = new Map(answers.map(answer => [answer.replyTo!, answer.body]));
    const answerFor = (question: string) => answerByQuestion.get(askedQuestions.find(message => message.body === question)!.id)!;
    expect(answerFor('status')).toContain('"status":"running"');
    expect(answerFor('why shadow-a')).toContain('"node":"shadow-a"');
    expect(answerFor('hold status')).toContain('"held":false');
    expect(answerFor('where are we')).toContain('"currentNode":"shadow-a"');
    expect(answerFor('why target')).toContain('"node":"target"');
    expect(toOp.filter(message => message.kind === 'progress').map(message => message.body)).toEqual(expect.arrayContaining([
      expect.stringContaining('node=shadow-a · state=start'), expect.stringContaining('node=target · state=start'),
      expect.stringContaining('node=recovery · state=start'), expect.stringContaining('node=finish · state=start'),
    ]));
    expect(ledger.listByRecipient('OP').some(message => message.from === 'TC' && message.body.includes('node=shadow-a · state=start'))).toBe(false);
    expect(toOp.filter(message => message.kind === 'report').map(message => message.body)).toEqual(expect.arrayContaining([
      expect.stringContaining('RLA status'), expect.stringContaining('RLA why'), expect.stringContaining('decision":"go"'),
    ]));
    expect(ledger.listByRecipient('RLA').some(message => message.kind === 'rla-command')).toBe(true);
  } finally { ledger.close(); }

  const secondRunGraph = releaseGraph(root, [
    'graph_id: release-loop-sim', 'version: 1', 'entry_node: finish', 'terminal_nodes: [done, failed]', 'nodes:',
    '  - { node_id: finish, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', 'edges:',
    '  - { from: finish, on: outcome, map: { ok: done, fail: failed } }', '',
  ].join('\n'));
  const persistedInbox = new MsgStore(join(root, 'msg', 'messages.db'));
  try { postReleaseOpCommand(persistedInbox, 'OP', 'status'); } finally { persistedInbox.close(); }
  const restarted = await runGraph(secondRunGraph, { runId: 'rla-after-restart', deps: { root, releaseOpChannel: true } });
  expect(restarted.status).toBe('done');
  const afterRestart = new MsgStore(join(root, 'msg', 'messages.db'));
  try {
    const statusReply = afterRestart.listByRecipient('OP').find(message => message.from === 'RLA' && message.body.includes('RLA status · run=rla-after-restart'));
    expect(statusReply?.body).toContain('"held":false');
    expect(statusReply?.body).toContain('"decision":"go"');
    expect(statusReply?.body).toContain('test-only escalation');
  } finally { afterRestart.close(); }
});

test('RLA message ledger outage is fail-open at the real release node boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-op-channel-fail-open-')); roots.push(root);
  const graph = releaseGraph(root, [
    'graph_id: release-loop-sim', 'version: 1', 'entry_node: done', 'terminal_nodes: [done, failed]', 'nodes:',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', '',
  ].join('\n'));
  mkdirSync(join(root, 'msg', 'messages.db'), { recursive: true });
  const state = await runGraph(graph, { runId: 'rla-ledger-failure', deps: { root, releaseOpChannel: true } });
  expect(state.status).toBe('done');
  expect(state.path).toEqual(['done']);
});
