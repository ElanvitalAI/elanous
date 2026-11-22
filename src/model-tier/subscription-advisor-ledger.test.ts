// SUBSCRIPTION-ADVISOR-PROACTIVE r7 종단 시험(JUD-B #126547 mustFix — 실제 CLI 경로 종단) —
// CLI 경로(`elanous usage advisor`)가 deps 심(readRunLogs+advisorReadSnapshot)으로 원장 읽기 → 어댑터 →
// adviseSubscriptions 를 건너는지. r6 의 «CLI 를 우회하는 직접 주입» 폐지.
import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { registerUsageCommand, type UsageCliDeps } from '../cli/usage-cli.js';
import type { LogStoreRow } from '../mss/logging/log-store.js';

function row(data: unknown, category = 'llm.usage', event = 'llm-usage', ageMs = 0, id = 1): LogStoreRow {
  const ts = new Date(Date.parse('2026-11-22T00:00:00Z') - ageMs).toISOString();
  return { id, ts, ts_ms: Date.parse(ts), level: 'info', instance: 'test', surface: 'tui', category, event,
    session_id: null, trace_id: null, data: typeof data === 'string' ? data : JSON.stringify(data) };
}

const HOUR = 3_600_000, DAY = 86_400_000;
const FIXED_NOW = Date.parse('2026-11-22T00:00:00Z');

/** 창 스냅숏 심 — 계정 후보들(창 있음/모름 혼합). CLI deps 로 주입해 실제 registerUsageCommand 경로를 탄다. */
function snapshotStub(candidates: unknown[]) {
  return (() => ({ candidates: candidates as never, active: { provider: 'openai-codex', account: 'team' }, selection: 'shadow' as const, readAtMs: FIXED_NOW })) as never;
}

async function runAdvisorCli(rows: LogStoreRow[], readSnapshot?: UsageCliDeps['advisorReadSnapshot']): Promise<string[]> {
  const lines: string[] = [];
  const command = new Command();
  registerUsageCommand(command, {
    readRunLogs: () => rows,
    out: { log: (line) => lines.push(line) },
    exit: (code) => { throw new Error(`exit ${code}`); },
    advisorMembership: () => 'pro', // jud-39528 mustFix ③ — 종단은 pro 등급 경로(free 거부는 usage-cli.test.ts 신규 2건)
    ...(readSnapshot ? { advisorReadSnapshot: readSnapshot } : {}),
  });
  await command.parseAsync(['usage', 'advisor'], { from: 'user' });
  return lines;
}

