// PLAN §4.4 · Phase 1.4 — Research bridge barrel.

export type {
  ExternalResearchResult,
  InvokeResearchOpts,
} from './types.js';

export {
  invokeResearch,
  invokeResearchAxes,
  setResearchInvoker,
  type ResearchInvoker,
  type ResearchInvocationOutcome,
} from './invoke.js';

export {
  recordResult,
  getRecentResults,
  clearResults,
  setResearchArchiveDir,
  getResearchArchiveDir,
} from './store.js';

export {
  formatResearchPrefill,
  formatResearchSummary,
} from './format.js';

export {
  CRAWL_CONTRACTS, CRAWL_PROVIDERS, matchingCrawlProviders, executeCrawlCapability,
  type CrawlContract, type CrawlContext, type CrawlProvider,
} from './crawl.js';
