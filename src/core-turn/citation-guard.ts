/** An answer may cite only URLs this turn actually fetched (tool results, research evidence), matched as exact
 * normalized URLs. URLs the user typed are shown as «user-provided», never as evidence. Anything else is removed
 * before it reaches the screen (용평 live run4 · OP79035/79069 · JUD79063). */

export const UNFETCHED_CITATION_NOTICE = (count: number): string =>
  `(검색 안 함 — 이번 턴에 실제로 가져온 출처가 아닌 링크 ${count}개를 제거했습니다.)`;
export const USER_PROVIDED_URL_MARK = ' (사용자 제공 링크 · 출처 아님)';

const URL_TOKEN = /https?:\/\/[^\s<>"'`]+/giu;
const SCHEME_PREFIXES = [...new Set(['https://', 'http://'].flatMap(scheme => [...scheme].map((_char, index) => scheme.slice(0, index + 1))))];
const TRAILING = /[.,;:!?'"」』>]+$/u;

function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '');
  // Drop an unbalanced closing paren/bracket that belongs to surrounding prose.
  while (/[)\]]$/u.test(url)) {
    const close = url.endsWith(')') ? ')' : ']';
    const open = close === ')' ? '(' : '[';
    if (url.split(close).length <= url.split(open).length) break;
    url = url.slice(0, -1);
    url = url.replace(TRAILING, '');
  }
  return url;
}

/** Exact comparison key: parsed http(s) URL without fragment (host case, default port, encoding normalized). */
export function normalizeCitationUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}

function urlsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_TOKEN)) {
    const key = normalizeCitationUrl(trimUrl(match[0]));
    if (key) found.push(key);
  }
  return found;
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  // An error anywhere in the tree (a failed sub-result, an «Error: …» string) is not provenance either.
  if (isErrorResult(value)) return;
  if (typeof value === 'string') { out.push(value); return; }
  if (!value || typeof value !== 'object' || depth > 8) return;
  for (const item of Array.isArray(value) ? value : Object.values(value)) collectStrings(item, out, depth + 1);
}

function isErrorResult(value: unknown): boolean {
  if (typeof value === 'string') return /^\s*(?:error|오류|실패|failed)\b/iu.test(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.ok === false || record.isError === true || (typeof record.error === 'string' && record.ok !== true);
}

export type CitationVerdict = 'fetched' | 'user' | 'unfetched';

export class CitationLedger {
  private readonly fetched = new Set<string>();
  private readonly userGiven = new Set<string>();

  /** URLs found anywhere in a fetched tool result or research evidence (strings, nested objects).
   *  An error result is not provenance: a URL quoted in a failure message was never fetched. */
  addFetched(value: unknown): void {
    if (isErrorResult(value)) return;
    const strings: string[] = [];
    collectStrings(value, strings);
    for (const text of strings) for (const url of urlsIn(text)) this.fetched.add(url);
  }

  addUserText(text: string | undefined): void {
    if (text) for (const url of urlsIn(text)) this.userGiven.add(url);
  }

  verdict(raw: string): CitationVerdict {
    const key = normalizeCitationUrl(raw);
    if (key && this.fetched.has(key)) return 'fetched';
    if (key && this.userGiven.has(key)) return 'user';
    return 'unfetched';
  }
}

/** 1121 FIRST-CITED-30S — distinct URLs in already-visible text that this turn actually fetched («verified
 * citations»). User-typed URLs and unfetched URLs do not count; the guard itself is unchanged. */
export function countVerifiedCitations(text: string, ledger: CitationLedger): number {
  return new Set(urlsIn(text).filter(url => ledger.verdict(url) === 'fetched')).size;
}

/** Sanitize text whose URL tokens are complete. No notice is appended; callers add it once per answer. */
export function sanitizeCitationSegment(segment: string, ledger: CitationLedger): { text: string; removed: string[] } {
  const removed: string[] = [];
  const judge = (url: string): CitationVerdict => {
    const verdict = ledger.verdict(url);
    if (verdict === 'unfetched') removed.push(url);
    return verdict;
  };
  const SKIP = '\u0000';
  // Markdown links first: keep the label when the target is unfetched; mark user-provided targets.
  let text = segment.replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/giu, (whole, label: string, url: string) => {
    const verdict = judge(url);
    if (verdict === 'unfetched') return label;
    return verdict === 'user' ? whole.replace('://', SKIP) + USER_PROVIDED_URL_MARK : whole.replace('://', SKIP);
  });
  text = text.replace(/<(https?:\/\/[^\s<>]+)>/giu, (whole, url: string) => {
    const verdict = judge(url);
    if (verdict === 'unfetched') return '';
    return verdict === 'user' ? whole.replace('://', SKIP) + USER_PROVIDED_URL_MARK : whole.replace('://', SKIP);
  });
  text = text.replace(URL_TOKEN, raw => {
    let url = trimUrl(raw);
    // Korean prose often glues a particle onto a bare URL («https://a.kr에서»): when the full token is unknown,
    // judge only its ASCII prefix so the particle stays as prose.
    const asciiEnd = url.search(/[^\x21-\x7e]/u);
    let glued = false;
    if (asciiEnd > 0 && ledger.verdict(url) === 'unfetched') { url = trimUrl(url.slice(0, asciiEnd)); glued = true; }
    const verdict = judge(url);
    const tail = raw.slice(url.length);
    if (verdict === 'unfetched') return tail;
    // A verified prefix glued to unverified text would render as one (unverified) link: split it with a space.
    const rest = glued && tail ? ` ${tail}` : tail;
    return verdict === 'user' ? url + USER_PROVIDED_URL_MARK + rest : url + rest;
  });
  return { text: text.split(SKIP).join('://'), removed };
}

