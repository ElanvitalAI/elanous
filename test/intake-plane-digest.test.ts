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
  expect(md).toContain('렌즈 판정 못 함 2 — 원장 `elanous intake items`');
  expect(md).not.toContain('사람이 가를 것');
  expect(renderDigestTelegram(d)).toBe('흡수 2편 → 우리에게 닿는 것 0\n\n참고 2편 — 노트: [[A]], [[B]]');
  expect(d.absorbed.find((e) => e.id === a)?.impact).toBeUndefined();
  expect(buildIntakeDigest(r, '2026-09-25', (p) => files[p]).absorbed).toHaveLength(0);
});

test('렌즈 판정 3 · 참고 2 — 노트 S, 우리 맥락 C, 판정별 A 와 마크다운 원장', () => {
  const r = root();
  const at = '2026-10-05T03:00:00.000Z';
  ingestIntakeItems(r, 'youtube', Array.from({ length: 5 }, (_, n) => ({ url: `https://example.org/${n}` })), at, quiet);
  const ids = listIntakeItems(r).map((i) => i.id);
  const notes = ids.map((_, n) => `## 한줄 결론\n외부 도구 ${n}은 새로운 방법을 제시한다.\n`);
  for (const [n, id] of ids.entries()) {
    markIntakeItem(r, id, { status: 'absorbed', output: { kind: 'note', ref: `/v/${n}.md` } }, at);
  }
  const out = join(r, 'intake', 'outbox', 'lens');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, '2026-10-05.jsonl'), [
    { id: ids[0], fact: 'elanous 의 `video-gen` 은 python 으로 합성한다', current: 'catalog/resources.yaml', lensVerdict: '대체 후보', why: 'video-gen 의 유료 렌더링 의존을 줄일 가능성이 있어 현장 비교가 필요하다.', target: 'video-gen' },
    { id: ids[1], fact: '우리 기능을 설명한 문장', current: 'src/feature.ts', lensVerdict: '보강', why: '영상 자동화 칸의 품질 소구점에 재현 근거가 부족하다.', target: 'VIDEO-2' },
    { id: ids[2], fact: '우리 기능을 설명한 문장', current: 'src/feature.ts', lensVerdict: '경쟁 대조', why: '경쟁 도구와 편집 시간 차이를 같은 조건에서 대조해야 한다.', target: 'video-gen' },
    { id: ids[3], fact: 'elanous 설명만 있음', current: 'src/feature.ts' },
    { id: ids[4], fact: '근거만 있음', current: 'src/feature.ts', lensVerdict: '보강', why: 'src/feature.ts', target: 'VIDEO-3' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const d = buildIntakeDigest(r, '2026-10-05', (p) => notes[Number(p.match(/\d+/)?.[0])]);
  const t = renderDigestTelegram(d);
  expect(t.split('\n')[0]).toBe('흡수 5편 → 우리에게 닿는 것 3');
  expect(t.match(/^S 무엇:/gm)).toHaveLength(3);
  expect(t.match(/^🔗 노트:/gm)).toHaveLength(3);
  expect(t.match(/^S 무엇: (.*)$/gm)?.map((line) => line.slice('S 무엇: '.length))).toEqual(notes.slice(0, 3).map((note) => noteOneLiner(note)!));
  const contexts = t.match(/^C 우리에게 왜: (.*)$/gm) ?? [];
  expect(contexts).toHaveLength(3);
  expect(contexts.every((line) => !/^C 우리에게 왜: (?:[\w.-]+\/)+[\w.-]+(?::\d+)?$/.test(line))).toBe(true);
  const actions = t.match(/^A 그래서 무엇을 하나: (.*)$/gm) ?? [];
  expect(actions).toEqual([
    'A 그래서 무엇을 하나: video-gen lite Pod 실증 제안',
    'A 그래서 무엇을 하나: 칸 VIDEO-2 에 근거 추가',
    'A 그래서 무엇을 하나: video-gen 비교표 갱신',
  ]);
  expect(new Set(actions).size).toBe(actions.length);
  expect(t).not.toContain('elanous 의 `video-gen` 은 python 으로 합성한다');
  expect(t).toContain('참고 2편 — 노트: [[3]], [[4]]');
  expect(t).not.toContain('그 밖');
  const md = renderDigestMarkdown(d);
  expect(md).toContain('렌즈 판정 못 함 2 — 원장 `elanous intake items`');
  expect(md).not.toContain('사람이 가를 것');
});

test('체크 대조 fact/current 는 렌즈 판정이 아니다 — 경로만 있거나 노트 요지가 없으면 참고', () => {
  const r = root();
  const at = '2026-09-26T03:00:00.000Z';
  ingestIntakeItems(r, 'youtube', [{ url: 'https://example.org/a' }, { url: 'https://example.org/b' }], at, quiet);
  const ids = listIntakeItems(r).map((i) => i.id);
  for (const id of ids) markIntakeItem(r, id, { status: 'absorbed', output: { kind: 'note', ref: `/v/${id}.md` } }, at);
  routeIntakeItem(r, ids[0], { items: [{ fact: 'elanous 의 video-gen', current: 'src/feature.ts', verdict: '판단 필요' }] }, {}, at);
  const d = buildIntakeDigest(r, '2026-09-26', () => undefined);
  expect(renderDigestTelegram(d)).toBe(`흡수 2편 → 우리에게 닿는 것 0\n\n참고 2편 — 노트: ${ids.map((id) => `[[${id}]]`).join(', ')}`);
  expect(renderDigestMarkdown(d)).toContain('렌즈 판정 못 함 2 — 원장 `elanous intake items`');
});

test('닿는 것 4여도 텔레그램에는 최대 세 건만 낸다', () => {
  const absorbed = Array.from({ length: 4 }, (_, n) => ({
    id: String(n), sources: ['youtube'], axis: 'x', oneLiner: `외부 사실 ${n}`,
    impact: { verdict: '보강' as const, why: `소구점 ${n}에 근거가 부족하다.`, target: `VIDEO-${n}` },
  }));
  const t = renderDigestTelegram({ day: '2026-10-05', grounding: 0, release: 0, manual: 0, absorbed, goals: [] });
  expect(t.split('\n')[0]).toBe('흡수 4편 → 우리에게 닿는 것 4');
  expect(t.match(/^S 무엇:/gm)).toHaveLength(3);
  expect(t).not.toContain('외부 사실 3');
});

test('닿는 것 0이면 머리 줄 ⊕ 참고 한 줄만 — 침묵·옵시디언 주소도 덧붙이지 않는다', () => {
  const t = renderDigestTelegram({
    day: '2026-09-26', grounding: 0, release: 0, manual: 0,
    absorbed: [{ id: '1', sources: ['youtube'], axis: 'x' }], goals: [{ fact: 'old aggregate without an item id' }],
    savedSilence: { days: 3, lastNewAt: '2026-09-20T00:00:00Z' },
  }, { vaultRoot: '/vault/ElanvitalAI', notePath: '/vault/ElanvitalAI/digest.md' });
  expect(t).toBe('흡수 1편 → 우리에게 닿는 것 0\n\n참고 1편 — 노트: 1');
});

test('저장된 메시지 새 글이 이틀 넘게 없으면 노트에 경고 · 텔레그램 닿는 것 0은 머리만 · 이틀 안이면 없다', () => {
  const r = root();
  expect(buildIntakeDigest(r, '2026-09-30', () => undefined, new Date('2026-09-30T00:00:00Z')).savedSilence).toBeUndefined();
  mkdirSync(join(r, 'intake'), { recursive: true });
  writeFileSync(join(r, 'intake', 'telegram-saved.cursor.json'), JSON.stringify({ lastId: 8773, at: '2026-09-28T22:07:49.773Z' }) + '\n');
  expect(buildIntakeDigest(r, '2026-09-30', () => undefined, new Date('2026-09-29T23:30:00Z')).savedSilence).toBeUndefined();
  const d = buildIntakeDigest(r, '2026-10-01', () => undefined, new Date('2026-10-01T00:00:00Z'));
  expect(d.savedSilence).toEqual({ days: 2, lastNewAt: '2026-09-28T22:07:49.773Z' });
  expect(renderDigestMarkdown(d)).toContain('새 글을 2일째 못 받았다(마지막 새 글 수집 2026-09-29)');
  expect(renderDigestTelegram(d)).toBe('흡수 0편 → 우리에게 닿는 것 0');
});

test('lens file drives the digest: same verdict+target repeats collapse to one A, and a header over three says how many more (ACP must-fix)', () => {
  const r = root();
  const at = '2026-10-05T03:00:00.000Z';
  ingestIntakeItems(r, 'youtube', Array.from({ length: 6 }, (_, n) => ({ url: `https://example.org/m${n}` })), at, quiet);
  const ids = listIntakeItems(r).map((i) => i.id);
  for (const [n, id] of ids.entries()) markIntakeItem(r, id, { status: 'absorbed', output: { kind: 'note', ref: `/v/m${n}.md` } }, at);
  const lens = join(r, 'intake', 'outbox', 'lens');
  mkdirSync(lens, { recursive: true });
  writeFileSync(join(lens, '2026-10-05.jsonl'), [
    { id: ids[0], at, lensVerdict: '보강', why: '첫째 근거가 칸을 보강한다.', target: 'VIDEO-2' },
    { id: ids[1], at, lensVerdict: '보강', why: '둘째도 같은 칸을 보강한다.', target: 'VIDEO-2' },
    { id: ids[2], at, lensVerdict: '대체 후보', why: '유료 의존을 줄일 수 있다.', target: 'video-gen' },
    { id: ids[3], at, lensVerdict: '경쟁 대조', why: '편집 시간을 같은 조건에서 비교해야 한다.', target: 'editor' },
    { id: ids[4], at, lensVerdict: '보강', why: '다른 칸을 보강한다.', target: 'VIDEO-3' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const read = (p: string) => p.endsWith('.md') ? `## 한줄 결론\n${p} 의 결론이다.\n` : undefined;
  const d = buildIntakeDigest(r, '2026-10-05', read);
  const text = renderDigestTelegram(d);
  expect(text.split('\n')[0]).toBe('흡수 6편 → 우리에게 닿는 것 5');
  const actions = text.match(/^A 그래서 무엇을 하나: .+$/gm) ?? [];
  expect(new Set(actions).size).toBe(actions.length);
  expect(actions.filter((a) => a.includes('칸 VIDEO-2 에 근거 추가')).length).toBe(2);
  expect(text.match(/^S 무엇: /gm)?.length).toBe(3);
  // Each block keeps S, C, A and its link together.
  expect(text).toMatch(/S 무엇: [^\n]+\nC 우리에게 왜: [^\n]+\nA 그래서 무엇을 하나: [^\n]+\n🔗 노트: /);
  expect(text).toContain('닿는 것 2건 더');
});

test('a lens «why» that only names paths, even behind a label, is not shown as C (ACP must-fix)', async () => {
  const { pathOnly } = await import('../src/intake-plane/digest.js');
  expect(pathOnly('경로: catalog/resources.yaml')).toBe(true);
  expect(pathOnly('`src/feature.ts:12`, scripts/x.ts')).toBe(true);
  expect(pathOnly('file: src/a.ts')).toBe(true);
  expect(pathOnly('video-gen 의 유료 렌더링 의존을 줄일 가능성이 있다.')).toBe(false);
});

test('NEWS-INTAKE: telegram carries at most three news items, each with S · A · link', () => {
  const news = Array.from({ length: 4 }, (_, i) => ({ title: `기사 ${i}`, url: `https://n.example/${i}`, summary: [`요약 ${i}`, '둘째 줄'], implication: [`함의 ${i}`] }));
  const t = renderDigestTelegram({ day: '2026-10-06', grounding: 0, release: 0, manual: 0, absorbed: [], goals: [], news });
  expect(t.match(/^📰 /gm)).toHaveLength(3);
  expect(t).toContain('S: 요약 0');
  expect(t).toContain('A: 함의 0');
  expect(t).toContain('https://n.example/2');
  expect(t).not.toContain('기사 3');
});

test('NEWS-INTAKE: the news recipe resolves the script from the graph dir, not the cron cwd', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const recipes = parse(readFileSync(new URL('../graphs/intake/recipes.yaml', import.meta.url), 'utf8')) as Record<string, { command: string }>;
  expect(recipes['intake-news']!.command).toContain('$ELANOUS_GRAPH_DIR/../../scripts/intake-news.ts');
});
