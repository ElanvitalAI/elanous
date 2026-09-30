import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { harnessReleaseNote, parseReleaseNoteSection, readReleaseNotes, releaseNotesDir, renderReleaseNoteSection, writeReleaseNote, type ReleaseNoteFragment } from './release-note.js';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fragment: ReleaseNoteFragment = {
  pr: 42, line: '사용자에게 보이는 개선', kind: 'feat', docs: { path: 'release/public/docs/cli.md' }, target: 'next', source: 'pr-body',
};

test('valid four-field PR section parses and render/parse round trips', () => {
  const section = `Intro\n${renderReleaseNoteSection(fragment)}\n## 다른 절\n- 대상: later\n`;
  expect(parseReleaseNoteSection(section)).toEqual({
    fragment: { line: fragment.line, kind: fragment.kind, docs: fragment.docs, target: fragment.target }, problems: [],
  });
  expect(parseReleaseNoteSection(renderReleaseNoteSection({ ...fragment, docs: { none: '내부 변경' } })).fragment?.docs).toEqual({ none: '내부 변경' });
  expect(parseReleaseNoteSection(renderReleaseNoteSection(fragment).trimEnd())).toEqual({
    fragment: { line: fragment.line, kind: fragment.kind, docs: fragment.docs, target: fragment.target }, problems: [],
  });
});

test('multiple PR release-note sections use the last and report the count', () => {
  const automatic = '## 릴리스 노트\n- 한 줄: 하니스 자동 생성\n- 종류: internal\n- 문서: 없음(하니스 자동 생성)\n- 대상: next\n';
  const amended = '## 릴리스 노트\n- 한 줄: Adds plugin credentials.\n- 종류: feat\n- 문서: docs/plugins.md\n- 대상: next\n';
  expect(parseReleaseNoteSection(`${automatic}\n## 검증\n내용\n${amended}`)).toEqual({
    fragment: { line: 'Adds plugin credentials.', kind: 'feat', docs: { path: 'docs/plugins.md' }, target: 'next' },
    problems: ['multiple release-note sections (2); using the last'],
  });
  expect(parseReleaseNoteSection(`${automatic}${amended}${automatic}`)).toEqual({
    fragment: { line: '하니스 자동 생성', kind: 'internal', docs: { none: '하니스 자동 생성' }, target: 'next' },
    problems: ['multiple release-note sections (3); using the last'],
  });
  expect(parseReleaseNoteSection(`${automatic}\n\`\`\`md\n${amended}\`\`\`\n`)).toEqual({
    fragment: { line: '하니스 자동 생성', kind: 'internal', docs: { none: '하니스 자동 생성' }, target: 'next' }, problems: [],
  });
  expect(parseReleaseNoteSection(`${automatic}${amended.replace('- 종류: feat', '- 종류: bugfix')}`)).toEqual({
    problems: ['종류', 'multiple release-note sections (2); using the last'],
  });
});

test('harness release note uses the valid goal section rather than the PR title', () => {
  const note = harnessReleaseNote(`## 목표\n일을 완성한다\n${renderReleaseNoteSection(fragment)}\n## 검증\n`, 'fallback title');
  expect(note).toEqual({ line: fragment.line, kind: fragment.kind, docs: fragment.docs, target: fragment.target });
  expect(parseReleaseNoteSection(renderReleaseNoteSection(note)).fragment).toEqual(note);
  const root = mkdtempSync(join(tmpdir(), 'release-note-harness-'));
  scratch.push(root);
  const dir = releaseNotesDir(root);
  writeReleaseNote(dir, { ...note, pr: fragment.pr, source: 'harness' });
  expect(readReleaseNotes(dir).get(fragment.pr)).toEqual({ ...note, pr: fragment.pr, source: 'harness' });
  writeReleaseNote(dir, fragment);
  expect(readReleaseNotes(dir).get(fragment.pr)).toEqual(fragment);
});

test('harness release note recognizes a goal heading indented by one to three spaces and stops at an indented next section', () => {
  const outside = renderReleaseNoteSection({ ...fragment, line: '목표 밖의 설명' });
  const inside = renderReleaseNoteSection(fragment);
  for (const indent of [' ', '  ', '   ']) {
    expect(harnessReleaseNote(`${outside}\n${indent}## 목표\n${inside}\n${indent}## 검증\n${outside}`, 'fallback title'))
      .toEqual({ line: fragment.line, kind: fragment.kind, docs: fragment.docs, target: fragment.target });
    expect(harnessReleaseNote(`${indent}## 목표\n${indent}## 검증\n${outside}`, 'fallback title'))
      .toEqual({ line: 'fallback title', kind: 'internal', docs: { none: '하니스 자동 생성' }, target: 'next' });
  }
});

test('harness release note ignores release sections outside the goal even when they come first', () => {
  const outside = renderReleaseNoteSection({ ...fragment, line: '목표 밖의 설명', target: 'later' });
  const inside = renderReleaseNoteSection(fragment);
  expect(harnessReleaseNote(`${outside}\n## 목표\n${inside}\n## 검증\n`, '작업 제목'))
    .toEqual({ line: fragment.line, kind: fragment.kind, docs: fragment.docs, target: fragment.target });
});

