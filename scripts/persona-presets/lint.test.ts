import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { lintPreset, officialPacks, type Preset } from './lint.js';

const dir = join(import.meta.dir, '../../persona-presets');
const packs = officialPacks();
const load = (f: string) => parse(readFileSync(join(dir, f), 'utf8')) as Preset;
const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_'));

test('all eight presets pass with no errors (PS1)', () => {
  expect(files).toHaveLength(8);
  for (const f of files) expect(lintPreset(load(f), `persona-presets/${f}`, packs).errors).toEqual([]);
});

test('a tool that is not installable, a seat name, a bad title and a banned word are errors', () => {
  const p = structuredClone(load('mira.yaml'));
  p.tools.push({ name: 'diagram-master', from: 'elanous-basics' }, { name: 'youtube-master', from: 'youtube-master', optional: true }, { name: 'doc-draft', from: 'doc-draft' });
  p.names.push('MK');
  p.title = '대표';
  p.oneLine = '무엇이든 해 주는 캐릭터';
  const errors = lintPreset(p, 'persona-presets/mira.yaml', packs).errors;
  expect(errors.some((e) => e.includes('«diagram-master» 이 묶음 «elanous-basics» 의 목록에 없다'))).toBe(true);
  expect(errors.some((e) => e.includes('«youtube-master» 은 공식 묶음에도'))).toBe(true);
  expect(errors).toContain('«doc-draft» 은 공식 묶음에 없다 — optional: true 로 둔다');
  expect(errors.some((e) => e.includes('«MK» 이 자리'))).toBe(true);
  expect(errors.some((e) => e.includes('title'))).toBe(true);
  expect(errors).toContain('금지어 «캐릭터»');
  expect(errors).toContain('금지어 «무엇이든»');
});

test('the public pack table is read, and an unpublished pack does not count', () => {
  expect(packs.get('elanous-basics')).toContain('`omni-crawl`');
  expect(packs.has('elanous-markets')).toBe(false);
});

test('the shipped preset files carry no internal marks (they are in the npm package and the public repo)', () => {
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), 'utf8');
    expect(text).not.toMatch(/\u{1F451}|docs\/|scripts\/|\b(OP|MK|TC|UX)\b|#2\d{4}|\/Users\//u);
  }
});
