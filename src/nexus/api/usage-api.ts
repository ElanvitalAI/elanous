import { collectUnifiedUsage } from '../../budget/unified-usage.js';
import type { UnifiedUsageReport } from '../../budget/types.js';
import { jsonResponse } from './json-response.js';

const CACHE_MS = 30_000;

// TC 조건(10-03 01:21): 계정 이름·이메일·토큰은 응답에 «하나도» 싣지 않는다 — 공급자·사용률·리셋만.
// 계정이 여럿이면 공급자 안 순번(«계정 1»)으로만 가른다(이름에서 비밀을 걸러 내는 방식은 쓰지 않는다).
function accountLabel(index: number, count: number): string {
  return count > 1 ? `계정 ${index + 1}` : '계정';
}

const SAFE_REASONS = new Set(['query-does-not-supply', 'not-a-subscription']);
function safeReason(reason: unknown): string {
  return typeof reason === 'string' && SAFE_REASONS.has(reason) ? reason : 'unknown';
}

function periodType(value: string | null): string | null {
  return value && /^(?:session|weekly|monthly|daily|prepaid-usd|USAGE_PERIOD_TYPE_(?:SESSION|WEEKLY|MONTHLY|DAILY))$/.test(value) ? value : null;
}

function isoDate(value: string | null): string | null {
  if (!value) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : null;
}

function resetsInMs(resetsAt: number, nowMs: number): number | null {
  return Number.isFinite(resetsAt) && resetsAt > 0 ? Math.max(0, resetsAt - nowMs) : null;
}

function projectUsage(report: UnifiedUsageReport, nowMs: number) {
  return {
    ok: true as const,
    accountCounts: {
      codex: report.accountCounts.codex,
      grok: report.accountCounts.grok,
      openrouter: report.accountCounts.openrouter,
    },
    rows: report.rows.map((row, _i, rows) => ({
      provider: row.provider,
      account: accountLabel(rows.filter((r) => r.provider === row.provider).indexOf(row), rows.filter((r) => r.provider === row.provider).length),
      accountCount: row.accountCount,
      soleAccount: row.soleAccount,
      credits: row.credits.status === 'ok' ? {
        status: 'ok' as const,
        usedPercent: row.credits.usedPercent,
        periodType: periodType(row.credits.periodType),
        periodStart: isoDate(row.credits.periodStart),
        periodEnd: isoDate(row.credits.periodEnd),
        resetsInMs: resetsInMs(row.credits.periodEnd ? Date.parse(row.credits.periodEnd) : 0, nowMs),
        monthlyLimit: row.credits.monthlyLimit,
        used: row.credits.used,
        onDemandCap: row.credits.onDemandCap,
        onDemandUsed: row.credits.onDemandUsed,
        prepaidBalance: row.credits.prepaidBalance,
        balance: row.credits.balance,
        hasCredits: row.credits.hasCredits,
        unlimited: row.credits.unlimited,
      } : { status: row.credits.status },
      subscription: row.subscription.status === 'available' ? {
        status: 'available' as const,
        remainingPercent: row.subscription.remainingPercent,
        resetsAt: row.subscription.resetsAt,
        resetsInMs: resetsInMs(row.subscription.resetsAt, nowMs),
        windowKind: row.subscription.windowKind,
      } : { status: 'unavailable' as const, reason: safeReason(row.subscription.reason) },
      resetCredits: row.resetCredits.status === 'available' || row.resetCredits.status === 'expiring-soon' || row.resetCredits.status === 'expired' ? {
        status: row.resetCredits.status,
        expiresAt: isoDate(row.resetCredits.expiresAt),
        hasUnknownExpiry: row.resetCredits.hasUnknownExpiry,
      } : { status: row.resetCredits.status },
    })),
  };
}

/** A per-daemon 30-second snapshot; concurrent requests share the same collection. */
export function createUsageHandler(
  collect: () => Promise<UnifiedUsageReport> = collectUnifiedUsage,
  now: () => number = Date.now,
): () => Promise<Response> {
  let cached: ReturnType<typeof projectUsage> | undefined;
  let cachedAt = 0;
  let pending: Promise<ReturnType<typeof projectUsage>> | undefined;
  return async () => {
    if (cached && now() - cachedAt < CACHE_MS) return jsonResponse(cached);
    pending ??= Promise.resolve().then(collect).then((report) => {
      const value = projectUsage(report, now());
      cached = value;
      cachedAt = now();
      return value;
    }).finally(() => { pending = undefined; });
    try {
      return jsonResponse(await pending);
    } catch {
      // Upstream exceptions can contain credentials; never echo their messages.
      return jsonResponse({ ok: false, reason: 'usage-collection-failed' });
    }
  };
}

export const handleUsageGet = createUsageHandler();
