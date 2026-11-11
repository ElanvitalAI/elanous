// Wave P3a (presentation) · A4-1 — plan-board chat-surface runtime.
//
// Owns a single chat-surface block that mirrors the active plan
// (steps from update_plan). Replaces the old chatLines.push fallback
// (dashboard/index.ts:2682-2690 from WF2) with in-place splice — so
// repeated update_plan calls REPLACE the previous block instead of
// pushing duplicates that scroll the chat.
//
// Pattern: identical to agent-progress-runtime (P2a) and
// background-pill-runtime (P2b). Host-scoped, single block, splice
// in-place, removed on empty.
//
// The chat-surface presentation is ephemeral and uses no widget host.

import { renderPlanBoard } from '../code-edit/plan-renderer.js';
import {
  subscribePlanUpdate,
  type PlanState,
} from '../code-edit/plan-tool.js';

export interface PlanBoardRuntimeDeps {
  chatLines: string[];
  pinChatTail: () => void;
  draw: () => void;
  /** Optional `noColor` flag forwarded to renderPlanBoard. Tests use
   *  this to assert on plain text without ANSI noise. */
  noColor?: boolean;
}

export interface PlanBoardRuntime {
  /** Apply a plan-state update — splice into chatLines in place. */
  apply: (state: PlanState) => void;
  /** Drop the block from chatLines (e.g. session reset). */
  reset: () => void;
  /** Test seam — current rendered lines, or null when absent. */
  _linesForTest: () => string[] | null;
}

interface BlockHandle {
  start: number;
  length: number;
}

export function createPlanBoardRuntime(
  deps: PlanBoardRuntimeDeps,
): PlanBoardRuntime {
  let block: BlockHandle | null = null;
  let lastSnapshot: string[] | null = null;

  const removeBlock = (): void => {
    if (!block) return;
    deps.chatLines.splice(block.start, block.length);
    block = null;
    lastSnapshot = null;
  };

  const writeBlock = (lines: string[]): void => {
    if (!block) {
      const start = deps.chatLines.length;
      deps.chatLines.push(...lines);
      block = { start, length: lines.length };
    } else {
      deps.chatLines.splice(block.start, block.length, ...lines);
      block = { start: block.start, length: lines.length };
    }
    lastSnapshot = lines;
  };

  return {
    apply(state) {
      const lines = renderPlanBoard(state, { noColor: deps.noColor === true });
      if (lines.length === 0) {
        if (block) {
          removeBlock();
          deps.pinChatTail();
          deps.draw();
        }
        return;
      }
      // Idempotent — skip redraw if rendered output is identical.
      if (
        lastSnapshot
        && lastSnapshot.length === lines.length
        && lastSnapshot.every((l, i) => l === lines[i])
      ) {
        return;
      }
      writeBlock(lines);
      deps.pinChatTail();
      deps.draw();
    },
    reset() {
      if (block) {
        removeBlock();
        deps.pinChatTail();
        deps.draw();
      }
    },
    _linesForTest: () => (lastSnapshot ? [...lastSnapshot] : null),
  };
}

/** Convenience wiring helper — subscribes the runtime to plan
 *  updates. Returns the unsubscribe function for test teardown. */
export function wirePlanBoardRuntime(runtime: PlanBoardRuntime): () => void {
  return subscribePlanUpdate((state) => {
    try {
      runtime.apply(state);
    } catch {
      /* swallow — never break the tool loop */
    }
  });
}
