// ── Parallel tool dispatch (Coding Pipeline P2) ──
//
// Helper for the llm.ts tool loop. All-or-nothing per batch (JUD #39447
// HOLD #122147): a batch of tool calls fans out through Promise.all only
// when EVERY call is per-call safe; a single unsafe call pins the whole
// batch to sequential dispatch in ORIGINAL call order. The
// `supportsParallel` meta in nativeToolCatalog is an opt-in, never a
// blanket licence — Bash calls additionally pass the conservative
// per-command isolation gate in bash-parallel-safety.ts, so write/mutating
// shell commands never ride a parallel batch even though the Bash tool is
// flagged parallel-eligible.
//
// Pattern adapted from:
//   - claude-code-fork `src/services/tools/toolOrchestration.ts:19-82`
//     (`isConcurrencySafe()` batch partitioning)
//   - codex `codex-rs/tools/src/tool_spec.rs:121-137`
//     (`ConfiguredToolSpec.supports_parallel_tool_calls`)
//
// Design choices:
//
//   1. Result ordering is preserved in the caller's `results` array.
//      Callers index into their own storage through the `dispatchOne`
//      callback — we never reorder — so the tool_result blocks that get
//      pushed to the LLM conversation stay in original call order.
//
//   2. Agent is always sequential for this helper. The tool loop has a
//      separate, richer Agent-batch path (with onAgentBatchStart/Tick/End
//      UX events) upstream of this helper; when the caller enters the
//      Agent-batch path it doesn't call this helper.
//
//   3. Post-processing hooks (onToolCall / onToolResult / verifyArmed
//      flip) run inside the dispatch callback the caller provides, so we
//      stay policy-free: the helper only decides ORDER, not POLICY.
//
//   4. MVP safety net: when `supportsParallel` is undefined or false the
//      call is unsafe. A miss-classified mutating tool without the flag
//      stays sequential — never parallelised. Bash adds the per-command
//      gate on top (HOLD #122147): file redirection, mutating utilities
//      and command substitution all demote the call — and with it the
//      whole batch — to original-order sequential.
//
// Non-goals:
//
//   - Concurrency capping — if the LLM asks for 12 parallel Reads, we run
//     12. Provider response time is the natural backpressure.
//   - Reordering within a parallel batch — Promise.all fires them all at
//     once and we let the runtime decide actual scheduling.

import { findNativeTool } from '../native-tool-catalog.js';
import { classifyBashCommand } from './bash-parallel-safety.js';

/** 원본 index 로 호출을 래핑한 통 요소 — pre-HOLD 분할기의 반환 모양.
 *  export 유지(r4 changed-tsc touch-clean, 2026-11-21): main 소유 baseline 시험
 *  `test/session-runtime-parallel-dispatch.test.ts` 가 임포트한다.
 *  출처: main 770e0d233e(=base 021d8887fe) src/session-runtime/parallel-dispatch.ts:45-48 원문. */
export interface CallWithIndex<T> {
  call: T;
  index: number;
}

/** Look up the catalog `supportsParallel` flag by tool name / alias.
 *  Returns false (conservative) when the tool isn't in the catalog so
 *  unknown / plugin tools default to sequential until explicitly opted
 *  in via catalog metadata. Export 유지(같은 r4 호환 — baseline 시험 임포트). */
export function isSafeForParallel(toolName: string): boolean {
  // Agent is handled by the separate agent-batch path in llm.ts even
  // when the catalog marks it supportsParallel=true. Excluding it here
  // keeps this helper composable with the existing Agent path without
  // double-dispatch.
  if (toolName === 'Agent') return false;
  const entry = findNativeTool(toolName);
  return entry?.supportsParallel === true;
}

/** Pre-HOLD 분할기 — main 원문 복원(r4 changed-tsc touch-clean, 2026-11-21):
 *  묶음을 도구급 카탈로그 깃발로 (safe, unsafe) 두 통에 나누고 원본 index 를
 *  래핑해 돌준다. dispatch 경로는 HOLD #122147(전부 안전일 때만 병렬)로 옮겨
 *  이 분할기를 더 쓰지 않지만, main 소유 baseline 시험이 임포트하므로
 *  export 표면은 유지한다(본문은 main 과 동일).
 *  출처: main 770e0d233e(=base 021d8887fe) src/session-runtime/parallel-dispatch.ts:64-77 원문. */
