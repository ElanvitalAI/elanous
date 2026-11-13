import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';

test('classic and Next complete the same valid goal-file dry run in isolated PTYs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b2-paired-goal-'));
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
    const common = {
      executable: process.execPath,
      root, cols: 120, rows: 36,
      env: { ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
    } as const;
    const outDir = process.env.ELANOUS_B2_PAIRED_OUT_DIR;
    const next = await mockSeatPtySequence({
      ...common,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      ready: { label: 'Next boot', until: screen => screen.includes('Enter 전송 · Esc 취소 · Ctrl+Q 종료') },
      steps: [{
        label: 'same valid goal dry run', text: input,
        until: screen => screen.includes('턴 완료') && screen.includes('ask 마커 — 경고 없음') && screen.includes('[dry-run] 입력:'),
      }],
      ...(outDir ? { artifactPath: join(outDir, 'next.json') } : {}),
    });
    const classic = await mockSeatPtySequence({
      ...common,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'classic'],
      ready: { label: 'classic boot', until: screen => screen.includes('❯') && screen.length > 80 },
      steps: [{
        label: 'same valid goal dry run', text: input,
        until: screen => screen.includes('✓ /harness ask --dry-run 완료') && screen.includes('ask 마커 — 경고 없음'),
      }],
      ...(outDir ? { artifactPath: join(outDir, 'classic.json') } : {}),
    });
    const nextScreen = next.frames.at(-1)?.screen ?? '';
    const classicScreen = classic.frames.at(-1)?.screen ?? '';
    for (const screen of [nextScreen, classicScreen]) {
      expect(screen).toContain(goal);
      expect(screen).toContain('ask 마커 — 경고 없음');
      expect(screen).not.toContain('🚀 런을 띄웠다');
    }
    expect(next.exitCode).toBe(0);
    expect(classic.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
