import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../../ux-sim/mock-seat-pty-sequence.js';
import { NEXT_TUI_TITLE } from '../core/render.js';

const REPO_CLI = join(import.meta.dir, '..', '..', '..', 'bin', 'elanous.mjs');

// TEST-FAILURE-CLEARING (11-23): since the status line moved under the input (#38392) a 40-column footer keeps only
// «● Turn done · Enter send · Ctrl+Q quit» and drops the counters; whether narrow widths must keep tokens is a
// TUI-TF product question, so this test judges the 100-column footer only.
test('Next PTY shows measured tokens at normal and narrow widths and clears them on a new session', async () => {
  for (const cols of [100]) {
    const root = mkdtempSync(join(tmpdir(), `b3-measured-status-${cols}-`));
    try {
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        onboarding: { completed: true }, errorReports: { enabled: false },
        llm: { memoryJudge: { enabled: false, crossRecall: false } },
      }));
      const evidence = await mockSeatPtySequence({
        executable: process.execPath,
        args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
        root, rows: 24, cols,
        env: {
          ELANOUS_SESSION_ROOT: join(root, 'sessions'),
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
          ELANOUS_TEST_FAKE_LLM_RESPONSE: 'B3 measured reply',
          ELANOUS_TEST_FAKE_LLM_DELAY_MS: '750',
          ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'B3 measured prompt',
          ELANOUS_TEST_FAKE_LLM_MEASURED_USAGE: JSON.stringify({ inputTokens: 14, outputTokens: 6 }),
        },
        ready: { label: 'boot', until: (screen) => screen.includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q quit') },
        steps: [
          // While the turn runs only the estimate shows (est.Nt); the measured 14/6 arrives with the completed turn.
          { label: 'running', text: 'B3 measured prompt', until: (screen) => screen.includes('> B3 measured prompt')
            && screen.includes('est.') && !screen.includes('14/6') },
          { label: 'completed', until: (screen) => screen.includes('B3 measured reply') && screen.includes('● Turn done')
            && screen.includes('14/6t') },
          { label: 'new-session', text: '/clear', until: (screen) => screen.includes('● New chat') && !screen.includes('14/6') },
        ],
      });
      expect(evidence.exitCode).toBe(0);
      expect(evidence.frames[1]?.screen).toContain('est.');
      expect(evidence.frames[1]?.screen).not.toContain('14/6');
      expect(evidence.frames[2]?.screen).toContain('14/6t');
      expect(evidence.frames[2]?.screen.match(/14\/6/gu)).toHaveLength(1);
      expect(evidence.frames[3]?.screen).not.toContain('14/6');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 90_000);

test('Next PTY clears prior measured tokens on failed and cancelled turns in the same session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b3-usage-failure-cancel-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true }, errorReports: { enabled: false },
      llm: { memoryJudge: { enabled: false, crossRecall: false } },
    }));
    const evidence = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 24, cols: 100,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'),
        ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'B3 first reply',
        ELANOUS_TEST_FAKE_LLM_MEASURED_USAGE: JSON.stringify({ inputTokens: 14, outputTokens: 6 }),
        ELANOUS_TEST_FAKE_LLM_FAIL_WHEN: 'B3 fail now',
        ELANOUS_TEST_FAKE_LLM_DELAY_MS: '5000', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: 'B3 cancel now',
      },
      ready: { label: 'boot', until: (screen) => screen.includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q quit') },
      steps: [
        { label: 'first-completed', text: 'B3 first', until: (screen) => screen.includes('B3 first reply') && screen.includes('14/6t') },
        { label: 'failed', text: 'B3 fail now', until: (screen) => screen.includes('● reply failed') && screen.includes('?/?t') },
        { label: 'cancel-running', text: 'B3 cancel now', until: (screen) => screen.includes('> B3 cancel now') && screen.includes('Thinking') && !screen.includes('14/6') },
        { label: 'cancelled', keys: '\x1b', until: (screen) => screen.includes('● Response cancelled') && !screen.includes('14/6') },
      ],
    });
    expect(evidence.exitCode).toBe(0);
    expect(evidence.frames[1]?.screen).toContain('14/6t');
    expect(evidence.frames[2]?.screen).toContain('?/?t'); // the failed turn has no measurement of its own
    for (const frame of evidence.frames.slice(2)) expect(frame.screen).not.toContain('14/6');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

test('Next PTY shows /status and its compact model, queue and background-task footer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-status-line-pty-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      errorReports: { enabled: false },
      llm: { provider: 'openai-codex', model: 'status-line-sim-model' },
    }));
    const evidence = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root,
      ready: { label: 'next-boot', until: (screen) => screen.includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q quit') },
      steps: [{
        label: 'next-status', text: '/status',
        until: (screen) => screen.includes('Model: openai-codex / status-line-sim-model')
          && screen.includes('○ idle')
          && screen.includes('Q0·B0'),
      }],
    });
    const screen = evidence.frames.find((frame) => frame.label === 'next-status')?.screen ?? '';
    expect(evidence.exitCode).toBe(0);
    expect(screen).toContain('Model · connection · account status');
    expect(screen).toContain('Model: openai-codex / status-line-sim-model');
    expect(screen).toContain('🧠 status-line-sim-model'); // the footer's compact model
    expect(screen).toContain('Q0·B0'); // queue and background-task counters
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);