test('harness release note falls back for absent or invalid goal sections', () => {
  const fallback = { line: '작업 제목', kind: 'internal', docs: { none: '하니스 자동 생성' }, target: 'next' } as const;
  expect(harnessReleaseNote('', '작업 제목')).toEqual(fallback);
  expect(harnessReleaseNote('## 목표\n릴리스 노트가 없는 골', '작업 제목')).toEqual(fallback);
  expect(harnessReleaseNote('## 릴리스 노트\n- 한 줄: 사용자 변화\n- 종류: bugfix\n- 문서: 없음(이유)\n- 대상: later\n', '작업 제목')).toEqual(fallback);
  expect(harnessReleaseNote(renderReleaseNoteSection(fragment), '작업 제목')).toEqual(fallback);
  expect(harnessReleaseNote(`## 목표\n릴리스 노트가 없는 골\n## 검증\n${renderReleaseNoteSection(fragment)}`, '작업 제목')).toEqual(fallback);
  expect(harnessReleaseNote(`## 목표\n### 세부 목표\n릴리스 노트가 없는 골\n## 검증\n${renderReleaseNoteSection(fragment)}`, '작업 제목')).toEqual(fallback);
  expect(harnessReleaseNote(`## 목표\n릴리스 노트가 없는 골\n## 검증\n### 릴리스 노트\n${renderReleaseNoteSection(fragment)}`, '작업 제목')).toEqual(fallback);
  expect(harnessReleaseNote(`\`\`\`md\n## 목표\n\`\`\`\n${renderReleaseNoteSection(fragment)}`, '작업 제목')).toEqual(fallback);
  expect(parseReleaseNoteSection(renderReleaseNoteSection(fallback)).fragment).toEqual(fallback);
});

test('mergeSha survives JSON ledger round trip but never enters the four-field PR section', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-note-merge-sha-'));
  scratch.push(root);
  const dir = releaseNotesDir(root);
  const merged = { ...fragment, mergeSha: 'abcdef1234567890' };
  writeReleaseNote(dir, merged);
  expect(JSON.parse(readFileSync(join(dir, '42.json'), 'utf8'))).toEqual(merged);
  expect(readReleaseNotes(dir).get(fragment.pr)).toEqual(merged);
  expect(renderReleaseNoteSection(merged)).toBe(renderReleaseNoteSection(fragment));
  expect(renderReleaseNoteSection(merged)).not.toContain('mergeSha');
  expect(renderReleaseNoteSection(merged)).not.toContain(merged.mergeSha);
  expect(parseReleaseNoteSection(renderReleaseNoteSection(merged)).fragment).toEqual({
    line: fragment.line, kind: fragment.kind, docs: fragment.docs, target: fragment.target,
  });
});

test('invalid values and missing fields name the bad fields without inventing a fragment', () => {
  expect(parseReleaseNoteSection('## 릴리스 노트\n- 한 줄: 수정\n- 종류: bugfix\n- 문서: 없음(이유)\n- 대상: next\n')).toEqual({ problems: ['종류'] });
  expect(parseReleaseNoteSection('## 릴리스 노트\n- 종류: fix\n- 문서: 없음()\n- 대상: soon\n')).toEqual({ problems: ['한 줄', '문서', '대상'] });
  expect(parseReleaseNoteSection('## 릴리스 노트\n- 한 줄: 수정\n- 종류: fix\n- 문서: 없음(이유)\n')).toEqual({ problems: ['대상'] });
  expect(parseReleaseNoteSection('## 변경 사항\n- 종류: feat')).toEqual({ problems: [] });
});

test('a following heading at any Markdown level cannot fill missing fields', () => {
  for (const heading of ['# 다른 절', '## 다른 절', '### 다른 절', '###### 다른 절']) {
    const body = `## 릴리스 노트\n- 한 줄: 수정\n- 종류: fix\n${heading}\n- 문서: 없음(다른 절)\n- 대상: next\n`;
    expect(parseReleaseNoteSection(body)).toEqual({ problems: ['문서', '대상'] });
  }
});

test('a following heading indented by one to three spaces cannot fill missing fields', () => {
  for (const indent of [' ', '  ', '   ']) {
    for (const level of ['#', '##', '###']) {
      const body = `## 릴리스 노트\n- 한 줄: 수정\n- 종류: fix\n${indent}${level} 다른 절\n- 문서: 없음(다른 절)\n- 대상: next\n`;
      expect(parseReleaseNoteSection(body)).toEqual({ problems: ['문서', '대상'] });
    }
  }
});

