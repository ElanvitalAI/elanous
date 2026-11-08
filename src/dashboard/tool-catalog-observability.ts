import type { LLMToolSpec } from '../llm/tool-spec.js';

import { debug } from '../debug/log.js';
import { buildSessionRuntimeToolSpecs } from '../session-runtime/index.js';

/** Records an assembled tool catalog so membership queries distinguish absent from unmeasured. */
export function recordToolCatalog(
  sessionId: string | null,
  surface: string,
  assembler: { name: string },
  tools: readonly LLMToolSpec[],
): void {
  debug.log('capability.resolve', 'tool-catalog-assembled', {
    sessionId,
    surface,
    assembler: assembler.name,
    toolCount: tools.length,
    tools: tools.map((tool) => tool.name),
  }, {
    // Tool names are the membership evidence, so neither arrays nor names may compact.
    compact: { arrayMax: Number.MAX_SAFE_INTEGER, stringMax: Number.MAX_SAFE_INTEGER },
  });
}

/** Records the catalog assembled for the in-process TUI dashboard turn. */
export function recordDashboardToolCatalog(
  sessionId: string,
  tools: readonly LLMToolSpec[],
): void {
  recordToolCatalog(sessionId, 'tui-dashboard', buildSessionRuntimeToolSpecs, tools);
}
