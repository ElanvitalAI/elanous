import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TicketingError, TicketingStore, type ConcertConfig } from './db.js';

const root = join(import.meta.dir, '..');
const frontend = join(root, 'frontend');

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function userId(request: Request): string {
  const user = request.headers.get('X-User-Id')?.trim() ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/u.test(user)) throw new TicketingError(400, 'X-User-Id demo identity required');
  return user;
}

async function requestBody(request: Request): Promise<{ seatIds?: unknown }> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 16_384) throw new TicketingError(413, 'request too large');
  const text = await request.text();
  if (Buffer.byteLength(text) > 16_384) throw new TicketingError(413, 'request too large');
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value as { seatIds?: unknown };
  } catch { throw new TicketingError(400, 'JSON object required'); }
}

export function createTicketingHandler(store: TicketingStore): (request: Request) => Promise<Response> {
  return async request => {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/') return new Response(Bun.file(join(frontend, 'index.html')),
        { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (request.method === 'GET' && path === '/app.js') return new Response(Bun.file(join(frontend, 'app.js')),
        { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
      if (request.method === 'GET' && path === '/styles.css') return new Response(Bun.file(join(frontend, 'styles.css')),
        { headers: { 'content-type': 'text/css; charset=utf-8' } });
      if (request.method === 'GET' && path === '/api/health') return json({ ok: true, concertCount: 1, seatCount: store.config.seatCount });
      if (request.method === 'GET' && path === '/api/concerts') return json([store.concert()]);
      if (request.method === 'GET' && path === '/api/concerts/demo-concert') return json(store.concert());
      if (request.method === 'GET' && path === '/api/concerts/demo-concert/seats') return json(store.seats());
      if (request.method === 'POST' && path === '/api/concerts/demo-concert/hold') {
        const user = userId(request);
        const body = await requestBody(request);
        return json(store.hold(user, body.seatIds as string[]), 201);
      }
      if (request.method === 'POST' && path === '/api/concerts/demo-concert/checkout') {
        const user = userId(request);
        const key = request.headers.get('Idempotency-Key') ?? '';
        const body = await requestBody(request);
        return json(store.checkout(user, body.seatIds as string[], key), 201);
      }
      if (request.method === 'GET' && path === '/api/my-tickets') return json(store.tickets(userId(request)));
      return json({ error: 'not found' }, 404);
    } catch (error) {
      if (error instanceof TicketingError) return json({ error: error.message }, error.status);
      return json({ error: 'internal error' }, 500);
    }
  };
}

if (import.meta.main) {
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as ConcertConfig;
  const dataPath = join(root, 'data', 'ticketing.sqlite');
  mkdirSync(dirname(dataPath), { recursive: true });
  const store = new TicketingStore(dataPath, config);
  const port = Number(process.env.PORT ?? '31542');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid PORT');
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: createTicketingHandler(store) });
  console.log('ticketing local preview: ' + server.url.href);
}
