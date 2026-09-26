import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { RESOURCE_KINDS, ResourceLedger, ResourceLedgerError, type ResourceRecord } from './ledger.js';
import { leasePort, PORT_BANDS } from './ports.js';
import { machineForToken } from './member-tokens.js';

export const DEFAULT_CONTROL_PORT = PORT_BANDS.reserved[0];
export const CONTROL_HOSTNAME = '127.0.0.1';

export function allowedControlHostname(hostname: string): boolean {
  if (hostname === '127.0.0.1' || hostname === '::1') return true;
  const parts = hostname.split('.');
  if (parts.length !== 4 || !parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return false;
  return parts[0] === '100' && Number(parts[1]) >= 64 && Number(parts[1]) <= 127;
}
export type ControlScope = 'admin' | 'member' | 'query';
export type ControlTokens = Record<ControlScope, string>;

/** Tokens are separate from the ACP token envelope and never sent through HTTP. */
export function ensureControlTokens(root: string = effectiveInstanceRoot()): ControlTokens {
  const path = join(root, 'control', 'tokens.json');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, JSON.stringify({
      admin: randomBytes(32).toString('hex'),
      member: randomBytes(32).toString('hex'),
      query: randomBytes(32).toString('hex'),
    }), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !['admin', 'member', 'query'].every(k =>
    typeof (parsed as Record<string, unknown>)[k] === 'string' &&
    /^[a-f0-9]{64}$/.test((parsed as Record<string, string>)[k]!))) {
    throw new Error('invalid control tokens file');
  }
  const tokens = parsed as ControlTokens;
  if (new Set(Object.values(tokens)).size !== 3) throw new Error('duplicate control tokens');
  // A pre-existing file must not silently leave credentials world-readable.
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  return tokens;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function recordFromBody(value: unknown, owner: string): ResourceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResourceLedgerError(400, 'invalid-record');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id ||
      !RESOURCE_KINDS.includes(row.kind as (typeof RESOURCE_KINDS)[number]) ||
      typeof row.machine !== 'string' || !row.machine ||
      typeof row.name !== 'string' || !row.name ||
      (row.endpoint !== undefined && typeof row.endpoint !== 'string') ||
      !row.attrs || typeof row.attrs !== 'object' || Array.isArray(row.attrs) ||
      typeof row.ttlMs !== 'number' || !Number.isFinite(row.ttlMs) || row.ttlMs < 0) {
    throw new ResourceLedgerError(400, 'invalid-record');
  }
  return {
    id: row.id, kind: row.kind as ResourceRecord['kind'], machine: row.machine,
    name: row.name, owner,
    ...(row.endpoint !== undefined ? { endpoint: row.endpoint as string } : {}),
    attrs: row.attrs as Record<string, unknown>, observedAt: Date.now(), ttlMs: row.ttlMs,
  };
}

export interface ControlServerOptions {
  root?: string;
  port?: number;
  hostname?: string;
}

