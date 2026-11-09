import type { AppSimulationResult, AppSimulationSnapshot } from './app-simulation.js';
import type { AppSimulationStore } from './app-simulation-db.js';
import { runRegisteredAppSimulation } from './app-simulation-runner.js';

export function createAppSimulationRoute(input: {
  readonly store: AppSimulationStore;
  readonly authorize: (request: Request, appSlug: string) => boolean | Promise<boolean>;
  readonly publish: (event: { kind: 'app.sim.step'; detail: Record<string, unknown> }) => void;
  readonly hasApp: (appSlug: string) => boolean;
  readonly runSimulation?: (appSlug: string) => AppSimulationResult | Promise<AppSimulationResult>;
  readonly observeError?: (error: unknown) => void;
}): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const match = /^\/v1\/apps\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/simulations\/run$/.exec(new URL(request.url).pathname);
    if (!match) return undefined;
    const appSlug = match[1]!;
    if (request.method !== 'POST') return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    if (!await input.authorize(request, appSlug)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (!input.hasApp(appSlug)) return Response.json({ error: 'app-not-found' }, { status: 404 });
    try {
      const result = await (input.runSimulation ?? runRegisteredAppSimulation)(appSlug);
      input.store.record(result);
      for (const event of result.events.filter(row => row.appId === appSlug)) {
        input.publish({ kind: event.kind, detail: { appId: event.appId, runId: event.runId, ts: event.ts, data: event.data } });
      }
      const snapshot: AppSimulationSnapshot = input.store.snapshot(appSlug);
      return Response.json({ ok: true, simulation: snapshot }, { status: 200, headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      input.observeError?.(error);
      return Response.json({ error: 'app-simulation-failed' }, { status: 502 });
    }
  };
}
