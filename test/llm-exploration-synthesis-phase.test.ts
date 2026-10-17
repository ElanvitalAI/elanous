import { afterEach, describe, test, expect, spyOn } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_TOOL_DISCIPLINE,
  GROK_TOOL_DISCIPLINE,
  looksLikeDebuggingTask,
  looksLikeImplementationTask,
  looksLikeStructuralAnalysis,
  selectIntentClassificationMessages,
  streamLLMWithTools,
} from '../src/llm';
import type { LLMMessage, LLMProvider, LLMStreamEvent, ContentBlock } from '../src/llm';
import {
  __resetSnapshotStore,
  __resetTurnState,
  captureSnapshot,
  pushSnapshot,
} from '../src/undo-turn/index.js';
import {
  INACTIVE_PLAN_MODE_STATE,
  resetPlanModeState,
  setPlanModeState,
} from '../src/plan-mode/index.js';

function scriptedProvider(turns: LLMStreamEvent[][]): {
  provider: LLMProvider;
  capturedMessagesAt: (idx: number) => LLMMessage[] | undefined;
} {
  let call = 0;
  const captured: LLMMessage[][] = [];
  const p: LLMProvider = {
    name: 'scripted',
    defaultModel: 'd',
    available: () => true,
    async *streamChat(messages) {
      captured.push(messages.map(m => ({ ...m })));
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat() {},
  };
  return { provider: p, capturedMessagesAt: (idx) => captured[idx] };
}

function lastToolResult(messages: LLMMessage[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    const blocks = m.content as ContentBlock[];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]!;
      if (b.type === 'tool_result') return b.content;
    }
  }
  return null;
}

function splitFinalAnswerAndEvidence(result: string): { answer: string; evidence: string } {
  const separator = '\n\n변경 파일: ';
  const index = result.indexOf(separator);
  expect(index).toBeGreaterThanOrEqual(0);
  return {
    answer: result.slice(0, index),
    evidence: result.slice(index + 2),
  };
}

function expectVerificationEvidence(
  evidence: string,
  expected: { freshness: 'current' | 'stale'; history: string },
): void {
  expect(evidence).toContain('변경 파일: /tmp/debug-surface.ts');
  expect(evidence).not.toContain('/tmp/debug-surface.ts, /tmp/debug-surface.ts');
  expect(evidence).toContain(expected.freshness === 'current' ? '검증 명령: bun test' : '최근 검증 명령: bun test');
  expect(evidence).toContain(expected.freshness === 'current' ? '검증 결과: PASS test/debug-surface.test.ts' : '최근 검증 결과: PASS test/debug-surface.test.ts');
  expect(evidence).toContain(`최근 검증 흐름: ${expected.history}`);
  expect(evidence).toContain('루프 마감 상태:');
}

