import type { AgentRoomRegistry } from './registry.js';
import type { PolicyDecideFn, ResolvedBrand } from './brand-resolver.js';
import type { AgentRoomInstance, AgentRoomSpec } from './types.js';

export interface BuildRoomDeps {
  readonly registry?: AgentRoomRegistry;
  readonly policyDecide?: PolicyDecideFn;
}

export interface BuildRoomResult {
  readonly room: AgentRoomInstance;
  readonly resolvedBrands: readonly ResolvedBrand[];
  readonly warnings: readonly string[];
}

export async function buildAgentRoom(
  _spec: AgentRoomSpec,
  _deps: BuildRoomDeps = {},
): Promise<BuildRoomResult> {
  throw new Error('agent rooms need the removed rich TUI (virtual windows)');
}
