import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIntakeDigest, noteOneLiner, renderDigestMarkdown, renderDigestTelegram } from '../src/intake-plane/digest.js';
import { ingestIntakeItems, listIntakeItems, markIntakeItem } from '../src/intake-plane/items.js';
import { routeIntakeItem } from '../src/intake-plane/route.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const root = () => { const r = mkdtempSync(join(tmpdir(), 'intake-digest-')); roots.push(r); return r; };
const quiet = () => {};

test('한 줄 요약 — yt-vault 절 제목 · omni-digest 이모지 줄 · 굵은 번호 줄 · 없으면 첫 문단', () => {
  expect(noteOneLiner('---\na: 1\n---\n# 제목\n\n## 한줄 결론\n\n**AI 검색은 작은 전문가에게 기회다.**\n')).toBe('AI 검색은 작은 전문가에게 기회다.');
  expect(noteOneLiner('# 참조 링크\n- x\n\n🎯 한 줄 결론  \nOpus 5.5 가 두 프롬프트로 품질을 올렸다는 사례.\n')).toBe('Opus 5.5 가 두 프롬프트로 품질을 올렸다는 사례.');
  expect(noteOneLiner('**1. 🎯 한 줄 결론**  \n삼성 SRE 는 3계층 멀티 에이전트로 운영을 자동화했다.\n')).toBe('삼성 SRE 는 3계층 멀티 에이전트로 운영을 자동화했다.');
  expect(noteOneLiner('---\nt: x\n---\n# 제목\n\n본문 첫 문단이다.\n')).toBe('본문 첫 문단이다.');
});

test('그날 흡수·갈래가 끝난 것만 · 축별로 묶고 노트의 한 줄 요약을 붙인다 · 골 후보를 싣는다', () => {
  const r = root();
  const NOW = '2026-09-26T03:00:00.000Z';   // KST 12:00
  ingestIntakeItems(r, 'youtube', [{ url: 'https://youtu.be/aaaaaaaaaaa', judgement: { axis: 'agent_basics', axisConf: 0.9, promo: 0, learn: 2 } }], NOW, quiet);
  ingestIntakeItems(r, 'telegram-saved', [{ url: 'https://x.com/i/status/1' }], NOW, quiet);
  ingestIntakeItems(r, 'github', [{ url: 'https://github.com/a/b' }], NOW, quiet);   // 흡수 안 됨 → 빠진다
  const [a, b] = listIntakeItems(r).filter((i) => i.sources[0] !== 'github').map((i) => i.id);
  markIntakeItem(r, a, { status: 'absorbed', output: { kind: 'note', ref: '/v/A.md' } }, NOW);
  markIntakeItem(r, b, { status: 'absorbed', output: { kind: 'note', ref: '/v/B.md' } }, NOW);
  routeIntakeItem(r, a, { items: [{ fact: 'elanous 에 `x` 가 없다', current: '0건', verdict: '없음' }, { fact: 'elanous 의 `y` 가 같은 것인가', current: '이름은 있으나 설계 판단이 필요하다', verdict: '판단 필요' }] }, {}, NOW);
  const files: Record<string, string> = { '/v/A.md': '## 한줄 결론\n하니스는 그래프다.\n', '/v/B.md': '🎯 한 줄 결론\n저장해 둔 글의 요지.\n' };
  const d = buildIntakeDigest(r, '2026-09-26', (p) => files[p]);
  expect(new Set(d.absorbed.map((e) => e.axis))).toEqual(new Set(['에이전트 기본', '내가 저장한 것']));
  expect(new Set(d.absorbed.map((e) => e.oneLiner))).toEqual(new Set(['하니스는 그래프다.', '저장해 둔 글의 요지.']));
  expect(d.goals).toEqual([{ fact: 'elanous 에 `x` 가 없다', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }]);
  expect(d.grounding).toBe(1);
  const md = renderDigestMarkdown(d);
  expect(md).toContain('## 📰 오늘의 흡수 요약 (2)');
  expect(md).toContain('### 에이전트 기본 (1)');
  expect(md).toContain('- [[A]] — 하니스는 그래프다.');
  expect(md).toContain('🔴 엘라누스에 없는 것 — 골 후보 (1)');
  expect(d.review).toEqual([{ fact: 'elanous 의 `y` 가 같은 것인가', note: '/v/A.md' }]);
  expect(md).toContain('### 🟡 사람이 가를 것 — 판단 필요 (1)');
  expect(md).toContain('- elanous 의 `y` 가 같은 것인가 · [[A]]');
  expect(buildIntakeDigest(r, '2026-09-25', (p) => files[p]).absorbed).toHaveLength(0);
});

test('텔레그램 짧은 판 — 수 · 요약 · 골 후보 수 · 옵시디언 열기 주소', () => {
  const t = renderDigestTelegram({
    day: '2026-09-26', grounding: 0, release: 0, manual: 0,
    absorbed: [{ id: '1', sources: ['youtube'], axis: 'x', oneLiner: '요약 하나' }],
    goals: [{ fact: 'f' }], review: [{ fact: 'r' }, { fact: 's' }],
  }, { vaultRoot: '/vault/ElanvitalAI', notePath: '/vault/ElanvitalAI/01. Knowledge/Youtube/_trend/20260926_흡수후보.md' });
  expect(t).toContain('2026-09-26 흡수 1편');
  expect(t).toContain('• 요약 하나');
  expect(t).toContain('엘라누스에 없는 것 1건');
  expect(t).toContain('🟡 사람이 가를 것 2건');
  expect(t).toContain('obsidian://open?vault=ElanvitalAI&file=01.%20Knowledge%2FYoutube%2F_trend%2F20260926_%ED%9D%A1%EC%88%98%ED%9B%84%EB%B3%B4');
});

test('저장된 메시지 새 글이 이틀 넘게 없으면 노트·텔레그램 판에 경고 줄 · 이틀 안이면 없다 · 커서가 없으면 없다', () => {
  const r = root();
  expect(buildIntakeDigest(r, '2026-09-30', () => undefined, new Date('2026-09-30T00:00:00Z')).savedSilence).toBeUndefined();
  mkdirSync(join(r, 'intake'), { recursive: true });
  writeFileSync(join(r, 'intake', 'telegram-saved.cursor.json'), JSON.stringify({ lastId: 8773, at: '2026-09-28T22:07:49.773Z' }) + '\n');
  expect(buildIntakeDigest(r, '2026-09-30', () => undefined, new Date('2026-09-29T23:30:00Z')).savedSilence).toBeUndefined();
  const d = buildIntakeDigest(r, '2026-10-01', () => undefined, new Date('2026-10-01T00:00:00Z'));
  expect(d.savedSilence).toEqual({ days: 2, lastNewAt: '2026-09-28T22:07:49.773Z' });
  expect(renderDigestMarkdown(d)).toContain('새 글을 2일째 못 받았다(마지막 새 글 수집 2026-09-29)');
  expect(renderDigestTelegram(d)).toContain('⚠️ 저장된 메시지 새 글 2일째 0');
});
