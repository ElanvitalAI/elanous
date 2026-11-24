// ELN-COMPACT-EVERY-TURN ② — synthetic 50-round OP tool loop, no LLM. Literal expectations.
import { expect, test } from 'bun:test';
import type { LLMMessage } from '../llm.js';
import { pruneOldToolResults, toolResultPlaceholder, type ToolResultPruneState } from './tool-result-prune.js';

const WINDOW_TOKENS = 100_000; // fixture budget: the codex 400K-char request cap at 4 chars/token, not a product constant
const ROUNDS = 50; // acceptance scenario: a 50-round seat turn
// an 8 KB result — the coordinator-seat capture cap (llm.ts toolResultInlineLimitBytes)
const msgList = Array.from({ length: 40 }, (_, i) => `#${138100 + i} REL → OP · preflight blocked raw line ${'x'.repeat(150)}`).join('\n');

function round(history: LLMMessage[], index: number): void {
  const id = `call_${index}`;
  history.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'RunShell', input: { command: ['eln', 'msg', 'list', '--to', 'OP'] } }] });
  history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: msgList }] });
}

test('placeholder is one informative line and a pure function of the call and its result', () => {
  expect(toolResultPlaceholder('RunShell', { command: ['eln', 'msg', 'list', '--to', 'OP'] }, msgList, false))
    .toBe('[tool RunShell] eln msg list --to OP → ok, 40 lines');
  expect(toolResultPlaceholder('Read', { file_path: '/tmp/a.ts' }, 'a\nb', true)).toBe('[tool Read] /tmp/a.ts → error, 2 lines');
});

test('50 rounds: few prunes, last 3 rounds verbatim, and the pruned prefix replays the same bytes every request', () => {
  const history: LLMMessage[] = [{ role: 'system', content: 'seat contract' }, { role: 'user', content: '[notice · seat-mail] digest' }];
  const state: ToolResultPruneState = {};
  let prunes = 0;
  let previousWire = '';
  let prefixRewrites = 0;
  for (let index = 0; index < ROUNDS; index++) {
    round(history, index);
    const outcome = pruneOldToolResults(history, { contextTokens: WINDOW_TOKENS }, state);
    if (outcome.fired) prunes++;
    const wire = JSON.stringify(history);
    // the bytes already sent stay a prefix of the next request unless a prune was committed (a cache boundary)
    if (previousWire && !wire.startsWith(previousWire.slice(0, -1))) prefixRewrites++;
    previousWire = wire;
  }
  expect(prunes).not.toBe(0);
  expect(prunes).toBeLessThanOrEqual(3); // 출처: OP 지시 11-24 수용 기준 «prune events ≤3»
  expect(prefixRewrites).toBe(prunes);
  const results = history.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === 'tool_result');
  expect(results.slice(-3).every((block) => block.type === 'tool_result' && block.content === msgList)).toBe(true);
  expect(results.slice(0, 10).every((block) => block.type === 'tool_result' && block.content === '[tool RunShell] eln msg list --to OP → ok, 40 lines')).toBe(true);
});

test('below half the window nothing changes; a prune that reclaims too little is not committed', () => {
  const small: LLMMessage[] = [{ role: 'user', content: 'go' }];
  for (let index = 0; index < 4; index++) round(small, index);
  const before = JSON.stringify(small);
  expect(pruneOldToolResults(small, { contextTokens: WINDOW_TOKENS }, {}).reason).toBe('under-trigger');
  expect(pruneOldToolResults(small, { contextTokens: 1_000 }, {}).reason).toBe('below-min-reclaim');
  expect(JSON.stringify(small)).toBe(before);
});
