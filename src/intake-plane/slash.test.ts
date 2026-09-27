import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntakeStore } from './store.js';
import { resolveIntakeSlash } from './slash.js';
import { buildUserConfig } from '../user-config.js';
import type { PipelineRunResult, PipelinePhaseCallables } from './pipeline-runner.js';

test('harness.defaultRepo parser keeps only absolute string paths without changing sibling fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'intake-config-'));
  const path = join(dir, 'config.json');
  try {
    for (const value of ['/repo', './repo', '~/', 42, null, '']) {
      writeFileSync(path, JSON.stringify({ harness: { defaultRepo: value, pod: { grokApiKeyOptIn: true } } }));
      const parsed = buildUserConfig(path).harness;
      expect(parsed?.defaultRepo).toBe(value === '/repo' ? '/repo' : undefined);
      expect(parsed?.pod?.grokApiKeyOptIn).toBe(true);
      expect(parsed?.budgetGate).toBeDefined();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function capture(store: ReturnType<typeof createIntakeStore>): void {
  store.capture({
    intakeId: 'intake-1', source: 'telegram', rawText: '구현 과제',
    attachments: [], receivedAt: new Date().toISOString(),
  });
}

function oneTaskPipeline(): PipelineRunResult {
  return {
    intakeId: 'intake-1',
    decomposition: { rationale: 'decomposed' } as PipelineRunResult['decomposition'],
    enriched: { missions: [{ tasks: [{
      id: 'task-1', title: '구현', intent: '요구사항', refs: ['src/intake-plane/slash.ts'],
      invariants: [{ condition: '대상 저장소 검증', verification: 'bun test src/intake-plane/slash.test.ts', expected: '유효하지 않으면 거부' }],
      decisionSignals: [{ condition: 'git 저장소 안에서 발사', observation: 'bun test src/intake-plane/slash.test.ts', expected: '발사 성공' }],
      context: { enrichments: [] },
    }] }] } as unknown as PipelineRunResult['enriched'],
  } as PipelineRunResult;
}

test('/harness implement rejects before decomposition or dispatch when no repository exists', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'intake-not-git-'));
  try {
    const store = createIntakeStore({ archiveDir: null });
    capture(store);
    let decompositions = 0;
    let dispatches = 0;
    const result = await resolveIntakeSlash(['implement', 'intake-1'], {
      store,
      harnessContext: { cwd, signal: new AbortController().signal, userText: '/harness 무언가' },
      harnessConfig: { harness: {} },
      runPipeline: async () => { decompositions++; return oneTaskPipeline(); },
      dispatchHarness: async () => { dispatches++; return { output: 'launched' }; },
    });
    expect(result.output).toContain('하니스 대상 저장소가 없습니다');
    expect(result.output).toContain('harness.defaultRepo');
    expect(decompositions).toBe(0);
    expect(dispatches).toBe(0);
    expect(store.listEvents({ intakeId: 'intake-1' })).toHaveLength(1);
    expect(store.getSession('intake-1')?.state).toBe('captured');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('configured git repository reaches dispatch as the harness cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-harness-target-'));
  const cwd = join(root, 'daemon');
  const repo = join(root, 'repo');
  try {
    mkdirSync(cwd);
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'README.md'), 'fixture');
    execFileSync('git', ['-C', repo, 'add', 'README.md']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    const store = createIntakeStore({ archiveDir: null });
    capture(store);
    let dispatches = 0;
    const result = await resolveIntakeSlash(['implement', 'intake-1'], {
      store,
      harnessContext: { cwd, signal: new AbortController().signal, userText: '/harness 구현 과제' },
      harnessConfig: { harness: { defaultRepo: repo } },
      runPipeline: async () => oneTaskPipeline(),
      pipelineCallables: {} as PipelinePhaseCallables,
      dispatchHarness: async (_args, context) => {
        dispatches++;
        expect(context?.cwd).toBe(repo);
        return { output: 'launched' };
      },
    });
    expect(result.output).toContain('launched 1/1');
    expect(dispatches).toBe(1);
    expect(result.action).toBe('refresh');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
