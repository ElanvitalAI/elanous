import { expect, test } from 'bun:test';
import { startFakeUpstageServer } from '../../../test/fixtures/fake-upstage-server.js';
import { dispatchGraphContract } from '../capabilities.js';
import type { InProcessHandlerContext } from '../in-process-registry.js';
import { createUpstageInformationExtractRegistry, type UpstageInformationExtractOptions } from './upstage-information-extract.js';

const documentDataUrl = 'data:application/pdf;base64,JVBERi0xLjQ=';
const schema = { type: 'object', properties: { reference: { type: 'string' } },
  required: ['reference'], additionalProperties: false };
const input = { documentDataUrl, schemaName: 'notice_fields', schema, consentToUpstage: true };
const context = (value: unknown, signal?: AbortSignal): InProcessHandlerContext => ({ graphId: 'upstage-information-extract',
  runId: 'fake-run', nodeId: 'extract', input: value, outputs: {}, signal });
const contract = 'document.information-extract@1';
const fakeKey = 'fake-upstage-key';
const registry = (options: UpstageInformationExtractOptions = {}) => createUpstageInformationExtractRegistry({
  lookupSecret: async (id) => { expect(id).toBe('cred:upstage.api_key'); return fakeKey; }, ...options,
});
const failed = async (options: UpstageInformationExtractOptions, reason: string, value: unknown = input,
  signal?: AbortSignal) => expect(await dispatchGraphContract(contract, context(value, signal), registry(options)))
  .toMatchObject({ ok: false, outcome: 'failed', error: 'contract-exhausted',
    evidence: { attempts: [{ reason }] } });
const fakeResponse = (content: string) => Response.json({ choices: [{ message: { role: 'assistant', content } }] });

test('P3 uses U-0 shared fake server and sole credential slot for chat-shaped schema extraction', async () => {
  const fake = await startFakeUpstageServer();
  try {
    const result = await dispatchGraphContract(contract, context(input), registry({
      testEndpoint: `${fake.baseUrl}/information-extraction`,
    }));
    expect(result).toEqual({ ok: true, outcome: 'ok', result: { reference: 'SYNTHETIC-1' },
      evidence: { source: 'upstage-information-extract' } });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.path).toBe('/v1/information-extraction');
    expect(fake.requests[0]?.authorized).toBe(true);
    const request = JSON.parse(fake.requests[0]!.body) as Record<string, any>;
    expect(request.model).toBe('information-extract');
    expect(request.messages).toEqual([{ role: 'user', content: [{ type: 'image_url', image_url: { url: documentDataUrl } }] }]);
    expect(request.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'notice_fields', schema } });
    expect(registry().providers[0]?.secretRefs).toEqual(['cred:upstage.api_key']);
  } finally { await fake.close(); }
});

test('P3 refuses valid JSON that echoes the looked-up credential in result or evidence', async () => {
  for (const value of [`before-${fakeKey}-after`, fakeKey]) {
    const result = await dispatchGraphContract(contract, context(input), registry({ fetcher: async () =>
      fakeResponse(JSON.stringify({ reference: value })) }));
    expect(result).toMatchObject({ ok: false, error: 'contract-exhausted',
      evidence: { attempts: [{ reason: 'secret_echo_refused' }] } });
    expect(JSON.stringify(result)).not.toContain(fakeKey);
  }
  const thrown = await dispatchGraphContract(contract, context(input), registry({ fetcher: async () =>
    { throw new Error(fakeKey); } }));
  expect(JSON.stringify(thrown)).not.toContain(fakeKey);
  const named = await dispatchGraphContract(contract, context({ ...input,
    schema: { ...schema, additionalProperties: true } }), registry({ fetcher: async () =>
    fakeResponse(JSON.stringify({ reference: 'safe', [fakeKey]: 'field value' })) }));
  expect(named).toMatchObject({ ok: false, error: 'contract-exhausted',
    evidence: { attempts: [{ reason: 'secret_echo_refused' }] } });
  expect(JSON.stringify(named)).not.toContain(fakeKey);
});

test('P3 enum compares JSON object values regardless of property order', async () => {
  const enumSchema = { type: 'object', properties: { reference: { type: 'string' }, count: { type: 'integer' } },
    required: ['reference', 'count'], additionalProperties: false,
    enum: [{ reference: 'R-1', count: 2 }] };
  const result = await dispatchGraphContract(contract, context({ ...input, schema: enumSchema }), registry({
    fetcher: async () => fakeResponse('{"count":2,"reference":"R-1"}'),
  }));
  expect(result).toMatchObject({ ok: true, result: { reference: 'R-1', count: 2 } });
});

