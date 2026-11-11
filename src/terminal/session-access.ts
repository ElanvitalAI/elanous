// Shared terminal session registry used by classic dashboard and skill tools.
// The dashboard initializes it once at boot; headless callers receive a
// specific error until that initialization has happened.

import { TerminalSessionRegistry } from './session-registry.js';
import type { DisplayCoordinator } from '../display/coordinator.js';
import type { DisplayEventBus } from '../display/events.js';

let registry: TerminalSessionRegistry | null = null;

export function initDashboardTerminalSessions(
  coordinator: DisplayCoordinator,
  eventBus?: DisplayEventBus,
): TerminalSessionRegistry {
  registry = new TerminalSessionRegistry({ coordinator, eventBus });
  return registry;
}

export function getDashboardTerminalSessions(): TerminalSessionRegistry {
  if (!registry) {
    throw new Error(
      'dashboard terminal session registry not initialized — call initDashboardTerminalSessions first',
    );
  }
  return registry;
}

/** Test-only reset so unit tests don't leak state between cases. */
export function _resetDashboardTerminalSessionsForTesting(): void {
  registry = null;
}
