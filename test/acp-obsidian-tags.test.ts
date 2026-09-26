// PLAN-ipad-notes-obsidian-typora §5 Phase O3·2 (2026-05-17) —
// Smoke tests for the daemon-side tag aggregate helper.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findTags,
  TAG_PATTERN,
  extractFrontmatterTags,
} from '../src/acp/obsidian-tags';

describe('TAG_PATTERN regex', () => {
  test('matches a simple inline tag', () => {
    const re = new RegExp(TAG_PATTERN, 'gu');
    const matches = 'this is a #ideas tag'.match(re);
    expect(matches).toEqual(['#ideas']);
  });

  test('matches nested tag with /', () => {
    const re = new RegExp(TAG_PATTERN, 'gu');
    expect('see #project/q4-planning'.match(re)).toEqual(['#project/q4-planning']);
  });

  test('matches tag with hyphen', () => {
    const re = new RegExp(TAG_PATTERN, 'gu');
    expect('a #q4-2026 deadline'.match(re)).toEqual(['#q4-2026']);
  });

  test('does NOT match a heading (## Foo)', () => {
    const re = new RegExp(TAG_PATTERN, 'gu');
    expect('## Heading'.match(re)).toBeNull();
    expect('### Sub'.match(re)).toBeNull();
  });

  test('does NOT match a hex color (#aaaaaa) — starts with hex but needs letters', () => {
    const re = new RegExp(TAG_PATTERN, 'gu');
    // Note: the pattern requires the first char to be a letter, so #fff
    // (hex letters only) WILL match. This is a limitation we accept —
    // Obsidian itself behaves the same way. Document for clarity.
    expect('color #fff'.match(re)).toEqual(['#fff']);
    // True numeric hex DOES NOT match (must start with letter):
    expect('#123456'.match(re)).toBeNull();
  });

  test('한글·한영 혼합 태그를 잡는다 · 단어 중간 # 은 태그가 아니다', () => {
    const re = new RegExp(TAG_PATTERN, 'gu');
    expect('로 간다 #시험 그리고 #AI요약 #프로젝트/사분기-4'.match(re)).toEqual(['#시험', '#AI요약', '#프로젝트/사분기-4']);
    expect('한국어#태그아님'.match(re)).toBeNull();
    expect('## 제목'.match(re)).toBeNull();
    expect('#123'.match(re)).toBeNull();
  });

  test('does NOT match pure-numeric tag', () => {
    const re = new RegExp(TAG_PATTERN, 'gu');
    expect('issue #1234'.match(re)).toBeNull();
  });
});

