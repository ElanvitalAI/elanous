import { isToolSearchCall } from '../skills/tools/tool-search-route.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import type { ToolRuntimeContext, ToolRunResult } from '../tool-runtime/types.js';

/** Keep ToolSearch discovery scoped to the catalog assembled for this classic TUI turn. */
export function dispatchClassicTuiTool(
  dispatch: (name: string, input: Record<string, unknown>, context: ToolRuntimeContext) => Promise<ToolRunResult>,
  name: string,
  input: Record<string, unknown>,
  context: ToolRuntimeContext,
  surfaceSpecs: readonly LLMToolSpec[],
): Promise<ToolRunResult> {
  const dispatchContext: ToolRuntimeContext = { ...context };
  delete dispatchContext.surfaceSpecs;
  if (isToolSearchCall(name)) dispatchContext.surfaceSpecs = surfaceSpecs;
  return dispatch(name, input, dispatchContext);
}

/** Put ToolSearch within the model-visible prefix when this dashboard TUI catalog is capped. */
export function prioritizeDashboardTuiToolSearch(specs: readonly LLMToolSpec[]): LLMToolSpec[] {
  const search = specs.filter((spec) => isToolSearchCall(spec.name));
  return [...search, ...specs.filter((spec) => !isToolSearchCall(spec.name))];
}
