import { expect, test } from 'bun:test';
import { publicReportHost, submitPublicAppReport } from '@/lib/public-app-report';

test('report page accepts only an app hostname and sends a category without credentials', async () => {
  expect(publicReportHost('notes--alice.elanous.app')).toBe('notes--alice.elanous.app');
  for (const unsafe of [
    'https://notes--alice.elanous.app/path?token=emt_secret',
    'notes--alice.elanous.app?token=emt_secret',
    'user:pass@notes--alice.elanous.app',
    'notes--alice.elanous.app.evil.test',
  ]) expect(publicReportHost(unsafe)).toBeNull();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  expect(await submitPublicAppReport('notes--alice.elanous.app', 'phishing', fakeFetch)).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://notes--alice.elanous.app/.well-known/elanous/report');
  expect(calls[0]!.init.credentials).toBe('omit');
  expect(calls[0]!.init.referrerPolicy).toBe('no-referrer');
  expect(calls[0]!.init.body).toBe(JSON.stringify({ category: 'phishing' }));
  expect(JSON.stringify(calls)).not.toContain('emt_secret');
});
