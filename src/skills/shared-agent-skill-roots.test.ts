import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharedAgentSkillRoots } from './shared-agent-skill-roots.js';

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'shared-agent-roots-'));
  try { run(home); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

describe('sharedAgentSkillRoots', () => {
  test('includes only an existing directory, never a file or missing path', () => {
    withHome((home) => {
      const root = join(home, '.agents', 'skills');
      expect(sharedAgentSkillRoots({ home })).toEqual([]);
      mkdirSync(join(home, '.agents'));
      writeFileSync(root, 'not a directory');
      expect(sharedAgentSkillRoots({ home })).toEqual([]);
      rmSync(root);
      mkdirSync(root);
      expect(sharedAgentSkillRoots({ home })).toEqual([root]);
    });
  });

  test('disabled returns empty without probing; probe failure is fail-soft', () => {
    const exists = () => { throw new Error('unreadable'); };
    expect(sharedAgentSkillRoots({ home: '/unused', exists, includeSharedAgentSkills: false })).toEqual([]);
    expect(sharedAgentSkillRoots({ home: '/unused', exists })).toEqual([]);
  });

  test('discovery does not create or change children under the shared root', () => {
    withHome((home) => {
      const root = join(home, '.agents', 'skills');
      mkdirSync(join(root, 'x'), { recursive: true });
      writeFileSync(join(root, 'x', 'SKILL.md'), 'shared skill');
      const before = readdirSync(root);
      const skillBefore = readdirSync(join(root, 'x'));
      expect(sharedAgentSkillRoots({ home })).toEqual([root]);
      expect(readdirSync(root)).toEqual(before);
      expect(readdirSync(join(root, 'x'))).toEqual(skillBefore);
    });
  });
});
