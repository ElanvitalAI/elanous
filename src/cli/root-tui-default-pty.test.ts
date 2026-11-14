import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

test('bare root opens Next and explicit classic still accepts a chat turn', async () => {
  for (const mode of ['default', 'classic'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'root-default-'));
    try {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--local',
          ...(mode === 'classic' ? ['--tui', 'classic'] : [])],
        root, rows: 24, cols: 100,
        env: { NODE_ENV: 'test', ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1',
          ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', ELANOUS_TEST_FAKE_LLM_RESPONSE: 'explicit-classic-reply' },
        // 출처: #63237 classic entry regression; allocate 20s to each real-PTY boot.
        ready: { label: mode + ' boot', timeoutMs: 20_000, until: (s) => mode === 'default'
          ? s.includes('Enter 전송') && s.includes('❯')
          : (s.includes('elanous | daemon') || s.includes('Opening web setup…')) && s.includes('❯') },
        // 출처: #63237 classic chat regression; allocate the same 20s per-turn PTY slice.
        steps: [{ label: 'chat', text: '짧게 인사해줘', timeoutMs: 20_000,
          until: (s) => s.includes('explicit-classic-reply') }],
      });
      expect(run.frames[0]?.screen).toContain(mode === 'default' ? 'Enter 전송' : 'ChatLog');
      expect(run.frames[1]?.screen).toContain('explicit-classic-reply');
      expect(run.exitCode).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 60_000);
