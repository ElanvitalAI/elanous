import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import type { BrowserHandArgs, BrowserHandDeps, BrowserHandResult } from '../tool-runtime/browser-hand-runtime.js';

export type BrowserHandRunner = (args: BrowserHandArgs, ctx?: ToolRuntimeContext, deps?: BrowserHandDeps) => Promise<BrowserHandResult>;

export interface HumanBrowserSelection {
  /** Linear subtask chosen by the person for this browser roundtrip. */
  linearSubtaskId: string;
  /** Whether the person also chose page content to reflect in that subtask. */
  includeThisToo?: boolean;
  /** Optional text/tab the person explicitly selected to reflect in that subtask. */
  selection?: { text?: string; tab?: string };
}

export interface BrowserRoundtripRequest extends Omit<BrowserHandArgs, 'linearSubtaskId' | 'selection' | 'includeThisToo'> {
  includeThisToo?: boolean;
  humanSelection?: HumanBrowserSelection;
}

export interface BrowserRoundtripResult {
  scene: 'browser-roundtrip';
  selectedSubtaskId: string | null;
  sourceUrl: string;
  result: BrowserHandResult;
}

/**
 * Coordinates the demo's human-selected browser handoff through the production
 * BrowserHand safety path. BrowserHand owns approval, host checks, one safe
 * alternate-source attempt, capture, and the optional Linear reflection.
 */
export async function coordinateBrowserRoundtrip(
  request: BrowserRoundtripRequest,
  deps: BrowserHandDeps,
  runBrowserHand: BrowserHandRunner,
  ctx?: ToolRuntimeContext,
): Promise<BrowserRoundtripResult> {
  const selection = request.humanSelection;
  if (!selection) {
    return {
      scene: 'browser-roundtrip',
      selectedSubtaskId: null,
      sourceUrl: request.url,
      result: {
        ok: false,
        reason: 'human-selection-required',
        output: '사람이 Linear 서브태스크를 선택해야 브라우저 왕복을 시작합니다.',
      },
    };
  }

  const selectedSubtaskId = selection.linearSubtaskId.trim();
  if (!selectedSubtaskId) {
    return {
      scene: 'browser-roundtrip',
      selectedSubtaskId: null,
      sourceUrl: request.url,
      result: {
        ok: false,
        reason: 'invalid-input',
        output: 'Linear 서브태스크 UUID가 필요합니다.',
      },
    };
  }
  const args: BrowserHandArgs = {
    url: request.url,
    target: request.target,
    armed: request.armed,
    linearSubtaskId: selectedSubtaskId,
    ...(request.persona ? { persona: request.persona } : {}),
    ...(request.alternateUrl ? { alternateUrl: request.alternateUrl } : {}),
    ...(request.includeThisToo !== undefined
      ? { includeThisToo: request.includeThisToo }
      : selection.includeThisToo !== undefined ? { includeThisToo: selection.includeThisToo } : {}),
    // Empty selection objects mean that no page text/tab was chosen; only explicit content is forwarded.
    ...(selection.selection ? { selection: selection.selection } : {}),
  };
  const result = await runBrowserHand(args, ctx, deps);
  return {
    scene: 'browser-roundtrip',
    selectedSubtaskId,
    sourceUrl: result.repairNode?.detourUrl || request.url,
    result,
  };
}
