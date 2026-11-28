// KIT jev-decide — the one Jev call path. Fake transports / fake fetch only (no real HTTP · no key file · no live ledger).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JEV_ENDPOINT, JevHttpError, type JevRequest, type JevResponse } from '../../decide/jev.js';
import {
  BUILTIN_JEV_SITES_FILE, fileJevBreaker, isLoopbackEndpoint, jevDecide, jevErrorStatus, jevSite, jevSiteQuestion, jevSitesFrom, jevTopChoice,
  maskJevState, memoryJevBreaker, readJevSites, type JevBreakerCard, type JevDecideDeps,
} from './index.js';

const LOCAL = 'http://127.0.0.1:8787/v1/systemone';
const noul = { irreversible: { type: 'noul' as const, instructions: 'q?' } };
const ok = (over: Partial<JevResponse> = {}): JevResponse => ({ model: 'jev-fake', answers: { irreversible: { type: 'noul', noul: 0.1 } }, ...over });

function rig(over: Partial<JevDecideDeps> = {}) {
  const calls: JevRequest[] = [];
  const lines: Array<Record<string, unknown>> = [];
  const usage: Array<{ model: string; site: string }> = [];
  let accessReads = 0;
  const deps: JevDecideDeps = {
    peekEndpoint: () => JEV_ENDPOINT,
    resolveAccess: () => { accessReads += 1; return { ok: true, access: { endpoint: JEV_ENDPOINT, endpointSource: 'default', key: 'fake-not-a-key' } }; },
    callJev: async (req) => { calls.push(req); return ok({ usage: { input_tokens: 10, output_tokens: 0 } }); },
    log: (_e, d) => { lines.push(d); },
    logUsage: (model, _u, site) => { usage.push({ model, site }); },
    ...over,
  };
  return { deps, calls, lines, usage, accessReads: () => accessReads };
}

describe('site table (graphs/policies/jev-sites.yaml)', () => {
  test('the built-in table parses clean and names every migrated site', () => {
    const t = readJevSites([BUILTIN_JEV_SITES_FILE]);
    expect(t.problems).toEqual([]);
    for (const id of ['boundary-shadow', 'memory-write-gate', 'mail-route.hand-classify', 'tool-guard-axis']) expect(t.sites[id]?.declared).toBe(true);
    expect(t.sites['boundary-shadow']).toMatchObject({ usageSite: 'jev-boundary-shadow', audience: 'hq-seat', timeoutMs: 5_000, threshold: 0.7 }); // 출처: #40588 graphs/policies/jev-sites.yaml boundary-shadow row (pins the YAML value, not a bound)
    expect(t.sites['memory-write-gate']).toMatchObject({ usageSite: 'jev-memory-write-gate', audience: 'member', threshold: 0.6 }); // 출처: #40588 graphs/policies/jev-sites.yaml memory-write-gate row (pins the YAML value)
    expect(t.breaker).toEqual({ creditCooldownMs: 30 * 60_000, rateLimitCooldownMs: 60_000, cardTo: 'OP' });
  });

  test('invalid rows are dropped with a reason · options/levels refused · unknown site = strict defaults', () => {
    const t = jevSitesFrom({ version: 1, sites: { a: { audience: 'everyone', questions: {
      bad: { type: 'boolean', instructions: 'x' }, opt: { type: 'choice', instructions: 'x', options: ['a', 'b'] },
      one: { type: 'choice', instructions: 'x', criteria: ['only'] }, good: { type: 'choice', instructions: 'x', criteria: { y: 'yes', n: null } },
    } } } });
    expect(t.problems.length).toBe(4);
    expect(Object.keys(t.sites.a!.questions)).toEqual(['good']);
    expect(t.sites.a!.audience).toBe('member');
    expect(jevSite('nope', t)).toMatchObject({ usageSite: 'nope', audience: 'member', declared: false, questions: {} });
    expect(jevSitesFrom({ version: 2 }).problems[0]).toContain('version');
  });

  test('a choice question without YAML criteria takes per-call choices (≥2) — else undefined', () => {
    const site = jevSite('memory-write-gate', readJevSites([BUILTIN_JEV_SITES_FILE]));
    expect(jevSiteQuestion(site, 'dup')).toBeUndefined();
    expect(jevSiteQuestion(site, 'dup', { cand_1: null, none: null })).toMatchObject({ type: 'choice', criteria: { cand_1: null, none: null } });
    expect(jevSiteQuestion(site, 'scope')).toMatchObject({ type: 'choice', criteria: { seat: null, role: null, project: null, global: null } });
  });

  test('an override file replaces the top-level keys it names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-sites-'));
    const over = join(dir, 'jev-sites.yaml');
    writeFileSync(over, 'breaker:\n  creditCooldownMinutes: 5\n  cardTo: guardian\n');
    const t = readJevSites([BUILTIN_JEV_SITES_FILE, over]);
    expect(t.breaker).toMatchObject({ creditCooldownMs: 5 * 60_000, cardTo: 'GUARDIAN' });
    expect(t.sites['boundary-shadow']).toBeDefined();
  });
});

