import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEffectiveInstanceRoot } from '../instance/resolve.js';
import { INFLIGHT_REGISTRY_FILE, listInflight, registerInflight } from '../pr-tool/inflight-registry.js';
import { runPrLand, type PrLandDeps } from './pr-cli.js';

// INFLIGHT-REGISTRY: pr land 가 병합에 성공하면 그 PR 을 연 카드의 비행 중 줄을 지운다.
let freezeRoot = '';
let stateDir = '';
let savedStateDir: string | undefined;
beforeEach(() => {
  freezeRoot = mkdtempSync(join(tmpdir(), 'pr-land-inflight-freeze-'));
  stateDir = mkdtempSync(join(tmpdir(), 'pr-land-inflight-state-'));
  savedStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = stateDir;
  resetEffectiveInstanceRoot();
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = savedStateDir;
  resetEffectiveInstanceRoot();
  rmSync(freezeRoot, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function land(taskStatePath: string, merged: boolean) {
  const deps: PrLandDeps = {
    prodFreezeRoot: freezeRoot,
    taskStatePath,
    currentBranch: () => 'feat/inflight',
    resolveBase: (_run, _cwd, explicit) => explicit ?? 'origin/main',
    run: (command, args) => {
      if (command === 'git' && args[0] === 'remote') return { ok: true, out: args[1] === 'get-url' ? 'https://github.com/example/repo.git' : 'origin' };
      if (command === 'git' && args[0] === 'rev-parse') return { ok: true, out: args[1] === 'HEAD' ? 'a'.repeat(40) : '/tmp/inflight-test' };
      if (command === 'git' && args[0] === 'diff' && args[1] === '--name-only') return { ok: true, out: 'src/cli/x.ts\n' };
      if (command === 'gh' && args.includes('baseRefName')) return { ok: true, out: 'main\n' };
      return { ok: true, out: '' };
    },
    listUnfinishedRuns: () => [],
    queryRunningRuns: () => { throw new Error('observation unavailable'); },
    runTypecheckGate: () => true,
    runIsolationGate: () => true,
    runMockModuleRestoreGate: () => true,
    runModelHardcodeGate: () => true,
    runDaemonPortGate: () => true,
    runPublicLeakGate: () => 0,
    runExportLeakCheck: () => ({ measured: true, hits: [] }),
    runTestInterferenceGate: async () => 0,
    runLandGlobalChecks: () => true,
    runAndroidGate: () => true,
    runPwaGate: () => true,
    runIosGate: () => true,
    listOpenPrs: () => [],
    out: { log: () => {}, error: () => {} },
    manager: {
      findPrForBranchOutcome: () => ({ status: 'NOT_FOUND' }),
      upsertPr: () => ({ ok: true, url: 'https://github.com/example/repo/pull/27777', reused: true }),
      mergePrOutcome: () => merged ? { ok: true, kind: 'merged' } : { ok: false, kind: 'not-merged', state: 'CLOSED' },
    } as unknown as PrLandDeps['manager'],
  };
  return runPrLand({ body: 'inflight landing test.' }, deps);
}

function fixture(): { taskStatePath: string; registry: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pr-land-inflight-cards-'));
  const taskStatePath = join(dir, 'task-agent-actions.json');
  writeFileSync(taskStatePath, JSON.stringify({ tasks: {
    'ta-landed': { id: 'ta-landed', text: 't', createdAt: '2026-10-17T00:00:00Z', status: 'launched', history: [], runId: 'run-landed', pr: { number: 27777 } },
    'ta-other': { id: 'ta-other', text: 't', createdAt: '2026-10-17T00:00:00Z', status: 'launched', history: [], runId: 'run-other' },
  } }));
  const registry = join(dir, INFLIGHT_REGISTRY_FILE);
  registerInflight({ runId: 'run-landed', cell: 'CELL-L', intent: 'landed', files: ['src/cli/x.ts'], cardId: 'ta-landed' }, { path: registry });
  registerInflight({ runId: 'run-other', cell: 'CELL-O', intent: 'other', files: ['src/cli/x.ts'], cardId: 'ta-other' }, { path: registry });
  return { taskStatePath, registry };
}

test('병합 성공 뒤 그 PR 카드의 줄만 지운다', async () => {
  const { taskStatePath, registry } = fixture();
  expect(await land(taskStatePath, true)).toBe(0);
  expect(listInflight({}, { path: registry }).map((entry) => entry.runId)).toEqual(['run-other']);
});

test('병합 실패면 줄을 남긴다', async () => {
  const { taskStatePath, registry } = fixture();
  expect(await land(taskStatePath, false)).toBe(1);
  expect(listInflight({}, { path: registry }).map((entry) => entry.runId)).toEqual(['run-landed', 'run-other']);
});
