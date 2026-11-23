import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';

// Next half of the retired classic↔Next parity test (#39709 review): a valid goal file dry run in an isolated Next PTY
// completes, names the goal, reports no ask-marker warning, and launches nothing.
test('Next completes a valid goal-file dry run in an isolated PTY without launching a run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-goal-dry-run-'));
  const repo = resolve(import.meta.dir, '..', '..');
  const goal = join(root, 'goal.md');
  const input = `/harness ask --dry-run ${goal}`;
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(repo, 'scripts', 'ask-marker-check.ts'), join(root, 'scripts', 'ask-marker-check.ts'));
  writeFileSync(goal, `대상 경로: scripts/ask-marker-check.ts

불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = 검사기가 export를 센다; 관측 = rg -c 'export function inspectAskMarkers' scripts/ask-marker-check.ts; 기대 = 1 이상.
`);
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true }, errorReports: { enabled: false },
  }));
  const git = Bun.spawnSync(['git', 'init', '-q', root], { stdout: 'pipe', stderr: 'pipe' });
  expect(git.exitCode).toBe(0);
  try {
    const next = await mockSeatPtySequence({
      executable: process.execPath,
      root, cols: 120, rows: 36,
      env: { ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      ready: { label: 'Next boot', until: screen => screen.includes('Enter send · Esc cancel · Ctrl+Q quit') },
      steps: [{
        label: 'valid goal dry run', text: input,
        until: screen => DONE.every((marker) => screen.includes(marker)),
      }],
    });
    const screen = next.frames.at(-1)?.screen ?? '';
    expect(screen).toContain(goal);
    expect(screen).toContain('ask 마커 — 경고 없음');
    expect(screen).not.toContain('🚀 런을 띄웠다');
    expect(next.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000); // Source: #39709 — the retired parity test's own bound for two PTYs; one Next PTY stays well inside it.

const DONE = ['ask 마커 — 경고 없음', '[dry-run] 입력:'];
