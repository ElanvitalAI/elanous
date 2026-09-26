export interface DashboardAssistantRenderState {
  lastAssistantRaw: string | null;
  lastAssistantRange: { start: number; end: number } | null;
  lastAssistantMode: 'rendered' | 'raw';
}

export interface ToggleDashboardAssistantRenderStateDeps {
  state: DashboardAssistantRenderState;
  termCols: number;
  // chat.rendering.wrap 는 boolean 이 아니라 wrap 옵션 오브젝트로 이관됨.
  wrapOpts: { urlAware?: boolean };
  chatLines: string[];
  formatResponse: (full: string, width: number, wrapOpts?: { urlAware?: boolean }) => string[];
  text: (line: string) => string;
}

export interface ToggleDashboardAssistantRenderStateResult {
  nextState: DashboardAssistantRenderState;
  applied: boolean;
}

export function toggleDashboardAssistantRenderState(
  deps: ToggleDashboardAssistantRenderStateDeps,
): ToggleDashboardAssistantRenderStateResult {
  if (deps.state.lastAssistantRaw === null || deps.state.lastAssistantRange === null) {
    return { nextState: deps.state, applied: false };
  }

  const nextMode: 'rendered' | 'raw' =
    deps.state.lastAssistantMode === 'rendered' ? 'raw' : 'rendered';
  const wrapWidth = Math.max(20, deps.termCols - 6);
  const nextLines = nextMode === 'rendered'
    ? deps.formatResponse(deps.state.lastAssistantRaw, wrapWidth, deps.wrapOpts).map((line) => deps.text(line))
    : deps.state.lastAssistantRaw.split('\n').map((line) => deps.text(line));
  const oldLen = deps.state.lastAssistantRange.end - deps.state.lastAssistantRange.start;
  deps.chatLines.splice(deps.state.lastAssistantRange.start, oldLen, ...nextLines);

  return {
    applied: true,
    nextState: {
      lastAssistantRaw: deps.state.lastAssistantRaw,
      lastAssistantRange: {
        start: deps.state.lastAssistantRange.start,
        end: deps.state.lastAssistantRange.start + nextLines.length,
      },
      lastAssistantMode: nextMode,
    },
  };
}
