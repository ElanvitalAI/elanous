import { afterEach, expect, test } from 'bun:test';
import { createFakeDataGuardBoundaryDevice } from './fake-data-guard-boundary.js';
import { scanSecretCanaries, issueSecretCanary } from './secret-canary.js';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('fake data-guard boundary records local and public payloads and refuses unknown destinations', async () => {
  const fetchBeforeInstall = globalThis.fetch;
  const device = createFakeDataGuardBoundaryDevice({
    localOrigins: ['http://127.0.0.1:1234'],
    publicOrigins: ['https://api.openai.com'],
    localResponse: Response.json({ route: 'local' }),
    publicResponse: Response.json({ route: 'public' }),
  });
  try {
    const canary = issueSecretCanary('openai', 'DATA-GUARD-01');
    const privateBody = JSON.stringify({ prompt: `customer secret ${canary.value}` });
    await fetch('https://api.openai.com/v1/responses', { method: 'POST', body: privateBody });
    const publicResponse = await fetch('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify({ prompt: 'public prompt' }) });
    const localResponse = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
      method: 'POST', headers: { 'x-scenario': 'local-fallback' }, body: privateBody,
    });
    await expect(fetch('https://unregistered.example/v1/responses', { method: 'POST', body: privateBody }))
      .rejects.toThrow('unregistered destination');
    await expect(fetch('blob:https://api.openai.com/data-guard-artifact'))
      .rejects.toThrow('non-HTTP(S) destination');

    expect(await publicResponse.json()).toEqual({ route: 'public' });
    expect(await localResponse.json()).toEqual({ route: 'local' });
    expect(device.localCalls()).toHaveLength(1);
    expect(device.publicCalls()).toHaveLength(2);
    expect(device.unknownCalls()).toHaveLength(2);
    expect(device.unknownCalls()[0]?.body).toContain(canary.value);
    expect(device.unknownCalls()[1]?.url).toStartWith('blob:');
    expect(device.calls().map(({ destination, method }) => [destination, method])).toEqual([
      ['public', 'POST'], ['public', 'POST'], ['local', 'POST'], ['unknown', 'POST'], ['unknown', 'GET'],
    ]);
    expect(device.calls()[2]?.headers).toMatchObject({ 'x-scenario': 'local-fallback' });
    const publicLeaks = scanSecretCanaries([canary], device.publicCalls().map((call) => ({
      path: call.url,
      content: call.body ?? '',
      kind: 'evidence' as const,
    })));
    expect(publicLeaks.verdict).toBe('leaked');
    expect(scanSecretCanaries([canary], device.publicCalls().slice(1).map((call) => ({
      path: call.url,
      content: call.body ?? '',
      kind: 'evidence' as const,
    }))).verdict).toBe('clean');
  } finally {
    device.restore();
  }
  expect(globalThis.fetch).toBe(fetchBeforeInstall);
});

test('fake data-guard boundary rejects non-HTTP origins before installation', () => {
  expect(() => createFakeDataGuardBoundaryDevice({
    localOrigins: ['file:///tmp/approved-local'],
    publicOrigins: ['https://api.openai.com'],
  })).toThrow('must use HTTP or HTTPS origins');
});

test('fake data-guard boundary is catalogued as an explicit HTTP boundary device', () => {
  const catalog = loadMockScenarioCatalog();
  const device = catalog.devices.find((entry) => entry.id === 'fake-data-guard-boundary');
  expect(device?.implementation).toEqual(['src/ux-sim/fake-data-guard-boundary.ts']);
  expect(device?.tests).toContain('src/ux-sim/fake-data-guard-boundary.test.ts');
  expect(catalog.sourceModules.find((module) => module.path === 'src/ux-sim/fake-data-guard-boundary.ts')?.deviceIds)
    .toContain('fake-data-guard-boundary');
});
