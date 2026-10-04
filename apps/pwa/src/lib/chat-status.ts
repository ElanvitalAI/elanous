export interface UsageRow {
  provider: string;
  account: string;
  subscription?: { status: string; remainingPercent?: number | null; resetsInMs?: number | null; reason?: string };
  credits?: { status: string; usedPercent?: number | null; reason?: string };
}

export interface UsageBody {
  ok: boolean;
  rows?: UsageRow[];
}

/** Raw 0–100 value, unrounded — comparisons must use this (8.4% vs 8.1% both round to 8). */
function rawPercent(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function percent(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value) : null;
}

function resetText(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return ` · ${minutes}분 뒤 초기화`;
  if (minutes < 1_440) return ` · ${Math.ceil(minutes / 60)}시간 뒤 초기화`;
  return ` · ${Math.ceil(minutes / 1_440)}일 뒤 초기화`;
}

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
}

function detail(row: UsageRow): string {
  const remaining = row.subscription?.status === 'available'
    ? percent(row.subscription.remainingPercent) : null;
  if (remaining !== null) return `남은 ${remaining}%${resetText(row.subscription?.resetsInMs)}`;
  const used = row.credits?.status === 'ok' ? percent(row.credits.usedPercent) : null;
  if (used !== null) return `사용 ${used}%`;
  const reason = row.subscription?.reason ?? row.credits?.reason ?? '정보 없음';
  return `못 읽음(${oneLine(reason).slice(0, 40)})`;
}

export function remainingLines(usage: UsageBody): string[] {
  if (!usage.ok || !Array.isArray(usage.rows)) return [];
  return usage.rows.map((row) => `${oneLine(row.provider)} ${oneLine(row.account)} · ${detail(row)}`);
}

export function statusText({ sessionId, provider, model, version, usage }: {
  sessionId: string;
  provider: string;
  model?: string;
  version?: string;
  usage?: UsageBody;
}): string {
  const rows = usage?.ok && Array.isArray(usage.rows) ? usage.rows : [];
  const remaining = (row: UsageRow): number | null => {
    const subscription = row.subscription?.status === 'available' ? rawPercent(row.subscription.remainingPercent) : null;
    if (subscription !== null) return subscription;
    const used = row.credits?.status === 'ok' ? rawPercent(row.credits.usedPercent) : null;
    return used === null ? null : 100 - used;
  };
  const least = rows.reduce<UsageRow | undefined>((lowest, row) => {
    const value = remaining(row);
    const previous = lowest ? remaining(lowest) : null;
    return value !== null && (previous === null || value < previous) ? row : lowest;
  }, undefined);
  const summary = least ? remainingLines({ ok: true, rows: [least] })[0]
    : rows.length ? remainingLines({ ok: true, rows: [rows[0]!] })[0]
      : usage?.ok && Array.isArray(usage.rows) ? '등록된 계정이 없습니다' : '남은 양을 읽지 못했습니다';
  return [
    `대화: ${sessionId.slice(0, 8)}`,
    `모델: ${provider}/${model || '미확인'}`,
    `데몬 판: ${version ?? '확인할 수 없음'}`,
    `남은 양: ${summary}`,
  ].join('\n');
}
