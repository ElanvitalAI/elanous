import { expect, test } from 'bun:test';
import { ElanousAwarePeers } from './elanous-aware-peers.js';

const awareCaps = { _meta: { elanous: { ui: { showToast: true } } } };

test('initialize awareness is per connection even when two peers share a session', () => {
  const aware = {};
  const plain = {};
  const attached = new Map([['shared', new Set([aware, plain])]]);
  const peers = new ElanousAwarePeers(attached);
  peers.markPeer(aware, awareCaps);
  peers.markPeer(plain, {});
  expect(peers.isElanousAware('shared')).toBe(true);
  expect(peers.isPeerAware(aware)).toBe(true);
  expect(peers.isPeerAware(plain)).toBe(false);
  attached.set('shared', new Set([plain]));
  expect(peers.isElanousAware('shared')).toBe(false);
  expect(peers.isElanousAware('missing')).toBe(false);
});

test('only an object in initialize capabilities marks a peer aware', () => {
  const peer = {};
  const attached = new Map([['session', new Set([peer])]]);
  const peers = new ElanousAwarePeers(attached);
  peers.markPeer(peer, { _meta: { elanous: {} } });
  expect(peers.isElanousAware('session')).toBe(true);
  for (const value of [undefined, null, 'yes', [], true]) {
    peers.markPeer(peer, { _meta: { elanous: value } });
    expect(peers.isElanousAware('session')).toBe(false);
  }
});
