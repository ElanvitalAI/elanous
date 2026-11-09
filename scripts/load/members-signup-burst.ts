/** Isolated member signup burst. No production URL or Google credentials are used. */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createGoogleSignin } from '../../src/nexus/members/google-signin.js';
import { createMemberStore } from '../../src/nexus/members/member-store.js';
import { createMembersApi } from '../../src/nexus/members/members-api.js';
import { createFakeGoogleOAuthWorld, FAKE_GOOGLE_ISSUER } from '../../src/ux-sim/fake-google-oauth.js';

const count = Number(process.argv.find(arg => arg.startsWith('--count='))?.split('=')[1] ?? 300);
const sharedCount = Number(process.argv.find(arg => arg.startsWith('--shared-count='))?.split('=')[1] ?? count);
if (!Number.isSafeInteger(count) || count < 1 || count > 10_000 || !Number.isSafeInteger(sharedCount)
  || sharedCount < 0 || sharedCount > count) throw new Error('invalid count or shared-count');

const root = mkdtempSync(join(tmpdir(), 'elanous-member-burst-'));
const dbPath = join(root, 'members.sqlite');
const redirectUri = 'https://api.example.test/v1/members/oauth/google/callback';
const now = () => Date.parse('2026-11-14T01:00:00.000Z');
const store = createMemberStore({ path: dbPath, now });
store.provisionEventCode({ code: 'KAIST-2026', maxUses: count });
const expectedByState = new Map<string, number>();
const world = createFakeGoogleOAuthWorld({
  clientId: 'member-burst-test', redirectUri,
  identity: url => {
    const index = expectedByState.get(url.searchParams.get('state') ?? '');
    if (index === undefined) throw new Error('authorization state has no expected attendee');
    return { sub: `burst-google-${index}`, email: `burst-${index}@example.test`,
      emailVerified: true, name: `Burst Member ${index}` };
  },
});
const google = createGoogleSignin({
  clientId: async () => 'member-burst-test',
  clientSecret: async () => 'fake-google-client-secret',
  stateEncryptionKey: async () => 'burst-only-state-encryption-key',
  redirectUri, store, fetch: world.fetch, now,
  authorizationEndpoint: `${FAKE_GOOGLE_ISSUER}/o/oauth2/v2/auth`,
  tokenEndpoint: `${FAKE_GOOGLE_ISSUER}/token`,
  userinfoEndpoint: `${FAKE_GOOGLE_ISSUER}/userinfo`,
});
const api = createMembersApi({ store, google, successRedirectUri: 'https://app.example.test/signup/complete', now });

type Result = { start: number; callback?: number; profile?: number; startMs: number; googleMs?: number; callbackMs?: number; totalMs: number; error?: string };
const elapsed = (from: number) => Math.round((performance.now() - from) * 100) / 100;
const percentile = (values: number[], fraction: number): number | null => values.length
  ? [...values].sort((a: number, b: number) => a - b)[Math.ceil(values.length * fraction) - 1]! : null;
const counts = (values: number[]) => Object.fromEntries([...new Set(values)].sort((a, b) => a - b)
  .map(value => [value, values.filter(item => item === value).length]));

async function signup(index: number): Promise<Result> {
  const startedAt = performance.now();
  const networkKey = index < sharedCount ? '203.0.113.42' : `198.51.${Math.floor(index / 254)}.${index % 254 + 1}`;
  try {
    const start = (await api.handle(new Request('https://api.example.test/v1/members', {
      method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, eventCode: 'KAIST-2026' }),
    }), networkKey))!;
    const startMs = elapsed(startedAt);
    if (start.status !== 201) return { start: start.status, startMs, totalMs: elapsed(startedAt) };
    const { authorizationUrl } = await start.json() as { authorizationUrl: string };
    expectedByState.set(new URL(authorizationUrl).searchParams.get('state')!, index);
    const googleAt = performance.now();
    const { code, state } = world.authorize(authorizationUrl);
    const googleMs = elapsed(googleAt);
    const callbackAt = performance.now();
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0]!;
    const callback = (await api.handle(new Request(`${redirectUri}?code=${code}&state=${state}`, {
      headers: { cookie: stateCookie },
    })))!;
    const callbackMs = elapsed(callbackAt);
    if (callback.status !== 303) return { start: start.status, callback: callback.status, startMs, googleMs, callbackMs, totalMs: elapsed(startedAt) };
    const sessionCookie = callback.headers.get('set-cookie')!.split(';', 1)[0]!;
    const profile = (await api.handle(new Request('https://api.example.test/v1/members', {
      headers: { cookie: sessionCookie },
    })))!;
    const profileBody = profile.status === 200 ? await profile.json() as { member?: { email?: string } } : null;
    const error = profileBody?.member?.email === `burst-${index}@example.test`
      ? undefined : `attendee ${index} received a mismatched member profile`;
    return { start: start.status, callback: callback.status, profile: profile.status,
      startMs, googleMs, callbackMs, totalMs: elapsed(startedAt), error };
  } catch (error) {
    return { start: 0, startMs: elapsed(startedAt), totalMs: elapsed(startedAt), error: String(error) };
  }
}

try {
  const wallAt = performance.now();
  const results = await Promise.all(Array.from({ length: count }, (_, index) => signup(index)));
  const db = new Database(dbPath, { readonly: true });
  const rowCount = (table: string) => Number((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const rows = {
    members: rowCount('members'), consents: rowCount('member_consents'),
    sessions: rowCount('member_sessions'), starts: rowCount('member_oauth_start_attempts'),
    eventUses: rowCount('member_event_uses'),
  };
  db.close();
  const successful = results.filter(result => result.start === 201 && result.callback === 303
    && result.profile === 200 && !result.error).length;
  const summary = {
    universe: 'local isolated SQLite + fake Google', count, sharedCount,
    successful, successRate: successful / count, wallMs: elapsed(wallAt),
    p95Ms: {
      start: percentile(results.map(result => result.startMs), 0.95),
      callback: percentile(results.flatMap(result => result.callbackMs === undefined ? [] : [result.callbackMs]), 0.95),
      total: percentile(results.map(result => result.totalMs), 0.95),
    },
    statuses: { start: counts(results.map(result => result.start)),
      callback: counts(results.flatMap(result => result.callback === undefined ? [] : [result.callback])),
      profile: counts(results.flatMap(result => result.profile === undefined ? [] : [result.profile])) },
    http409: results.filter(result => [result.start, result.callback, result.profile].includes(409)).length,
    http429: results.filter(result => [result.start, result.callback, result.profile].includes(429)).length,
    rows, errors: results.flatMap(result => result.error ? [result.error] : []).slice(0, 5),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (successful !== count || rows.members !== count || rows.consents !== 2 * count
    || rows.sessions !== count || rows.eventUses !== count) process.exitCode = 1;
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
