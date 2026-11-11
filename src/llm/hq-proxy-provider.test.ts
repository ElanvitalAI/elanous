import { expect, test } from 'bun:test';
import { makeHqProxyProvider } from './hq-proxy-provider.js';
import { finalizeProviderModelCompatibility, getProviderForConfigAsync } from '../llm.js';
import type { UserConfig } from '../user-config/types.js';

test('member access token uses bearer alone, without a machine token header', async () => {
  const previousFetch = globalThis.fetch;
  const previousMachine = process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN;
  const previousSeat = process.env.ELANOUS_SEAT;
  const previousPurpose = process.env.ELANOUS_LLM_PURPOSE;
  delete process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN;
  process.env.ELANOUS_SEAT = 'R-PROXY';
  process.env.ELANOUS_LLM_PURPOSE = 'review';
  let sent: Request | undefined;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    sent = new Request(input, init);
    return new Response('{"usage":{"inputTokens":1,"outputTokens":1}}\n', { headers: { 'content-type': 'application/x-ndjson' } });
  }, { preconnect: previousFetch.preconnect });
  try {
    const provider = makeHqProxyProvider({ provider: 'hq-proxy', baseUrl: 'https://hq.example.ts.net', apiKey: `emt_${'a'.repeat(43)}` });
    expect(provider.available()).toBe(true);
    for await (const _event of provider.streamChat!([{ role: 'user', content: 'ping' }])) { /* consume */ }
    expect(sent?.headers.has('x-elanous-machine-token')).toBe(false);
    expect(sent?.headers.get('authorization')?.startsWith('Bearer emt_')).toBe(true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousMachine === undefined) delete process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN; else process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN = previousMachine;
    if (previousSeat === undefined) delete process.env.ELANOUS_SEAT; else process.env.ELANOUS_SEAT = previousSeat;
    if (previousPurpose === undefined) delete process.env.ELANOUS_LLM_PURPOSE; else process.env.ELANOUS_LLM_PURPOSE = previousPurpose;
  }
});

test('config-routed Codex model stays on the HQ proxy provider', async () => {
  const config = { llm: { provider: 'hq-proxy', model: 'gpt-6.1-terra',
    baseUrl: 'https://hq.example.ts.net', apiKey: 'owner-only' } } as UserConfig;
  expect(finalizeProviderModelCompatibility({ provider: 'hq-proxy', model: 'gpt-6.1-terra', auth: 'apikey' }).provider).toBe('hq-proxy');
  expect((await getProviderForConfigAsync(config)).name).toBe('hq-proxy');
});

test('remote provider sends only Nexus credentials and returns fake upstream events', async () => {
  const previousFetch = globalThis.fetch;
  const previousMachine = process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN;
  const previousSeat = process.env.ELANOUS_SEAT;
  const previousPurpose = process.env.ELANOUS_LLM_PURPOSE;
  process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN = 'machine-only';
  process.env.ELANOUS_SEAT = 'R-PROXY';
  process.env.ELANOUS_LLM_PURPOSE = 'implement';
  let sent: Request | undefined;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    sent = new Request(input, init);
    return new Response('{"event":{"type":"text","delta":"fake upstream"}}\n{"usage":{"inputTokens":2,"outputTokens":3}}\n',
      { headers: { 'content-type': 'application/x-ndjson' } });
  }, { preconnect: previousFetch.preconnect });
  try {
    const provider = makeHqProxyProvider({ provider: 'hq-proxy', baseUrl: 'https://hq.example.ts.net', apiKey: 'owner-only' });
    expect(provider.available()).toBe(true);
    const events = [];
    let usage: unknown;
    for await (const event of provider.streamChat!([{ role: 'user', content: 'ping' }], { onUsage: value => { usage = value; } })) events.push(event);
    expect(events).toEqual([{ type: 'text', delta: 'fake upstream' }]);
    expect(usage).toEqual({ inputTokens: 2, outputTokens: 3 });
    expect(sent?.url).toBe('https://hq.example.ts.net/v1/llm/proxy');
    expect(sent?.headers.get('authorization')).toBe('Bearer owner-only');
    expect(sent?.headers.get('x-elanous-machine-token')).toBe('machine-only');
    const body = await sent!.json() as Record<string, unknown>;
    expect(body).toMatchObject({ seat: 'R-PROXY', purpose: 'implement' });
    expect(JSON.stringify(body)).not.toContain('owner-only');
    expect(JSON.stringify(body)).not.toContain('machine-only');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousMachine === undefined) delete process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN; else process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN = previousMachine;
    if (previousSeat === undefined) delete process.env.ELANOUS_SEAT; else process.env.ELANOUS_SEAT = previousSeat;
    if (previousPurpose === undefined) delete process.env.ELANOUS_LLM_PURPOSE; else process.env.ELANOUS_LLM_PURPOSE = previousPurpose;
  }
});

