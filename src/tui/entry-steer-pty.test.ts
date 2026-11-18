import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence, type SeatPtyStep } from '../ux-sim/mock-seat-pty-sequence.js';
import {
  TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV,
} from '../ux-sim/fake-llm.js';

// A200 ELN-MIDTURN-STEER — pty capture before/after: input typed during a running turn is shown as
// «N steer pending», joins the next model request at the tool-result boundary («Steer applied»), and does not
// leave again as a separate turn. Esc with queued input auto-submits it as the next turn.
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SLOW = 'STEER-SLOW';
// Long enough for a person to type during the first model request (same stage as entry-queue-recall).
const SLOW_MS = '8000';
// Status line queue counter in its wide and compact forms (status-line.ts «Queue n» · «Qn»).
// One item waits: as a queued turn («Queue 1» · «Q1») or, since ELN-QUEUE-ITEM-CONTROLS, as a steer («Steer 1 · Queue 0» · «S1·Q0»).
const QUEUE_ONE = /\bQueue 1\b|\bQ1\b|\bSteer 1 · Queue 0\b|\bS1·Q0\b/;

async function runSteer(steps: SeatPtyStep[], toolFile?: string) {
  const root = mkdtempSync(join(tmpdir(), 'next-steer-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const file = toolFile ? join(root, toolFile) : undefined;
    if (file) writeFileSync(file, 'steer line\n');
    return await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 28, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'STEER-DONE',
        [TEST_FAKE_LLM_DELAY_MS_ENV]: SLOW_MS, [TEST_FAKE_LLM_DELAY_WHEN_ENV]: SLOW,
        ...(file ? { [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify({ when: `${SLOW}-READ`, name: 'Read', args: { file_path: file } }) } : {}),
      },
      // Current chrome: English footer (#37988) · user turn is the «> » line, no speaker label (#38020).
      ready: { label: 'boot', until: (s) => s.includes('elanous') && s.includes('Enter send') },
      steps,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('A200: input typed during a tool turn is steered into the next model request', async () => {
  const run = await runSteer([
    // before: the line waits as a steer while the first model request is still running.
    { label: 'steer-queued', chunks: [`${SLOW}-READ`, '\r', 'turn left please', '\r'], gapMs: 350,
      until: (s) => s.includes('steer pending') },
    // after: the child drained it right before the next model request.
    { label: 'steer-applied', until: (s) => s.includes('Steer applied') },
    { label: 'settled', until: (s) => s.includes('STEER-DONE') && !s.includes('steer pending') },
  ], 'steer-notes.txt');
  expect(run.exitCode).toBe(0);
  const settled = run.frames.find((frame) => frame.label === 'settled')?.screen ?? '';
  // Applied steer does not come back as a separate queued turn.
  expect(settled).not.toContain('> turn left please');
  expect(settled).not.toMatch(QUEUE_ONE);
}, 90_000);

test('A200: Esc with queued input auto-submits it as the next turn (draft stays empty)', async () => {
  const run = await runSteer([
    { label: 'queued', chunks: [`${SLOW} first`, '\r', 'after cancel', '\r'], gapMs: 350, until: (s) => QUEUE_ONE.test(s) },
    { label: 'esc', keys: '\x1b', until: (s) => s.includes('> after cancel') && s.includes('STEER-DONE') },
  ]);
  expect(run.exitCode).toBe(0);
  const screen = run.frames.find((frame) => frame.label === 'esc')?.screen ?? '';
  // The person words show; the interrupted-on-purpose line is model context only.
  expect(screen).not.toContain('의도적으로 중단');
  expect(screen).not.toContain('❯ after cancel');
}, 90_000);
