/**
 * 무료 티어 — 자동 계약 선택에서 먼저 시도하고, 공백이면 BYOK로 진행한다.
 *
 * 구현 (deer-flow ddg_search/jina_ai 포팅, dep-free = 순수 fetch + regex):
 *   - searchDdg   : DuckDuckGo HTML 엔드포인트 스크레이프 (키 불필요)
 *   - fetchJina   : r.jina.ai Reader 마크다운 직수신 (키리스·저 rate-limit)
 *   - scrapeFree  : jina → (폴백) 직접 HTML fetch + 로컬 readability. SSRF 가드.
 */

import type { CrawlResult, CrawlItem } from './types.js';
import { env } from './env.js';
import { validatePublicHttpUrl } from './url-safety.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 무료 티어는 항상 사용 가능 (키 불필요). Jina 키 있으면 rate-limit만 상향. */
export function freeAvailable(): boolean { return true; }

// ── HTML 엔티티 최소 디코드 ──
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** DDG 리다이렉트 래퍼(//duckduckgo.com/l/?uddg=...) 언랩 */
function unwrapDdgUrl(href: string): string {
  try {
    const u = href.startsWith('//') ? new URL('https:' + href) : new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return href.startsWith('//') ? 'https:' + href : href;
  } catch { return href; }
}

/**
 * DuckDuckGo HTML 검색 (무료·키 불필요). html.duckduckgo.com/html/ 스크레이프.
 * deer-flow 의 ddgs 라이브러리와 동일 엔드포인트 계열.
 */
export async function searchDdg(query: string, opts?: { maxResults?: number; timeoutMs?: number }): Promise<CrawlResult> {
  const max = opts?.maxResults ?? 5;
  console.log(`  [ddg-free] 검색: "${query}" (무료·키 불필요, max=${max})`);
  const items: CrawlItem[] = [];
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // 결과 블록: result__a(제목+href) ~ result__snippet(스니펫)
    const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = snipRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));

    let m: RegExpExecArray | null; let idx = 0;
    while ((m = linkRe.exec(html)) !== null && items.length < max) {
      const url = unwrapDdgUrl(m[1]);
      const title = stripTags(m[2]);
      if (!url || !title) { idx++; continue; }
      const snippet = snippets[idx] || '';
      items.push({
        engine: 'ddg-free', query, url,
        text: snippet || title,
        author: (() => { try { return new URL(url).hostname; } catch { return 'unknown'; } })(),
        metadata: { title, source: 'ddg-html' },
      });
      idx++;
    }
    console.log(`  [ddg-free] ${items.length}건 (비용 0)`);
  } catch (e: any) {
    console.log(`  [ddg-free] 실패: ${e.message?.slice(0, 80)}`);
  }
  return { engine: 'ddg-free', query, items, totalItems: items.length, costNote: 'ddg 무료' };
}

/**
 * Jina Reader (r.jina.ai) 로 URL → 클린 마크다운 직수신. 키 없어도 동작(저 rate-limit).
 * deer-flow 는 HTML 받아 로컬 readability 를 돌리지만, Jina 는 마크다운을
 * 서버측에서 직접 반환하므로 dep-free 로 더 간단.
 */
