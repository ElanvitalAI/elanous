// TUI-DISPLAY-SNAPSHOT-RESTORE — a restart / session switch / resume paints the transcript the person last saw, then
// what is newer in the store. The real compactor runs with a fake summarizer only. Expectations are literals (rule 11).
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompactProvider } from '../../compact/provider.js';
import { CHAT_DEFAULTS } from '../../user-config/chat.js';
import { appendMessage, createSession, loadSession, type SerializedMessage } from '../../session/index.js';
import { compactSessionHistory } from '../../session/compact-session.js';
import { toLLM } from '../../session/chat.js';
import { displayRowsAfterReload } from './compact-display.js';
import { buildDisplaySnapshot, displaySnapshotFile, restoreDisplayFromSnapshot, writeDisplaySnapshot } from './display-snapshot.js';

const root = mkdtempSync(join(tmpdir(), 'display-snapshot-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const summarizer: CompactProvider = {
  async summarize(args) { return { summary: 'fake summary', modelUsed: 'fake', sourceMessageCount: args.messages.length }; },
  getContextWindow: () => 32_000,
  getAutoCompactThreshold: () => 0.5,
};
const at = (minute: number) => `2026-11-25T02:${String(minute).padStart(2, '0')}:00.000Z`;
const pad = ' detail'.repeat(60);
const heads = (rows: readonly SerializedMessage[]) => rows.map((row) => `${row.role}:${row.content.split(/[\n ]/, 2).join(' ')}`);

function seed(): string {
  const id = createSession({ source: 'tui' }, root).id;
  let minute = 0;
  for (let k = 0; k < 5; k += 1) {
    appendMessage(id, { role: 'user', content: `question ${k}${pad}`, ts: at(minute++) }, root);
    appendMessage(id, { role: 'tool', content: `⚙️ Bash ${k}`, ts: at(minute++), toolName: 'Bash' } as SerializedMessage, root);
    appendMessage(id, { role: 'assistant', content: `answer ${k}${pad}`, ts: at(minute++), replyFinal: true } as SerializedMessage, root);
  }
  appendMessage(id, { role: 'user', content: `[notice · seat-mail]\nmail line two${pad}`, ts: at(minute++),
    from: { kind: 'agent', seat: 'TC', msgId: '9002' } } as SerializedMessage, root);
  appendMessage(id, { role: 'assistant', content: `answer to mail${pad}`, ts: at(minute++), replyFinal: true } as SerializedMessage, root);
  return id;
}

const SHOWN = [
  'user:question 0', 'tool:⚙️ Bash', 'assistant:answer 0',
  'user:question 1', 'tool:⚙️ Bash', 'assistant:answer 1',
  'user:question 2', 'tool:⚙️ Bash', 'assistant:answer 2',
  'user:question 3', 'tool:⚙️ Bash', 'assistant:answer 3',
  'user:question 4', 'tool:⚙️ Bash', 'assistant:answer 4',
  'user:[notice ·', 'assistant:answer to',
];

test('compaction → restart: the restart paints the transcript last shown, then the newer stored rows; store and request untouched', async () => {
  const id = seed();
  const shown = loadSession(id, root)!.messages;
  expect((await compactSessionHistory(id, { config: CHAT_DEFAULTS.autoCompact, force: true, provider: summarizer, modelId: 'fake', root })).fired).toBe(true);
  const compacted = loadSession(id, root)!.messages;
  // Pre-fix restart: the boot painted the store — reordered rows and a stubbed mail row.
  expect(heads(compacted)).not.toEqual(SHOWN);
  expect(compacted.some((row) => row.content === '[seat-mail 9002 from TC] [notice · seat-mail]')).toBe(true);

  // The running TUI merged the compaction (#40049) and saves what it shows.
  const merged = displayRowsAfterReload({ sameSession: true, compacted: false, displayed: shown, reloaded: compacted }).rows;
  expect(heads(merged)).toEqual(SHOWN);
  const file = join(root, `${id}.jsonl`);
  const storeBefore = readFileSync(file, 'utf-8');
  const requestBefore = JSON.stringify(toLLM(loadSession(id, root)!.messages));
  expect(writeDisplaySnapshot(id, merged, compacted, root)).toBe('written');
  expect(existsSync(displaySnapshotFile(id, root))).toBe(true);

  // A row arrives while the TUI is down (the relaunch window).
  appendMessage(id, { role: 'user', content: 'question after restart', ts: at(40) }, root);
  const storedAtBoot = loadSession(id, root)!.messages;
  const storedAtBootJson = JSON.stringify(storedAtBoot);

  // Restart: the boot paints the snapshot, then the newer row.
  const painted = restoreDisplayFromSnapshot(id, storedAtBoot, root)!;
  expect(heads(painted.rows)).toEqual([...SHOWN, 'user:question after']);
  expect(painted.rows[15]!.content.startsWith('[notice · seat-mail]\nmail line two')).toBe(true);
  expect(painted.rows.some((row) => row.content.startsWith('<context_summary>'))).toBe(false);

  // Cache-neutral: the stored history bytes (apart from the one appended row) and the request are what they were.
  expect(readFileSync(file, 'utf-8').startsWith(storeBefore)).toBe(true);
  expect(JSON.stringify(storedAtBoot)).toBe(storedAtBootJson);
  const requestNow = JSON.stringify(toLLM(loadSession(id, root)!.messages));
  expect(requestNow.startsWith(requestBefore.slice(0, -1))).toBe(true);
  expect(JSON.stringify(toLLM(storedAtBoot))).toBe(requestNow);
});

test('a screen equal to the store keeps no snapshot; a missing or foreign snapshot paints the store', () => {
  const a = { role: 'user', content: 'one', ts: at(1), turn_id: 'B1' } as SerializedMessage;
  const b = { role: 'assistant', content: 'two', ts: at(2), turn_id: 'B2' } as SerializedMessage;
  expect(buildDisplaySnapshot([a, b], [a, b])).toBeNull();
  expect(buildDisplaySnapshot([a, b], [b])).toEqual([{ row: a }, { ref: 'B2' }]);
  const id = createSession({ source: 'tui' }, root).id;
  expect(restoreDisplayFromSnapshot(id, [a, b], root)).toBeNull();
  expect(writeDisplaySnapshot(id, [a, b], [b], root)).toBe('written');
  expect(restoreDisplayFromSnapshot(id, [b], root)!.rows.map((row) => row.content)).toEqual(['one', 'two']);
  // The screen caught up with the store: the snapshot is removed.
  expect(writeDisplaySnapshot(id, [a, b], [a, b], root)).toBe('cleared');
  expect(existsSync(displaySnapshotFile(id, root))).toBe(false);
  // Another session's snapshot never paints this one.
  const other = createSession({ source: 'tui' }, root).id;
  expect(restoreDisplayFromSnapshot(other, [b], root)).toBeNull();
});
