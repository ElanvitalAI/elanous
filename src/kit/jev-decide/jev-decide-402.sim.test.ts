// SIM · JEV-DECIDE-KIT — a synthetic 402 (Typesafe «credits exhausted») hits every migrated Jev site in two processes.
//
// World: the real HTTP client (src/decide/jev.ts callJev) over a fake fetch that answers 402 like Typesafe does · two
// «processes» = two file breakers on ONE state file · one real msg ledger (temp) for the OP card · the real site rows
// (graphs/policies/jev-sites.yaml). No network, no key file, no live ledger.
//
// Expected (cell done criterion «402 합성 이벤트 시뮬: 폴백·카드 1·재시도 억제 · usageSite 로그»):
//   ① every site call during the outage returns a fallback (ok:false) — nobody throws, nobody blocks
//   ② exactly ONE OP card for the outage, even though two processes and four sites saw it
//   ③ during the cooldown the endpoint is asked once in total (no hammering) — after it, one probe per cooldown
//   ④ every call leaves one `jev.decide` line naming its usageSite
//   ⑤ credits back → the first probe closes the breaker for every process
import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JEV_ENDPOINT } from '../../decide/jev.js';
import { openMsgStore } from '../../msg/msg-store.js';
import { BUILTIN_JEV_SITES_FILE, fileJevBreaker, jevDecide, msgLedgerCardPoster, readJevSites, type JevDecideDeps } from './index.js';

const SITES = ['boundary-shadow', 'memory-write-gate', 'mail-route.hand-classify', 'tool-guard-axis'] as const;
const Q = { q: { type: 'noul' as const, instructions: 'synthetic?' } };

test('synthetic 402 across 4 sites × 2 processes → fallback · one OP card · no hammering · usageSite on every line · probe re-opens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-402-sim-'));
  const breakerFile = join(dir, 'breaker.json');
  const ledger = join(dir, 'messages.db');
  const table = readJevSites([BUILTIN_JEV_SITES_FILE]);
  let t = Date.parse('2026-11-28T00:00:00Z');
  let credits = false;
  let httpCalls = 0;
  const fetch402 = (async () => {
    httpCalls += 1;
    return credits
      ? new Response(JSON.stringify({ model: 'jev-sim', answers: { q: { type: 'noul', noul: 0.2 } } }), { status: 200 })
      : new Response('{"message":"Insufficient credits"}', { status: 402 });
  }) as unknown as typeof fetch;
  const lines: Array<Record<string, unknown>> = [];
  const proc = (): JevDecideDeps => ({
    table, now: () => t, fetch: fetch402, breaker: fileJevBreaker(breakerFile), postCard: msgLedgerCardPoster(ledger),
    peekEndpoint: () => JEV_ENDPOINT,
    resolveAccess: () => ({ ok: true, access: { endpoint: JEV_ENDPOINT, endpointSource: 'default', key: 'sim-not-a-key' } }),
    log: (_e, d) => { lines.push(d); }, logUsage: () => {},
  });
  const tui = proc();
  const harness = proc();
  const round = async () => {
    const out = [];
    for (const deps of [tui, harness]) for (const site of SITES) out.push(await jevDecide({ site, state: { x: 1 }, questions: Q, audience: 'hq-seat' }, deps));
    return out;
  };

  // outage: 10 rounds over 20 minutes (inside the 30-min cooldown)
  const outage = [];
  for (let i = 0; i < 10; i++) { outage.push(...await round()); t += 2 * 60_000; }
  expect(outage.every((r) => !r.ok)).toBe(true);                                         // ①
  expect(outage.filter((r) => !r.ok && r.reason === 'credit-exhausted')).toHaveLength(1);
  expect(outage.filter((r) => !r.ok && r.reason === 'breaker-open')).toHaveLength(79);
  expect(httpCalls).toBe(1);                                                             // ③

  const store = openMsgStore(ledger);
  const cards = () => (store.db.query(`SELECT id, recipient, body FROM msg_messages WHERE refs_json LIKE '%jev-credit-402%'`).all() as Array<{ recipient: string; body: string }>);
  try {
    expect(cards()).toHaveLength(1);                                                     // ②
    expect(cards()[0]!.recipient).toBe('OP');
    expect(cards()[0]!.body).toContain('402');

    // cooldown over, still no credits: one probe (the other process sees the re-opened breaker), still one card
    t += 11 * 60_000;
    const probe = await round();
    expect(probe.filter((r) => !r.ok && r.reason === 'credit-exhausted')).toHaveLength(1);
    expect(httpCalls).toBe(2);
    expect(cards()).toHaveLength(1);

    // credits topped up: after the cooldown the first call is the probe, it closes the breaker for both processes
    credits = true;
    t += 31 * 60_000;
    const back = await round();
    expect(back.every((r) => r.ok)).toBe(true);                                          // ⑤
    expect(httpCalls).toBe(2 + SITES.length * 2);
    expect(cards()).toHaveLength(1);
  } finally { store.close(); }

  // ④ one line per call, each with the site's usageSite from the YAML
  expect(lines.filter((l) => l.event !== 'breaker-open')).toHaveLength(10 * 8 + 8 + 8);
  for (const l of lines) expect(typeof l.usageSite).toBe('string');
  expect(new Set(lines.map((l) => l.usageSite))).toEqual(new Set(['jev-boundary-shadow', 'jev-memory-write-gate', 'mail-route.hand-classify', 'jev-tool-guard-axis']));
});
