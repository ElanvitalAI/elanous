import { expect, test } from 'bun:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { isPrivateIpv4, pickLanAddress, isLanReachableBind } from './lan-address.js';

const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address, family: 'IPv4', internal, netmask: '255.255.255.0', cidr: `${address}/24`, mac: '00:00:00:00:00:00',
});

test('only RFC1918 IPv4 ranges count as private LAN addresses', () => {
  for (const address of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.12']) expect(isPrivateIpv4(address)).toBe(true);
  for (const address of ['100.64.0.1', '100.101.1.2', '169.254.1.2', '127.0.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '10.1.1.999', '10.1.1.1x', '::1']) expect(isPrivateIpv4(address)).toBe(false);
});

test('default-route interface wins over alphabetical order, excluding tunnel and internal addresses', () => {
  expect(pickLanAddress({ interfaces: { utun3: [ipv4('100.101.1.2')], en0: [ipv4('192.168.0.12')], lo0: [ipv4('10.0.0.1', true)] }, defaultRouteInterface: 'en0' })).toBe('192.168.0.12');
  expect(pickLanAddress({ interfaces: { en0: [ipv4('10.0.0.5')], en7: [ipv4('192.168.1.20')] }, defaultRouteInterface: 'en7' })).toBe('192.168.1.20');
});

test('lookup failure falls back to first named private interface; no candidate yields null', () => {
  expect(pickLanAddress({ interfaces: { en7: [ipv4('192.168.1.20')], en0: [ipv4('10.0.0.5')] }, defaultRouteInterface: () => { throw Error('route failed'); } })).toBe('10.0.0.5');
  expect(pickLanAddress({ interfaces: { en0: [ipv4('100.64.1.1')] } })).toBeNull();
});

test('only wildcard, empty and private binds are LAN reachable', () => {
  for (const host of ['', '0.0.0.0', '::', '[::]', '10.0.0.5', '172.16.1.1', '192.168.1.20']) expect(isLanReachableBind(host)).toBe(true);
  for (const host of ['127.0.0.1', 'localhost', '100.101.1.2', '169.254.1.2']) expect(isLanReachableBind(host)).toBe(false);
});
