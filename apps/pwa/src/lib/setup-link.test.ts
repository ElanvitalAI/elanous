import { describe, expect, test } from 'bun:test';
import { claimSetupLink, readSetupLinkToken } from './setup-link';

const linkToken = 'els_Example123_-';
const bearer = 'secret-bearer-value';

function mockResponse(status: number, body: unknown = null) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('readSetupLinkToken', () => {
  test('accepts only a standalone #t=els_ token', () => {
    expect(readSetupLinkToken(`#t=${linkToken}`)).toBe(linkToken);
    for (const hash of ['', '#bearer-token', '#t=secret', '#t=els_', '#t=els_a&extra=1',
      '#other=1&t=els_a', '#t=els_a%26x', '#t=els_a/b', '#T=els_a']) {
      expect(readSetupLinkToken(hash)).toBeNull();
    }
  });
});

describe('claimSetupLink', () => {
  test('posts a one-time link and returns only the setup bearer and expiry', async () => {
    const mock = mockResponse(200, { scope: 'setup', bearer, expiresAt: 12345, token: linkToken });
    expect(await claimSetupLink('https://nexus.example/', linkToken, mock.fetchImpl)).toEqual({
      status: 'claimed', bearer, expiresAt: 12345,
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe('https://nexus.example/v1/setup/claim');
    expect(mock.calls[0]!.init.method).toBe('POST');
    expect(mock.calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(mock.calls[0]!.init.body as string)).toEqual({ t: linkToken });
  });

  test('maps unsupported endpoint statuses without leaking a token', async () => {
    for (const status of [404, 405]) {
      const mock = mockResponse(status, { error: linkToken });
      const result = await claimSetupLink('https://nexus.example', linkToken, mock.fetchImpl);
      expect(result).toEqual({ status: 'unsupported' });
      expect(JSON.stringify(result)).not.toContain(linkToken);
    }
  });

  test('rejects non-setup claims, malformed claims and other failures', async () => {
    for (const response of [
      mockResponse(200, { scope: 'admin', bearer, expiresAt: 12345 }),
      mockResponse(200, { scope: 'setup', bearer: '', expiresAt: 12345 }),
      mockResponse(200, { scope: 'setup', bearer, expiresAt: 'tomorrow' }),
      mockResponse(401, { error: linkToken }),
    ]) {
      expect(await claimSetupLink('https://nexus.example', linkToken, response.fetchImpl))
        .toEqual({ status: 'invalid' });
    }
    const mock = mockResponse(200, { scope: 'setup', bearer, expiresAt: 12345 });
    expect(await claimSetupLink('https://nexus.example', 'bad-token', mock.fetchImpl))
      .toEqual({ status: 'invalid' });
    expect(mock.calls).toHaveLength(0);
  });

  test('does not propagate a fetch error containing a link secret', async () => {
    const failingFetch = (async () => { throw new Error(linkToken); }) as unknown as typeof fetch;
    expect(await claimSetupLink('https://nexus.example', linkToken, failingFetch))
      .toEqual({ status: 'invalid' });
  });
});
