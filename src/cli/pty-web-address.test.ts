import { expect, test } from 'bun:test';
import { ptyWebAddress, resolvePtyWebAddress, formatPtyWebAddress } from './pty-web-address.js';
import type { PwaInstanceListing } from './pwa-registry.js';

const id = 'codex_12345678';
const tailnet = { status: 'registered' as const, loopback: 'http://127.0.0.1:31415/app/', url: 'https://host.ts.net/app/', source: 'tailnet' as const };

test('tailnet resolution uses the selected URL for a direct PTY link', () => {
  const address = resolvePtyWebAddress(id, () => tailnet);
  expect(address).toEqual({ webUrl: 'https://host.ts.net/app/term?pty=codex_12345678', webUrlSource: 'tailnet', pwaUnavailableReason: null });
  expect(formatPtyWebAddress(address)).toBe('https://host.ts.net/app/term?pty=codex_12345678 (tailnet)');
});

test('unavailable resolution and a throwing resolver return null URLs with a named reason', () => {
  expect(resolvePtyWebAddress(id, () => ({ status: 'absent', reason: 'daemon-absent' }), {
    listFn: () => [],
    lifecycleFn: () => null,
    productionRootFn: () => '/production/empty',
  })).toEqual({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'daemon-absent' });
  expect(resolvePtyWebAddress(id, () => { throw new Error('registry unavailable'); }))
    .toEqual({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'pwa-query-failed' });
});

test('watch link uses the production daemon when this universe is daemon-absent', () => {
  const productionRoot = '/production/elanous';
  const address = resolvePtyWebAddress('pty-1', () => ({ status: 'absent', reason: 'daemon-absent' }), {
    cwd: '/isolated/project',
    nexusRootFn: () => '/isolated/nexus',
    listForCwdFn: (cwd) => cwd === productionRoot ? [{ cwd: productionRoot, ports: [4455] } as PwaInstanceListing] : [],
    lifecycleFn: () => null,
    productionRootFn: () => productionRoot,
  });
  const formatted = formatPtyWebAddress(address);
  expect(formatted.startsWith('http://127.0.0.1:4455/')).toBe(true);
  expect(formatted).toContain('production daemon');
  expect(formatted).not.toContain('web unavailable');
  expect(formatted).not.toContain('web-unavailable');
});

test('shared address matches the resolver-selected PTY link', () => {
  const selected = ptyWebAddress(id, tailnet);
  expect(selected.webUrl).toBe('https://host.ts.net/app/term?pty=codex_12345678');
  expect(resolvePtyWebAddress(id, () => tailnet)).toEqual(selected);
  expect(formatPtyWebAddress(selected)).toBe('https://host.ts.net/app/term?pty=codex_12345678 (tailnet)');
});
