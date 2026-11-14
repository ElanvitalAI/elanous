import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraphPluginFromDir } from '../graph-manifest-loader.js';
import { runGraph } from '../runner.js';
import type { InProcessHandlerContext } from '../in-process-registry.js';
import {
  createUpstageEmbeddingsProvider, createUpstageEmbeddingsRegistry,
  UPSTAGE_EMBEDDING_DIMENSIONS, UPSTAGE_EMBEDDING_MODELS, type UpstageEmbeddingRequest,
} from './upstage-embeddings.js';

const pluginRoot = join(import.meta.dir, '../../../plugins/upstage-embeddings');
const context = (input: unknown): InProcessHandlerContext => ({
  graphId: 'upstage-embeddings', runId: 'embedding-sim', nodeId: 'embed', input, outputs: {},
});
const requestInput = { input: ['한국어 검색 근거', 'A source passage'], consent: true };

function response(request: UpstageEmbeddingRequest) {
  return { model: request.model, data: request.input.map((_, index) => ({
    index, embedding: Array.from({ length: UPSTAGE_EMBEDDING_DIMENSIONS }, () => index),
  })) };
}

test('selects distinct Embedding 2 query and passage models and preserves original input', async () => {
  const requests: UpstageEmbeddingRequest[] = [];
  const provider = createUpstageEmbeddingsProvider(async request => { requests.push(request); return response(request); });
  const original = structuredClone(requestInput);
  const query = await provider(context(requestInput));
  const passage = await provider(context({ ...requestInput, purpose: 'passage' }));
  expect(query).toMatchObject({ ok: true, result: { model: UPSTAGE_EMBEDDING_MODELS.query, purpose: 'query' } });
  expect(passage).toMatchObject({ ok: true, result: { model: UPSTAGE_EMBEDDING_MODELS.passage, purpose: 'passage' } });
  expect(requests.map(request => request.model)).toEqual(Object.values(UPSTAGE_EMBEDDING_MODELS));
  expect(requests[0]).toEqual({ model: UPSTAGE_EMBEDDING_MODELS.query, input: requestInput.input, encoding_format: 'float' });
  expect(requestInput).toEqual(original);
});

