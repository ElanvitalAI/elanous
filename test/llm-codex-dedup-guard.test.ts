// Codex-family guards — fix L (same-args dedup) + fix T (maxTurns cap).
// 2026-04-25.
// Reference: log/debug-20260425155205 — codex/gpt-5.4 issued
// Read({file_path:"내부 문서 `_index`", offset:1, limit:2200|2500}) 6× in
// one turn-loop instead of synthesizing from prior tool_results.
// Claude Opus naturally rotated files (verified 2026-04-25T06:56);
// codex did not. Guard activates only for modelFamily === 'codex'.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  familyMaxTurnsKey,
  streamLLMWithTools,
  TOOL_LOOP_MAX_TURNS_CODEX,
  TOOL_LOOP_MAX_TURNS_DEFAULT,
} from '../src/llm';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';
import { __resetSnapshotStore, __resetTurnState } from '../src/undo-turn/index.js';
import { resetPlanModeState } from '../src/plan-mode/index.js';
import { setUserConfigOverlay } from '../src/user-config.js';
import { loadProjectAnchorWithMeta, setGlobalAnchorPathForTest } from '../src/prompt-library/universal-preamble.js';

afterEach(() => {
  __resetSnapshotStore();
  __resetTurnState();
  resetPlanModeState();
  setUserConfigOverlay(null);
  setGlobalAnchorPathForTest(undefined);
});

function installFamilyCapsForLoopTest(): void {
  setUserConfigOverlay((cfg) => ({
    ...cfg,
    llm: {
      ...cfg.llm,
      maxTurns: {
        codex: TOOL_LOOP_MAX_TURNS_CODEX,
        default: TOOL_LOOP_MAX_TURNS_DEFAULT,
      },
    },
  }));
}

function scriptedProvider(turns: LLMStreamEvent[][], onCall?: () => void): LLMProvider {
  let call = 0;
  return {
    name: 'scripted',
    defaultModel: 'd',
    available: () => true,
    async *streamChat() {
      onCall?.();
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat() {},
  };
}

describe('streamLLMWithTools — codex-family same-args dedup (fix L)', () => {
  // NOTE on test design: elanous's exploration-synthesis phase fires when
  // 4 consecutive turns issue only EXPLORATORY_TOOLS (Read, Grep, Glob,
  // ListDir, Lsp, …). Beyond that point the loop rejects pending calls
  // wholesale with a phase-rejection stub — independent of the dedup
  // guard. To isolate dedup behavior, every test below interleaves a
  // non-exploratory tool (Bash) so the streak resets between Read calls
  // and dedup is the only gate that fires.

  test('codex: 3rd identical call is blocked with RE-CALL stub, prior dispatches succeed', async () => {
    const sameRead = { file_path: '/tmp/a.ts', offset: 1, limit: 2200 };
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const dispatchedResults: string[] = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: sameRead }],
      [{ type: 'tool_call', id: 'reset1', name: 'Bash', args: { command: 'echo 1' } }],
      [{ type: 'tool_call', id: 'b', name: 'Read', args: sameRead }],
      [{ type: 'tool_call', id: 'reset2', name: 'Bash', args: { command: 'echo 2' } }],
      [{ type: 'tool_call', id: 'c', name: 'Read', args: sameRead }],  // ← 3rd → blocked
      [{ type: 'text', delta: 'final answer' }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { dispatchedResults.push(typeof r.result === 'string' ? r.result : JSON.stringify(r.result)); },
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'real-result';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 8,
      },
    );
    // Reads #1 + #2 + 2 Bash dispatch = 4 real dispatches. Read #3 blocked.
    expect(dispatchedCalls.length).toBe(4);
    const stubMatches = dispatchedResults.filter((s) => s.includes('RE-CALL BLOCKED'));
    expect(stubMatches.length).toBe(1);
    expect(stubMatches[0]!).toContain('Read({"file_path":"/tmp/a.ts"');
    expect(stubMatches[0]!).toContain('FINAL ANSWER');
  });

  test('codex: same args in different key order collapse to the same signature', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const dispatchedResults: string[] = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: '/tmp/x.ts', offset: 1, limit: 100 } }],
      [{ type: 'tool_call', id: 'reset1', name: 'Bash', args: { command: 'echo 1' } }],
      [{ type: 'tool_call', id: 'b', name: 'Read', args: { limit: 100, offset: 1, file_path: '/tmp/x.ts' } }],
      [{ type: 'tool_call', id: 'reset2', name: 'Bash', args: { command: 'echo 2' } }],
      [{ type: 'tool_call', id: 'c', name: 'Read', args: { offset: 1, file_path: '/tmp/x.ts', limit: 100 } }],
      [{ type: 'text', delta: 'done' }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { dispatchedResults.push(typeof r.result === 'string' ? r.result : JSON.stringify(r.result)); },
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'real-result';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 8,
      },
    );
    // Reads #1 + #2 + 2 Bash = 4 dispatches. Read #3 (different key
    // order, same logical args) blocked.
    expect(dispatchedCalls.length).toBe(4);
    const stubMatches = dispatchedResults.filter((s) => s.includes('RE-CALL BLOCKED'));
    expect(stubMatches.length).toBe(1);
  });

  test('codex: different args (offset varied) bypass the dedup guard', async () => {
    // Bash (non-exploratory) interleaves reset the exploration streak,
    // so the loop can run 4 Read calls + 1 Bash without hitting the
    // exploration-synthesis phase. The guard would only block if
    // signatures matched — varying offset prevents that.
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: '/tmp/x.ts', offset: 1, limit: 100 } }],
      [{ type: 'tool_call', id: 'reset1', name: 'Bash', args: { command: 'echo 1' } }],
      [{ type: 'tool_call', id: 'b', name: 'Read', args: { file_path: '/tmp/x.ts', offset: 100, limit: 100 } }],
      [{ type: 'tool_call', id: 'reset2', name: 'Bash', args: { command: 'echo 2' } }],
      [{ type: 'tool_call', id: 'c', name: 'Read', args: { file_path: '/tmp/x.ts', offset: 200, limit: 100 } }],
      [{ type: 'text', delta: 'done' }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'real-result';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 8,
      },
    );
    // All 5 different signatures dispatched.
    expect(dispatchedCalls.length).toBe(5);
  });

  test('claude family bypasses the guard — 5 identical calls all dispatch', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const dupRead = (id: string): LLMStreamEvent[] => [
      { type: 'tool_call', id, name: 'Read', args: { file_path: '/tmp/a.ts', offset: 1, limit: 2200 } },
    ];
    const provider = scriptedProvider([
      dupRead('a'),
      dupRead('b'),
      dupRead('c'),
      dupRead('d'),
      dupRead('e'),
      [{ type: 'text', delta: 'final' }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'real-result';
        },
      },
      {
        provider,
        model: 'claude-opus-4-6',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 8,
      },
    );
    // claude path is unaffected — guard only fires for codex family.
    // Note: maxTurns governs the loop, and exploration synthesis may
    // hard-stop earlier than 5; we just assert the guard didn't block.
    expect(dispatchedCalls.length).toBeGreaterThanOrEqual(3);
  });

  test('codex: dedup signature is per-tool — same args but different tool name pass independently', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: '/tmp/x.ts' } }],
      [{ type: 'tool_call', id: 'reset1', name: 'Bash', args: { command: 'echo 1' } }],
      [{ type: 'tool_call', id: 'b', name: 'Read', args: { file_path: '/tmp/x.ts' } }],
      [{ type: 'tool_call', id: 'reset2', name: 'Bash', args: { command: 'echo 2' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { file_path: '/tmp/x.ts' } }],
      [{ type: 'tool_call', id: 'reset3', name: 'Bash', args: { command: 'echo 3' } }],
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { file_path: '/tmp/x.ts' } }],
      [{ type: 'text', delta: 'done' }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'real-result';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );
    // 7 dispatches (2 Read + 2 Grep + 3 Bash). Read#1, Read#2, Grep#1,
    // Grep#2 each within their per-tool count of 2 → no dedup fired.
    expect(dispatchedCalls.length).toBe(7);
  });
});

