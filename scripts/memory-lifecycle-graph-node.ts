#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveStateRoot, prodInstanceRoot } from '../src/instance/resolve.js';
import { debug } from '../src/debug/log.js';
import { getUserConfig } from '../src/user-config.js';

const fields = ['replayStrengthened', 'decayChanged', 'hot', 'warm', 'cold', 'consolidated', 'archived', 'prunedEvents', 'promotionCandidates', 'errors'] as const;
type Effect = Record<typeof fields[number], number | null>;

export function verifyEffect(value: unknown): Effect {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('missing lifecycle effect');
  const effect = value as Record<string, unknown>;
  for (const field of fields) {
    const n = effect[field];
    if (n !== null && (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) throw new Error(`invalid lifecycle effect: ${field}`);
  }
  return Object.fromEntries(fields.map(field => [field, effect[field]])) as Effect;
}

const PHASE_RELATIVE_PATH = 'elanous-hq/seat-state/OP/PHASE.json';
export function phasePath(root: string): string {
  return join(root === prodInstanceRoot() ? dirname(root) : root, PHASE_RELATIVE_PATH);
}

export function readPhase(root: string): string {
  try {
    const data: unknown = JSON.parse(readFileSync(phasePath(root), 'utf8'));
    const phase = (data as { phase?: unknown } | null)?.phase;
    if (typeof phase === 'string' && ['land-flood', 'dev-normal', 'hard-rehearsal', 'gate-window', 'publish'].includes(phase)) return phase;
  } catch { /* Unknown phase is fail-open, with an operator warning. */ }
  console.error('warning: phase unknown or unreadable; continuing');
  return 'unknown';
}

async function record(event: string, data: Record<string, unknown>): Promise<void> {
  try {
    const { registerLogStoreSink, setLogInstanceName } = await import('../src/mss/logging/log-store.js');
    const config = getUserConfig().logs;
    setLogInstanceName(config.instanceName);
    const off = registerLogStoreSink(s => debug.registerSink(s), 'scheduler', config.retention);
    if (!off) throw new Error('lifecycle log sink unavailable');
    try { debug.log('memory.lifecycle', event, data); } finally { off(); }
  } catch (error) {
    console.error(`warning: lifecycle log unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const contextFile = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!contextFile) throw new Error('graph context required');
  const context = JSON.parse(readFileSync(contextFile, 'utf8')) as { graphId: string; runId: string; nodeId: string; outputs: Record<string, unknown> };
  const node = process.argv[2];
  if (context.graphId !== 'memory-lifecycle' || context.nodeId !== node) throw new Error('graph node identity mismatch');
  if (node === 'phase-guard') {
    const phase = readPhase(effectiveStateRoot());
    const skipped = ['hard-rehearsal', 'gate-window'].includes(phase);
    if (skipped) await record('skipped', { graphId: context.graphId, runId: context.runId, phase });
    console.log(JSON.stringify({ outcome: skipped ? 'skipped' : 'ok', phase }));
  } else if (node === 'verify-effect') {
    const effect = verifyEffect(context.outputs.run);
    const warnings = fields.filter(field => effect[field] === null || (field === 'errors' && effect[field] !== 0));
    console.log(JSON.stringify({ outcome: 'ok', effect, warnings }));
  } else if (node === 'record') {
    const verified = context.outputs['verify-effect'] as { outcome?: unknown; effect?: unknown; warnings?: unknown } | undefined;
    if (verified?.outcome !== 'ok' || !Array.isArray(verified.warnings)) throw new Error('verified effect required');
    const effect = verifyEffect(verified.effect);
    const guard = context.outputs['phase-guard'] as { phase?: unknown } | undefined;
    const phase = typeof guard?.phase === 'string' ? guard.phase : 'unknown';
    await record('graph-cycle', { graphId: context.graphId, runId: context.runId, phase, ...effect, warnings: verified.warnings });
    console.log(JSON.stringify({ outcome: 'ok', effect, warnings: verified.warnings }));
  } else throw new Error('unknown node');
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