describe('findTags · live rg over tmpdir vault', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'elanous-tags-test-'));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test('aggregates tag occurrences with counts', async () => {
    writeFileSync(join(vault, 'A.md'), 'has #meeting and #q4-plan\n');
    writeFileSync(join(vault, 'B.md'), 'another #meeting today\n');
    writeFileSync(join(vault, 'C.md'), 'nothing tagged\n');
    const result = await findTags({ vaultRoot: vault });
    expect(result.error).toBeUndefined();
    const by = Object.fromEntries(result.tags.map((t) => [t.tag, t.count]));
    expect(by.meeting).toBe(2);
    expect(by['q4-plan']).toBe(1);
  });

  test('captures sample paths (cap 5 per tag)', async () => {
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(vault, `Note${i}.md`), 'uses #ideas tag\n');
    }
    const result = await findTags({ vaultRoot: vault });
    const ideas = result.tags.find((t) => t.tag === 'ideas');
    expect(ideas).toBeDefined();
    expect(ideas?.count).toBe(8);
    expect(ideas?.samplePaths.length).toBe(5);
    // Sample paths must be a subset of the actual notes.
    for (const p of ideas?.samplePaths ?? []) {
      expect(p).toMatch(/^Note\d\.md$/);
    }
  });

  test('skips markdown headings (## Foo)', async () => {
    writeFileSync(join(vault, 'Doc.md'), '## Heading\n\nbody with #real-tag\n');
    const result = await findTags({ vaultRoot: vault });
    expect(result.tags.find((t) => t.tag === 'Heading')).toBeUndefined();
    expect(result.tags.find((t) => t.tag === 'real-tag')).toBeDefined();
  });

  test('handles nested tag (project/q4)', async () => {
    writeFileSync(join(vault, 'A.md'), '#project/q4-plan see also #project/q3-recap\n');
    const result = await findTags({ vaultRoot: vault });
    const tagNames = result.tags.map((t) => t.tag).sort();
    expect(tagNames).toContain('project/q4-plan');
    expect(tagNames).toContain('project/q3-recap');
  });

  test('sorts by count desc, then tag asc', async () => {
    writeFileSync(join(vault, 'A.md'), '#alpha #beta\n');
    writeFileSync(join(vault, 'B.md'), '#alpha\n');
    writeFileSync(join(vault, 'C.md'), '#gamma\n');
    const result = await findTags({ vaultRoot: vault });
    expect(result.tags[0]?.tag).toBe('alpha'); // count=2
    // Remaining tags (count=1 each) sorted alpha: beta < gamma
    const after = result.tags.slice(1).map((t) => t.tag);
    expect(after).toEqual(['beta', 'gamma']);
  });

  test('honors limit cap', async () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(vault, `T${i}.md`), `#tag${i}\n`);
    }
    const result = await findTags({ vaultRoot: vault, limit: 3 });
    expect(result.tags.length).toBe(3);
  });

  test('strips trailing slash from tag (#foo/ → foo)', async () => {
    writeFileSync(join(vault, 'A.md'), 'tag with trailing slash #foo/ end\n');
    const result = await findTags({ vaultRoot: vault });
    const tagNames = result.tags.map((t) => t.tag);
    expect(tagNames).toContain('foo');
    expect(tagNames).not.toContain('foo/');
  });

  test('returns empty when vault has no tags', async () => {
    writeFileSync(join(vault, 'A.md'), '# Heading\n\nno tags here\n');
    writeFileSync(join(vault, 'B.md'), 'still no tags\n');
    const result = await findTags({ vaultRoot: vault });
    expect(result.error).toBeUndefined();
    expect(result.tags).toEqual([]);
  });

  test('subfolders work — same tag across nested files aggregates', async () => {
    mkdirSync(join(vault, 'Folder'), { recursive: true });
    writeFileSync(join(vault, 'A.md'), '#shared\n');
    writeFileSync(join(vault, 'Folder/B.md'), '#shared\n');
    const result = await findTags({ vaultRoot: vault });
    const shared = result.tags.find((t) => t.tag === 'shared');
    expect(shared?.count).toBe(2);
    expect(shared?.samplePaths.sort()).toEqual(['A.md', 'Folder/B.md']);
  });

  test('rg spawn failure surfaces as rg-spawn error', async () => {
    const result = await findTags({ vaultRoot: vault, rgBin: '/nonexistent/rg' });
    expect(result.error).toContain('rg-spawn');
    expect(result.tags).toEqual([]);
  });

  // C5 (2026-05-17) — frontmatter tags surface alongside inline tags.
  test('한글 태그 — 본문 #시험 과 frontmatter 목록 AI요약 이 모두 집계된다(rg 실물)', async () => {
    writeFileSync(join(vault, 'ko.md'), `---
tags:
  - "AI요약"
  - 비디오_로딩_오류
---

[[두번째]] 로 간다 #시험
`);
    const result = await findTags({ vaultRoot: vault });
    const names = result.tags.map(t => t.tag);
    expect(names).toContain('시험');
    expect(names).toContain('AI요약');
    expect(names).toContain('비디오_로딩_오류');
  });

  test('frontmatter inline-array tags counted', async () => {
    writeFileSync(join(vault, 'fm-array.md'), `---
title: x
tags: [work, important]
---

body text
`);
    const result = await findTags({ vaultRoot: vault });
    const work = result.tags.find(t => t.tag === 'work');
    const important = result.tags.find(t => t.tag === 'important');
    expect(work?.count).toBe(1);
    expect(important?.count).toBe(1);
  });

  test('frontmatter block-list tags counted', async () => {
    writeFileSync(join(vault, 'fm-list.md'), `---
title: x
tags:
  - work
  - q4-planning
---
`);
    const result = await findTags({ vaultRoot: vault });
    const work = result.tags.find(t => t.tag === 'work');
    const q4 = result.tags.find(t => t.tag === 'q4-planning');
    expect(work?.count).toBe(1);
    expect(q4?.count).toBe(1);
  });

  test('inline + frontmatter tags merge by tag name', async () => {
    writeFileSync(join(vault, 'fm.md'), `---
tags: [work]
---
also has #work inline
`);
    const result = await findTags({ vaultRoot: vault });
    const work = result.tags.find(t => t.tag === 'work');
    expect(work?.count).toBe(2);
  });
});

// C5 (2026-05-17) — extractFrontmatterTags unit tests.
describe('extractFrontmatterTags', () => {
  test('no frontmatter → empty', () => {
    expect(extractFrontmatterTags('plain body, no fm')).toEqual([]);
  });

  test('frontmatter without tags key → empty', () => {
    expect(extractFrontmatterTags('---\ntitle: x\n---\nbody')).toEqual([]);
  });

  test('inline-array form', () => {
    expect(extractFrontmatterTags('---\ntags: [a, b, c]\n---\n')).toEqual(['a', 'b', 'c']);
  });

  test('inline-array with quoted values', () => {
    expect(extractFrontmatterTags(`---
tags: ['foo-bar', "baz"]
---
`)).toEqual(['foo-bar', 'baz']);
  });

  test('block-list form', () => {
    expect(extractFrontmatterTags(`---
title: t
tags:
  - alpha
  - beta
---
`)).toEqual(['alpha', 'beta']);
  });

  test('single-value form', () => {
    expect(extractFrontmatterTags('---\ntags: solo\n---\n')).toEqual(['solo']);
  });

  test('skips invalid tag names (numeric · special chars)', () => {
    expect(extractFrontmatterTags('---\ntags: [1bad, with space, ok-tag]\n---\n'))
      .toEqual(['ok-tag']);
  });

  test('unclosed frontmatter → empty', () => {
    expect(extractFrontmatterTags('---\ntags: [foo]\n')).toEqual([]);
  });
});
