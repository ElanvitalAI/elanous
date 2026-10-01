// Unified usage assembly — injected fetch, no live credentials, no network.

import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { grokUsageToSnapshot } from './fetchers/grok.js';
import { collectUnifiedUsage, formatUnifiedUsage } from './unified-usage.js';
import { registerUsageCommand } from '../cli/usage-cli.js';
import { executeUsageSlash } from '../skills/tools/usage-slash.js';
import { parseGrokBilling } from '../grok/usage.js';
import type { GrokUsageResult } from '../grok/usage.js';
import type { GrokCredential } from '../grok/credential.js';
import type { UsageSnapshot } from './types.js';

const GROK_OK = parseGrokBilling({
  creditUsagePercent: 42,
  currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-08-07T13:07:00Z', end: '2026-08-14T13:07:00Z' },
  prepaidBalance: 3,
  monthlyLimit: 25,
  used: 7.5,
})!;

function grokOk(): GrokUsageResult {
  return { status: 'ok', usage: GROK_OK };
}

const GROK_CREDENTIAL: GrokCredential = {
  kind: 'subscription',
  baseUrl: 'https://cli-chat-proxy.grok.com/v1',
  token: 'test-token',
  headers: {},
  source: 'auth.json',
};

function codexSnap(
  used: number,
  remaining: number,
  window: Partial<UsageSnapshot['windows'][number]> = {},
): UsageSnapshot {
  return {
    provider: 'codex',
    windows: [{
      kind: 'weekly',
      windowMinutes: 10_080,
      limit: 100,
      used,
      remainingPercent: remaining,
      resetsAt: 1_786_163_948_000,
      ...window,
    }],
    credits: { balance: 10, hasCredits: true, unlimited: false },
    fetchedAt: 1,
    source: 'cli-rpc',
  };
}

describe('collectUnifiedUsage — 계정 행 × 크레딧 축 × 구독 축', () => {
  it('계정이 여럿이면 계정마다 행이 나오고 각 행에 두 축이 각각 있다', async () => {
    const homes: string[] = [];
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [
        { name: 'default', storeKey: 'openai-codex' },
        { name: 'team', storeKey: 'openai-codex:team' },
      ],
      loadCodexHome: (key) => key === 'openai-codex:team' ? '/tmp/codex-team' : '/tmp/codex-default',
      fetchCodex: async (opts) => {
        homes.push(opts.codexHome ?? '(none)');
        return codexSnap(opts.codexHome?.includes('team') ? 10 : 80, opts.codexHome?.includes('team') ? 90 : 20);
      },
      fetchGrok: async () => grokOk(),
      resolveGrokCredential: () => GROK_CREDENTIAL,
    });
    const codex = report.rows.filter((r) => r.provider === 'codex');
    expect(codex).toHaveLength(2);
    expect(report.accountCounts.codex).toBe(2);
    expect(codex.every((r) => r.accountCount === 2 && r.soleAccount === false)).toBe(true);
    expect(codex.map((r) => r.accountName)).toEqual(['default', 'team']);
    expect(codex[0]!.credits.status).toBe('ok');
    expect(codex[0]!.subscription.status).toBe('available');
    expect(codex[1]!.subscription.status).toBe('available');
    const grok = report.rows.find((r) => r.provider === 'grok')!;
    expect(grok.credits.status).toBe('ok');
    expect(grok.subscription).toEqual({ status: 'unavailable', reason: 'query-does-not-supply' });
    expect(homes).toEqual(['/tmp/codex-default', '/tmp/codex-team']);
    expect(process.env.CODEX_HOME).not.toBe('/tmp/codex-team');
  });

  it('계정이 하나뿐이면 하나뿐임이 값으로 보인다', async () => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [{ name: 'default', storeKey: 'openai-codex' }],
      loadCodexHome: () => '/tmp/codex-default',
      fetchCodex: async () => codexSnap(50, 50),
      fetchGrok: async () => ({ status: 'unauthorized' }),
      resolveGrokCredential: () => GROK_CREDENTIAL,
    });
    const grok = report.rows.find((r) => r.provider === 'grok')!;
    expect(grok.accountCount).toBe(1);
    expect(grok.soleAccount).toBe(true);
    expect(report.accountCounts.grok).toBe(1);
    expect(report.accountCounts.codex).toBe(1);
    const text = formatUnifiedUsage(report);
    expect(text).toContain('grok  accounts=1  (하나뿐)');
    expect(text).toContain('codex  accounts=1  (하나뿐)');
  });

  it('Grok 구독 축은 0·빈칸이 아니라 query-does-not-supply 다', async () => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [],
      fetchCodex: async () => { throw new Error('codex should not run when no accounts'); },
      fetchGrok: async () => grokOk(),
      resolveGrokCredential: () => GROK_CREDENTIAL,
    });
    const grok = report.rows.find((r) => r.provider === 'grok')!;
    expect(grok.credits.status).toBe('ok');
    if (grok.credits.status === 'ok') expect(grok.credits.usedPercent).toBe(42);
    expect(grok.subscription).toEqual({ status: 'unavailable', reason: 'query-does-not-supply' });
    const text = formatUnifiedUsage(report);
    expect(text).toContain('credits.usedPercent');
    expect(text).toContain('42%');
    expect(text).toContain('unavailable (query-does-not-supply)');
    const subLine = text.split('\n').find((l) => l.includes('grok') && l.includes('default'));
    expect(subLine).toBeDefined();
    expect(subLine).toContain('42%');
    expect(subLine).toContain('unavailable (query-does-not-supply)');
    expect(subLine).not.toMatch(/available remaining=42/);
  });

  it('부분 실패는 그 행의 credits.status=error 이고 다른 행은 산다', async () => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [
        { name: 'default', storeKey: 'openai-codex' },
        { name: 'team', storeKey: 'openai-codex:team' },
      ],
      loadCodexHome: (key) => key === 'openai-codex:team' ? '/tmp/team' : '/tmp/default',
      fetchCodex: async (opts) => {
        if (opts.codexHome?.includes('team')) throw new Error('team down');
        return codexSnap(11, 89);
      },
      fetchGrok: async () => ({ status: 'error', detail: 'billing 500' }),
      resolveGrokCredential: () => GROK_CREDENTIAL,
    });
    const team = report.rows.find((r) => r.accountName === 'team')!;
    expect(team.credits).toEqual({ status: 'error', detail: 'team down' });
    const def = report.rows.find((r) => r.accountName === 'default')!;
    expect(def.credits.status).toBe('ok');
    const grok = report.rows.find((r) => r.provider === 'grok')!;
    expect(grok.credits).toEqual({ status: 'error', detail: 'billing 500' });
  });
});

