// 저잔액 알림 — 모의 잔액 3단계(ok · low · empty) + 구독 창 소진 · 중복 억제 · 재무장 · 우편 실패 격리 · 폴백 전환 영수증.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { gateLlmCall, type LlmCallGateDeps } from '../oauth/llm-call-gate.js';
import type { LowBalanceMail } from '../oauth/llm-low-balance-alert.js';
import { createInMemoryGuardStore } from '../oauth/llm-spend-guard.js';
import { defaultSpendPolicyDoc } from '../nexus/llm-spend-policy/schema.js';
import type { LlmSpendLedgerEntry, LlmSpendRowState } from '../nexus/llm-spend-policy/types.js';

const T0 = new Date('2026-11-20T03:00:00.000Z');
const LEASE = '2026-11-20T23:00:00.000Z';
const GLM = 'openrouter/z-ai/glm-5.3';
const SUBS = ['codex-default', 'codex-team', 'codex-third', 'claude-code-sub', 'claude-acp'] as const;

function setup(opts: { mailerThrows?: boolean } = {}) {
  const ledger: LlmSpendLedgerEntry[] = [];
  const mails: LowBalanceMail[] = [];
  const s = { subPct: 100, balanceUsd: 50 };
  const states = (): LlmSpendRowState[] => [
    ...SUBS.map((row): LlmSpendRowState => ({
      row, provider: 'x', window: { status: 'measured', usedPct: s.subPct, observedAt: T0.toISOString() }, lease: { leaseId: `l-${row}`, expiresAt: LEASE },
      ...(row === 'claude-acp' ? { device: { status: 'measured' as const, alive: true, sessions: 0, observedAt: T0.toISOString() } } : {}),
    })),
    {
      row: 'openrouter', provider: 'openrouter', lease: { leaseId: 'l-or', expiresAt: LEASE },
      balance: { status: 'measured', usd: s.balanceUsd, totalCreditsUsd: 100, totalUsageUsd: 50, source: 't', observedAt: T0.toISOString() },
      spend: { todayUsd: 1, monthUsd: 1, source: 't', observedAt: T0.toISOString() },
    },
  ];
  const deps: { -readonly [K in keyof LlmCallGateDeps]: LlmCallGateDeps[K] } & Pick<LlmCallGateDeps, 'observers' | 'memory' | 'now' | 'appendLedger'> = {
    readPolicy: async () => defaultSpendPolicyDoc(), observers: [states], memory: createInMemoryGuardStore(), now: () => T0,
    appendLedger: (e) => { ledger.push(e); },
    lowBalanceMailer: (m) => { if (opts.mailerThrows) throw new Error('smtp down'); mails.push(m); },
  };
  const call = () => gateLlmCall({ role: 'judgement', location: 'host', models: [GLM], estimateUsd: 5 }, deps);
  const orMails = () => mails.filter((m) => m.row === 'openrouter');
  return { s, call, mails, orMails, ledger, deps };
}

describe('저잔액 알림 — 크레딧 3단계', () => {
  test('ok 무우편 → low(잔액<추정) 폴백+1통 · 반복 중복 억제 → empty 새 레벨 1통 → 회복 재무장', async () => {
    const w = setup();
    w.s.subPct = 100; // 구독은 전부 소진 — 크레딧이 폴백 목적지

    w.s.balanceUsd = 50; // ok
    const ok = await w.call();
    expect(ok.outcome === 'go' && ok.row).toBe('openrouter');
    expect(w.orMails()).toEqual([]);

    w.s.balanceUsd = 2; // low: 잔액 2 < 추정 5 → 크레딧 행 건너뜀
    const low = await w.call();
    expect(low.outcome).toBe('stop');
    expect(w.orMails().map((m) => m.level)).toEqual(['balance-insufficient']);
    expect(w.orMails()[0]!.body).toContain('2 USD');
    await w.call(); await w.call();
    expect(w.orMails()).toHaveLength(1); // 중복 억제

    w.s.balanceUsd = 0; // empty: 새 레벨
    await w.call();
    expect(w.orMails().map((m) => m.level)).toEqual(['balance-insufficient', 'balance-empty']);
    await w.call();
    expect(w.orMails()).toHaveLength(2);

    w.s.balanceUsd = 50; // 회복 → 선택됨 → 재무장
    expect((await w.call()).outcome).toBe('go');
    w.s.balanceUsd = 2;
    await w.call();
    expect(w.orMails().map((m) => m.level)).toEqual(['balance-insufficient', 'balance-empty', 'balance-insufficient']);
  });

  test('크레딧 잔액 부족 → 정책상 다음 구독 행 전환 영수증 + 우편 1통', async () => {
    const w = setup();
    // 명시적 정책 순서: 크레딧이 먼저이고 구독이 대체 행이다. 기본 정책은 바꾸지 않는다.
    w.deps.readPolicy = async () => ({ ...defaultSpendPolicyDoc(), fallbackOrder: ['openrouter', 'codex-default'], returnOnReset: false });
    w.s.subPct = 10;
    const initial = await w.call();
    expect(initial.outcome === 'go' && initial.row).toBe('openrouter');
    expect(w.orMails()).toHaveLength(0);

    w.s.balanceUsd = 2; // 잔액 2 < 호출 추정 5
    const low = await w.call();
    expect(low.outcome === 'go' && low.row).toBe('codex-default');
    expect(low.outcome === 'go' && low.ledgerLines.map((l) => [l.action, l.from, l.to])).toEqual([['switch', 'openrouter', 'codex-default']]);
    expect(w.orMails().map((m) => m.level)).toEqual(['balance-insufficient']);
    await w.call();
    expect(w.orMails()).toHaveLength(1);
  });

  test('비밀 0 — 우편 본문에 행·레벨·수치만(임대 id 없음)', async () => {
    const w = setup();
    w.s.balanceUsd = 0;
    await w.call();
    for (const m of w.mails) expect(m.subject + m.body).not.toContain('l-or');
  });
});

