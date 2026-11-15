import { expect, test } from 'bun:test';
import type { MessageBlock } from '../../conv-substrate/message-block.js';
import type { SerializedMessage } from '../../session/index.js';
import { renderNextTuiLogFrame } from './render.js';

const result: SerializedMessage = {
  role: 'tool', content: '⚙️ Read', toolName: 'Read', toolCallId: 'call-1', surfaceRunId: 'run-1',
  toolArgs: '{"file_path":"/tmp/private-key.pem"}',
  // 출처: #67371 — 한 줄 결과가 보이는지 검증하는 합성 도구 봉투.
  toolResult: JSON.stringify({ output: 'visible file result', linesRead: 1 }), ts: '2026-11-15T00:00:00Z',
};
const block: MessageBlock = {
  id: 'run-1:tool:call-1', ts: 1, source: 'tool',
  body: { kind: 'tool-call', toolCallId: 'call-1', title: 'Read 결과' },
  detail: { level: 3, summary: 'Read 결과', rawRef: { runId: 'run-1', blockId: 'run-1:tool:call-1' } },
};

function screen(message: SerializedMessage, detail = block): string {
  const frame = renderNextTuiLogFrame({
    messages: [{ role: 'user', content: '읽어 줘', ts: '2026-11-15T00:00:00Z' }, message,
      { role: 'assistant', content: '완료', ts: '2026-11-15T00:00:01Z' }],
    messageBlocks: [{ block: detail, level: 0, afterMessageIndex: 0 }],
    columns: 80, rows: 16, header: [], footer: [], promptLine: '❯ ', notices: [], activity: [], scroll: 0,
    expandedToolIndexes: new Set(),
  });
  return frame.lines.join('\n');
}

test('one live tool appears once when its saved trace and expandable block share run and call IDs', () => {
  const shown = screen(result);
  expect(shown).toContain('▸ 도구 · Read 결과');
  expect(shown).not.toContain('도구: Read');
  expect(shown).not.toContain('visible file result');
  expect(shown).not.toContain('private-key.pem');
});

test('same call ID in another run keeps its saved result visible', () => {
  const shown = screen({ ...result, surfaceRunId: 'run-2' });
  expect(shown).toContain('도구: Read');
  expect(shown).toContain('visible file result');
  expect(shown).toContain('▸ 도구 · Read 결과');
});

test('a detail block without verified raw reference leaves the saved result visible', () => {
  const shown = screen(result, { ...block, detail: { level: 1, summary: 'Read 결과' } });
  expect(shown).toContain('도구: Read');
});
