import type { DaemonClient } from '@/lib/daemon-client';

/** DRAFT-METRIC — daemon `/v1/drafts/metrics` answers from a TTL cache; the page never triggers GitHub reads. */
export const DRAFT_METRICS_PATH = '/v1/drafts/metrics';

export interface DraftMetricsView {
  inventory: number;
  oldestAgeHours: number | null;
  needsOwner: number;
  converted48h: number;
  cohort48h: number;
  conversion48h: number | null;
}

/** measuring = daemon has no value yet · unavailable = read failed or the daemon could not measure. */
export type DraftMetricsCardValue =
  | { kind: 'loading' }
  | { kind: 'measuring' }
  | { kind: 'unavailable'; reason: string | null }
  | { kind: 'ready'; metrics: DraftMetricsView; measuredAt: string; refreshError: string | null };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const nullableNumber = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value));

/** Anything malformed is «못 읽음», never a zero. */
export function parseDraftMetricsBody(body: unknown): DraftMetricsCardValue {
  if (!isObject(body)) return { kind: 'unavailable', reason: null };
  const reason = typeof body.reason === 'string' ? body.reason : null;
  if (body.state === 'measuring') return { kind: 'measuring' };
  if (body.state === 'unavailable') return { kind: 'unavailable', reason };
  const metrics = body.metrics;
  if (body.state !== 'ready' || !isObject(metrics) || typeof body.measuredAt !== 'string' || !Number.isFinite(Date.parse(body.measuredAt))
    || !count(metrics.inventory) || !count(metrics.needsOwner) || !count(metrics.converted48h) || !count(metrics.cohort48h)
    || !nullableNumber(metrics.oldestAgeHours) || !nullableNumber(metrics.conversion48h)) return { kind: 'unavailable', reason: null };
  return {
    kind: 'ready', measuredAt: body.measuredAt, refreshError: reason,
    metrics: { inventory: metrics.inventory, oldestAgeHours: metrics.oldestAgeHours, needsOwner: metrics.needsOwner,
      converted48h: metrics.converted48h, cohort48h: metrics.cohort48h, conversion48h: metrics.conversion48h },
  };
}

export async function readDraftMetrics(client: DaemonClient): Promise<DraftMetricsCardValue> {
  try {
    const response = await client.fetchResponse(DRAFT_METRICS_PATH);
    if (!response.ok) return { kind: 'unavailable', reason: null };
    return parseDraftMetricsBody(await response.json());
  } catch { return { kind: 'unavailable', reason: null }; }
}

function age(hours: number | null): string {
  if (hours === null) return '해당 없음';
  return hours >= 48 ? `${(hours / 24).toFixed(1)}일` : `${hours.toFixed(1)}시간`;
}

function kstTime(iso: string): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function DraftMetricsCard({ value }: { value: DraftMetricsCardValue }) {
  const title = 'draft 재고';
  return <section aria-label={title} className="col-span-2 min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4">
    <h2 className="text-xs font-medium text-muted-foreground sm:text-sm">{title}</h2>
    {value.kind === 'loading' ? <p className="mt-2 text-sm">불러오는 중…</p>
      : value.kind === 'measuring' ? <p className="mt-2 text-sm">측정 중</p>
        : value.kind === 'unavailable' ? <p className="mt-2 text-sm" title={value.reason ?? undefined}>못 읽음</p>
          : <>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4 sm:text-sm">
              <div className="min-w-0"><dt className="text-muted-foreground">열린 draft</dt><dd className="text-lg font-semibold tabular-nums sm:text-xl">{value.metrics.inventory}</dd></div>
              <div className="min-w-0"><dt className="text-muted-foreground">최장 나이</dt><dd className="text-lg font-semibold tabular-nums sm:text-xl">{age(value.metrics.oldestAgeHours)}</dd></div>
              <div className="min-w-0"><dt className="text-muted-foreground">주인 표식 없는 draft</dt><dd className="text-lg font-semibold tabular-nums sm:text-xl">{value.metrics.needsOwner}</dd>
                {/* 전부 표식 없음 = 아무도 claim 하지 않는다 — 숫자가 «주인 없음»이 아니라 «표식 0건»임을 숨기지 않는다. */}
                {value.metrics.inventory > 0 && value.metrics.needsOwner === value.metrics.inventory && <dd className="text-muted-foreground">처리 중 표식 0건</dd>}</div>
              <div className="min-w-0"><dt className="text-muted-foreground">48h 전환율</dt><dd className="text-lg font-semibold tabular-nums sm:text-xl">{value.metrics.conversion48h === null
                ? '표본 없음' : `${(value.metrics.conversion48h * 100).toFixed(1)}%`}</dd>
                {value.metrics.conversion48h !== null && <dd className="text-muted-foreground tabular-nums">{value.metrics.converted48h}/{value.metrics.cohort48h}</dd>}</div>
            </dl>
            <p className="mt-1 text-xs text-muted-foreground"><time dateTime={value.measuredAt}>{kstTime(value.measuredAt)}</time> 측정
              {value.refreshError && <span className="ml-1 text-amber-700" title={value.refreshError}>· 갱신 실패 — 이전 값</span>}</p>
          </>}
  </section>;
}
