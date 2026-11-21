import { expect, test } from 'bun:test';
import { socialEvidence } from './social-evidence.js';

test('Reddit search evidence is published before an X post body fetch settles', async () => {
  const controller = new AbortController();
  const redditUrl = 'https://www.reddit.com/r/stocks/comments/2027/market/';
  let redditPublished!: () => void;
  const ready = new Promise<void>(resolve => { redditPublished = resolve; });
  let postFetchStarted!: () => void;
  const postStarted = new Promise<void>(resolve => { postFetchStarted = resolve; });
  const published: string[] = [];
  const pending = socialEvidence('2027 market sentiment', 'q1', {
    signal: controller.signal,
    search: async ({ allow_domains }) => ({ hits: [{
      url: allow_domains[0] === 'reddit.com' ? redditUrl : 'https://x.com/market/post/27',
      title: 'investor view', snippet: 'cautious outlook', engine: 'grok',
    }] }),
    fetchPost: async (_url, signal) => new Promise((_resolve, reject) => {
      postFetchStarted();
      signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
    onPlatformEvidence: (evidence, platform) => {
      published.push(...evidence.map(item => item.source));
      if (platform === 'reddit') redditPublished();
    },
  });
  await Promise.all([ready, postStarted]);
  expect(published).toContain(redditUrl);
  controller.abort();
  const result = await pending;
  expect(result.evidence.map(item => item.source)).toContain(redditUrl);
});
