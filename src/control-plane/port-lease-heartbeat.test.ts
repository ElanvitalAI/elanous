import { expect, test } from 'bun:test';
import { PORT_LEASE_TTL_MS, startPortLeaseHeartbeat } from './port-lease-heartbeat.js';

test('detached owner renews with its lease id and releases on orderly shutdown', async () => {
  const methods: string[] = [];
  const stop = await startPortLeaseHeartbeat(31450, 'run-id', {
    token: 'member-token', intervalMs: 10, retryMs: 5,
    onLeaseLost: error => { throw error; },
    fetchFn: async (_url, init) => {
      expect(new Headers(init.headers).get('x-port-lease-id')).toBe('run-id');
      methods.push(init.method ?? '');
      return new Response(null, { status: init.method === 'DELETE' ? 204 : 200 });
    },
  });
  await Bun.sleep(35);
  expect(methods.filter(method => method === 'POST').length).toBeGreaterThan(1);
  await stop();
  expect(methods.at(-1)).toBe('DELETE');
  const count = methods.length;
  await Bun.sleep(20);
  expect(methods).toHaveLength(count);
});

test('renewal retries after transient failure and shutdown still releases the lease', async () => {
  const methods: string[] = [];
  const failures: string[] = [];
  const stop = await startPortLeaseHeartbeat(31450, 'run-id', {
    token: 'member-token', intervalMs: 10, retryMs: 5,
    onLeaseLost: error => { throw error; },
    onError: error => failures.push(error.message),
    fetchFn: async (_url, init) => {
      methods.push(init.method ?? '');
      return new Response(null, { status: methods.length === 2 ? 503 : init.method === 'DELETE' ? 204 : 200 });
    },
  });
  await Bun.sleep(35);
  expect(failures).toEqual(['coordinator lease renewal HTTP 503']);
  expect(methods.filter(method => method === 'POST').length).toBeGreaterThan(1);
  await stop();
  expect(methods.at(-1)).toBe('DELETE');
});

test('missing lease identity prevents heartbeat startup', async () => {
  await expect(startPortLeaseHeartbeat(31450, '', { token: 'member-token', onLeaseLost: () => {} })).rejects.toThrow('missing coordinator lease id');
});

test('failed initial renewal prevents startup before exposing the HTTP listener', async () => {
  await expect(startPortLeaseHeartbeat(31450, 'run-id', {
    token: 'member-token', onLeaseLost: () => {}, fetchFn: async () => new Response(null, { status: 503 }),
  })).rejects.toThrow('coordinator lease renewal HTTP 503');
});

test('initial renewal completing past the safety deadline cannot start the daemon', async () => {
  let clock = 1000;
  await expect(startPortLeaseHeartbeat(31450, 'run-id', {
    token: 'member-token', now: () => clock,
    onLeaseLost: () => { throw new Error('must not start'); },
    fetchFn: async () => {
      clock += PORT_LEASE_TTL_MS - 9_000;
      return new Response(null, { status: 200 });
    },
  })).rejects.toThrow('coordinator port lease renewal deadline exceeded');
});

test('failed renewals halt the daemon before the coordinator TTL expires', async () => {
  let clock = 1000;
  const failures: string[] = [];
  let lost = '';
  const stop = await startPortLeaseHeartbeat(31450, 'run-id', {
    token: 'member-token', intervalMs: 5, retryMs: 5, now: () => clock,
    onError: error => failures.push(error.message),
    onLeaseLost: error => { lost = error.message; },
    fetchFn: async (_url, init) => new Response(null, { status: init.method === 'DELETE' ? 204 : clock === 1000 ? 200 : 503 }),
  });
  await Bun.sleep(12);
  clock += PORT_LEASE_TTL_MS - 9_000;
  await Bun.sleep(12);
  expect(failures.length).toBeGreaterThan(0);
  expect(lost).toContain('coordinator lease renewal');
  await stop();
});

test('a delayed success after the safety deadline cannot reset the last confirmed renewal time', async () => {
  let clock = 1000;
  let lost = '';
  const stop = await startPortLeaseHeartbeat(31450, 'run-id', {
    token: 'member-token', intervalMs: 5, now: () => clock,
    onLeaseLost: error => { lost = error.message; },
    fetchFn: async (_url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (clock === 1000) return new Response(null, { status: 200 });
      clock += PORT_LEASE_TTL_MS - 9_000;
      return new Response(null, { status: 200 });
    },
  });
  clock += 1;
  await Bun.sleep(15);
  expect(lost).toBe('coordinator port lease renewal deadline exceeded');
  await stop();
});

test('lost ownership fails immediately rather than retrying until expiry', async () => {
  let lost = '';
  let renewals = 0;
  const stop = await startPortLeaseHeartbeat(31450, 'old-run', {
    token: 'member-token', intervalMs: 5,
    onLeaseLost: error => { lost = error.message; },
    fetchFn: async (_url, init) => new Response(null, { status: init.method === 'DELETE' ? 403 : ++renewals === 1 ? 200 : 403 }),
  });
  await Bun.sleep(20);
  expect(lost).toBe('coordinator lease renewal HTTP 403');
  await stop();
});
