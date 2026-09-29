import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueMcpPat, revokeMcpPat } from './pat-store.js';
import { MinuteIpLimiter, startMcpGateway } from './gateway.js';

let root: string;
let nexus: ReturnType<typeof Bun.serve>;
let gateway: ReturnType<typeof Bun.serve>;
let issued: ReturnType<typeof issueMcpPat>;
let seen: Array<{ authorization: string | null; body: string; forwarded: string | null }>;
let base: string;
const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const post = (token?: string, options: { body?: string; headers?: Record<string, string> } = {}) => fetch(`${base}/mcp`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers }, body: options.body ?? rpc,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-gateway-'));
  issued = issueMcpPat('laptop', {}, root);
  seen = [];
  nexus = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const text = await req.text();
    seen.push({ authorization: req.headers.get('authorization'), body: text, forwarded: req.headers.get('x-forwarded-for') });
    if (text.includes('"gzip/test"')) {
      const body = Bun.gzipSync(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: ['z'] } })));
      return new Response(body, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(body.byteLength) } });
    }
    if (req.headers.get('mcp-progress') === 'stream') return new Response('event: result\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1', 'x-mcp-test-response': 'intact' } });
    return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  } });
  gateway = startMcpGateway({ host: '127.0.0.1', port: 0, nexusUrl: `http://127.0.0.1:${nexus.port}`, nexusToken: 'gateway-scoped-token', patRoot: root, publicUrl: 'https://mcp.elanous.ai', rateLimitPerMinute: 2 });
  base = `http://127.0.0.1:${gateway.port}`;
});
afterEach(() => { gateway.stop(true); nexus.stop(true); rmSync(root, { recursive: true, force: true }); });

test('public URL is required independently of the bind address', () => {
  const options = { host: '0.0.0.0', port: 0, nexusUrl: `http://127.0.0.1:${nexus.port}`, nexusToken: 'gateway-scoped-token', patRoot: root };
  expect(() => startMcpGateway(options as Parameters<typeof startMcpGateway>[0])).toThrow('public URL required');
  expect(() => startMcpGateway({ ...options, publicUrl: 'http://0.0.0.0:31482' })).toThrow('invalid public URL');
});

test('wildcard bind uses the explicit public origin in challenge and metadata', async () => {
  const wildcard = startMcpGateway({ host: '0.0.0.0', port: 0, nexusUrl: `http://127.0.0.1:${nexus.port}`, nexusToken: 'gateway-scoped-token', patRoot: root, publicUrl: 'https://mcp.elanous.ai' });
  try {
    const address = `http://127.0.0.1:${wildcard.port}`;
    const response = await fetch(`${address}/mcp`, { method: 'POST', body: rpc });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://mcp.elanous.ai/.well-known/oauth-protected-resource"');
    const metadata = await fetch(`${address}/.well-known/oauth-protected-resource`);
    expect(await metadata.json()).toEqual({ resource: 'https://mcp.elanous.ai', bearer_methods_supported: ['header'], authorization_servers: [] });
  } finally { wildcard.stop(true); }
});

