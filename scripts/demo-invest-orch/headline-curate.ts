// DEMO-FIXTURE-HEADLINE-CURATE (11-25 demo check S7): the event list is read out on stage. A live crawl once put a
// tabloid-style headline (futurism.com) on screen. Keep news and market sources; drop social, video, opinion-blog and
// tabloid hosts, and any headline that reads as gossip rather than a market event.

/** Hosts whose items are never shown as a stage headline (social, video, opinion blogs, tabloid tech commentary). */
export const STAGE_BLOCKED_HOSTS: readonly string[] = [
  'futurism.com', 'reddit.com', 'youtube.com', 'youtu.be', 'instagram.com', 'x.com', 'twitter.com',
  'tiktok.com', 'facebook.com', 'substack.com', 'blog.naver.com', 'medium.com',
];

/** Wording that marks a headline as gossip or insult rather than a market event. */
const GOSSIP = /\b(sleep(?:ing)? with|subordinates?|affair|disgraced|scandal|sex(?:ual)?|mistress|lawsuit over)\b/iu;

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./u, ''); } catch { return null; }
}

/** True when the item may be shown on stage: a parseable http(s) URL from a non-blocked host, and a neutral title. */
export function isStageSafeHeadline(item: { readonly title: string; readonly url: string }): boolean {
  const host = hostOf(item.url);
  if (!host) return false;
  if (STAGE_BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return false;
  return !GOSSIP.test(item.title);
}

export function curateStageHeadlines<T extends { readonly title: string; readonly url: string }>(items: readonly T[]): T[] {
  return items.filter(isStageSafeHeadline);
}

/** Names a headline must carry to count as «about» the chosen stock (demo P0 11-25: the Samsung card showed Nvidia headlines). */
const TICKER_NAMES: Readonly<Record<string, readonly string[]>> = {
  '005930': ['samsung', '삼성전자', '삼전'],
  '000660': ['sk hynix', 'sk하이닉스', '하이닉스', '닉스'],
};

/** Headlines about the chosen stock first (news before the market-wide event shock), then the rest; deduped by url. */
export function tickerHeadlines<T extends { readonly title: string; readonly url: string }>(ticker: string, groups: readonly (readonly T[])[]): T[] {
  const names = TICKER_NAMES[ticker.split('.')[0] ?? ''] ?? [];
  const all = groups.flat().filter((i, n, a) => i.url && a.findIndex((j) => j.url === i.url) === n);
  const about = (i: T) => names.some((name) => i.title.toLowerCase().includes(name));
  return [...all.filter(about), ...all.filter((i) => !about(i))];
}
