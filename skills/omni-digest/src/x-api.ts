/** X(Twitter) API — absorbed from x-to-obsidian */

import { requireEnv } from './env.js';
import type { TweetMeta, TweetMedia, Reply } from './types.js';

async function xApiFetch(url: string): Promise<any> {
  const token = requireEnv('BEARER_TOKEN');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    if (res.status === 401) throw new Error('Bearer Token이 유효하지 않습니다.');
    if (res.status === 429) throw new Error('API 요청 한도 초과.');
    throw new Error(`X API error: ${res.status}`);
  }
  return res.json();
}

/** media.variants 중 MP4만 비트레이트 오름차순으로 정렬 (HLS 등은 제외) */
function sortedMp4s(variants: any[] = []): any[] {
  return variants
    .filter(v => v.content_type === 'video/mp4' && v.url)
    .sort((a, b) => (a.bit_rate || 0) - (b.bit_rate || 0));
}

function parseMedia(includes: any): TweetMedia[] {
  return (includes?.media || []).map((m: any): TweetMedia => {
    const isVideo = m.type === 'video' || m.type === 'animated_gif';
    const mp4s = isVideo ? sortedMp4s(m.variants) : [];
    return {
      mediaKey: m.media_key,
      type: m.type,
      durationMs: m.duration_ms,
      // 최고 화질은 보관용, 최저 화질은 STT용 (4K 4분이면 1GB에 육박한다)
      bestMp4Url: mp4s.length ? mp4s[mp4s.length - 1].url : undefined,
      sttMp4Url: mp4s.length ? mp4s[0].url : undefined,
      previewImageUrl: m.preview_image_url || m.url,
    };
  });
}

export async function fetchTweetMeta(tweetId: string): Promise<TweetMeta> {
  // note_tweet = 280자 초과 장문 전문 / media.* = 첨부 영상 직링크
  const url = `https://api.x.com/2/tweets/${tweetId}`
    + `?tweet.fields=created_at,public_metrics,text,author_id,conversation_id,note_tweet`
    + `&expansions=author_id,attachments.media_keys`
    + `&user.fields=username,name`
    + `&media.fields=type,duration_ms,variants,preview_image_url,url,media_key`;
  const data = await xApiFetch(url);
  if (!data.data) throw new Error('트윗 정보를 찾을 수 없습니다.');
  const tweet = data.data;
  const user = data.includes?.users?.[0];
  const m = tweet.public_metrics || {};

  // 장문 트윗이면 note_tweet.text가 전문 (tweet.text는 280자에서 잘림)
  const noteText: string = tweet.note_tweet?.text || '';
  const shortText: string = tweet.text || '';
  const isLongform = noteText.length > shortText.length;

  return {
    text: isLongform ? noteText : shortText,
    isLongform,
    media: parseMedia(data.includes),
    author: `${user?.name || 'Unknown'} (@${user?.username || 'unknown'})`,
    authorHandle: user?.username || 'unknown',
    createdAt: tweet.created_at ? tweet.created_at.split('T')[0] : 'N/A',
    conversationId: tweet.conversation_id || tweetId,
    viewCount: m.impression_count ? Number(m.impression_count).toLocaleString() : 'N/A',
    likeCount: m.like_count ? Number(m.like_count).toLocaleString() : 'N/A',
    retweetCount: m.retweet_count ? Number(m.retweet_count).toLocaleString() : 'N/A',
    replyCount: m.reply_count ? Number(m.reply_count).toLocaleString() : 'N/A',
    bookmarkCount: m.bookmark_count ? Number(m.bookmark_count).toLocaleString() : 'N/A',
    metrics: { impression_count: m.impression_count || 0, like_count: m.like_count || 0, retweet_count: m.retweet_count || 0, reply_count: m.reply_count || 0, bookmark_count: m.bookmark_count || 0 },
  };
}

