import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSimulationResult, AppSimulationSnapshot } from './app-simulation.js';
import type { AppSimulationStore } from './app-simulation-db.js';
import { parseAppManifest, type AppManifest } from './app-contract.js';
import { runDeclaredAppSimulation, runRegisteredAppSimulation, type AppSimulationRun } from './app-simulation-runner.js';
import { buildConceptProofReceipt, currentSimDeviceCatalogVersion } from '../../ux-sim/sim-receipt.js';

function flattenDeclaredRun(run: AppSimulationRun): AppSimulationResult {
  const runId = `simkit-${randomUUID()}`;
  const receiptId = `simkit-receipt-${randomUUID()}`;
  const events = run.scenarios.flatMap(scenario => scenario.result.events
    .filter(event => event.appId === run.appSlug)
    .map(event => ({ ...event, runId, data: { ...event.data, receiptId } })));
  if (!events.length || !run.scenarios.length) throw new Error('declared simulation omitted app evidence');
  const summary = run.passed ? 'all declared app.yaml scenarios passed' : 'one or more declared app.yaml scenarios failed';
  return { runId, events, receipts: [{ id: receiptId, appId: run.appSlug, runId,
    outcome: run.passed ? 'passed' : 'failed', summary }] };
}

export function createAppSimulationRoute(input: {
  readonly store: AppSimulationStore;
  readonly authorize: (request: Request, appSlug: string) => boolean | Promise<boolean>;
  readonly publish: (event: { kind: 'app.sim.step'; detail: Record<string, unknown> }) => void;
  readonly hasApp: (appSlug: string) => boolean;
  readonly getManifest?: (appSlug: string) => AppManifest | undefined;
  readonly appSourceRoot?: (appSlug: string) => string;
  /** Uses the same source snapshot fingerprint as live promotion. */
  readonly fingerprintApp?: (appSlug: string) => string;
  readonly withSourceLock?: <T>(appSlug: string, run: (assertHeld: () => void) => T | Promise<T>) => Promise<T>;
  readonly runDeclaredSimulation?: (appSlug: string) => Promise<AppSimulationRun>;
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
      const run = async (assertLockHeld: () => void = () => undefined) => {
        const beforeFingerprint = input.fingerprintApp?.(appSlug);
        const sourceRoot = input.appSourceRoot?.(appSlug);
        const parsedSourceManifest = sourceRoot
          ? parseAppManifest(readFileSync(join(sourceRoot, 'app.yaml'), 'utf8'))
          : undefined;
        if (parsedSourceManifest && !parsedSourceManifest.ok) throw new Error('app simulation manifest is invalid');
        const manifest = parsedSourceManifest?.ok ? parsedSourceManifest.manifest : input.getManifest?.(appSlug);
        const declaredScenarios = manifest?.simulate && typeof manifest.simulate === 'object' && !Array.isArray(manifest.simulate)
          ? (manifest.simulate as { scenarios?: unknown }).scenarios : undefined;
        const declaredRun = !input.runSimulation && Array.isArray(declaredScenarios) && declaredScenarios.length > 0
          ? input.runDeclaredSimulation
            ? await input.runDeclaredSimulation(appSlug)
            : await runDeclaredAppSimulation({ manifest: manifest! })
          : undefined;
        const rawResult = declaredRun
          ? flattenDeclaredRun(declaredRun)
          : await (input.runSimulation ?? runRegisteredAppSimulation)(appSlug);
        const afterFingerprint = input.fingerprintApp?.(appSlug);
        if (beforeFingerprint !== afterFingerprint) throw new Error('app source changed during simulation');
        const result = {
          runId: rawResult.runId,
          events: rawResult.events.filter(event => event.appId === appSlug),
          receipts: rawResult.receipts.filter(receipt => receipt.appId === appSlug)
            .map(receipt => beforeFingerprint === undefined ? receipt : { ...receipt, appFingerprint: beforeFingerprint }),
        };
        if (!result.events.length || !result.receipts.length) throw new Error('simulation omitted requested app evidence');
        assertLockHeld();
        if (declaredRun && beforeFingerprint && input.appSourceRoot) {
          const proofReceiptId = result.receipts[0]!.id;
          input.store.recordWithConceptProof(result, proofReceiptId, storedReceipt => buildConceptProofReceipt({
            simulationReceipt: storedReceipt,
            currentAppFingerprint: afterFingerprint ?? '',
            appSourceRoot: input.appSourceRoot!(appSlug),
            deviceCatalogVersion: currentSimDeviceCatalogVersion(),
            scenarioResults: declaredRun.scenarios.map(scenario => ({
              id: scenario.name,
              outcome: scenario.passed ? 'passed' as const : 'failed' as const,
            })),
            sandboxEstablished: declaredRun.networkEvidence.sandboxEstablished,
            externalNetworkAttempts: declaredRun.networkEvidence.externalNetworkAttempts,
            blockedNetworkAttempts: declaredRun.networkEvidence.blockedNetworkAttempts,
            unmeasuredCount: declaredRun.networkEvidence.unmeasuredCount,
            eventLedgerPath: `app-simulation.sqlite#${result.runId}`,
          }));
        } else {
          input.store.record(result);
        }
        for (const event of result.events.filter(row => row.appId === appSlug)) {
          input.publish({ kind: event.kind, detail: { appId: event.appId, runId: event.runId, ts: event.ts, data: event.data } });
        }
        const snapshot: AppSimulationSnapshot = input.store.snapshot(appSlug);
        return Response.json({ ok: true, simulation: snapshot }, { status: 200, headers: { 'cache-control': 'no-store' } });
      };
      return input.withSourceLock ? await input.withSourceLock(appSlug, assertHeld => run(assertHeld)) : await run();
    } catch (error) {
      input.observeError?.(error);
      return Response.json({ error: 'app-simulation-failed' }, { status: 502 });
    }
  };
}