test('P3 treats inherited property names as additional fields when schema allows them', async () => {
  const result = await dispatchGraphContract(contract, context({ ...input,
    schema: { ...schema, additionalProperties: true } }), registry({
    fetcher: async () => fakeResponse('{"reference":"R-1","toString":"safe","constructor":"safe"}'),
  }));
  expect(result).toMatchObject({ ok: true, result: { reference: 'R-1', toString: 'safe', constructor: 'safe' } });
});

test('P3 refuses schema mismatch and invalid JSON without exposing raw response', async () => {
  await failed({ fetcher: async () => fakeResponse(JSON.stringify({ reference: 7 })) }, 'schema_mismatch');
  await failed({ fetcher: async () => fakeResponse('{"reference":') }, 'invalid_json');
});

test('P3 blocks unconsented, unsupported-schema and missing-key requests before upload', async () => {
  let calls = 0;
  const options: UpstageInformationExtractOptions = { fetcher: async () => { calls++; throw new Error('must not upload'); },
    lookupSecret: async () => undefined };
  await failed(options, 'consent_required', { ...input, consentToUpstage: false });
  await failed(options, 'unsupported_schema', { ...input, schema: { ...schema, $ref: '#/defs/x' } });
  await failed(options, 'upstage_key_required');
  expect(calls).toBe(0);
});

test('P3 rejects malformed base64 before secret lookup or upload', async () => {
  let lookups = 0;
  let fetches = 0;
  const options: UpstageInformationExtractOptions = { lookupSecret: async () => { lookups++; return fakeKey; },
    fetcher: async () => { fetches++; return fakeResponse('{"reference":"unexpected"}'); } };
  for (const encoded of ['A', 'QQ=', 'QQ===', 'Q!Q=', '', 'AB==', 'AAB=']) {
    await failed(options, 'invalid_document', { ...input, documentDataUrl: `data:application/pdf;base64,${encoded}` });
  }
  expect(lookups).toBe(0);
  expect(fetches).toBe(0);
});

test('P3 accepts decodable unpadded base64 data URLs for existing callers', async () => {
  const urls: string[] = [];
  const options: UpstageInformationExtractOptions = { fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: Array<{ image_url: { url: string } }> }> };
    urls.push(body.messages[0]!.content[0]!.image_url.url);
    return fakeResponse('{"reference":"R-1"}');
  } };
  for (const encoded of ['SGVsbG8', 'TQ']) {
    const dataUrl = `data:application/pdf;base64,${encoded}`;
    expect(await dispatchGraphContract(contract, context({ ...input, documentDataUrl: dataUrl }), registry(options)))
      .toMatchObject({ ok: true, result: { reference: 'R-1' } });
    expect(urls.at(-1)).toBe(dataUrl);
  }
});

test('P3 bounds slow lookup and never starts a late fetch', async () => {
  let resolveKey!: (value: string) => void;
  const pendingKey = new Promise<string>((resolve) => { resolveKey = resolve; });
  let fetches = 0;
  await failed({ testTimeoutMs: 10, lookupSecret: async () => pendingKey,
    fetcher: async () => { fetches++; return fakeResponse('{"reference":"late"}'); } }, 'operation_aborted');
  resolveKey(fakeKey);
  await Bun.sleep(0);
  expect(fetches).toBe(0);
});

test('P3 passes abort to fetch and bounds stalled response body', async () => {
  let fetchSignal: AbortSignal | undefined;
  await failed({ testTimeoutMs: 10, fetcher: async (_url, init) => {
    fetchSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  } }, 'operation_aborted');
  expect(fetchSignal?.aborted).toBe(true);
  await failed({ testTimeoutMs: 10, fetcher: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); },
  })) }, 'operation_aborted');
});

test('P3 rejects an oversized streaming response before parsing or returning fields', async () => {
  const tooLarge = new Uint8Array(1_048_577);
  tooLarge.fill(65);
  await failed({ fetcher: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(tooLarge); controller.close(); },
  })) }, 'response_too_large');
});

test('P3 honors caller cancellation before a stalled credential lookup settles', async () => {
  const controller = new AbortController();
  const result = dispatchGraphContract(contract, context(input, controller.signal), registry({
    lookupSecret: async () => new Promise<string>(() => {}),
  }));
  controller.abort();
  expect(await result).toMatchObject({ ok: false, error: 'contract-exhausted',
    evidence: { attempts: [{ reason: 'operation_aborted' }] } });
});
