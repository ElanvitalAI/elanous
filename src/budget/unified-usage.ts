// Unified usage assembly — outside UsageStore's single-provider snapshot map.
//
// Codex: enumerate known account names, fetch each via the existing
// ProviderFetcher with CODEX_HOME on the child env only.
// Grok: this wiring has no multi-account list — 0 or 1 current-credential row.
// Claude / Gemini are intentionally out of this landing.

import { createCodexFetcher, type CodexFetcherOpts } from './fetchers/codex.js';
import {
  fetchGrokUsage,
  GROK_SUBSCRIPTION_AXIS,
  grokUsageToCreditAxis,
  type GrokUsageResult,
} from '../grok/usage.js';
import { resolveGrokCredential } from '../grok/credential.js';
import { getOpenRouterApiKey } from '../config.js';
import { listCodexAccountsInStore } from '../oauth/codex-account-store.js';
import { loadTokens } from '../oauth/store.js';
import { envLiteral } from '../platform/env-literal.js';
import { describeResetCreditExpiry } from './codex-reset-credit-state.js';
import { listCodexResetCredits, type CodexResetCreditsResult } from './codex-reset-credits.js';
import type {
  AccountUsageRow,
  CreditAxis,
  ResetCreditExpiryAxis,
  SubscriptionAxis,
  UnifiedUsageReport,
  UsageSnapshot,
  WindowKind,
} from './types.js';

const GROK_ACCOUNT_NAME = 'default';

export interface UnifiedUsageDeps {
  /** Test seam — bypass live credential + network. */
  readonly fetchGrok?: () => Promise<GrokUsageResult>;
  readonly fetchGrokImpl?: typeof fetch;
  readonly grokSignal?: AbortSignal;
  readonly listCodexAccounts?: () => readonly { readonly name: string; readonly storeKey: string }[];
  /** Test seam — same injection convention as listCodexAccounts. */
  readonly resolveGrokCredential?: () => unknown;
  readonly loadCodexHome?: (storeKey: string) => string | undefined;
  readonly fetchCodex?: (opts: CodexFetcherOpts) => Promise<UsageSnapshot>;
  /** Reads a Codex account's reset credits without consuming them. */
  readonly listCodexResetCredits?: (opts: { env?: NodeJS.ProcessEnv }) => Promise<CodexResetCreditsResult>;
  /** Configuration-owned warning horizon; undefined deliberately remains observable as unavailable. */
  readonly resetCreditExpiryWarningMs?: number;
  readonly now?: () => number;
  /** 결정 2026-09-23 — OpenRouter 선불 크레딧 조회 seam. 없으면 실키로 `/api/v1/credits`. */
  readonly openRouterKey?: () => string | undefined;
  readonly fetchOpenRouterImpl?: typeof fetch;
}

export async function collectUnifiedUsage(deps: UnifiedUsageDeps = {}): Promise<UnifiedUsageReport> {
  const [codexRows, grokRows, openRouterRows] = await Promise.all([
    collectCodexRows(deps),
    collectGrokRows(deps),
    collectOpenRouterRows(deps),
  ]);
  return {
    rows: [...codexRows, ...grokRows, ...openRouterRows],
    accountCounts: {
      codex: codexRows.length,
      grok: grokRows.length,
      openrouter: openRouterRows.length,
    },
  };
}

async function collectCodexRows(deps: UnifiedUsageDeps): Promise<AccountUsageRow[]> {
  const listed = (deps.listCodexAccounts ?? listCodexAccountsInStore)();
  const accounts = listed;
  const accountCount = accounts.length;
  const soleAccount = accountCount === 1;
  const loadHome = deps.loadCodexHome ?? ((storeKey: string) => loadTokens(storeKey)?.codexHome);
  const fetchOne = deps.fetchCodex ?? ((opts: CodexFetcherOpts) => createCodexFetcher(opts).fetch());
  const listResetCredits = deps.listCodexResetCredits ?? listCodexResetCredits;
  const warningWindowMs = deps.resetCreditExpiryWarningMs ?? configuredResetCreditExpiryWarningMs();
  const nowMs = (deps.now ?? Date.now)();

  const rows: AccountUsageRow[] = [];
  for (const account of accounts) {
    const home = loadHome(account.storeKey);
    const resetCreditsPromise = collectResetCreditExpiry(listResetCredits, home, warningWindowMs, nowMs)
      .catch((error): ResetCreditExpiryAxis => ({
        status: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
      }));
    try {
      const snap = await fetchOne(home ? { codexHome: home } : {});
      rows.push({
        provider: 'codex',
        accountName: account.name,
        accountCount,
        soleAccount,
        credits: creditsFromCodexSnapshot(snap),
        subscription: subscriptionFromCodexSnapshot(snap),
        resetCredits: await resetCreditsPromise,
      });
    } catch (err) {
      rows.push({
        provider: 'codex',
        accountName: account.name,
        accountCount,
        soleAccount,
        credits: { status: 'error', detail: err instanceof Error ? err.message : String(err) },
        subscription: { status: 'unavailable', reason: 'query-does-not-supply' },
        resetCredits: await resetCreditsPromise,
      });
    }
  }
  return rows;
}

