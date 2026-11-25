// DirectiveSearch — read-only seat tool over the owner's utterance index (src/skills/tools/directive-search.ts).
import { buildDirectiveSearchTool, dispatchDirectiveSearch, type DirectiveSearchResult } from '../skills/tools/directive-search.js';
import type { ToolRuntime } from './types.js';

export const directiveSearchRuntime: ToolRuntime<Record<string, unknown>, DirectiveSearchResult> = {
  id: 'directive_search',
  spec: buildDirectiveSearchTool(),
  async run(req) { return dispatchDirectiveSearch(req); },
};
