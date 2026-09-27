import type { FoldMode } from '../../log-entry.js';
import type { ChatRenderingToolDisplayMode } from '../../user-config.js';

export type ToolRenderName =
  | 'Bash'
  | 'Read'
  | 'Grep'
  | 'Glob'
  | 'ListDir'
  | 'Edit'
  | 'Write'
  | 'Agent'
  | 'AstGrep'
  | 'UpdatePlan'
  | 'UpdateGoal'
  | 'Lsp'
  | 'RunShell'
  | 'WebSearch'
  | 'WebFetch'
  | 'GetDashboardState';
export type ToolRenderStatus = 'running' | 'success' | 'error';

export interface ToolRenderConfig {
  displayMode: ChatRenderingToolDisplayMode;
  blockMaxLines: number;
  /** Fold strategy for collapsed tool bodies. Default `'line'` keeps the
   *  existing line-budget truncation; `'task-unit'` hides a multi-line body
   *  as one work unit; `'kind-unit'` carries operationKind for adjacent
   *  same-kind coalescing. Omitted = `'line'`. Expanded rendering ignores this. */
  foldMode?: FoldMode;
  /** When true, collapsed foldHint keeps the rich-mode "press f to expand"
   *  suffix. Omitted/false = count-only (essential/unknown). Expanded
   *  rendering ignores this. Dashboard producers pass
   *  `mode === 'rich'`. */
  expandHint?: boolean;
}

export interface ToolRenderCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolRenderResult extends ToolRenderCall {
  result: unknown;
}

export interface ToolRenderModel {
  kind: string;
  status: ToolRenderStatus;
  summary: string;
  collapsedSummary?: string;
  bodyLines: string[];
  /** kind-unit only: semantic operation kind used as the adjacent-group identity. */
  operationKind?: string;
}

export interface ToolRenderResultVariants {
  collapsed: string[];
  expanded: string[] | null;
  /** kind-unit only: grouping identity forwarded to presentation events. */
  operationKind?: string;
}
