import { expect, test } from 'bun:test';
import { probeDeviceAuth } from './device-auth';
import type { DaemonConfig } from './daemon-config';

const config = { baseUrl: 'https://owner.elanous.app' } as DaemonConfig;

test('bare webchat origin is connected without probing /v1/nexus', async () => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => ({ getAttribute: () => '1' }) } });
  try {
    const asked: string[] = [];
    const answer = await probeDeviceAuth(config, { fetchResponse: async (path: string) => { asked.push(path); return new Response('', { status: 401 }); } } as never);
    expect(answer).toBe('connected');
    expect(asked).toEqual([]);
  } finally { delete (globalThis as { document?: unknown }).document; }
});

test('a normal origin still reports a 401 probe as unconnected', async () => {
  const answer = await probeDeviceAuth(config, { fetchResponse: async () => new Response('', { status: 401 }) } as never);
  expect(answer).toBe('unconnected');
});