test('401 challenge, protected-resource document and scoped-token substitution', async () => {
  const missing = await post();
  expect(missing.status).toBe(401);
  expect(missing.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://mcp.elanous.ai/.well-known/oauth-protected-resource"');
  expect((await post('incorrect')).status).toBe(401);
  const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`);
  expect(await metadata.json()).toEqual({ resource: 'https://mcp.elanous.ai', bearer_methods_supported: ['header'], authorization_servers: [] });
  const response = await post(issued.token);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  expect(seen).toEqual([{ authorization: 'Bearer gateway-scoped-token', body: rpc, forwarded: 'mcp-gateway' }]);
  expect(JSON.stringify(seen)).not.toContain(issued.token);
  revokeMcpPat('laptop', root);
  expect((await post(issued.token)).status).toBe(401);
});

test('Origin, body size, rate limit and non-POST paths are denied without reaching nexus', async () => {
  expect((await post(issued.token, { headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
  expect((await post(issued.token, { body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
  expect((await fetch(`${base}/mcp`)).status).toBe(404);
  expect((await fetch(`${base}/anything`, { method: 'POST' })).status).toBe(404);
  expect((await fetch(`${base}/.well-known/oauth-protected-resource`, { headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
  expect(seen).toHaveLength(0);
  expect((await post(issued.token)).status).toBe(200);
  expect((await post(issued.token)).status).toBe(429);
  expect(seen).toHaveLength(1);
});

test('per-name limit does not count missing or invalid credentials against other PATs', async () => {
  const second = issueMcpPat('phone', {}, root);
  expect((await post('invalid')).status).toBe(401);
  expect((await post(issued.token)).status).toBe(200);
  expect((await post(issued.token)).status).toBe(200);
  expect((await post(issued.token)).status).toBe(429);
  expect((await post(second.token)).status).toBe(200);
  expect(seen).toHaveLength(3);
});

test('nexus redirects cannot send the gateway credential to another origin', async () => {
  let leaked: string | null = null;
  const receiver = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    leaked = req.headers.get('authorization');
    return Response.json({ accepted: true });
  } });
  const redirect = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${receiver.port}/steal` } });
  } });
  const isolated = startMcpGateway({ host: '127.0.0.1', port: 0, nexusUrl: `http://127.0.0.1:${redirect.port}`, nexusToken: 'gateway-scoped-token', patRoot: root, publicUrl: 'https://mcp.elanous.ai' });
  try {
    const response = await fetch(`http://127.0.0.1:${isolated.port}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${issued.token}` }, body: rpc,
    });
    expect(response.status).toBe(502);
    expect(leaked).toBeNull();
  } finally { isolated.stop(true); redirect.stop(true); receiver.stop(true); }
});

test('per-IP limit also bounds attempts with invalid credentials', async () => {
  for (let i = 0; i < 60; i++) expect((await post('incorrect')).status).toBe(401);
  expect((await post('incorrect')).status).toBe(429);
  expect(seen).toHaveLength(0);
});

test('IP buckets expire independently of returning clients and cap distinct IPs without resetting the 429 count', () => {
  const limiter = new MinuteIpLimiter(2, 3);
  expect(limiter.allow('stale', 100)).toBe(true);
  expect(limiter.allow('returning', 100)).toBe(true);
  expect(limiter.allow('returning', 100)).toBe(true);
  expect(limiter.allow('returning', 100)).toBe(false);
  expect(limiter.allow('third', 100)).toBe(true);
  expect(limiter.allow('fourth', 100)).toBe(false);
  expect(limiter.size).toBe(3);
  expect(limiter.allow('returning', 100)).toBe(false);
  expect(limiter.allow('fresh', 101)).toBe(true);
  expect(limiter.size).toBe(1);
  expect(limiter.allow('returning', 101)).toBe(true);
  expect(limiter.size).toBe(2);
  const productionCap = new MinuteIpLimiter(60);
  for (let i = 0; i < 4096; i++) expect(productionCap.allow(`ip-${i}`, 100)).toBe(true);
  expect(productionCap.allow('ip-4096', 100)).toBe(false);
  expect(productionCap.size).toBe(4096);
  expect(productionCap.allow('ip-4096', 101)).toBe(true);
  expect(productionCap.size).toBe(1);
});

test('streaming body above 1MB without Content-Length is rejected before forwarding', async () => {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${issued.token}` },
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close(); } }),
    duplex: 'half',
  } as RequestInit);
  expect(response.status).toBe(413);
  expect(seen).toHaveLength(0);
});

test('response SSE and session headers are relayed without forwarding attacker headers', async () => {
  const response = await post(issued.token, { headers: { 'mcp-progress': 'stream', 'x-forwarded-for': 'attacker', cookie: 'private', 'mcp-session-id': 'session' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(response.headers.get('mcp-session-id')).toBe('s1');
  expect(response.headers.get('x-mcp-test-response')).toBe('intact');
  expect(await response.text()).toBe('event: result\ndata: {}\n\n');
  expect(seen[0]?.forwarded).toBe('mcp-gateway');
});

test('compressed upstream: gateway drops stale content-encoding/content-length so the decoded body is intact', async () => {
  const response = await post(issued.token, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gzip/test' }) });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: ['z'] } });
});
