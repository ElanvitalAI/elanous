#!/usr/bin/env bun
// deliver node — «최종 게시» 승인 «뒤»에만 돈다. 읽는 것은 그 시점의 초안 파일(사람이 고친 최신본)이지 처음 생성본이 아니다.
// ① 커버 문구·사진별 한 줄이 렌더 당시와 다르면 그 장만 다시 그린다 ② 포함된 장만 순서대로 <folder>/feed/ready/ 에 모은다
// ③ caption.txt(훅·본문·해시태그·위치) ⊕ 릴스 사본 ④ 텔레그램(/v1/outbound)에 «승인됨 · 게시 준비 완료» 한 줄.
// ⛔ 인스타그램에 올리지 않는다 — 실제 Meta 게시는 다음 판.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver as sendReport } from '../../src/domains/outbound-alert.js';
import { coverHtml, readContext, readDraft, result, screenshot, slideHtml, writeDraft } from './lib.js';

try {
  const { folder } = readContext();
  const draft = readDraft(folder);
  if (!draft) throw new Error('초안 없음 — feed 노드가 먼저 돌아야 한다');
  const included = draft.slides.filter((s) => s.include);
  if (!included.length) throw new Error('포함된 사진이 0장이다');

  let redrawn = 0;
  if (draft.cover.text !== draft.cover.renderedText || draft.cover.sub !== draft.cover.renderedSub || draft.cover.renderedSource !== included[0]!.source) {
    screenshot(coverHtml(join(folder, included[0]!.source), draft.cover.text, draft.cover.sub), join(folder, draft.cover.image));
    draft.cover.renderedText = draft.cover.text; draft.cover.renderedSub = draft.cover.sub; draft.cover.renderedSource = included[0]!.source; redrawn++;
  }
  included.forEach((s, i) => {
    // 번호(01 / N)는 포함된 장 기준이라, 빼거나 순서를 바꾸면 글이 같아도 다시 그린다.
    const label = `${i + 1}/${included.length}:${s.caption}`;
    if (s.renderedCaption !== label) {
      screenshot(slideHtml(join(folder, s.source), s.caption, i + 1, included.length), join(folder, s.image));
      s.renderedCaption = label; redrawn++;
    }
  });
  if (redrawn) writeDraft(folder, { ...draft, updatedAt: new Date().toISOString() });

  const ready = join(folder, 'feed', 'ready');
  rmSync(ready, { recursive: true, force: true });
  mkdirSync(ready, { recursive: true });
  copyFileSync(join(folder, draft.cover.image), join(ready, '00-cover.png'));
  included.forEach((s, i) => copyFileSync(join(folder, s.image), join(ready, `${String(i + 1).padStart(2, '0')}.png`)));
  const text = [draft.caption.hook, '', draft.caption.body, '', draft.hashtags.join(' '), ...(draft.location ? ['', `📍 ${draft.location}`] : [])].join('\n');
  writeFileSync(join(ready, 'caption.txt'), text + '\n');
  const reel = draft.reel && existsSync(join(folder, draft.reel)) ? join(ready, 'reel-9x16.mp4') : null;
  if (reel) copyFileSync(join(folder, draft.reel!), reel);

  // FIELD_FEED_NOTIFY=0 — 시험·리허설에서 텔레그램으로 나가지 않게.
  // 경로(daemon=/v1/outbound 수락 · direct=텔레그램 직접 · false=실패)를 그대로 남긴다 — 10-01 운영 실측에서
  // «notified:true» 만 있고 그래프 자식은 debug.log 가 꺼져 있어 도착 근거가 0 이었다. 사람이 «최종 게시»를 누른
  // 직후라 야간 무음 보류는 걸지 않는다(sendOutbound 의 보류 대신 바로 보낸다).
  const notify = process.env.FIELD_FEED_NOTIFY === '0' ? 'off' : sendReport([
    `✅ 승인됨 · 게시 준비 완료 — ${draft.event.title} (${draft.event.date})`,
    `캐러셀 ${included.length + 1}장${reel ? ' ⊕ 릴스 1편' : ''} · 초안 r${draft.revision}${draft.updatedBy === 'human' ? '(사람이 고침)' : ''}`,
    '', text, '', `묶음: ${ready}`, '(인스타그램 게시는 아직 사람이 한다 — 자동 게시는 다음 판)',
  ].join('\n'), 'report');
  const delivered = { at: new Date().toISOString(), path: notify === false ? 'failed' : notify, revision: draft.revision };
  writeDraft(folder, { ...(readDraft(folder) ?? draft), delivered } as typeof draft);
  result({ ready, slides: included.length + 1, reel: Boolean(reel), redrawn, revision: draft.revision, notified: notify === 'daemon' || notify === 'direct', notifyPath: delivered.path });
} catch (error) {
  console.log(JSON.stringify({ outcome: 'fail', reason: error instanceof Error ? error.message : String(error) }));
}
