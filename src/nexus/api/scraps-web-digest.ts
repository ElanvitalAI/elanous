import { fetchJina } from '../../../skills/omni-crawl/src/free.js';
import { debug } from '../../debug/log.js';
import type { ScrapsRouteOptions } from './scraps.js';

const SCRAP_WEB_FETCH_TIMEOUT_MS = 15_000;
const SCRAP_WEB_BODY_CHARS = 100_000;
const MK_FALLBACK_MIN_CHARS = 200;

function mkReaderBody(content: string, title: string): string {
  const lines = content.split('\n');
  const heading = lines.findIndex(line => /^#{1,3}\s+/.test(line) && line.replace(/^#{1,3}\s+/, '').trim() === title.trim());
  if (heading < 0 || !title.trim()) throw new Error('article title unavailable');
  const tail = lines.slice(heading + 1);
  const end = tail.findIndex(line => /^\s*(?:\[[^\]\n]+기자\]|\*\*주의사항\*\*|#{1,3}\s+(?:핵심요약|AI 해설)|\[?ⓒ|©|Copyright\b|무단전재(?:\s|$)|#{1,3}\s*(?:댓글|관련\s*기사)(?:\s|$|\d)|\[관련기사\])/i.test(line));
  if (end < 0) throw new Error('article footer unavailable');
  const body = tail.slice(0, end).join('\n').trim();
  if (body.length < MK_FALLBACK_MIN_CHARS) throw new Error('article body unavailable');
  return body;
}

/** MK's Reader markdown includes page navigation and a second comment panel around the article. */
function articleBody(url: string, content: string, title: string): string {
  const parsed = new URL(url);
  if (!/(^|\.)mk\.co\.kr$/.test(parsed.hostname) || !parsed.pathname.startsWith('/news/')) return content;
  const detail = content.indexOf('# 기사 상세');
  if (detail < 0) return mkReaderBody(content, title);
  const article = content.slice(detail);
  const byline = /\[매일경제[^\]\n]*기자\]/.exec(article);
  if (!byline || byline.index === undefined) return mkReaderBody(content, title);
  const body = article.slice(byline.index + byline[0].length);
  const footer = /^(?:\s*[\w.+-]+@[\w.-]+|\s*\[ⓒ|\s*이 기사가 마음에 들었다면|\s*댓글\s*_?\d+_?\s*댓글 새로고침)/m.exec(body);
  if (!footer) throw new Error('article footer unavailable');
  const clean = body.slice(0, footer.index).trim();
  if (!clean) throw new Error('article body unavailable');
  return clean;
}

/** Reuse the URL-safety checked reader for member article scraps. */
export function createScrapsWebDigest(reader: typeof fetchJina = fetchJina): (url: string) => Promise<{ title: string; body: string }> {
  return async (url) => {
    let readerFailure: 'invalid-url' | 'http' | 'timeout' | 'network' | 'empty' | undefined;
    let readerStatus: number | undefined;
    let result: Awaited<ReturnType<typeof fetchJina>>;
    try {
      result = await reader(url, { timeoutMs: SCRAP_WEB_FETCH_TIMEOUT_MS, quiet: true,
        onFailure: (reason, status) => { readerFailure = reason; readerStatus = status; } });
    } catch {
      debug.log('absorb.web-digest', 'reader-failed', { stage: 'reader-exception' });
      throw new Error('web digest unavailable');
    }
    if (!result?.content.trim()) {
      debug.log('absorb.web-digest', 'reader-failed', { stage: readerFailure ?? 'empty', status: readerStatus ?? null });
      throw new Error('web digest unavailable');
    }
    try {
      return { title: result.title.slice(0, 200), body: articleBody(url, result.content, result.title).slice(0, SCRAP_WEB_BODY_CHARS) };
    } catch {
      debug.log('absorb.web-digest', 'parser-failed', { stage: 'parser' });
      throw new Error('web digest unavailable');
    }
  };
}

export function createNexusScrapsRouteOptions(instanceRoot: string, reader: typeof fetchJina = fetchJina):
  Pick<ScrapsRouteOptions, 'instanceRoot' | 'extractors'> {
  return { instanceRoot, extractors: { digestWeb: createScrapsWebDigest(reader) } };
}
