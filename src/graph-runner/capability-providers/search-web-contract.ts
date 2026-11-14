import type { GraphCapabilityContract } from '../capabilities.js';

/** Shared shape for Exa, Grok, and Firecrawl graph search providers. */
export const SEARCH_WEB_CONTRACT: GraphCapabilityContract = Object.freeze({
  id: 'search.web@1',
  input: { type: 'object', required: ['query'], properties: {
    query: { type: 'string' }, limit: { type: 'integer' },
  } },
  output: { type: 'object', required: ['provider', 'results'], properties: {
    provider: { type: 'string' },
    results: { type: 'array', items: { type: 'object', required: ['title', 'url', 'snippet'], properties: {
      title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' },
      publishedAt: { type: 'string' },
    } } },
  } },
});
