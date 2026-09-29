// PWA · Nexus React Query key factories (Phase N-4 PR ξ)
//
// All hooks share the same key namespace. Pure functions so unit tests
// can assert key shape + cache invalidation patterns without React.

import type { NexusTabKind } from '../types';

export const nexusKeys = {
  all: ['nexus'] as const,
  health:           () => [...nexusKeys.all, 'health'] as const,
  snapshot:         () => [...nexusKeys.all, 'snapshot'] as const,
  tabs:             (kind?: NexusTabKind) => kind ? [...nexusKeys.all, 'tabs', { kind }] as const : [...nexusKeys.all, 'tabs'] as const,
  tab:              (id: string) => [...nexusKeys.all, 'tab', id] as const,
  templates:        () => [...nexusKeys.all, 'templates'] as const,
  template:         (name: string) => [...nexusKeys.all, 'template', name] as const,
  config:           () => [...nexusKeys.all, 'config'] as const,
  switches:         () => [...nexusKeys.all, 'switches'] as const,
  switch:           (id: string) => [...nexusKeys.all, 'switch', id] as const,
  secrets:          () => [...nexusKeys.all, 'secrets'] as const,
  bindingChannels:  () => [...nexusKeys.all, 'bindings', 'channels'] as const,
  bindings:         (channel: string) => [...nexusKeys.all, 'bindings', channel] as const,
  binding:          (channel: string, key: string) => [...nexusKeys.all, 'binding', channel, key] as const,
  logsTail:         (id: string, lines?: number) => lines ? [...nexusKeys.all, 'logs', id, { lines }] as const : [...nexusKeys.all, 'logs', id] as const,
  // Archon-port T2A workflow keys.
  workflows:        () => [...nexusKeys.all, 'workflows'] as const,
  workflow:         (name: string) => [...nexusKeys.all, 'workflow', name] as const,
  workflowRun:      (runId: string) => [...nexusKeys.all, 'workflow-run', runId] as const,
  workflowRuns:     () => [...nexusKeys.all, 'workflow-runs'] as const,
  pendingApprovals: () => [...nexusKeys.all, 'workflow-pending-approvals'] as const,
  platforms:        () => [...nexusKeys.all, 'platforms'] as const,
  providers:        () => [...nexusKeys.all, 'providers'] as const,
  worktrees:        () => [...nexusKeys.all, 'worktrees'] as const,
  designCheck:      () => [...nexusKeys.all, 'design-check'] as const,
  designPreviews:   () => [...nexusKeys.all, 'design-previews'] as const,
  designPreview:    (system: string) => [...nexusKeys.all, 'design-preview', system] as const,
  // RFC #2161 Phase 3 — Layer A static catalog snapshot. Phase 5 adds
  // a sibling `resolvedView` key for live (apiKey/health) state.
  registryCatalog:  () => [...nexusKeys.all, 'registry-catalog'] as const,
  resolvedView:     () => [...nexusKeys.all, 'resolved-view'] as const,
} as const;

/** SSE event.kind prefix → query keys to invalidate. */
export const eventInvalidationMap: Record<string, readonly (readonly unknown[])[]> = {
  'tab.':           [nexusKeys.snapshot(), nexusKeys.tabs()],
  'nexus.':         [nexusKeys.health(), nexusKeys.snapshot()],
  'config.':        [nexusKeys.config(), nexusKeys.switches()],
};

/** Returns the list of query keys that should be invalidated when an
 *  event with the given kind arrives. */
export function invalidationsForEvent(kind: string): (readonly unknown[])[] {
  const out: (readonly unknown[])[] = [];
  for (const [prefix, keys] of Object.entries(eventInvalidationMap)) {
    if (kind.startsWith(prefix)) out.push(...keys);
  }
  return out;
}
