import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { makeSkill } from './skill-maker.js';

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-maker-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'sample-plugin', version: '1.2.3',
    extensions: { 'ai.elanous': { graphs: ['./graphs/main.yaml'], capabilities: ['fs:workdir'] } } }, null, 2) + '\n');
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const gap = { name: 'Digest skill', use: 'Summarize tickets.', evidence: ['https://example.org/skills'] };

test('one gap writes one wizard-format skill and keeps the manifest unchanged', () => {
  const dir = fixture();
  const before = readFileSync(join(dir, 'plugin.json'));
  const path = makeSkill({ dir, gap, id: 'digest-skill' });
  expect(path).toBe(join(dir, 'skills/digest-skill/SKILL.md'));
  const skill = readFileSync(path, 'utf8');
  expect(skill).toMatch(/^---\n[\s\S]+---\n\n/);
  expect(parseYaml(skill.split('---')[1]!)).toEqual({ name: 'digest-skill', description: gap.use, requires: [] });
  expect(skill).toContain('Summarize tickets.\n\nResearch sources:\nhttps://example.org/skills');
  expect(readFileSync(join(dir, 'plugin.json'))).toEqual(before);
  expect(() => makeSkill({ dir, gap, id: 'digest-skill' })).toThrow('already exists');
  expect(readFileSync(path, 'utf8')).toBe(skill);
});

test('two distinct gaps write distinct skills without clobbering the first', () => {
  const dir = fixture();
  const first = makeSkill({ dir, gap, id: 'digest-skill' });
  const second = makeSkill({ dir, gap: { name: 'Publish skill', use: 'Publish tickets.', evidence: [] }, id: 'publish-skill' });
  expect(first).not.toBe(second);
  expect(readFileSync(first, 'utf8')).toContain('Summarize tickets.');
  expect(readFileSync(second, 'utf8')).toContain('Publish tickets.');
});

test('a linked ancestor is accepted without accepting a linked plugin directory', () => {
  const dir = fixture();
  const aliasRoot = mkdtempSync(join(tmpdir(), 'skill-maker-alias-'));
  dirs.push(aliasRoot);
  symlinkSync(dirname(dir), join(aliasRoot, 'parent'), 'dir');
  const aliasDir = join(aliasRoot, 'parent', basename(dir));
  const path = makeSkill({ dir: aliasDir, gap, id: 'digest-skill' });
  expect(path).toBe(join(aliasDir, 'skills/digest-skill/SKILL.md'));
  expect(existsSync(path)).toBe(true);
  const linkedDir = join(aliasRoot, 'linked-plugin');
  symlinkSync(dir, linkedDir, 'dir');
  expect(() => makeSkill({ dir: linkedDir, gap, id: 'another-skill' })).toThrow('unsafe');
});

test('preflight rejects missing manifest, unconfirmed gap and symlink before writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-maker-'));
  dirs.push(dir);
  expect(() => makeSkill({ dir, gap, id: 'digest-skill' })).toThrow('plugin.json');
  expect(existsSync(join(dir, 'skills'))).toBe(false);
  const plugin = fixture();
  expect(() => makeSkill({ dir: plugin, gap: { ...gap, name: '미확인' }, id: 'digest-skill' })).toThrow('invalid skill gap');
  expect(() => makeSkill({ dir: plugin, gap, id: '../escape' })).toThrow('invalid skill gap');
  const outside = mkdtempSync(join(tmpdir(), 'skill-maker-outside-'));
  dirs.push(outside);
  symlinkSync(outside, join(plugin, 'skills'), 'dir');
  expect(() => makeSkill({ dir: plugin, gap, id: 'digest-skill' })).toThrow('unsafe');
  expect(existsSync(join(outside, 'digest-skill'))).toBe(false);
});
