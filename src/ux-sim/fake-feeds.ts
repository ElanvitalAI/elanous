import { executeCrawlCapability, type CrawlContract, type CrawlProvider, type CrawlTier } from '../crawl-capabilities/contracts.js';
import { createFakeCred } from './fake-cred.js';

export interface FakeFeedSource {
  readonly id: string;
  readonly url: string;
  readonly interests: readonly string[];
  readonly requires: CrawlContract;
  readonly reason: string;
  readonly keyEnv?: string;
  readonly keySlot?: string;
}
export interface FakeFeedPost { readonly id: string; readonly url: string; readonly title: string; readonly text: string }
export type FakeFeedStatus = 'up' | 'down' | 'slow' | 'vanished';
export interface FakeFeedBrief {
  readonly ledgerId: string;
  readonly at: number;
  readonly items: readonly FakeFeedPost[];
  readonly summaryStyle: 'standard' | 'short';
  readonly collectors: readonly { sourceId: string; url: string; requires: CrawlContract; provider: string; tier: CrawlTier }[];
  readonly skipped: readonly { sourceId: string; reason: 'key-missing' | Exclude<FakeFeedStatus, 'up'> | 'unavailable'; failures: number }[];
  readonly duplicateCount: number;
  readonly ownerCards: readonly { sourceId: string; action: 'disable-and-recommend' }[];
  readonly upgradeHint: string | null;
}

interface SourceState { source: FakeFeedSource; status: FakeFeedStatus; posts: FakeFeedPost[]; failures: number }
interface Approval { agent: 'absorb'; trigger: 'periodic'; sourceIds: string[]; timeZone: string; at: string; ledgerId: string }
interface ChangeProposal { id: string; kind: 'try-change'; status: 'pending' | 'applied'; reason: string; summaryStyle: 'short' }

function copyBrief(brief: FakeFeedBrief): FakeFeedBrief {
  return { ...brief, items: brief.items.map((item) => ({ ...item })),
    collectors: brief.collectors.map((collector) => ({ ...collector })),
    skipped: brief.skipped.map((entry) => ({ ...entry })),
    ownerCards: brief.ownerCards.map((card) => ({ ...card })) };
}

