// Unified usage assembly — injected fetch, no live credentials, no network.

import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { visibleWidth } from '../tui.js';
import { grokUsageToSnapshot } from './fetchers/grok.js';
import { collectUnifiedUsage, formatUnifiedUsage, formatUsageCompact } from './unified-usage.js';
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

describe('formatUsageCompact — 계정별 한 줄 TUI 문면', () => {
  it('주간·월간·일간을 번역하고 상대·기기 지역 시각으로 표기한다', async () => {
    const nowMs = Date.parse('2026-10-28T12:14:00Z');
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [{ name: 'team', storeKey: 'team' }],
      loadCodexHome: () => '/tmp/team',
      fetchCodex: async () => codexSnap(25, 75, { resetsAt: nowMs + 3 * 3_600_000 }),
      fetchGrok: async () => ({ status: 'ok', usage: parseGrokBilling({
        creditUsagePercent: 42,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', start: '2026-10-01T00:00:00Z', end: '2026-10-29T19:14:10.427Z' },
      })! }),
      resolveGrokCredential: () => GROK_CREDENTIAL,
    });
    const lines = formatUsageCompact(report, { width: 160, nowMs });
    expect(lines).toHaveLength(report.rows.length);
    expect(lines[0]).toContain('codex team · 남은 75% · 주간 3시간 뒤에 다시 참 · 크레딧 10');
    const local = new Date('2026-10-29T19:14:10.427Z');
    const day = ['일', '월', '화', '수', '목', '금', '토'][local.getDay()];
    expect(lines[1]).toContain(`grok default · 남은 58% · 월간 ${local.getMonth() + 1}/${local.getDate()} (${day}) ${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}에 다시 참`);
    expect(lines.join('\n')).not.toMatch(/USAGE_PERIOD_TYPE|T\d\d:\d\d:\d\d|Z/);
    expect(lines.every((line) => visibleWidth(line) <= 160)).toBe(true);
    const grokCredits = report.rows[1]!.credits;
    expect(grokCredits.status).toBe('ok');
    if (grokCredits.status !== 'ok') throw new Error('expected grok credit axis');
    const daily = { ...report, rows: [{ ...report.rows[1]!, credits: {
      ...grokCredits, periodType: 'USAGE_PERIOD_TYPE_DAILY',
    } }] };
    expect(formatUsageCompact(daily, { width: 160, nowMs })[0]).toContain('일간');
  });

  it('크레딧은 큰 수에 쉼표를 찍고 작은 수는 소수 한 자리까지 표기하며 0은 0으로 쓴다', async () => {
    const nowMs = Date.parse('2026-10-02T10:00:00Z');
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [{ name: 'default', storeKey: 'openai-codex' }],
      loadCodexHome: () => '/tmp/default',
      fetchCodex: async () => ({
        ...codexSnap(89, 11, { resetsAt: nowMs + 3 * 3_600_000 }),
        credits: { balance: 67226.7008331667, hasCredits: true, unlimited: false },
      }),
      resolveGrokCredential: () => null,
    });
    const row = report.rows[0]!;
    if (row.credits.status !== 'ok') throw new Error('expected codex credit axis');
    const options = { width: 120, nowMs };
    const withBalance = (balance: number) => ({
      ...report, rows: [{ ...row, credits: { ...row.credits, balance } }],
    });
    const cliReport = { ...report, rows: [{ ...row, credits: { ...row.credits, periodType: 'prepaid-usd' } }] };
    expect(formatUnifiedUsage(cliReport)).toContain('89% ($67226.7008331667 left)');
    expect(formatUsageCompact(report, options)).toEqual([
      'codex default · 남은 11% · 주간 3시간 뒤에 다시 참 · 크레딧 67,227',
    ]);
    expect(formatUsageCompact(withBalance(22.3), options)).toEqual([
      'codex default · 남은 11% · 주간 3시간 뒤에 다시 참 · 크레딧 22.3',
    ]);
    expect(formatUsageCompact(withBalance(0), options)).toEqual([
      'codex default · 남은 11% · 주간 3시간 뒤에 다시 참 · 크레딧 0',
    ]);
  });

  it('긴 계정명만 생략하고 숫자를 보존하며 모르는 축은 잔량 모름으로 쓴다', async () => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [{ name: '매우긴계정이름'.repeat(30), storeKey: 'team' }, { name: 'unknown', storeKey: 'unknown' }],
      loadCodexHome: (key) => key,
      fetchCodex: async ({ codexHome }) => {
        if (codexHome === 'unknown') throw new Error('secret-token-should-not-leak');
        return codexSnap(12.5, 87.5, { resetsAt: 0 });
      },
      resolveGrokCredential: () => null,
    });
    const lines = formatUsageCompact(report, { width: 80, nowMs: Date.parse('2026-10-28T12:14:00Z') });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('… · 남은 87.5% · 주간 시각 모름 · 크레딧 10');
    expect(lines[1]).toContain('unknown · 남은 잔량 모름 · 시각 모름');
    expect(lines.join('\n')).not.toContain('secret-token-should-not-leak');
    expect(lines.join('\n')).not.toContain('잔량 모름에 다시 참');
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    const expired = formatUsageCompact({ ...report, rows: [{ ...report.rows[0]!, subscription: {
      status: 'available' as const, remainingPercent: 87.5, windowKind: 'weekly' as const,
      resetsAt: Date.parse('2026-10-27T12:14:00Z'),
    } }] }, { width: 80, nowMs: Date.parse('2026-10-28T12:14:00Z') });
    expect(expired[0]).toContain('재조회 필요');
    expect(expired[0]).not.toContain('다시 참');
  });

  it('선불에 리셋을 지어내지 않고, 알 수 없는 기간과 제어문자 계정도 한 줄로 제한한다', async () => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [{ name: 'team\nnext', storeKey: 'team' }],
      loadCodexHome: () => '/tmp/team',
      fetchCodex: async () => codexSnap(40, 60),
      resolveGrokCredential: () => null,
      openRouterKey: () => 'test-key',
      fetchOpenRouterImpl: (async () => new Response(JSON.stringify({ data: { total_credits: 60, total_usage: 1.36 } }))) as unknown as typeof fetch,
    });
    const prepaid = formatUsageCompact(report, { width: 160, nowMs: 1 })[1]!;
    expect(prepaid).toContain('openrouter default · 남은 97.7% · 크레딧 58.6');
    expect(prepaid).not.toContain('다시 참');
    const codex = report.rows[0]!;
    const unknownPeriod = { ...report, rows: [{ ...codex, subscription: { status: 'unavailable' as const, reason: 'query-does-not-supply' as const }, credits: {
      ...codex.credits, status: 'ok' as const, periodType: 'USAGE_PERIOD_TYPE_YEARLY', usedPercent: 40,
      periodStart: null, periodEnd: null, monthlyLimit: null, used: null, onDemandCap: null,
      onDemandUsed: null, prepaidBalance: null, balance: null, hasCredits: null, unlimited: null,
    } }] };
    const line = formatUsageCompact(unknownPeriod, { width: 160, nowMs: 1 })[0]!;
    expect(line).toContain('codex team next · 남은 60% · yearly 시각 모름');
    expect(line).not.toContain('\n');
  });

  it('좁은 폭은 실제 셀 폭으로 제한하고 숫자의 일부를 출력하지 않는다', async () => {
    const report = await collectUnifiedUsage({
      listCodexAccounts: () => [{ name: '📦계정'.repeat(20), storeKey: 'team' }],
      loadCodexHome: () => '/tmp/team',
      fetchCodex: async () => codexSnap(12.5, 87.5),
      resolveGrokCredential: () => null,
    });
    for (const width of [1, 2, 5, 10, 18, 25, 40]) {
      const [line] = formatUsageCompact(report, { width, nowMs: 1 });
      expect(visibleWidth(line!)).toBeLessThanOrEqual(width);
      if (/\d/.test(line!)) expect(line).toContain('87.5%');
    }
    const [line] = formatUsageCompact(report, { width: 80, nowMs: 1 });
    expect(visibleWidth(line!)).toBeLessThanOrEqual(80);
    expect(line).toContain('87.5%');
    expect(line).toContain('…');
    expect(line).not.toMatch(/[\u200d\ufe0f](?=…)/u);
    const emojiReport = { ...report, rows: [{ ...report.rows[0]!, accountName: '👩‍💻'.repeat(20) }] };
    for (const width of [60, 61, 62, 63, 64, 65]) {
      const [emojiLine] = formatUsageCompact(emojiReport, { width, nowMs: 1 });
      expect(visibleWidth(emojiLine!)).toBeLessThanOrEqual(width);
      expect(emojiLine).not.toMatch(/👩(?!‍💻)|👩‍(?!💻)/u);
    }
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
  it('빈 리포트의 기존 CLI 문면을 그대로 유지한다', () => {
    expect(formatUnifiedUsage({ rows: [], accountCounts: { codex: 0, grok: 0, openrouter: 0 } })).toBe([
      'usage — 계정마다 한 행 · 크레딧 축과 구독 축은 각각 칸',
      '  codex  accounts=0  (없음)',
      '  grok  accounts=0  (없음)',
      '  openrouter  accounts=0  (없음)',
      '  provider    account     accounts  credits.usedPercent  credits.window              window-resets-in       reset-credit-expiry                  subscription',
    ].join('\n'));
  });

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
    expect(slash?.logLines).toEqual([
      ...formatUsageCompact(report, { width: 120, nowMs: Date.now() }),
      '자세히: elanous usage',
    ]);
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
