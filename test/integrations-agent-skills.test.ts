import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(import.meta.dir, '..');
const skill = readFileSync(join(root, 'integrations/agent-skills/attach-elanous/SKILL.md'), 'utf8');
const formula = readFileSync(join(root, 'integrations/homebrew/elanous.rb'), 'utf8');

test('attach-elanous carries the fields ClawHub and agentskills.io read (EN11)', () => {
  const front = parse(skill.split('---')[1]!) as Record<string, string>;
  expect(front.name).toBe('attach-elanous');
  expect(front.summary?.length).toBeGreaterThan(20);
  expect(front.description?.length).toBeGreaterThan(20);
  expect(front.license).toBe('Apache-2.0');
  expect(skill).toContain('## Examples');
});

test('the formula url and sha256 move together and the CLI is not named like the desktop cask', () => {
  const version = formula.match(/elanous-(\d+\.\d+\.\d+)\.tgz/)?.[1];
  expect(version).toBeDefined();
  expect(formula).toMatch(/sha256 "[0-9a-f]{64}"/);
  expect(formula).toContain('class Elanous < Formula');
  expect(formula).toContain('elanous-desktop');
});
