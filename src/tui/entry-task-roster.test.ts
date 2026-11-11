import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { simAgentRegistry } from '../ux-sim/interaction.js';

test('Next PTY groups background Agents without raw dispatch rows and settles the card', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-agent-noise-'));
  const args = { description: 'noise worker', prompt: 'slow-child task', run_in_background: true, max_turns: 1 }; // Source: #36642 background Agent fixture.
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
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'noise-parent', name: 'Agent', args, after: { name: 'Agent', args } }),
      },
      ready: { label: 'boot', until: 'Ctrl+Q 종료' },
      steps: [
        { label: 'running', text: 'noise-parent', until: (screen) => screen.includes('◐ 하위 에이전트 · 실행 중 5'), timeoutMs: 30_000 }, // Source: #36642 five-child dispatch fixture.
        { label: 'settled', until: (screen) => screen.includes('✓ 결과 대기 5'), timeoutMs: 30_000 }, // Source: #36642 five-child dispatch fixture and BackgroundJobStatus pending-result state.
      ],
    });
    if (process.env.ELANOUS_TUI_EVIDENCE_PATH) {
      writeFileSync(process.env.ELANOUS_TUI_EVIDENCE_PATH, JSON.stringify(run, null, 2));
    }
    expect(run.exitCode).toBe(0);
    const runningFrame = run.frames.find((frame) => frame.label === 'running')!.screen;
    expect(runningFrame.match(/하위 에이전트/g)?.length).toBe(1); // Source: one grouped card in the captured running frame.
    expect(runningFrame).not.toContain('(running in background — taskId=');
    expect(runningFrame).not.toContain('도구: Agent result');
    const settledFrame = run.frames.find((frame) => frame.label === 'settled')!.screen;
    expect(settledFrame).toContain('✓ 하위 에이전트 · 완료 5'); // Source: five terminal tasks in the captured PTY frame.
    expect(settledFrame).not.toContain('하위 에이전트 · 실행 중');
    expect(settledFrame).not.toContain('(running in background — taskId=');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 65_000); // Source: two 30-second PTY step bounds plus CLI startup/exit.

test('five background Agents stay listed while typing, and one can be stopped by ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-task-roster-'));
  const capture = join(root, 'requests.jsonl');
  const args = { description: 'flood worker', prompt: 'slow-child task', run_in_background: true, max_turns: 1 }; // Source: #36642
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
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'flood-parent', name: 'Agent', args, after: { name: 'Agent', args } }),
      },
      ready: { label: 'boot', until: 'Ctrl+Q 종료' },
      steps: [
        { label: 'five running', text: 'flood-parent', until: (screen) => {
          const rows = [...screen.matchAll(/([0-9a-f]{8}) · flood worker · running/g)];
          if (rows.length < 5) return false;
          target = rows[4]![1]!;
          return true;
        }, timeoutMs: 35_000 }, // Source: #36642
        { label: 'composer responsive', text: 'still-typing', enter: false, until: '❯ still-typing' },
        { label: 'clear draft', keys: '\x15', until: (screen) => !screen.includes('❯ still-typing') },
        { label: 'list', text: '/tasks', until: '작업 5건' },
        { label: 'cancel', text: () => `/tasks stop ${target}`, until: (screen) => screen.includes(`${target} · flood worker · aborted`), timeoutMs: 15_000 }, // Source: #36642
        { label: 'all terminal', until: '백그라운드 끝 5', timeoutMs: 30_000 }, // Source: #36642
        { label: 'next turn receives results', text: 'collect-results', until: (screen) => screen.includes('나: collect-results') && screen.includes('응답 완료') },
      ],
    });
    const requests = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const delivery = requests.find((request) => JSON.stringify(request.messages).includes('collect-results'));
    const delivered = JSON.stringify(delivery?.messages ?? []);
    expect(run.actualHost).toBeTruthy();
    expect(run.exitCode).toBe(0);
    expect(Date.parse(run.frames[2]!.at) - Date.parse(run.frames[1]!.at)).toBeLessThan(1500); // Source: #36642
    expect(delivered.match(/<task id=/g)).toHaveLength(5); // Source: #36642
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
          args: { description: 'failing worker', prompt: 'child-failure', run_in_background: true, max_turns: 1 } }), // Source: #36642
      },
      ready: { label: 'boot', until: 'Ctrl+Q 종료' },
      steps: [
        { label: 'submit', text: 'fail-parent', until: (screen) => screen.includes('failing worker') },
        { label: 'failed', until: (screen) => /[0-9a-f]{8} · failing worker · failed/.test(screen), timeoutMs: 20_000 }, // Source: #36642
      ],
    });
    expect(run.exitCode).toBe(0);
    expect(run.frames[2]!.screen).toMatch(/[0-9a-f]{8} · failing worker · failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
