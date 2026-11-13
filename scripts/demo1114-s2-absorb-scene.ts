import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAbsorbGraphSimulation } from '../src/ux-sim/absorb-v2-runGraph-sim.js';
import { listAbsorbScraps } from '../src/intake-plane/items.js';

const worldPath = fileURLToPath(new URL('../plugins/absorb/sims/h12-s1-s2-same-root-world.yaml', import.meta.url));
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const sourceWires = { telegram: 'telegram', pwa: 'pwa', iphone: 'android-share' } as const;
export type Scene2SourceSurface = keyof typeof sourceWires;

function canonicalFuturePath(path: string): string {
  let parent = resolve(path);
  const missing: string[] = [];
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) throw new Error('scene-2 receipt path has no existing parent');
    missing.unshift(basename(parent));
    parent = next;
  }
  return resolve(realpathSync(parent), ...missing);
}

export function assertScene2Briefing(briefing: { id?: string; owner?: string; scrapIds?: string[] } | undefined,
  memberId: string, sourceScrapId: string, graphStatus: unknown) {
  if (graphStatus !== 'done' || !briefing?.id?.trim() || briefing.owner !== memberId
    || briefing.scrapIds?.length !== 1 || briefing.scrapIds[0] !== sourceScrapId)
    throw new Error('scene-2 briefing did not bind the Scene-1 scrap with a nonempty artifact ID');
  return briefing.id;
}

/** Scene 2 entry for the isolated root CLI; source identity comes from Scene 1, not a new fixture ID. */
export async function runScene2Absorb(input: { instanceRoot: string; sourceUrl: string; deviceId: string;
  rootRunId: string; memberId: string; sourceScrapId: string; sourceCommit: string; evidencePath: string;
  sourceSurface?: Scene2SourceSurface }) {
  if (!isAbsolute(input.instanceRoot) || !isAbsolute(input.evidencePath)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(input.rootRunId)
    || !/^[a-f0-9]{40}$/i.test(input.sourceCommit) || !/^[a-f0-9]{16}$/.test(input.sourceScrapId)
    || !input.memberId.trim() || input.deviceId !== 'fake-absorb-ingest' || !/^https?:\/\//.test(input.sourceUrl))
    throw new Error('scene-2 same-root identity is invalid');
  const sceneRunId = `${input.rootRunId}-s2`;
  const ledgerPath = join(input.instanceRoot, 'intake', 'items.jsonl');
  const artifactPath = join(input.instanceRoot, sceneRunId, 'graph-runs', 'absorb-brief', `${sceneRunId}.json`);
  const canonicalReceiptPath = canonicalFuturePath(input.evidencePath);
  if ([ledgerPath, artifactPath].some(path => canonicalFuturePath(path) === canonicalReceiptPath)
    || existsSync(input.evidencePath))
    throw new Error('scene-2 receipt path collides with an existing file or source artifact');
  const sourceSurface = input.sourceSurface ?? 'telegram';
  const expectedWire = sourceWires[sourceSurface];
  const source = listAbsorbScraps(input.instanceRoot, input.memberId).find(item => item.id === input.sourceScrapId);
  if (!source) throw new Error('same-root owner source scrap unavailable');
  if (!expectedWire || source.absorb?.source !== expectedWire)
    throw new Error('scene-2 source surface does not match the owner scrap wire source');
  const result = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true,
    worldPath, instanceRoot: input.instanceRoot, memberId: input.memberId,
    sourceScrapId: input.sourceScrapId, sourceUrl: input.sourceUrl,
    rootRunId: input.rootRunId, briefRunId: sceneRunId });
  const briefing = result.briefing as { id?: string; owner?: string; scrapIds?: string[] } | undefined;
  const briefingArtifactId = assertScene2Briefing(briefing, input.memberId, input.sourceScrapId, result.graphStatus);
  const artifactRaw = readFileSync(artifactPath, 'utf8');
  const artifact = JSON.parse(artifactRaw) as { input?: Record<string, unknown>;
    nodes?: Array<{ nodeId: string; output?: string }> };
  const briefNode = artifact.nodes?.find(node => node.nodeId === 'brief');
  const readback = JSON.parse(String(briefNode?.output)) as { evidence?: { briefing?: { id?: string; scrapIds?: string[] } } };
  if (artifact.input?.sourceScrapId !== input.sourceScrapId || artifact.input.rootRunId !== input.rootRunId
    || !readback.evidence?.briefing?.id?.trim()
    || readback.evidence.briefing.id !== briefingArtifactId
    || readback.evidence?.briefing?.scrapIds?.[0] !== input.sourceScrapId)
    throw new Error('scene-2 briefing artifact readback mismatch');
  const receipt = { scene: 2, status: 'done', rootRunId: input.rootRunId, sceneRunId,
    memberId: input.memberId, sourceScrapId: input.sourceScrapId, sourceCommit: input.sourceCommit,
    sourceSurface, sourceWire: expectedWire,
    deviceId: input.deviceId, registryCatalogVersion: 2, deviceCatalogVersion: 32,
    evidencePath: input.evidencePath, sourceUrl: input.sourceUrl,
    briefingArtifactId, sourceLedger: { path: ledgerPath, sha256: sha256(readFileSync(ledgerPath, 'utf8')) },
    briefingArtifact: { path: artifactPath, sha256: sha256(artifactRaw) } } as const;
  mkdirSync(dirname(input.evidencePath), { recursive: true });
  writeFileSync(input.evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}

if (import.meta.main) {
  const [instanceRoot, sourceUrl, deviceId] = process.argv.slice(2);
  if (!instanceRoot || !sourceUrl || !deviceId || process.argv.length !== 5)
    throw new Error('usage: bun scripts/demo1114-s2-absorb-scene.ts <instanceRoot> <sourceUrl> <deviceId>');
  const receipt = await runScene2Absorb({ instanceRoot, sourceUrl, deviceId,
    rootRunId: process.env.DEMO_ROOT_RUN_ID ?? '', memberId: process.env.DEMO_MEMBER_ID ?? '',
    sourceScrapId: process.env.DEMO_SOURCE_SCRAP_ID ?? '', sourceCommit: process.env.DEMO_SOURCE_COMMIT ?? '',
    evidencePath: process.env.DEMO_SCENE_RECEIPT_PATH ?? '',
    sourceSurface: (process.env.DEMO_SOURCE_SURFACE ?? 'telegram') as Scene2SourceSurface });
  process.stdout.write(`${JSON.stringify({ sceneRunId: receipt.sceneRunId,
    sourceScrapId: receipt.sourceScrapId, briefingArtifactId: receipt.briefingArtifactId,
    evidencePath: receipt.evidencePath })}\n`);
}
