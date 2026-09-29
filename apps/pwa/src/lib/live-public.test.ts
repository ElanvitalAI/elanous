import { describe, expect, test } from 'bun:test';
import type { LogRow } from '@/nexus/client';
import { accountNames, maskRowsForPublic, maskValueForPublic } from './live-public';

const row = (category: string, event: string, data: Record<string, unknown>): LogRow => ({ ts: '2026-09-28T01:20:10.000Z', category, event, data });
const rows: LogRow[] = [
  row('oauth.codex-account', 'rotation', { from: 'default', to: 'team', reason: 'rotated' }),
  row('oauth.codex-account', 'outbound-suppressed', { usage: [{ name: 'default' }, { name: 'team' }, { name: 'third' }] }),
  row('harness.decision', 'decision', { kind: 'ROUTE', what: 'codex 계정 default → team', reason: '구독 한도 전부 참 · team 크레딧 28,333 이 가장 많다', target: 'team' }),
  row('llm.usage', 'llm-usage', { model: 'gpt-6-sol', site: 'default-site', cost: { apiEquivalentUsd: 0.12, usd: 0 } }),
  row('dev-pipeline', 'plan', { runId: 'run-a', cwd: '/Users/someone/source/x', note: 'default config · spent $1,875.63' }),
];

describe('공개 캡처 가림', () => {
  test('account names come from oauth rows in first-seen order', () => {
    expect(accountNames(rows)).toEqual(['default', 'team', 'third']);
  });

  test('accounts → account-N in account-scoped rows; credits and USD hidden; home paths → ~', () => {
    const m = maskRowsForPublic(rows);
    expect(m[0]!.data).toMatchObject({ from: 'account-1', to: 'account-2' });
    expect(m[2]!.data).toMatchObject({ what: 'codex 계정 account-1 → account-2', target: 'account-2' });
    expect(String(m[2]!.data!.reason)).toBe('구독 한도 전부 참 · account-2 크레딧 ••• 이 가장 많다');
    expect(JSON.stringify(m)).not.toMatch(/28,333|1,875|apiEquivalentUsd|\/Users\/someone/);
    expect(m[4]!.data).toMatchObject({ cwd: '~/source/x', note: 'default config · spent $•••' });
    // 계정 범위 밖 줄의 같은 낱말(«default-site», «default config»)은 건드리지 않는다.
    expect(m[3]!.data).toMatchObject({ site: 'default-site' });
  });

  test('the original rows are untouched', () => {
    maskRowsForPublic(rows);
    expect(rows[0]!.data).toMatchObject({ from: 'default' });
  });
});

describe('maskValueForPublic — 서버 판단 사슬·L4 원문도 같은 규칙(Trace 공개 캡처)', () => {
  test('계정 이름은 별칭으로 · USD·크레딧 값은 가린다 · 원본은 그대로', () => {
    const event = { kind: 'ROUTE', what: 'codex 계정 default → team', why: '구독 한도 전부 참 · team 크레딧 19,280 이 가장 많다 · $216.99', refs: { logId: 'log:prod:1' } };
    const masked = maskValueForPublic(event, ['default', 'team', 'third']);
    expect(masked.what).toBe('codex 계정 account-1 → account-2');
    expect(masked.why).not.toContain('team');
    expect(masked.why).toContain('•••');
    expect(masked.why).not.toContain('216.99');
    expect(event.what).toBe('codex 계정 default → team');
  });
  test('L4 원문 JSON 의 과금 칸은 칸째 없앤다 · 홈 경로는 ~', () => {
    const evidence = { ts: 't', data: { account: 'third', apiEquivalentUsd: 12.5, path: '/Users/user/x' } };
    const masked = maskValueForPublic(evidence, ['default', 'team', 'third']) as { data: Record<string, unknown> };
    expect(masked.data.account).toBe('account-3');
    expect('apiEquivalentUsd' in masked.data).toBe(false);
    expect(masked.data.path).toBe('~/x');
  });
});

describe('PTY 벽 의도 띠 — oauth 줄 없이 판단 줄만 올 때(🅞 09-29 05:31)', () => {
  test('문장 속 «계정 <이름>» 과 잔량 % 를 가린다', () => {
    const only: LogRow[] = [row('harness.decision', 'decision', { kind: 'ROUTE', what: 'codex 계정 default 유지', reason: 'credits-allowed · 잔: default 7% · 임계 97%', runId: 'run-x' })];
    expect(accountNames(only)).toEqual(['default']);
    const m = maskRowsForPublic(only);
    expect(m[0]!.data).toMatchObject({ what: 'codex 계정 account-1 유지', reason: 'credits-allowed · 잔: ••• · 임계 97%' });
    expect(JSON.stringify(m)).not.toMatch(/default|[^9]7%/);
  });

  test('«계정 회전» 같은 한글 낱말은 이름으로 오인하지 않는다', () => {
    expect(accountNames([row('harness.decision', 'decision', { what: '계정 회전', account: 'team' })])).toEqual(['team']);
  });
});
