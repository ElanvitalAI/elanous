import { describe, expect, test } from 'bun:test';
import { buildFirstScreenBand } from './first-screen-band.js';

describe('buildFirstScreenBand', () => {
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
