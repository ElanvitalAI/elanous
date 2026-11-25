import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { simAgentRegistry } from '../ux-sim/interaction.js';

// The footer says «Turn done» where the wide sentence fits, else the short clause «○ done»; either means settled.
const TURN_DONE = (screen: string): boolean => /Turn done|○ done/.test(screen);

test('Next PTY groups background Agents without raw dispatch rows and settles the card', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-agent-noise-'));
  // Three distinct workers in one parallel batch: the per-seat guard admits at most 3 running agents and refuses
  // re-spawns of the same work, so the old «same prompt five times» fixture no longer reaches five children.
  const batch = [1, 2, 3].map((n) => ({ name: 'Agent', args: { description: `noise worker ${n}`, prompt: `slow-child task part ${n}`, reason: 'roster fixture', run_in_background: true, max_turns: 1 } }));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 40, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'NOISE_REPLY',
        ELANOUS_TEST_FAKE_LLM_DELAY_MS: '2500', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'slow-child',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify([{ when: 'noise-parent', parallel: batch }]),
      },
      ready: { label: 'boot', until: 'Ctrl+Q quit' },
      steps: [
        { label: 'log focus', text: 'noise-parent', until: TURN_DONE, timeoutMs: 30_000 }, // Source: #36642. Basic chat hides the roster until the parent turn settles.
        { label: 'running', keys: '\x1b[5~', until: (screen) => screen.includes('◐ sub-agents · running 3'), timeoutMs: 30_000 }, // Source: #36642 three-child dispatch fixture. PageUp leaves basic chat so the roster is visible.
        { label: 'settled', until: (screen) => screen.includes('✓ sub-agents · done 3'), timeoutMs: 30_000 }, // Source: #36642 three-child dispatch fixture. TUI-NOTICE-QUIET: «Results ready N» is no longer drawn, the roster's done row is the settled surface.
      ],
    });
    if (process.env.ELANOUS_TUI_EVIDENCE_PATH) {
      writeFileSync(process.env.ELANOUS_TUI_EVIDENCE_PATH, JSON.stringify(run, null, 2));
    }
    expect(run.exitCode).toBe(0);
    const runningFrame = run.frames.find((frame) => frame.label === 'running')!.screen;
    expect(runningFrame.match(/sub-agents/g)?.length).toBe(1); // Source: one grouped card in the captured running frame.
    expect(runningFrame).not.toContain('(running in background — taskId=');
    expect(runningFrame).not.toContain('도구: Agent result');
    const settledFrame = run.frames.find((frame) => frame.label === 'settled')!.screen;
    expect(settledFrame).toContain('✓ sub-agents · done 3'); // Source: three terminal tasks in the captured PTY frame.
    expect(settledFrame).not.toContain('sub-agents · running');
    expect(settledFrame).not.toContain('(running in background — taskId=');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 65_000); // Source: two 30-second PTY step bounds plus CLI startup/exit.