describe('grokUsageToSnapshot — 크레딧 사용률을 RateWindow 에 넣지 않는다', () => {
  it('windows 는 비어 있고 credits 만 있다', () => {
    const snap = grokUsageToSnapshot(GROK_OK, 1);
    expect(snap.provider).toBe('grok');
    expect(snap.windows).toEqual([]);
    expect(snap.credits?.balance).toBe(3);
    expect(JSON.stringify(snap)).not.toContain('remainingPercent');
  });
});

describe('formatUnifiedUsage ⊕ CLI 가 같은 문면을 낸다', () => {
  it('유효한 종료 시각과 창 길이에서 종류를 유지한 날짜 범위를 표시하고 구조화 기간을 보존한다', async () => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [{ name: 'default', storeKey: 'openai-codex' }],
      loadCodexHome: () => '/tmp/default',
      fetchCodex: async () => codexSnap(25, 75, {
        windowMinutes: 60,
        resetsAt: Date.parse('2026-08-15T00:30:00Z'),
      }),
      fetchGrok: async () => grokOk(),
      resolveGrokCredential: () => GROK_CREDENTIAL,
    });
    const codex = report.rows.find((row) => row.provider === 'codex')!;
    expect(codex.credits).toMatchObject({
      status: 'ok',
      usedPercent: 25,
      periodType: 'weekly',
      periodStart: '2026-08-14T23:30:00.000Z',
      periodEnd: '2026-08-15T00:30:00.000Z',
    });
    expect(formatUnifiedUsage(report)).toContain('weekly 2026-08-14~2026-08-15');
    expect(codex).toHaveProperty('provider', 'codex');
    expect(codex).toHaveProperty('accountName', 'default');
    expect(codex).toHaveProperty('accountCount', 1);
    expect(codex).toHaveProperty('credits.usedPercent', 25);
    expect(codex).toHaveProperty('subscription.status', 'available');
  });

  it.each([
    ['종료 시각 없음', { resetsAt: 0 }],
    ['창 길이 없음', { windowMinutes: 0 }],
    ['창 길이가 유효하지 않음', { windowMinutes: Number.NaN }],
    ['창 길이가 Date 범위를 벗어남', { windowMinutes: Number.MAX_VALUE }],
  ])('%s이면 날짜를 지어내지 않고 unknown을 표시한다', async (_caseName, window) => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [{ name: 'default', storeKey: 'openai-codex' }],
      loadCodexHome: () => '/tmp/default',
      fetchCodex: async () => codexSnap(25, 75, window),
      fetchGrok: async () => grokOk(),
      resolveGrokCredential: () => GROK_CREDENTIAL,
    });
    const codex = report.rows.find((row) => row.provider === 'codex')!;
    expect(codex.credits).toMatchObject({ status: 'ok', periodType: 'weekly', periodStart: null });
    const codexLine = formatUnifiedUsage(report).split('\n').find((line) => line.includes('codex') && line.includes('default'))!;
    expect(codexLine).toContain('weekly unknown');
    expect(codexLine).not.toContain('2026-08-');
  });

  it('명령은 같은 구조화 산출을 그대로 찍는다', async () => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [{ name: 'default', storeKey: 'openai-codex' }],
      loadCodexHome: () => '/tmp/default',
      fetchCodex: async () => codexSnap(25, 75, {
        windowMinutes: 60,
        resetsAt: Date.parse('2026-08-15T00:30:00Z'),
      }),
      fetchGrok: async () => grokOk(),
      resolveGrokCredential: () => GROK_CREDENTIAL,
    });
    const expected = formatUnifiedUsage(report);
    const lines: string[] = [];
    const program = new Command();
    registerUsageCommand(program, {
      collect: async () => report,
      creditPlan: () => null,
      out: { log: (s) => { lines.push(s); } },
    });
    await program.parseAsync(['usage'], { from: 'user' });
    expect(lines.join('\n')).toBe(expected);
    expect(expected).toContain('credits.usedPercent');
    expect(expected).toContain('weekly 2026-08-14~2026-08-15');
    expect(expected).toContain('subscription');
    expect(JSON.stringify(report)).not.toMatch(/sk-|Bearer |eyJ/);
    const slash = await executeUsageSlash({ name: 'remaining', args: [] }, {
      listCodexAccounts: () => [{ name: 'default', storeKey: 'openai-codex' }],
      loadCodexHome: () => '/tmp/default',
      fetchCodex: async () => codexSnap(25, 75, {
        windowMinutes: 60,
        resetsAt: Date.parse('2026-08-15T00:30:00Z'),
      }),
      fetchGrok: async () => grokOk(),
      resolveGrokCredential: () => GROK_CREDENTIAL,
    });
    expect(slash?.logLines.join('\n')).toBe(expected);
  });
});

