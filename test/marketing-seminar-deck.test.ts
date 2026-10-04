import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const decks = join(root, 'docs/marketing/decks');
const html = readFileSync(join(decks, 'ceo-seminar-1027-draft.html'), 'utf8');
const storyline = readFileSync(join(root, 'docs/marketing/STORYLINE-ceo-seminar-2026-10-27.md'), 'utf8');
const media = readFileSync(join(decks, 'media/README.md'), 'utf8');
const sources = readFileSync(join(root, 'docs/marketing/SOURCES-site-numbers-2026-10-03.md'), 'utf8');
const template = readFileSync(join(root, 'skills/pitch-deck/template.html'), 'utf8');
const slides = [...html.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/g)];
const scenes = [...storyline.split('## 장면 (')[1]!.split('\n## ')[0]!.matchAll(/^\| [1-7] \|[^|]+\| ([^|]+) \|/gm)]
  .map(match => match[1].trim());

function visibleText(slide: string): string {
  return slide.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<aside class="notes">[\s\S]*?<\/aside>/g, '')
    .replace(/<[^>]+>/g, ' ');
}

test('seminar slides follow every storyline scene in order, with three daily-proof slides and a spoken note each', () => {
  expect(scenes).toHaveLength(7);
  expect(slides.length).toBeGreaterThanOrEqual(12);
  expect(slides.length).toBeLessThanOrEqual(18);
  expect([...html.matchAll(/<section\b/g)]).toHaveLength(slides.length);
  expect(new Set(slides.map(slide => /data-claim="([^"]+)"/.exec(slide[1])?.[1])).size).toBe(slides.length);
  const slideScenes = slides.map(([, attributes, body]) => {
    const scene = /data-scene="([^"]+)"/.exec(attributes)?.[1];
    expect(scene).toBeDefined();
    expect(body).toContain(scene!);
    const notes = [...body.matchAll(/<aside class="notes">([^<]*)(?:<small>([^<]+)<\/small>)?<\/aside>/g)];
    expect(notes).toHaveLength(1);
    const spokenLine = notes[0]![1].trim();
    if (notes[0]![2]) expect(notes[0]![2]).toMatch(/^측정 시각: .+ 측정 명령: .+\.$/);
    expect(spokenLine.length).toBeGreaterThan(0);
    expect(spokenLine.length).toBeLessThanOrEqual(110);
    expect(spokenLine).not.toMatch(/[\r\n]/);
    expect([...spokenLine.matchAll(/[.!?](?=\s|$)/g)]).toHaveLength(1);
    expect(body).toMatch(/<h[12](?: class="[^"]+")?>[^<]+<\/h[12]>/);
    const words = [...body.matchAll(/<(?:h1|h2|p)\b[^>]*>([^<]*)<\/(?:h1|h2|p)>/g)]
      .flatMap(match => match[1].trim().split(/\s+/));
    expect(words.length).toBeLessThanOrEqual(45);
    return scene;
  });
  expect([...new Set(slideScenes)]).toEqual(scenes);
  for (const scene of scenes) {
    const count = slideScenes.filter(item => item === scene).length;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(scene === scenes[2] ? 5 : 2);
  }
  const proofSlides = slides.filter(slide => /^S3[CDE]$/.test(/data-claim="([^"]+)"/.exec(slide[1])?.[1] ?? ''));
  expect(proofSlides).toHaveLength(3);
  expect(proofSlides.map(slide => /<h2[^>]*>([^<]+)<\/h2>/.exec(slide[2])?.[1])).toEqual([
    '자리 넷 · 채널 하나', '하루 300+ PR', '사고는 난다 — 닫는 순서가 있다',
  ]);
  expect(proofSlides.every(slide => /data-scene="([^"]+)"/.exec(slide[1])?.[1] === scenes[2])).toBe(true);
  expect(slides.indexOf(proofSlides[0]!)).toBe(slides.indexOf(slides.find(slide => slide[1].includes('data-claim="S3B"'))!) + 1);
  expect(proofSlides[0]![2]).toContain('받는 이: TC · 종류: 수리 요청 · 칸: 발사 관문 · 기한: 오늘');
  for (const seat of ['OP · 운영', 'MK · 마케팅', 'TC · 기술', 'UX · 경험']) expect(proofSlides[0]![2]).toContain(seat);
  const incident = proofSlides[2]![2];
  expect([...incident.matchAll(/<strong>(사고|원인|우회|근본 수리)<\/strong>/g)].map(match => match[1]))
    .toEqual(['사고', '원인', '우회', '근본 수리']);
  expect(incident).toContain('시험 환경에서 자리별 발사가 막혔습니다.');
  expect(incident).toContain('설정이 빈 환경을 관문이 차단했습니다.');
  expect(incident).toContain('정식 도구로 시험 설정을 동기화한 뒤, 같은 일을 다시 발사했습니다.');
  expect(incident).toContain('설정이 없어도 기본값으로 판단하도록 고쳐 수리판을 착지했습니다.');
  expect(incident).toContain('우회 재발사 확인 · 근본 수리 착지');
  expect(incident).toContain('같은 일을 다시 띄웠고');
  expect(incident).not.toMatch(/찾습니다|고치고.*시험합니다|완료 여부|확인해야 합니다|예정입니다/);
  expect(incident).not.toMatch(/(?:src\/|docs\/|\.ts\b|GH_TOKEN|ELANOUS_[A-Z_]+)/);
  for (const id of ['5969082698', '5969106415', '5969108595', '5969131987']) expect(html).toContain(`issuecomment-${id}`);
  expect(html).toContain('근본 수리 커밋 a133c0d5e2 · #23392(회귀 시험 포함)');
  expect(html).toContain('수리 뒤 별도 운영 재발사 실측은 주장하지 않음');
});

