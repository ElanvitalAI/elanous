import { describe, expect, test } from 'bun:test';
import { buildFirstScreenBand, resolveTuiDaemonLink } from './first-screen-band.js';
import type { TuiDaemonLink } from './first-screen-band.js';
import { setResolveDaemonEndpointForTest } from '../nexus/daemon-endpoint.js';

describe('resolveTuiDaemonLink', () => {
  const endpoint = () => ({
    baseUrl: 'http://127.0.0.1:31415',
    healthUrl: 'http://127.0.0.1:31415/v1/health',
    source: 'registry' as const,
  });

  test('probes the injected write endpoint and exposes only its origin in the band', async () => {
    const calls: unknown[] = [];
    const observations: unknown[] = [];
    const result = await resolveTuiDaemonLink({
      universe: () => 'test', endpoint,
      probe: async (url, init) => {
        calls.push([url, init]);
        return Response.json({ ok: true, testUniverse: true });
      },
      observe: (data) => observations.push(data),
    });
    expect(result).toEqual({ status: 'connected', address: 'http://127.0.0.1:31415' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['http://127.0.0.1:31415/v1/health', { signal: expect.any(AbortSignal) }]);
    expect(observations).toEqual([{ status: 'connected', stage: 'health', universe: 'test', source: 'registry' }]);
  });

  test('the default endpoint seam explicitly requests write rather than watch', async () => {
    const purposes: unknown[] = [];
    setResolveDaemonEndpointForTest((opts) => { purposes.push(opts.purpose); return null; });
    try {
      expect(await resolveTuiDaemonLink({ universe: () => 'test', observe: () => {} })).toEqual({
        status: 'absent', startCommand: 'elanous --test nexus run --hmr',
      });
      expect(purposes).toEqual(['write']);
    } finally {
      setResolveDaemonEndpointForTest(null);
    }
  });

  test('absence and unhealthy responses give universe-specific startup commands', async () => {
    expect(await resolveTuiDaemonLink({ universe: () => 'test', endpoint: () => null })).toEqual({
      status: 'absent', startCommand: 'elanous --test nexus run --hmr',
    });
    expect(await resolveTuiDaemonLink({ universe: () => 'prod', endpoint, probe: async () => Response.json({ ok: false }) })).toEqual({
      status: 'unhealthy', startCommand: 'elanous nexus run --hmr',
    });
    expect(await resolveTuiDaemonLink({ universe: () => 'test', endpoint, probe: async () => new Response('bad', { status: 503 }) })).toEqual({
      status: 'unhealthy', startCommand: 'elanous --test nexus run --hmr',
    });
  });

  test('reports the failing stage, never logs an endpoint or error body, and isolates observation errors', async () => {
    const observations: unknown[] = [];
    const observe = (data: unknown) => { observations.push(data); throw new Error('log failed'); };
    expect(await resolveTuiDaemonLink({ universe: () => 'prod', endpoint: () => { throw new Error('secret-endpoint'); }, observe }))
      .toEqual({ status: 'error', stage: 'endpoint' });
    expect(await resolveTuiDaemonLink({ universe: () => 'prod', endpoint, probe: async () => { throw new Error('secret-health'); }, observe }))
      .toEqual({ status: 'error', stage: 'health' });
    expect(await resolveTuiDaemonLink({ universe: () => 'prod', endpoint, probe: async () => Response.json({ ok: true, testUniverse: true }), observe }))
      .toEqual({ status: 'error', stage: 'identity' });
    expect(await resolveTuiDaemonLink({ universe: () => { throw new Error('secret-identity'); }, observe }))
      .toEqual({ status: 'error', stage: 'identity' });
    expect(JSON.stringify(observations)).not.toContain('secret');
    expect(JSON.stringify(observations)).not.toContain('http');
    expect(observations).toEqual([
      { status: 'error', stage: 'endpoint', universe: 'prod', source: 'none' },
      { status: 'error', stage: 'health', universe: 'prod', source: 'registry' },
      { status: 'error', stage: 'identity', universe: 'prod', source: 'registry' },
      { status: 'error', stage: 'identity', universe: 'unknown', source: 'none' },
    ]);
  });

  test('connected requires the daemon to state a matching universe; missing or non-boolean testUniverse is an identity error', async () => {
    const endpoint = () => ({ baseUrl: 'http://127.0.0.1:31415/', healthUrl: 'http://127.0.0.1:31415/v1/health', source: 'registry' as const });
    for (const body of [{ ok: true }, { ok: true, testUniverse: 'unknown' }, { ok: true, testUniverse: false }]) {
      expect(await resolveTuiDaemonLink({ universe: () => 'test', endpoint, probe: async () => Response.json(body), observe: () => {} }))
        .toEqual({ status: 'error', stage: 'identity' });
    }
    expect(await resolveTuiDaemonLink({ universe: () => 'prod', endpoint, probe: async () => Response.json({ ok: true }), observe: () => {} }))
      .toEqual({ status: 'error', stage: 'identity' });
    expect(await resolveTuiDaemonLink({ universe: () => 'prod', endpoint, probe: async () => Response.json({ ok: true, testUniverse: false }), observe: () => {} }))
      .toEqual({ status: 'connected', address: 'http://127.0.0.1:31415' });
  });

  test('a custom test root is named in the start command as one literal shell argument', async () => {
    expect(await resolveTuiDaemonLink({ universe: () => 'test', testRoot: () => '/tmp/my root/it\'s', endpoint: () => null, observe: () => {} }))
      .toEqual({ status: 'absent', startCommand: "elanous --test='/tmp/my root/it'\\''s' nexus run --hmr" });
    expect(await resolveTuiDaemonLink({ universe: () => 'test', testRoot: () => '/tmp/plain-root', endpoint: () => null, observe: () => {} }))
      .toEqual({ status: 'absent', startCommand: 'elanous --test=/tmp/plain-root nexus run --hmr' });
    for (const root of ['/tmp/a\nb', '/tmp/\u001b[2Jx', '/tmp/\u009bx']) {
      const link = await resolveTuiDaemonLink({ universe: () => 'test', testRoot: () => root, endpoint: () => null, observe: () => {} });
      expect(link).toEqual({ status: 'absent', startCommand: '' });
      expect(buildFirstScreenBand({ width: 120, daemon: false, link })[0]).toBe('elanous | 데몬: 없음');
    }
    expect(buildFirstScreenBand({ width: 120, daemon: false, link: { status: 'unhealthy', startCommand: 'elanous \u001b[31mx' } })[0])
      .toBe('elanous | 데몬: 응답 없음');
    expect(await resolveTuiDaemonLink({ universe: () => 'test', testRoot: () => { throw new Error('x'); }, endpoint: () => null, observe: () => {} }))
      .toEqual({ status: 'error', stage: 'identity' });
  });

  test('rejects malformed or credential-bearing endpoint URLs before probing', async () => {
    let probed = false;
    expect(await resolveTuiDaemonLink({
      universe: () => 'test',
      endpoint: () => ({ baseUrl: 'http://user:secret@127.0.0.1:31415/private', healthUrl: 'http://127.0.0.1:31415/v1/health', source: 'lifecycle' }),
      probe: async () => { probed = true; return Response.json({ ok: true }); },
    })).toEqual({ status: 'error', stage: 'endpoint' });
    expect(probed).toBe(false);
    expect(await resolveTuiDaemonLink({
      universe: () => 'test',
      endpoint: () => ({ baseUrl: 'http://127.0.0.1:31415', healthUrl: 'http://127.0.0.1:31415/v1/health?token=secret', source: 'lifecycle' }),
      probe: async () => { probed = true; return Response.json({ ok: true }); },
    })).toEqual({ status: 'error', stage: 'endpoint' });
    expect(probed).toBe(false);
  });
});

describe('buildFirstScreenBand', () => {
  test('renders the Korean zero row for each injected link without altering the other rows', () => {
    const base = buildFirstScreenBand({ width: 100, daemon: false });
    const cases = [
      [{ status: 'checking' }, 'elanous | 데몬: 확인 중'],
      [{ status: 'connected', address: 'http://127.0.0.1:31415' }, 'elanous | 데몬: 연결됨 (http://127.0.0.1:31415)'],
      [{ status: 'absent', startCommand: 'elanous nexus run --hmr' }, 'elanous | 데몬: 없음 · 시작: elanous nexus run --hmr'],
      [{ status: 'unhealthy', startCommand: 'elanous --test nexus run --hmr' }, 'elanous | 데몬: 응답 없음 · 시작: elanous --test nexus run --hmr'],
      [{ status: 'error', stage: 'health' }, 'elanous | 데몬: health 조회 오류'],
    ] as const satisfies ReadonlyArray<readonly [TuiDaemonLink, string]>;
    for (const [link, expected] of cases) {
      const lines = buildFirstScreenBand({ width: 100, daemon: false, link });
      expect(lines).toEqual([expected, base[1], base[2]]);
    }
    const secretAddress = 'https://user:secret@example.ts.net:31415/private?token=secret';
    const narrow = buildFirstScreenBand({ width: 25, daemon: false, link: { status: 'connected', address: secretAddress } });
    expect(narrow[0]).toBe('elanous | 데몬: 연결됨');
    expect(narrow.join('\n')).not.toContain('secret');
    expect(buildFirstScreenBand({ width: 25, daemon: false, link: { status: 'connected', address: 'http://long.hostname.example:31415' } })[0])
      .toBe('elanous | 데몬: 연결됨');
  });

  test('uses terminal cells for Hangul and never renders a partial daemon address or command', () => {
    const connected: TuiDaemonLink = { status: 'connected', address: 'http://127.0.0.1:31415' };
    const absent: TuiDaemonLink = { status: 'absent', startCommand: 'elanous nexus run --hmr' };
    expect(buildFirstScreenBand({ width: 47, daemon: false, link: connected })[0])
      .toBe('elanous | 데몬: 연결됨 (http://127.0.0.1:31415)');
    expect(buildFirstScreenBand({ width: 46, daemon: false, link: connected })[0])
      .toBe('elanous | 데몬: 연결됨');
    expect(buildFirstScreenBand({ width: 56, daemon: false, link: absent })[0])
      .toBe('elanous | 데몬: 없음 · 시작: elanous nexus run --hmr');
    expect(buildFirstScreenBand({ width: 40, daemon: false, link: absent })[0])
      .toBe('elanous | 데몬: 없음');
    expect(buildFirstScreenBand({ width: 15, daemon: false, link: connected })[0])
      .toBe('elanous | 데몬:');
  });

  test('renders three startup lines with a daemon state, PWA location and entry hint', () => {
    expect(buildFirstScreenBand({ width: 80, daemon: true, pwa: { loopback: 'http://127.0.0.1:3460' } })).toEqual([
      'elanous | daemon: online',
      'PWA: http://127.0.0.1:3460',
      'Type a message to begin | /help for commands',
    ]);
  });

  test('distinguishes unchecked PWA status from checked but unavailable addresses', () => {
    expect(buildFirstScreenBand({ width: 80, daemon: false })).toEqual([
      'elanous | daemon: offline',
      'PWA: not checked',
      'Type a message to begin | /help for commands',
    ]);
    expect(buildFirstScreenBand({ width: 80, daemon: false, pwa: {} })[1]).toBe('PWA: unavailable');
  });

  test('selects tailnet before lan before loopback, falling back when an address is absent', () => {
    const pwa = {
      tailnet: 'https://host.tailnet.ts.net:3460',
      lan: 'http://192.168.1.5:3460',
      loopback: 'http://127.0.0.1:3460',
    };
    expect(buildFirstScreenBand({ width: 80, daemon: true, pwa })[1]).toBe('PWA: https://host.tailnet.ts.net:3460');
    expect(buildFirstScreenBand({ width: 80, daemon: true, pwa: { ...pwa, tailnet: null } })[1])
      .toBe('PWA: http://192.168.1.5:3460');
    expect(buildFirstScreenBand({ width: 80, daemon: true, pwa: { loopback: pwa.loopback } })[1])
      .toBe('PWA: http://127.0.0.1:3460');
  });

  test('limits every line to the available width without truncating an address', () => {
    const address = 'https://very-long-tailnet-host.tailnet.ts.net:3460';
    const narrow = buildFirstScreenBand({ width: 24, daemon: true, pwa: { tailnet: address } });
    expect(narrow).toHaveLength(3);
    expect(narrow.every((line) => line.length <= 24)).toBe(true);
    expect(narrow[1]).toBe('PWA: address available');
    expect(narrow.join('\n')).not.toContain(address.slice(0, 15));
    const wide = buildFirstScreenBand({ width: 80, daemon: true, pwa: { tailnet: address } });
    expect(wide[1]).toBe(`PWA: ${address}`);
  });

  test('preserves the complete /app/ PWA URL when it fits', () => {
    expect(buildFirstScreenBand({ width: 80, daemon: true, pwa: { tailnet: 'https://host.tailnet.ts.net:3460/app/' } })[1])
      .toBe('PWA: https://host.tailnet.ts.net:3460/app/');
  });

  test('never exposes URL credentials, tokens in paths, query or fragments', () => {
    const output = buildFirstScreenBand({
      width: 120,
      daemon: true,
      pwa: { tailnet: 'https://user:secret@host.tailnet.ts.net:3460/private-token?token=query-secret#fragment-secret' },
    }).join('\n');
    expect(output).toContain('PWA: https://host.tailnet.ts.net:3460');
    for (const secret of ['user', 'secret', 'private-token', 'query-secret', 'fragment-secret']) {
      expect(output).not.toContain(secret);
    }
  });
});
