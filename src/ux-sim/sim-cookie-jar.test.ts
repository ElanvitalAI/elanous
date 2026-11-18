import { expect, test } from 'bun:test';
import { createSimCookieJar } from './sim-cookie-jar.js';

test('sim cookie jar follows browser host, path, secure, prefix and expiry rules', () => {
  let now = Date.parse('2026-11-17T00:00:00Z');
  const jar = createSimCookieJar(() => now);
  const api = new URL('https://members.example.test/v1/members');
  jar.store(api, '__Host-session=s1; Path=/; Secure; HttpOnly; SameSite=Lax');
  jar.store(api, '__Host-bad=x; Path=/v1; Secure'); // __Host- requires Path=/.
  jar.store(new URL('http://members.example.test/'), 'plain=x; Secure'); // Secure needs https.
  jar.store(api, 'scoped=1; Path=/v1/members/oauth; Max-Age=60');
  expect(jar.snapshot().map((cookie) => cookie.name)).toEqual(['__Host-session', 'scoped']);
  expect(jar.header(api)).toBe('__Host-session=s1');
  expect(jar.header(new URL('https://members.example.test/v1/members/oauth/google/callback'))).toBe('__Host-session=s1; scoped=1');
  expect(jar.header(new URL('https://app.example.test/v1/members'))).toBeUndefined(); // Host-only.
  expect(jar.header(new URL('http://members.example.test/v1/members'))).toBeUndefined(); // Secure.
  now += 61_000;
  expect(jar.header(new URL('https://members.example.test/v1/members/oauth/x'))).toBe('__Host-session=s1');
  jar.store(api, '__Host-session=; Path=/; Secure; Max-Age=0');
  expect(jar.header(api)).toBeUndefined();
});
