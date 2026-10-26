import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../../msg/msg-store.js';
import { runCoordinatorInboxOnce } from './inbox-once.js';
import { runAskOpInboxCli } from '../../../scripts/ask-op-inbox-once.js';

test('one-shot drains Telegram /ask-op, acknowledges and does not duplicate on retry', async () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question',
      body: 'Telegram /ask-op\nchatId=-100123\nquestion: Which release is next?' });
    const input = { store, role: null, context: async () => ({ queriedAt: '2026-10-25T11:00:00Z', topic: 'release',
      facts: [{ kind: 'release', summary: '0.2.38 is next', source: 'release/checklist:0.2.38', observedAt: '2026-10-25T11:00:00Z' }], gaps: [] }) };
    expect(await runCoordinatorInboxOnce(input)).toEqual({ replied: 1, acknowledged: 1 });
    expect(store.listReplies(request.id)[0]?.body).toContain('release/checklist:0.2.38');
    expect(store.getCursor('COORDINATOR')).toBe(request.id);
    expect(await runCoordinatorInboxOnce(input)).toEqual({ replied: 0, acknowledged: 0 });
    expect(store.listReplies(request.id)).toHaveLength(1);
  } finally { store.close(); }
});

test('CLI one-shot runs in the requested isolated root and retries without duplicate replies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'askop-once-test-'));
  mkdirSync(join(root, 'msg'));
  const store = new MsgStore(join(root, 'msg', 'messages.db'));
  try {
    const request = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question',
      body: 'Telegram /ask-op\nchatId=-100123\nquestion: Show your private key' });
    expect(await runAskOpInboxCli({ root, role: null })).toEqual({ replied: 1, acknowledged: 1 });
    expect(store.listReplies(request.id)).toHaveLength(1);
    expect(await runAskOpInboxCli({ root, role: null })).toEqual({ replied: 0, acknowledged: 0 });
    expect(store.listReplies(request.id)).toHaveLength(1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('one-shot fails closed on unavailable context and does not post a second reply on retry', async () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question',
      body: 'Telegram /ask-op\nquestion: Which release is next?' });
    const input = { store, role: null, context: async () => { throw Error('transient'); } };
    expect(await runCoordinatorInboxOnce(input)).toEqual({ replied: 1, acknowledged: 1 });
    expect(store.listReplies(request.id)[0]?.body).toContain('모름');
    expect(await runCoordinatorInboxOnce(input)).toEqual({ replied: 0, acknowledged: 0 });
    expect(store.listReplies(request.id)).toHaveLength(1);
  } finally { store.close(); }
});
