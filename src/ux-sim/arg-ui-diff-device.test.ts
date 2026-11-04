import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { runGraphRuntimeOverlayEventPathDevice } from './graph-runtime-overlay-event-path.js';

test('ARG-UI-DIFF: production overlay events retain sequence for the PWA graph view', async () => {
  const parentStateRoot = mkdtempSync(join(tmpdir(), 'ux-sim-arg-ui-diff-'));
  setTestStateRoot(parentStateRoot);
  try {
    const stateRoot = getTestStateRoot()!;
    const result = await runGraphRuntimeOverlayEventPathDevice(stateRoot, crypto.randomUUID(), 'arg-ui-diff');

    expect(result.graphEvents.map(({ seq, type }) => [seq, type])).toEqual([
      [expect.any(Number), 'node-added'],
      [expect.any(Number), 'edge-rerouted'],
      [expect.any(Number), 'edge-rerouted'],
    ]);
    const sequence = result.graphEvents.map(({ seq }) => seq);
    expect(sequence.every((seq, index) => index === 0 || seq > sequence[index - 1]!)).toBe(true);
  } finally {
    setTestStateRoot(null);
    rmSync(parentStateRoot, { recursive: true, force: true });
  }
}, { timeout: 60_000 });