describe('jevDecide — built-ins', () => {
  test('ok: one request, usage row and one jev.decide line carry the usageSite', async () => {
    const r = rig();
    const out = await jevDecide({ site: 'boundary-shadow', state: { c: 'ls' }, questions: noul }, r.deps);
    expect(out.ok).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.usage).toEqual([{ model: 'jev-fake', site: 'jev-boundary-shadow' }]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ usageSite: 'jev-boundary-shadow', ok: true, model: 'jev-fake' });
  });

  test('every failure also leaves one line with the usageSite', async () => {
    const r = rig({ callJev: async () => { throw new Error('Jev HTTP 503: down'); } });
    const out = await jevDecide({ site: 'mail-route.hand-classify', state: { line: 'x' }, questions: noul }, r.deps);
    expect(out).toMatchObject({ ok: false, reason: 'request-failed', status: 503 });
    expect(r.lines).toEqual([expect.objectContaining({ usageSite: 'mail-route.hand-classify', ok: false, reason: 'request-failed' })]);
  });

  test('state is redacted (keys and free text) before it leaves; the input is unchanged', async () => {
    const r = rig();
    const state = { cmd: 'curl -H "Authorization: Bearer abcSECRET" https://x', meta: { password: 'pwSECRET' }, line: 'token=sk-abcdefghijklSECRET' };
    await jevDecide({ site: 'boundary-shadow', state, questions: noul }, r.deps);
    const sent = JSON.stringify(r.calls[0]);
    expect(sent).not.toContain('SECRET');
    expect(sent).toContain('[REDACTED]');
    expect(state.meta.password).toBe('pwSECRET');
    expect(maskJevState('git push --force origin main')).toBe('git push --force origin main');
  });

  test('member state goes only to a loopback IP — the key is not even read for a remote endpoint', async () => {
    const remote = rig();
    expect(await jevDecide({ site: 'memory-write-gate', state: {}, questions: noul, audience: 'member' }, remote.deps)).toMatchObject({ ok: false, reason: 'egress-not-allowed' });
    expect(remote.calls).toHaveLength(0);
    expect(remote.accessReads()).toBe(0);
    const local = rig({ peekEndpoint: () => LOCAL, resolveAccess: () => ({ ok: true, access: { endpoint: LOCAL, endpointSource: 'config' } }) });
    expect((await jevDecide({ site: 'memory-write-gate', state: {}, questions: noul, audience: 'member' }, local.deps)).ok).toBe(true);
    // the key read sees a different (remote) endpoint → refused on the real target
    const race = rig({ peekEndpoint: () => LOCAL });
    expect(await jevDecide({ site: 'memory-write-gate', state: {}, questions: noul, audience: 'member' }, race.deps)).toMatchObject({ ok: false, reason: 'egress-not-allowed' });
    expect(race.calls).toHaveLength(0);
    expect(isLoopbackEndpoint('http://localhost:8787/v1/systemone')).toBe(false);
    expect(isLoopbackEndpoint('http://[::1]:8787/v1/systemone')).toBe(true);
  });

  test('timeout aborts the in-flight request and redirects are refused', async () => {
    const inits: RequestInit[] = [];
    const r = rig({
      callJev: (_req, _key, fetchImpl, endpoint) => fetchImpl(endpoint, {}).then(() => ok()),
      fetch: ((_u: RequestInfo | URL, init?: RequestInit) => { inits.push(init!); return new Promise<Response>(() => {}); }) as typeof fetch,
    });
    // 출처: R-TST40 — 1ms is the injected «never answers» cut, not a wall-clock judgement
    expect(await jevDecide({ site: 'boundary-shadow', state: {}, questions: noul, timeoutMs: 1 }, r.deps)).toMatchObject({ ok: false, reason: 'timeout' });
    expect(inits[0]?.signal?.aborted).toBe(true);
    expect(inits[0]?.redirect).toBe('error');
  });

  test('no key → no call · no questions → no call · bun test without an injected call → no live call', async () => {
    const r = rig({ resolveAccess: () => ({ ok: false }) });
    expect(await jevDecide({ site: 'boundary-shadow', state: {}, questions: noul }, r.deps)).toMatchObject({ ok: false, reason: 'no-key' });
    expect(await jevDecide({ site: 'boundary-shadow', state: {}, questions: {} }, rig().deps)).toMatchObject({ ok: false, reason: 'no-question' });
    expect(await jevDecide({ site: 'boundary-shadow', state: {}, questions: noul }, { log: () => {} })).toMatchObject({ ok: false, reason: 'no-live-in-test' });
    expect(r.calls).toHaveLength(0);
  });

  test('status is read from JevHttpError or the «Jev HTTP n» prefix', () => {
    expect(jevErrorStatus(new JevHttpError(402, 'Jev HTTP 402: x'))).toBe(402);
    expect(jevErrorStatus(new Error('Jev HTTP 429: slow'))).toBe(429);
    expect(jevErrorStatus(new Error('boom'))).toBeUndefined();
    expect(jevTopChoice({ probabilities: { a: 0.2, b: 0.7 } })).toEqual({ word: 'b', p: 0.7 });
    expect(jevTopChoice({ choice: 'a' })).toEqual({ word: 'a', p: 1 });
  });
});

