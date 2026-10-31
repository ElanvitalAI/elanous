import { expect, test } from 'bun:test';
import { verifyServiceKey } from '../setup/service-keys.js';
import { startFakeOpenAiCompatibleApi, type FakeOpenAiApiMode } from './service-key-setup.js';

test('first-run key verifier uses the configured OpenAI-compatible endpoint and classifies server outcomes safely', async () => {
  const cases: Array<[FakeOpenAiApiMode, string]> = [
    ['ok', 'verified'],
    ['unauthorized', 'invalid'],
    ['rate-limited', 'rate-limited'],
    ['disconnect', 'unavailable'],
    ['slow', 'unavailable'],
  ];
  for (const [mode, result] of cases) {
    const server = await startFakeOpenAiCompatibleApi(mode);
    try {
      const secret = `sentinel-${mode}-key-value`;
      const verification = await verifyServiceKey('openai-api', secret, {
        baseUrl: server.baseUrl,
        timeoutMs: 100,
      });
      expect(verification.result).toBe(result);
      expect(server.requests()).toBe(1);
      expect(JSON.stringify(verification)).not.toContain(secret);
    } finally { await server.close(); }
  }
});