export function partitionByParallelSafety<T extends { name: string }>(
  calls: readonly T[],
): { safe: CallWithIndex<T>[]; unsafe: CallWithIndex<T>[] } {
  const safe: CallWithIndex<T>[] = [];
  const unsafe: CallWithIndex<T>[] = [];
  // 출처: main 원문 루프(0 에서 calls.length 까지 1 씩) — 측정 상한 아님.
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    const bucket = isSafeForParallel(call.name) ? safe : unsafe;
    bucket.push({ call, index: i });
  }
  return { safe, unsafe };
}

/** Per-call parallel judgement (JUD #39447 HOLD #122147): the catalog flag
 *  is necessary but not sufficient. A Bash call is only parallel-safe when
 *  a conservative per-command pass (bash-parallel-safety.ts) proves its
 *  command cannot mutate anything — redirect writers, mutating utilities
 *  and command substitution all demote the call, and with it the whole
 *  batch, to original-order sequential. Non-Bash tools keep the plain
 *  tool-level opt-in. */
export function isCallSafeForParallel(call: { name: string; args?: unknown }): boolean {
  if (call.name === 'Agent') return false;
  if (!isSafeForParallel(call.name)) return false;
  if (call.name !== 'Bash') return true;
  const args = call.args as { command?: unknown } | undefined;
  const command = typeof args?.command === 'string' ? args.command : '';
  return classifyBashCommand(command).kind === 'read-only';
}

/** Dispatch all `calls` honouring parallel safety — ALL-OR-NOTHING per batch
 *  (JUD #39447 HOLD #122147):
 *    - every call per-call safe → the whole batch runs concurrently (Promise.all)
 *    - any unsafe call → the whole batch runs strictly sequential, in
 *      original call order
 *
 *  The caller provides `dispatchOne(call, index): Promise<void>` which is
 *  responsible for calling the tool, firing onToolCall / onToolResult /
 *  policy hooks, and writing the result into the caller's results storage
 *  at `index`. Returns after all calls have resolved.
 *
 *  Pre-HOLD behaviour partitioned the batch — safe group via Promise.all
 *  first, unsafe group after — which both reordered original call order and,
 *  once Bash was flagged supportsParallel=true, let two same-file Bash
 *  writes run concurrently. The all-or-nothing rule closes both: the batch
 *  is one unit, ordered exactly as the model emitted it, unless every call
 *  is proven per-call safe.
 *
 *  ⭐ `signal` (TUI-ESC-ABORT-TOOLS · 2026-10-15) — 턴 중단(Esc)이 걸리면 묶음 안
 *  «남은» 호출을 새로 시작하지 않는다. 순차 경로에서는 호출마다
 *  `signal.aborted` 를 보고, 참이면 그 호출과 뒤의 호출을 부르지 않는다.
 *  ⛔ 이미 시작한 호출은 끊지 않는다(진행 중 도구의 중단은 도구가 받는 신호의 몫).
 *  ⛔ 병렬 묶음은 한꺼번에 시작되므로 시작 «전»에만 본다.
 *  부르지 않은 호출의 결과 칸은 비어 있다 — 호출자가 «중단됨» 결과로 채워
 *  공급자 이력의 tool_call/tool_result 짝을 지킨다(`skippedIndices`). */
export async function dispatchWithParallelSafety<T extends { name: string }>(
  calls: readonly T[],
  dispatchOne: (call: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<{ safeCount: number; unsafeCount: number; parallelActivated: boolean; skippedIndices: number[] }> {
  const perCallSafe = calls.map((call) => isCallSafeForParallel(call));
  const safeCount = perCallSafe.filter((safe) => safe).length;
  const unsafeCount = calls.length - safeCount;
  const parallelActivated = calls.length >= 2 && unsafeCount === 0;
  const skippedIndices: number[] = [];
  if (!parallelActivated) {
    // Mixed / unsafe batch: whole batch sequential, original order — no
    // safe-first reordering, no concurrent same-file writes.
    for (let i = 0; i < calls.length; i += 1) {
      if (signal?.aborted) { skippedIndices.push(i); continue; }
      await dispatchOne(calls[i]!, i);
    }
    return { safeCount, unsafeCount, parallelActivated, skippedIndices };
  }
  // Parallel kickoff for the fully-safe batch. Promise.all is safe here
  // because `dispatchOne` is expected to catch its own errors and write an
  // error result into the caller's storage — one failing Read must never
  // cancel two sibling Reads.
  if (signal?.aborted) {
    for (let i = 0; i < calls.length; i += 1) skippedIndices.push(i);
  } else {
    await Promise.all(calls.map((call, index) => dispatchOne(call, index)));
  }
  return { safeCount, unsafeCount, parallelActivated, skippedIndices };
}