import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { runDemo1114Root, type DemoSceneNumber, type DemoSceneReceipt } from '../src/ux-sim/demo-1114-root-run.js';

const runFile = promisify(execFile);

interface SceneCommand {
  readonly entryFile: string;
  readonly cwd: string;
  readonly receiptPath: string;
  readonly args?: readonly string[];
}

interface DemoRootPlan {
  readonly registryUrl: string;
  readonly root: string;
  readonly memberId: string;
  readonly sourceCommit: string;
  readonly registryCatalogVersion: number;
  readonly deviceCatalogVersion: number;
  readonly deviceIds: Readonly<Record<DemoSceneNumber, string>>;
  readonly sceneCommands: Readonly<Record<DemoSceneNumber, SceneCommand>>;
}

const EXPECTED_REGISTRY_CATALOG_VERSION = 2;
const EXPECTED_DEVICE_CATALOG_VERSION = 32;

/** Run each supplied operating scene entry inside the durable graph node, then read its saved receipt. */
export async function runDemo1114RootPlan(plan: DemoRootPlan) {
  if (!isAbsolute(plan.root)) throw new Error('demo root path must be absolute');
  const registryUrl = new URL(plan.registryUrl);
  if (!/^https?:$/.test(registryUrl.protocol) || registryUrl.pathname !== '/v1/ux-sim/devices'
    || registryUrl.username || registryUrl.password || registryUrl.search || registryUrl.hash)
    throw new Error('demo device registry URL is invalid');
  if (registryUrl.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(registryUrl.hostname))
    throw new Error('demo device registry HTTP requires loopback');
  const bearer = process.env.DEMO_DEVICE_REGISTRY_BEARER?.trim();
  if (!bearer) throw new Error('demo device registry bearer is required');
  if (plan.registryCatalogVersion !== EXPECTED_REGISTRY_CATALOG_VERSION
    || plan.deviceCatalogVersion !== EXPECTED_DEVICE_CATALOG_VERSION)
    throw new Error('demo device plan has untrusted catalog versions');
  const registryResponse = await fetch(registryUrl, {
    headers: { authorization: `Bearer ${bearer}` }, redirect: 'error',
  });
  if (!registryResponse.ok) throw new Error(`demo device registry returned ${registryResponse.status}`);
  const registry = await registryResponse.json() as { catalogVersion?: unknown;
    deviceCatalogVersion?: unknown; devices?: Array<{ id?: unknown }> };
  const registered = new Set((registry.devices ?? []).map(row => row.id));
  if (registry.catalogVersion !== EXPECTED_REGISTRY_CATALOG_VERSION
    || registry.deviceCatalogVersion !== EXPECTED_DEVICE_CATALOG_VERSION
    || ([1, 2, 3, 4, 5, 6] as const).some(scene => !registered.has(plan.deviceIds[scene])))
    throw new Error('demo device registry does not match the pinned plan');
  const scenes = {} as Record<DemoSceneNumber, (input: { rootRunId: string; memberId: string;
    sourceCommit: string; previous: readonly DemoSceneReceipt[] }) => Promise<DemoSceneReceipt>>;
  for (const scene of [1, 2, 3, 4, 5, 6] as const) {
    const command = plan.sceneCommands[scene];
    if (!command || !isAbsolute(command.entryFile) || !isAbsolute(command.cwd)
      || !isAbsolute(command.receiptPath) || (command.args && !command.args.every(arg => typeof arg === 'string')))
      throw new Error(`scene-${scene} command is invalid`);
    scenes[scene] = async ({ rootRunId, memberId, sourceCommit, previous }) => {
      const childEnv = { ...process.env };
      delete childEnv.DEMO_DEVICE_REGISTRY_BEARER;
      await runFile('bun', [command.entryFile, ...(command.args ?? [])], {
        cwd: command.cwd, timeout: 900_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...childEnv, DEMO_ROOT_RUN_ID: rootRunId, DEMO_SCENE: String(scene),
          DEMO_MEMBER_ID: memberId, DEMO_SOURCE_COMMIT: sourceCommit,
          DEMO_SOURCE_SCRAP_ID: previous.at(-1)?.sourceScrapId ?? '',
          DEMO_SCENE_RECEIPT_PATH: command.receiptPath },
      });
      const receipt = JSON.parse(readFileSync(command.receiptPath, 'utf8')) as DemoSceneReceipt;
      if (receipt.evidencePath !== command.receiptPath) throw new Error(`scene-${scene} receipt path differs from plan`);
      return receipt;
    };
  }
  return runDemo1114Root({ ...plan, scenes });
}

if (import.meta.main) {
  const planPath = process.argv[2];
  if (!planPath || process.argv.length !== 3 || !isAbsolute(planPath))
    throw new Error('usage: bun scripts/demo1114-root-run.ts <absolute-plan.json>');
  const result = await runDemo1114RootPlan(JSON.parse(readFileSync(planPath, 'utf8')) as DemoRootPlan);
  process.stdout.write(`${JSON.stringify({ rootRunId: result.graph.runId, status: result.graph.status,
    scenes: result.scenes.map(row => ({ scene: row.scene, sceneRunId: row.sceneRunId,
      evidencePath: row.evidencePath })) })}\n`);
  if (result.graph.status !== 'done') process.exitCode = 1;
}
