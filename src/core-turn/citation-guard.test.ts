import { expect, test } from 'bun:test';
import {
  CitationLedger,
  createCitationStreamFilter,
  sanitizeCitations,
  UNFETCHED_CITATION_NOTICE,
  USER_PROVIDED_URL_MARK,
} from './citation-guard.js';

const ledgerWith = (fetched: unknown[], userText?: string): CitationLedger => {
  const ledger = new CitationLedger();
  for (const value of fetched) ledger.addFetched(value);
  ledger.addUserText(userText);
  return ledger;
};

test('fetched URLs (nested tool results, research rows) survive unchanged and nothing is appended', () => {
  const ledger = ledgerWith([{ hits: [{ url: 'https://example.org/a?x=1' }] }, '- [complete] web · https://example.org/b · published']);
  const answer = '출처 (https://example.org/a?x=1). <https://example.org/b>';
  expect(sanitizeCitations(answer, ledger)).toEqual({ text: answer, removed: [] });
});

test('exact normalized match only: a fetched look-alike host or longer path never admits another URL', () => {
  const ledger = ledgerWith(['https://example.org.attacker.invalid/x', 'https://example.org/docs/page']);
  const result = sanitizeCitations('a https://example.org b https://example.org/docs c https://EXAMPLE.org/docs/page#top', ledger);
  expect(result.removed).toEqual(['https://example.org', 'https://example.org/docs']);
  expect(result.text).toContain('https://EXAMPLE.org/docs/page#top');
});

test('a user-typed URL with no fetch is marked as user-provided, never treated as a source', () => {
  const ledger = ledgerWith([], '이 링크 https://user.example/page 참고해서 알려줘');
  const result = sanitizeCitations('참고: https://user.example/page 그리고 [자료](https://user.example/page)', ledger);
  expect(result.removed).toEqual([]);
  expect(result.text).toBe(`참고: https://user.example/page${USER_PROVIDED_URL_MARK} 그리고 [자료](https://user.example/page)${USER_PROVIDED_URL_MARK}`);
});

test('unfetched bare, angle and markdown URLs are removed, labels and glued particles kept, notice counts them', () => {
  const result = sanitizeCitations('보기: https://made.up/x, <https://made.up/y> 그리고 [공식](https://made.up/z). https://made.up/w에서', new CitationLedger());
  expect(result.removed).toEqual(['https://made.up/z', 'https://made.up/y', 'https://made.up/x', 'https://made.up/w']);
  expect(result.text).not.toContain('made.up');
  expect(result.text).toContain('공식');
  expect(result.text).toContain('에서');
  expect(result.text.endsWith(UNFETCHED_CITATION_NOTICE(result.removed.length))).toBe(true);
});

test('percent-encoded and decoded spellings of the same fetched URL are the same normalized URL', () => {
  const ledger = ledgerWith(['https://example.org/%EC%9A%A9%ED%8F%89']);
  expect(sanitizeCitations('see https://example.org/용평 now', ledger).removed).toEqual([]);
});

test('streaming never emits an unverified URL, even split across tiny deltas or inside a markdown link', () => {
  const ledger = ledgerWith(['https://ok.example/a']);
  const shown: string[] = [];
  const stream = createCitationStreamFilter(ledger, delta => shown.push(delta));
  const answer = '근거 https://ok.example/a 와 가짜 https://fake.example/b 그리고 [링크](https://fake.example/c) 끝';
  for (const char of answer) stream.push(char);
  const visible = stream.finish().text;
  for (let index = 1; index <= shown.length; index += 1) expect(shown.slice(0, index).join('')).not.toContain('fake.example');
  expect(visible).toContain('https://ok.example/a');
  expect(visible).toContain('링크');
  expect(stream.finish().removed).toBe(2);
});

test('plain words stream at once; only a token that may become a URL (even mid-token) is held', () => {
  const shown: string[] = [];
  const plain = createCitationStreamFilter(new CitationLedger(), delta => shown.push(delta));
  plain.push('first answer');
  expect(shown.join('')).toBe('first answer');
  const split: string[] = [];
  const midToken = createCitationStreamFilter(new CitationLedger(), delta => split.push(delta));
  midToken.push('참고:h');
  expect(split.join('')).toBe('');
  midToken.push('ttps://fake.example/x 끝');
  expect(split.join('')).not.toContain('fake.example');
  expect(midToken.finish().text).toBe('참고: 끝');
});

test('a URL quoted in an error result is not provenance', () => {
  const ledger = ledgerWith([{ error: 'fetch failed for https://err.example/page' }, 'Error: could not open https://err.example/two', { ok: false, url: 'https://err.example/three' }]);
  const result = sanitizeCitations('see https://err.example/page and https://err.example/two and https://err.example/three', ledger);
  expect(result.removed).toEqual(['https://err.example/page', 'https://err.example/two', 'https://err.example/three']);
});

test('a verified URL glued to unverified text is split so the unverified tail cannot render as part of the link', () => {
  const ledger = ledgerWith(['https://ok.example/a']);
  const result = sanitizeCitations('근거 https://ok.example/a용평리조트 참고', ledger);
  expect(result.removed).toEqual([]);
  expect(result.text).toBe('근거 https://ok.example/a 용평리조트 참고');
});

test('a URL inside a nested error sub-result is not provenance, while a sibling success still is', () => {
  const ledger = ledgerWith([{
    results: [
      { ok: true, url: 'https://ok.example/kept' },
      { ok: false, url: 'https://err.example/nested' },
      { detail: { error: 'timeout fetching https://err.example/deep' } },
      ['Error: blocked https://err.example/array'],
    ],
  }]);
  const result = sanitizeCitations('a https://ok.example/kept b https://err.example/nested c https://err.example/deep d https://err.example/array', ledger);
  expect(result.removed).toEqual(['https://err.example/nested', 'https://err.example/deep', 'https://err.example/array']);
  expect(result.text).toContain('https://ok.example/kept');
});
