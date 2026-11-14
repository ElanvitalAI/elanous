import { expect, test } from 'bun:test';
import { TicketingStore } from '../backend/db.js';
import { createTicketingHandler } from '../backend/server.js';

test('same-origin frontend and ticketing API respond over loopback HTTP', async () => {
  const store = new TicketingStore(':memory:', {
    eventTitle: 'HTTP Concert', eventDate: '미정', venue: '미정', seatCount: 4,
    sampleFields: ['공연일', '장소'],
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createTicketingHandler(store) });
  const url = server.url.href;
  try {
    const html = await fetch(url);
    expect(html.status).toBe(200);
    const htmlText = await html.text();
    expect(htmlText).toContain('seat-grid');
    expect(htmlText).toContain('id="sample-note"');
    const app = await fetch(new URL('/app.js', url));
    expect(app.status).toBe(200);
    const appText = await app.text();
    expect(appText).toContain('/api/my-tickets');
    expect(appText).toContain('샘플/가상 입력값:');
    const concert = await fetch(new URL('/api/concerts/demo-concert', url));
    expect(await concert.json()).toMatchObject({ date: '미정', venue: '미정', sampleFields: ['공연일', '장소'] });
    const health = await fetch(new URL('/api/health', url));
    expect(await health.json()).toEqual({ ok: true, concertCount: 1, seatCount: 4 });
    const hold = await fetch(new URL('/api/concerts/demo-concert/hold', url), {
      method: 'POST', headers: { 'X-User-Id': 'user-a', 'content-type': 'application/json' },
      body: JSON.stringify({ seatIds: ['s1-1-1'] }),
    });
    expect(hold.status).toBe(201);
    const conflict = await fetch(new URL('/api/concerts/demo-concert/hold', url), {
      method: 'POST', headers: { 'X-User-Id': 'user-b', 'content-type': 'application/json' },
      body: JSON.stringify({ seatIds: ['s1-1-1'] }),
    });
    expect(conflict.status).toBe(409);
    const checkout = await fetch(new URL('/api/concerts/demo-concert/checkout', url), {
      method: 'POST', headers: { 'X-User-Id': 'user-a', 'Idempotency-Key': 'http-checkout-0001',
        'content-type': 'application/json' },
      body: JSON.stringify({ seatIds: ['s1-1-1'] }),
    });
    expect(checkout.status).toBe(201);
    expect((await checkout.json()).ticketIds).toHaveLength(1);
    const tickets = await fetch(new URL('/api/my-tickets', url), { headers: { 'X-User-Id': 'user-a' } });
    expect(await tickets.json()).toHaveLength(1);
  } finally { server.stop(true); store.close(); }
});
