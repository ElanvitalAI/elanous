import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

test('a real isolated Read turn shows one detailed tool row and a safe input target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-tool-ux-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const file = join(root, 'project-notes.txt');
    writeFileSync(file, 'first visible line\nsecond visible line\n');
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 28, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'TOOLUX-DONE',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'TOOLUX-READ', name: 'Read', args: { file_path: file } }) },
      ready: { label: 'boot', until: (screen) => screen.includes('Ctrl+Q 종료') },
      steps: [
        { label: 'settled', text: 'TOOLUX-READ', until: (screen) => screen.includes('TOOLUX-DONE') && screen.includes('턴 완료') },
        { label: 'detail', keys: '\x1b[5~', until: (screen) => screen.includes('턴 로그') && screen.includes('▸ 도구 · Read 결과') },
        { label: 'expanded', keys: '\r\r\r', until: (screen) => screen.includes('first visible line') && screen.includes('입력') },
      ],
    });
    const detail = run.frames.find((frame) => frame.label === 'detail')?.screen ?? '';
    const expanded = run.frames.find((frame) => frame.label === 'expanded')?.screen ?? '';
    expect(run.exitCode).toBe(0);
    expect(detail.match(/▸ 도구 · Read 결과/g)).toHaveLength(1);
    expect(detail).not.toContain('도구: Read');
    expect(detail).not.toContain('Read(');
    expect(expanded).toContain('first visible line');
    expect(expanded).toContain('project-notes.txt');
    expect(expanded).not.toContain(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
