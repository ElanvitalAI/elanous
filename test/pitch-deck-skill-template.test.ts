import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const skill = readFileSync(resolve(root, 'skills/pitch-deck/SKILL.md'), 'utf8');
const template = readFileSync(resolve(root, 'skills/pitch-deck/template.html'), 'utf8');

test('skill specifies slide sequence, final plan and source words inside cited ranges', () => {
  expect(skill).toContain('정의 → 실물 증거 → 문제 → 시장 → 기술/BM → 성과 → 성장 전략 → 팀 → 계획');
  expect(skill).toContain('계획**은 기본 일곱 및 실물 증거와 *별도 마지막 장*');
  expect(skill).toContain('`근거 낱말:`');
  expect(skill).toContain('파일:줄 범위에 실제로 존재하는 짧은 원문 구절');
  expect(skill).toContain('측정 명령·시각·정확한 값');
});

test('template title and body keep Korean words intact but wrap long tokens', () => {
  for (const selector of ['h1, h2', 'p, li']) {
    const rule = template.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    expect(rule, selector).not.toBeNull();
    expect(rule![1]).toContain('word-break: keep-all;');
    expect(rule![1]).toContain('overflow-wrap: anywhere;');
  }
  expect(template).toContain('Geist, "G sans"');
  expect(template).toContain('#e95047');
  expect(template).toContain('#0c0c0e');
  expect(template).toContain('#f2f1ee');
  expect(skill).toContain('docs/brand/BRAND-CANON-elanvital-and-elanous-2026-09-30.md');
  for (const content of [skill, template]) {
    expect(content).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    expect(content).not.toMatch(/(?<!\d)(?:\+82[-.\s]?|0)1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/);
  }
});
