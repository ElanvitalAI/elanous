// RESOURCE-FACTS (3/3) — usage caps are facts, not literals: one policy edit moves the hand-model tier-down cap, the
// 연료관 low/exhausted thresholds and the grok weekly cut, with no code change (defaults = the old literals).
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountCap, pickHandModel, TIER_CHAIN } from '../../seat/model-by-difficulty.js';
import { accountEntries, fuelExhausted, fuelLow } from '../../guardian-agent/fuel.js';
import { grokQuotaFromUsageSnapshot } from '../../oauth/fallback-chain.js';
import { resetResourceFactsCache } from './facts.js';

let dir = '';
const saved = { ledger: process.env.RESOURCE_FACTS_LEDGER, policy: process.env.RESOURCE_FACTS_POLICY };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resource-facts-caps-'));
  process.env.RESOURCE_FACTS_LEDGER = join(dir, 'events.jsonl');
  process.env.RESOURCE_FACTS_POLICY = join(dir, 'policy.json');
  resetResourceFactsCache();
});
afterEach(() => {
  if (saved.ledger === undefined) delete process.env.RESOURCE_FACTS_LEDGER; else process.env.RESOURCE_FACTS_LEDGER = saved.ledger;
  if (saved.policy === undefined) delete process.env.RESOURCE_FACTS_POLICY; else process.env.RESOURCE_FACTS_POLICY = saved.policy;
  rmSync(dir, { recursive: true, force: true });
  resetResourceFactsCache();
});
const policy = (caps: Record<string, number>) => { writeFileSync(process.env.RESOURCE_FACTS_POLICY!, JSON.stringify({ caps })); resetResourceFactsCache(); };

test('defaults keep the old literals (accountCap 0.95 · fuelLow 0.9 · grok weekly 70 %)', () => {
  expect([accountCap(), fuelLow(), fuelExhausted()]).toEqual([0.95, 0.9, 0.95]);
  expect(grokQuotaFromUsageSnapshot({ windows: [{ kind: 'weekly', remainingPercent: 31 }] })).toBe('usable');
  expect(grokQuotaFromUsageSnapshot({ windows: [{ kind: 'weekly', remainingPercent: 30 }] })).toBe('exhausted');
});

test('a policy edit moves the hand-model tier-down cap without code change', () => {
  const first = TIER_CHAIN.hard[0]!;
  const used = (p: string) => (p === first.provider ? 0.85 : 0);
  expect(pickHandModel('hard', used).model).toBe(first.model);
  policy({ accountCap: 0.8 });
  expect(pickHandModel('hard', used).model).not.toBe(first.model);
  expect(pickHandModel('hard', used).note ?? '').toContain('(cap 80%)');
});

test('a policy edit moves the 연료관 thresholds and the grok weekly cut', () => {
  const snap = { ts: Date.now(), accounts: [{ provider: 'openai-codex', account: 'a1', usedPercent: 88, status: 'ok' as const }] };
  expect(accountEntries(snap, Date.now())[0]!.status).toBe('ok');
  policy({ fuelLow: 0.85, accountCap: 0.87, grokWeeklyExhaustedPercent: 60 });
  expect(accountEntries(snap, Date.now())[0]!.status).toBe('exhausted');
  expect(grokQuotaFromUsageSnapshot({ windows: [{ kind: 'weekly', remainingPercent: 39 }] })).toBe('exhausted');
});
