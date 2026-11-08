#!/usr/bin/env bun
/** Narrow CLI entrypoint used by hard rehearsal; keep the gate implementation lazy until invocation. */
import { createRequire } from 'node:module';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { runWithReleaseGateTraffic, runWithReleasePwaTraffic } from './gate-traffic-mode.js';

const require = createRequire(import.meta.url);
type GateNodeCli = { runGateNode(args: string[], env: NodeJS.ProcessEnv): Promise<number> };

async function main(): Promise<void> {
  await registerStandaloneLogSink('release-loop');
  const { runGateNode } = require('./gate-runtime.js') as GateNodeCli;
  process.exitCode = await runWithReleaseGateTraffic(process.env,
    () => runWithReleasePwaTraffic(process.env, () => runGateNode(process.argv.slice(2), process.env)));
}

if (import.meta.main) await main();