describe('streamLLMWithTools — codex-family maxTurns cap (fix T → P0 2026-05-03)', () => {
  // Classification: ㉠ `codex owns the larger named cap…` is the family-cap
  // contract; it must prove the unconfigured loop's family selection.
  test('codex owns the larger named cap while residual families use the default cell (P0 2026-05-03)', () => {
    expect(familyMaxTurnsKey('codex')).toBe('codex');
    expect(familyMaxTurnsKey('local')).toBe('default');
    expect(familyMaxTurnsKey('gpt')).toBe('default');
    expect(TOOL_LOOP_MAX_TURNS_CODEX).toBeGreaterThan(TOOL_LOOP_MAX_TURNS_DEFAULT);
  });

  // Classification: ㉠ the codex loop scenario verifies the no-opts.maxTurns
  // path; the config seam supplies distinct named cells without bypassing it.
  test('unconfigured codex loop applies its named cap before dispatching tools', async () => {
    installFamilyCapsForLoopTest();
    const familyCap = TOOL_LOOP_MAX_TURNS_CODEX;
    const scriptedTurns = Array.from({ length: familyCap + 1 }, (_, index): LLMStreamEvent[] => [
      { type: 'tool_call', id: `turn-${index}`, name: 'Bash', args: { command: `echo ${index}` } },
    ]);
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let providerCalls = 0;
    const provider = scriptedProvider(scriptedTurns, () => { providerCalls += 1; });
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Bash', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(providerCalls).toBe(familyCap);
    expect(dispatchedCalls).toHaveLength(familyCap - 2);
  });

  // Classification: ㉠ the residual scenario verifies the same no-opts.maxTurns
  // execution path selects the default cell, not the codex cell.
  test('unconfigured residual-family loop applies the default cap before dispatching tools', async () => {
    installFamilyCapsForLoopTest();
    const familyCap = TOOL_LOOP_MAX_TURNS_DEFAULT;
    const scriptedTurns = Array.from({ length: familyCap + 1 }, (_, index): LLMStreamEvent[] => [
      { type: 'tool_call', id: `turn-${index}`, name: 'Bash', args: { command: `echo ${index}` } },
    ]);
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let providerCalls = 0;
    const provider = scriptedProvider(scriptedTurns, () => { providerCalls += 1; });
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-4.1',
        tools: [{ name: 'Bash', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(providerCalls).toBe(familyCap);
    expect(dispatchedCalls).toHaveLength(familyCap);
  });

  // Classification: ㉡ `claude family is not affected by the codex cap` preserves
  // the original intent: “Pure exploratory turns remain governed by the synthesis
  // guard, independent of the codex family cap.”
  test('claude family is not affected by the codex cap', async () => {
    const exploratoryTurn = (id: string): LLMStreamEvent[] => [
      { type: 'tool_call', id, name: 'Read', args: { file_path: `/tmp/${id}.ts` } },
    ];
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = scriptedProvider([
      exploratoryTurn('a'),
      exploratoryTurn('b'),
      exploratoryTurn('c'),
      exploratoryTurn('d'),
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'claude-opus-4-6',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
        maxTurns: TOOL_LOOP_MAX_TURNS_DEFAULT,
      },
    );
    expect(dispatchedCalls).toHaveLength(Math.min(4, TOOL_LOOP_MAX_TURNS_DEFAULT));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// W4-anchor (2026-05-03 PM) — Anchor file Grep blocking. AGENTS.md /
// CLAUDE.md content is already in the system prompt as project anchor;
// codex was observed re-greppling them across multiple turns. Block on
// the first attempt (no threshold) — anchor grep is structurally
// redundant.
// ─────────────────────────────────────────────────────────────────────────
describe('streamLLMWithTools — W4-anchor: Grep on AGENTS.md/CLAUDE.md blocked for codex', () => {
  test('codex Grep reports a complete anchor using its observed fence label', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', glob: 'AGENTS.md', output_mode: 'content' } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Repository guide (AGENTS.md) ===\ncomplete\n=== end AGENTS.md ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL_DISPATCH_HAPPENED',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(typeof toolResultText).toBe('string');
    expect(String(toolResultText)).toContain('ANCHOR GREP BLOCKED');
    expect(String(toolResultText)).toContain('full text of `AGENTS.md` is present');
    expect(String(toolResultText)).toContain('`Repository guide` anchor');
    expect(String(toolResultText)).not.toBe('ACTUAL_DISPATCH_HAPPENED');
  });

  test('codex Grep reports a truncated anchor prefix and unavailable remainder', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'rule', glob: 'AGENTS.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Project guide (AGENTS.md) ===\nprefix\n…[truncated to fit anchor budget]\n=== end AGENTS.md ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('Only a prefix of `AGENTS.md` is present');
    expect(String(toolResultText)).toContain('the remainder is unavailable');
    expect(String(toolResultText)).toContain('`Project guide` anchor');
  });

  test('codex Grep with glob=CLAUDE.md returns ANCHOR GREP BLOCKED stub', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'rule', glob: 'CLAUDE.md', output_mode: 'content' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('ANCHOR GREP BLOCKED');
    expect(String(toolResultText)).toContain('CLAUDE.md');
    expect(String(toolResultText)).toContain('is not present in the system prompt');
    expect(String(toolResultText)).not.toContain('ALREADY rendered verbatim');
  });

  test('codex Grep treats a malformed anchor fence as absent', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'rule', glob: 'CLAUDE.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Malformed guide (CLAUDE.md) ===\ncontent without a closing fence' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('`CLAUDE.md` is not present in the system prompt');
  });

  test('codex Grep with brace-glob {AGENTS.md,CLAUDE.md} also blocked', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'foo', glob: '{AGENTS,CLAUDE}.md', output_mode: 'content' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('ANCHOR GREP BLOCKED');
  });

  test('claude family is NOT subject to anchor grep blocking', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', glob: 'AGENTS.md', output_mode: 'content' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'CLAUDE_DISPATCH_OK',
      },
      {
        provider,
        model: 'claude-opus-4-6',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toBe('CLAUDE_DISPATCH_OK');
  });

  test('codex Grep on a NON-anchor file is dispatched normally', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'foo', glob: 'src/llm.ts', output_mode: 'content' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'NORMAL_DISPATCH',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toBe('NORMAL_DISPATCH');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// W5-A (2026-05-03 PM) — Literal-path Glob redirect. Codex was observed
// (log/debug-20260503123524) calling Glob({pattern: "src/debug-log.ts"})
// as a stat-style existence check before Read — pure waste since the
// pattern returns ≤1 entry and Read on the same path is the next step.
// Block on first attempt with a redirect stub steering to Read.
// ─────────────────────────────────────────────────────────────────────────
describe('streamLLMWithTools — W5-A: literal-path Glob blocked for codex', () => {
  test('codex Glob with literal file path returns LITERAL-PATH GLOB BLOCKED stub', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Glob', args: { pattern: 'src/debug-log.ts', path: '.' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL_DISPATCH_HAPPENED',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Glob', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(typeof toolResultText).toBe('string');
    expect(String(toolResultText)).toContain('LITERAL-PATH GLOB BLOCKED');
    expect(String(toolResultText)).toContain('Read({file_path: "src/debug-log.ts"})');
    expect(String(toolResultText)).not.toBe('ACTUAL_DISPATCH_HAPPENED');
  });

  test('codex Glob with deep literal path also blocked', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Glob', args: { pattern: 'docs/manual/MANUAL-debug-principles-2026-04-30.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Glob', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('LITERAL-PATH GLOB BLOCKED');
  });

  test('codex Glob with wildcard pattern is dispatched normally', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Glob', args: { pattern: 'src/**/*.ts' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'WILDCARD_DISPATCH',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Glob', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toBe('WILDCARD_DISPATCH');
  });

  test('codex Glob with brace pattern is dispatched normally', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Glob', args: { pattern: '{AGENTS,CLAUDE}.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'BRACE_DISPATCH',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Glob', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toBe('BRACE_DISPATCH');
  });

  test('claude family is NOT subject to literal-path Glob blocking', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Glob', args: { pattern: 'src/debug-log.ts' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'CLAUDE_DISPATCH_OK',
      },
      {
        provider,
        model: 'claude-opus-4-6',
        tools: [{ name: 'Glob', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toBe('CLAUDE_DISPATCH_OK');
  });

  test('codex Glob with empty pattern is dispatched (no false positive)', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Glob', args: { pattern: '', path: 'src' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'EMPTY_PATTERN_OK',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Glob', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toBe('EMPTY_PATTERN_OK');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// W4-A (2026-05-03 PM) — Post-Read broad search blocking. After 3+
// Reads have been dispatched, codex's "go back to broad search" pattern
// is regression behavior. Force narrow code-intel followup, specific
// Read, or text synthesis. Reproducer: log/wave5-w5e/debug.jsonl —
// 12 Greps + 6 Reads with `**/debug*` family rotated.
// ─────────────────────────────────────────────────────────────────────────
describe('streamLLMWithTools — W4-A: post-Read broad search blocked for codex', () => {
  test('codex broad Glob (with **) after 3 Reads is blocked with POST-READ stub', async () => {
    const stubs: string[] = [];
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'r1', name: 'Read', args: { file_path: '/tmp/a.ts' } }],
      [{ type: 'tool_call', id: 'b1', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r2', name: 'Read', args: { file_path: '/tmp/b.ts' } }],
      [{ type: 'tool_call', id: 'b2', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r3', name: 'Read', args: { file_path: '/tmp/c.ts' } }],
      [{ type: 'tool_call', id: 'b3', name: 'Bash', args: { command: 'echo' } }],
      // ↓ Broad Glob — should be blocked (Read count = 3)
      [{ type: 'tool_call', id: 'g1', name: 'Glob', args: { pattern: 'src/**/*.ts' } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => {
          if (typeof r.result === 'string' && r.result.includes('POST-READ BROAD SEARCH BLOCKED')) {
            stubs.push(r.result);
          }
        },
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Glob', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );
    // 3 Reads + 3 Bash interleaves dispatched; Glob blocked
    expect(dispatchedCalls.length).toBe(6);
    expect(stubs.length).toBeGreaterThanOrEqual(1);
    expect(stubs[0]).toContain('inspected 3 file(s)');
  });

  test('codex narrow Glob (no **) after 3 Reads is NOT blocked', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'r1', name: 'Read', args: { file_path: '/tmp/a.ts' } }],
      [{ type: 'tool_call', id: 'b1', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r2', name: 'Read', args: { file_path: '/tmp/b.ts' } }],
      [{ type: 'tool_call', id: 'b2', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r3', name: 'Read', args: { file_path: '/tmp/c.ts' } }],
      [{ type: 'tool_call', id: 'b3', name: 'Bash', args: { command: 'echo' } }],
      // ↓ Narrow Glob (no `**`) — should pass
      [{ type: 'tool_call', id: 'g1', name: 'Glob', args: { pattern: 'src/*.ts' } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Glob', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );
    // 3 Reads + 3 Bash + 1 Glob = 7 dispatched (narrow Glob passes)
    expect(dispatchedCalls.length).toBe(7);
  });

  test('codex broad Grep (no path/glob) after 3 Reads is blocked', async () => {
    const stubs: string[] = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'r1', name: 'Read', args: { file_path: '/tmp/a.ts' } }],
      [{ type: 'tool_call', id: 'b1', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r2', name: 'Read', args: { file_path: '/tmp/b.ts' } }],
      [{ type: 'tool_call', id: 'b2', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r3', name: 'Read', args: { file_path: '/tmp/c.ts' } }],
      [{ type: 'tool_call', id: 'b3', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'gr1', name: 'Grep', args: { pattern: 'foo' } }],  // no path
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => {
          if (typeof r.result === 'string' && r.result.includes('POST-READ BROAD SEARCH BLOCKED')) {
            stubs.push(r.result);
          }
        },
        dispatchTool: async () => 'r',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );
    expect(stubs.length).toBeGreaterThanOrEqual(1);
  });

  test('codex narrow Grep (path: src/foo.ts) after 3 Reads is NOT blocked', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'r1', name: 'Read', args: { file_path: '/tmp/a.ts' } }],
      [{ type: 'tool_call', id: 'b1', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r2', name: 'Read', args: { file_path: '/tmp/b.ts' } }],
      [{ type: 'tool_call', id: 'b2', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r3', name: 'Read', args: { file_path: '/tmp/c.ts' } }],
      [{ type: 'tool_call', id: 'b3', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'gr1', name: 'Grep', args: { pattern: 'foo', path: 'src/llm.ts' } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );
    expect(dispatchedCalls.length).toBe(7);
  });

  test('codex broad Glob after 2 Reads is NOT blocked (threshold is 3)', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'r1', name: 'Read', args: { file_path: '/tmp/a.ts' } }],
      [{ type: 'tool_call', id: 'b1', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r2', name: 'Read', args: { file_path: '/tmp/b.ts' } }],
      [{ type: 'tool_call', id: 'b2', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'g1', name: 'Glob', args: { pattern: 'src/**/*.ts' } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Glob', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 8,
      },
    );
    // 2 Reads + 2 Bash + 1 Glob = 5 dispatched
    expect(dispatchedCalls.length).toBe(5);
  });

  test('claude family is NOT subject to W4-A blocking', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'r1', name: 'Read', args: { file_path: '/tmp/a.ts' } }],
      [{ type: 'tool_call', id: 'b1', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r2', name: 'Read', args: { file_path: '/tmp/b.ts' } }],
      [{ type: 'tool_call', id: 'b2', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'r3', name: 'Read', args: { file_path: '/tmp/c.ts' } }],
      [{ type: 'tool_call', id: 'b3', name: 'Bash', args: { command: 'echo' } }],
      [{ type: 'tool_call', id: 'g1', name: 'Glob', args: { pattern: 'src/**/*.ts' } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'claude-opus-4-6',
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Glob', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );
    // All 7 dispatched (claude bypasses W4-A)
    expect(dispatchedCalls.length).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// W5-D (2026-05-03 PM) — Anchor file Read redirect. Companion to W4-
// anchor (Grep). After Grep was blocked, codex pivoted to Read on
// AGENTS.md / CLAUDE.md (5× each across 5 turns before generic dedup
// caught the 3rd). The anchor is already rendered verbatim in the
// system prompt; on-disk Read is pure waste.
// ─────────────────────────────────────────────────────────────────────────
describe('streamLLMWithTools — W5-D: Read on AGENTS.md/CLAUDE.md blocked for codex', () => {
  test('codex Read on a fenced root AGENTS.md returns ANCHOR READ BLOCKED stub', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'AGENTS.md', offset: 1, limit: 2600 } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Root guide (AGENTS.md) ===\ncomplete\n=== end AGENTS.md ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL_DISPATCH_HAPPENED',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('ANCHOR READ BLOCKED');
    expect(String(toolResultText)).toContain('AGENTS.md');
    expect(String(toolResultText)).not.toBe('ACTUAL_DISPATCH_HAPPENED');
  });

  test('codex Read reports a complete anchor using its observed fence label', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'AGENTS.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Root guide (AGENTS.md) ===\ncomplete\n=== end AGENTS.md ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('full text of `AGENTS.md` is present');
    expect(String(toolResultText)).toContain('`Root guide` anchor');
  });

  test('codex Read on a CLAUDE.md omitted from the prompt dispatches', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'CLAUDE.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'X',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toBe('X');
  });

  test('codex Read reports a truncated anchor prefix and unavailable remainder', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'AGENTS.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Root guide (AGENTS.md) ===\nprefix\n…[truncated to fit anchor budget]\n=== end AGENTS.md ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('Only a prefix of `AGENTS.md` is present');
    expect(String(toolResultText)).toContain('the remainder is unavailable');
    expect(String(toolResultText)).toContain('`Root guide` anchor');
  });

  test('codex Read on an unfenced subdir/AGENTS.md dispatches despite the root fence', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'subproject/AGENTS.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Root guide (AGENTS.md) ===\ncomplete\n=== end AGENTS.md ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'X',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toBe('X');
  });

  test('codex Read on ./AGENTS.md resolves to the same fenced root path', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: './AGENTS.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Root guide (AGENTS.md) ===\ncomplete\n=== end AGENTS.md ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('ANCHOR READ BLOCKED');
    expect(String(toolResultText)).toContain('full text of `./AGENTS.md` is present');
    expect(String(toolResultText)).not.toContain('`./AGENTS.md` is not present');
  });

  test('codex Read on a fenced subdir/AGENTS.md names that path in its stub', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'release/public/AGENTS.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Subdirectory guide (release/public/AGENTS.md) ===\nsubguide\n=== end release/public/AGENTS.md ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('ANCHOR READ BLOCKED');
    expect(String(toolResultText)).toContain('full text of `release/public/AGENTS.md` is present');
    expect(String(toolResultText)).toContain('`Subdirectory guide` anchor');
  });

  test('same-named root and scoped fences match the requested path, not the first basename', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'subproject/AGENTS.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Root guide (AGENTS.md) ===\nroot\n=== end AGENTS.md ===\n=== Scoped guide (AGENTS.md @ subproject) ===\nsubguide\n=== end AGENTS.md @ subproject ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('ANCHOR READ BLOCKED');
    expect(String(toolResultText)).toContain('full text of `subproject/AGENTS.md`');
    expect(String(toolResultText)).toContain('`Scoped guide` anchor');
    expect(String(toolResultText)).not.toContain('`Root guide` anchor');
  });

  test('a truncated scoped fence is reported instead of the complete same-named root fence', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'subproject/AGENTS.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Root guide (AGENTS.md) ===\ncomplete\n=== end AGENTS.md ===\n=== Scoped guide (AGENTS.md @ subproject) ===\nprefix\n…[truncated to fit anchor budget]\n=== end AGENTS.md @ subproject ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('Only a prefix of `subproject/AGENTS.md` is present');
    expect(String(toolResultText)).toContain('`Scoped guide` anchor');
    expect(String(toolResultText)).not.toContain('`Root guide` anchor');
  });

  test('a scoped opening fence with a legacy scopeless closing fence is still recognized', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'subproject/AGENTS.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Scoped guide (AGENTS.md @ subproject) ===\nlegacy\n=== end AGENTS.md ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('ANCHOR READ BLOCKED');
    expect(String(toolResultText)).toContain('full text of `subproject/AGENTS.md`');
  });

  test('an absolute root path matches the same fence as a relative root path', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: `${process.cwd()}/AGENTS.md` } }],
      [],
    ]);
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== Root guide (AGENTS.md) ===\nroot\n=== end AGENTS.md ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toContain('ANCHOR READ BLOCKED');
    expect(String(toolResultText)).toContain(`full text of \`${process.cwd()}/AGENTS.md\``);
  });

  test('a global anchor fence only blocks the actual universe-root file', async () => {
    const globalPath = `${process.cwd()}/global/AGENTS.md`;
    setGlobalAnchorPathForTest(globalPath);
    let result: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: globalPath } }],
      [{ type: 'tool_call', id: 'b', name: 'Read', args: { file_path: 'AGENTS.md' } }],
      [],
    ]);
    const results: string[] = [];
    await streamLLMWithTools(
      [
        { role: 'system', content: '=== User-global instructions (AGENTS.md @ instance root) ===\nglobal\n=== end AGENTS.md @ instance root ===' },
        { role: 'user', content: 'q' },
      ],
      {
        onText: () => {},
        onToolResult: (r) => { result = r.result; results.push(String(result)); },
        dispatchTool: async () => 'ACTUAL',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(results[0]).toContain('ANCHOR READ BLOCKED');
    expect(results[0]).toContain(`full text of \`${globalPath}\``);
    expect(results[1]).toBe('ACTUAL');
  });

  test('the real anchor builder fence blocks its scoped path but not a same-named sibling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-anchor-read-'));
    const priorCwd = process.cwd();
    try {
      mkdirSync(join(root, '.git'));
      const scoped = join(root, 'subproject');
      mkdirSync(scoped);
      writeFileSync(join(root, 'AGENTS.md'), 'root guide');
      writeFileSync(join(scoped, 'AGENTS.md'), 'scoped guide');
      setGlobalAnchorPathForTest(null);
      process.chdir(scoped);
      const built = loadProjectAnchorWithMeta(scoped);
      expect(built.content).toContain('AGENTS.md @ ..');
      expect(built.content).toContain('=== end AGENTS.md ===');
      const results: string[] = [];
      const provider = scriptedProvider([
        [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: join(root, 'AGENTS.md') } }],
        [{ type: 'tool_call', id: 'b', name: 'Read', args: { file_path: join(scoped, 'AGENTS.md') } }],
        [{ type: 'tool_call', id: 'c', name: 'Read', args: { file_path: join(root, 'other', 'AGENTS.md') } }],
        [],
      ]);
      await streamLLMWithTools(
        [{ role: 'system', content: built.content! }, { role: 'user', content: 'q' }],
        {
          onText: () => {},
          onToolResult: (r) => { results.push(String(r.result)); },
          dispatchTool: async () => 'ACTUAL',
        },
        {
          provider,
          model: 'gpt-5.4',
          tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
        },
      );
      expect(results[0]).toContain('ANCHOR READ BLOCKED');
      expect(results[1]).toContain('ANCHOR READ BLOCKED');
      expect(results[1]).toContain(`full text of \`${join(scoped, 'AGENTS.md')}\` is present`);
      expect(results[2]).toBe('ACTUAL');
    } finally {
      process.chdir(priorCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('codex Read on AGENTS-helper.md (NOT exact basename) is NOT blocked', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'docs/AGENTS-helper.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'NOT_ANCHOR',
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toBe('NOT_ANCHOR');
  });

  test('claude family is NOT subject to anchor Read blocking', async () => {
    let toolResultText: unknown = null;
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: 'AGENTS.md' } }],
      [],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => { toolResultText = r.result; },
        dispatchTool: async () => 'CLAUDE_DISPATCH_OK',
      },
      {
        provider,
        model: 'claude-opus-4-6',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );
    expect(String(toolResultText)).toBe('CLAUDE_DISPATCH_OK');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// W3-A extension (2026-05-03 PM) — broad-spot dedup now also tracks
