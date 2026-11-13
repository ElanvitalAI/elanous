import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence } from './mock-seat-pty-sequence.js';

test('classic goal request in observe-only mode cannot launch a detached run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'classic-b2-observe-'));
  const repo = resolve(import.meta.dir, '..', '..');
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(repo, 'scripts', 'ask-marker-check.ts'), join(root, 'scripts', 'ask-marker-check.ts'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true }, errorReports: { enabled: false },
  }));
  const git = Bun.spawnSync(['git', 'init', '-q', root], { stdout: 'pipe', stderr: 'pipe' });
  expect(git.exitCode).toBe(0);
  try {
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(repo, 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'classic'],
      root, rows: 36, cols: 120,
      env: {
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1',
      },
      ready: { label: 'classic boot', until: screen => screen.includes('❯') && screen.length > 80 },
      steps: [{
        label: 'valid goal observe-only',
        text: '/harness ask 대상 경로: scripts/ask-marker-check.ts',
        until: screen => screen.includes('관측 전용이라 런을 발사하지 않았습니다') || screen.includes('예비 검사에서 막혔다'),
      }],
      ...(process.env.ELANOUS_B2_CLASSIC_OUT ? { artifactPath: process.env.ELANOUS_B2_CLASSIC_OUT } : {}),
    });
    const screen = run.frames.at(-1)?.screen ?? '';
    expect(screen).toContain('관측 전용이라 런을 발사하지 않았습니다');
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
