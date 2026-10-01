// EV10d — «게시 대기» 피드 초안: 승인 노드가 `{"kind":"feed-preview"}` 이면 그 런의 현장폴더 초안
// (`<folder>/feed/feed-draft.json`)이 정본이다(계약 = MK 10-01 · field-feed 그래프). 경로는 «런 상태의
// input.folder» 에서만 구하고, 그 폴더는 `<configDir>/field/<slug>` 꼴일 때만 받는다(realpath 로 탈출 거부).
// 사람의 «수정 저장»은 허용된 칸만 고쳐 그 파일을 덮는다 — 승인 상태는 바꾸지 않는다.
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize, sep } from 'node:path';
import { fieldEventDir, isFieldSlug } from '../../field/field-media.js';
import type { GraphRunState } from '../../graph-runner/runner.js';

export interface FeedSlide { image: string; caption: string; include: boolean; [key: string]: unknown }
export interface FeedDraft {
  kind: 'feed-draft';
  version: 1;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  slides: FeedSlide[];
  caption: { hook: string; body: string };
  hashtags: string[];
  cover: { text: string; sub: string; image?: string; [key: string]: unknown };
  location: string | null;
  reel: string | null;
  brand?: { name?: string; handle?: string; avatar?: string | null };
  [key: string]: unknown;
}

/** Fields a person may change from the PWA — everything else (rendered*, source, folder…) is preserved. */
export interface FeedEdit {
  slides: Array<{ image: string; caption?: string; include?: boolean }>;
  caption: { hook: string; body: string };
  hashtags: string[];
  cover: { text: string; sub: string };
  location: string | null;
}

export const FEED_DRAFT_FILE = join('feed', 'feed-draft.json');

export function isFeedPreviewMessage(message: string): boolean {
  try {
    const parsed = JSON.parse(message) as unknown;
    return !!parsed && typeof parsed === 'object' && (parsed as { kind?: unknown }).kind === 'feed-preview';
  } catch { return false; }
}

function real(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/** The run's field folder when it is exactly `<configDir>/field/<slug>` (after resolving links), else null. */
export function feedFolderFor(state: Pick<GraphRunState, 'input'>, configDir: string): string | null {
  const input = state.input as { folder?: unknown } | undefined;
  const folder = typeof input?.folder === 'string' ? input.folder : null;
  if (!folder) return null;
  const slug = basename(folder);
  if (!isFieldSlug(slug)) return null;
  const resolved = real(folder);
  const expected = real(fieldEventDir(configDir, slug));
  if (!resolved || !expected || resolved !== expected) return null;
  if (dirname(resolved) !== real(join(configDir, 'field'))) return null;
  return resolved;
}

function str(value: unknown): string { return typeof value === 'string' ? value : ''; }

export function readFeedDraft(folder: string): FeedDraft | null {
  try {
    const raw = JSON.parse(readFileSync(join(folder, FEED_DRAFT_FILE), 'utf8')) as Partial<FeedDraft>;
    if (raw.kind !== 'feed-draft' || raw.version !== 1 || !Array.isArray(raw.slides)) return null;
    return raw as FeedDraft;
  } catch { return null; }
}

export type FeedEditResult = { ok: true; draft: FeedDraft } | { ok: false; error: string };

/** Apply a person's edit to the current draft. Slides must be the same set of images (order may change,
 *  removal is `include:false`), so no new path can enter the draft. */
export function applyFeedEdit(current: FeedDraft, edit: unknown, now = new Date()): FeedEditResult {
  if (!edit || typeof edit !== 'object') return { ok: false, error: 'bad_request' };
  const e = edit as Partial<FeedEdit>;
  if (!Array.isArray(e.slides) || !e.caption || typeof e.caption !== 'object' || !Array.isArray(e.hashtags)
    || !e.cover || typeof e.cover !== 'object') return { ok: false, error: 'bad_request' };
  const original = new Map(current.slides.map((slide) => [slide.image, slide]));
  const seen = new Set<string>();
  const slides: FeedSlide[] = [];
  for (const raw of e.slides) {
    const image = str((raw as { image?: unknown })?.image);
    const base = original.get(image);
    if (!base || seen.has(image)) return { ok: false, error: 'unknown-image' };
    seen.add(image);
    const caption = (raw as { caption?: unknown }).caption;
    const include = (raw as { include?: unknown }).include;
    slides.push({ ...base, ...(typeof caption === 'string' ? { caption } : {}), ...(typeof include === 'boolean' ? { include } : {}) });
  }
  if (seen.size !== original.size) return { ok: false, error: 'missing-image' };
  const location = e.location === null ? null : typeof e.location === 'string' ? e.location : current.location;
  return {
    ok: true,
    draft: {
      ...current,
      slides,
      caption: { ...current.caption, hook: str(e.caption.hook), body: str(e.caption.body) },
      hashtags: e.hashtags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean),
      cover: { ...current.cover, text: str(e.cover.text), sub: str(e.cover.sub) },
      location,
      revision: (Number.isFinite(current.revision) ? current.revision : 0) + 1,
      updatedBy: 'human',
      updatedAt: now.toISOString(),
    },
  };
}

export function writeFeedDraft(folder: string, draft: FeedDraft): void {
  const target = join(folder, FEED_DRAFT_FILE);
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(draft, null, 2)}\n`);
  renameSync(temp, target);
}

const MEDIA_RE = /^(?:feed\/[^/\\]+\.(?:png|jpe?g|webp)|reel\/reel-9x16\.mp4)$/i;

/** Absolute file for a folder-relative media path, only `feed/*.png|jpg|jpeg|webp` and `reel/reel-9x16.mp4`. */
export function resolveFeedMedia(folder: string, relative: string): string | null {
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.includes('\0')) return null;
  const clean = normalize(relative).split(sep).join('/');
  if (clean !== relative || !MEDIA_RE.test(clean)) return null;
  const file = join(folder, clean);
  if (!existsSync(file)) return null;
  const resolved = real(file);
  const root = real(folder);
  if (!resolved || !root || !resolved.startsWith(`${root}${sep}`)) return null;
  return resolved;
}

export function mediaContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  return 'image/jpeg';
}
