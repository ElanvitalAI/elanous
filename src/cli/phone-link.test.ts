import { describe, expect, test } from 'bun:test';
import { androidDeliverySteps, buildPhoneConnectLink, endpointFromBaseUrl, pickPhoneBase } from './phone-link.js';

describe('phone link', () => {
  test('reads host/port/tls from a REST base', () => {
    expect(endpointFromBaseUrl('https://mbp.example.ts.net:31415/v1/')).toEqual({ host: 'mbp.example.ts.net', port: 31415, tls: true });
    expect(endpointFromBaseUrl('http://127.0.0.1:31415/v1/')).toEqual({ host: '127.0.0.1', port: 31415, tls: false });
    expect(endpointFromBaseUrl('https://host.example/v1/')).toEqual({ host: 'host.example', port: 443, tls: true });
    expect(endpointFromBaseUrl('not a url')).toBeNull();
    expect(endpointFromBaseUrl('ftp://x:21/')).toBeNull();
  });

  test('builds an elanous://connect link with the token encoded', () => {
    const link = buildPhoneConnectLink({ host: 'mbp.example.ts.net', port: 31415, tls: true }, 'a+b/c=');
    expect(link.startsWith('elanous://connect?')).toBe(true);
    const q = new URL(link).searchParams;
    expect(q.get('host')).toBe('mbp.example.ts.net');
    expect(q.get('port')).toBe('31415');
    expect(q.get('tls')).toBe('1');
    expect(q.get('token')).toBe('a+b/c=');
  });

  test('prefers tailnet for a real phone and loopback when --local or no tailnet', () => {
    const urls = { loopback: 'http://127.0.0.1:31415/v1/', tailnet: 'https://mbp.example.ts.net:31415/v1/' };
    expect(pickPhoneBase(urls)).toEqual({ base: urls.tailnet, kind: 'tailnet' });
    expect(pickPhoneBase(urls, { local: true })).toEqual({ base: urls.loopback, kind: 'loopback' });
    expect(pickPhoneBase({ loopback: urls.loopback })).toEqual({ base: urls.loopback, kind: 'loopback' });
  });

  test('android: adb reverse the port, then open the link quoted for the remote shell (& would split it)', () => {
    const link = buildPhoneConnectLink({ host: '127.0.0.1', port: 31415, tls: false }, 't&x');
    const [reverse, start] = androidDeliverySteps(link, 31415);
    expect(reverse).toEqual(['reverse', 'tcp:31415', 'tcp:31415']);
    expect(start).toContain('android.intent.action.VIEW');
    expect(start).toContain(`'${link}'`);
    expect(start!.at(-1)).toBe('com.elanvitalai.elanous.android');
    expect(androidDeliverySteps(link, 31415, 'R5KL')[0]!.slice(0, 2)).toEqual(['-s', 'R5KL']);
  });
});