describe('구독 창 소진 알림 · 폴백 전환 영수증', () => {
  test('codex-default 소진 → codex-team 폴백(switch 영수증) + 우편 1통 · 반복 1통', async () => {
    const w = setup();
    w.s.subPct = 10;
    expect((await w.call()).outcome === 'go').toBe(true);
    expect(w.mails).toEqual([]);

    w.deps.observers = [() => [
      { row: 'codex-default', provider: 'x', window: { status: 'measured', usedPct: 100, observedAt: T0.toISOString() }, lease: { leaseId: 'l1', expiresAt: LEASE } },
      { row: 'codex-team', provider: 'x', window: { status: 'measured', usedPct: 10, observedAt: T0.toISOString() }, lease: { leaseId: 'l2', expiresAt: LEASE } },
    ]];
    const r = await w.call();
    expect(r.outcome === 'go' && r.row).toBe('codex-team');
    expect(r.outcome === 'go' && r.ledgerLines.map((l) => [l.action, l.from, l.to])).toEqual([['switch', 'codex-default', 'codex-team']]);
    expect(w.mails.map((m) => [m.row, m.level])).toEqual([['codex-default', 'cap-pct-exhausted']]);
    expect(w.mails[0]!.body).toContain('100%');
    await w.call();
    expect(w.mails).toHaveLength(1);
  });

  test('우편이 던져도 결정은 그대로(go/stop 불변) — 실패는 기록하지 않아 다음 호출이 재시도', async () => {
    const w = setup({ mailerThrows: true });
    w.s.balanceUsd = 0;
    const r = await w.call();
    expect(r.outcome).toBe('stop');
    expect(w.mails).toEqual([]);
  });
});

// ── 동시 폴백 우편 억제 — 원자적 임계 구역(JUD HOLD #117117: 동시 호출이 같은 행·레벨을 동시에 통과) ──

describe('동시 폴백 우편 억제 — 원자적 임계 구역', () => {
  test('같은 프로세스 동시 호출 2건 → openrouter 폴백 우편 1통(억제 load→우편→save 가 임계 구역 안)', async () => {
    const w = setup();
    w.s.subPct = 100; // 구독 전부 소진 — 크레딧이 폴백 목적지
    w.s.balanceUsd = 2; // low: 잔액 2 < 추정 5
    const orig = w.deps.lowBalanceMailer!; // 실배선 mailer 도 await 가 낀다 — 경쟁 창을 넓힌다
    w.deps.lowBalanceMailer = async (m) => { await new Promise((r) => setTimeout(r, 25)); orig(m); };
    await Promise.all([w.call(), w.call()]);
    expect(w.orMails()).toHaveLength(1); // 억제가 원자적이면 2건 호출 → 1통(현재는 경쟁으로 2통)
  });

  test('교차 프로세스 동시 호출 2건(파일 기억·파일 예약 원장) → openrouter 폴백 우편 1통', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lowbal-atomic-'));
    const script = join(import.meta.dir, 'llm-low-balance-alert.crossproc.fixture.ts');
    const children = [0, 1].map(() => Bun.spawn(['bun', script, dir], { cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' }));
    const codes = await Promise.all(children.map((c) => c.exited));
    expect(codes).toEqual([0, 0]);
    const lines = readFileSync(join(dir, 'mails.log'), 'utf8').split('\n').filter((l) => l.includes('openrouter'));
    expect(lines).toHaveLength(1); // 파일 락(withExclusive)이 임계 구역을 프로세스 사이에서도 직렬화하면 1통
  });
});