test('every image is an existing registered actual screen with an actual-screen caption; absent footage remains a labelled slot', () => {
  const approved = new Set([...media.matchAll(/^\| ([^|]+\.(?:jpg|png)) \|[^\n]*실제 (?:화면|캡처)[^\n]*\|$/gm)]
    .map(match => match[1]));
  expect(approved.size).toBeGreaterThan(0);
  const images = [...html.matchAll(/<img\b[^>]*>/g)];
  expect(images.length).toBeGreaterThan(0);
  expect([...html.matchAll(/<figure\b/g)]).toHaveLength(images.length);
  for (const image of images) {
    const src = /\bsrc="([^"]+)"/.exec(image[0])?.[1];
    expect(src).toMatch(/^media\/[a-z-]+\.(?:jpg|png)$/);
    expect(approved.has(src!.slice('media/'.length))).toBe(true);
    expect(existsSync(join(decks, src!))).toBe(true);
    expect(image[0]).toMatch(/\balt="[^"]+"/);
  }
  for (const [, , body] of slides) {
    for (const figure of body.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/g)) {
      expect(figure[1]).toMatch(/<figcaption>[^<]*실제 화면[^<]*<\/figcaption>/);
    }
  }
  expect(html).not.toMatch(/<(?:video|iframe)\b/i);
  const slots = [...html.matchAll(/class="screen-slot"[^>]*>([^<]+)</g)];
  expect(slots.length).toBeGreaterThan(0);
  for (const slot of slots) expect(slot[1]).toContain('화면 자리 · 연출 아님');
});

