import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nativeToolCatalog } from '../native-tool-catalog.js';
import { buildElanousSkillsListTool } from '../tool-runtime/elanous-skills-list-runtime.js';
import {
  SKILLS_LIST_DESCRIPTION,
  SKILLS_STEP_COMMAND,
  UNATTENDED_SETUP_COMMAND,
  unattendedSetupHint,
} from './entry-hints.js';

const root = join(import.meta.dir, '../..');

test('onboarding entry commands and rendered unattended hint', () => {
  expect(SKILLS_STEP_COMMAND).toBe('elanous onboarding skills');
  expect(UNATTENDED_SETUP_COMMAND).toBe('elanous onboarding --non-interactive --config <answers.json>');
  expect(unattendedSetupHint()).toBe(`unattended: \`${UNATTENDED_SETUP_COMMAND}\``);
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
