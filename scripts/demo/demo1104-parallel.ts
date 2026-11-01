#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { DisplayCoordinator } from '../../src/display/coordinator.js';
import { TerminalSessionRegistry } from '../../src/terminal/session-registry.js';
import { createDemoRunGraphSurfaceAdapter, createDemoTelegramDryRunAdapter } from './demo1104-parallel-scenes.js';
import { DEMO1104_STAGE_CONFIG } from './demo1104-stage.config.js';
import { startDemo1104ParallelHost } from './demo1104-parallel-host.js';

const repoRoot = resolve(import.meta.dir, '../..');
const outputDir = resolve(process.env.DEMO1104_OUTPUT_DIR ?? `${process.env.HOME}/Movies/elanous/demo-1104/live`);
const videoSources = Object.fromEntries(['V1', 'V2', 'V3', 'V4', 'V5', 'V6'].map(id => [id, resolve(outputDir, `${id}.mp4`)]));
const coordinator = new DisplayCoordinator({ termSize: () => ({ cols: process.stdout.columns ?? 120, rows: process.stdout.rows ?? 40 }) });
const registry = new TerminalSessionRegistry({ coordinator });
const webRunGraph = createDemoRunGraphSurfaceAdapter({
  graphId: 'inside-seed',
  graphYaml: readFileSync(resolve(repoRoot, 'graphs/demo/inside-seed.yaml'), 'utf8'),
  videoSources,
  onView(view, act) { stdout.write(`[web-run-graph] ${act.id} ${view.status}\n`); },
  onVideo(transition) { stdout.write(`[web-run-graph] video ${transition.videoId}: ${transition.source}\n`); },
});
const telegramFile = resolve(outputDir, 'telegram-dry-run.jsonl');
const telegram = createDemoTelegramDryRunAdapter({ file: telegramFile, linearIssueId: 'DEMO1104', videoSources });
let stage: Awaited<ReturnType<typeof startDemo1104ParallelHost>>['stage'] | undefined;

try {
  const started = await startDemo1104ParallelHost({
    registry,
    cwd: repoRoot,
    termSize: () => ({ cols: process.stdout.columns ?? 120, rows: process.stdout.rows ?? 40 }),
    videoSources,
    webRunGraph,
    telegram,
    async runMission(session, act) {
      const prompt = `\n[11-04 ${act.id}] ${act.title}\n`;
      session.preview.write(`${prompt}\n`);
      stdout.write(`[${session.agentBrand}] mission sent to ${session.id}\n`);
    },
    showVideo(session, transition) {
      session.preview.write(`\n[11-04 video ${transition.videoId}] ${transition.source}\n`);
    },
  });
  stage = started.stage;
  stdout.write(`11-04 parallel stage started\n${JSON.stringify(started.snapshot, null, 2)}\n`);
  stdout.write(`Controls: act <act-id> | video <act-id> | snapshot | quit\nActs: ${DEMO1104_STAGE_CONFIG.acts.map(act => act.id).join(', ')}\n`);
  const input = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  try {
    for await (const line of input) {
      const [command, id] = line.trim().split(/\s+/, 2);
      if (command === 'quit' || command === 'exit') break;
      if (command === 'snapshot') {
        stdout.write(`${JSON.stringify(stage.snapshot(), null, 2)}\n`);
      } else if (command === 'act' && id) {
        await stage.runActNow(id as typeof DEMO1104_STAGE_CONFIG.acts[number]['id']);
        stdout.write(`act complete: ${id}\n`);
      } else if (command === 'video' && id) {
        await stage.switchToVideo(id as typeof DEMO1104_STAGE_CONFIG.acts[number]['id']);
        stdout.write(`video transition complete: ${id}\n`);
      } else {
        stdout.write('Use: act <act-id> | video <act-id> | snapshot | quit\n');
      }
    }
  } finally {
    input.close();
  }
} finally {
  for (const session of registry.list()) registry.kill(session.id);
  webRunGraph.close();
  telegram.close();
}
