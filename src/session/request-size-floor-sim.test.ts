/**
 * SIM — REQUEST-SIZE-FLOOR (CEO 11-27 · `eln fed snapshot --anomalies` on build 261127_0004: «TC-H-POOL-2 lost 3 turn(s) in
 * 60m — llm.request request-size-limit-blocked»). The requests were 401 499 · 402 821 · 402 080 chars against the 400 000
 * cap after compaction (no-op, or still over by ~2k) and each turn was thrown away. Seeds 1–5 build a Codex Responses input
 * 0.3–1 % over the cap from messages, function calls and tool outputs of mixed sizes. Expect: the floor gets under the cap
 * by stubbing as few tool outputs as it can (largest first) — never message text, never the last two items — and says what
 * it held back.
 */
import { describe, expect, test } from 'bun:test';
import { floorRequestInput, REQUEST_SIZE_MAX_CHARS } from './request-size-guard.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type Item = Record<string, unknown>;
const measure = (input: Item[]) => JSON.stringify({ model: 'gpt-6.1-terra', instructions: 'x'.repeat(20_000), input }).length;

function overCapInput(seed: number): Item[] {
  const r = rng(seed); const items: Item[] = [];
  let i = 0;
  while (measure(items) < REQUEST_SIZE_MAX_CHARS * (1.003 + r() * 0.007)) {
    const k = i % 3;
    if (k === 0) items.push({ role: 'user', content: [{ type: 'input_text', text: `turn ${i}\n${'u'.repeat(200 + Math.floor(r() * 3000))}` }] });
    else if (k === 1) items.push({ type: 'function_call', name: 'Bash', arguments: '{"command":"eln work next"}', call_id: `c${i}` });
    else items.push({ type: 'function_call_output', call_id: `c${i - 1}`, output: `result ${i}\n${'o'.repeat(500 + Math.floor(r() * 20_000))}` });
    i++;
  }
  items.push({ type: 'function_call', name: 'Read', arguments: '{}', call_id: 'last' }, { type: 'function_call_output', call_id: 'last', output: 'z'.repeat(30_000) });
  return items;
}

describe('SIM request-size floor — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: a request 0.3–1 % over the cap fits after the floor; the last two items stay whole`, () => {
      const input = overCapInput(seed);
      const before = measure(input);
      expect(before > REQUEST_SIZE_MAX_CHARS).toBe(true); // 출처: #40322 — tonight's requests were 401–403k vs the 400k cap
      const floor = floorRequestInput(input, measure, REQUEST_SIZE_MAX_CHARS)!;
      expect(floor).not.toBe(null);
      expect(floor.chars <= REQUEST_SIZE_MAX_CHARS).toBe(true);
      expect(floor.input.slice(-2)).toEqual(input.slice(-2));
      expect(floor.input.length).toBe(input.length); // nothing removed: tool calls keep their outputs (stubbed)
      const stubs = floor.input.filter(it => typeof it.output === 'string' && (it.output as string).startsWith('[tool output held back — over the request size cap · '));
      expect(stubs.length).toBe(floor.stubbed); // tool outputs go first; enough of them exist here
      // As few as possible: the largest outputs first — un-stubbing the smallest stubbed one would go back over the cap.
      const sizes = input.map((it, i) => ({ i, n: typeof it.output === 'string' ? (it.output as string).length : 0 }));
      const stubbedIdx = floor.input.map((it, i) => (it !== input[i] ? i : -1)).filter(i => i >= 0);
      const smallest = stubbedIdx.sort((a, b) => sizes[a]!.n - sizes[b]!.n)[0]!;
      const undo = floor.input.map((it, i) => (i === smallest ? input[i]! : it));
      expect(measure(undo) > REQUEST_SIZE_MAX_CHARS).toBe(true);
    });
  }
  test('only message text is big (no tool output to re-run) → null: message text is never stubbed, the caller fails closed', () => {
    const input: Item[] = [{ role: 'user', content: [{ type: 'input_text', text: 'small' }] }, { type: 'function_call_output', call_id: 'a', output: 'y'.repeat(500_000) }, { role: 'user', content: [{ type: 'input_text', text: 'now' }] }];
    expect(floorRequestInput(input, measure, REQUEST_SIZE_MAX_CHARS)).toBe(null);
  });
});