/** Whole-answer sanitize: segment sanitize plus a single notice when anything was removed. */
export function sanitizeCitations(answer: string, ledger: CitationLedger): { text: string; removed: string[] } {
  const result = sanitizeCitationSegment(answer, ledger);
  if (result.removed.length === 0) return result;
  return { text: `${result.text.replace(/[ \t]+$/gmu, '').trimEnd()}\n\n${UNFETCHED_CITATION_NOTICE(result.removed.length)}`, removed: result.removed };
}

/** Streaming buffer: text is released only once every URL token in it is complete (closed by whitespace or a
 * line end) and judged, and a possible markdown link (from `[`) is held until its line ends. No unverified URL
 * is ever emitted, even briefly. The removal notice is added by the caller's whole-answer sanitize. */
export function createCitationStreamFilter(ledger: CitationLedger, emit: (delta: string, visible: string) => void) {
  let pending = '';
  let visible = '';
  let removed = 0;
  let received = false;
  const release = (segment: string): void => {
    if (!segment) return;
    const result = sanitizeCitationSegment(segment, ledger);
    removed += result.removed.length;
    if (!result.text) return;
    visible += result.text;
    emit(result.text, visible);
  };
  return {
    push(delta: string): void {
      if (delta) received = true;
      pending += delta;
      const lineEnd = pending.lastIndexOf('\n') + 1;
      const tail = pending.slice(lineEnd);
      const bracket = tail.indexOf('[');
      const lastSpace = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\t'));
      // Hold the trailing token only when it is or may become a URL; ordinary words stream immediately.
      // A URL can also start mid-token («참고:h» + «ttps://…»), so any token ending in a scheme prefix is held.
      const lastToken = tail.slice(lastSpace + 1).toLowerCase();
      const mayBeUrl = lastToken.includes('://') || SCHEME_PREFIXES.some(prefix => lastToken.endsWith(prefix));
      const tokenCut = mayBeUrl ? lastSpace + 1 : tail.length;
      const tailCut = bracket >= 0 ? Math.min(bracket, tokenCut) : tokenCut;
      const cut = lineEnd + tailCut;
      release(pending.slice(0, cut));
      pending = pending.slice(cut);
    },
    /** Release the held tail (the turn is over, so every token is complete). Returns what was shown. */
    finish(): { text: string; removed: number } {
      release(pending);
      pending = '';
      return { text: visible, removed };
    },
    visible: (): string => visible,
    received: (): boolean => received,
  };
}
