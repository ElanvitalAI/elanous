// CODEX-CREDIT-ACCOUNTS — 대표 11-27 15:1x «team·third 는 구독 100% 까지 · 크레딧 직전에 막고 · default 는 크레딧으로 넘어갈 때까지».
//   계약: 목록(`llm.codexCreditAccounts` · resource facts `creditAccounts.openai-codex`)이 있으면 목록 안 계정만 크레딧을 쓴다.
//   목록이 없으면 종전(잔액 많은 순 — third 먼저). 기대값은 모두 리터럴(제품 상수·함수로 만들지 않는다).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { creditCandidatesByBalance, decideCodexRotation, type RotationCandidate } from './codex-account-rotation.js';
import { readCodexCreditAccounts, resolveCodexCreditAccounts } from './codex-credit-accounts.js';
import { _setRotationConfigReaderForTesting, codexCreditAccountNames, codexCreditAccountsFromConfig } from './codex-account-store.js';
import { planOwnerCodexMirrorCandidates, planPodAccounts, planPodProvider } from '../task-orchestrator/surfaces/pod-account-broker.js';
import { decideBudget } from '../self-implement/budget-gate.js';
import { resetResourceFactsCache } from '../kit/resource-facts/facts.js';
import { factGet, resolveFacts } from '../kit/resource-facts/index.js';
import { buildPodConfigSnapshot } from '../task-orchestrator/surfaces/pod-config-snapshot.js';
import { buildUserConfig, saveUserConfig, type UserConfig } from '../user-config.js';

// 운영 실측 11-27 15:1x — 세 계정 모두 구독 100% · 잔액 default 8499 · team 14093 · third 22110.
const cand = (name: string, creditBalance: number): RotationCandidate => ({
  name, storeKey: name === 'default' ? 'openai-codex' : `openai-codex:${name}`, home: `/h/${name}`,
  reached: true, usedPercent: 100, creditBalance, hasCredits: true,
});
const DEFAULT = cand('default', 8499);
const TEAM = cand('team', 14093);
const THIRD = cand('third', 22110);
const ALL = [DEFAULT, TEAM, THIRD];

const rotate = (currentName: string, creditAccounts: readonly string[] | undefined) => {
  const self = ALL.find((c) => c.name === currentName)!;
  return decideCodexRotation({
    current: { name: currentName, storeKey: self.storeKey, home: self.home, source: 'default' } as never,
    explicit: false, enabled: true, currentReached: true, currentUsedPercent: 100,
    resetCreditAvailability: 'unavailable', creditsAllowed: true, creditReserve: 2000,
    currentCreditBalance: self.creditBalance, currentHasCredits: true,
    thresholdPercent: 100, thresholdPercentByAccount: { default: 100, team: 100, third: 100 },
    candidates: ALL,
    ...(creditAccounts === undefined ? {} : { creditAccounts }),
  });
};

describe('rotation — credits only on allowed accounts', () => {
  test('list absent → old behavior: from team, rotates to the richest (third)', () => {
    expect(rotate('team', undefined)).toMatchObject({ reason: 'rotated', to: { name: 'third' }, creditEntry: true });
  });
  test('list [default] → from team (100 %) moves to default for credits', () => {
    expect(rotate('team', ['default'])).toMatchObject({ reason: 'rotated', to: { name: 'default' }, creditEntry: true });
  });
  test('list [default] → from third (100 %) moves to default, never stays on third credits', () => {
    expect(rotate('third', ['default'])).toMatchObject({ reason: 'rotated', to: { name: 'default' } });
  });
  test('list [default] → on default (100 %) stays on credits even though team/third hold more', () => {
    expect(rotate('default', ['default']).reason).toBe('credits-allowed');
  });
  test('list [] → nobody spends credits: no-candidate', () => {
    expect(rotate('default', []).reason).toBe('no-candidate');
    expect(rotate('team', []).reason).toBe('no-candidate');
  });
});

