import { expect, test } from 'bun:test';
import { inlineStyles, renderMarkdownRows, renderTable, truncateCells, visibleWidth, wrapStyled } from './markdown-render.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const rows = (md: string, width = 60): string[] => renderMarkdownRows(md, width).map(plain);

// A note shaped like the real vault (frontmatter, Korean, tables, callouts, mermaid, embeds) — the fixture, not the vault.
const NOTE = [
  '---', 'title: "토픽 맵 · 온톨로지"', 'tags: [SCM, ontology]', 'created: 2026-10-11', '---', '',
  '# 토픽 맵', '', '> **계층**: 과목 → 모듈. 카드는 [[20-concept-cards]], 루프는 [[30-loops|루프 문서]]에 있다.', '',
  '## 1. 과목 골격', '', '- **과목**: BIZ574 Supply Chain Management(생산경영 및 공급사슬관리) · KAIST EMBA · 2026 Spring',
  '  - L1 Foundation (0~2주): 가치·CPR·시스템사고', '    - 더 깊은 단계', '1. 첫째 *기울임* 과 `code`', '2. 둘째 [링크](https://example.com)', '- [ ] 할 일', '- [x] 끝난 일', '',
  '### 표', '', '| # | 이름 | 공식 | 출처 |', '|---|:---:|---|---:|', '| F01 | 가치 함수 | $V = R / C$ 아주 아주 긴 공식 설명이 붙은 칸 | mid 3.1 |', '| F02 | 곱 | $V ≈ R×E$ | mid 10.2 |', '',
  '> [!summary]+ 3줄 요약', '> - 아카라 G3의 제스처/얼굴 인식 기능을 n8n, Pushcut, 애플 TV와 연동하여 다양한 자동화 시나리오를 구현할 수 있습니다.', '> - 둘째 줄', '',
  '```mermaid', 'flowchart TB', '  A --> B', '```', '', '```ts', 'const veryLongIdentifierName = someFunctionCall(argumentOne, argumentTwo, argumentThree);', '```', '',
  '![[diagram.png]] 그리고 ![alt text](img/photo.jpg) #태그 ==강조== ~~취소~~ 😀 이모지', '', '---', '',
  '아주 긴 한국어 문단입니다 띄어쓰기가 있어도 화면 폭에 맞춰 줄이 바뀌어야 하고 글자 폭은 두 칸으로 셉니다 그리고계속이어지는띄어쓰기없는긴낱말도잘려야합니다',
].join('\n');

test('no row is wider than the box at 40 / 60 / 80 / 158 cells (CJK and emoji count by display width)', () => {
  for (const width of [40, 60, 80, 158]) for (const row of renderMarkdownRows(NOTE, width)) expect(visibleWidth(row) <= width).toBe(true);
});

test('frontmatter folds to one dim line naming its keys', () => {
  const out = rows(NOTE);
  expect(out[0]).toBe('⋯ properties: title · tags · created');
  expect(out.join('\n')).not.toContain('created: 2026');
});

test('headings, quotes with wikilinks (label shown, brackets gone), lists with depth marks, numbers, tasks', () => {
  const out = rows(NOTE, 100);
  expect(out).toContain('토픽 맵');
  expect(out).toContain('1. 과목 골격');
  expect(out.find((row) => row.startsWith('▎ 계층'))).toBe('▎ 계층: 과목 → 모듈. 카드는 20-concept-cards, 루프는 루프 문서에 있다.');
  expect(out.some((row) => row.startsWith('• 과목: BIZ574'))).toBe(true);
  expect(out).toContain('  ◦ L1 Foundation (0~2주): 가치·CPR·시스템사고');
  expect(out).toContain('    ▪ 더 깊은 단계');
  expect(out).toContain('1. 첫째 기울임 과 code');
  expect(out).toContain('2. 둘째 링크');
  expect(out).toContain('☐ 할 일');
  expect(out).toContain('☑ 끝난 일');
});

