import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { lint, render, type Storyboard } from '../../src/storyboard/storyboard.js';

const real = parse(readFileSync(join(import.meta.dir, '../../storyboards/site-hero/suseuro-stage.yaml'), 'utf8')) as Storyboard;

test('the site-hero v1 storyboard passes lint with no errors', () => {
  expect(lint(real, 'storyboards/site-hero/suseuro-stage.yaml').errors).toEqual([]);
});

test('an approved storyboard must say who approved it and when', () => {
  expect(lint({ ...real, status: 'approved', approved: null }, 'storyboards/site-hero/x.yaml').errors).toContain('승인본은 approved.by·at 필요');
});

test('every on-screen text names its source; a real UI string without a ref warns', () => {
  const sb = structuredClone(real);
  sb.shots[0]!.on_screen_text = [{ text: '저작 · 분해', source: 'made-up' }, { text: '게이트 통과', source: 'real-ui' }];
  const r = lint(sb, 'storyboards/site-hero/x.yaml');
  expect(r.errors.some((e) => e.includes('«저작 · 분해» 의 source'))).toBe(true);
  expect(r.warnings.some((w) => w.includes('«게이트 통과» 에 ref'))).toBe(true);
});

test('a transition without an intent is an error — «just cut» is not a design', () => {
  const sb = structuredClone(real);
  sb.shots[1]!.transition_in = { type: 'cut', intent: '' };
  expect(lint(sb, 'storyboards/site-hero/x.yaml').errors.some((e) => e.includes('의도 한 줄'))).toBe(true);
});

test('the file must live under its kind folder', () => {
  expect(lint(real, 'storyboards/teaser/suseuro-stage.yaml').errors.some((e) => e.includes('kind(site-hero) 폴더'))).toBe(true);
});

test('render says it is generated and carries every shot and prompt', () => {
  const out = render(real, 'storyboards/site-hero/suseuro-stage.yaml');
  expect(out).toContain('자동 생성 — 손으로 고치지 않는다');
  for (const s of real.shots) expect(out).toContain(`| ${s.id} |`);
  expect(out).toContain('## 생성 프롬프트');
});

const site = parse(readFileSync(join(import.meta.dir, '../../storyboards/site/site2-two-sites.yaml'), 'utf8')) as Storyboard;

test('kind site: the SITE2 plan lints without shots or format, and renders a menu and a section table per site', () => {
  expect(lint(site, 'storyboards/site/site2-two-sites.yaml').errors).toEqual([]);
  const out = render(site, 'storyboards/site/site2-two-sites.yaml');
  expect(out).toContain('## elanous.ai — 제품 · 작동 방식 · 설치');
  expect(out).toContain('- 메뉴: 작동 방식(#feats-title)');
  expect(out).toContain('| 9 | company | 회사 · 도입 상담 |');
  expect(out).not.toContain('## 샷 구조표');
});

test('kind site: a section without a purpose or with an unknown change is an error; no sites is an error', () => {
  const sb = structuredClone(site);
  sb.sites![0]!.pages[0]!.sections[0]!.purpose = '';
  sb.sites![0]!.pages[0]!.sections[1]!.change = 'tweak';
  const errors = lint(sb, 'storyboards/site/x.yaml').errors;
  expect(errors.some((e) => e.includes('#hero: purpose'))).toBe(true);
  expect(errors.some((e) => e.includes('#stage: change'))).toBe(true);
  expect(lint({ ...site, sites: [] }, 'storyboards/site/x.yaml').errors).toContain('site 종류는 sites 가 필요하다');
});
