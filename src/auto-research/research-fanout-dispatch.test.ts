import { expect, test } from 'bun:test';
import { createResearchSubagent, runResearchFanout, RESEARCH_FANOUT_DETACHED_REASON, type ResearchSubagentDeps } from './research-fanout.js';
import { withAmbientSessionScope } from '../debug/log.js';

type Args = Record<string, unknown>;
type Opts = {
  awaitResult?: boolean; parentSessionId?: string; signal?: AbortSignal;
  dispatchTool?: (name: string, args: Args) => Promise<unknown>;
};

let mode: 'real-seam' | 'always-detach' = 'real-seam';
const seen: Opts[] = [];
const FOREGROUND_RUN_MS = 40;
const FAKE_SYNC_CAP_MS = 10;
const receipt = { output: '(running in background — taskId=t-fake)', agent: 'general-purpose', cid: 'c', taskId: 't-fake', background: true };

// Behaves like the real dispatch seam: background by default (#38772), and a
// foreground run longer than the sync cap detaches with the same receipt.
async function fakeDispatchAgent(args: Args, opts: Opts) {
  seen.push(opts);
  if (mode === 'always-detach') return receipt;
  if (opts.awaitResult !== true && args.run_in_background !== false) return receipt;
  const search = (async () => {
    await new Promise((r) => setTimeout(r, FOREGROUND_RUN_MS));
    await opts.dispatchTool?.('OmniSearch', { query: 'q' });
    return { ...receipt, background: undefined, taskId: 't-real', output: '[A](https://a.example/x) and [B](https://b.example/y)' };
  })();
  if (opts.awaitResult === true) return search;
  return Promise.race([search, new Promise<typeof receipt>((r) => setTimeout(() => r(receipt), FAKE_SYNC_CAP_MS))]);
}

const runResearchSubagent = createResearchSubagent({
  dispatchAgent: fakeDispatchAgent as unknown as ResearchSubagentDeps['dispatchAgent'],
  buildOmniSearchTool: (() => ({ name: 'OmniSearch', description: 'x', inputSchema: { type: 'object', properties: {} } })) as unknown as ResearchSubagentDeps['buildOmniSearchTool'],
  dispatchResearchOmniSearch: (async (_args: Args, o: { onSource?: (s: { url: string; title: string; snippet: string }) => void }) => {
    o.onSource?.({ url: 'https://a.example/x', title: 'A', snippet: 'a' });
    o.onSource?.({ url: 'https://b.example/y', title: 'B', snippet: 'b' });
    return { output: 'ok' };
  }) as unknown as ResearchSubagentDeps['dispatchResearchOmniSearch'],
});

test('with the real background default every angle still gets its own answer and sources', async () => {
  mode = 'real-seam';
  seen.length = 0;
  const result = await runResearchFanout('q', runResearchSubagent, { runId: 'r-await' });
  expect(result.angles.map(({ status }) => status)).toEqual(['complete', 'complete', 'complete']);
  expect(result.angles[0]?.sources.map(({ url }) => url)).toEqual(['https://a.example/x', 'https://b.example/y']);
  expect(seen.every((o) => o.awaitResult === true)).toBe(true);
});

test('workers are scoped to the owning session instead of orphaned', async () => {
  mode = 'real-seam';
  seen.length = 0;
  await withAmbientSessionScope('sess-owner', () => runResearchFanout('q', runResearchSubagent, { runId: 'r-sess' }));
  expect(seen.map((o) => o.parentSessionId)).toEqual(['sess-owner', 'sess-owner', 'sess-owner']);
});

test('a background receipt is a structured failure, never answer text', async () => {
  mode = 'always-detach';
  const result = await runResearchFanout('q', runResearchSubagent, { runId: 'r-detach' });
  expect(result.angles.map(({ status }) => status)).toEqual(['failed', 'failed', 'failed']);
  expect(result.angles.map(({ error }) => error)).toEqual(Array(3).fill(RESEARCH_FANOUT_DETACHED_REASON));
  expect(result.angles.every(({ text }) => text === '')).toBe(true);
});
