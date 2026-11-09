#!/usr/bin/env bun
import { emitNodeResult, readGraphContext } from './node-verdict.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';

/** The graph node is reserved for a later, evidence-bound emergency gate implementation. */
export function runEmergencyPublishGateNode(env: NodeJS.ProcessEnv = process.env): number {
  let version = '';
  try {
    const context = readGraphContext(env);
    version = context.input.version;
    emitNodeResult({ outcome: 'error', verdict: 'fail',
      summary: 'emergency publish is disabled by default; reduced gate implementation is deferred' });
    return 2;
  } catch (error) {
    emitNodeResult({ outcome: 'error', verdict: 'fail',
      summary: `${version ? `v${version}: ` : ''}${error instanceof Error ? error.message : String(error)}` });
    return 2;
  }
}

if (import.meta.main) {
  await registerStandaloneLogSink('release-loop');
  process.exitCode = runEmergencyPublishGateNode();
}