export async function fetchReplies(conversationId: string): Promise<Reply[]> {
  try {
    const url = `https://api.x.com/2/tweets/search/recent?query=conversation_id:${conversationId}&tweet.fields=text,public_metrics,author_id,created_at&expansions=author_id&user.fields=username,name&max_results=30`;
    const data = await xApiFetch(url);
    if (!data.data?.length) return [];
    const users: Record<string, string> = {};
    for (const u of data.includes?.users || []) users[u.id] = `${u.name} (@${u.username})`;
    return data.data
      .filter((r: any) => r.id !== conversationId)
      .map((r: any) => ({ text: r.text, author: users[r.author_id] || 'Unknown', likes: r.public_metrics?.like_count || 0, createdAt: r.created_at?.split('T')[0] || 'N/A' }))
      .sort((a: Reply, b: Reply) => b.likes - a.likes)
      .slice(0, 20);
  } catch { return []; }
}

async function resolveUrl(u: string): Promise<string> {
  try { return (await fetch(u, { method: 'HEAD', redirect: 'follow' })).url || u; } catch { return u; }
}

function normalizeXUrl(url: string): string {
  try { const u = new URL(url); u.search = ''; u.hash = ''; return u.toString(); } catch { return url; }
}

export function isXInternalUrl(url: string): boolean {
  return /https?:\/\/(?:x\.com|twitter\.com)\/[^\s/]+\/(?:status|article)\/\d+/.test(url);
}

export function extractXInternalUrls(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/(?:x\.com|twitter\.com)\/[^\s/]+\/(?:status|article)\/\d+/g) || []).map(normalizeXUrl))];
}

export async function extractLinks(text: string): Promise<string[]> {
  const tco = text.match(/https?:\/\/t\.co\/\w+/g) || [];
  if (!tco.length) return [];
  return [...new Set((await Promise.all(tco.map(resolveUrl))).map(normalizeXUrl))];
}

export async function fetchArticleContent(articleUrl: string): Promise<string> {
  const res = await fetch(`https://r.jina.ai/${articleUrl}`, { headers: { Accept: 'text/markdown', 'X-Return-Format': 'markdown' } });
  if (!res.ok) throw new Error(`Jina Reader error: ${res.status}`);
  const text = await res.text();
  if (!text || text.trim().length < 50) throw new Error('아티클 본문이 너무 짧음');
  return text.trim();
}

export function looksLikeOnlyUrls(text: string): boolean {
  return text.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim().length < 8;
}

export function guessHeadingFromSummary(body: string, fallback = 'X Post'): string {
  const exec = body.match(/^#{1,6}\s*(\d+\.)?\s*Executive Summary\b[\s\S]*?\n[-•]\s*(.+)$/mi);
  if (exec?.[2]) return exec[2].replace(/[*_`]/g, '').trim().substring(0, 80);
  // rich-cards 절 표지(「1. 🎯 한 줄 결론」·「✅ 한눈에 정리」…)는 제목이 아니다 — 「한 줄 결론」이면 그 «다음» 문장이 제목(2026-09-26: 노트 이름이 `_한_줄_결론` 이 됐다).
  const label = /^(\d+\.\s*)?[^\p{L}\p{N}]*(한\s?줄\s?결론|한눈에\s?정리|상세\s?카드|핵심|참조\s?링크|원문)/u;
  let wantNext = false;
  for (const line of body.split('\n')) {
    const c = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
    if (!c || /^(table of contents|executive summary|scqa|comment analysis)$/i.test(c)) continue;
    if (/^[-*]\s*\[.+\]\(#.+\)\s*$/.test(c) || /^https?:\/\//.test(c)) continue;
    if (label.test(c)) { wantNext = /한\s?줄\s?결론/.test(c); continue; }
    if (!wantNext && /^[-*•]\s/.test(c)) continue;
    return c.replace(/[*_`]/g, '').trim().substring(0, 80);
  }
  return fallback;
}

export function insertRefLinksAfterToc(body: string, refBlock: string): string {
  const lines = body.split('\n');
  const ref = refBlock.trim();
  if (!ref) return body;
  const tocIdx = lines.findIndex(l => /^#{1,6}\s*(\d+\.)?\s*table of contents\b/i.test(l.trim()));
  if (tocIdx === -1) return [ref, '', ...lines].join('\n');
  let next = -1;
  for (let i = tocIdx + 1; i < lines.length; i++) { if (/^#{1,6}\s+/.test(lines[i].trim())) { next = i; break; } }
  if (next === -1) return [...lines, '', ref].join('\n');
  return [...lines.slice(0, next), '', ref, '', ...lines.slice(next)].join('\n');
}
