import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runGraph, type GraphRunState } from '../graph-runner/runner.js';
import type { InProcessHandlerRegistry } from '../graph-runner/in-process-registry.js';

export type DemoSceneNumber = 1 | 2 | 3 | 4 | 5 | 6;

/** A receipt identifies an actual scene execution; a recording or storyboard has no sceneRunId. */
export interface DemoSceneReceipt {
  readonly scene: DemoSceneNumber;
  readonly status: 'done' | 'failed';
  readonly rootRunId: string;
  readonly sceneRunId: string;
  readonly memberId: string;
  readonly sourceScrapId: string;
  readonly sourceCommit: string;
  readonly deviceId: string;
  readonly registryCatalogVersion: number;
  readonly deviceCatalogVersion: number;
  readonly evidencePath: string;
}

export interface DemoSceneContext {
  readonly rootRunId: string;
  readonly memberId: string;
  readonly sourceCommit: string;
  readonly previous: readonly DemoSceneReceipt[];
}

export type DemoSceneAdapter = (context: DemoSceneContext) => Promise<DemoSceneReceipt>;

export interface DemoRootRunOptions {
  readonly root: string;
  readonly memberId: string;
  readonly sourceCommit: string;
  readonly registryCatalogVersion: number;
  readonly deviceCatalogVersion: number;
  readonly deviceIds: Readonly<Record<DemoSceneNumber, string>>;
  readonly scenes: Readonly<Record<DemoSceneNumber, DemoSceneAdapter>>;
  readonly runId?: string;
}

const graph = resolve(fileURLToPath(new URL('../../graphs/demo/integrated-ticketing-run.yaml', import.meta.url)));
const sha = /^[a-f0-9]{40}$/i;

/** Execute all six observed scene adapters inside one durable production graph run. */
export async function runDemo1114Root(options: DemoRootRunOptions): Promise<{
  readonly graph: GraphRunState;
  readonly scenes: readonly DemoSceneReceipt[];
}> {
  if (!options.memberId.trim() || !sha.test(options.sourceCommit)
    || !Number.isSafeInteger(options.registryCatalogVersion) || options.registryCatalogVersion < 1
    || !Number.isSafeInteger(options.deviceCatalogVersion) || options.deviceCatalogVersion < 1
    || ([1, 2, 3, 4, 5, 6] as const).some(scene => !options.deviceIds[scene]?.trim()))
    throw new Error('demo root identity or device plan is invalid');
  const receipts: DemoSceneReceipt[] = [];
  const handlers: Record<string, InProcessHandlerRegistry[string]> = {};
  for (const scene of [1, 2, 3, 4, 5, 6] as const) {
    handlers[`demo-scene-${scene}`] = async ({ runId }) => {
      try {
        const receipt = await options.scenes[scene]({ rootRunId: runId,
          memberId: options.memberId, sourceCommit: options.sourceCommit, previous: [...receipts] });
        const prior = receipts.at(-1);
        if (receipt.scene !== scene || receipt.status !== 'done' || receipt.rootRunId !== runId
          || receipt.memberId !== options.memberId || receipt.sourceCommit !== options.sourceCommit
          || !receipt.sceneRunId.trim() || !receipt.evidencePath.trim()
          || receipt.deviceId !== options.deviceIds[scene]
          || receipt.registryCatalogVersion !== options.registryCatalogVersion
          || receipt.deviceCatalogVersion !== options.deviceCatalogVersion
          || !receipt.sourceScrapId.trim() || (prior && receipt.sourceScrapId !== prior.sourceScrapId))
          throw new Error(`scene-${scene} receipt does not prove the same execution`);
        const observed = JSON.parse(readFileSync(receipt.evidencePath, 'utf8')) as Partial<DemoSceneReceipt>;
        for (const key of ['scene', 'status', 'rootRunId', 'sceneRunId', 'memberId', 'sourceScrapId',
          'sourceCommit', 'deviceId', 'registryCatalogVersion', 'deviceCatalogVersion'] as const) {
          if (observed[key] !== receipt[key]) throw new Error(`scene-${scene} evidence mismatch: ${key}`);
        }
        receipts.push(receipt);
        return { ok: true, outcome: 'ok', result: receipt,
          evidence: { sceneRunId: receipt.sceneRunId, deviceId: receipt.deviceId,
            registryCatalogVersion: receipt.registryCatalogVersion,
            deviceCatalogVersion: receipt.deviceCatalogVersion } };
      } catch (error) {
        return { ok: false, outcome: 'fail', error: error instanceof Error ? error.message : String(error) };
      }
    };
  }
  const state = await runGraph(graph, {
    ...(options.runId ? { runId: options.runId } : {}),
    input: { memberId: options.memberId, sourceCommit: options.sourceCommit },
    quiet: true,
    deps: { root: options.root, inProcessHandlers: handlers },
  });
  return { graph: state, scenes: receipts };
}