test('site-source display candidates are the only performance figures; the daily snapshot shows its date', () => {
  const candidates = sources.split('\n').filter(line => /^\| (?:줄 수|병합 PR|완료 개월|하루 병합 PR\(10-03 KST\)) \|/.test(line))
    .map(line => /\| (\d+만\+ (?:줄|PR)|\d+개월\+|하루 \d+\+ PR) \|/.exec(line)?.[1] ?? '');
  expect(candidates).toEqual(['460만+ 줄', '2만+ PR', '5개월+', '하루 300+ PR']);
  const visible = slides.map(slide => visibleText(slide[2])).join(' ');
  for (const candidate of candidates) {
    expect(visible.split(candidate).length - 1).toBe(1);
  }
  // The dated snapshot label is not a performance count; all other visible numbers remain source candidates.
  const measurementDate = '2026년 10월 3일 00:00~21:23 KST';
  const withoutCandidates = candidates.reduce((text, candidate) => text.replace(candidate, ''), visible)
    .replace(measurementDate, '');
  expect(withoutCandidates).not.toMatch(/[0-9]/);
  const numericSlide = slides.find(slide => candidates.slice(0, 3).every(candidate => visibleText(slide[2]).includes(candidate)));
  expect(numericSlide?.[0]).toContain('저장소 규모');
  expect(numericSlide?.[0]).toContain('제작 주체 미분류');
  expect(numericSlide?.[0]).toContain('SOURCES-site-numbers-2026-10-03.md:5–11');
  expect(numericSlide?.[0]).toContain('내부 재측 후보이며 게시 승인 전');
  const dailyRow = sources.split('\n').find(line => line.startsWith('| 하루 병합 PR(10-03 KST) |'))!;
  const dailySlide = slides.find(slide => /data-claim="S3D"/.test(slide[1]));
  expect(dailyRow).toContain('307 PR');
  expect(dailyRow).toContain('2026-10-03T21:23+09:00');
  expect(dailyRow).toContain('10-03 00:00~21:23 KST 병합 · 제작 주체 미분류');
  const command = 'bun bin/elanous.mjs gh pr list --state merged --search "merged:>=2026-10-02T15:00:00Z" --limit 1000 --json number --jq length';
  expect(dailyRow).toContain(`\`${command}\``);
  expect(dailySlide?.[2]).toContain(`<h2 class="day-count">${candidates[3]}</h2>`);
  const dailyScreen = dailySlide?.[2].split('<aside class="notes">')[0] ?? '';
  // A partial-day count must show where it stops and never call itself the whole day.
  expect(dailyScreen).toContain(`${measurementDate} 병합 · 제작 주체 미분류`);
  expect(dailyScreen).not.toContain('전체');
  expect(dailySlide?.[2]).toContain('제작 주체 미분류');
  expect(dailySlide?.[2]).toContain(`측정 시각: 2026-10-03T21:23+09:00. 측정 명령: ${command}.`);
  expect(html).not.toMatch(/에이전트가 쓴|written by agents/i);
});

test('one site action and one allowed contact close the deck without banned language', () => {
  const emails = html.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
  expect(emails).toEqual(['user@elanvital.ai', 'user@elanvital.ai']);
  expect(html).not.toMatch(/곧|완전 자율|에이전트가 쓴/);
  expect(slides.map(slide => visibleText(slide[2])).join(' ')).not.toMatch(/\b(?:OpenAI|Anthropic|Google|Microsoft|Apple|Meta|Amazon)\b|삼성|네이버|카카오/i);
  const last = slides.at(-1)?.[0] ?? '';
  expect(last).toContain('href="https://elanous.ai"');
  expect(last).toContain('href="mailto:user@elanvital.ai"');
  expect(last).not.toMatch(/href="https?:\/\/(?!elanous\.ai)/);
  expect(html.slice(0, html.indexOf(last))).not.toContain('mailto:');
});

test('standalone deck keeps the pitch-deck navigation and print contract', () => {
  const script = (document: string) => document.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script(html)).toBe(script(template));
  expect(html).toContain('aspect-ratio: 16 / 9');
  expect(html).toContain('@page { size: 16in 9in; margin: 0; }');
  expect(html).toContain('break-after: page');
  expect(html).toContain('.slide:last-child { break-after: auto;');
  expect(html).not.toMatch(/<(?:script|link)\b[^>]+(?:src|href)\s*=/i);
});
