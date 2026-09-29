export interface CreditsRow {
  name: string;
  balance?: number;
  perHour?: number;
  resetInHours?: number;
}

export interface CreditsSummary {
  totalBalance: number;
  totalPerHour: number | null;
  etaHours: number | null;
  earliestResetHours: number | null;
  beforeReset: boolean | null;
  unknownSpeedCount: number;
  unknownBalanceCount: number;
}

export function creditsSummary(rows: CreditsRow[]): CreditsSummary {
  const balances = rows.map(row => row.balance).filter((balance): balance is number =>
    typeof balance === 'number' && Number.isFinite(balance));
  const unknownBalanceCount = rows.length - balances.length;
  const totalBalance = balances.reduce((sum, balance) => sum + balance, 0);
  const measuredSpeeds = rows.map(row => row.perHour).filter((speed): speed is number =>
    typeof speed === 'number' && Number.isFinite(speed));
  const totalPerHour = measuredSpeeds.length
    ? measuredSpeeds.reduce((sum, speed) => sum + speed, 0) : null;
  const unknownSpeedCount = rows.length - measuredSpeeds.length;
  const resets = rows.map(row => row.resetInHours).filter((hours): hours is number =>
    typeof hours === 'number' && Number.isFinite(hours) && hours > 0);
  const earliestResetHours = rows.length > 0 && resets.length === rows.length ? Math.min(...resets) : null;
  const etaHours = unknownBalanceCount === 0 && totalPerHour !== null && totalPerHour < 0
    ? Math.max(0, totalBalance / -totalPerHour) : null;
  const beforeReset = etaHours === null || earliestResetHours === null
    ? null : etaHours < earliestResetHours;
  return { totalBalance, totalPerHour, etaHours, earliestResetHours, beforeReset, unknownSpeedCount, unknownBalanceCount };
}

export function formatCreditsSummary(summary: CreditsSummary): string {
  const balance = Math.round(summary.totalBalance).toLocaleString('en-US');
  const rate = summary.totalPerHour === null ? '미상'
    : `${summary.totalPerHour < 0 ? '−' : summary.totalPerHour > 0 ? '+' : ''}${Math.abs(summary.totalPerHour).toLocaleString('en-US', { maximumFractionDigits: 1 })}`;
  const speed = summary.unknownSpeedCount ? ` · 속도 모름 ${summary.unknownSpeedCount}개` : '';
  const eta = summary.etaHours === null ? ' · 고갈 시각 미상' : ` · 약 ${Math.round(summary.etaHours)}시간 뒤 0`;
  const reset = summary.earliestResetHours === null
    ? ' — 가장 이른 리셋 시각 미상'
    : summary.beforeReset === null ? ` — 가장 이른 리셋(${summary.earliestResetHours}시간)과 비교 불가`
      : summary.beforeReset
        ? ` — 가장 이른 리셋(${summary.earliestResetHours}시간)«보다 먼저»`
        : ` — 가장 이른 리셋(${summary.earliestResetHours}시간)이 먼저 옵니다`;
  const balanceLabel = summary.unknownBalanceCount ? `확인된 계정 합계 ${balance} · 잔액 모름 ${summary.unknownBalanceCount}개` : `크레딧 합계 ${balance}`;
  return `💳 ${balanceLabel} · 시간당 ${rate}${speed}${eta}${reset}`;
}
