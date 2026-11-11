import { expect, spyOn, test } from 'bun:test';
import { createFakeFeeds } from './fake-feeds.js';
import { assembleWorld, parseSimWorld } from './world.js';

test('fake feeds complete interest → recommendation → approval → briefing → feedback with key transition', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('real network forbidden'); }) as unknown as typeof globalThis.fetch);
  try {
    const feeds = createFakeFeeds({ now: () => 1_000 }); // Source: 내부 문서 `app-agents-and-loops` §5a; fixed simulation clock.
    feeds.registerSource({ id: 'rss', url: 'https://news.example/rss', interests: ['AI'], requires: 'search.news@1', reason: 'AI articles are cited often' });
    feeds.registerSource({ id: 'deep', url: 'https://blog.example', interests: ['AI'], requires: 'crawl.site@1', keyEnv: 'FIRECRAWL_API_KEY', keySlot: 'cred:firecrawl', reason: 'Long-form AI posts' });
    expect(feeds.chooseInterests(['AI'], 'robotics')).toEqual(['AI', 'robotics']);
    const recommended = feeds.recommendSources();
    expect(recommended.map((source) => source.id)).toEqual(['rss', 'deep']);
    expect(recommended.find((source) => source.id === 'rss')).toMatchObject({ url: 'https://news.example/rss', requires: 'search.news@1' });
    expect(recommended.find((source) => source.id === 'deep')?.upgrade).toContain('cred:firecrawl');
    const approved = feeds.approve(['rss', 'deep'], { timeZone: 'Asia/Seoul', at: '08:00' });
    expect(approved).toMatchObject({ agent: 'absorb', trigger: 'periodic', sourceIds: ['rss', 'deep'] });

    const longText = 'Release notes explain the full change and include enough detail to compare an approved short summary.';
    feeds.inject('rss', { id: 'a', url: 'https://news.example/a', title: 'AI release', text: longText });
    feeds.inject('rss', { id: 'a-copy', url: 'https://news.example/a', title: 'AI release', text: 'Release notes' });
    feeds.inject('deep', { id: 'b', url: 'https://blog.example/b', title: 'AI analysis', text: 'Analysis' });
    const free = await feeds.brief();
    expect(free.items.map((item) => item.url)).toEqual(['https://news.example/a']);
    expect(free.items[0]?.text).toBe(longText);
    expect(free.summaryStyle).toBe('standard');
    expect(free.duplicateCount).toBe(1); // Source: 내부 문서 `app-agents-and-loops` §5a; one repeated URL in the fixed feed.
    expect(free.collectors).toEqual([{ sourceId: 'rss', url: recommended[0]?.url, requires: recommended[0]?.requires,
      provider: 'fake-feed:rss', tier: 'free' }]);
    expect(free.skipped).toContainEqual({ sourceId: 'deep', reason: 'key-missing', failures: 0 }); // Source: 내부 문서 `app-agents-and-loops` §5a; no fetch was attempted for the optional slot.
    expect(free.upgradeHint).toContain('무료 수집');

    feeds.installKey('cred:firecrawl');
    const keyed = await feeds.brief();
    expect(keyed.items.map((item) => item.url)).toEqual(['https://blog.example/b']);
    expect(keyed.collectors).toEqual([
      { sourceId: 'rss', url: recommended[0]?.url, requires: recommended[0]?.requires, provider: 'fake-feed:rss', tier: 'free' },
      { sourceId: 'deep', url: recommended[1]?.url, requires: recommended[1]?.requires, provider: 'fake-feed:deep', tier: 'byok' },
    ]);
    expect(keyed.upgradeHint).toBeNull();
    expect(keyed.ledgerId).toBe(free.ledgerId);

    const proposal = feeds.feedback('bad', 'too broad');
    expect(proposal).toMatchObject({ kind: 'try-change', status: 'pending', reason: 'too broad' });
    expect(feeds.receipt().summaryStyle).toBe('standard');
    expect(feeds.applyProposal(proposal!.id)).toMatchObject({ status: 'applied', summaryStyle: 'short' });
    expect(feeds.receipt().summaryStyle).toBe('short');
    feeds.inject('rss', { id: 'c', url: 'https://news.example/c', title: 'Another release', text: longText });
    const changed = await feeds.brief();
    expect(changed.items[0]?.text).toBe(longText.slice(0, 40)); // Source: 내부 문서 `app-agents-and-loops` §5a; approved short summary applies to the next briefing.
    expect(changed.summaryStyle).toBe('short');
    expect(feeds.receipt().steps).toEqual(['interests', 'recommendations', 'approval', 'briefing', 'feedback']);
    expect(feeds.receipt().collectionMode).toBe('in-memory');
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

test('down, slow and vanished sources fail without blocking a healthy briefing; repeated failure raises owner card', async () => {
  const feeds = createFakeFeeds({ now: () => 2_000 }); // Source: 내부 문서 `app-agents-and-loops` §5a; deterministic failure round.
  for (const id of ['healthy', 'down', 'slow', 'gone']) {
    feeds.registerSource({ id, url: `https://${id}.example`, interests: ['AI'], requires: 'search.news@1', reason: `${id} source` });
  }
  feeds.chooseInterests(['AI'], '');
  feeds.recommendSources();
  feeds.approve(['healthy', 'down', 'slow', 'gone'], { timeZone: 'UTC', at: '09:00' });
  feeds.inject('healthy', { id: 'good', url: 'https://healthy.example/good', title: 'Good', text: 'Good news' });
  feeds.setStatus('down', 'down');
  feeds.setStatus('slow', 'slow');
  feeds.setStatus('gone', 'vanished');
  const first = await feeds.brief();
  expect(first.items.map((item) => item.id)).toEqual(['good']);
  expect(first.skipped.map((item) => item.reason)).toEqual(['down', 'slow', 'vanished']);
  expect(first.upgradeHint).toBeNull();
  const second = await feeds.brief();
  expect(second.items).toEqual([]);
  expect(second.ownerCards.map((card) => card.sourceId)).toEqual(['down', 'slow', 'gone']);
  expect(second.skipped.every((item) => item.failures === 2)).toBe(true); // Source: 내부 문서 `app-agents-and-loops` §5a; owner card after two failures.
  expect(feeds.receipt().collectionMode).toBe('in-memory');
});

test('approval is limited to the exact recommendation snapshot and interests changes require a new recommendation', () => {
  const feeds = createFakeFeeds();
  feeds.registerSource({ id: 'shown', url: 'https://shown.example', interests: ['AI'], requires: 'search.news@1', reason: 'shown source' });
  feeds.chooseInterests(['AI'], '');
  expect(feeds.recommendSources().map((source) => source.id)).toEqual(['shown']);
  expect(() => feeds.chooseInterests([], '')).toThrow('at least one interest');
  expect(feeds.receipt().interests).toEqual(['AI']);
  expect(feeds.approve(['shown'], { timeZone: 'UTC', at: '09:00' }).sourceIds).toEqual(['shown']);
  feeds.registerSource({ id: 'late', url: 'https://late.example', interests: ['AI'], requires: 'search.news@1', reason: 'late source' });
  expect(() => feeds.approve(['late'], { timeZone: 'UTC', at: '09:00' })).toThrow('unreviewed');
  feeds.chooseInterests(['AI'], 'robotics');
  expect(() => feeds.approve(['shown'], { timeZone: 'UTC', at: '09:00' })).toThrow('recommend sources');
  expect(feeds.recommendSources().map((source) => source.id)).toEqual(['shown', 'late']);
  expect(feeds.approve(['late'], { timeZone: 'UTC', at: '09:00' }).sourceIds).toEqual(['late']);
});

test('registered sources and returned briefings cannot mutate approved collection or saved receipts', async () => {
  const feeds = createFakeFeeds({ now: () => 4_000 }); // Source: 내부 문서 `app-agents-and-loops` §5a; fixed receipt clock.
  const source = { id: 'safe', url: 'https://safe.example/feed', interests: ['AI'], requires: 'search.news@1' as const, reason: 'shown feed' };
  const post = { id: 'safe-post', url: 'https://safe.example/post', title: 'Original title', text: 'Original text' };
  feeds.registerSource(source);
  feeds.chooseInterests(['AI'], '');
  const displayed = feeds.recommendSources();
  expect(displayed).toMatchObject([{ id: 'safe', url: 'https://safe.example/feed', requires: 'search.news@1' }]);
  Object.assign(source, { url: 'https://unshown.example/feed', requires: 'crawl.site@1', keyEnv: 'FIRECRAWL_API_KEY', keySlot: 'cred:firecrawl' });
  source.interests.push('unshown');
  feeds.approve(['safe'], { timeZone: 'UTC', at: '09:00' });
  feeds.inject('safe', post);
  Object.assign(post, { title: 'Altered after injection' });
  const returned = await feeds.brief();
  expect(returned.collectors).toEqual([{ sourceId: 'safe', url: displayed[0]?.url, requires: displayed[0]?.requires,
    provider: 'fake-feed:safe', tier: 'free' }]);
  expect(returned.items[0]?.title).toBe('Original title');
  Object.assign(returned.items[0]!, { title: 'Tampered returned item' });
  Object.assign(returned.collectors[0]!, { provider: 'tampered' });
  const firstReceipt = feeds.receipt();
  expect(firstReceipt.briefs[0]?.items[0]?.title).toBe('Original title');
  expect(firstReceipt.briefs[0]?.collectors[0]?.provider).toBe('fake-feed:safe');
  Object.assign(firstReceipt.briefs[0]?.items[0]!, { title: 'Tampered receipt item' });
  expect(feeds.receipt().briefs[0]?.items[0]?.title).toBe('Original title');
});

test('X posts and YouTube pages use the declared crawl contracts with fixed responses', async () => {
  const feeds = createFakeFeeds({ now: () => 3_000 }); // Source: 내부 문서 `app-agents-and-loops` §5a; fixed social and video response round.
  feeds.registerSource({ id: 'x', url: 'https://x.example/account', interests: ['AI'], requires: 'social.posts@1', reason: 'recent AI discussion' });
  feeds.registerSource({ id: 'youtube', url: 'https://youtube.example/channel', interests: ['AI'], requires: 'scrape.url@1', reason: 'AI talks' });
  feeds.chooseInterests(['AI'], '');
  expect(feeds.recommendSources().map((source) => source.id)).toEqual(['x', 'youtube']);
  feeds.approve(['x', 'youtube'], { timeZone: 'UTC', at: '10:00' });
  feeds.inject('x', { id: 'x-post', url: 'https://x.example/post', title: 'AI thread', text: 'Thread text' });
  feeds.inject('youtube', { id: 'video', url: 'https://youtube.example/watch', title: 'AI talk', text: 'Transcript' });
  const brief = await feeds.brief();
  expect(brief.items.map((item) => item.id)).toEqual(['x-post', 'video']);
  expect(brief.collectors.map((collector) => collector.provider)).toEqual(['fake-feed:x', 'fake-feed:youtube']);
  expect(brief.skipped).toEqual([]);
});

test('world assembles a fresh fake-feeds device for each isolated world', () => {
  const spec = parseSimWorld('world: fake-feeds-world\nseed: 0\ndevices: [fake-feeds]\nevents: []\n');
  const first = assembleWorld({ spec }).devices.get('fake-feeds') as ReturnType<typeof createFakeFeeds>;
  const second = assembleWorld({ spec }).devices.get('fake-feeds') as ReturnType<typeof createFakeFeeds>;
  first.registerSource({ id: 'rss', url: 'https://news.example/rss', interests: ['AI'], requires: 'search.news@1', reason: 'recent citations' });
  expect(first.chooseInterests(['AI'], '')).toEqual(['AI']);
  expect(first.recommendSources()).toHaveLength(1); // Source: 내부 문서 `app-agents-and-loops` §5a; one fixed source in the first world.
  expect(second.chooseInterests(['AI'], '')).toEqual(['AI']);
  expect(second.recommendSources()).toEqual([]);
});