export function startControlServer(opts: ControlServerOptions = {}): {
  hostname: string;
  url: string;
  stop(): void;
} {
  const hostname = opts.hostname ?? CONTROL_HOSTNAME;
  if (!allowedControlHostname(hostname)) throw new Error('invalid control hostname');
  const root = opts.root ?? effectiveInstanceRoot();
  const tokens = ensureControlTokens(root);
  const ledger = new ResourceLedger(root);
  const port = opts.port ?? DEFAULT_CONTROL_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid control port');
  const server = Bun.serve({
    hostname,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      const resourcePath = path === '/v1/resources' && method === 'GET';
      const registerPath = path === '/v1/resources/register' && method === 'POST';
      const heartbeat = /^\/v1\/resources\/([^/]+)\/heartbeat$/.exec(path);
      const deletion = /^\/v1\/resources\/([^/]+)$/.exec(path);
      const leaseRequest = path === '/v1/leases/port' && method === 'POST';
      const leaseDeletion = /^\/v1\/leases\/port\/([^/]+)$/.exec(path);
      const leaseRenewal = /^\/v1\/leases\/port\/([^/]+)\/heartbeat$/.exec(path);
      if (!resourcePath && !registerPath && !leaseRequest && !(leaseDeletion && method === 'DELETE') && !(leaseRenewal && method === 'POST') && !(heartbeat && method === 'POST') && !(deletion && method === 'DELETE')) {
        return json({ error: 'not-found' }, 404);
      }
      const authorization = req.headers.get('authorization');
      const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
      const scope: ControlScope | undefined = presented
        ? (Object.keys(tokens) as ControlScope[]).find(key => tokens[key] === presented)
        : undefined;
      const machine = !scope && presented ? machineForToken(presented, root) : undefined;
      if (!scope && !machine) return json({ error: 'unauthorized' }, 401);
      if (!resourcePath && (scope === 'query' || ((leaseRequest || leaseDeletion || leaseRenewal) && scope !== 'member' && !machine))) return json({ error: 'forbidden' }, 403);
      const owner = createHash('sha256').update(machine ? `machine:${machine}` : presented!).digest('hex');
      const requireMachine = (target: string) => {
        if (machine && target !== machine) throw new ResourceLedgerError(403, 'machine-scope');
      };
      const requireTarget = (id: string) => {
        if (machine) {
          const target = ledger.list().find(row => row.id === id);
          if (target) requireMachine(target.machine);
        }
      };
      try {
        if (leaseRequest) {
          const body: unknown = await req.json();
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ResourceLedgerError(400, 'invalid-port-lease');
          const { machine, purpose, ttlMs, excluded } = body as Record<string, unknown>;
          if (typeof machine !== 'string' || !machine.trim() || typeof purpose !== 'string' || !purpose.trim() ||
              typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0 ||
              (excluded !== undefined && (!Array.isArray(excluded) || !excluded.every(port =>
                Number.isInteger(port) && port >= PORT_BANDS.test.start && port <= PORT_BANDS.test.end)))) {
            throw new ResourceLedgerError(400, 'invalid-port-lease');
          }
          requireMachine(machine);
          const lease = leasePort({ machine, purpose, ttlMs, owner, excluded: excluded as number[] | undefined }, ledger);
          return json({ port: lease.attrs.port, lease });
        }
        if (leaseRenewal || leaseDeletion) {
          const match = leaseRenewal ?? leaseDeletion!;
          const port = Number(match[1]);
          if (!Number.isInteger(port) || port < PORT_BANDS.test.start || port > PORT_BANDS.test.end ||
              match[1] !== String(port)) throw new ResourceLedgerError(400, 'invalid-port');
          requireTarget(`port-lease:${port}`);
          const leaseId = req.headers.get('x-port-lease-id');
          if (!leaseId) throw new ResourceLedgerError(400, 'missing-lease-id');
          if (leaseRenewal) {
            const renewed = ledger.renewTestPort(port, owner, leaseId);
            return json({ ...renewed, attrs: { ...renewed.attrs, leaseId: undefined } });
          }
          ledger.deleteTestPort(port, owner, leaseId);
          return new Response(null, { status: 204 });
        }
        if (resourcePath) {
          const rows = ledger.list({
            kind: url.searchParams.get('kind') || undefined,
            machine: url.searchParams.get('machine') || undefined,
            name: url.searchParams.get('name') || undefined,
          });
          return json({ resources: rows.map(row => row.kind === 'port-lease'
            ? { ...row, attrs: { ...row.attrs, leaseId: undefined } }
            : row) });
        }
        if (registerPath) {
          const row = recordFromBody(await req.json(), owner);
          if (row.kind === 'port-lease' || row.id.startsWith('port-lease:')) throw new ResourceLedgerError(403, 'port-lease-requires-allocator');
          requireMachine(row.machine);
          requireTarget(row.id);
          return json(ledger.register(row, owner));
        }
        if (heartbeat && method === 'POST') {
          if (decodeURIComponent(heartbeat[1]!).startsWith('port-lease:')) throw new ResourceLedgerError(403, 'port-lease-requires-allocator');
          const body: unknown = await req.json();
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ResourceLedgerError(400, 'invalid-heartbeat');
          if (machine && 'machine' in body) requireMachine((body as Record<string, unknown>).machine as string);
          const attrs = (body as Record<string, unknown>).attrs;
          if (attrs !== undefined && (!attrs || typeof attrs !== 'object' || Array.isArray(attrs))) {
            throw new ResourceLedgerError(400, 'invalid-heartbeat');
          }
          const id = decodeURIComponent(heartbeat[1]!);
          requireTarget(id);
          return json(ledger.heartbeat(id, owner, attrs as Record<string, unknown> | undefined));
        }
        if (decodeURIComponent(deletion![1]!).startsWith('port-lease:')) throw new ResourceLedgerError(403, 'port-lease-requires-allocator');
        const id = decodeURIComponent(deletion![1]!);
        requireTarget(id);
        ledger.delete(id, owner);
        return new Response(null, { status: 204 });
      } catch (err) {
        if (err instanceof ResourceLedgerError) return json({ error: err.message }, err.status);
        if (err instanceof SyntaxError) return json({ error: 'invalid-json' }, 400);
        throw err;
      }
    },
  });
  return {
    hostname,
    url: `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${server.port ?? port}`,
    stop() { server.stop(true); },
  };
}