describe('credit collectors share the list', () => {
  test('creditCandidatesByBalance / codexCreditAccountNames', () => {
    expect(creditCandidatesByBalance(ALL, 2000).map((c) => c.name)).toEqual(['third', 'team', 'default']);
    expect(creditCandidatesByBalance(ALL, 2000, ['default']).map((c) => c.name)).toEqual(['default']);
    expect(codexCreditAccountNames(ALL, 2000, ['default'])).toEqual(['default']);
    expect(codexCreditAccountNames(ALL, 2000)).toEqual(['third', 'team', 'default']);
  });
  test('Pod plan: team/third excluded as subscription-only, default on credits', () => {
    expect(planPodAccounts(ALL, { creditsAllowed: true, creditReserve: 2000 }).creditAccounts).toEqual(['third', 'team', 'default']);
    const plan = planPodAccounts(ALL, { creditsAllowed: true, creditReserve: 2000, creditAccounts: ['default'] });
    expect(plan).toMatchObject({ usable: ['default'], creditAccounts: ['default'] });
    const none = planPodAccounts(ALL, { creditsAllowed: true, creditReserve: 2000, creditAccounts: [] });
    expect(none.usable).toEqual([]);
    expect(none.excluded.map((e) => e.why)).toEqual([
      'quota reached · subscription-only (codexCreditAccounts)',
      'quota reached · subscription-only (codexCreditAccounts)',
      'quota reached · subscription-only (codexCreditAccounts)',
    ]);
  });
  test('Pod provider credits step + owner mirror honor the list', () => {
    const plan = planPodProvider({ codexCandidates: ALL, grokSubscription: false, grokApiKey: false, grokApiKeyOptIn: false,
      codexCreditsStep: true, creditReserve: 2000, creditAccounts: ['default'] });
    expect(plan).toMatchObject({ provider: 'openai-codex', accounts: ['default'], creditAccounts: ['default'] });
    expect(planOwnerCodexMirrorCandidates(ALL, { accountOrder: [], creditsAllowed: true, creditReserve: 2000, creditAccounts: ['default'] })
      .map((c) => c.name)).toEqual(['default']);
  });
  test('budget gate picks default for credits, not third', () => {
    const base = {
      preference: { chain: [{ provider: 'openai-codex' }], budgetGate: { onShortfall: 'decompose' as const } },
      codexCandidates: ALL, grokUsedPercent: undefined, maxUsedPercent: { 'openai-codex': 100 },
      codexCreditsAllowed: true, codexCreditReserve: 2000,
    };
    expect(decideBudget(base).reasons).toEqual(['codex: default 100%·team 100%·third 100% ≥ 100 · credits allowed (balance 22110)']);
    expect(decideBudget({ ...base, codexCreditAccounts: ['default'] }).reasons)
      .toEqual(['codex: default 100%·team 100%·third 100% ≥ 100 · credits allowed (balance 8499)']);
    const stepOnly = { ...base, codexCreditsAllowed: undefined,
      preference: { chain: [{ provider: 'openai-codex', codexCredits: true as const }], budgetGate: { onShortfall: 'decompose' as const } } };
    expect(decideBudget({ ...stepOnly, codexCreditAccounts: ['default'] }).reasons)
      .toEqual(['codex-credits: default 크레딧 잔액 8499 (체인 마지막 칸 · 과금)']);
    expect(decideBudget({ ...stepOnly, codexCreditAccounts: [] })).toMatchObject({ action: 'stop', reasons: ['codex-credits: 잔액이 확인된 계정 없음'] });
  });
});

describe('source: resource facts first, then config, else absent', () => {
  test('pure resolver', () => {
    expect(resolveCodexCreditAccounts(undefined, undefined)).toEqual({ names: undefined, source: 'absent' });
    expect(resolveCodexCreditAccounts({ codexCreditAccounts: ['default'] }, undefined)).toEqual({ names: ['default'], source: 'config' });
    expect(resolveCodexCreditAccounts({ codexCreditAccounts: ['default'] }, ['team'])).toEqual({ names: ['team'], source: 'resource-facts' });
    expect(resolveCodexCreditAccounts({ codexCreditAccounts: 'default' }, 7)).toEqual({ names: undefined, source: 'absent' });
  });
  test('read failures (Terra #40488 must-fix): a broken config read still honors facts · nothing readable + failure → [] (fail-closed)', () => {
    const boom = (): never => { throw new Error('config unreadable'); };
    expect(readCodexCreditAccounts(boom, () => ['default'])).toEqual({ names: ['default'], source: 'resource-facts' });
    expect(readCodexCreditAccounts(boom, () => undefined)).toEqual({ names: [], source: 'read-error' });
    expect(readCodexCreditAccounts(() => ({ codexCreditAccounts: ['default'] }), boom)).toEqual({ names: ['default'], source: 'config' });
    expect(readCodexCreditAccounts(() => ({}), boom)).toEqual({ names: [], source: 'read-error' });
    expect(readCodexCreditAccounts(() => ({}), () => undefined)).toEqual({ names: undefined, source: 'absent' });
    // fail-closed list → nobody spends credits (team at 100 % does not ride third's balance).
    expect(rotate('team', readCodexCreditAccounts(boom, () => undefined).names).reason).toBe('no-candidate');
  });
  test('resource facts policy file carries creditAccounts (no default)', () => {
    const facts = resolveFacts({ actors: null, policy: { creditAccounts: { 'openai-codex': ['default'] } } });
    expect(facts.creditAccounts).toEqual({ 'openai-codex': ['default'] });
    expect(factGet(facts, 'creditAccounts.openai-codex')).toEqual(['default']);
    expect(resolveFacts({ actors: null, policy: null }).creditAccounts).toEqual({});
  });

  let dir = '';
  const saved = { policy: process.env.RESOURCE_FACTS_POLICY, ledger: process.env.RESOURCE_FACTS_LEDGER };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-credit-accounts-'));
    process.env.RESOURCE_FACTS_POLICY = join(dir, 'policy.json');
    process.env.RESOURCE_FACTS_LEDGER = join(dir, 'events.jsonl');
    resetResourceFactsCache();
  });
  afterEach(() => {
    _setRotationConfigReaderForTesting(null);
    if (saved.policy === undefined) delete process.env.RESOURCE_FACTS_POLICY; else process.env.RESOURCE_FACTS_POLICY = saved.policy;
    if (saved.ledger === undefined) delete process.env.RESOURCE_FACTS_LEDGER; else process.env.RESOURCE_FACTS_LEDGER = saved.ledger;
    rmSync(dir, { recursive: true, force: true });
    resetResourceFactsCache();
  });
  test('store reader: config value, then a policy-file entry overrides it', () => {
    _setRotationConfigReaderForTesting(() => ({ llm: {} }));
    expect(codexCreditAccountsFromConfig()).toEqual({ names: undefined, source: 'absent' });
    _setRotationConfigReaderForTesting(() => ({ llm: { codexCreditAccounts: ['default'] } }));
    expect(codexCreditAccountsFromConfig()).toEqual({ names: ['default'], source: 'config' });
    writeFileSync(process.env.RESOURCE_FACTS_POLICY!, JSON.stringify({ creditAccounts: { 'openai-codex': ['team'] } }));
    resetResourceFactsCache();
    expect(codexCreditAccountsFromConfig()).toEqual({ names: ['team'], source: 'resource-facts' });
    // config reader throws → the facts list still holds (was: «unrestricted»).
    _setRotationConfigReaderForTesting(() => { throw new Error('config unreadable'); });
    expect(codexCreditAccountsFromConfig()).toEqual({ names: ['team'], source: 'resource-facts' });
    writeFileSync(process.env.RESOURCE_FACTS_POLICY!, JSON.stringify({}));
    resetResourceFactsCache();
    expect(codexCreditAccountsFromConfig()).toEqual({ names: [], source: 'read-error' });
  });
});

