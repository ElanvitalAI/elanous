#!/usr/bin/env bun
// feed node — 현장 폴더 → 인스타 피드 초안 한 벌: 4:5(1080×1350) 캐러셀(커버 ⊕ 사진별 한 줄) ⊕ 캡션(훅·본문·해시태그·위치) ⊕ 릴스 경로.
// 쓰는 곳: <folder>/feed/feed-draft.json(정본) · <folder>/feed/slide-N.png. 사진별 한 줄과 제목은 앞 reel 노드의
// reel/timeline.json(비전 결과)을 그대로 쓴다 — 같은 사진을 두 번 읽지 않는다. 없으면 «현장 N».
// 사람이 이미 고친 초안(updatedBy: human)이 있으면 덮지 않는다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ask, coverHtml, draftPath, kstDate, lastJson, listPhotos, readContext, readDraft, result, screenshot, slideHtml, writeDraft, type FeedDraft } from './lib.js';

const started = Date.now();
try {
  const { folder, runId } = readContext();
  const existing = readDraft(folder);
  if (existing?.updatedBy === 'human') {
    result({ draftPath: draftPath(folder), slides: existing.slides.length, kept: 'human-edited' });
    process.exit(0);
  }
  let timeline: { title?: string; sub?: string; items?: { file: string; video?: boolean; cap?: string }[] } = {};
  try { timeline = JSON.parse(readFileSync(join(folder, 'reel', 'timeline.json'), 'utf8')); } catch { /* reel 없이도 돈다 */ }
  // 릴스가 쓴 순서(와 reel/v<i>.jpg 번호)를 그대로 따른다 — 같은 사진이 두 순서로 갈리지 않게.
  const reelOrder = (timeline.items ?? []).map((it) => it.file);
  const photos = reelOrder.length ? (timeline.items ?? []).filter((it) => !it.video).map((it) => it.file) : listPhotos(folder);
  if (!photos.length) throw new Error('현장 폴더에 사진이 없다');
  const capOf = new Map((timeline.items ?? []).map((it) => [it.file, it.cap ?? '']));
  const title = timeline.title && timeline.title !== '현장 스케치' ? timeline.title : '현장 스케치';
  const date = timeline.sub || kstDate(photos);
  const shown = photos.slice(0, 9); // 커버 ⊕ 9장 = 인스타 캐러셀 상한 10
  const captions = shown.map((f, i) => capOf.get(f) || `현장 ${i + 1}`);

  const out = join(folder, 'feed');
  mkdirSync(out, { recursive: true });
  screenshot(coverHtml(join(folder, shown[0]!), title, `${date} · 현장 스케치`), join(out, 'slide-0.png'));
  shown.forEach((f, i) => screenshot(slideHtml(join(folder, f), captions[i]!, i + 1, shown.length), join(out, `slide-${i + 1}.png`)));
  const rendered = Date.now();

  // 캡션: 행사 제목 ⊕ 사진별 한 줄 ⊕ 사진(앞 셋)을 보고 한 벌. 실패하면 템플릿.
  const prompt = [
    '행사 현장 사진으로 인스타그램 게시글 초안을 쓴다. JSON 객체 하나만 출력하라:',
    '{"hook": 첫 줄(25자 이내 · 이모지 0~1개), "body": 본문 2~3문장(보이는 장면과 아래 한 줄들만 근거 · 사람 이름·외모·감정 추측 금지 · 과장 금지), "hashtags": 6~8개(한국어 위주 · # 포함), "location": 화면 글자에서 읽히는 장소 이름 또는 null}',
    `행사 제목: ${title}`, `날짜: ${date}`, `사진별 한 줄: ${captions.join(' / ')}`,
  ].join('\n');
  const reply = lastJson(await ask(prompt, shown.slice(0, 3).map((f) => join(folder, 'reel', `v${reelOrder.indexOf(f)}.jpg`)).filter(existsSync)));
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : '');
  const tags = Array.isArray(reply?.hashtags) ? (reply!.hashtags as unknown[]).filter((t): t is string => typeof t === 'string' && /^#\S{1,30}$/.test(t)).slice(0, 10) : [];
  const draft: FeedDraft = {
    kind: 'feed-draft', version: 1, revision: (existing?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), updatedBy: 'graph',
    graphId: 'field-feed', runId, folder,
    brand: { name: 'Elanous', handle: 'elanous.ai', avatar: null },
    event: { title, date },
    cover: { text: title, sub: `${date} · 현장 스케치`, image: 'feed/slide-0.png', renderedText: title, renderedSub: `${date} · 현장 스케치`, renderedSource: shown[0]! },
    slides: shown.map((f, i) => ({ image: `feed/slide-${i + 1}.png`, source: f, caption: captions[i]!, include: true, renderedCaption: `${i + 1}/${shown.length}:${captions[i]!}` })),
    caption: {
      hook: str(reply?.hook, 40) || `${title} 현장`,
      body: str(reply?.body, 400) || `${date}, ${title} 현장을 사진으로 담았습니다.`,
    },
    hashtags: tags.length ? tags : ['#현장스케치', `#${title.replace(/\s+/g, '')}`],
    location: str(reply?.location, 40) || null,
    reel: existsSync(join(folder, 'reel', 'reel-9x16.mp4')) ? 'reel/reel-9x16.mp4' : null,
  };
  writeDraft(folder, draft);
  result({
    draftPath: draftPath(folder), slides: draft.slides.length + 1, vision: Boolean(reply),
    renderMs: rendered - started, totalMs: Date.now() - started,
  });
} catch (error) {
  console.log(JSON.stringify({ outcome: 'fail', reason: error instanceof Error ? error.message : String(error) }));
}
