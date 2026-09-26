import type { DashboardAssistantRenderState } from './assistant-render-state-runtime.js';
import { commitDashboardAssistantRenderState } from './turn-tail-runtime.js';

export interface DashboardAssistantSampleDeps {
  chatLines: string[];
  text: string;
  termCols: number;
  wrapEnabled: { urlAware?: boolean };
  formatResponse: (
    full: string,
    width: number,
    wrapOpts?: { urlAware?: boolean },
  ) => string[];
  renderTextLine: (line: string) => string;
}

export function appendDashboardAssistantSampleOutput(
  deps: DashboardAssistantSampleDeps,
): DashboardAssistantRenderState {
  const assistantStart = deps.chatLines.length;
  const wrapWidth = Math.max(40, deps.termCols - 8);
  const nextLines = deps.formatResponse(deps.text, wrapWidth - 2, deps.wrapEnabled)
    .map((line) => deps.renderTextLine(line));
  deps.chatLines.push(...nextLines);
  return commitDashboardAssistantRenderState(deps.text, assistantStart, deps.chatLines.length);
}