describe('Pod snapshot carries the host EFFECTIVE list (Terra #40488 r2)', () => {
  const host = { llm: { codexCreditAccounts: ['team'] } } as unknown as UserConfig;
  const runtime = { steps: ['codex-rotate'], overage: 'stop' as const, worktreeAddTimeoutSec: 1200 };
  test('resource facts override config on the host → the Pod gets the facts list and its source', () => {
    const snap = buildPodConfigSnapshot(host, { ...runtime, creditAccounts: { names: ['default'], source: 'resource-facts' } });
    expect(JSON.parse(snap.configJson).llm.codexCreditAccounts).toEqual(['default']);
    expect(snap.sources['llm.codexCreditAccounts']).toBe('host-resource-facts');
  });
  test('fail-closed [] is carried as [] (not dropped)', () => {
    const snap = buildPodConfigSnapshot(host, { ...runtime, creditAccounts: { names: [], source: 'read-error' } });
    expect(JSON.parse(snap.configJson).llm.codexCreditAccounts).toEqual([]);
    expect(snap.sources['llm.codexCreditAccounts']).toBe('host-read-error');
  });
  test('config source → config list · absent → no key (child keeps old behavior)', () => {
    const fromConfig = buildPodConfigSnapshot(host, { ...runtime, creditAccounts: { names: ['team'], source: 'config' } });
    expect(JSON.parse(fromConfig.configJson).llm.codexCreditAccounts).toEqual(['team']);
    expect(fromConfig.sources['llm.codexCreditAccounts']).toBe('host-effective');
    const absent = buildPodConfigSnapshot({ llm: {} } as unknown as UserConfig, { ...runtime, creditAccounts: { names: undefined, source: 'absent' } });
    expect(JSON.parse(absent.configJson).llm.codexCreditAccounts).toBeUndefined();
  });
  test('the child reading the forwarded config (no policy file in the Pod) applies the host list', () => {
    const snap = buildPodConfigSnapshot(host, { ...runtime, creditAccounts: { names: ['default'], source: 'resource-facts' } });
    const childLlm = JSON.parse(snap.configJson).llm;
    expect(readCodexCreditAccounts(() => childLlm, () => undefined)).toEqual({ names: ['default'], source: 'config' });
  });
});

describe('config parse → save → parse keeps the list (no CLI spawn · R-LIVE10)', () => {
  let cdir = '';
  beforeEach(() => { cdir = mkdtempSync(join(tmpdir(), 'codex-credit-accounts-cfg-')); });
  afterEach(() => { rmSync(cdir, { recursive: true, force: true }); });
  for (const list of [['default'], []] as const) {
    test(`codexCreditAccounts ${JSON.stringify(list)} survives the round trip`, () => {
      const first = join(cdir, 'config.json');
      writeFileSync(first, JSON.stringify({ llm: { provider: 'openai-codex', codexCreditAccounts: list } }));
      const parsed = buildUserConfig(first);
      expect(parsed.llm.codexCreditAccounts).toEqual([...list]);
      const second = join(cdir, 'saved', 'config.json');
      saveUserConfig(parsed, second);
      expect(JSON.parse(readFileSync(second, 'utf8')).llm.codexCreditAccounts).toEqual([...list]);
      expect(buildUserConfig(second).llm.codexCreditAccounts).toEqual([...list]);
    });
  }
});
