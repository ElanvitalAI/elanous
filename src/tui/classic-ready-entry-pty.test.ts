import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

for (const mode of ['classic', 'next', 'default'] as const) {
  test(`${mode} opens an editable dashboard when provider setup is ready but optional web onboarding is incomplete`, async () => {
    const root = mkdtempSync(join(tmpdir(), `tui-ready-${mode}-`));
    try {
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        onboarding: { completed: false, ready: true, webFirst: true },
        errorReports: { enabled: false },
      }));
      const run = await mockSeatPtySequence({
        executable: process.execPath,
        args: [join(import.meta.dir, '../../bin/elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', ...(mode === 'default' ? [] : ['--tui', mode])],
        root, rows: 24, cols: 120, quitKeys: '\x11',
        env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
        ready: { label: `${mode} ready without web setup`, until: s => s.includes('❯') && !s.includes('continue setup in your browser'), timeoutMs: 20_000 }, // 출처: #36682 — entry-composer-multiline classic boot budget.
        steps: [{ label: 'editable prompt', chunks: ['ready-entry-draft'], until: s => s.includes('ready-entry-draft'), timeoutMs: 10_000 }], // 출처: #36682 — entry-composer-multiline classic input budget.
      });
      expect(run.frames.at(-1)?.screen).toContain('ready-entry-draft');
      expect(run.frames.map(f => f.screen).join('\n')).not.toContain('continue setup in your browser');
      expect(run.frames[0]?.screen).not.toContain('failed to load plugin manifest');
      expect(run.frames[0]?.screen).not.toContain('main not found');
      expect(run.exitCode).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000); // Source: entry-composer-multiline PTY test process budget.
}