export async function fetchJina(url: string, opts?: { timeoutMs?: number; allowPrivate?: boolean; quiet?: boolean; onFailure?: (reason: 'invalid-url' | 'http' | 'timeout' | 'network' | 'empty', status?: number) => void }): Promise<{ title: string; content: string } | null> {
  const err = await validatePublicHttpUrl(url, { action: 'fetch', allowPrivate: opts?.allowPrivate });
  if (err) { opts?.onFailure?.('invalid-url'); if (!opts?.quiet) console.log(`  [jina-free] 차단: ${url.slice(0, 50)} — ${err}`); return null; }
  try {
    const headers: Record<string, string> = { 'X-Return-Format': 'markdown', 'User-Agent': UA };
    const jinaKey = env('JINA_API_KEY');
    if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers, signal: AbortSignal.timeout(opts?.timeoutMs ?? 25_000),
    });
    if (!res.ok) {
      opts?.onFailure?.('http', res.status);
      if (!opts?.quiet) console.log(`  [jina-free] 실패(${url.slice(0, 50)}): HTTP ${res.status}`);
      return null;
    }
    const raw = (await res.text()).trim();
    if (!raw || raw.startsWith('Error:')) { opts?.onFailure?.('empty'); return null; }

    // Jina 헤더 파싱: "Title: ...\nURL Source: ...\n...\nMarkdown Content:\n<본문>"
    let title = url; let content = raw;
    const titleM = raw.match(/^Title:\s*(.+)$/m);
    if (titleM) title = titleM[1].trim();
    const mcIdx = raw.indexOf('Markdown Content:');
    if (mcIdx >= 0) content = raw.slice(mcIdx + 'Markdown Content:'.length).trim();
    if (!content || content.length < 30) { opts?.onFailure?.('empty'); return null; }
    return { title, content };
  } catch (e: any) {
    opts?.onFailure?.(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network');
    if (!opts?.quiet) console.log(`  [jina-free] 실패(${url.slice(0, 50)}): ${e.message?.slice(0, 60)}`);
    return null;
  }
}

/**
 * 최후 폴백: URL 직접 HTML fetch → 로컬 최소 readability → 러프 마크다운.
 * Jina 마저 죽었을 때만. SSRF 가드 필수 (로컬에서 임의 URL 페치하므로).
 */
export async function fetchDirectReadable(url: string, opts?: { timeoutMs?: number; allowPrivate?: boolean }): Promise<{ title: string; content: string } | null> {
  const err = await validatePublicHttpUrl(url, { action: 'fetch', allowPrivate: opts?.allowPrivate });
  if (err) { console.log(`  [readable-free] 차단: ${err}`); return null; }
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(opts?.timeoutMs ?? 15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    const html = await res.text();
    return extractReadable(html, url);
  } catch (e: any) {
    console.log(`  [readable-free] 실패: ${e.message?.slice(0, 60)}`);
    return null;
  }
}

/** dep-free 최소 readability: script/style/nav 제거 → main/article 우선 → 텍스트 러프 마크다운. */
export function extractReadable(html: string, url: string): { title: string; content: string } | null {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? stripTags(titleM[1]) : url;

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // 본문 후보: <article> 또는 <main> 우선
  const artM = body.match(/<article[\s\S]*?<\/article>/i) || body.match(/<main[\s\S]*?<\/main>/i);
  if (artM) body = artM[0];

  // 헤딩/문단을 러프 마크다운으로
  body = body
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n# ${stripTags(t)}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${stripTags(t)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${stripTags(t)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${stripTags(t)}`)
    .replace(/<\/(p|div|section|br)[^>]*>/gi, '\n');

  const text = stripTags(body).replace(/\n{3,}/g, '\n\n');
  // stripTags 가 개행을 지우므로, 위 치환 결과를 살리려면 개행 보존 버전 필요
  const content = decodeEntities(body.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const final = content.length >= 200 ? content : text;
  if (!final || final.length < 100) return null;
  return { title, content: final };
}

/**
 * 무료 스크랩 체인: Jina 마크다운 → 직접 HTML+로컬 readability.
 * scrapeFirecrawl 실패 시 호출측이 이걸 최후 폴백으로 사용.
 */
export async function scrapeFree(url: string, opts?: { allowPrivate?: boolean }): Promise<{ title: string; content: string; method: string } | null> {
  const jina = await fetchJina(url, { allowPrivate: opts?.allowPrivate });
  if (jina && jina.content.length > 100) return { ...jina, method: 'jina-free' };
  const direct = await fetchDirectReadable(url, { allowPrivate: opts?.allowPrivate });
  if (direct && direct.content.length > 100) return { ...direct, method: 'readable-free' };
  return null;
}
