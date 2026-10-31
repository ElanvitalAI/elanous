import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';
import { buildImplementReport } from './off-diff-evidence.js';

test('passing child tool output is transcribed into tdd-green ledger evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-tdd-green-warning-'));
  const goalFile = join(root, 'goal.md');
  const transcript = `⏺ Bash({"command":"bun test -- 'src/self-implement/orchestrator-tdd-warning.test.ts'"})\\n ↳ bun test v1.4.2\\n ↳ 2 pass 0 fail`;
  const goal = [
    '# Passing child with omitted green marker',
    '',
    '### 검증 계획(TDD)',
    '- ① 증명할 동작: completed 결과를 보존한다.',
    '- ② 무대: unit',
    '- ③ 먼저 쓸 시험(RED): `src/self-implement/orchestrator-tdd-warning.test.ts` › `passing child with parsed result and missing green tag`',
    '- ④ GREEN 뒤 같은 명령: `bun test src/self-implement/orchestrator-tdd-warning.test.ts` → 0 fail',
    '- ⑤ 생산 진입점 배선(MS-05): runSelfImplement 라운드 루프',
  ].join('\n');
  writeFileSync(goalFile, goal);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/ElanvitalAI/elanous.git'], { cwd: root });

  let implementCalls = 0;
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  try {
    const result = await runSelfImplement({
      feature: goal,
      goalFile,
      runId: 'tdd-green-warning-completes',
      maxReworkRounds: 1,
      memory: false,
      seams: seams({
        createWorktree: async ({ branch }) => ({ path: root, branch, resolvedBase: 'a'.repeat(40) }),
        defaultBranchRef: () => 'main',
        implement: async () => {
          implementCalls++;
          const report = buildImplementReport([
            'EVIDENCE: [tdd-red] same test failed before the change || bun test src/self-implement/orchestrator-tdd-warning.test.ts',
            'RESULT: 1 fail · 0 pass',
            transcript,
          ].join('\n'), { changed: false, toolCalls: 1, reached: true, timedOut: false });
          return {
            ok: true,
            ...report,
            terminalStatus: { reached: true, changed: false, toolCalls: 1, timedOut: false },
          };
        },
        changedFilesForGateRoute: () => [],
        writeRunLedger: (entry) => events.push({ event: entry.event, data: entry.data }),
      }),
    });

    expect(result).toMatchObject({ outcome: 'completed', completionStatus: 'completed' });
    expect(result.stage).not.toBe('aborted');
    expect(result.terminationReason).toBeUndefined();
    expect(result.tddEvidenceFailure).toBeUndefined();
    expect(implementCalls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'tdd-green',
      data: expect.objectContaining({ observed: true, sameCommand: true, missing: [] }),
    }));
    expect(events.some(({ event }) => event === 'implement-abort-reason')).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