test('rejects legacy aliases with new-name guidance before transport or credential access', async () => {
  let calls = 0;
  const provider = createUpstageEmbeddingsProvider(async request => { calls++; return response(request); });
  for (const [alias, replacement] of [
    ['embedding-query', UPSTAGE_EMBEDDING_MODELS.query], ['embedding-passage', UPSTAGE_EMBEDDING_MODELS.passage],
  ]) {
    const result = await provider(context({ ...requestInput, model: alias }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain(replacement!);
  }
  expect(calls).toBe(0);
});

test('requires consent and valid input/model purpose before sending text', async () => {
  let calls = 0;
  const provider = createUpstageEmbeddingsProvider(async request => { calls++; return response(request); });
  for (const input of [null, {}, { ...requestInput, consent: false }, { ...requestInput, consent: undefined },
    { ...requestInput, input: [] }, { ...requestInput, input: [''] }, { ...requestInput, input: [1] },
    { ...requestInput, purpose: 'unknown' }, { ...requestInput, model: 'other' },
    { ...requestInput, apiKey: 'synthetic-key' }, { ...requestInput, baseUrl: 'http://fixture.invalid' },
    { ...requestInput, purpose: 'query', model: UPSTAGE_EMBEDDING_MODELS.passage }]) {
    expect((await provider(context(input))).ok).toBe(false);
  }
  expect(calls).toBe(0);
});

test('enforces the documented batch boundary without dispatching an oversized batch', async () => {
  let calls = 0;
  const provider = createUpstageEmbeddingsProvider(async request => { calls++; return response(request); });
  // Source: MK UPSTAGE-PLUGIN-INVENTORY.md API row 8 caps a request at 100 inputs.
  const atLimit = Array.from({ length: 100 }, () => 'fixture passage');
  expect((await provider(context({ input: atLimit, consent: true }))).ok).toBe(true);
  expect((await provider(context({ input: [...atLimit, 'overflow'], consent: true }))).ok).toBe(false);
  expect(calls).toBe(1);
});

test('restores response order using unique input indexes', async () => {
  const provider = createUpstageEmbeddingsProvider(async request => {
    const raw = response(request); raw.data.reverse(); return raw;
  });
  const result = await provider(context(requestInput));
  expect(result).toMatchObject({ ok: true, result: { dimensions: UPSTAGE_EMBEDDING_DIMENSIONS } });
  const vectors = (result.result as { embeddings: number[][] }).embeddings;
  expect(vectors.map(vector => vector.length)).toEqual([UPSTAGE_EMBEDDING_DIMENSIONS, UPSTAGE_EMBEDDING_DIMENSIONS]);
  expect(vectors.map(vector => vector[0])).toEqual([0, 1]);
});

test('rejects malformed model, count, indexes, dimensions and non-finite elements', async () => {
  const mutations: Array<(raw: ReturnType<typeof response>) => unknown> = [
    raw => ({ ...raw, model: UPSTAGE_EMBEDDING_MODELS.passage }),
    raw => ({ ...raw, data: raw.data.slice(1) }),
    raw => ({ ...raw, data: [raw.data[0], raw.data[0]] }),
    raw => ({ ...raw, data: raw.data.map(row => ({ ...row, index: -1 })) }),
    raw => ({ ...raw, data: raw.data.map(row => ({ ...row, embedding: row.embedding.slice(1) })) }),
    raw => ({ ...raw, data: raw.data.map(row => ({ ...row, embedding: row.embedding.map(() => Infinity) })) }),
    () => null,
  ];
  for (const mutate of mutations) {
    const provider = createUpstageEmbeddingsProvider(async request => mutate(response(request)));
    expect((await provider(context(requestInput))).ok).toBe(false);
  }
});

test('does not forward error bodies, credentials, or submitted text', async () => {
  const sensitive = 'synthetic-private-value';
  const provider = createUpstageEmbeddingsProvider(async () => { throw new Error(sensitive); });
  const result = await provider(context({ input: sensitive, consent: true }));
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(sensitive);
});

test('rejects credential-like text inside otherwise valid response JSON without echoing it', async () => {
  const sensitive = 'synthetic-private-value';
  const provider = createUpstageEmbeddingsProvider(async request => {
    const raw = response(request);
    return { ...raw, data: raw.data.map(row => ({ ...row, embedding: [sensitive, ...row.embedding.slice(1)] })) };
  });
  const result = await provider(context(requestInput));
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(sensitive);
});

test('an aborted request never reaches the transport', async () => {
  let calls = 0;
  const provider = createUpstageEmbeddingsProvider(async request => { calls++; return response(request); });
  const signal = AbortSignal.abort();
  expect((await provider({ ...context(requestInput), signal })).ok).toBe(false);
  expect(calls).toBe(0);
});

test('does not return successful vectors after cancellation during transport', async () => {
  const controller = new AbortController();
  const provider = createUpstageEmbeddingsProvider(async request => { controller.abort(); return response(request); });
  const result = await provider({ ...context(requestInput), signal: controller.signal });
  expect(result.ok).toBe(false);
  expect(result.result).toBeUndefined();
});

test('the declared plugin graph binds graph input to the capability and returns vectors', async () => {
  const loaded = loadGraphPluginFromDir(pluginRoot);
  expect(Object.keys(loaded.graphs)).toEqual(['upstage-embeddings']);
  const root = mkdtempSync(join(tmpdir(), 'upstage-embeddings-graph-'));
  try {
    const state = await runGraph(loaded.graphs['upstage-embeddings']!.file, {
      input: { ...requestInput, purpose: 'passage' }, quiet: true,
      deps: { root, capabilityProviders: createUpstageEmbeddingsRegistry(async request => response(request)) },
    });
    expect(state.status, JSON.stringify(state)).toBe('done');
    const rawOutput = state.nodes.find(node => node.nodeId === 'embed')!.output;
    if (typeof rawOutput !== 'string') throw new Error('Expected serialized capability output');
    const output = JSON.parse(rawOutput);
    expect(output.result).toMatchObject({ model: UPSTAGE_EMBEDDING_MODELS.passage, dimensions: UPSTAGE_EMBEDDING_DIMENSIONS });
    expect(output.result.embeddings).toHaveLength(requestInput.input.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