test('a wrapped list item continues under its text (hanging indent)', () => {
  const out = rows('- 아카라 G3의 제스처 인식 기능을 n8n 과 연동하여 다양한 자동화 시나리오를 구현', 30);
  expect(out).toEqual(['• 아카라 G3의 제스처 인식', '  기능을 n8n 과 연동하여', '  다양한 자동화 시나리오를', '  구현']);
});

test('tables draw with box borders, honour alignment and shrink the widest column with «…» to fit', () => {
  const all = rows(NOTE, 60);
  const top = all.findIndex((row) => row.startsWith('┌─') && row.includes('┬'));
  const out = all.slice(top, all.findIndex((row, i) => i > top && row.startsWith('└')) + 1);
  expect(out[0]!.startsWith('┌─────┬')).toBe(true);
  expect(out[1]).toContain('│ #   │');
  for (const row of out) expect(Bun.stringWidth(row)).toBe(Bun.stringWidth(out[0]!));
  expect(out.some((row) => row.includes('…'))).toBe(true);
  expect(out.some((row) => row.includes('mid 10.2 │'))).toBe(true);
});

test('callouts are boxed blocks with their title; plain quotes keep the bar', () => {
  const out = rows(NOTE, 60);
  const head = out.findIndex((row) => row.startsWith('┏ ≡ 3줄 요약'));
  expect(head).not.toBe(-1);
  expect(out[head + 1]!.startsWith('┃ • 아카라 G3')).toBe(true);
  expect(out[head + 2]!.startsWith('┃   ')).toBe(true);
  expect(out.some((row) => row.startsWith('┃ • 둘째 줄'))).toBe(true);
});

test('mermaid becomes a diagram placeholder; code is labelled and cut, never re-wrapped', () => {
  const out = rows(NOTE, 40);
  const at = out.indexOf('◇ diagram (mermaid)');
  expect(out.slice(at, at + 4)).toEqual(['◇ diagram (mermaid)', '│ flowchart TB', '│   A --> B', '  └ 2 lines of mermaid (open the note in']);
  expect(out).toContain('┌ code · ts');
  expect(out.find((row) => row.startsWith('│ const'))).toBe('│ const veryLongIdentifierName = someFu…');
});

test('embeds and images are placeholders; tags, highlights, strike and emoji survive', () => {
  expect(plain(inlineStyles('![[diagram.png]] and ![alt text](img/photo.jpg)'))).toBe('🖼 diagram.png and 🖼 alt text');
  expect(plain(inlineStyles('#태그 ==강조== ~~취소~~ 😀'))).toBe('#태그 강조 취소 😀');
  expect(plain(inlineStyles('a<br>b <span>c</span>'))).toBe('a b c');
  expect(plain(inlineStyles('`**not bold**`'))).toBe('**not bold**');
  expect(plain(inlineStyles('foo_bar_baz'))).toBe('foo_bar_baz');
  expect(inlineStyles('**b**')).toBe('\u001b[1mb\u001b[0m');
});

test('wrapStyled: breaks at spaces, mid-word for long runs, closes and reopens colour across rows', () => {
  expect(wrapStyled('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
  expect(wrapStyled('가나다라마바', 5).map(plain)).toEqual(['가나', '다라', '마바']);
  const coloured = wrapStyled('\u001b[36mabc def ghi\u001b[0m', 7);
  expect(coloured[0]!.endsWith('\u001b[0m')).toBe(true);
  expect(coloured[1]!.startsWith('\u001b[36m')).toBe(true);
  expect(wrapStyled('x', 0)).toEqual([]);
});

test('truncateCells and renderTable keep widths exact on wide glyphs', () => {
  expect(plain(truncateCells('가나다라', 5))).toBe('가나…');
  const table = renderTable(['이름', 'v'], [['아주 긴 한국어 이름', '1']], ['left', 'right'], 20).map(plain);
  for (const row of table) expect(Bun.stringWidth(row)).toBe(20);
});

test('blank runs collapse and the output never ends with blank rows', () => {
  expect(rows('a\n\n\n\nb\n\n\n')).toEqual(['a', '', 'b']);
});