function gitInit(cwd: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

function gitCommitAll(cwd: string, msg: string): void {
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', msg], {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

afterEach(() => {
  __resetSnapshotStore();
  __resetTurnState();
  resetPlanModeState();
});

describe('streamLLMWithTools — exploration synthesis phase', () => {
  test('intent classification excludes injected disciplines while preserving ordinary messages', () => {
    const ordinarySystem: LLMMessage = { role: 'system', content: 'Keep replies concise.' };
    const userQuestion: LLMMessage = { role: 'user', content: 'What is the current status?' };
    const selected = selectIntentClassificationMessages([
      { role: 'system', content: CODEX_TOOL_DISCIPLINE },
      { role: 'system', content: GROK_TOOL_DISCIPLINE },
      ordinarySystem,
      userQuestion,
    ]);

    expect(selected).toEqual([ordinarySystem, userQuestion]);
  });

  test('codex pure question is neither structural, implementation, nor debugging intent', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: CODEX_TOOL_DISCIPLINE },
      { role: 'user', content: 'What is the current status?' },
    ];

    expect(looksLikeStructuralAnalysis(messages)).toBe(false);
    expect(looksLikeImplementationTask(messages)).toBe(false);
    expect(looksLikeDebuggingTask(messages)).toBe(false);
  });

  test('grok injected discipline preserves implementation intent classification', async () => {
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'text', delta: 'done' }],
    ]);

    await streamLLMWithTools(
      [{ role: 'user', content: 'implement the renderer change' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      {
        provider,
        model: 'grok-4.6',
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 2,
      },
    );

    const transmitted = capturedMessagesAt(0)!;
    expect(transmitted[0]).toEqual({ role: 'system', content: GROK_TOOL_DISCIPLINE });
    expect(looksLikeStructuralAnalysis(transmitted)).toBe(false);
    expect(looksLikeImplementationTask(transmitted)).toBe(true);
    expect(looksLikeDebuggingTask(transmitted)).toBe(false);
  });

  test('rejects consecutive exploratory tool turns and forces synthesis early', async () => {
    const readTurn = (id: string): LLMStreamEvent[] => [
      { type: 'tool_call', id, name: 'Read', args: { file_path: `/tmp/${id}.ts` } },
    ];
    const { provider, capturedMessagesAt } = scriptedProvider([
      readTurn('a'),
      readTurn('b'),
      readTurn('c'),
      readTurn('d'),
      [{ type: 'text', delta: 'debug 구조는 log / call-stack / display 3계층입니다.' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'analyze debug structure' }],
      { onText: () => {}, dispatchTool: async () => 'tool-out' },
      {
        provider,
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 6,
      },
    );

    expect(result).toContain('3계층');
    const finalToolResult = lastToolResult(capturedMessagesAt(4));
    expect(finalToolResult).toBe('tool-out');
  });

  test('non-exploratory tool resets exploration streak', async () => {
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Read', args: { file_path: '/tmp/a.ts' } }],
      [{ type: 'tool_call', id: 'b', name: 'Bash', args: { command: 'pwd' } }],
      [{ type: 'tool_call', id: 'c', name: 'Read', args: { file_path: '/tmp/c.ts' } }],
      [{ type: 'tool_call', id: 'd', name: 'Read', args: { file_path: '/tmp/d.ts' } }],
      [{ type: 'text', delta: 'done' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'analyze' }],
      { onText: () => {}, dispatchTool: async () => 'tool-out' },
      {
        provider,
        tools: [
          { name: 'Read', description: 'd', parameters: { type: 'object' } },
          { name: 'Bash', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 6,
      },
    );

    expect(result).toBe('done');
    const beforeFinal = lastToolResult(capturedMessagesAt(4));
    expect(beforeFinal).not.toContain('EXPLORATION BUDGET EXHAUSTED');
  });

  test('hard-stops when the model ignores exploration synthesis twice', async () => {
    const readTurn = (id: string): LLMStreamEvent[] => [
      { type: 'tool_call', id, name: 'Read', args: { file_path: `/tmp/${id}.ts` } },
    ];
    const { provider, capturedMessagesAt } = scriptedProvider([
      readTurn('a'),
      readTurn('b'),
      readTurn('c'),
      readTurn('d'),
      readTurn('e'),
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'analyze debug structure' }],
      { onText: () => {}, dispatchTool: async () => 'tool-out' },
      {
        provider,
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 8,
      },
    );

    expect(result).toContain('[NO FINAL SYNTHESIS]');
  });

  test('exploration hard-stop attaches a fallback summary of explored paths/patterns', async () => {
    // Reproduces the 2026-04-25 codex/gpt-5.4 stall (log/debug-20260425141718,
    // log/debug-20260425144120) where the user's evaluation question hit the
    // exploration synthesis phase with 0 chars of useful answer. After fix A,
    // the [SYNTHESIS IGNORED] notice MUST be followed by an EXPLORATION
    // GATHERED summary so the user sees what was actually attempted.
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'ListDir', args: { path: '.', sort: 'name' } }],
      [
        { type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'coding-agent|tool loop', path: '.' } },
        { type: 'tool_call', id: 'c', name: 'Glob', args: { pattern: 'src/**/*.ts' } },
      ],
      [{ type: 'tool_call', id: 'd', name: 'ListDir', args: { path: 'src' } }],
      [{ type: 'tool_call', id: 'e', name: 'Grep', args: { pattern: 'streamLLMWithTools' } }],
      // turn 4: streak hits 5 ≥ threshold 4 → reject (count=1)
      [{ type: 'tool_call', id: 'f', name: 'ListDir', args: { path: 'docs' } }],
      // turn 5: still exploratory → reject (count=2) → hardStop
      [{ type: 'tool_call', id: 'g', name: 'Grep', args: { pattern: 'agent flow' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'evaluate this project codebase' }],
      { onText: () => {}, dispatchTool: async () => 'tool-out' },
      {
        provider,
        tools: [
          { name: 'ListDir', description: 'd', parameters: { type: 'object' } },
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Glob', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 6,
      },
    );

    expect(result).toContain('[SYNTHESIS IGNORED]');
    expect(result).toContain('===== EXPLORATION GATHERED =====');
    expect(result).toContain('ListDir paths');
    expect(result).toContain('Grep patterns');
    expect(result).toContain('Glob patterns');
    expect(result).toContain('Recommendation:');
    // No Read calls were issued, so the recommendation should call out the
    // narrow-scope advice explicitly (codex-style stall pattern).
    expect(result).toContain('No file content was read');
  });

  test('hard-stops when the model keeps issuing candidate-listing searches after narrowing was required', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [
        { type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } },
        { type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } },
      ],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'analyze debug structure' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- src/debug/log.ts';
          }
          return 'RUNTIME BLOCKED — candidate list already exists for this turn. Do not issue another `files_with_matches` search before narrowing. Use Read(file_path="src/debug/log.ts") ; or use AstGrep/Lsp on those files.';
        },
      },
      {
        provider,
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 6,
      },
    );

    expect(result).toContain('[SYNTHESIS IGNORED]');
    expect(result).toContain('candidate-listing searches');
    expect(result).toContain('Read/Lsp/content grep');
    // AA (2026-04-25, log/debug-20260425164918) — narrowing-blocked-twice-no-
    // inspections must now ALSO emit the EXPLORATION GATHERED fallback so the
    // user sees the trace + recommendation instead of just the 239-char notice.
    expect(result).toContain('===== EXPLORATION GATHERED =====');
    expect(result).toContain('Grep patterns');
    expect(result).toContain('Recommendation:');
    // baseline (sterile notice alone) is ~239 chars; with fallback ~625+
    expect(result.length).toBeGreaterThan(500);
  });

  test('BB — codex same-turn parallel Grep batch survives turn 0 (threshold raised to 3)', async () => {
    // Reproduces the 2026-04-25 W-bis side effect (log/debug-20260425164918)
    // where codex's first-turn [Grep, Grep, Grep] burst tripped
    // narrowingBlockedCount to 2 inside a single dispatch (1st sets phase=
    // 'listed'; 2nd & 3rd are blocked) → instant hard-stop at turn 0 with a
    // 239-char sterile notice. After BB, codex absorbs one same-turn batch
    // and recovers on the next turn instead of dying.
    const { provider } = scriptedProvider([
      [
        { type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } },
        { type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } },
        { type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } },
      ],
      [{ type: 'text', delta: 'recovered with what I have' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: '이 프로젝트 현재 코딩 에이전트 구현 정도 평가해주세요' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 12 files\nsrc/debug/log.ts\nsrc/debug/surface.ts';
          }
          return 'RUNTIME BLOCKED — candidate list already exists for this turn.';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 6,
      },
    );

    // Reaches the model's own text turn (no hard-stop after the first batch).
    expect(result).toBe('recovered with what I have');
    expect(result).not.toContain('[SYNTHESIS IGNORED]');
  });

  test('P4 + P2 grace — codex inspect-action phase: 1 grace turn, then hard-stop', async () => {
    // Reproduces the 2026-04-25 codex stall (log/debug-20260425173516):
    // turn 0 fans out 4 broad searches (CC-passed), turn 1 auto-narrows
    // into 2 Reads → autoNarrowedReadCount=2 hits inspectBudgetThreshold,
    // turn 2 codex issues another broad search → inInspectActionPhase
    // fires.
    //
    // P2 (2026-05-03) — grace contract: the FIRST trip into inspect-
    // action phase soft-rejects (model gets the stub, decrements
    // codexInspectActionGrace from 1→0). On the SECOND trip, grace=0 →
    // hard-stop fallback fires. So scripted turns now 5 (was 4): turns
    // 0-2 are the find/narrow phase, turn 3 burns grace, turn 4 hits
    // the hard-stop with the [ACTION IGNORED] notice.
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'foo', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'bar', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'baz', output_mode: 'files_with_matches' } }],
      // turn 3 — first inspect-action trip → grace burn (soft rejection).
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { pattern: 'qux', output_mode: 'files_with_matches' } }],
      // turn 4 — second inspect-action trip → hard-stop fires.
      [{ type: 'tool_call', id: 'e', name: 'Grep', args: { pattern: 'quux', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      // 'implement' triggers inspectFollowupMode='action' (vs default
      // 'synthesis'), which is the path P4 targets.
      [{ role: 'user', content: 'evaluate this implementation' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20\n[Suggested next Read/Lsp candidates]\n- /tmp/x.ts\n- /tmp/y.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/x.ts").\n\n1  alpha';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/y.ts").\n\n1  beta';
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 6,
      },
    );

    // Immediate-stop UX: [ACTION IGNORED] notice + buildInspectActionFallback
    // (Korean "구현/수정 단계는..." text) — same builder as the existing
    // 2-rejection path, just emitted earlier so codex doesn't burn an
    // extra turn reissuing rejected calls.
    expect(result).toContain('[ACTION IGNORED]');
    expect(result).toContain('구현/수정 단계는');
    expect(result).toContain('/tmp/x.ts');
    expect(result).toContain('/tmp/y.ts');
  });

  test('P4 gate — codex with edits already applied defers to finalization snapshot', async () => {
    // When edits/execution have happened, the existing 2-rejection path
    // produces a tailored "[FINAL ANSWER REQUIRED]" snapshot. P4 must
    // NOT preempt that branch — the gate restricts immediate-stop to
    // pure-exploration state (no edits, no execution). This test
    // mirrors the test directly above it (`successful verify followed
    // by broad search…`) but with explicit codex modelFamily to lock
    // the gate behaviour.
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Edit', args: { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'b', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'foo', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix the bug and verify' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') return 'edited';
          if (ctx?.callId === 'b') return { output: 'tests passed' };
          return 'tool-out';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 6,
      },
    );

    // P4 immediate-stop did NOT fire because editedFilePaths.length > 0
    // (edits were applied). The test passes if no [ACTION IGNORED]
    // appeared from a turn-2 immediate stop — the loop progressed into
    // the verify-action / finalization paths instead.
    expect(result).not.toContain('codex-inspect-action-immediate-stop');
  });

  test('forces synthesis after codex auto-narrows into top candidates twice', async () => {
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'keep narrowing these grep candidates' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\nsrc/acp/tool-call-state.ts\nsrc/acp/auto-persist.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/tool-call-state.ts").\n\n1  tool call state';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/auto-persist.ts").\n\n1  auto persist';
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 6,
      },
    );

    expect(result).toContain('구조 분석은 후보 파일 2개까지 좁혀 확인했습니다.');
    expect(result).toContain('/tmp/tool-call-state.ts');
    expect(result).toContain('/tmp/auto-persist.ts');
    expect(lastToolResult(capturedMessagesAt(4))).toBeNull();
  });

  test('inspect fallback synthesis summarizes inferred roles from inspected files', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'keep narrowing these candidates' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return 'unexpected';
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 6,
      },
    );

    expect(result).toContain('디버그 워크벤치/패널 구성과 소비 지점을 정의하는 축');
    expect(result).toContain('디버그 이벤트와 상태를 화면에 렌더링하는 축');
    expect(result).toContain('디버그 워크벤치가 어떤 패널 키와 컬럼 구성을 노출하는지 정의합니다.');
    expect(result).toContain('DebugEvent, CallFrame, 실행 이력을 화면용 텍스트/토큰으로 조합하는 렌더링 계층입니다.');
    expect(result).toContain('현재까지는');
  });

  test('blocked candidate-listing after inspections falls back to inspected-file synthesis', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'e', name: 'Grep', args: { pattern: 'log', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'keep narrowing these candidates' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          return 'runtime blocked — reuse current candidates';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 7,
      },
    );

    expect(result).not.toContain('[SYNTHESIS IGNORED]');
    expect(result).toContain('/tmp/debug-window-consumers.ts');
    expect(result).toContain('/tmp/debug-surface.ts');
    expect(result).toContain('디버그 워크벤치/패널 구성과 소비 지점을 정의하는 축');
  });

  test('structural analysis falls back to synthesis when a third broad listing is blocked after two inspections', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: '현재 프로젝트에서 디버깅 구조 분석해주세요' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts\n- /tmp/debug/log.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          return 'runtime blocked — narrow the request or use prior results';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 6,
      },
    );

    expect(result).not.toContain('[SYNTHESIS IGNORED]');
    expect(result).toContain('구조 분석은 후보 파일 2개까지 좁혀 확인했습니다.');
    expect(result).toContain('/tmp/debug-window-consumers.ts');
    expect(result).toContain('/tmp/debug-surface.ts');
    expect(result).toContain('워크벤치 구성');
  });

  test('structural analysis requests allow a third codex auto-narrowed inspection before fallback synthesis', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'e', name: 'Grep', args: { pattern: 'log', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: '현재 프로젝트에서 디버깅 구조 분석해주세요' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts\n- /tmp/debug/log.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug/log.ts").\n\n1  export interface DebugEvent {';
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 7,
      },
    );

    expect(result).toContain('후보 파일 3개');
    expect(result).toContain('/tmp/debug-window-consumers.ts');
    expect(result).toContain('/tmp/debug-surface.ts');
    expect(result).toContain('/tmp/debug/log.ts');
  });

  test('codex finalizes immediately when inspect budget is reached via auto-narrowed reads', async () => {
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'keep narrowing these candidates' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 6,
      },
    );

    expect(result).toContain('/tmp/debug-window-consumers.ts');
    expect(result).toContain('/tmp/debug-surface.ts');
    expect(capturedMessagesAt(3)).toBeUndefined();
  });

  test('implementation-like requests allow Edit after auto-narrowed inspections', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'text', delta: 'patched and verified the debug surface path.' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix the renderer path after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return { output: 'edited /tmp/debug-surface.ts' };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 7,
      },
    );

    expect(result).toContain('patched and verified the debug surface path.');
    expect(result).toContain('변경 파일: /tmp/debug-surface.ts');
    expect(result).not.toContain('[SYNTHESIS IGNORED]');
    expect(result).not.toContain('[ACTION IGNORED]');
  });

  test('implementation-like requests hard-stop if the model keeps searching after inspect budget', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'e', name: 'Grep', args: { pattern: 'log', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix the renderer path after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 7,
      },
    );

    expect(result).toContain('[ACTION IGNORED]');
    expect(result).toContain('Edit/Write/RunShell/Bash');
    expect(result).toContain('구현/수정 단계는 후보 파일 2개까지 좁혀 확인했습니다.');
    expect(result).toContain('다음 권장 단계');
    expect(result).toContain('Edit/Write 대상 우선순위');
  });

  test('implementation-like requests still allow narrow code-intel followups after inspect budget', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Lsp', args: { symbol: 'DebugEvent', action: 'references' } }],
      [{ type: 'text', delta: 'used lsp after inspection before editing.' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix the renderer path after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return { output: '2 references found for DebugEvent' };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Lsp', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 7,
      },
    );

    expect(result).toBe('used lsp after inspection before editing.');
  });

  test('debugging-like requests allow RunShell after auto-narrowed inspections', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'text', delta: 'reproduced the issue and captured the failing test output.' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'debug the failing test after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return { output: '1 failed', exitCode: 1, outcome: 'exit' };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 7,
      },
    );

    expect(result).toBe('reproduced the issue and captured the failing test output.');
    expect(result).not.toContain('[EXECUTION IGNORED]');
  });

  test('debugging-like requests hard-stop if the model keeps searching instead of executing after inspect budget', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'e', name: 'Grep', args: { pattern: 'log', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'debug the failing test after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          return 'runtime blocked — use the current inspected files';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Grep', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 8,
      },
    );

    expect(result).toContain('[EXECUTION IGNORED]');
    expect(result).toContain('RunShell(["bun","test"])');
    expect(result).toContain('디버깅 단계는 후보 파일 2개까지 좁혀 확인했습니다.');
  });

  test('debugging-like requests allow Edit after a failed RunShell', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'e', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'f', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'text', delta: 'fixed the issue and the test now passes.' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'debug the failing test after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return { output: '1 failed', exitCode: 1, outcome: 'exit' };
          }
          if (ctx?.callId === 'e') {
            return { output: 'edited /tmp/debug-surface.ts' };
          }
          if (ctx?.callId === 'f') {
            return { output: 'ok\n2 passed', exitCode: 0, outcome: 'exit' };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 8,
      },
    );

    expect(result).toContain('fixed the issue and the test now passes.');
    expect(result).toContain('변경 파일: /tmp/debug-surface.ts');
    expect(result).toContain('검증 명령: bun test');
    expect(result).toContain('검증 결과: ok');
    expect(result).not.toContain('[ACTION IGNORED]');
    expect(result).not.toContain('[VERIFY IGNORED]');
  });

  test('debugging-like requests fall back to repair guidance if the model keeps searching after execution failure (P2 grace: 2 search turns post-failure)', async () => {
    // P2 (2026-05-03) — codex repair-action phase has 1 grace turn
    // before the hard-stop fallback fires. So after the RunShell
    // failure (turn 3), the FIRST broad-search turn (turn 4) burns
    // grace; the SECOND broad-search (turn 5) trips hard-stop and the
    // result text includes the repair guidance. Scripted turns now 6
    // (was 5).
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      // turn 4 — first repair-action trip → grace burn (soft rejection).
      [{ type: 'tool_call', id: 'e', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
      // turn 5 — second repair-action trip → hard-stop, repair fallback.
      [{ type: 'tool_call', id: 'f', name: 'Grep', args: { pattern: 'render', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'debug the failing test after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return {
              output: '1 failed',
              stderr: 'FAIL test/debug-surface.test.ts\nError: render mismatch at src/display/debug-surface.ts:41',
              exitCode: 1,
              outcome: 'exit',
            };
          }
          return 'runtime blocked — narrow the request or use prior results';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 7,
      },
    );

    expect(result).toContain('실행 단계에서 실패 신호를 확인했습니다.');
    expect(result).toContain('실패를 낸 실행:');
    expect(result).toContain('bun test');
    expect(result).toContain('실패 요약:');
    expect(result).toContain('FAIL test/debug-surface.test.ts');
    expect(result).toContain('실패에서 드러난 파일/테스트:');
    expect(result).toContain('test/debug-surface.test.ts');
    expect(result).toContain('src/display/debug-surface.ts');
    expect(result).toContain('실패 스택/신호:');
    expect(result).toContain('Error: render mismatch at src/display/debug-surface.ts:41');
    expect(result).toContain('우선 수정 후보:');
    expect(result).toContain('src/display/debug-surface.ts — 실패 파일 힌트');
    expect(result).toContain('먼저 시도할 수정: Edit(file_path="src/display/debug-surface.ts"');
    expect(result).toContain('다음 검증: RunShell(["bun","test","test/debug-surface.test.ts"]) 또는 Bash("bun test test/debug-surface.test.ts")');
    expect(result).toContain('재수정 전 추가 확인: Read(file_path="src/display/debug-surface.ts"), Read(file_path="test/debug-surface.test.ts")');
    expect(result).toContain('필요하면 Read/Lsp/AstGrep 또는 Grep(output_mode="content"|"count")');
  });

  test('debugging-like requests detect repeated identical execution failures as execution doom', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'e', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'f', name: 'RunShell', args: { command: ['bun', 'test'] } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'debug the failing test after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd' || ctx?.callId === 'e' || ctx?.callId === 'f') {
            return {
              output: '1 failed',
              stderr: 'FAIL test/debug-surface.test.ts\nError: render mismatch at src/display/debug-surface.ts:41',
              exitCode: 1,
              outcome: 'exit',
            };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 9,
      },
    );

    expect(result).toContain('[EXECUTION DOOM DETECTED]');
    expect(result).toContain('실행 루프 상태: 같은 실행 실패가 반복됨');
    expect(result).toContain('루프 권장 상태:');
    expect(result).toContain('같은 실행 실패가 반복 중이므로 재실행보다 수정 또는 repair 정리가 맞습니다.');
    expect(result).toContain('수정 후 재검증: RunShell(["bun","test","test/debug-surface.test.ts"]) 또는 Bash("bun test test/debug-surface.test.ts")');
    expect(result).toContain('반복된 실행 실패 패턴:');
    expect(result).toContain('bun test -> fail test/debug-surface.test.ts');
    expect(result).toContain('bun test');
    expect(result).toContain('FAIL test/debug-surface.test.ts');
    expect(result).toContain('src/display/debug-surface.ts');
  });

  test('successful execution resets execution doom tracking', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'e', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'f', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'g', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'h', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'text', delta: 'retried after a passing verification without hitting execution doom.' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'debug the failing test after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd' || ctx?.callId === 'e' || ctx?.callId === 'h') {
            return {
              output: '1 failed',
              stderr: 'FAIL test/debug-surface.test.ts\nError: render mismatch at src/display/debug-surface.ts:41',
              exitCode: 1,
              outcome: 'exit',
            };
          }
          if (ctx?.callId === 'f') {
            return { output: 'edited /tmp/debug-surface.ts' };
          }
          if (ctx?.callId === 'g') {
            return { output: 'ok\n2 passed', stdout: '2 passed', exitCode: 0, outcome: 'exit' };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 12,
      },
    );

    expect(result).toContain('retried after a passing verification without hitting execution doom.');
    expect(result).toContain('변경 파일: /tmp/debug-surface.ts');
    expect(result).toContain('검증 명령: bun test');
    expect(result).toContain('검증 결과: 2 passed');
    expect(result).not.toContain('[EXECUTION DOOM DETECTED]');
  });

  test('implementation-like requests allow verify tools after Edit', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'e', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'text', delta: 'edited and verified with bun test.' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix the renderer path after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return { output: 'edited /tmp/debug-surface.ts' };
          }
          if (ctx?.callId === 'e') {
            return { output: 'ok\n2 passed' };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 8,
      },
    );

    expect(result).toContain('edited and verified with bun test.');
    expect(result).toContain('변경 파일: /tmp/debug-surface.ts');
    expect(result).toContain('검증 명령: bun test');
    expect(result).toContain('검증 결과: ok');
  });

  test('implementation-like requests hard-stop if the model resumes broad search after Edit', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'debug', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'logger', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'e', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'f', name: 'Grep', args: { pattern: 'log', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix the renderer path after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return { output: 'edited /tmp/debug-surface.ts' };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 8,
      },
    );

    expect(result).toContain('[VERIFY IGNORED]');
    expect(result).toContain('수정 단계는 진행됐고, 이제 추가 탐색보다 검증 단계로 넘어가는 것이 맞습니다.');
    expect(result).toContain('/tmp/debug-surface.ts');
    expect(result).toContain('RunShell(["bun","test"])');
  });

  test('successful verify followed by broad search falls back to action guidance', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'render', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'surface', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'display', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'e', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'f', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'g', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix the renderer path after inspecting the relevant files' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return { output: 'edited /tmp/debug-surface.ts' };
          }
          if (ctx?.callId === 'e') {
            return {
              output: 'ok\nPASS test/debug-surface.test.ts\n2 passed',
              stdout: 'PASS test/debug-surface.test.ts\n2 passed',
              exitCode: 0,
              outcome: 'exit',
            };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 9,
      },
    );

    expect(result).toContain('[FINAL ANSWER REQUIRED]');
    expect(result).toContain('검증이 이미 성공했으므로 추가 broad search 대신');
    expect(result).toContain('루프 마감 상태:');
    expect(result).toContain('마지막 검증이 성공했으므로 추가 탐색보다 최종 답변 정리가 맞습니다.');
    expect(result).toContain('변경 파일: /tmp/debug-surface.ts');
    expect(result).toContain('검증 결과: PASS test/debug-surface.test.ts');
  });

  test('final answer is enriched with verify history after repair and successful verification', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'render', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'surface', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'display', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'e', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'text', delta: '수정했고 테스트도 통과했습니다.' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix the renderer path and verify the result' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return { output: 'edited /tmp/debug-surface.ts' };
          }
          if (ctx?.callId === 'e') {
            return {
              output: 'ok\nPASS test/debug-surface.test.ts\n2 passed',
              stdout: 'PASS test/debug-surface.test.ts\n2 passed',
              exitCode: 0,
              outcome: 'exit',
            };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 8,
      },
    );

    expect(result).toContain('수정했고 테스트도 통과했습니다.');
    expect(result).toContain('변경 파일: /tmp/debug-surface.ts');
    expect(result).toContain('검증 명령: bun test');
    expect(result).toContain('검증 결과: PASS test/debug-surface.test.ts');
    expect(result).toContain('검증 기준 파일/테스트: test/debug-surface.test.ts');
    expect(result).toContain('해결 기준 파일/테스트: /tmp/debug-surface.ts, test/debug-surface.test.ts');
    expect(result).not.toContain('해결 기준 파일/테스트: /tmp/debug-surface.ts, test/debug-surface.test.ts, /tmp/debug-window-consumers.ts');
    expect(result).toContain('해결 근거 연결: 수정 파일 /tmp/debug-surface.ts 이(가) 실패/검증 힌트와 직접 겹칩니다.');
    expect(result).toContain('루프 마감 상태: 마지막 검증이 성공했으므로 추가 탐색보다 최종 답변 정리가 맞습니다.');
  });

  test('final answer stays stable after multiple successful verify passes', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'render', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'surface', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'display', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'e', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'f', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'b', new_string: 'c' } }],
      [{ type: 'tool_call', id: 'g', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'text', delta: '수정 후 재검증까지 완료했습니다.' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'debug the failing test and keep iterating until the verification passes' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd' || ctx?.callId === 'f') {
            return { output: `edited ${ctx?.callId === 'd' ? 'b' : 'c'} /tmp/debug-surface.ts` };
          }
          if (ctx?.callId === 'e') {
            return {
              output: 'ok\nPASS test/debug-surface.test.ts\n1 passed',
              stdout: 'PASS test/debug-surface.test.ts\n1 passed',
              exitCode: 0,
              outcome: 'exit',
            };
          }
          if (ctx?.callId === 'g') {
            return {
              output: 'ok\nPASS test/debug-surface.test.ts\n2 passed',
              stdout: 'PASS test/debug-surface.test.ts\n2 passed',
              exitCode: 0,
              outcome: 'exit',
            };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );

    const { answer, evidence } = splitFinalAnswerAndEvidence(result);
    expect(answer).toBe('수정 후 재검증까지 완료했습니다.');
    expectVerificationEvidence(evidence, {
      freshness: 'current',
      history: 'bun test -> PASS (PASS test/debug-surface.test.ts)',
    });
    expect(result).not.toContain('[VERIFY IGNORED]');
    expect(result).not.toContain('[ACTION IGNORED]');
  });

  test('recent successful verify is treated as stale after a new edit', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'render', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'surface', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'display', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'e', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'f', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'b', new_string: 'c' } }],
      [{ type: 'text', delta: '추가 수정을 적용했습니다.' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'debug the failing test and make one more tweak after it passes' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd' || ctx?.callId === 'f') {
            return { output: `edited ${ctx?.callId === 'd' ? 'b' : 'c'} /tmp/debug-surface.ts` };
          }
          if (ctx?.callId === 'e') {
            return {
              output: 'ok\nPASS test/debug-surface.test.ts\n2 passed',
              stdout: 'PASS test/debug-surface.test.ts\n2 passed',
              exitCode: 0,
              outcome: 'exit',
            };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 9,
      },
    );

    const { answer, evidence } = splitFinalAnswerAndEvidence(result);
    expect(answer).toBe('추가 수정을 적용했습니다.');
    expectVerificationEvidence(evidence, {
      freshness: 'stale',
      history: 'bun test -> PASS (PASS test/debug-surface.test.ts)',
    });
    expect(evidence).toContain('최근 수정 이후 재검증이 아직 필요합니다.');
    expect(result).not.toContain('루프 마감 상태: 마지막 검증이 성공했으므로');
  });

  test('stale verify state is surfaced in verify fallback after a new edit', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'render', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'surface', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'display', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'e', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'f', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'b', new_string: 'c' } }],
      [{ type: 'tool_call', id: 'g', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'h', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'make one more edit after the test passes and then keep going' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd' || ctx?.callId === 'f') {
            return { output: `edited ${ctx?.callId === 'd' ? 'b' : 'c'} /tmp/debug-surface.ts` };
          }
          if (ctx?.callId === 'e') {
            return {
              output: 'ok\nPASS test/debug-surface.test.ts\n2 passed',
              stdout: 'PASS test/debug-surface.test.ts\n2 passed',
              exitCode: 0,
              outcome: 'exit',
            };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );

    expect(result).toContain('최근 수정 이후 재검증이 아직 필요합니다.');
    expect(result).toContain('최근 검증 결과:');
    expect(result).toContain('- 명령: bun test');
    expect(result).toContain('- 요약: PASS test/debug-surface.test.ts');
    expect(result).toContain('먼저 시도할 재검증: RunShell(["bun","test","test/debug-surface.test.ts"]) 또는 Bash("bun test test/debug-surface.test.ts")  // 최근 결과: PASS test/debug-surface.test.ts');
    expect(result).not.toContain('다음 검증: RunShell(["bun","test","test/debug-surface.test.ts"]) 또는 Bash("bun test test/debug-surface.test.ts")  // 최근 결과: PASS test/debug-surface.test.ts');
    expect(result).toContain('재수정 전 추가 확인: Read(file_path="/tmp/debug-surface.ts"), Read(file_path="test/debug-surface.test.ts")');
    expect(result).not.toContain('Read(file_path="/tmp/debug-window-consumers.ts")');
  });

  test('failed verify followed by broad search falls back to repair guidance with failure context', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'render', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'surface', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'display', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'e', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'f', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'g', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix the renderer path after debugging the failing test' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return { output: 'edited /tmp/debug-surface.ts' };
          }
          if (ctx?.callId === 'e') {
            return {
              output: '1 failed',
              stderr: 'FAIL test/debug-surface.test.ts\nError: render mismatch at src/display/debug-surface.ts:41',
              exitCode: 1,
              outcome: 'exit',
            };
          }
          return 'unexpected';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 10,
      },
    );

    expect(result).toContain('[VERIFY IGNORED]');
    expect(result).toContain('수정 단계는 진행됐고, 이제 추가 탐색보다 검증 단계로 넘어가는 것이 맞습니다.');
    expect(result).toContain('이번 검증이 이어진 실패 맥락:');
    expect(result).toContain('- 실패 명령: bun test');
    expect(result).toContain('- 실패 요약: FAIL test/debug-surface.test.ts');
    expect(result).toContain('FAIL test/debug-surface.test.ts');
    expect(result).toContain('실패 스택/신호:');
    expect(result).toContain('Error: render mismatch at src/display/debug-surface.ts:41');
    expect(result).toContain('우선 수정 후보:');
    expect(result).toContain('src/display/debug-surface.ts — 실패 파일 힌트');
    expect(result).toContain('먼저 시도할 수정: Edit(file_path="src/display/debug-surface.ts"');
    expect(result).toContain('다음 검증: RunShell(["bun","test","test/debug-surface.test.ts"]) 또는 Bash("bun test test/debug-surface.test.ts")  // 최근 결과: FAIL test/debug-surface.test.ts');
    expect(result).toContain('재수정 전 추가 확인: Read(file_path="src/display/debug-surface.ts"), Read(file_path="test/debug-surface.test.ts")');
  });

  test('repeated verify failures add verify loop health guidance', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Grep', args: { pattern: 'render', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'b', name: 'Grep', args: { pattern: 'surface', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'c', name: 'Grep', args: { pattern: 'display', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'd', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'e', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'f', name: 'Edit', args: { file_path: '/tmp/debug-surface.ts', old_string: 'b', new_string: 'c' } }],
      [{ type: 'tool_call', id: 'g', name: 'RunShell', args: { command: ['bun', 'test'] } }],
      [{ type: 'tool_call', id: 'h', name: 'Grep', args: { pattern: 'dashboard', output_mode: 'files_with_matches' } }],
      [{ type: 'tool_call', id: 'i', name: 'Grep', args: { pattern: 'trace', output_mode: 'files_with_matches' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'keep fixing the renderer until the verification passes' }],
      {
        onText: () => {},
        dispatchTool: async (_name, _args, ctx) => {
          if (ctx?.callId === 'a') {
            return 'Found 20 files\n[Suggested next Read/Lsp candidates]\n- /tmp/debug-window-consumers.ts\n- /tmp/debug-surface.ts';
          }
          if (ctx?.callId === 'b') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-window-consumers.ts").\n\n1  export type DebugWorkbenchPane =';
          }
          if (ctx?.callId === 'c') {
            return '[AUTO-NARROWED] Repeated candidate-listing search converted into Read(file_path="/tmp/debug-surface.ts").\n\n1  import { formatLine, type DebugEvent } from "../debug/log.js";';
          }
          if (ctx?.callId === 'd') {
            return { output: 'edited /tmp/debug-surface.ts' };
          }
          if (ctx?.callId === 'e' || ctx?.callId === 'g') {
            return {
              output: '1 failed',
              stderr: 'FAIL test/debug-surface.test.ts\nError: render mismatch at src/display/debug-surface.ts:41',
              exitCode: 1,
              outcome: 'exit',
            };
          }
          if (ctx?.callId === 'f') {
            return { output: 'edited /tmp/debug-surface.ts again' };
          }
          return 'runtime blocked — narrow the request or use prior results';
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [
          { name: 'Grep', description: 'd', parameters: { type: 'object' } },
          { name: 'Edit', description: 'd', parameters: { type: 'object' } },
          { name: 'RunShell', description: 'd', parameters: { type: 'object' } },
        ],
        maxTurns: 12,
      },
    );

    expect(result).toContain('검증 루프 상태: 같은 검증 실패가 반복됨');
    expect(result).toContain('bun test -> FAIL test/debug-surface.test.ts');
    expect(result).toContain('재실행보다 수정 우선이 맞습니다.');
    expect(result).toContain('루프 권장 상태:');
    expect(result).toContain('같은 파일/테스트를 중심으로 실패가 반복되므로 대상 파일을 우선 수정하고 필요한 검증만 다시 돌리는 것이 맞습니다.');
    expect(result).toContain('반복 실패 대상: src/display/debug-surface.ts 중심으로 같은 실패 패턴이 이어집니다.');
    expect(result).toContain('재수정 전 추가 확인: Read(file_path="src/display/debug-surface.ts")');
    expect(result).toContain('수정 후 재검증: RunShell(["bun","test","test/debug-surface.test.ts"]) 또는 Bash("bun test test/debug-surface.test.ts")');
  });

  test('doom-loop auto-undo restores the latest snapshot and continues in repair mode', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'doom-auto-undo-'));
    try {
      gitInit(repo);
      const file = join(repo, 'a.txt');
      writeFileSync(file, 'v1\n');
      gitCommitAll(repo, 'c1');
      writeFileSync(file, 'v2\n');
      const snap = captureSnapshot(repo)!;
      pushSnapshot(snap);
      writeFileSync(file, 'v3\n');

      const sameError = new Error('No ToolRuntime registered for MissingTool');
      const { provider, capturedMessagesAt } = scriptedProvider([
        [{ type: 'tool_call', id: 'a', name: 'Edit', args: { file_path: file, old_string: 'v3\n', new_string: 'vx\n' } }],
        [{ type: 'tool_call', id: 'b', name: 'Edit', args: { file_path: file, old_string: 'v3\n', new_string: 'vy\n' } }],
        [{ type: 'tool_call', id: 'c', name: 'Edit', args: { file_path: file, old_string: 'v3\n', new_string: 'vz\n' } }],
        [{ type: 'text', delta: 'repair after auto undo' }],
      ]);

      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'fix the broken tool loop after repeated failures' }],
        {
          onText: () => {},
          dispatchTool: async () => {
            throw sameError;
          },
        },
        {
          provider,
          model: 'gpt-5.4',
          tools: [{ name: 'Edit', description: 'd', parameters: { type: 'object' } }],
          maxTurns: 6,
        },
      );

      expect(result).toBe('repair after auto undo');
      expect(readFileSync(file, 'utf8')).toBe('v2\n');
      const priorToolResult = lastToolResult(capturedMessagesAt(3));
      expect(priorToolResult).toContain('AUTO-UNDO APPLIED');
      expect(priorToolResult).toContain('repair mode');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('doom-loop self-heals (no ask) when plan mode is active', async () => {
    const logSpy = spyOn(debug, 'log');
    setPlanModeState({
      ...INACTIVE_PLAN_MODE_STATE,
      active: true,
      sessionId: 'plan-1',
      startedAt: Date.now(),
      phase: 'explore',
      planFilePath: '/tmp/plan.md',
    });

    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Edit', args: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'b', name: 'Edit', args: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'c' } }],
      [{ type: 'tool_call', id: 'c', name: 'Edit', args: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'd' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix the broken tool loop after repeated failures' }],
      {
        onText: () => {},
        dispatchTool: async () => {
          throw new Error('No ToolRuntime registered for MissingTool');
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Edit', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 5,
      },
    );

    const heal = logSpy.mock.calls.find((call) => call[1] === 'doom-loop-self-heal');
    logSpy.mockRestore();
    expect(result).not.toContain('[ASK USER]');
    expect(heal?.[2]).toMatchObject({ reason: 'plan-mode', attempt: 1, action: 'guidance' });
  });

  // ─────────────────────────────────────────────────────────────────────
  // W5-E (2026-05-03 PM) — Force-synthesis no-tools pass. When the loop
  // is about to emit a [...IGNORED] hard-stop notice for codex family,
  // give the model ONE chance to write the synthesis with tools removed.
  // The model already has tool_results in history; removing tools forces
  // a text-only response. If the pass fails (empty / errors), fall back
  // to the existing notice.
  // ─────────────────────────────────────────────────────────────────────
  describe('streamLLMWithTools — W5-E: force-synthesis no-tools pass on hard-stop', () => {
    function makeForceSynthProvider(
      streamTurns: LLMStreamEvent[][],
      forceText: string | null,
    ): LLMProvider {
      let streamCall = 0;
      return {
        name: 'scripted',
        defaultModel: 'd',
        available: () => true,
        async *streamChat() {
          const events = streamTurns[streamCall++] ?? [];
          for (const ev of events) yield ev;
        },
        async *chat() {
          if (forceText !== null) yield forceText;
        },
      };
    }

    test('codex family — synthesized text replaces [SYNTHESIS IGNORED] notice', async () => {
      const readTurn = (id: string): LLMStreamEvent[] => [
        { type: 'tool_call', id, name: 'Read', args: { file_path: `/tmp/${id}.ts` } },
      ];
      const provider = makeForceSynthProvider(
        [readTurn('a'), readTurn('b'), readTurn('c'), readTurn('d'),
         readTurn('e'), readTurn('f'), readTurn('g'), readTurn('h'), readTurn('i')],
        'Here is the synthesis: the project has 3 modules wired through the central dispatcher.',
      );
      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'analyze' }],
        { onText: () => {}, dispatchTool: async () => 'tool-out' },
        {
          provider,
          model: 'gpt-5.4',
          tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
          maxTurns: 8,
        },
      );
      expect(result).toContain('the project has 3 modules');
      expect(result).not.toContain('[SYNTHESIS IGNORED]');
      expect(result).not.toContain('===== EXPLORATION GATHERED =====');
    });

    test('codex family — empty synthesis falls back to [SYNTHESIS IGNORED] notice', async () => {
      const readTurn = (id: string): LLMStreamEvent[] => [
        { type: 'tool_call', id, name: 'Read', args: { file_path: `/tmp/${id}.ts` } },
      ];
      const provider = makeForceSynthProvider(
        [readTurn('a'), readTurn('b'), readTurn('c'), readTurn('d'),
         readTurn('e'), readTurn('f'), readTurn('g'), readTurn('h'), readTurn('i')],
        '',  // empty synthesis
      );
      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'analyze' }],
        { onText: () => {}, dispatchTool: async () => 'tool-out' },
        {
          provider,
          model: 'gpt-5.4',
          tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
          maxTurns: 8,
        },
      );
      expect(result).toContain('[NO FINAL SYNTHESIS]');
      expect(result).not.toContain('[SYNTHESIS IGNORED]');
      expect(result).toContain('===== EXPLORATION GATHERED =====');
    });

    test('codex family — too-short synthesis (<50 chars) falls back to notice', async () => {
      const readTurn = (id: string): LLMStreamEvent[] => [
        { type: 'tool_call', id, name: 'Read', args: { file_path: `/tmp/${id}.ts` } },
      ];
      const provider = makeForceSynthProvider(
        [readTurn('a'), readTurn('b'), readTurn('c'), readTurn('d'),
         readTurn('e'), readTurn('f'), readTurn('g'), readTurn('h'), readTurn('i')],
        'too short',  // 9 chars
      );
      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'analyze' }],
        { onText: () => {}, dispatchTool: async () => 'tool-out' },
        {
          provider,
          model: 'gpt-5.4',
          tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
          maxTurns: 8,
        },
      );
      expect(result).toContain('[NO FINAL SYNTHESIS]');
      expect(result).not.toContain('[SYNTHESIS IGNORED]');
    });

    test('non-codex family does NOT trigger force-synthesis pass', async () => {
      const readTurn = (id: string): LLMStreamEvent[] => [
        { type: 'tool_call', id, name: 'Read', args: { file_path: `/tmp/${id}.ts` } },
      ];
      // chat() yields a "synthesis" but family is non-codex — should
      // NOT replace the standard fallback.
      const provider = makeForceSynthProvider(
        [readTurn('a'), readTurn('b'), readTurn('c'), readTurn('d'),
         readTurn('e'), readTurn('f'), readTurn('g'), readTurn('h'), readTurn('i')],
        'this would be the synthesis if codex but should not appear here',
      );
      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'analyze' }],
        { onText: () => {}, dispatchTool: async () => 'tool-out' },
        {
          provider,
          // no model arg → defaultModel='d' → family='other'
          tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
          maxTurns: 8,
        },
      );
      expect(result).not.toContain('this would be the synthesis');
      // Non-codex falls through to standard hard-stop notice
      // ([SYNTHESIS IGNORED] when exploration phase fires, or
      // [NO FINAL SYNTHESIS] when loop simply runs out). Either is OK
      // — what matters is the chat() text DIDN'T leak in.
      expect(
        result.includes('[SYNTHESIS IGNORED]') || result.includes('[NO FINAL SYNTHESIS]'),
      ).toBe(true);
    });
  });

  test('doom-loop self-heals (no ask) when auto-undo has no snapshot', async () => {
    const logSpy = spyOn(debug, 'log');
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'a', name: 'Edit', args: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' } }],
      [{ type: 'tool_call', id: 'b', name: 'Edit', args: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'c' } }],
      [{ type: 'tool_call', id: 'c', name: 'Edit', args: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'd' } }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix the broken tool loop after repeated failures' }],
      {
        onText: () => {},
        dispatchTool: async () => {
          throw new Error('No ToolRuntime registered for MissingTool');
        },
      },
      {
        provider,
        model: 'gpt-5.4',
        tools: [{ name: 'Edit', description: 'd', parameters: { type: 'object' } }],
        maxTurns: 5,
      },
    );

    const heal = logSpy.mock.calls.find((call) => call[1] === 'doom-loop-self-heal');
    logSpy.mockRestore();
    expect(result).not.toContain('[ASK USER]');
    expect(heal?.[2]).toMatchObject({ reason: 'no-undo-available', attempt: 1, action: 'guidance' });
  });

});