test('missing purpose is rejected before any request', async () => {
  const previousPurpose = process.env.ELANOUS_LLM_PURPOSE;
  const previousMachine = process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN;
  const previousSeat = process.env.ELANOUS_SEAT;
  delete process.env.ELANOUS_LLM_PURPOSE;
  process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN = 'machine-only';
  process.env.ELANOUS_SEAT = 'R-PROXY';
  try {
    const provider = makeHqProxyProvider({ provider: 'hq-proxy', baseUrl: 'https://hq.example.ts.net', apiKey: 'owner-only' });
    expect(provider.available()).toBe(false);
    await expect(async () => { for await (const _event of provider.streamChat!([{ role: 'user', content: 'ping' }])) { /* no request */ } })
      .toThrow('ELANOUS_LLM_PURPOSE');
  } finally {
    if (previousPurpose === undefined) delete process.env.ELANOUS_LLM_PURPOSE; else process.env.ELANOUS_LLM_PURPOSE = previousPurpose;
    if (previousMachine === undefined) delete process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN; else process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN = previousMachine;
    if (previousSeat === undefined) delete process.env.ELANOUS_SEAT; else process.env.ELANOUS_SEAT = previousSeat;
  }
});

test('NDJSON without a usage completion frame fails closed', async () => {
  const previousFetch = globalThis.fetch;
  const previousMachine = process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN;
  const previousSeat = process.env.ELANOUS_SEAT;
  const previousPurpose = process.env.ELANOUS_LLM_PURPOSE;
  process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN = 'machine-only';
  process.env.ELANOUS_SEAT = 'R-PROXY';
  process.env.ELANOUS_LLM_PURPOSE = 'review';
  globalThis.fetch = Object.assign(async () => new Response('{"event":{"type":"text","delta":"partial"}}\n',
    { headers: { 'content-type': 'application/x-ndjson' } }), { preconnect: previousFetch.preconnect });
  try {
    const provider = makeHqProxyProvider({ provider: 'hq-proxy', baseUrl: 'https://hq.example.ts.net', apiKey: 'owner-only' });
    await expect(async () => { for await (const _event of provider.streamChat!([{ role: 'user', content: 'ping' }])) { /* consume */ } })
      .toThrow('usage completion frame');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousMachine === undefined) delete process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN; else process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN = previousMachine;
    if (previousSeat === undefined) delete process.env.ELANOUS_SEAT; else process.env.ELANOUS_SEAT = previousSeat;
    if (previousPurpose === undefined) delete process.env.ELANOUS_LLM_PURPOSE; else process.env.ELANOUS_LLM_PURPOSE = previousPurpose;
  }
});

test('rejects a public DNS name disguised as a tailnet IP', () => {
  const provider = makeHqProxyProvider({ provider: 'hq-proxy', baseUrl: 'https://100.64.attacker.example', apiKey: 'owner-only' });
  expect(provider.available()).toBe(false);
});

test('usage event calls onUsage once and redirects are forbidden', async () => {
  const previousFetch = globalThis.fetch;
  const previousMachine = process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN;
  const previousSeat = process.env.ELANOUS_SEAT;
  const previousPurpose = process.env.ELANOUS_LLM_PURPOSE;
  process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN = 'machine-only';
  process.env.ELANOUS_SEAT = 'R-PROXY';
  process.env.ELANOUS_LLM_PURPOSE = 'review';
  let redirect: RequestRedirect | undefined;
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    redirect = init?.redirect;
    return new Response('{"event":{"type":"usage","usage":{"inputTokens":2,"outputTokens":3}}}\n{"usage":{"inputTokens":2,"outputTokens":3}}\n',
      { headers: { 'content-type': 'application/x-ndjson' } });
  }, { preconnect: previousFetch.preconnect });
  try {
    const provider = makeHqProxyProvider({ provider: 'hq-proxy', baseUrl: 'https://hq.example.ts.net', apiKey: 'owner-only' });
    const used: unknown[] = [];
    for await (const _event of provider.streamChat!([{ role: 'user', content: 'ping' }], { onUsage: usage => used.push(usage) })) { /* consume */ }
    expect(redirect).toBe('error');
    expect(used).toEqual([{ inputTokens: 2, outputTokens: 3 }]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousMachine === undefined) delete process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN; else process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN = previousMachine;
    if (previousSeat === undefined) delete process.env.ELANOUS_SEAT; else process.env.ELANOUS_SEAT = previousSeat;
    if (previousPurpose === undefined) delete process.env.ELANOUS_LLM_PURPOSE; else process.env.ELANOUS_LLM_PURPOSE = previousPurpose;
  }
});
