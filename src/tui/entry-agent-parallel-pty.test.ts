import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_DELAY_MS_ENV, TEST_FAKE_LLM_DELAY_WHEN_ENV, TEST_FAKE_LLM_RESPONSE_RULES_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV } from '../ux-sim/fake-llm.js';

// OP-SUBAGENT-VIA-HARNESS (O8) — evidence in a real Next TUI PTY that sub-agents delegated in ONE assistant message run side by side:
// every `Agent` row is in flight at the same time (not one after another), and the parent gets its answer after all of them return.
// The children are slowed by the fake LLM, so «at the same time» is a screen fact, not a wall-clock assertion.
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const CHILDREN = ['A', 'B', 'C'] as const;
const PARENT_DONE = 'PARENT-DELEGATED';

test('a batch of Agent calls shows every child running at once and then the parent answers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-parallel-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    // #38772: an Agent call without run_in_background runs in the background, and the parent would answer at once.
    // This test proves the parent answers only after every child returns, so it asks for the blocking call explicitly.
    const batch = CHILDREN.map((name) => ({ name: 'Agent', args: { description: `probe ${name}`, prompt: `Investigate ${name} and answer in one line`, reason: 'parallel probe', run_in_background: false } }));
    const seen: Record<string, string> = {};
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 40, cols: 130,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: PARENT_DONE,
        [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify([{ when: 'DELEGATE', parallel: batch }]),
        // Only the children's prompts («Investigate …») are slow, so the rows stay in flight long enough to be seen together.
        [TEST_FAKE_LLM_DELAY_MS_ENV]: '6000', [TEST_FAKE_LLM_DELAY_WHEN_ENV]: 'Investigate',
      },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [
        { label: 'all children in flight', text: 'DELEGATE please', until: (screen) => {
          const running = screen.split('\n').filter((line) => /⏺ 🤖 probe /u.test(line)).length;
          if (running === CHILDREN.length && /Running Agent/.test(screen)) seen.together = screen;
          return seen.together !== undefined;
        } },
        { label: 'parent answers', text: '', enter: false, until: (screen) => { seen.done = screen; return screen.includes(PARENT_DONE); } },
      ],
    });
    expect(run.exitCode).toBe(0);
    expect(seen.together).toBeDefined();
    expect(seen.together).not.toContain(PARENT_DONE);
    expect(seen.done).toContain(PARENT_DONE);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, out); else out.push(path);
  }
  return out;
}

// O8 (a)(b): each child's row reads «🤖 <label> — <reason> · <one-line result>», and what the child's own tools read never reaches the parent.
test('Agent rows show the label and a one-line result, and the child\'s tool output stays out of the parent session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-rows-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const childData = join(root, 'child-data.txt');
    const CHILD_TOOL_OUTPUT = 'CHILD-TOOL-OUTPUT-MARK';
    writeFileSync(childData, `${CHILD_TOOL_OUTPUT} the child read this file\n`);
    // #38772: an Agent call without run_in_background runs in the background. This test reads each child's
    // completed one-line result on its row, so it asks for the blocking call explicitly.
    const batch = CHILDREN.map((name) => ({ name: 'Agent', args: { description: `probe ${name}`, prompt: `Investigate ${name} and answer in one line`, reason: 'parallel probe', run_in_background: false } }));
    const summaryOf = (name: string): string => `CHILD-SUMMARY-${name} found the answer`;
    const seen: Record<string, string> = {};
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 40, cols: 130,
      env: {
        ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: PARENT_DONE,
        [TEST_FAKE_LLM_RESPONSE_RULES_ENV]: JSON.stringify(CHILDREN.map((name) => ({ when: `Investigate ${name}`, text: summaryOf(name) }))),
        [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify([
          { when: 'DELEGATE', parallel: batch },
          // Each child reads a file first: that output belongs to the child's context only.
          ...CHILDREN.map((name) => ({ when: `Investigate ${name}`, name: 'Read', args: { file_path: childData } })),
        ]),
      },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [
        { label: 'parent answers', text: 'DELEGATE please', until: (screen) => { seen.done = screen; return screen.includes(PARENT_DONE); } },
      ],
    });
    expect(run.exitCode).toBe(0);
    const rows = seen.done!.split('\n').filter((line) => /✓ 🤖 probe /u.test(line));
    expect(rows).toHaveLength(CHILDREN.length);
    for (const name of CHILDREN) {
      expect(rows.some((line) => line.includes(`🤖 probe ${name} \u2014 parallel probe `) && line.includes(`· ${summaryOf(name)}`))).toBe(true);
    }
    expect(seen.done).not.toContain(CHILD_TOOL_OUTPUT);
    // The parent's saved session holds the children's final answers, not what their tools read.
    const saved = filesUnder(join(root, 'sessions')).map((path) => readFileSync(path, 'utf8')).join('\n');
    for (const name of CHILDREN) expect(saved).toContain(summaryOf(name));
    expect(saved).not.toContain(CHILD_TOOL_OUTPUT);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);
