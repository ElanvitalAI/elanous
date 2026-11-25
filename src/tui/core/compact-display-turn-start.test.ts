// TUI-KEEP-TRANSCRIPT-ON-TURN-START-COMPACT (대표 11-25 «the live conversation still flips and disappears at compaction»).
// Live evidence (OP seat be2bc47e, 0.3.36-dev.0): `compact.session turn-start fired:true` came from the turn child, the
// TUI logged zero `compact-display-kept` in 6h, so #40003's merge never ran for this path — the next reload showed the
// rewritten store (audit rows moved ahead of the summary, seat mail cut to one-line stubs). The real compactor runs here
// with a fake summarizer only. Expectations are literals (rule 11).
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompactProvider } from '../../compact/provider.js';
import { CHAT_DEFAULTS } from '../../user-config/chat.js';
import { appendMessage, createSession, loadSession, type SerializedMessage } from '../../session/index.js';
import { compactSessionHistory } from '../../session/compact-session.js';
import { toLLM } from '../../session/chat.js';
import { displayRowsAfterReload, newStoreSummaryId } from './compact-display.js';

const root = mkdtempSync(join(tmpdir(), 'turn-start-compact-display-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const summarizer: CompactProvider = {
  async summarize(args) { return { summary: 'fake summary', modelUsed: 'fake', sourceMessageCount: args.messages.length }; },
  getContextWindow: () => 32_000,
  getAutoCompactThreshold: () => 0.5,
};

const at = (minute: number) => `2026-11-25T01:${String(minute).padStart(2, '0')}:00.000Z`;
const pad = ' detail'.repeat(60);

function seed(): string {
  const id = createSession({ source: 'tui' }, root).id;
  let minute = 0;
  for (let k = 0; k < 6; k += 1) {
    appendMessage(id, { role: 'user', content: `question ${k}${pad}`, ts: at(minute++) }, root);
    appendMessage(id, { role: 'tool', content: `⚙️ Bash ${k}`, ts: at(minute++), toolName: 'Bash' } as SerializedMessage, root);
    appendMessage(id, { role: 'assistant', content: `answer ${k}${pad}`, ts: at(minute++), replyFinal: true } as SerializedMessage, root);
  }
  appendMessage(id, { role: 'user', content: `[notice · seat-mail]\nmail line two${pad}`, ts: at(minute++),
    from: { kind: 'agent', seat: 'TC', msgId: '9001' } } as SerializedMessage, root);
  appendMessage(id, { role: 'assistant', content: `answer to mail${pad}`, ts: at(minute++), replyFinal: true } as SerializedMessage, root);
  return id;
}

const heads = (rows: readonly SerializedMessage[]) => rows.map((row) => `${row.role}:${row.content.split(/[\n ]/, 2).join(' ')}`);

test('turn-start compaction in the turn child: the next reload keeps the shown rows; store and request are untouched', async () => {
  const id = seed();
  const shown = loadSession(id, root)!.messages;
  const result = await compactSessionHistory(id, { config: CHAT_DEFAULTS.autoCompact, force: true, provider: summarizer, modelId: 'fake', root });
  expect(result.fired).toBe(true);
  const reloaded = loadSession(id, root)!.messages;

  // Pre-fix: no onCompact reached the TUI, so the store was shown as it is — the screen reorders and the mail shrinks.
  expect(heads(reloaded)).not.toEqual(heads(shown));
  expect(reloaded.some((row) => row.content === '[seat-mail 9001 from TC] [notice · seat-mail]')).toBe(true);

  // Cache-neutral evidence: the bytes on disk and the provider request built from them, before the display merge.
  const file = join(root, `${id}.jsonl`);
  const storeBefore = readFileSync(file, 'utf-8');
  const requestBefore = JSON.stringify(toLLM(loadSession(id, root)!.messages));
  const reloadedBefore = JSON.stringify(reloaded);

  const merged = displayRowsAfterReload({ sameSession: true, compacted: false, displayed: shown, reloaded });
  expect(typeof merged.compactedBy).toBe('string');
  expect(heads(merged.rows)).toEqual([
    'user:question 0', 'tool:⚙️ Bash', 'assistant:answer 0',
    'user:question 1', 'tool:⚙️ Bash', 'assistant:answer 1',
    'user:question 2', 'tool:⚙️ Bash', 'assistant:answer 2',
    'user:question 3', 'tool:⚙️ Bash', 'assistant:answer 3',
    'user:question 4', 'tool:⚙️ Bash', 'assistant:answer 4',
    'user:question 5', 'tool:⚙️ Bash', 'assistant:answer 5',
    'user:[notice ·', 'assistant:answer to',
  ]);
  // The mail row keeps the text the person read, not the stub.
  expect(merged.rows[18]!.content.startsWith('[notice · seat-mail]\nmail line two')).toBe(true);
  expect(merged.rows.some((row) => row.content.startsWith('<context_summary>'))).toBe(false);

  // Display only: nothing written, nothing mutated, the request the provider gets is byte-identical.
  expect(readFileSync(file, 'utf-8')).toBe(storeBefore);
  expect(JSON.stringify(reloaded)).toBe(reloadedBefore);
  expect(JSON.stringify(toLLM(loadSession(id, root)!.messages))).toBe(requestBefore);

  // The next reload of the same store adds no second compaction (the summary is known), and still keeps the rows.
  const again = displayRowsAfterReload({ sameSession: true, compacted: true, displayed: merged.rows, reloaded,
    knownSummaryId: merged.compactedBy });
  expect(again.compactedBy).toBeUndefined();
  expect(heads(again.rows)).toEqual(heads(merged.rows));
});

test('no new summary in the store, a session switch, or a first paint: the store is shown as it is', () => {
  const a = { role: 'user', content: 'one', ts: at(1), turn_id: 'A1' } as SerializedMessage;
  const b = { role: 'assistant', content: 'two', ts: at(2), turn_id: 'A2' } as SerializedMessage;
  const summary = { role: 'system', content: '<context_summary>\nold\n</context_summary>', ts: at(3), turn_id: 'S1' } as SerializedMessage;
  expect(newStoreSummaryId([a], [a, b])).toBeNull();
  expect(newStoreSummaryId([summary, a], [summary, a, b])).toBeNull();
  expect(newStoreSummaryId([a], [summary, b], 'S1')).toBeNull();
  expect(newStoreSummaryId([a], [summary, b])).toBe('S1');
  expect(displayRowsAfterReload({ sameSession: false, compacted: false, displayed: [a], reloaded: [summary, b] }).rows)
    .toEqual([summary, b]);
  expect(displayRowsAfterReload({ sameSession: true, compacted: false, displayed: [], reloaded: [summary, b] }).rows)
    .toEqual([summary, b]);
});
