import { setDefaultTimeout, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nativeToolCatalog } from '../native-tool-catalog.js';
import { buildElanousSkillsListTool } from '../tool-runtime/elanous-skills-list-runtime.js';
import {
  SKILLS_LIST_DESCRIPTION,
  SKILLS_STEP_COMMAND,
  UNATTENDED_SETUP_COMMAND,
  unattendedNextStepLine,
  unattendedSetupHint,
} from './entry-hints.js';
import { handleOnboardingRefusal, OnboardingRefusedError } from '../onboarding.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const root = join(import.meta.dir, '../..');

test('onboarding entry commands and rendered unattended hint', () => {
  expect(SKILLS_STEP_COMMAND).toBe('elanous onboarding skills');
  expect(UNATTENDED_SETUP_COMMAND).toBe('elanous onboarding --non-interactive --config <answers.json>');
  expect(unattendedSetupHint()).toBe(`unattended: \`${UNATTENDED_SETUP_COMMAND}\``);
  expect(unattendedNextStepLine()).toBe(`next: ${unattendedSetupHint()}`);
});

// FIRST-CHAT-NONTTY: a first chat refused on the non-TTY 'other' entrance ends with the one-line next step, rc stays 2.
function captureRefusal(error: unknown, entrance: 'agent' | 'other') {
  const lines: string[] = [];
  const codes: number[] = [];
  const handled = handleOnboardingRefusal(error, entrance, {
    printError: (line) => lines.push(line),
    setExitCode: (code) => codes.push(code),
  });
  return { handled, lines, codes };
}

test('non-TTY refusal on the other entrance prints the message then the unattended next-step line, rc 2', () => {
  const error = new OnboardingRefusedError('wizard needs a TTY', 'non-tty');
  const { handled, lines, codes } = captureRefusal(error, 'other');
  expect(handled).toBe(true);
  expect(lines).toEqual(['wizard needs a TTY', unattendedNextStepLine()]);
  expect(lines.at(-1)).toContain(UNATTENDED_SETUP_COMMAND);
  expect(lines.at(-1)!.split('\n')).toHaveLength(1);
  expect(codes).toEqual([2]);
});

test('agent non-TTY and autonomous refusals keep their single line without the extra next step', () => {
  const agent = captureRefusal(new OnboardingRefusedError('x', 'non-tty'), 'agent');
  expect(agent.lines).toHaveLength(1);
  expect(agent.lines[0]).toContain(unattendedSetupHint());
  expect(agent.codes).toEqual([2]);
  for (const entrance of ['agent', 'other'] as const) {
    const auto = captureRefusal(new OnboardingRefusedError('universe empty', 'autonomous-empty-universe'), entrance);
    expect(auto.lines).toEqual(['universe empty']);
    expect(auto.codes).toEqual([2]);
  }
});

test('unrelated errors are not handled and leave the exit code alone', () => {
  const { handled, lines, codes } = captureRefusal(new Error('unrelated'), 'other');
  expect(handled).toBe(false);
  expect(lines).toEqual([]);
  expect(codes).toEqual([]);
});

test('unattended onboarding accepts a JSON answers file and --help without unknown option', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-entry-hints-'));
  try {
    const answers = join(dir, 'answers.json');
    writeFileSync(answers, '{}');
    const args = UNATTENDED_SETUP_COMMAND.split(' ').map((arg) => arg === '<answers.json>' ? answers : arg);
    const result = Bun.spawnSync(['bun', join(root, 'bin/elanous.mjs'), '--test', ...args.slice(1), '--help'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    const text = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(0);
    expect(text).not.toContain('unknown option');
    expect(text).toContain('--config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('both skills-list tool descriptions use configured roots without a fixed home path', () => {
  const spec = buildElanousSkillsListTool();
  const catalog = nativeToolCatalog.find((item) => item.id === 'elanous_skills_list');
  expect(spec.description).toBe(SKILLS_LIST_DESCRIPTION);
  expect(catalog?.description).toBe(SKILLS_LIST_DESCRIPTION);
  expect(SKILLS_LIST_DESCRIPTION).toContain('skills.activeSet / skills.dirs');
  expect(SKILLS_LIST_DESCRIPTION).toContain('packaged skills');
  expect(SKILLS_LIST_DESCRIPTION).toContain('Read-only');
  expect(SKILLS_LIST_DESCRIPTION).not.toContain('~/.elanous/skills');
});
