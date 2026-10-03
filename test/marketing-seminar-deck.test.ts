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

test('seminar slides follow every storyline scene in order, at one or two slides per scene, with a spoken note each', () => {
  expect(scenes).toHaveLength(7);
  expect(slides.length).toBeGreaterThanOrEqual(10);
  expect(slides.length).toBeLessThanOrEqual(16);
  expect([...html.matchAll(/<section\b/g)]).toHaveLength(slides.length);
  expect(new Set(slides.map(slide => /data-claim="([^"]+)"/.exec(slide[1])?.[1])).size).toBe(slides.length);
  const slideScenes = slides.map(([, attributes, body]) => {
    const scene = /data-scene="([^"]+)"/.exec(attributes)?.[1];
    expect(scene).toBeDefined();
    expect(body).toContain(scene!);
    const notes = [...body.matchAll(/<aside class="notes">([^<]+)<\/aside>/g)];
    expect(notes).toHaveLength(1);
    const spokenLine = notes[0]![1].trim();
    expect(spokenLine.length).toBeGreaterThan(0);
    expect(spokenLine.length).toBeLessThanOrEqual(110);
    expect(spokenLine).not.toMatch(/[\r\n]/);
    expect([...spokenLine.matchAll(/[.!?](?=\s|$)/g)]).toHaveLength(1);
    expect(body).toMatch(/<h[12]>[^<]+<\/h[12]>/);
    const words = [...body.matchAll(/<(?:h1|h2|p)\b[^>]*>([^<]*)<\/(?:h1|h2|p)>/g)]
      .flatMap(match => match[1].trim().split(/\s+/));
    expect(words.length).toBeLessThanOrEqual(45);
    return scene;
  });
  expect([...new Set(slideScenes)]).toEqual(scenes);
  for (const scene of scenes) {
    const count = slideScenes.filter(item => item === scene).length;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(2);
  }
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

test('only site-source display candidates are shown as numbers, and only as repository scale', () => {
  const candidates = sources.split('\n').filter(line => /^\| (?:줄 수|병합 PR|완료 개월) \|/.test(line))
    .map(line => /\| (\d+만\+ (?:줄|PR)|\d+개월\+) \|/.exec(line)?.[1] ?? '');
  expect(candidates).toEqual(['460만+ 줄', '2만+ PR', '5개월+']);
  const visible = slides.map(slide => visibleText(slide[2])).join(' ');
  for (const candidate of candidates) {
    expect(visible.split(candidate).length - 1).toBe(1);
  }
  const withoutCandidates = candidates.reduce((text, candidate) => text.replace(candidate, ''), visible);
  expect(withoutCandidates).not.toMatch(/[0-9]/);
  const numericSlide = slides.find(slide => candidates.every(candidate => visibleText(slide[2]).includes(candidate)));
  expect(numericSlide?.[0]).toContain('저장소 규모');
  expect(numericSlide?.[0]).toContain('제작 주체 미분류');
  expect(numericSlide?.[0]).toContain('SOURCES-site-numbers-2026-10-03.md:5–11');
  expect(numericSlide?.[0]).toContain('내부 재측 후보이며 게시 승인 전');
  expect(html).not.toMatch(/에이전트가 쓴|written by agents/i);
});

test('one site action and one allowed contact close the deck without banned language', () => {
  const emails = html.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
  expect(emails).toEqual(['user@elanvital.ai', 'user@elanvital.ai']);
  expect(html).not.toMatch(/곧|완전 자율|에이전트가 쓴/);
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
