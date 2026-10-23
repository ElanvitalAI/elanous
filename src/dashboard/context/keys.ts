// IDX-2b — singleton ContextKeyService owned by the dashboard.
//
// One instance per runtime. Dashboard wires it into:
//   - resolver deps (ResolverDeps.getContextKeys)
//   - mountViewAsModalSurface hooks (via spec.contextKeyService fallback)
//   - PFC bridges (auto-mode / andon)
//   - LLM introspection tools (IDX-4: GetInputPolicy V2)
//
// Why a module-level singleton: every surface that needs to update
// keys lives in a different subsystem (chat.ts, mouseWiring,
// terminalModalRouter, auto-research, cft/andon). Passing a service
// instance through every boundary clutters signatures; a singleton
// with a single reset hook for tests is pragmatic here.

import type { ContextKeyService, ContextKeys } from '../../input-core/context-keys.js';
import { getRuntimeContextKeyService, getRuntimeContextKeys, resetRuntimeContextKeysForTests, updateRuntimeContextKeys } from '../../input-core/context-key-runtime.js';

/** Dashboard-facing names remain stable while the singleton lives in the shared input layer. */
export const getDashboardContextKeyService = getRuntimeContextKeyService;
export const getDashboardContextKeys = getRuntimeContextKeys;
export const updateDashboardContextKeys = updateRuntimeContextKeys;
export const __resetDashboardContextKeysForTests = resetRuntimeContextKeysForTests;
export type { ContextKeyService, ContextKeys };
