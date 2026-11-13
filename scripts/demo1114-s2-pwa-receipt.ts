import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runScene2PwaWorld } from '../src/ux-sim/fake-absorb-ingest.js';

const root = resolve(process.argv[2] ?? '.elanous-test/scene2-receipt');
mkdirSync(root, { recursive: true });
const runId = `scene2-pwa-${randomUUID()}`;
const positive = await runScene2PwaWorld({ root: join(root, 'positive'), runId });
const negative = await runScene2PwaWorld({ root: join(root, 'negative'), runId: `${runId}-extractor-failed`, failExtraction: true });
const pass = positive.result.status === 'done' && positive.briefings[0]?.runId === runId
  && positive.briefings[0]?.topics[0]?.scrapIds[0] === `${runId}:scrap`
  && negative.result.status === 'failed' && !negative.result.path.includes('brief') && negative.briefings.length === 0;
const receipt = { pass, runId, worldId: positive.worldId, positive, negative,
  boundary: 'fake business and API projection; production runGraph and catalog-owned world; installed LIVE yellow' };
writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
if (!pass) process.exitCode = 1;
