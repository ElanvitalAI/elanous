import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseNextTuiHarnessCommand, runNextTuiHarnessBranchRoute } from '../tui/branches/harness.js';
import { goalFilePath, runGoalFileHarnessCommand } from '../tui-client/goal-file-harness-command.js';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';

const validGoal = `대상 경로: scripts/ask-marker-check.ts

불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = 검사기가 export를 센다; 관측 = rg -c 'export function inspectAskMarkers' scripts/ask-marker-check.ts; 기대 = 1 이상.
`;

test('Next recognizes explicit goal documents and keeps prose on say', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-goal-route-'));
  const goal = join(root, 'goal.md');
  writeFileSync(goal, validGoal);
  const calls: string[] = [];
  const signal = new AbortController().signal;
  try {
    expect(goalFilePath(goal)).toBe(goal);
    expect(goalFilePath('improve the goal')).toBeNull();
    const request = parseNextTuiHarnessCommand('/harness ask --dry-run improve the goal');
    expect(request).not.toBeNull();
    await runNextTuiHarnessBranchRoute(request!, signal, () => {},
      async (_command, text) => { calls.push(`say:${text}`); });
    expect(calls).toEqual(['say:--dry-run improve the goal']);
    await runNextTuiHarnessBranchRoute({ command: 'ask', goal: 'improve  the goal --dry-run' }, signal, () => {},
      async (_command, text) => { calls.push(`say:${text}`); });
    expect(calls.at(-1)).toBe('say:improve  the goal --dry-run');
    await runNextTuiHarnessBranchRoute({ command: 'ask', goal: 'explain "--dry-run"' }, signal, () => {},
      async (_command, text) => { calls.push(`say:${text}`); });
    expect(calls.at(-1)).toBe('say:explain "--dry-run"');
    await runNextTuiHarnessBranchRoute({ command: 'ask', goal: "don't change the goal --dry-run" }, signal, () => {},
      async (_command, text) => { calls.push(`say:${text}`); });
    expect(calls.at(-1)).toBe("say:don't change the goal --dry-run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Next goal-file dry run produces a clean goal receipt without launching', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-goal-parity-'));
  const goal = join(root, 'goal.md');
  writeFileSync(goal, validGoal);
  const repo = resolve(import.meta.dir, '..', '..');
  const lines: string[] = [];
  try {
    await runGoalFileHarnessCommand(goal, true, new AbortController().signal,
      line => lines.push(line), join(repo, 'bin', 'elanous.mjs'));
    expect(lines).toContain(`[dry-run] 입력: ${goal}`);
    expect(lines).toContain('[dry-run] 입구: cli-harness-ask');
    expect(lines).toContain('[dry-run] ✅ ask 마커 — 경고 없음');
    expect(lines.join('\n')).not.toContain('워크트리 생성 완료');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

test('quoted option-like goal filename remains a file argument in the real CLI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-goal-option-name-'));
  const repo = resolve(import.meta.dir, '..', '..');
  const goal = join(root, '--dry-run');
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(repo, 'scripts', 'ask-marker-check.ts'), join(root, 'scripts', 'ask-marker-check.ts'));
  writeFileSync(goal, validGoal);
  const helper = join(root, 'invoke-goal.ts');
  writeFileSync(helper, `import { goalFilePath, runGoalFileHarnessCommand } from ${JSON.stringify(join(repo, 'src/tui-client/goal-file-harness-command.ts'))};
await runGoalFileHarnessCommand(goalFilePath('"--dry-run"')!, true, new AbortController().signal, console.log, ${JSON.stringify(join(repo, 'bin/elanous.mjs'))});
`);
  try {
    const child = Bun.spawn([process.execPath, helper], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(out).toContain(`[dry-run] 입력: ${realpathSync(goal)}`);
    expect(out).toContain('[dry-run] 입구: cli-harness-ask');
    expect(out).not.toContain('워크트리 생성 완료');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const placement of ['before', 'after'] as const) test(`Next PTY completes a goal document with dry-run ${placement} the path`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-goal-parity-pty-'));
  const repo = resolve(import.meta.dir, '..', '..');
  const goal = join(root, 'goal with spaces.md');
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(repo, 'scripts', 'ask-marker-check.ts'), join(root, 'scripts', 'ask-marker-check.ts'));
  writeFileSync(goal, validGoal);
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true }, errorReports: { enabled: false },
  }));
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, cols: 120, rows: 36,
      env: { ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'boot', until: screen => screen.includes('Enter 전송 · Esc 취소 · Ctrl+Q 종료') },
      steps: [{
        label: 'grounded goal dry run', text: placement === 'before'
          ? `/harness ask --dry-run "${goal}"` : `/harness ask "${goal}" --dry-run`,
        until: screen => screen.includes('턴 완료') && screen.includes('ask 마커 — 경고 없음') && screen.includes('[dry-run] 입력:'),
      }],
    });
    const screen = run.frames.at(-1)?.screen ?? '';
    expect(screen).toContain('턴 완료');
    expect(screen).toContain('ask 마커 — 경고 없음');
    expect(run.exitCode).toBe(0);
    expect(run.entrySha256).toHaveLength(64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
