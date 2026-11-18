import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// DECISION-GATE v2 reads a turn's outcome from the plan the model records with update_plan. The Next TUI's child REPL
// did not advertise that tool, so every call failed («INVALID TOOL») and the gate never saw a plan.
test('the Next TUI child accepts update_plan and the turn end reads its state (a blocked step tells a person)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-update-plan-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    let final = '';
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 120,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: 'PLAN-RECORDED',
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify([{ when: 'PLAN-PROBE', calls: [{ name: 'update_plan',
          args: { plan: [{ step: 'deploy to production', status: 'blocked', reason: 'owner approval needed' }] } }] }]),
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [{ label: 'turn', text: 'PLAN-PROBE deploy it', until: (screen) => { final = screen; return /Blocked: owner approval needed/.test(screen); } }],
    });
    expect(run.exitCode).toBe(0);
    // The gate read the plan: blocked → a person is told, with the reason from the tool.
    expect(final).toContain('⏸ Blocked: owner approval needed — a person is needed');
    const sessionFile = readdirSync(join(root, 'sessions')).find((name) => name.endsWith('.jsonl'))!;
    const results = readFileSync(join(root, 'sessions', sessionFile), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { toolName?: string; toolResult?: unknown; content?: string })
      .filter((row) => row.toolName === 'update_plan').map((row) => String(row.toolResult ?? row.content ?? ''));
    expect(results.length).toBe(1);
    expect(results[0]).not.toContain('INVALID TOOL');
    expect(results[0]).not.toContain('update_plan failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
