import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const qa = readFileSync(resolve(root, 'docs/marketing/QA-visitor-1008-30-2026-10-03.md'), 'utf8');
const storyline = readFileSync(resolve(root, 'docs/marketing/STORYLINE-ceo-seminar-2026-10-27.md'), 'utf8');
const sources = readFileSync(resolve(root, 'docs/marketing/SOURCES-site-numbers-2026-10-03.md'), 'utf8');
const rows = qa.split('\n').filter(line => /^\| \d+ \|/.test(line))
  .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));

function checkNumbers(text: string): string[] {
  const candidates = sources.split('\n').filter(line => /^\| (줄 수|병합 PR|완료 개월) \|/.test(line))
    .map(line => line.split('|').at(-3)?.trim() ?? '');
  expect(candidates).toHaveLength(3);
  const withoutRefs = text.replace(/`docs\/[^`]+\.md`/g, '').replace(/MAP §\d+[a-z]?/g, '')
    .replace(/^\| \d+ \|/gm, '| |');
  let remainder = withoutRefs;
  for (const candidate of candidates) remainder = remainder.replaceAll(candidate, '');
  return remainder.match(/\d+(?:[.,]\d+)?(?:만|개월|년|월|일|건|명|%|원|줄|\+)?/g) ?? [];
}

test('visitor sheet has one table with thirty numbered questions and six groups of five', () => {
  expect(qa.match(/^\| # \| 묶음 \| 예상 질문 \| 답\(두 문장 이하\) \| 근거 \| 넘지 않는 선 \|$/gm)).toHaveLength(1);
  expect(qa.match(/^\|---\|---\|---\|---\|---\|---\|$/gm)).toHaveLength(1);
  expect(qa.match(/^\|[^\n]*\|$/gm)).toHaveLength(32);
  expect(rows).toHaveLength(30);
  expect(rows.map(cells => Number(cells[0]))).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
  for (const cells of rows) expect(cells).toHaveLength(6);
  const groups = ['제품', '보안·데이터', '비용·계약', '회사 적용·AX 상담', '기술', '회사·팀'];
  expect([...new Set(rows.map(cells => cells[1]))]).toEqual(groups);
  for (const group of groups) expect(rows.filter(cells => cells[1] === group)).toHaveLength(5);
});

test('answers are at most two sentences and each row has a real reference and a boundary', () => {
  let dashCount = 0;
  for (const [number, , question, answer, evidence, boundary] of rows) {
    expect(question, `row ${number}: question`).toBeTruthy();
    expect(answer, `row ${number}: answer`).toBeTruthy();
    expect(answer.split(/[.!?。]+/).filter(Boolean).length, `row ${number}: sentences`).toBeLessThanOrEqual(2);
    expect(evidence, `row ${number}: evidence`).toBeTruthy();
    const references = [...evidence.matchAll(/`(docs\/[^`]+\.md)`/g)].map(match => match[1]);
    const mapRefs = [...evidence.matchAll(/MAP §(\d+[a-z]?)/g)].map(match => match[1]);
    const sourceRefs = [...evidence.matchAll(/SOURCES (줄 수|병합 PR|완료 개월)/g)].map(match => match[1]);
    expect(references.length + mapRefs.length + sourceRefs.length, `row ${number}: references`).toBeGreaterThan(0);
    for (const path of references) {
      expect(path.startsWith('docs/marketing/'), `row ${number}: path`).toBe(true);
      expect(existsSync(resolve(root, path)), `row ${number}: ${path}`).toBe(true);
    }
    for (const section of mapRefs) expect(readFileSync(resolve(root, 'docs/marketing/MAP-value-props-to-features.md'), 'utf8')).toContain(`## ${section}.`);
    for (const label of sourceRefs) expect(sources).toMatch(new RegExp(`^\\| ${label} \\|`, 'm'));
    expect(evidence.replace(/`docs\/[^`]+\.md`|MAP §\d+[a-z]?|SOURCES (?:줄 수|병합 PR|완료 개월)|[ ·]/g, ''), `row ${number}: reference syntax`).toBe('');
    expect(boundary, `row ${number}: boundary`).toBeTruthy();
    if (boundary === '—') dashCount++;
    if (/계획|준비\s*중|준비하고 있|미검증 단계|관리형/.test(answer)) {
      expect(answer, `row ${number}: planned answer`).toContain('계획 · 바뀔 수 있습니다');
    }
  }
  expect(dashCount).toBeLessThanOrEqual(5);
});

test('source candidates only, no forbidden claims, outside names or price promises', () => {
  expect(checkNumbers(qa)).toEqual([]);
  expect(qa).not.toMatch(/곧|완전 자율|에이전트가 쓴/);
  expect(qa).not.toMatch(/ChatGPT|Codex|Claude|Grok|OpenAI|Microsoft|Google|n8n|\$\s*\d|₩\s*\d|\d[\d,]*\s*원/i);
  const unanswered = qa.split('## 답하지 않는 질문\n');
  expect(unanswered).toHaveLength(2);
  expect(unanswered[1]).not.toMatch(/^## /m);
  for (const item of ['가격·할인', '인력 감축 숫자', '남의 회사 비교', '출시일']) expect(unanswered[1]).toContain(item);
});

test('storyline questions remain recognizable in the visitor questions', () => {
  const section = storyline.split('## 질문 대비 (말할 수 있는 범위 · MAP §0 규칙)\n')[1]?.split('\n## ')[0];
  expect(section).toBeDefined();
  const sourceQuestions = section!.split('\n').filter(line => /^\| (?!예상 질문|---)[^|]+ \|/.test(line));
  expect(sourceQuestions).toHaveLength(5);
  const words = ['보안', '대체', '비용', '바로', '한국'];
  for (const word of words) {
    expect(sourceQuestions.some(line => line.split('|')[1].includes(word)), `${word}: storyline`).toBe(true);
    expect(rows.some(cells => cells[2].includes(word)), `${word}: visitor question`).toBe(true);
  }
  expect(rows.find(cells => cells[2].includes('보안'))?.[3]).toContain('내 기계');
  expect(rows.find(cells => cells[2].includes('대체'))?.[3]).toContain('사람');
  expect(rows.find(cells => cells[2].includes('비용'))?.[3]).toContain('구독');
  expect(rows.find(cells => cells[2].includes('바로'))?.[3]).toContain('상담');
  expect(rows.find(cells => cells[2].includes('한국'))?.[3]).toContain('언어');
});
