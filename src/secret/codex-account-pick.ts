/**
 * CODEX-OAUTH-IN-VAULT (0.3.30 P0 · OP 지시 #93561) — 여유 codex 계정 선택 · 순수 함수.
 *
 * `--account` 없는 `eln secret oauth-lease codex` 의 기본 선택과 `eln codex mirror push` 가
 * 공유하는 «선택 함수 1개». 규칙(지시 원문):
 *  - 주간 사용률 80% 이상 계정은 건너뛴다(상한 초과 임대 금지)
 *  - 크레딧(구독 소진) 계정은 절대 선택하지 않는다(크레딧 지출 없음)
 *  - 사용량을 측정할 수 없는 계정은 건너뛴다(낙관 선택 금지)
 *  - 남은 계정 중 주간 사용률이 가장 낮은 계정을 고른다
 *  - 전부 막혔으면 'no-free-account' 로 거부하고 건너뛴 사유를 남긴다
 * 배선은 PR-2 — 이 모듈은 입출력만(파일·네트워크 0).
 */

export type CodexUsageStatus =
  | { kind: 'subscription'; weeklyUsedPercent: number }
  | { kind: 'credit' }
  | { kind: 'unknown' };

export type CodexAccountUsageRow = {
  account: string;
  status: CodexUsageStatus;
};

export type CodexPickSuccess = {
  ok: true;
  account: string;
  weeklyUsedPercent: number;
};

export type CodexPickRefusal = {
  ok: false;
  reason: 'no-free-account';
  skipped: Array<{ account: string; why: 'weekly-cap' | 'credit' | 'unknown' }>;
};

export type CodexPickResult = CodexPickSuccess | CodexPickRefusal;

export const FREE_ACCOUNT_WEEKLY_LIMIT_PERCENT = 80;

export function pickFreeCodexAccount(rows: readonly CodexAccountUsageRow[]): CodexPickResult {
  const skipped: CodexPickRefusal['skipped'] = [];
  let best: { account: string; weeklyUsedPercent: number } | null = null;
  for (const row of rows) {
    if (row.status.kind === 'unknown') {
      skipped.push({ account: row.account, why: 'unknown' });
      continue;
    }
    if (row.status.kind === 'credit') {
      skipped.push({ account: row.account, why: 'credit' });
      continue;
    }
    if (row.status.weeklyUsedPercent >= FREE_ACCOUNT_WEEKLY_LIMIT_PERCENT) {
      skipped.push({ account: row.account, why: 'weekly-cap' });
      continue;
    }
    if (best === null || row.status.weeklyUsedPercent < best.weeklyUsedPercent) {
      best = { account: row.account, weeklyUsedPercent: row.status.weeklyUsedPercent };
    }
  }
  if (best === null) {
    return { ok: false, reason: 'no-free-account', skipped };
  }
  return { ok: true, account: best.account, weeklyUsedPercent: best.weeklyUsedPercent };
}