describe('usage advisor (subscription-advisor-ledger 종단 — r7 JUD-B #126547)', () => {
  it('OP #127200 완료선 — 실 snapshot 모양(account=c.name 단일 계정 창) × ledger 미귀속 총량(account=null): 조언 1건 + 미측정 표지 종단', async () => {
    // 완료선 원문: «실제 snapshot 경로로 조언 1건 + 미측정 표기 종단 1회(stub account=null 아닌 것)».
    // 후보 account=c.name(제품 readAccountWindowSnapshot 계열)·remaining 실측 모양 — account=null stub 이 아님.
    const rows = [row({ billingProvider: 'openai-codex', billing: 'subscription' }, 'llm.usage', 'llm-usage', 1 * HOUR)];
    const snap = snapshotStub([{ provider: 'openai-codex', account: 'codex-main', billing: 'subscription', window: { remaining: 0.9, resetsAtMs: FIXED_NOW + 3_600_000 } }]);
    const lines = await runAdvisorCli(rows, snap);
    const text = lines.join('\n');
    expect(text).toContain('openai-codex:codex-main'); // 실계정 이름이 조언 행에 뜬다(폴백 매칭 성립)
    expect(text).toContain('하향'); // 조언 1건(월 1호출·소진 미측정 표지)
    expect(text).toContain('창 소진 미측정(계정 미구분 관측)'); // 미측정 표지 — 가짜 0 아님
    expect(text).toContain('사용량 미관측(제안 제외) 0건'); // missingUsage 0 — 폴백으로 조언이 났다
  });
  it('OP #127200 — 다중 계정 창에서는 미귀속 총량 폴백 금지(이중계상 방지 · JUD-B #126547 mustFix2 계약 유지)', async () => {
    const rows = [row({ billingProvider: 'openai-codex', billing: 'subscription' }, 'llm.usage', 'llm-usage', 1 * HOUR)];
    const snap = snapshotStub([
      { provider: 'openai-codex', account: 'team', billing: 'subscription', window: { remaining: 0.01 } },
      { provider: 'openai-codex', account: 'personal', billing: 'subscription', window: { remaining: 0.9 } },
    ]);
    const lines = await runAdvisorCli(rows, snap);
    const text = lines.join('\n');
    expect(text).toContain('사용량 미관측(제안 제외) 2건'); // 폴백 안 함 — missingUsage 로 정직
  });

  it('구독 호출 30일 3건·7일 2건 관측 — usage 행 1건(monthlyCalls=3)과 관측 줄을 낸다', async () => {
    const rows = [
      row({ billingProvider: 'openai-codex', billing: 'subscription' }, 'llm.usage', 'llm-usage', 1 * HOUR),
      row({ billingProvider: 'openai-codex', billing: 'subscription' }, 'llm.usage', 'llm-usage', 2 * DAY),
      row({ billingProvider: 'openai-codex', billing: 'subscription' }, 'llm.usage', 'llm-usage', 10 * DAY),
      row({ billingProvider: 'glm', billing: 'unknown' }, 'llm.usage', 'llm-usage', 1 * HOUR), // 비구독 — 제외
    ];
    const lines = await runAdvisorCli(rows);
    const text = lines.join('\n');
    expect(text).toContain('관측 원장 — 최근 7일 구독 호출 2건 · 30일 3건');
  });

  it('mustFix1: 창 없는 스냅숏 후보(unknown window) — CLI 종단에서 unknownWindowSubscriptions=1 로 세고 제안 0', async () => {
    const rows = [
      row({ billingProvider: 'openai-codex', billing: 'subscription' }, 'llm.usage', 'llm-usage', 1 * HOUR),
    ];
    // 후보에 window 없음(stale 신호) — r6 필터가 이 후보를 버렸다 → r7 통과해 unknown 으로 관측.
    const lines = await runAdvisorCli(rows, snapshotStub([
      { provider: 'openai-codex', account: 'team', billing: 'subscription' }, // 창 없음 = 모름
    ]));
    const text = lines.join('\n');
    expect(text).toContain('창 미측정(제안 제외) 1건');
    expect(text).not.toMatch(/추가|상향|하향/);
  });

  it('mustFix2①: all-exhausted 거절은 provider 구분 «선택 거절 수»로만 관측되고 계정 usage 로는 0부착 — 반복 거절(3회·다른 provider 1회)도 동일', async () => {
    const rows = [
      row({ billingProvider: 'openai-codex', billing: 'subscription' }, 'llm.usage', 'llm-usage', 1 * HOUR),
      row({ reason: 'all-exhausted', provider: 'openai-codex' }, 'harness.window-account', 'refused', 1 * HOUR, 10),
      row({ reason: 'all-exhausted', provider: 'openai-codex' }, 'harness.window-account', 'refused', 2 * DAY, 11),
      row({ reason: 'all-exhausted', provider: 'openai-codex' }, 'harness.window-account', 'refused', 3 * DAY, 12), // 반복 거절 3회
      row({ reason: 'all-exhausted', provider: 'grok' }, 'harness.window-account', 'refused', 4 * DAY, 13),        // 다른 provider — 제외
      row({ reason: 'stale-snapshot', provider: 'openai-codex' }, 'harness.window-account', 'refused', 5 * DAY, 14), // all-exhausted 아님 — 제외
    ];
    const lines = await runAdvisorCli(rows, snapshotStub([
      { provider: 'openai-codex', account: null, billing: 'subscription', window: { remaining: 0.01 } },
    ]));
    const text = lines.join('\n');
    // 거절 3건(1시간·2일·3일 전 — 전부 7일 주간 창 안)은 provider급 관측 줄에만 — 계정 소진 아님 표기와 함께.
    expect(text).toContain('전체 선택 거절(all-exhausted·provider급, 계정 소진 아님) 주/월 3/3');
    // 계정 usage 의 exhaustions 는 0부착 — add 제안(주2회+remaining≤5%)이 나오지 않는다.
    expect(text).not.toContain('주 2회 창 소진');
  });

  it('mustFix2②: 미귀속 총량(account=null)은 계정 창(team)에 부착 금지 — missingUsage 로 세고 제안 0(다중 계정)', async () => {
    const rows = [
      row({ billingProvider: 'openai-codex', billing: 'subscription' }, 'llm.usage', 'llm-usage', 1 * HOUR),
    ];
    const lines = await runAdvisorCli(rows, snapshotStub([
      { provider: 'openai-codex', account: 'team', billing: 'subscription', window: { remaining: 0.01 } },
      { provider: 'openai-codex', account: 'personal', billing: 'subscription', window: { remaining: 0.9 } },
    ]));
    const text = lines.join('\n');
    // 계정별 사용량 미관측(원장 계정 칸 없음) — provider 폴백 부착 금지 → 제안 0.
    expect(text).toContain('사용량 미관측(제안 제외) 2건');
    expect(text).not.toMatch(/추가|상향|하향/);
  });

  it('--json — observed 칸 이름이 재명명된 관측(weeklyAllExhaustedRefusals)을 낸다', async () => {
    const rows = [
      row({ billingProvider: 'openai-codex', billing: 'subscription' }, 'llm.usage', 'llm-usage', 1 * HOUR),
      row({ reason: 'all-exhausted', provider: 'openai-codex' }, 'harness.window-account', 'refused', 1 * HOUR, 10),
    ];
    const lines: string[] = [];
    const command = new Command();
    registerUsageCommand(command, { readRunLogs: () => rows, out: { log: (line) => lines.push(line) }, exit: (code) => { throw new Error(`exit ${code}`); }, advisorMembership: () => 'pro' }); // jud-39528 mustFix ③ — pro 경로
    await command.parseAsync(['usage', 'advisor', '--json'], { from: 'user' });
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.observed).toMatchObject({ weeklyCalls: 1, monthlyCalls: 1, weeklyAllExhaustedRefusals: 1, monthlyAllExhaustedRefusals: 1 });
    expect(Array.isArray(parsed.recommendations)).toBe(true);
    expect(typeof parsed.missingUsageSubscriptions).toBe('number');
    expect(typeof parsed.unknownWindowSubscriptions).toBe('number');
  });

  it('창 있는 account=null 후보 — provider급 총량 사용량 행과 정확 일치해 downgrade 제안(미구분 표지)', async () => {
    const rows = [
      row({ billingProvider: 'openai-codex', billing: 'subscription' }, 'llm.usage', 'llm-usage', 1 * HOUR),
    ];
    const lines = await runAdvisorCli(rows, snapshotStub([
      { provider: 'openai-codex', account: null, billing: 'subscription', window: { remaining: 0.8 } },
    ]));
    const text = lines.join('\n');
    expect(text).toContain('사용량 미관측(제안 제외) 0건');
    expect(text).toContain('계정 미구분 관측');
    expect(text).toContain('하향');
  });
});