// `output_mode: 'content'` (threshold 5, vs 4 for files_with_matches).
// Catches codex bypassing the original W3-A by setting content mode.
// ─────────────────────────────────────────────────────────────────────────
describe('streamLLMWithTools — W3-A extension: content-mode broad-spot dedup', () => {
  test('5th content-mode Grep against same {path, glob} is blocked (threshold 5)', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const stubs: string[] = [];
    // Bash interleaves break the exploratory streak so exploration
    // synthesis doesn't pre-empt the broad-spot check (threshold 5
    // for content mode — gives 4 grace passes, 5th blocked).
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'foo', path: 'src', glob: '**/*.ts', output_mode: 'content' } }],
      [{ type: 'tool_call', id: 'r1', name: 'Bash', args: { command: 'echo 1' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'bar', path: 'src', glob: '**/*.ts', output_mode: 'content' } }],
      [{ type: 'tool_call', id: 'r2', name: 'Bash', args: { command: 'echo 2' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'baz', path: 'src', glob: '**/*.ts', output_mode: 'content' } }],
      [{ type: 'tool_call', id: 'r3', name: 'Bash', args: { command: 'echo 3' } }],
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { pattern: 'qux', path: 'src', glob: '**/*.ts', output_mode: 'content' } }],
      [{ type: 'tool_call', id: 'r4', name: 'Bash', args: { command: 'echo 4' } }],
      [{ type: 'tool_call', id: 'e', name: 'Grep', args: { pattern: 'quux', path: 'src', glob: '**/*.ts', output_mode: 'content' } }],
      // ↑ 5th same-spot content grep → broad-spot blocked
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => {
          if (typeof r.result === 'string' && r.result.includes('BROAD-SPOT REPEAT BLOCKED')) {
            stubs.push(r.result);
          }
        },
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        // maxTurns=9 keeps below BUDGET_WARNING_MIN_TURNS=10 so the
        // final-synthesis-phase rejection at turn N-2 doesn't pre-empt
        // our broad-spot check.
        maxTurns: 9,
      },
    );
    // 4 Greps + 4 Bash = 8 real dispatches. 5th Grep (turn 8) blocked.
    expect(dispatchedCalls.length).toBe(8);
    expect(stubs.length).toBeGreaterThanOrEqual(1);
    expect(stubs[0]).toContain('output_mode: content');
  });

  test('4th files_with_matches Grep against same {path, glob} is blocked (threshold 4)', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const stubs: string[] = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'foo', path: 'src', glob: '**/*.ts', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'r1', name: 'Bash', args: { command: 'echo 1' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'bar', path: 'src', glob: '**/*.ts', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'r2', name: 'Bash', args: { command: 'echo 2' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'baz', path: 'src', glob: '**/*.ts', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'r3', name: 'Bash', args: { command: 'echo 3' } }],
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { pattern: 'qux', path: 'src', glob: '**/*.ts', output_mode: 'files_with_matches' } }],
      // ↑ 4th → blocked (threshold 4)
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => {
          if (typeof r.result === 'string' && r.result.includes('BROAD-SPOT REPEAT BLOCKED')) {
            stubs.push(r.result);
          }
        },
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );
    // 3 Greps + 3 Bash = 6 real dispatches. 4th Grep blocked.
    expect(dispatchedCalls.length).toBe(6);
    expect(stubs.length).toBeGreaterThanOrEqual(1);
    expect(stubs[0]).toContain('output_mode: files_with_matches');
  });

  test('content-mode and files_with_matches counters are independent (different keys)', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    // 3 content + 3 files_with_matches against same {path, glob}. Each
    // mode's counter independently goes to 3 (content under threshold
    // 5, files_with_matches under threshold 4) → all 6 should dispatch.
    // Bash interleaves break the exploratory streak.
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'foo', path: 'src', glob: '**/*.ts', output_mode: 'content' } }],
      [{ type: 'tool_call', id: 'r1', name: 'Bash', args: { command: 'echo 1' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'bar', path: 'src', glob: '**/*.ts', output_mode: 'content' } }],
      [{ type: 'tool_call', id: 'r2', name: 'Bash', args: { command: 'echo 2' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'baz', path: 'src', glob: '**/*.ts', output_mode: 'content' } }],
      [{ type: 'tool_call', id: 'r3', name: 'Bash', args: { command: 'echo 3' } }],
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { pattern: 'qux', path: 'src', glob: '**/*.ts', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'r4', name: 'Bash', args: { command: 'echo 4' } }],
      [{ type: 'tool_call', id: 'e', name: 'Grep', args: { pattern: 'quux', path: 'src', glob: '**/*.ts', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'r5', name: 'Bash', args: { command: 'echo 5' } }],
      [{ type: 'tool_call', id: 'f', name: 'Grep', args: { pattern: 'corge', path: 'src', glob: '**/*.ts', output_mode: 'files_with_matches' } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 14,
      },
    );
    // 6 Grep + 5 Bash = 11 dispatches. Content counter reaches 3
    // (< threshold 5), files_with_matches reaches 3 (< threshold 4),
    // neither blocked.
    expect(dispatchedCalls.length).toBe(11);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// W3-A-glob (2026-05-03 PM) — Glob broad-spot dedup. Glob is
// deterministic over the filesystem (same args ⇒ same result), so the
// threshold is 2 (block on the 2nd identical wildcard call). Catches
// codex's wildcard-Glob storm pattern (log/debug-20260503123524: same
// `src/debug*.ts` glob across 2+ turns). Literal-path Globs are caught
// earlier by W5-A's literalGlobPath redirect, so these tests use
// wildcard patterns.
// ─────────────────────────────────────────────────────────────────────────
describe('streamLLMWithTools — W3-A-glob: Glob broad-spot dedup (threshold 2)', () => {
  test('2nd identical wildcard Glob is blocked with BROAD-SPOT REPEAT BLOCKED', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const stubs: string[] = [];
    // Bash interleaves break the exploratory streak so synthesis-phase
    // doesn't pre-empt the broad-spot check.
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Glob', args: { pattern: 'src/**/*.ts', path: '.' } }],
      [{ type: 'tool_call', id: 'r1', name: 'Bash', args: { command: 'echo 1' } }],
      [{ type: 'tool_call', id: 'b', name: 'Glob', args: { pattern: 'src/**/*.ts', path: '.' } }],
      // ↑ 2nd identical wildcard glob → broad-spot blocked
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        onToolResult: (r) => {
          if (typeof r.result === 'string' && r.result.includes('BROAD-SPOT REPEAT BLOCKED')) {
            stubs.push(r.result);
          }
        },
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Glob', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 6,
      },
    );
    // 1 Glob + 1 Bash = 2 real dispatches. 2nd Glob blocked.
    expect(dispatchedCalls.length).toBe(2);
    expect(stubs.length).toBeGreaterThanOrEqual(1);
    expect(stubs[0]).toContain('Glob');
    expect(stubs[0]).toContain('deterministic');
  });

  test('different wildcard patterns are NOT blocked (different keys)', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Glob', args: { pattern: 'src/**/*.ts', path: '.' } }],
      [{ type: 'tool_call', id: 'r1', name: 'Bash', args: { command: 'echo 1' } }],
      [{ type: 'tool_call', id: 'b', name: 'Glob', args: { pattern: 'test/**/*.ts', path: '.' } }],
      [{ type: 'tool_call', id: 'r2', name: 'Bash', args: { command: 'echo 2' } }],
      [{ type: 'tool_call', id: 'c', name: 'Glob', args: { pattern: 'docs/**/*.md', path: '.' } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Glob', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 8,
      },
    );
    // 3 Glob + 2 Bash = 5 dispatches. All 3 globs have unique keys.
    expect(dispatchedCalls.length).toBe(5);
  });

  test('claude family is NOT subject to Glob broad-spot blocking', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Glob', args: { pattern: 'src/**/*.ts', path: '.' } }],
      [{ type: 'tool_call', id: 'r1', name: 'Bash', args: { command: 'echo 1' } }],
      [{ type: 'tool_call', id: 'b', name: 'Glob', args: { pattern: 'src/**/*.ts', path: '.' } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'claude-opus-4-6',
        tools: [
          { name: 'Glob', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 6,
      },
    );
    // Claude family bypasses broad-spot — both Globs dispatched.
    expect(dispatchedCalls.length).toBe(3);
  });

  test('Glob with empty pattern is not tracked (degenerate, skipped)', async () => {
    const dispatchedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Glob', args: { pattern: '', path: 'src' } }],
      [{ type: 'tool_call', id: 'r1', name: 'Bash', args: { command: 'echo 1' } }],
      [{ type: 'tool_call', id: 'b', name: 'Glob', args: { pattern: '', path: 'src' } }],
    ]);
    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name, args) => {
          dispatchedCalls.push({ name, args });
          return 'r';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Glob', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 6,
      },
    );
    // Both Globs dispatched (broad-spot skips empty patterns; same-args
    // dedup may catch it at threshold 3 but not at 2).
    expect(dispatchedCalls.length).toBe(3);
  });
});