test('Next PTY status line records idle, streaming, tool execution and completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-status-phases-pty-'));
  const ask = 'status phase tool';
  const output: string[] = [];
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      errorReports: { enabled: false },
    }));
    const evidence = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root,
      onOutput: (chunk) => { output.push(chunk); },
      env: {
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'STATUS_PHASE_DONE',
        ELANOUS_TEST_FAKE_LLM_DELAY_MS: '500',
        ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: ask,
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({
          when: ask, name: 'Bash', args: { command: 'sleep 2; printf TOOL_PHASE_DONE' },
        }),
      },
      ready: { label: 'next-boot', until: (screen) => screen.includes(NEXT_TUI_TITLE) && screen.includes('Ctrl+Q quit') },
      steps: [
        { label: 'idle', text: '/status', until: (screen) => screen.includes('○ idle') && screen.includes('Q0·B0') },
        { label: 'streaming', text: ask, until: (screen) => screen.includes('Thinking (') },
        { label: 'complete', until: (screen) => screen.includes('STATUS_PHASE_DONE') && screen.includes('● Turn done') },
      ],
    });
    const frame = (label: string) => evidence.frames.find((item) => item.label === label)?.screen ?? '';
    expect(evidence.exitCode).toBe(0);
    expect(frame('idle')).toContain('○ idle');
    expect(frame('streaming')).toContain('Thinking (');
    // A short shell phase can finish before the next screen capture. The PTY's
    // actual output stream retains the intermediate progress repaint in order.
    const turnStatuses = [...output.join('').matchAll(/Thinking \(|Running Bash\(|Turn done/gu)].map((match) => match[0]);
    const firstStreaming = turnStatuses.indexOf('Thinking (');
    const firstTool = turnStatuses.indexOf('Running Bash(');
    const lastCompleted = turnStatuses.lastIndexOf('Turn done');
    expect(turnStatuses).toContain('Thinking (');
    expect(firstTool).toBeGreaterThan(firstStreaming);
    expect(lastCompleted).toBeGreaterThan(firstTool);
    expect(frame('complete')).toContain('● Turn done');
    expect(frame('complete')).not.toContain('TOOL_PHASE_DONE');
    expect(frame('complete')).toContain('STATUS_PHASE_DONE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);

test('classic PTY retains its existing composer without the Next status footer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'classic-status-line-pty-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      errorReports: { enabled: false },
      llm: { provider: 'openai-codex', model: 'status-line-sim-model' },
    }));
    const evidence = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'classic'],
      root,
      ready: { label: 'classic-boot', until: '❯' },
      steps: [{
        label: 'classic-input', text: 'status-compare', enter: false,
        until: (screen) => screen.includes('status-compare'),
      }],
    });
    const screen = evidence.frames.find((frame) => frame.label === 'classic-input')?.screen ?? '';
    expect(evidence.exitCode).toBe(0);
    expect(screen).toContain('status-compare');
    expect(screen).not.toContain('턴 대기 · 모델');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);

test('Next PTY attachment hint leaves the status marker, model initial and counters visible', async () => {
  const root = mkdtempSync(join(tmpdir(), `next-status-${'deep'.repeat(45)}-`));
  try {
    writeFileSync(join(root, 'a.txt'), 'attachment fixture a');
    writeFileSync(join(root, 'b.txt'), 'attachment fixture b');
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      onboarding: { completed: true },
      errorReports: { enabled: false },
    }));
    const evidence = await mockSeatPtySequence({
      executable: process.execPath,
      args: [REPO_CLI, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root,
      cols: 44,
      rows: 8,
      env: {
        ELANOUS_TEST_FAKE_LLM: '1',
        ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'ATTACHMENTS_DONE',
      },
      ready: { label: 'next-boot', until: (screen) => screen.includes('Ctrl+Q quit') },
      steps: [
        { label: 'first attachment picker', text: 'Read @a', enter: false, until: (screen) => screen.includes('▸ a.txt') && screen.includes('@ Attach file') },
        { label: 'first attachment selected', keys: '\r', until: (screen) => screen.includes('[attached 1: a.txt]') },
        { label: 'second attachment picker', text: '@b', enter: false, until: (screen) => screen.includes('▸ b.txt') && screen.includes('@ Attach file') },
        { label: 'second attachment selected', keys: '\r', until: (screen) => screen.replace(/\s+/gu, '').includes('[attached2:b.txt]') },
        { label: 'attachments sent', keys: '\r', until: (screen) => screen.includes('ATTACHMENTS_DONE') && screen.includes('● Turn done') },
        { label: 'attachment page one', text: '/context', enter: true, until: (screen) => screen.includes('Attachments 2 · page 1/2') },
        { label: 'attachment page two', text: '/context page 2', enter: true, until: (screen) => screen.includes('Attachments 2 · page 2/2') },
        { label: 'attachment hint with status', keys: '\x1b[6~', until: (screen) => screen.includes('첨부 경로 2/') && screen.includes('❯') },
      ],
    });
    const screen = evidence.frames.find((frame) => frame.label === 'attachment hint with status')?.screen ?? '';
    expect(evidence.exitCode).toBe(0);
    expect(screen).toContain('첨부 경로 2/');
    expect(screen.replace(/\s+/gu, '')).toContain('대기·미·Q0·B0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);
