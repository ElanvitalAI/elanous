/**
 * Deterministic E4 fixture: emit a fixed fake-Pod gate-progress sequence through
 * the real standalone debug-log sink. It never starts a gate, Pod, SSH, or kubectl.
 * Run only with ELANOUS_STATE_DIR pointing at an isolated directory (config
 * follows the resolved state root), then inspect it with `eln logs --category release-loop.gate`.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../../src/instance/resolve.js';
import { getElanousConfigDir } from '../../src/elanous-config-dir.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';

const scenario = [
  { completed: 0, total: 3, elapsedMs: 0 },
  { completed: 1, total: 3, elapsedMs: 1_000 },
  { completed: 3, total: 3, elapsedMs: 3_000 },
] as const;

function isInside(path: string, root: string): boolean {
  const comparablePath = process.platform === 'darwin' ? path.toLocaleLowerCase('en-US') : path;
  const comparableRoot = process.platform === 'darwin' ? root.toLocaleLowerCase('en-US') : root;
  const rel = relative(comparableRoot, comparablePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function canonicalRoot(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(cursor), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function emitGateProgressSimulation(runId?: string): Promise<void> {
  const stateRoot = effectiveInstanceRoot();
  const configRoot = getElanousConfigDir();
  const actualProdRoot = canonicalRoot(prodInstanceRoot());
  const actualStateRoot = canonicalRoot(stateRoot);
  const actualConfigRoot = canonicalRoot(configRoot);
  const overlapsProductionRoot = [actualStateRoot, actualConfigRoot].some((root) =>
    isInside(root, actualProdRoot) || isInside(actualProdRoot, root));
  if (overlapsProductionRoot) {
    throw new Error('refusing to emit mock gate events into the production instance; set ELANOUS_STATE_DIR to an isolated path');
  }
  // Logs are written below effectiveInstanceRoot() by logsDbPath(); check both resolver roots before creating either.
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(configRoot, { recursive: true });
  if (!await registerStandaloneLogSink('release-loop')) {
    throw new Error('could not register the isolated standalone logs.db sink');
  }
  const effectiveRunId = runId?.trim() || randomUUID();
  for (const step of scenario) {
    debug.log('release-loop.gate', 'progress', {
      runId: effectiveRunId,
      scenario: 'e4-fixed-pod-shards',
      executor: 'pod',
      host: 'mock-pod-host-1',
      ...step,
    });
  }
  process.stdout.write(`${JSON.stringify({ runId: effectiveRunId, scenario: 'e4-fixed-pod-shards', events: scenario.length, stateRoot: actualStateRoot })}\n`);
}

if (import.meta.main) await emitGateProgressSimulation(process.argv[2] || undefined);
