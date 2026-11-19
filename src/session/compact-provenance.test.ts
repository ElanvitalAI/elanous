import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_DEFAULTS } from '../user-config/chat.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import type { CompactProvider } from '../compact/provider.js';
import { TURN_INTERRUPTED_MARKER } from '../chat/interjection.js';
import { nextTuiPublicHistory } from '../tui/core/public-history.js';
import { appendMessage, createSession, loadSession, type SerializedMessage } from './index.js';
import { compactSessionHistory } from './compact-session.js';

const roots: string[] = [];
afterEach(() => { resetAutoCompactStateForTest(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const provider: CompactProvider = {
  async summarize(args) { return { summary: 'summary', sourceMessageCount: args.messages.length }; },
  getContextWindow: () => 32000, getAutoCompactThreshold: () => 0.8,
};
for (const marker of [true, false]) {
  test(`compaction replay preserves ${marker ? 'marker' : 'human'} source on duplicate text`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'compact-provenance-')); roots.push(root);
    const session = createSession({ source: 'tui', model: 'test' }, root);
    const add = (row: SerializedMessage) => appendMessage(session.id, row, root);
    add({ role: 'user', content: TURN_INTERRUPTED_MARKER, ts: '1', ...(marker ? {} : { interruptionMarker: true }) } as SerializedMessage);
    add({ role: 'assistant', content: 'older', ts: '2', replyFinal: true });
    add({ role: 'user', content: TURN_INTERRUPTED_MARKER, ts: '3', ...(marker ? { interruptionMarker: true } : {}) } as SerializedMessage);
    add({ role: 'assistant', content: 'partial', ts: '4', replyFinal: true });
    add({ role: 'assistant', content: 'tail', ts: '5', replyFinal: true });
    const before = loadSession(session.id, root)!.messages;
    const result = await compactSessionHistory(session.id, { root, config: { ...CHAT_DEFAULTS.autoCompact, preserveLastN: 2 }, force: true, provider, modelId: 'test' });
    expect(result.fired).toBe(true);
    const after = loadSession(session.id, root)!.messages;
    expect(after[1]).toEqual(before[2]);
    expect(after.slice(2)).toEqual(before.slice(3));
    const projected = nextTuiPublicHistory([{role:'user',content:'q',ts:'0'}, {role:'assistant',content:'answer',ts:'1',replyFinal:true}, after[1]!]);
    expect(projected[1]!.role).toBe(marker ? 'system' : 'assistant');
  });
}


test('replay selects conversation source, never duplicate audit rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'compact-audit-source-')); roots.push(root);
  const session = createSession({ source: 'tui', model: 'test' }, root);
  const add = (row: SerializedMessage) => appendMessage(session.id, row, root);
  add({ role: 'user', content: 'identical', ts: '1', turn_id: 'selected', interruptionMarker: true } as SerializedMessage);
  add({ role: 'user', content: 'identical', ts: '2', turn_id: 'audit-1', goalInterim: true } as SerializedMessage);
  add({ role: 'user', content: 'identical', ts: '3', turn_id: 'audit-2', goalInterim: true } as SerializedMessage);
  add({ role: 'assistant', content: 'tail 1', ts: '4' });
  add({ role: 'assistant', content: 'tail 2', ts: '5' });
  const before = loadSession(session.id, root)!.messages;
  const result = await compactSessionHistory(session.id, { root, config: { ...CHAT_DEFAULTS.autoCompact, preserveLastN: 2 }, force: true, provider });
  expect(result.fired).toBe(true);
  const after = loadSession(session.id, root)!.messages;
  expect(after.filter(x => x.turn_id === 'selected')).toEqual([before[0]]);
  expect(after.filter(x => x.turn_id === 'audit-1')).toEqual([before[1]]);
  expect(after.filter(x => x.turn_id === 'audit-2')).toEqual([before[2]]);
});


test('overflow retry preserves selected source through workingRows remapping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'compact-overflow-source-')); roots.push(root);
  const session = createSession({ source: 'tui', model: 'test' }, root);
  const add = (row: SerializedMessage) => appendMessage(session.id, row, root);
  add({ role: 'user', content: 'old', ts: '1', turn_id: 'dropped' } as SerializedMessage);
  add({ role: 'user', content: 'identical', ts: '2', turn_id: 'selected', interruptionMarker: true } as SerializedMessage);
  add({ role: 'user', content: 'identical', ts: '3', turn_id: 'audit', goalInterim: true } as SerializedMessage);
  add({ role: 'assistant', content: 'tail 1', ts: '4' });
  add({ role: 'assistant', content: 'tail 2', ts: '5' });
  const before = loadSession(session.id, root)!.messages;
  let calls = 0;
  const overflowProvider: CompactProvider = { ...provider, async summarize(args) { calls++; return calls === 1 ? null : { summary: 'summary', sourceMessageCount: args.messages.length }; } };
  const result = await compactSessionHistory(session.id, { root, config: { ...CHAT_DEFAULTS.autoCompact, preserveLastN: 2 }, force: true, provider: overflowProvider });
  expect(result.overflowRetries).toBe(1);
  expect(result.fired).toBe(true);
  const after = loadSession(session.id, root)!.messages;
  expect(after.filter(x => x.turn_id === 'selected')).toEqual([before[1]]);
  expect(after.filter(x => x.turn_id === 'audit')).toEqual([before[2]]);
  expect(after.some(x => x.turn_id === 'dropped')).toBe(false);
});
