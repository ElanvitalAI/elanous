import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { GraphRunState } from '../src/graph-runner/runner.js';
import { mockSeatPtySequence } from '../src/ux-sim/mock-seat-pty-sequence.js';

test('N03: Next g-key reads a fake graph ledger and keeps its progress and status visible', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rich-sidetab-n03-'));
  const graphId = 'sidetab-sim';
  const runId = 'sidetab-sim-pty';
  const graphDir = join(root, 'graph-runs', graphId);
  mkdirSync(graphDir, { recursive: true });
  const statePath = join(graphDir, `${runId}.json`);
  const run: GraphRunState = {
    graphId, runId, startedAt: '2026-11-12T03:00:00.000Z',
    status: 'running', path: ['plan', 'build'],
    nodes: [{ nodeId: 'plan', ok: true, exit: 0, executed: true }],
    currentNode: { nodeId: 'build', startedAt: '2026-11-12T03:00:00.000Z' },
    executed: 1, dryRun: false, statePath,
  };
  const original = JSON.stringify(run);
  writeFileSync(statePath, original);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  try {
    const receipt = await mockSeatPtySequence({
      executable: process.execPath,
      args: [resolve(import.meta.dir, '../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, runId: 'rich-sidetab-n03', rows: 28, cols: 120,
      env: {
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
        ELANOUS_STATE_DIR: root, ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_RUN_ID: runId,
      },
      ready: { label: 'Next boot', until: screen => screen.includes('❯ ') },
      steps: [
        { label: 'focus side tab', chunks: ['\x1c', 's'], gapMs: 50, until: '세션 · PTY' },
        { label: 'fake graph in Next rich side tab', keys: 'g', until: screen => screen.includes('● build') && screen.includes('1/2') && screen.includes('상태 │') && screen.includes('running') },
      ],
      artifactPath: process.env.ELANOUS_RICH_SIDETAB_RECEIPT,
      quitKeys: '\x11', exitTimeoutMs: 20_000, // Source: N03 #36860 bounded Ctrl+Q cleanup, mock-seat-pty-sequence.test.ts.
    });
    expect(receipt.frames).toHaveLength(3);
    expect(receipt.frames.at(-1)!.screen).toContain('✓ plan');
    expect(receipt.frames.at(-1)!.screen).toContain('로그 │ plan 완료');
    expect(receipt.exitCode).toBe(0);
    expect(readFileSync(statePath, 'utf8')).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000); // Source: node-b N03 measured 3.36s; allow boot/cleanup margin under load.
