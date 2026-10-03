import { requireEnv } from './env.js';
import type { VideoMeta } from './types.js';

const VIDEO_ID_PATTERNS = [
  /[?&]v=([0-9A-Za-z_-]{11})/,
  /youtu\.be\/([0-9A-Za-z_-]{11})/,
  /\/shorts\/([0-9A-Za-z_-]{11})/,
  /\/embed\/([0-9A-Za-z_-]{11})/,
  /(?:v=|\/)([0-9A-Za-z_-]{11})/,
];

export function extractVideoId(url: string): string | null {
  for (const pat of VIDEO_ID_PATTERNS) {
    const m = url.match(pat);
    if (m) return m[1];
  }
  return null;
}

export function parseISODuration(iso: string): string {
  const m = (iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 'N/A';
  const h = Number(m[1] || 0);
  const mm = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  const parts: string[] = [];
  if (h) parts.push(`${h}시간`);
  if (mm) parts.push(`${mm}분`);
  if (s || !parts.length) parts.push(`${s}초`);
  return parts.join(' ');
}

export function parseISODurationToSeconds(iso: string): number {
  const m = (iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

export function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export async function fetchYoutubeMeta(videoId: string): Promise<VideoMeta> {
  const apiKey = requireEnv('YOUTUBE_API_KEY');
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API 오류: ${res.status}`);
  const data = await res.json();
  if (!data.items?.length) throw new Error('영상 정보를 찾을 수 없습니다.');
  const item = data.items[0];
  const snippet = item.snippet;
  const stats = item.statistics || {};
  const durationIso = item.contentDetails?.duration || '';
  return {
    title: snippet.title || 'Untitled',
    channel: snippet.channelTitle || 'Unknown',
    description: (snippet.description || '').substring(0, 6000),
    uploaded: snippet.publishedAt || '',
    duration: parseISODuration(durationIso),
    durationSec: parseISODurationToSeconds(durationIso),
    durationIso,
    views: Number(stats.viewCount || 0),
    likes: Number(stats.likeCount || 0),
  };
}
