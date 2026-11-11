import type { DashboardSession } from '../tui-client/dashboard-session.js';

/** Production runtime injected into the isolated classic autoheal simulation. */
export interface Tui400Runtime {
  boot: (deps: unknown) => Promise<{ session: DashboardSession }>;
  runPlainTurn: (deps: unknown) => Promise<void>;
  createAutoheal: (deps: unknown) => unknown;
}