async function collectGrokRows(deps: UnifiedUsageDeps): Promise<AccountUsageRow[]> {
  const resolve = deps.resolveGrokCredential ?? resolveGrokCredential;
  let present = true;
  try {
    present = resolve() !== null;
  } catch {
    present = true;
  }
  if (!present) return [];
  const result = await (deps.fetchGrok
    ? deps.fetchGrok()
    : fetchGrokUsage({
        ...(deps.fetchGrokImpl ? { fetchImpl: deps.fetchGrokImpl } : {}),
        ...(deps.grokSignal ? { signal: deps.grokSignal } : {}),
      }));
  const accountCount = 1;
  const base = {
    provider: 'grok' as const,
    accountName: GROK_ACCOUNT_NAME,
    accountCount,
    soleAccount: true,
    subscription: GROK_SUBSCRIPTION_AXIS,
    resetCredits: { status: 'not-applicable' } as const,
  };
  if (result.status === 'ok') {
    return [{ ...base, credits: grokUsageToCreditAxis(result.usage) }];
  }
  if (result.status === 'no-subscription') {
    return [{ ...base, credits: { status: 'no-subscription' } }];
  }
  if (result.status === 'unauthorized') {
    return [{ ...base, credits: { status: 'unauthorized' } }];
  }
  return [{ ...base, credits: { status: 'error', detail: result.detail } }];
}

/**
 * 「만료 임박」으로 볼 창 — 기본 24시간.
 *
 * ⛔ 종전엔 env 가 «없으면» undefined 를 돌려줬고, 그러면 판정이
 *   `unavailable (invalid-warning-window)` 로 «막혔다». 그래서 사람이 그 env 이름을
 *   «알아야만» 「리셋권이 있나」를 볼 수 있었다(2026-08-19 실측: 세 계정 전부 그 상태).
 * 🔑 그런데 창은 「임박이냐」를 가를 뿐이고, ***「있나/없나」는 창과 무관하다***.
 *   ⇒ 기본을 주면 `none`·`available`·`expired` 가 «그냥 보인다». env 는 여전히 이긴다.
 * ⛔ 잘못된 값(음수·NaN)은 «조용히 기본으로 접지 않고» undefined 를 돌려준다 —
 *   사람이 오타를 냈다는 사실이 산출에서 사라지면 안 된다.
 */
export const DEFAULT_RESET_CREDIT_EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

