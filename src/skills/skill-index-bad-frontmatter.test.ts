import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillIndex } from './index.js';
import { frontmatterText, parseSkillMd } from './runner.js';
import { extractTriggers } from './trigger-extract.js';

// 0.2.6 beta tester: a third-party SKILL.md wrote `description:` as a YAML list → the first screen crashed
// with `description.trim is not a function` (extractTriggers ← makeEntry ← buildSkillIndex ← showDashboard).
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function skills(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-index-bad-fm-'));
  roots.push(root);
  for (const [name, md] of Object.entries(files)) { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'SKILL.md'), md); }
  return root;
}

describe('a malformed third-party skill does not take down the skill index', () => {
  test('block-list description is read as one line of text', () => {
    const root = skills({ listy: '---\nname: listy\ndescription:\n  - first line\n  - second line\n---\nbody\n' });
    expect(parseSkillMd('listy', root)?.description).toBe('first line second line');
    expect(buildSkillIndex(root).map((e) => e.name)).toEqual(['listy']);
  });

  test('flow-list description is read as text and the good neighbour survives', () => {
    const root = skills({
      flow: '---\nname: flow\ndescription: [Beta, tool]\n---\nbody\n',
      good: '---\nname: good\ndescription: plain text 요약 시 사용\n---\nbody\n',
    });
    expect(buildSkillIndex(root).map((e) => e.name).sort()).toEqual(['flow', 'good']);
  });

  test('frontmatterText and extractTriggers never throw on non-strings', () => {
    expect(frontmatterText(['a', 1, 'b'])).toBe('a b');
    expect(frontmatterText(undefined)).toBe('');
    expect(frontmatterText({ x: 1 })).toBe('');
    expect(extractTriggers(['x'] as unknown as string)).toEqual([]);
    expect(extractTriggers(undefined as unknown as string)).toEqual([]);
  });
});