test('three background Agents stay listed while typing, and one can be stopped by ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-task-roster-'));
  const capture = join(root, 'requests.jsonl');
  const batch = [1, 2, 3].map((n) => ({ name: 'Agent', args: { description: `flood worker ${n}`, prompt: `slow-child task part ${n}`, reason: 'roster fixture', run_in_background: true, max_turns: 1 } }));
  let target = '';
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    expect(simAgentRegistry({ background: 5 }).list()).toHaveLength(5); // Source: #36642
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 40, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'flood reply {step}', ELANOUS_TEST_FAKE_LLM_CAPTURE: capture,
        ELANOUS_TEST_FAKE_LLM_DELAY_MS: '12000', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'slow-child',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify([{ when: 'flood-parent', parallel: batch }]),
      },
      ready: { label: 'boot', until: 'Ctrl+Q quit' },
      steps: [
        { label: 'turn settled', text: 'flood-parent', until: TURN_DONE, timeoutMs: 35_000 }, // Source: #36642. Basic chat hides the roster until the parent turn settles.
        { label: 'three running', keys: '\x1b[5~', until: (screen) => {
          const rows = [...screen.matchAll(/([0-9a-f]{8}) · flood worker 3 · running/g)];
          if ([...screen.matchAll(/flood worker [123] · running/g)].length < 3 || rows.length < 1) return false;
          target = rows[0]![1]!;
          return true;
        }, timeoutMs: 35_000 }, // Source: #36642
        { label: 'composer responsive', text: 'still-typing', enter: false, until: '❯ still-typing' },
        { label: 'clear draft', keys: '\x15', until: (screen) => !screen.includes('❯ still-typing') },
        { label: 'list', text: '/tasks', until: '3 tasks' },
        { label: 'cancel', text: () => `/tasks stop ${target}`, until: 'Stop requested', timeoutMs: 15_000 }, // Source: #36642. Stop acknowledgement is the visible basic-chat line.
        { label: 'aborted row', keys: '\x1b[5~', until: (screen) => screen.includes(`${target} · flood worker 3 · aborted`), timeoutMs: 15_000 }, // Source: #36642. PageUp leaves basic chat so the roster row is visible.
        // Source: #38650 — capsule-done now auto-submits its own turn and that turn consumes
        // each pending result at once, so the footer never sits on «Results ready 5» anymore.
        // The roster rows are the terminal surface: nothing running, the four non-stopped done.
        { label: 'all terminal', until: (screen) => [...screen.matchAll(/flood worker [123] · running/g)].length === 0 && [...screen.matchAll(/flood worker [123] · done/g)].length >= 2, timeoutMs: 30_000 }, // Source: #36642 five-child fixture, surface per #38650
        { label: 'next turn receives results', text: 'collect-results', until: (screen) => screen.includes('❯ collect-results') && TURN_DONE(screen), timeoutMs: 30_000 }, // Source: #36642. The next turn must finish before result delivery is asserted.
      ],
    });
    const requests = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    // Source: #38650 — the capsule-done auto-submitted turns consume the pending results one by
    // one (measured: 2+1+1+1 across four notice turns, zero in the collect-results turn), so
    // delivery is asserted over every captured request instead of the collect-results turn only.
    const delivered = requests.map((request) => JSON.stringify(request.messages)).join('');
    expect(run.actualHost).toBeTruthy();
    expect(run.exitCode).toBe(0);
    expect(Date.parse(run.frames[2]!.at) - Date.parse(run.frames[1]!.at)).toBeLessThan(1500); // Source: #36642
    expect(delivered.match(/<task id=/g)).toHaveLength(3); // Source: #36642 three-child fixture; delivery vehicle changed to capsule-done auto turns by #38650
    expect(delivered).toContain('status=\\"aborted\\"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 65_000);

test('a failed background Agent has an ID and failed state in the real PTY', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-task-failed-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_CONFIG_DIR: root,
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_FAIL_WHEN: 'child-failure',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'fail-parent', name: 'Agent',
          args: { description: 'failing worker', prompt: 'child-failure', reason: 'failure fixture', run_in_background: true, max_turns: 1 } }), // Source: #36642
      },
      ready: { label: 'boot', until: 'Ctrl+Q quit' },
      steps: [
        { label: 'submit', text: 'fail-parent', until: TURN_DONE, timeoutMs: 20_000 }, // Source: #36642. Basic chat hides the failed roster row until the parent turn settles.
        { label: 'failed', keys: '\x1b[5~', until: (screen) => /[0-9a-f]{8} · failing worker · failed/.test(screen), timeoutMs: 20_000 }, // Source: #36642. PageUp leaves basic chat so the roster is visible.
      ],
    });
    expect(run.exitCode).toBe(0);
    expect(run.frames[2]!.screen).toMatch(/[0-9a-f]{8} · failing worker · failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