/** In-memory feed responses. The only collection path is the existing crawl capability contract. */
export function createFakeFeeds(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const sources = new Map<string, SourceState>();
  const credentials = createFakeCred({ now });
  const seenUrls = new Set<string>();
  const steps: string[] = [];
  const briefs: FakeFeedBrief[] = [];
  const feedbackRows: Array<{ rating: 'good' | 'bad'; reason: string }> = [];
  const proposals: ChangeProposal[] = [];
  let interests: string[] = [];
  let recommended = false;
  let recommendedSourceIds = new Set<string>();
  let approval: Approval | null = null;
  let summaryStyle: 'standard' | 'short' = 'standard';
  const step = (name: string) => { if (!steps.includes(name)) steps.push(name); };
  const state = (id: string) => {
    const found = sources.get(id);
    if (!found) throw new Error(`unknown fake feed source: ${id}`);
    return found;
  };
  const providerFor = (entry: SourceState): CrawlProvider => {
    const requiredKey = entry.source.keyEnv;
    const requiredSlot = entry.source.keySlot;
    return {
      id: `fake-feed:${entry.source.id}`,
      provides: [entry.source.requires],
      tier: requiredKey ? 'byok' : 'free',
      latency: 1, // Source: 내부 문서 `app-agents-and-loops` §5a; fixed in-memory response, no wall-clock wait.
      keyEnv: requiredKey ? [requiredKey] : [],
      available: () => {
        if (!requiredKey) return true;
        if (!requiredSlot) return false;
        const slot = credentials.inspect(requiredSlot);
        return slot.present && credentials.use({ slot: requiredSlot, generation: slot.generation }, 'crawl').ok;
      },
      run: async (query) => ({
        engine: `fake-feed:${entry.source.id}`, query,
        items: entry.posts.map((post) => ({ engine: `fake-feed:${entry.source.id}`, query, url: post.url,
          text: post.text, metadata: { title: post.title, fakeFeedId: post.id } })),
        totalItems: entry.posts.length,
        rawText: 'fixed feed polled',
      }),
    };
  };
  return {
    registerSource(source: FakeFeedSource): void {
      if (!source.id.trim() || !source.url.trim() || !source.reason.trim() || !source.interests.length)
        throw new Error('fake feed source requires id, url, reason and interests');
      if (Boolean(source.keyEnv) !== Boolean(source.keySlot)) throw new Error('keyed fake feed source needs keyEnv and keySlot');
      if (source.keySlot) credentials.inspect(source.keySlot);
      if (sources.has(source.id)) throw new Error(`duplicate fake feed source: ${source.id}`);
      sources.set(source.id, { source: { ...source, interests: [...source.interests] }, status: 'up', posts: [], failures: 0 });
    },
    chooseInterests(chips: readonly string[], freeText: string): string[] {
      const chosen = [...new Set([...chips, freeText].map((item) => item.trim()).filter(Boolean))];
      if (!chosen.length) throw new Error('at least one interest is required');
      interests = chosen;
      recommended = false;
      recommendedSourceIds = new Set();
      step('interests');
      return [...interests];
    },
    recommendSources(): Array<{ id: string; url: string; requires: CrawlContract; reason: string; upgrade: string | null }> {
      if (!interests.length) throw new Error('choose interests before recommending sources');
      const matches = [...sources.values()].filter(({ source }) => source.interests.some((interest) => interests.includes(interest)));
      recommendedSourceIds = new Set(matches.map(({ source }) => source.id));
      recommended = true;
      step('recommendations');
      return matches.map(({ source }) => ({ id: source.id, url: source.url, requires: source.requires, reason: source.reason,
          upgrade: source.keySlot && !credentials.inspect(source.keySlot).present ? `키를 넣으면 ${source.keySlot} 수집을 사용할 수 있습니다` : null }));
    },
    approve(sourceIds: readonly string[], schedule: { timeZone: string; at: string }): Approval {
      if (!recommended) throw new Error('recommend sources before approval');
      if (!sourceIds.length || !schedule.timeZone.trim() || !schedule.at.trim()) throw new Error('approval needs sources and schedule');
      if (sourceIds.some((id) => !recommendedSourceIds.has(id)) || new Set(sourceIds).size !== sourceIds.length) throw new Error('approval contains unreviewed or duplicate source');
      approval = { agent: 'absorb', trigger: 'periodic', sourceIds: [...sourceIds], timeZone: schedule.timeZone,
        at: schedule.at, ledgerId: 'fake-feeds:absorb' };
      step('approval');
      return { ...approval, sourceIds: [...approval.sourceIds] };
    },
    inject(sourceId: string, post: FakeFeedPost): void { state(sourceId).posts.push({ ...post }); },
    setStatus(sourceId: string, status: FakeFeedStatus): void { state(sourceId).status = status; },
    installKey(slot: string): void {
      credentials.install(slot, { permissions: ['crawl'], expiresAt: Number.MAX_SAFE_INTEGER }); // Slot presence only; no secret value enters the world or receipt.
    },
    async brief(): Promise<FakeFeedBrief> {
      if (!approval) throw new Error('approve a loop before briefing');
      const items: FakeFeedPost[] = [];
      const collectors: Array<{ sourceId: string; url: string; requires: CrawlContract; provider: string; tier: CrawlTier }> = [];
      const skipped: Array<{ sourceId: string; reason: 'key-missing' | Exclude<FakeFeedStatus, 'up'> | 'unavailable'; failures: number }> = [];
      const ownerCards: Array<{ sourceId: string; action: 'disable-and-recommend' }> = [];
      let duplicateCount = 0;
      for (const sourceId of approval.sourceIds) {
        const entry = state(sourceId);
        const provider = providerFor(entry);
        if (!provider.available()) { skipped.push({ sourceId, reason: 'key-missing', failures: entry.failures }); continue; }
        if (entry.status !== 'up') {
          entry.failures += 1;
          skipped.push({ sourceId, reason: entry.status, failures: entry.failures });
        } else {
          try {
            const collected = await executeCrawlCapability(entry.source.requires, entry.source.url, {}, [provider]);
            collectors.push({ sourceId, url: entry.source.url, requires: entry.source.requires,
              provider: collected.provider.id, tier: collected.provider.tier });
            entry.failures = 0;
            for (const result of collected.result.items) {
              const post = entry.posts.find((candidate) => candidate.url === result.url);
              if (!post) continue;
              if (seenUrls.has(post.url)) { duplicateCount += 1; continue; }
              seenUrls.add(post.url);
              items.push({ ...post, text: summaryStyle === 'short' ? post.text.slice(0, 40) : post.text }); // Source: 내부 문서 `app-agents-and-loops` §5a; fixed short-summary display limit for approved try-change.
            }
          } catch {
            entry.failures += 1;
            skipped.push({ sourceId, reason: 'unavailable', failures: entry.failures });
          }
        }
        if (entry.failures >= 2) ownerCards.push({ sourceId, action: 'disable-and-recommend' }); // Source: 내부 문서 `app-agents-and-loops` §5a; two failed polls require an owner card.
      }
      const hasFreeCollection = collectors.some((item) => item.tier === 'free');
      const hasMissingKey = skipped.some((item) => item.reason === 'key-missing');
      const brief: FakeFeedBrief = { ledgerId: approval.ledgerId, at: now(), items, summaryStyle, collectors, skipped,
        duplicateCount, ownerCards, upgradeHint: hasFreeCollection && hasMissingKey ? '무료 수집 — 키를 넣으면 더 넓게' : null };
      briefs.push(copyBrief(brief));
      step('briefing');
      return copyBrief(brief);
    },
    feedback(rating: 'good' | 'bad', reason: string): ChangeProposal | null {
      if (!briefs.length) throw new Error('brief before feedback');
      feedbackRows.push({ rating, reason });
      step('feedback');
      if (rating === 'good') return null;
      const proposal: ChangeProposal = { id: `try-change:${proposals.length + 1}`, kind: 'try-change', status: 'pending', reason,
        summaryStyle: 'short' };
      proposals.push(proposal);
      return { ...proposal };
    },
    applyProposal(id: string): ChangeProposal {
      const proposal = proposals.find((candidate) => candidate.id === id);
      if (!proposal || proposal.status !== 'pending') throw new Error('unknown or already applied change proposal');
      proposal.status = 'applied';
      summaryStyle = proposal.summaryStyle;
      return { ...proposal };
    },
    receipt() {
      return { steps: [...steps], interests: [...interests], approval: approval ? { ...approval, sourceIds: [...approval.sourceIds] } : null,
        briefs: briefs.map(copyBrief), feedback: feedbackRows.map((row) => ({ ...row })), proposals: proposals.map((proposal) => ({ ...proposal })), summaryStyle,
        collectionMode: 'in-memory' as const };
    },
  };
}