test('a section inside a code fence is an example, not the real section', () => {
  const example = '## 릴리스 노트\n- 한 줄: 예시\n- 종류: feat\n- 문서: 없음(예시)\n- 대상: later\n';
  const expected = { fragment: { line: fragment.line, kind: fragment.kind, docs: fragment.docs, target: fragment.target }, problems: [] };
  expect(parseReleaseNoteSection(`형식:\n\`\`\`md\n${example}\`\`\`\n\n${renderReleaseNoteSection(fragment)}`)).toEqual(expected);
  expect(parseReleaseNoteSection(`~~~\n${example}~~~\n${renderReleaseNoteSection(fragment)}`)).toEqual(expected);
  // A longer opening fence is not closed by a shorter inner one.
  expect(parseReleaseNoteSection(`\`\`\`\`\n\`\`\`\n${example}\`\`\`\n\`\`\`\`\n${renderReleaseNoteSection(fragment)}`)).toEqual(expected);
  // Fields fenced inside the real section do not count.
  expect(parseReleaseNoteSection('## 릴리스 노트\n```\n- 한 줄: 예시\n- 종류: fix\n- 문서: 없음(예시)\n- 대상: next\n```\n')).toEqual({ problems: ['한 줄', '종류', '문서', '대상'] });
  // Only an example, no real section.
  expect(parseReleaseNoteSection(`\`\`\`\n${example}\`\`\`\n`)).toEqual({ problems: [] });
});

test('a field repeated three times stays invalid, including when an occurrence has a bad value', () => {
  const body = '## 릴리스 노트\n- 한 줄: 수정\n- 종류: feat\n- 종류: bugfix\n- 종류: fix\n- 문서: 없음(이유)\n- 대상: next\n';
  expect(parseReleaseNoteSection(body)).toEqual({ problems: ['종류'] });
});

test('priority backfill → pr-body → backfill protects the higher-priority ledger entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-note-'));
  scratch.push(root);
  const dir = releaseNotesDir(root);
  expect(dir).toBe(join(root, 'release', 'notes'));
  expect(readReleaseNotes(dir).size).toBe(0);
  writeReleaseNote(dir, { ...fragment, line: 'backfilled', source: 'backfill' });
  writeReleaseNote(dir, fragment);
  writeReleaseNote(dir, { ...fragment, line: 'later backfill', source: 'backfill' });
  expect(readReleaseNotes(dir).get(42)).toEqual(fragment);
  writeReleaseNote(dir, { ...fragment, line: 'harness', source: 'harness' });
  expect(readReleaseNotes(dir).get(42)).toEqual(fragment);
  writeReleaseNote(dir, { ...fragment, pr: 43, line: 'harness', source: 'harness' });
  writeReleaseNote(dir, { ...fragment, pr: 43, line: 'backfill', source: 'backfill' });
  expect(readReleaseNotes(dir).get(43)?.line).toBe('harness');
  writeReleaseNote(dir, { ...fragment, pr: 43 });
  expect(readReleaseNotes(dir).get(43)?.source).toBe('pr-body');
});

test('concurrent writers serialize priority checks for the same PR', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-note-race-'));
  scratch.push(root);
  const dir = releaseNotesDir(root);
  writeReleaseNote(dir, { ...fragment, line: 'original', source: 'backfill' });
  const lock = join(dir, '42.json.lock');
  const descriptor = openSync(lock, 'wx');
  let held = true;
  const moduleUrl = pathToFileURL(join(import.meta.dir, 'release-note.ts')).href;
  const script = `import { writeReleaseNote } from ${JSON.stringify(moduleUrl)}; writeReleaseNote(process.argv[1], JSON.parse(process.argv[2]));`;
  const child = (note: ReleaseNoteFragment) => Bun.spawn(['bun', '-e', script, dir, JSON.stringify(note)], { stdout: 'pipe', stderr: 'pipe' });
  try {
    const high = child(fragment);
    const low = child({ ...fragment, line: 'racing backfill', source: 'backfill' });
    const early = await Promise.race([high.exited.then(() => 'finished'), Bun.sleep(300).then(() => 'waiting')]);
    expect(early).toBe('waiting');
    expect(existsSync(lock)).toBe(true);
    expect(readReleaseNotes(dir).get(42)?.line).toBe('original');
    closeSync(descriptor);
    unlinkSync(lock);
    held = false;
    const statuses = await Promise.all([high.exited, low.exited]);
    expect(statuses).toEqual([0, 0]);
    expect(readReleaseNotes(dir).get(42)).toEqual(fragment);
    expect(existsSync(lock)).toBe(false);
  } finally {
    if (held) { closeSync(descriptor); unlinkSync(lock); }
  }
}, 20_000);

test('corrupt or mismatched JSON is skipped and each problem is observable', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-note-'));
  scratch.push(root);
  const dir = releaseNotesDir(root);
  mkdirSync(dir, { recursive: true });
  writeReleaseNote(dir, fragment);
  writeFileSync(join(dir, '43.json'), '{bad');
  writeFileSync(join(dir, '44.json'), JSON.stringify(fragment));
  const notes = readReleaseNotes(dir);
  expect([...notes.values()]).toEqual([fragment]);
  expect(notes.problems.map((problem) => problem.split(':')[0]).sort()).toEqual(['43.json', '44.json']);
});
