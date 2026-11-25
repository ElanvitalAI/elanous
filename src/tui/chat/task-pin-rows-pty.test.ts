// AUTOPILOT-TASK-GOAL-PIN — real PTY (test universe · fake LLM): two task goals in the autopilot state file are drawn as
// «📌 i/n …» rows just above the input, and neither reaches the 🚗 AUTO chip.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', '..', 'bin', 'elanous.mjs');

test('two task goals → two pin rows right above the input (before and after a turn); the chip shows no pin text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pin-pty-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false },
      llm: { memoryJudge: { enabled: false, crossRecall: false } } }));
    const stateFile = join(root, 'autopilot', 'state.json');
    mkdirSync(join(root, 'autopilot'), { recursive: true });
    const now = Date.now();
    const due1 = now + 3 * 60 * 60_000; const due2 = now + 4 * 60 * 60_000;
    writeFileSync(stateFile, JSON.stringify({ v: 1, on: true, since: now, by: 'slash', pins: [
      { id: 'pin:1', text: 'PINX 로스터 + 택틱', done: '로스터 표 발송', deadline: due1, priority: 1, at: now - 2_000 },
      { id: 'pin:2', text: 'PINY 데모 노트', done: '노트 링크 발송', deadline: due2, priority: 1, at: now - 1_000 },
    ] }));
    const evidence = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'PIN reply', ELANOUS_AUTOPILOT_STATE_FILE: stateFile },
      ready: { label: 'boot', until: (screen) => screen.includes('PINY') && screen.includes('🚗 AUTO') },
      // After a turn the pins are still there (the turn end re-reads the state file).
      steps: [{ label: 'answered', text: 'PIN prompt', until: (screen) => screen.includes('PIN reply') && screen.includes('PINY') }],
    });
    expect(evidence.exitCode).toBe(0);
    const screen = evidence.frames[1]!.screen;
    if (process.env.PIN_FRAME_OUT) writeFileSync(process.env.PIN_FRAME_OUT, screen);
    const lines = screen.split('\n');
    const promptRow = lines.map((row, i) => (row.trimStart().startsWith('❯') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const firstPin = lines.findIndex((row) => /📌 1\/2 PINX 로스터 \+ 택틱 · done when: 로스터 표 발송 · due \d\d:\d\d\s*$/u.test(row));
    const secondPin = lines.findIndex((row) => /📌 2\/2 PINY 데모 노트 · done when: 노트 링크 발송 · due \d\d:\d\d\s*$/u.test(row));
    expect(firstPin).not.toBe(-1);
    expect(secondPin).toBe(firstPin + 1);
    expect(promptRow > secondPin).toBe(true);
    // Between the last pin and the prompt only separators / blank rows (the pins sit right above the input).
    expect(lines.slice(secondPin + 1, promptRow).every((row) => /^[\s─]*$/u.test(row))).toBe(true);
    const chip = lines.find((row) => row.includes('🚗 AUTO')) ?? '';
    expect(chip).not.toContain('PINX');
    expect(chip).not.toContain('PINY');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
