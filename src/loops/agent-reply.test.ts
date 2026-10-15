import { describe, expect, test } from 'bun:test';
import { MsgStore } from '../msg/msg-store.js';
import { buildL0AgentTools, replyWithAgent } from './agent-reply.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

describe('agent reply body', () => {
  test('one linked reply survives retry without rerunning the agent', async () => {
    const store = new MsgStore(':memory:');
    try {
      const request = store.post({ from: 'UX', to: 'COORDINATOR', kind: 'request', body: 'What is next?' });
      let runs = 0;
      const input = { address: 'COORDINATOR' as const, request, store,
        role: { provider: 'grok' as const, model: 'grok-4.6' }, pack: 'L0',
        runAgent: async () => { runs++; return 'Proposal: ask OP. Evidence: no measured gate.'; } };
      const first = await replyWithAgent(input);
      const second = await replyWithAgent(input);
      expect(first.posted).toBe(true);
      expect(second).toEqual({ replyId: first.replyId, posted: false });
      expect(runs).toBe(1);
      expect(store.listReplies(request.id)).toMatchObject([{
        from: 'COORDINATOR', to: 'UX', replyTo: request.id, kind: 'reply',
      }]);
    } finally { store.close(); }
  });

  test('secret text is redacted before posting', async () => {
    const store = new MsgStore(':memory:');
    try {
      const request = store.post({ from: 'UX', to: 'GUARDIAN', kind: 'question', body: 'Status?' });
      await replyWithAgent({ address: 'GUARDIAN', request, store,
        role: { provider: 'grok', model: 'grok-4.6' }, pack: 'L0',
        runAgent: async () => 'Authorization: Bearer abcdefghijklmnop' });
      expect(store.listReplies(request.id)[0]?.body).toBe('Authorization: Bearer ***');
    } finally { store.close(); }
  });

  test('a linked non-reply does not satisfy the request', async () => {
    const store = new MsgStore(':memory:');
    try {
      const request = store.post({ from: 'UX', to: 'COORDINATOR', kind: 'question', body: 'Status?' });
      store.post({ from: 'COORDINATOR', to: 'UX', kind: 'request', body: 'A separate request', replyTo: request.id });
      const result = await replyWithAgent({ address: 'COORDINATOR', request, store,
        role: { provider: 'grok', model: 'grok-4.6' }, pack: 'L0', runAgent: async () => 'Needs evidence.' });
      expect(result.posted).toBe(true);
      expect(store.getMessage(result.replyId!)?.kind).toBe('reply');
    } finally { store.close(); }
  });

  test('L0 dispatcher refuses Bash and product writes before execution', async () => {
    const l0 = buildL0AgentTools('COORDINATOR');
    expect(l0.specs.map(s => s.name)).toContain('Read');
    expect(l0.specs.map(s => s.name)).toContain('Observe');
    expect(l0.specs.map(s => s.name)).not.toContain('Bash');
    expect(l0.specs.map(s => s.name)).not.toContain('Glob');
    expect(await l0.dispatch('Bash', { command: 'eln release checklist set X --status green' }))
      .toMatchObject({ error: expect.stringContaining('L0 denied') });
    expect(await l0.dispatch('Write', { file_path: 'src/traffic.json', content: '{}' }))
      .toMatchObject({ error: expect.stringContaining('outside role notes') });
    expect(await l0.dispatch('Grep', { pattern: 'token', path: process.cwd() }))
      .toMatchObject({ error: expect.stringContaining('one explicit file') });
    expect(await l0.dispatch('Read', { file_path: '/proc/self/environ' }))
      .toMatchObject({ error: expect.stringContaining('approved read roots') });
    expect(await l0.dispatch('Read', { file_path: join(process.env.HOME!, 'elanous-hq', 'seat-state', 'TC', 'HANDOFF.md') }))
      .toMatchObject({ error: expect.stringContaining('approved read roots') });
    expect(await l0.dispatch('Grep', { pattern: 'token', path: '/proc/self/environ', file_path: 'package.json' }))
      .toMatchObject({ error: expect.stringContaining('unexpected file_path') });
    expect(await l0.dispatch('Glob', { pattern: '/proc/**', path: process.cwd() }))
      .toMatchObject({ error: expect.stringContaining('L0 denied') });
    expect(await l0.dispatch('Observe', { surface: 'checklist', version: '../traffic.json' }))
      .toMatchObject({ error: expect.stringContaining('L0 denied') });
  });

  test('an existing credential dotfile inside an approved repo still cannot be read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coord-read-root-'));
    try {
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.npmrc'), '//registry.example/:_authToken=do-not-read\n');
      const l0 = buildL0AgentTools('COORDINATOR', root);
      expect(await l0.dispatch('Read', { file_path: '.npmrc' }))
        .toMatchObject({ error: expect.stringContaining('credential path') });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('credential file names inside an approved repo cannot be read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coord-read-cred-'));
    try {
      mkdirSync(join(root, '.git'));
      mkdirSync(join(root, 'config'));
      for (const name of ['secrets.json', 'credentials.json', 'tokens.txt', 'config/password.yaml']) {
        writeFileSync(join(root, name), 'do-not-read\n');
      }
      writeFileSync(join(root, 'notes.md'), 'ok\n');
      const l0 = buildL0AgentTools('COORDINATOR', root);
      for (const name of ['secrets.json', 'credentials.json', 'tokens.txt', 'config/password.yaml']) {
        expect(await l0.dispatch('Read', { file_path: name }))
          .toMatchObject({ error: expect.stringContaining('credential path') });
        expect(await l0.dispatch('Grep', { pattern: 'do', path: name }))
          .toMatchObject({ error: expect.stringContaining('credential path') });
      }
      expect(JSON.stringify(await l0.dispatch('Read', { file_path: 'notes.md' }))).not.toContain('L0 denied');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('Observe(thread) re-reads an acknowledged thread scoped to this address', async () => {
    const store = new MsgStore(':memory:');
    try {
      const request = store.post({ from: 'UX', to: 'COORDINATOR', kind: 'request', body: 'Hold PR?' });
      const reply = store.post({ from: 'COORDINATOR', to: 'UX', kind: 'reply', body: 'hold 제안', replyTo: request.id });
      const followUp = store.post({ from: 'UX', to: 'COORDINATOR', kind: 'question', body: 'Still hold?', replyTo: reply.id });
      const sideways = store.post({ from: 'UX', to: 'TC', kind: 'reply', body: 'not for coordinator', replyTo: request.id });
      const other = store.post({ from: 'TC', to: 'OP', kind: 'request', body: 'private seat thread' });
      store.ack('COORDINATOR', followUp.id);
      const l0 = buildL0AgentTools('COORDINATOR', process.cwd(), { store });
      expect(await l0.dispatch('Observe', { surface: 'messages' })).toEqual([]);
      const history = await l0.dispatch('Observe', { surface: 'messages', after: 0 }) as Array<{ id: number }>;
      expect(history.map(m => m.id)).toEqual([request.id, followUp.id]);
      const thread = await l0.dispatch('Observe', { surface: 'thread', messageId: followUp.id }) as Array<{ id: number }>;
      expect(thread.map(m => m.id)).toEqual([request.id, reply.id, followUp.id]);
      expect(JSON.stringify(thread)).not.toContain(String(sideways.body));
      expect(await l0.dispatch('Observe', { surface: 'thread', messageId: other.id }))
        .toMatchObject({ error: expect.stringContaining('L0 denied') });
      expect(await l0.dispatch('Observe', { surface: 'messages', after: -1 }))
        .toMatchObject({ error: expect.stringContaining('L0 denied') });
    } finally { store.close(); }
  });

  test('Observe(thread) bounds a long reply chain to depth 20 below the root', async () => {
    const store = new MsgStore(':memory:');
    try {
      const root = store.post({ from: 'UX', to: 'COORDINATOR', kind: 'request', body: 'chain root' });
      let parent = root;
      const chain = [root];
      for (let i = 1; i <= 30; i++) {
        parent = store.post({ from: i % 2 ? 'COORDINATOR' : 'UX', to: i % 2 ? 'UX' : 'COORDINATOR',
          kind: 'reply', body: `step ${i}`, replyTo: parent.id });
        chain.push(parent);
      }
      const l0 = buildL0AgentTools('COORDINATOR', process.cwd(), { store });
      const thread = await l0.dispatch('Observe', { surface: 'thread', messageId: root.id }) as Array<{ id: number }>;
      expect(thread.map(m => m.id)).toEqual(chain.slice(0, 21).map(m => m.id));
      const fromLeaf = await l0.dispatch('Observe', { surface: 'thread', messageId: chain[30]!.id }) as Array<{ id: number }>;
      expect(fromLeaf.map(m => m.id)).toEqual(chain.slice(10).map(m => m.id));
    } finally { store.close(); }
  });

  test('Observe(thread) keeps the requested reply when a busy root exceeds the limit', async () => {
    const store = new MsgStore(':memory:');
    try {
      const root = store.post({ from: 'UX', to: 'COORDINATOR', kind: 'request', body: 'busy root' });
      const replies = Array.from({ length: 60 }, (_, i) =>
        store.post({ from: 'COORDINATOR', to: 'UX', kind: 'reply', body: `reply ${i}`, replyTo: root.id }));
      const l0 = buildL0AgentTools('COORDINATOR', process.cwd(), { store });
      const thread = await l0.dispatch('Observe', { surface: 'thread', messageId: replies[55]!.id }) as Array<{ id: number }>;
      expect(thread).toHaveLength(50);
      expect(thread.map(m => m.id)).toContain(replies[55]!.id);
      expect(thread[0]!.id).toBe(root.id);
    } finally { store.close(); }
  });

  test('Observe(messages) reads only the selected instance store', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'coord-observe-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'coord-observe-b-'));
    const storeA = new MsgStore(join(rootA, 'msg', 'messages.db'));
    const storeB = new MsgStore(join(rootB, 'msg', 'messages.db'));
    try {
      storeA.post({ from: 'UX', to: 'COORDINATOR', body: 'only-instance-A' });
      storeB.post({ from: 'TC', to: 'COORDINATOR', body: 'only-instance-B' });
      const a = buildL0AgentTools('COORDINATOR', process.cwd(), { store: storeA, root: rootA });
      const b = buildL0AgentTools('COORDINATOR', process.cwd(), { store: storeB, root: rootB });
      const observedA = await a.dispatch('Observe', { surface: 'messages' });
      const observedB = await b.dispatch('Observe', { surface: 'messages' });
      expect(JSON.stringify(observedA)).toContain('only-instance-A');
      expect(JSON.stringify(observedA)).not.toContain('only-instance-B');
      expect(JSON.stringify(observedB)).toContain('only-instance-B');
      expect(JSON.stringify(observedB)).not.toContain('only-instance-A');
    } finally {
      storeA.close(); storeB.close();
      rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true });
    }
  });

  test('Observe(checklist) reads the selected ledger without writing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coord-checklist-'));
    const store = new MsgStore(join(root, 'msg', 'messages.db'));
    const ledger = join(root, 'release', 'features.sqlite');
    mkdirSync(join(root, 'release'));
    const db = new Database(ledger);
    db.exec('CREATE TABLE assignments (feature_id TEXT, version TEXT, status TEXT, evidence TEXT)');
    db.query('INSERT INTO assignments VALUES (?, ?, ?, ?)').run('COORD-AGENT-BODY', '0.2.29', 'yellow', 'PR #27511');
    db.close();
    try {
      const l0 = buildL0AgentTools('COORDINATOR', process.cwd(), { store, root });
      expect(await l0.dispatch('Observe', { surface: 'checklist', version: '0.2.29' }))
        .toEqual([{ id: 'COORD-AGENT-BODY', status: 'yellow', evidence: 'PR #27511' }]);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