describe('collectGrokRows — 계정 수는 자격에서 파생한다', () => {
  it('자격이 있으면 grok 행이 하나고 accountCount 는 1 이다', async () => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [],
      fetchGrok: async () => grokOk(),
      resolveGrokCredential: () => GROK_CREDENTIAL,
    });
    const grok = report.rows.filter((r) => r.provider === 'grok');
    expect(grok).toHaveLength(1);
    expect(grok[0]!.accountCount).toBe(1);
    expect(grok[0]!.soleAccount).toBe(true);
    expect(report.accountCounts.grok).toBe(1);
    expect(grok[0]!.credits.status).toBe('ok');
    expect(grok[0]!.subscription).toEqual({ status: 'unavailable', reason: 'query-does-not-supply' });
  });

  it('자격이 없으면 grok 행이 없고 accountCounts.grok 은 0 이다', async () => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [],
      fetchGrok: async () => { throw new Error('fetch should not run when credential is null'); },
      resolveGrokCredential: () => null,
    });
    expect(report.rows.filter((r) => r.provider === 'grok')).toEqual([]);
    expect(report.accountCounts.grok).toBe(0);
    expect(formatUnifiedUsage(report)).toContain('grok  accounts=0  (없음)');
  });

  it('자격 조회가 던지면 던지지 않고 종전 행(accountCount 1)으로 접는다', async () => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [],
      fetchGrok: async () => grokOk(),
      resolveGrokCredential: () => { throw new Error('credential store down'); },
    });
    const grok = report.rows.filter((r) => r.provider === 'grok');
    expect(grok).toHaveLength(1);
    expect(grok[0]!.accountCount).toBe(1);
    expect(report.accountCounts.grok).toBe(1);
    expect(grok[0]!.credits.status).toBe('ok');
  });
});

describe('openrouter 선불 크레딧 행 (2026-09-23)', () => {
  const noCodexGrok = {
    listCodexAccounts: () => [],
    fetchGrok: async () => ({ status: 'no-subscription' }) as never,
    resolveGrokCredential: () => null,
  };
  const res = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('키가 없으면 행을 안 만든다 — 「없음」은 «0달러»가 아니다', async () => {
    const r = await collectUnifiedUsage({ ...noCodexGrok, openRouterKey: () => undefined, fetchOpenRouterImpl: res(200, {}) });
    expect(r.accountCounts.openrouter).toBe(0);
    expect(r.rows.some((x) => x.provider === 'openrouter')).toBe(false);
  });

  it('실물 응답 모양을 크레딧 칸으로 옮기고 남은 달러를 보인다', async () => {
    const r = await collectUnifiedUsage({ ...noCodexGrok, openRouterKey: () => 'k', fetchOpenRouterImpl: res(200, { data: { total_credits: 60, total_usage: 1.359801883 } }) });
    const row = r.rows.find((x) => x.provider === 'openrouter')!;
    expect(row.credits).toMatchObject({ status: 'ok', usedPercent: 2.3, balance: 58.64, periodType: 'prepaid-usd', hasCredits: true });
    expect(formatUnifiedUsage(r)).toContain('2.3% ($58.64 left)');
  });

  it('401 은 unauthorized · 봉투가 틀리면 error(upstream-shape) — 「0」으로 접지 않는다', async () => {
    const a = await collectUnifiedUsage({ ...noCodexGrok, openRouterKey: () => 'k', fetchOpenRouterImpl: res(401, {}) });
    expect(a.rows.find((x) => x.provider === 'openrouter')!.credits).toEqual({ status: 'unauthorized' });
    const b = await collectUnifiedUsage({ ...noCodexGrok, openRouterKey: () => 'k', fetchOpenRouterImpl: res(200, { credits: 1 }) });
    expect(b.rows.find((x) => x.provider === 'openrouter')!.credits).toEqual({ status: 'error', detail: 'upstream-shape' });
  });
});