describe('402 circuit breaker', () => {
  test('402 → fallback, ONE card, and no further calls until the cooldown passes; success closes it', async () => {
    let t = 1_000_000;
    let status = 402;
    let sent = 0;
    const cards: JevBreakerCard[] = [];
    const breaker = memoryJevBreaker();
    const r = rig({
      now: () => t, breaker, postCard: (c) => { cards.push(c); return cards.length; },
      callJev: async () => { sent += 1; if (status !== 200) throw new JevHttpError(status, `Jev HTTP ${status}: x`); return ok(); },
    });
    const ask = () => jevDecide({ site: 'boundary-shadow', state: {}, questions: noul }, r.deps);
    expect(await ask()).toMatchObject({ ok: false, reason: 'credit-exhausted', status: 402 });
    for (let i = 0; i < 20; i++) expect(await ask()).toMatchObject({ ok: false, reason: 'breaker-open' });
    expect(sent).toBe(1);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ to: 'OP', refs: ['jev-credit-402', expect.stringMatching(/^jev-breaker:credit:/)] });
    expect(cards[0]!.body).toContain('402');
    // cooldown over, still 402 → same outage: re-opened, no second card
    t += 30 * 60_000 + 1;
    expect(await ask()).toMatchObject({ reason: 'credit-exhausted' });
    expect(sent).toBe(2);
    expect(cards).toHaveLength(1);
    // credits topped up → the next probe succeeds and closes the breaker
    t += 30 * 60_000 + 1; status = 200;
    expect((await ask()).ok).toBe(true);
    expect((await ask()).ok).toBe(true);
    // a new outage later is a new episode → a new card
    status = 402;
    await ask();
    expect(cards).toHaveLength(2);
    expect(cards[1]!.provenanceKey).not.toBe(cards[0]!.provenanceKey);
  });

  test('429 → short backoff, no card', async () => {
    let t = 0; let sent = 0;
    const cards: JevBreakerCard[] = [];
    const r = rig({ now: () => t, breaker: memoryJevBreaker(), postCard: (c) => { cards.push(c); return 1; },
      callJev: async () => { sent += 1; throw new Error('Jev HTTP 429: slow down'); } });
    const ask = () => jevDecide({ site: 'boundary-shadow', state: {}, questions: noul }, r.deps);
    expect(await ask()).toMatchObject({ reason: 'rate-limited' });
    expect(await ask()).toMatchObject({ reason: 'breaker-open' });
    t += 61_000;
    await ask();
    expect(sent).toBe(2);
    expect(cards).toHaveLength(0);
  });

  test('the breaker is per endpoint: a 402 from Typesafe does not stop a loopback server', async () => {
    const breaker = memoryJevBreaker();
    const remote = rig({ breaker, postCard: () => 1, callJev: async () => { throw new JevHttpError(402, 'Jev HTTP 402'); } });
    await jevDecide({ site: 'boundary-shadow', state: {}, questions: noul }, remote.deps);
    const local = rig({ breaker, peekEndpoint: () => LOCAL, resolveAccess: () => ({ ok: true, access: { endpoint: LOCAL, endpointSource: 'config' } }) });
    expect((await jevDecide({ site: 'boundary-shadow', state: {}, questions: noul }, local.deps)).ok).toBe(true);
  });

  test('the file breaker is shared by two processes (two instances, one file) and survives a broken file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'jev-breaker-')), 'breaker.json');
    const a = fileJevBreaker(file);
    const b = fileJevBreaker(file);
    const trip = a.trip(JEV_ENDPOINT, 'credit', 1_000, 60_000);
    expect(trip.firstInEpisode).toBe(true);
    expect(b.check(JEV_ENDPOINT, 2_000)).toMatchObject({ cause: 'credit', episode: trip.episode });
    expect(b.trip(JEV_ENDPOINT, 'credit', 70_000, 60_000)).toMatchObject({ firstInEpisode: false, episode: trip.episode });
    b.reset(JEV_ENDPOINT);
    expect(a.check(JEV_ENDPOINT, 2_000)).toBeNull();
    writeFileSync(file, '{not json');
    const c = fileJevBreaker(file);
    expect(c.check(JEV_ENDPOINT, 0)).toBeNull();
  });
});
