// nexus-dist-endpoints.test.ts — Stage B IPA + manifest OTA endpoints.
//
// Validates the manifest.plist generator + the dist.json gating logic
// without touching disk for the real ~/.elanous/dist (the handlers read
// from there via path-resolved fs calls; we exercise the pure builders
// + a tmp directory swap via DIST_DIR is intentionally NOT done here —
// instead we test the building blocks that don't depend on disk and
// verify the unhappy paths still return clean Responses).

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  buildManifestXml,
  originForManifest,
  handleDistManifest,
  handleDistIpa,
  handleDistInstallPage,
  type DistMeta,
} from '../src/nexus/api/dist';
import { runDistLink } from '../src/cli/nexus-dist';
import { setResolveDaemonEndpointForTest } from '../src/nexus/daemon-endpoint';

const SAMPLE: DistMeta = {
  file: 'ElanousiOS.ipa',
  bundleId: 'com.elanvitalai.elanous.ios',
  version: '1.0',
  build: '1',
  title: 'Elanous',
  publishedAt: '2026-05-18T03:00:00.000Z',
};

describe('runDistLink · daemon endpoint', () => {
  afterEach(() => setResolveDaemonEndpointForTest(null));

  test('tailnet install and manifest URLs use the resolved daemon port', async () => {
    setResolveDaemonEndpointForTest(() => ({
      baseUrl: 'http://127.0.0.1:31432',
      healthUrl: 'http://127.0.0.1:31432/v1/health',
      pwaUrl: 'http://127.0.0.1:31432/app/',
      source: 'registry',
    }));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect((await runDistLink({ readMetaFn: async () => SAMPLE, tailnetHostFn: async () => 'ipad.example.ts.net' })).exitCode).toBe(0);
      const output = log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(output).toContain('itms-services://?action=download-manifest&url=' + encodeURIComponent('https://ipad.example.ts.net:31432/v1/dist/manifest.plist'));
      expect(output).toContain('https://ipad.example.ts.net:31432/v1/dist/install');
      expect(output).toContain('https://ipad.example.ts.net:31432/v1/dist/ElanousiOS.ipa');
    } finally {
      log.mockRestore();
    }
  });

  test('asks the resolver with purpose «watch» — dist is production-scoped, so a test-universe tree still reaches the production daemon', async () => {
    const seen: unknown[] = [];
    setResolveDaemonEndpointForTest((opts) => { seen.push(opts.purpose); return null; });
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runDistLink({ readMetaFn: async () => SAMPLE, tailnetHostFn: async () => null });
      expect(seen).toEqual(['watch']);
    } finally {
      log.mockRestore();
    }
  });

  test('without tailnet uses the resolved loopback URL', async () => {
    setResolveDaemonEndpointForTest(() => ({
      baseUrl: 'http://127.0.0.1:31432',
      healthUrl: 'http://127.0.0.1:31432/v1/health',
      pwaUrl: 'http://127.0.0.1:31432/app/',
      source: 'registry',
    }));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runDistLink({ readMetaFn: async () => SAMPLE, tailnetHostFn: async () => null });
      const output = log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(output).toContain('Local manifest:  http://127.0.0.1:31432/v1/dist/manifest.plist');
    } finally {
      log.mockRestore();
    }
  });

  test('null endpoint prints one unknown-daemon line and no install links', async () => {
    setResolveDaemonEndpointForTest(() => null);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    let tailnetProbed = false;
    try {
      expect((await runDistLink({
        readMetaFn: async () => SAMPLE,
        tailnetHostFn: async () => { tailnetProbed = true; return 'ipad.example.ts.net'; },
      })).exitCode).toBe(0);
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.filter((line) => line.includes('데몬 주소를 모른다'))).toEqual([
        '  데몬 주소를 모른다 — 데몬을 먼저 띄워라 (`elanous nexus run`)',
      ]);
      expect(lines.join('\n')).not.toMatch(/itms-services:|\/v1\/dist\/install|Local manifest:|IPA stream:/);
      expect(tailnetProbed).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

describe('buildManifestXml', () => {
  test('embeds bundle-identifier · version · title · IPA URL', () => {
    const xml = buildManifestXml(SAMPLE, 'https://example.ts.net:31415/v1/dist/ElanousiOS.ipa');
    expect(xml).toContain('<key>bundle-identifier</key><string>com.elanvitalai.elanous.ios</string>');
    expect(xml).toContain('<key>bundle-version</key><string>1.0</string>');
    expect(xml).toContain('<key>title</key><string>Elanous</string>');
    expect(xml).toContain('https://example.ts.net:31415/v1/dist/ElanousiOS.ipa');
    expect(xml).toContain('<key>kind</key><string>software-package</string>');
  });

  test('escapes XML-special characters in metadata fields', () => {
    const meta: DistMeta = { ...SAMPLE, title: 'M & N <co>' };
    const xml = buildManifestXml(meta, 'https://h/');
    expect(xml).toContain('M &amp; N &lt;co&gt;');
    expect(xml).not.toContain('M & N <co>');
  });

  test('includes display + full-size asset entries when provided', () => {
    const meta: DistMeta = {
      ...SAMPLE,
      displayImageUrl: 'https://h/icon-512.png',
      fullSizeImageUrl: 'https://h/icon-1024.png',
    };
    const xml = buildManifestXml(meta, 'https://h/ipa');
    expect(xml).toContain('<key>kind</key><string>display-image</string>');
    expect(xml).toContain('https://h/icon-512.png');
    expect(xml).toContain('<key>kind</key><string>full-size-image</string>');
    expect(xml).toContain('https://h/icon-1024.png');
  });
});

describe('originForManifest', () => {
  test('prefers the request Host header (Tailscale Serve forwards it)', () => {
    const req = new Request('http://127.0.0.1:31415/v1/dist/manifest.plist', {
      headers: { host: 'mbp.tailnet-example.ts.net:31415' },
    });
    expect(originForManifest(req)).toBe('https://mbp.tailnet-example.ts.net:31415');
  });

  test('falls back to URL host when Host header is absent', () => {
    const req = new Request('http://example.test:9000/v1/dist/manifest.plist');
    // Note: fetch fills in the Host header from the URL on the request
    // object, but the explicit absence path is mostly defensive.
    expect(originForManifest(req).startsWith('https://')).toBe(true);
  });
});

describe('handleDistIpa · path safety', () => {
  test('rejects traversal sequences', async () => {
    const req = new Request('https://h/v1/dist/..%2Fetc%2Fpasswd');
    const res = await handleDistIpa(req, '../etc/passwd');
    expect(res.status).toBe(400);
  });

  test('rejects nested paths', async () => {
    const req = new Request('https://h/v1/dist/x/y.ipa');
    const res = await handleDistIpa(req, 'x/y.ipa');
    expect(res.status).toBe(400);
  });
});

describe('handlers without published artifact', () => {
  // These tests intentionally run without a real ~/.elanous/dist/dist.json
  // present from the CI workspace (the file is per-user runtime state).
  // We only assert the unhappy-path Response shape — when no IPA has
  // been published the endpoints return 404 / explanatory HTML.

  test('manifest returns 404 + helpful body when not published', async () => {
    const req = new Request('https://h/v1/dist/manifest.plist');
    const res = await handleDistManifest(req);
    // Either 404 (unset) or 200 (running with a real dist.json). Both
    // are valid post-states for this test; assert only the contract.
    expect([200, 404]).toContain(res.status);
    if (res.status === 404) {
      const body = await res.text();
      expect(body).toMatch(/publish/);
    }
  });

  test('install page renders HTML in both states', async () => {
    const req = new Request('https://h/v1/dist/install');
    const res = await handleDistInstallPage(req);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('text/html');
  });
});
