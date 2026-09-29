import { debug } from '../debug/log.js';
import { matchMcpPat } from './pat-store.js';

const MAX_BODY = 1024 * 1024;
const MAX_IP_BUCKETS = 4096;

export class MinuteIpLimiter {
  private readonly buckets = new Map<string, number>();
  private minute: number | undefined;

  constructor(private readonly limit: number, private readonly maxBuckets = MAX_IP_BUCKETS) {}

  allow(ip: string, minute: number): boolean {
    if (this.minute !== minute) {
      this.buckets.clear();
      this.minute = minute;
    }
    const count = this.buckets.get(ip);
    if (count === undefined && this.buckets.size >= this.maxBuckets) return false;
    if (count !== undefined && count >= this.limit) return false;
    this.buckets.set(ip, (count ?? 0) + 1);
    return true;
  }

  get size(): number { return this.buckets.size; }
}

export interface McpGatewayOptions {
  host: string;
  port: number;
  nexusUrl: string;
  nexusToken: string;
  patRoot: string;
  rateLimitPerMinute?: number;
  publicUrl: string;
}

export function startMcpGateway(options: McpGatewayOptions): ReturnType<typeof Bun.serve> {
  if (!options.publicUrl) throw new Error('public URL required');
  const base = new URL(options.publicUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/' || ['0.0.0.0', '[::]'].includes(base.hostname)) throw new Error('invalid public URL');
  const nexus = new URL(options.nexusUrl);
  if (!['http:', 'https:'].includes(nexus.protocol) || nexus.username || nexus.password || nexus.search || nexus.hash || nexus.pathname !== '/') throw new Error('invalid nexus URL');
  if (!options.nexusToken || /\s/.test(options.nexusToken)) throw new Error('invalid nexus token');
  const limit = options.rateLimitPerMinute ?? 60;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('invalid rate limit');
  const resource = base.origin;
  const challenge = `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource"`;
  const counts = new Map<string, { minute: number; count: number }>();
  const ipLimiter = new MinuteIpLimiter(Math.max(limit, 60));
  return Bun.serve({
    hostname: options.host,
    port: options.port,
    async fetch(req, server): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname !== '/mcp' && url.pathname !== '/.well-known/oauth-protected-resource') return new Response(null, { status: 404 });
      if (req.headers.has('origin')) return new Response(null, { status: 403 });
      if (url.pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET' && !url.search) {
        return Response.json({ resource, bearer_methods_supported: ['header'], authorization_servers: [] });
      }
      if (url.pathname !== '/mcp' || req.method !== 'POST' || url.search) return new Response(null, { status: 404 });
      const minute = Math.floor(Date.now() / 60_000);
      const ip = server.requestIP(req)?.address ?? 'unknown';
      if (!ipLimiter.allow(ip, minute)) return new Response(null, { status: 429 });
      const auth = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.get('authorization') ?? '');
      let pat = null;
      try { if (auth) pat = matchMcpPat(auth[1]!, Date.now(), options.patRoot); }
      catch { /* inaccessible/corrupt store denies access */ }
      if (!pat) return new Response(null, { status: 401, headers: { 'www-authenticate': challenge } });
      const started = Date.now();
      let status = 502;
      let method = 'unknown';
      let tool: string | undefined;
      try {
        const bucket = counts.get(pat.name);
        const count = bucket?.minute === minute ? bucket.count + 1 : 1;
        counts.set(pat.name, { minute, count });
        if (count > limit) { status = 429; return new Response(null, { status }); }
        const declared = Number(req.headers.get('content-length'));
        if (req.headers.has('content-length') && Number.isFinite(declared) && declared > MAX_BODY) { status = 413; return new Response(null, { status }); }
        const reader = req.body?.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (reader) {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              length += value.byteLength;
              if (length > MAX_BODY) { await reader.cancel(); status = 413; return new Response(null, { status }); }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
        }
        const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
        try {
          const rpc: unknown = JSON.parse(body.toString('utf8'));
          if (rpc && typeof rpc === 'object' && !Array.isArray(rpc)) {
            const record = rpc as { method?: unknown; params?: { name?: unknown } };
            if (typeof record.method === 'string') method = record.method;
            if (method === 'tools/call' && typeof record.params?.name === 'string') tool = record.params.name;
          }
        } catch { /* The nexus owns JSON-RPC validation. */ }
        const headers = new Headers();
        for (const key of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'mcp-progress']) {
          const value = req.headers.get(key);
          if (value !== null) headers.set(key, value);
        }
        headers.set('authorization', `Bearer ${options.nexusToken}`);
        // Force the nexus to authenticate its scoped token even over a loopback connection.
        headers.set('x-forwarded-for', 'mcp-gateway');
        const upstream = await fetch(new URL('/v1/mcp', nexus), { method: 'POST', headers, body, redirect: 'manual' });
        if (upstream.status >= 300 && upstream.status < 400) { status = 502; await upstream.body?.cancel(); return new Response(null, { status }); }
        status = upstream.status;
        // fetch 는 압축 응답을 풀어서 준다 — 원래의 content-encoding·content-length 를 그대로 붙이면 본문과 어긋나 MCP 응답이 깨진다(리뷰 must-fix · #21457).
        const outHeaders = new Headers(upstream.headers);
        outHeaders.delete('content-encoding');
        outHeaders.delete('content-length');
        return new Response(upstream.body, { status, headers: outHeaders });
      } catch {
        status = 502;
        return new Response(null, { status });
      } finally {
        debug.log('mcp.gateway', 'call', { tokenName: pat.name, method, ...(tool === undefined ? {} : { tool }), status, ms: Date.now() - started });
      }
    },
  });
}