function configuredResetCreditExpiryWarningMs(): number | undefined {
  const raw = process.env.ELANOUS_CODEX_RESET_CREDIT_EXPIRY_WARNING_MS?.trim();
  if (!raw) return DEFAULT_RESET_CREDIT_EXPIRY_WARNING_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function collectResetCreditExpiry(
  listResetCredits: (opts: { env?: NodeJS.ProcessEnv }) => Promise<CodexResetCreditsResult>,
  home: string | undefined,
  warningWindowMs: number | undefined,
  nowMs: number,
): Promise<ResetCreditExpiryAxis> {
  const listed = await listResetCredits(home ? { env: envLiteral({ CODEX_HOME: home }) } : {});
  if (!listed.ok) return { status: 'unavailable', detail: listed.kind };
  return describeResetCreditExpiry(listed.value.credits, warningWindowMs, nowMs);
}

function creditsFromCodexSnapshot(snap: UsageSnapshot): CreditAxis {
  const brand = snap.windows.find((w) => w.model === undefined) ?? snap.windows[0];
  const periodEnd = brand && isValidEpochMs(brand.resetsAt) ? new Date(brand.resetsAt) : null;
  const periodStartEpoch = periodEnd && isPositiveFinite(brand.windowMinutes)
    ? periodEnd.getTime() - brand.windowMinutes * 60_000
    : null;
  const periodStart = periodStartEpoch !== null && isValidDateMs(periodStartEpoch)
    ? new Date(periodStartEpoch)
    : null;
  return {
    status: 'ok',
    usedPercent: brand ? brand.used : null,
    periodType: brand?.kind ?? null,
    periodStart: periodStart?.toISOString() ?? null,
    periodEnd: periodEnd?.toISOString() ?? null,
    monthlyLimit: null,
    used: brand ? brand.used : null,
    onDemandCap: null,
    onDemandUsed: null,
    prepaidBalance: snap.credits?.balance ?? null,
    balance: snap.credits?.balance ?? null,
    hasCredits: snap.credits?.hasCredits ?? null,
    unlimited: snap.credits?.unlimited ?? null,
  };
}

function subscriptionFromCodexSnapshot(snap: UsageSnapshot): SubscriptionAxis {
  const brand = snap.windows.find((w) => w.model === undefined) ?? snap.windows[0];
  if (!brand) return { status: 'unavailable', reason: 'query-does-not-supply' };
  return {
    status: 'available',
    remainingPercent: brand.remainingPercent,
    resetsAt: brand.resetsAt,
    windowKind: brand.kind as WindowKind,
  };
}

/** 결정 2026-09-23 — OpenRouter 는 «선불 달러» 크레딧이다(창·리셋 없음).
 *  ⛔ 키가 없으면 행을 «안» 만든다(accounts=0 → 「없음」) — 키 없음은 «0달러»가 아니다.
 *  📏 응답 모양(실측 2026-09-23): `{data:{total_credits, total_usage}}` (USD). */
export const OPENROUTER_CREDITS_ENDPOINT = 'https://openrouter.ai/api/v1/credits';
async function collectOpenRouterRows(deps: UnifiedUsageDeps): Promise<AccountUsageRow[]> {
  // ⛔ 시험 런타임은 seam 이 없으면 «키 없음»으로 본다 — 키 캐시는 «파일»이라 env 스크럽을 통과해
  //   기존 시험들이 실제 네트워크를 치게 된다(seam 을 모르는 옛 시험이 다수).
  const key = (deps.openRouterKey ?? (process.env.NODE_ENV === 'test' ? () => undefined : getOpenRouterApiKey))();
  if (!key) return [];
  const base = {
    provider: 'openrouter' as const,
    accountName: 'default',
    accountCount: 1,
    soleAccount: true,
    subscription: { status: 'unavailable', reason: 'not-a-subscription' } as const,
    resetCredits: { status: 'not-applicable' } as const,
  };
  try {
    const res = await (deps.fetchOpenRouterImpl ?? fetch)(OPENROUTER_CREDITS_ENDPOINT, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return [{ ...base, credits: { status: 'unauthorized' } }];
    if (!res.ok) return [{ ...base, credits: { status: 'error', detail: `http-${res.status}` } }];
    const body = (await res.json()) as { data?: { total_credits?: unknown; total_usage?: unknown } };
    const total = typeof body.data?.total_credits === 'number' ? body.data.total_credits : null;
    const used = typeof body.data?.total_usage === 'number' ? body.data.total_usage : null;
    if (total === null || used === null) return [{ ...base, credits: { status: 'error', detail: 'upstream-shape' } }];
    const balance = Math.round((total - used) * 100) / 100;
    return [{
      ...base,
      credits: {
        status: 'ok',
        usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : null,
        periodType: 'prepaid-usd',
        periodStart: null,
        periodEnd: null,
        monthlyLimit: null,
        used: Math.round(used * 100) / 100,
        onDemandCap: null,
        onDemandUsed: null,
        prepaidBalance: total,
        balance,
        hasCredits: balance > 0,
        unlimited: false,
      },
    }];
  } catch (err) {
    return [{ ...base, credits: { status: 'error', detail: err instanceof Error ? err.message : String(err) } }];
  }
}

export function formatUnifiedUsage(report: UnifiedUsageReport): string {
  const lines: string[] = [
    'usage — 계정마다 한 행 · 크레딧 축과 구독 축은 각각 칸',
  ];
  for (const provider of ['codex', 'grok', 'openrouter'] as const) {
    const count = report.accountCounts[provider];
    lines.push(`  ${provider}  accounts=${count}${count === 1 ? '  (하나뿐)' : count === 0 ? '  (없음)' : ''}`);
  }
  lines.push('  provider    account     accounts  credits.usedPercent  credits.window              window-resets-in       reset-credit-expiry                  subscription');
  for (const row of report.rows) {
    lines.push(formatRow(row));
  }
  return lines.join('\n');
}

function formatRow(row: AccountUsageRow): string {
  const credits = formatCreditsCell(row.credits);
  const window = formatCreditsWindow(row.credits);
  const resetsIn = formatWindowResetsIn(row.credits);
  const resetCredits = formatResetCreditExpiryCell(row.resetCredits);
  const subscription = formatSubscriptionCell(row.subscription);
  return `  ${row.provider.padEnd(10)} ${row.accountName.padEnd(11)} ${String(row.accountCount).padEnd(8)} ${credits.padEnd(20)} ${window.padEnd(26)} ${resetsIn.padEnd(22)} ${resetCredits.padEnd(36)} ${subscription}`;
}

function formatResetCreditExpiryCell(expiry: ResetCreditExpiryAxis): string {
  switch (expiry.status) {
    case 'not-applicable': return 'not-applicable';
    case 'unavailable': return `unavailable (${expiry.detail})`;
    case 'none': return 'none';
    case 'unknown-expiry': return 'available expiry=unknown';
    case 'available': return `available expires=${expiry.expiresAt}${expiry.hasUnknownExpiry ? ' +unknown' : ''}`;
    case 'expiring-soon': return `EXPIRING-SOON expires=${expiry.expiresAt}${expiry.hasUnknownExpiry ? ' +unknown' : ''}`;
    case 'expired': return `EXPIRED expires=${expiry.expiresAt}${expiry.hasUnknownExpiry ? ' +unknown' : ''}`;
  }
}

function formatCreditsCell(credits: CreditAxis): string {
  if (credits.status !== 'ok') return credits.status;
  if (credits.usedPercent === null) return 'unknown';
  // 선불 달러 — 퍼센트만으로는 «얼마 남았나»를 못 읽는다.
  if (credits.periodType === 'prepaid-usd' && credits.balance !== null) return `${credits.usedPercent}% ($${credits.balance} left)`;
  return `${credits.usedPercent}%`;
}

function formatCreditsWindow(credits: CreditAxis): string {
  if (credits.status !== 'ok') return '—';
  if (credits.periodType === 'prepaid-usd') return 'prepaid (창 없음)';
  const type = credits.periodType ?? '—';
  if (credits.periodStart && credits.periodEnd) {
    return `${type} ${credits.periodStart.slice(0, 10)}~${credits.periodEnd.slice(0, 10)}`;
  }
  return `${type} unknown`;
}

/**
 * 「이 창이 «언제» 풀리나」 — 사람이 「언제 다시 쓸 수 있나」를 읽는 칸.
 *
 * ⛔ 창 끝을 «날짜»로만 보이면 사람이 남은 시간을 «머리로 계산»해야 한다(대표 2026-08-19 지적).
 *   ⇒ 남은 시간을 «값으로» 낸다.
 * ⛔ 그리고 「모른다」와 「이미 지났다」를 «다른 값»으로 낸다 —
 *   창 끝이 없으면 unknown 이고, 지났으면 그 사실을 말한다(다음 조회에 갱신될 값이므로).
 */
export function formatWindowResetsIn(credits: CreditAxis, nowMs: number = Date.now()): string {
  if (credits.status !== 'ok') return '—';
  if (credits.periodType === 'prepaid-usd') return 'n/a (리셋 없음)';
  const end = credits.periodEnd ? Date.parse(credits.periodEnd) : Number.NaN;
  if (!Number.isFinite(end)) return 'unknown';
  const remainMs = end - nowMs;
  if (remainMs <= 0) return 'elapsed (재조회 필요)';
  const hours = Math.floor(remainMs / 3_600_000);
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  const minutes = Math.floor((remainMs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${restHours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidEpochMs(value: number): boolean {
  return isPositiveFinite(value) && isValidDateMs(value);
}

function isValidDateMs(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}

function formatSubscriptionCell(subscription: SubscriptionAxis): string {
  if (subscription.status === 'unavailable') {
    if (subscription.reason === 'not-a-subscription') return 'not-applicable (선불)';
    return `unavailable (${subscription.reason})`;
  }
  return `available remaining=${subscription.remainingPercent}% ${subscription.windowKind}`;
}
