import type { LogStoreRow } from '../mss/logging/log-store.js';

export interface MeasuredApiSpendRow {
  readonly tier: string;
  readonly provider: string;
  readonly model: string;
  readonly calls: number;
  readonly usd: number;
}

export interface MeasuredApiSpend {
  readonly windowMinutes: 60;
  readonly rows: readonly MeasuredApiSpendRow[];
  readonly excludedCalls: number;
  readonly truncated: boolean;
  /** Usage events do not prove a successful result for each call. */
  readonly recommendation: null;
}

/** Local llm.usage only. Unknown price, tier or outcome never becomes a cost recommendation. */
export function measuredApiSpend(rows: readonly LogStoreRow[], nowMs: number, truncated = false): MeasuredApiSpend {
  const groups = new Map<string, MeasuredApiSpendRow>();
  let excludedCalls = 0;
  for (const row of rows) {
    if (row.category !== 'llm.usage' || row.event !== 'llm-usage') continue;
    const at = Date.parse(row.ts);
    if (!Number.isFinite(at) || at > nowMs || at < nowMs - 60 * 60_000) continue;
    let data: Record<string, unknown>;
    try { data = JSON.parse(row.data ?? '') as Record<string, unknown>; }
    catch { excludedCalls++; continue; }
    if (!data || typeof data !== 'object' || data.billing !== 'api') continue;
    const cost = data.cost;
    if (data.estimated === true || typeof data.billingProvider !== 'string' || !data.billingProvider.trim()
      || typeof data.model !== 'string' || !data.model.trim()
      || !['weak', 'mid', 'strong'].includes(String(data.workTier))
      || !cost || typeof cost !== 'object' || (cost as { kind?: unknown }).kind !== 'known'
      || typeof (cost as { usd?: unknown }).usd !== 'number'
      || !Number.isFinite((cost as { usd: number }).usd) || (cost as { usd: number }).usd < 0) {
      excludedCalls++;
      continue;
    }
    const tier = data.workTier as string;
    const provider = data.billingProvider.trim();
    const model = data.model.trim();
    const key = JSON.stringify([tier, provider, model]);
    const previous = groups.get(key);
    groups.set(key, { tier, provider, model, calls: (previous?.calls ?? 0) + 1,
      usd: (previous?.usd ?? 0) + (cost as { usd: number }).usd });
  }
  return { windowMinutes: 60, rows: [...groups.values()].sort((a, b) => a.tier.localeCompare(b.tier)
    || a.usd / a.calls - b.usd / b.calls || a.provider.localeCompare(b.provider)), excludedCalls,
    truncated, recommendation: null };
}

export function formatMeasuredApiSpend(report: MeasuredApiSpend): string {
  const lines = ['최근 60분 로컬 API 실측 비용 · 같은 등급별 호출당 비용 (성공 결과당 비용 아님)'];
  const safe = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 100);
  for (const row of report.rows) lines.push(`  ${row.tier}  ${safe(row.provider)}/${safe(row.model)}  calls=${row.calls}  usd=${row.usd.toFixed(6)}  usd/call=${(row.usd / row.calls).toFixed(6)}`);
  if (report.rows.length === 0) lines.push('  측정된 API 비용 없음');
  lines.push(`  제외 ${report.excludedCalls}건${report.truncated ? ' · 조회 상한 도달(일부 행)' : ''} · 추천 보류: 같은 등급의 성공 결과와 비용이 결속되지 않음`);
  return lines.join('\n');
}
