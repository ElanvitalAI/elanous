// NEXUS · /v1/nexus + /v1/nexus/tabs routes (Phase N-1 PR δ — read-only)

import type { NexusState } from '../state/state.js';
import type { TabRegistry } from '../state/tab-registry.js';
import type { TabKind } from '../kinds/types.js';
import { jsonResponse } from './json-response.js';

// Surface-unification v2.2 V2.2-8 (2026-05-11) — 'scheduler' kind retired.
const VALID_KINDS: ReadonlySet<TabKind> = new Set([
  'chat', 'webterm', 'daemon', 'pwa-host', 'channel-bot',
]);

export function handleNexusSnapshot(state: NexusState, registry: TabRegistry): Response {
  return jsonResponse({
    nexusVersion: state.nexusVersion,
    phase: state.phase,
    startedAt: state.startedAt,
    ...(state.template ? { template: state.template } : {}),
    tabs: registry.snapshot(),
    /** Tail of the event ring buffer (last 50). Full stream comes
     *  through SSE /v1/events. */
    recentEvents: state.events.slice(-50),
  });
}

export function handleTabsList(registry: TabRegistry, url: URL): Response {
  const kindParam = url.searchParams.get('kind');
  if (kindParam && !VALID_KINDS.has(kindParam as TabKind)) {
    return jsonResponse({ error: 'unknown-kind', kind: kindParam }, 400);
  }
  const tabs = kindParam
    ? registry.listByKind(kindParam as TabKind)
    : registry.list();
  return jsonResponse({ tabs: tabs.map((t) => ({ ...t, spec: { ...t.spec } })) });
}

export function handleTabDetail(registry: TabRegistry, state: NexusState, id: string): Response {
  const tab = registry.get(id);
  if (!tab) return jsonResponse({ error: 'tab-not-found', id }, 404);
  // Filter the recent event tail to the tab id so callers don't pull
  // the whole ring buffer for a per-tab view.
  const recent = state.events.filter((e) => e.tabId === id).slice(-25);
  return jsonResponse({ tab: { ...tab, spec: { ...tab.spec } }, recentEvents: recent });
}
