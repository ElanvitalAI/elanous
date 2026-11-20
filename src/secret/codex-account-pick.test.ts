import { describe, expect, test } from 'bun:test';
import {
  FREE_ACCOUNT_WEEKLY_LIMIT_PERCENT,
  pickFreeCodexAccount,
  type CodexAccountUsageRow,
} from './codex-account-pick';
import {
  CODEX_VAULT_ITEM_KIND,
  CODEX_VAULT_ITEM_OWNER_HOST,
  CODEX_VAULT_ITEM_TRANSFER,
  codexVaultItemId,
} from './codex-vault-items';

const sub = (weeklyUsedPercent: number) => ({ kind: 'subscription' as const, weeklyUsedPercent });

describe('pickFreeCodexAccount — 여유 계정 자동 선택 (OP 지시 #93561 · 설계 메모 #93600)', () => {
  test('가장 낮은 주간 사용률 계정을 고른다 (default 10% vs team 30%)', () => {
    const rows: CodexAccountUsageRow[] = [
      { account: 'default', status: sub(10) },
      { account: 'team', status: sub(30) },
    ];
    expect(pickFreeCodexAccount(rows)).toEqual({ ok: true, account: 'default', weeklyUsedPercent: 10 });
  });

  test('주간 사용률 80% 이상은 건너뛴다 (team 85% → default 선택)', () => {
    const rows: CodexAccountUsageRow[] = [
      { account: 'default', status: sub(50) },
      { account: 'team', status: sub(85) },
    ];
    const result = pickFreeCodexAccount(rows);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.account).toBe('default');
      expect(result.weeklyUsedPercent).toBe(50);
    }
  });

  test('측정 불가(unknown) 계정은 낙관 선택하지 않고 건너뛴다', () => {
    const rows: CodexAccountUsageRow[] = [
      { account: 'third', status: { kind: 'unknown' } },
      { account: 'default', status: sub(70) },
    ];
    const result = pickFreeCodexAccount(rows);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.account).toBe('default');
  });

  test('크레딧 계정(구독 소진)은 선택하지 않는다', () => {
    const rows: CodexAccountUsageRow[] = [
      { account: 'team', status: { kind: 'credit' } },
      { account: 'default', status: sub(20) },
    ];
    const result = pickFreeCodexAccount(rows);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.account).toBe('default');
  });

  test('전부 막혔으면 no-free-account 로 거부하고 건너뛴 사유를 그대로 남긴다', () => {
    const rows: CodexAccountUsageRow[] = [
      { account: 'default', status: sub(95) },
      { account: 'team', status: { kind: 'credit' } },
      { account: 'third', status: { kind: 'unknown' } },
    ];
    expect(pickFreeCodexAccount(rows)).toEqual({
      ok: false,
      reason: 'no-free-account',
      skipped: [
        { account: 'default', why: 'weekly-cap' },
        { account: 'team', why: 'credit' },
        { account: 'third', why: 'unknown' },
      ],
    });
  });

  test('사용률이 같으면 입력 순서가 앞선 계정을 고른다', () => {
    const rows: CodexAccountUsageRow[] = [
      { account: 'team', status: sub(25) },
      { account: 'default', status: sub(25) },
    ];
    const result = pickFreeCodexAccount(rows);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.account).toBe('team');
  });

  test('상한은 미만 경계까지 허용한다 (79.9% 선택 가능 · 80% 거부)', () => {
    expect(pickFreeCodexAccount([{ account: 'default', status: sub(79.9) }]).ok).toBe(true);
    expect(pickFreeCodexAccount([{ account: 'default', status: sub(80) }]).ok).toBe(false);
  });

  test('빈 입력도 no-free-account 로 거부한다', () => {
    expect(pickFreeCodexAccount([])).toEqual({ ok: false, reason: 'no-free-account', skipped: [] });
  });

  test('상한 상수는 80 (지시 원문)', () => {
    expect(FREE_ACCOUNT_WEEKLY_LIMIT_PERCENT).toBe(80);
  });
});

describe('codex-vault-items — 금고 항목 식별 상수', () => {
  test('항목 id 는 oauth:codex:<account> · 메타 칸은 지시 원문 그대로', () => {
    expect(codexVaultItemId('default')).toBe('oauth:codex:default');
    expect(codexVaultItemId('team')).toBe('oauth:codex:team');
    expect(CODEX_VAULT_ITEM_KIND).toBe('oauth-refresh-owner');
    expect(CODEX_VAULT_ITEM_TRANSFER).toBe('mirror-lease');
    expect(CODEX_VAULT_ITEM_OWNER_HOST).toBe('mshq');
  });
});