// TUI-INITIATIVE-S ② (10-15 · seat-state/OPC/initiative-probe/DIAGNOSIS-1.md) — 운영 TUI 가
// gpt-6-sol(gpt 계열 · openai-codex 공급자)로 release_status 를 같은 인자·같은 오류({error})로 26회 돌렸다.
// L-2 차단이 codex 계열·탐색 도구만 봤고, {error} 결과는 doom 추적기의 isError 를 세우지 않았다.
describe('streamLLMWithTools — 같은 호출 · 같은 오류 반복 차단(gpt 계열 · 비탐색 도구)', () => {
  const ERR = 'topic 과 action 을 동시에 쓸 수 없습니다 — 둘 중 하나만';
  function namedProvider(name: string, turns: LLMStreamEvent[][]): LLMProvider {
    return { ...scriptedProvider(turns), name };
  }
  const sameCall = (id: string): LLMStreamEvent[] => [
    { type: 'tool_call', id, name: 'release_status', args: { topic: 'features', action: 'landed' } },
  ];
  async function runRepeat(model: string, providerName: string, calls: number, dispatchResult: (n: number) => unknown) {
    const dispatched: string[] = [];
    const results: string[] = [];
    const turns: LLMStreamEvent[][] = [];
    for (let i = 0; i < calls; i += 1) turns.push(sameCall(`c${i}`));
    turns.push([{ type: 'text', delta: 'final' }]);
    await streamLLMWithTools(
      [{ role: 'user', content: '오늘 착지 현황 정리해줘' }],
      {
        onText: () => {},
        onToolResult: (r) => { results.push(typeof r.result === 'string' ? r.result : JSON.stringify(r.result)); },
        dispatchTool: async (name) => { dispatched.push(name); return dispatchResult(dispatched.length); },
      },
      {
        provider: namedProvider(providerName, turns),
        model,
        tools: [{ name: 'release_status', description: 'd', parameters: { type: 'object' } }],
        maxTurns: calls + 2,
      },
    );
    return { dispatched, results };
  }

  test('gpt-6-sol on openai-codex: the 4th identical failing call is blocked with the RE-CALL stub', async () => {
    const { dispatched, results } = await runRepeat('gpt-6-sol', 'openai-codex', 6, () => ({ error: ERR }));
    expect(dispatched.length).toBe(3);
    const stubs = results.filter((s) => s.includes('RE-CALL BLOCKED'));
    expect(stubs.length).toBe(3);
    expect(stubs[0]!).toContain('release_status(');
    expect(stubs[0]!).toContain(ERR);
  });

  test('gpt family is blocked by family even on another provider name', async () => {
    const { dispatched } = await runRepeat('gpt-6-sol', 'scripted', 5, () => ({ error: ERR }));
    expect(dispatched.length).toBe(3);
  });

  test('a success in between resets the count — identical call that recovers is not blocked', async () => {
    const { dispatched, results } = await runRepeat('gpt-6-sol', 'openai-codex', 5, (n) => (n === 3 ? 'ok' : { error: ERR }));
    expect(dispatched.length).toBe(5);
    expect(results.some((s) => s.includes('RE-CALL BLOCKED'))).toBe(false);
  });

  test('a different error each time is not «the same error» — not blocked', async () => {
    const { dispatched } = await runRepeat('gpt-6-sol', 'openai-codex', 5, (n) => ({ error: `${ERR} #${n}` }));
    expect(dispatched.length).toBe(5);
  });

  test('claude family is unchanged — repeated failing calls keep dispatching', async () => {
    const { dispatched, results } = await runRepeat('claude-opus-4-6', 'scripted', 5, () => ({ error: ERR }));
    expect(dispatched.length).toBe(5);
    expect(results.some((s) => s.includes('RE-CALL BLOCKED'))).toBe(false);
  });
});
