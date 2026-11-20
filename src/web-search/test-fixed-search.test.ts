import { expect, test } from 'bun:test';
import { buildFixedTestWebSearchProvider, TEST_FIXED_SEARCH_ENV, TEST_FIXED_SEARCH_HITS, testFixedSearchActive } from './test-fixed-search.js';

// The seam is a test boundary: it must stay off unless the switch, the fake-LLM universe and an isolated state root all hold.
test('fixed search is active only inside an isolated fake-LLM universe with the explicit switch', () => {
  const full = { [TEST_FIXED_SEARCH_ENV]: '1', ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_STATE_DIR: '/tmp/iso' };
  expect(testFixedSearchActive(full)).toBe(true);
  expect(testFixedSearchActive({})).toBe(false);
  expect(testFixedSearchActive({ ...full, [TEST_FIXED_SEARCH_ENV]: '0' })).toBe(false);
  // Refused (never honoured): a production-looking process that inherited only the switch, or the switch without isolation.
  expect(testFixedSearchActive({ [TEST_FIXED_SEARCH_ENV]: '1' })).toBe(false);
  expect(testFixedSearchActive({ ...full, ELANOUS_TEST_FAKE_LLM: undefined })).toBe(false);
  expect(testFixedSearchActive({ ...full, ELANOUS_STATE_DIR: ' ' })).toBe(false);
});

test('the fixed provider answers from fixed data whatever the query, without any network', async () => {
  const provider = buildFixedTestWebSearchProvider();
  expect(provider.available()).toBe(true);
  const first = await provider.search({ query: 'anything' });
  const second = await provider.search({ query: 'something else' });
  expect(first.hits.map((hit) => hit.url)).toEqual(TEST_FIXED_SEARCH_HITS.map((hit) => hit.url));
  expect(second.hits).toEqual(first.hits);
  expect(first.hits.every((hit) => hit.url.startsWith('http://localhost:'))).toBe(true);
});
