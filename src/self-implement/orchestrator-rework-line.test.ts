import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetLiveDetailCacheForTesting, writeLiveDetail } from '../live/detail-switch.js';
import { seams } from './test-seams.js';
import {
  formatReworkProgressLine,
  runSelfImplement,
  UNMEASURED_ATTEMPT_ORDINAL,
} from './orchestrator.js';

const orchestratorSource = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');

describe('rework progress line', () => {
  it('appends a measured relaunch ordinal of two or greater while preserving rework text', () => {
    expect(formatReworkProgressLine(1, 3, 'none', 2)).toBe('rework 1/3 · 재발사 2 — 수정 중…');
    expect(formatReworkProgressLine(2, 4, 'better', 3)).toBe('rework 2/4·better · 재발사 3 — 수정 중…');
  });

  it('keeps first and unmeasured attempts free of relaunch text', () => {
    expect(formatReworkProgressLine(1, 3, 'none', 1)).toBe('rework 1/3 — 수정 중…');
    expect(formatReworkProgressLine(1, 3, 'none', UNMEASURED_ATTEMPT_ORDINAL)).toBe('rework 1/3 — 수정 중…');
  });

  it('preserves the distinct round-zero implementation message at its progress call site', () => {
    expect(orchestratorSource).toContain("round === 0\n      ? '구현 중 (헤드리스 goal-loop·수분 소요)…'");
  });

  it('wires the incremented ordinal to the rework formatter without a run-supervisor dependency', () => {
    expect(orchestratorSource).toContain('const attemptOrdinal = incrementRunAttemptOrdinal(runId);');
    expect(orchestratorSource).toContain('formatReworkProgressLine(round, effectiveMax, escalateTier, attemptOrdinal)');
    expect(orchestratorSource).not.toContain('run-supervisor');
  });

  it('emits a run-scoped rework decision without changing the progress line or existing rework observation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-rework-decision-'));
    const priorStateDir = process.env.ELANOUS_STATE_DIR;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const progressLines: string[] = [];
    try {
      process.env.ELANOUS_STATE_DIR = root;
      writeLiveDetail({ scope: 'run-rework-decision' });
      const result = await runSelfImplement({
        runId: 'run-rework-decision', feature: 'rework decision fixture', completion: 'worktree-only', memory: false,
        seams: seams({ gateResults: [false, true], onProgress: ({ message }) => { progressLines.push(message); } }),
      });
      expect(result.ok).toBe(true);
      const decisions = log.mock.calls.filter(([category, event]) => category === 'harness.decision' && event === 'decision')
        .map(([, , data]) => data);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ kind: 'HEAL', runId: 'run-rework-decision' });
      const reworkLog = log.mock.calls.find(([category, event]) => category === 'self-implement' && event === 'rework');
      expect(reworkLog).toBeDefined();
      const { round, effectiveMax, escalateTier } = reworkLog![2] as { round: number; effectiveMax: number; escalateTier: string };
      expect(progressLines).toContain(formatReworkProgressLine(round, effectiveMax, escalateTier, 1));
      expect(progressLines).toContain('구현 중 (헤드리스 goal-loop·수분 소요)…');
    } finally {
      log.mockRestore();
      resetLiveDetailCacheForTesting();
      if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = priorStateDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('continues rework when decision emission throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-rework-emission-'));
    const priorStateDir = process.env.ELANOUS_STATE_DIR;
    const originalLog = debug.log;
    let emissionAttempted = false;
    try {
      process.env.ELANOUS_STATE_DIR = root;
      writeLiveDetail({ scope: 'run-rework-emission' });
      debug.log = ((category, event, data, options) => {
        if (category === 'harness.decision') {
          emissionAttempted = true;
          throw new Error('decision sink unavailable');
        }
        return originalLog.call(debug, category, event, data, options);
      }) as typeof debug.log;
      const result = await runSelfImplement({
        runId: 'run-rework-emission', feature: 'rework emission fixture', completion: 'worktree-only', memory: false,
        seams: seams({ gateResults: [false, true] }),
      });
      expect(emissionAttempted).toBe(true);
      expect(result.ok).toBe(true);
    } finally {
      debug.log = originalLog;
      resetLiveDetailCacheForTesting();
      if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = priorStateDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
