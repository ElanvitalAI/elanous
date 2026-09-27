import { existsSync } from 'node:fs';
import type { DetectedSource, SourceType } from './types.js';

export function detectSource(input: string): DetectedSource {
  const t = input.trim();

  // ── X (Twitter) ──
  const articleM = t.match(/(?:x\.com|twitter\.com)\/(\w+)\/article\/(\d+)/);
  if (articleM) return { type: 'x-article', input: t, authorHandle: articleM[1], articleId: articleM[2] };

  const postM = t.match(/(?:x\.com|twitter\.com)\/(\w+)\/status\/(\d+)/);
  if (postM) return { type: 'x-post', input: t, authorHandle: postM[1], tweetId: postM[2] };

  // ── YouTube ──
  if (/(?:youtube\.com|youtu\.be|youtube\.com\/shorts\/|youtube\.com\/embed\/)/.test(t))
    return { type: 'youtube', input: t };

  // ── GitHub ──
  const ghRepo = t.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/);
  if (ghRepo) {
    const [, owner, repo] = ghRepo;
    const prM = t.match(/\/pull\/(\d+)/);       if (prM)     return { type: 'github-pr',     input: t, owner, repo, ref: prM[1] };
    const isM = t.match(/\/issues\/(\d+)/);      if (isM)     return { type: 'github-issue',  input: t, owner, repo, ref: isM[1] };
    const cmM = t.match(/\/commit\/([a-f0-9]+)/i); if (cmM)  return { type: 'github-commit', input: t, owner, repo, ref: cmM[1] };
    return { type: 'github-repo', input: t, owner, repo };
  }

  // ── Local file ──
  if (existsSync(t) || /\.(pdf|docx?|txt|md|csv|xlsx?|pptx?|png|jpe?g|gif|bmp|tiff|webp)$/i.test(t))
    return { type: 'local-file', input: t };

  // ── Web URL ──
  if (/^https?:\/\//i.test(t)) return { type: 'web', input: t };

  return { type: 'unknown', input: t };
}

export function sourceLabel(type: SourceType): string {
  const labels: Record<SourceType, string> = {
    'x-post': 'X 포스트', 'x-article': 'X 아티클', youtube: 'YouTube',
    web: '웹페이지', 'github-repo': 'GitHub 레포', 'github-pr': 'GitHub PR',
    'github-issue': 'GitHub Issue', 'github-commit': 'GitHub Commit',
    'local-file': '로컬 파일', unknown: '알 수 없음',
  };
  return labels[type];
}
