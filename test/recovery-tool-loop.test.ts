import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendArchiveEntry } from '../src/compact/archive.js';
import { createRequestSizeGuard } from '../src/session/request-size-guard.js';
import { streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from '../src/llm.js';

describe('recovery through the actual tool loop', () => {
  test('declares host schema on first turn, pages session output, and signals failure', async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), 'recovery-loop-'));
    const content = 'session A output';
    const sha256 = createHash('sha256').update(content, 'utf16le').digest('hex');
    for (const [sessionId, text] of [['A', content], ['B', 'private B']] as const) {
      expect(appendArchiveEntry({ ts: 1, layer: 'tool-output-budget', sessionId, origin: { kind: 'tool_result', tool_use_id: 'same' }, content: text, replacement: 'stub' }, archiveDir)).toBe(true);
    }
    const guard = createRequestSizeGuard({ maxChars: 50000, compactOptions: () => ({ sessionId: 'A', archiveDir }) }); // 출처: #40760 fixture budget allows the scripted tool loop
    const seen: Array<{ tools: any[]; history: any }> = [];
    const turns: LLMStreamEvent[][] = [
      [{ type: 'tool_call', id: 'r1', name: 'restore_tool_output_chunk', args: { tool_use_id: 'same', sha256, offset: 0, limit: 7, sessionId: 'B' } }], // 출처: #40760 fixture reads the seven-character prefix session
      [{ type: 'tool_call', id: 'r2', name: 'restore_tool_output_chunk', args: { tool_use_id: 'same', sha256: '0'.repeat(64), offset: 0, limit: 7 } }], // 출처: #40760 fixture uses a valid-length absent SHA-256 selector
      [{ type: 'text', delta: 'done' }],
    ];
    let n = 0;
    const provider: LLMProvider = {
      name: 'scripted', defaultModel: 'd', available: () => true,
      async *streamChat(history, opts) {
        seen.push({ tools: structuredClone(opts?.tools ?? []), history: structuredClone(history) });
        for (const event of turns[n++] ?? []) yield event;
      },
      async *chat() {},
    };
    const fake = { name: 'restore_tool_output_chunk', description: 'incorrect', parameters: { type: 'object' } };
    let dispatches = 0;
    await streamLLMWithTools([{ role: 'user', content: 'recover' }], {
      onText: () => {}, dispatchTool: async () => { dispatches++; return 'wrong'; },
    }, { provider, model: 'd', tools: [fake], firstTurnTools: [fake], requestSizeGuard: guard, maxTurns: 5 }); // 출처: #40760 fixture needs three scripted turns with headroom
    expect(dispatches).toBe(0);
    for (const { tools } of seen) {
      const specs = tools.filter(t => t.name === fake.name);
      expect(specs).toHaveLength(1);
      expect(specs[0].parameters.required).toEqual(['tool_use_id', 'sha256', 'offset', 'limit']);
    }
    expect(JSON.stringify(seen[1].history)).toContain('session');
    expect(JSON.stringify(seen[1].history)).not.toContain('private B');
    const blocks = seen[2].history.flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
    const failed = blocks.find((b: any) => b.type === 'tool_result' && b.tool_use_id === 'r2');
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).toContain('not_found');
  });
});
