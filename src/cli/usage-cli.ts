// `elanous usage` — one query, account rows × credit axis × subscription axis.
//
// Existing `provider codex usage` and `acp usage grok` stay on their own
// trees. This command only assembles the shared report.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { collectUnifiedUsage, formatUnifiedUsage } from '../budget/unified-usage.js';
import { consumeCodexResetCredits, listCodexResetCredits } from '../budget/codex-reset-credits.js';
import { rollupRunUsage, type RunUsageInput } from '../budget/run-usage-rollup.js';
import { LogStore, logsDbPath, type LogQuery, type LogStoreRow } from '../mss/logging/log-store.js';
import { LOGS_SINCE_OPTION, parseSince } from './logs-cli.js';

export interface UsageCliDeps {
  readonly collect?: typeof collectUnifiedUsage;
  readonly out?: { log: (s: string) => void };
  /** Read-only LogStore query seam; returns stored llm-usage rows, newest first. */
  readonly readRunLogs?: (query: LogQuery) => LogStoreRow[];
  /** 시험 심 — 실물 네트워크를 안 탄다. */
  readonly list?: typeof listCodexResetCredits;
  readonly consume?: typeof consumeCodexResetCredits;
  /** 계정 이름 → CODEX_HOME. ⛔ 여기 없는 이름은 «거부»한다(모르는 곳에 쓰지 않는다). */
  readonly homes?: Readonly<Record<string, string>>;
  readonly exit?: (code: number) => never;
}

/** 계정 이름 → CODEX_HOME 기본 표.
 *  ⛔ 경로를 «박지» 않고 홈에서 유도한다(대표 상시지시: 새 코드에 절대 경로 금지). */
function defaultHomes(): Readonly<Record<string, string>> {
  const h = homedir();
  return { default: join(h, '.codex'), team: join(h, '.codex-new'), third: join(h, '.codex-third') };
}

function readRunLogs(query: LogQuery): LogStoreRow[] {
  const path = logsDbPath();
  if (!existsSync(path)) return [];
  const store = LogStore.openReadOnly(path);
  try {
    const rows: LogStoreRow[] = [];
    let beforeId: number | undefined;
    for (;;) {
      const page = store.query({ ...query, beforeId, limit: 1000 });
      rows.push(...page);
      if (page.length < 1000) break;
      beforeId = page.at(-1)!.id;
    }
    return rows;
  } finally {
    store.close();
  }
}

function usageData(row: LogStoreRow): RunUsageInput | null {
  if (row.category !== 'llm.usage' || row.event !== 'llm-usage' || !row.data) return null;
  try {
    const value: unknown = JSON.parse(row.data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RunUsageInput;
  } catch { return null; }
}

export function registerUsageCommand(program: Command, deps: UsageCliDeps = {}): void {
  const out = deps.out ?? { log: (s: string) => console.log(s) };
  const collect = deps.collect ?? collectUnifiedUsage;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const usage = program
    .command('usage')
    .description('계정마다 행으로 「지금 쓸 수 있는 것이 얼마나 남았나」를 본다 (크레딧 축 ≠ 구독 축)')
    .option('--json', 'JSON 출력 — 자격 값은 없다')
    .action(async (opts: { json?: boolean }) => {
      const report = await collect();
      if (opts.json) {
        out.log(JSON.stringify(report, null, 2));
        return;
      }
      out.log(formatUnifiedUsage(report));
    });

  usage
    .command('runs')
    .description('저장된 llm-usage 로그를 런 또는 역할·호출 자리별로 집계한다')
    .option('--run <runId>', '런 ID 정확 일치')
    .option('--by <axis>', '집계 축 (run | role)', 'run')
    .option(...LOGS_SINCE_OPTION)
    .option('--json', '집계 행 JSON 출력')
    .action((opts: { run?: string; by: string; since?: string; json?: boolean }, command: Command) => {
      const json = opts.json || command.optsWithGlobals<{ json?: boolean }>().json;
      if (opts.by !== 'run' && opts.by !== 'role') {
        out.log('⛔ --by 는 run | role');
        exit(2);
        return;
      }
      const sinceMs = opts.since === undefined ? undefined : parseSince(opts.since);
      if (sinceMs === null) {
        out.log(`⛔ --since 파싱 불가: '${opts.since}' (30s/15m/2h/7d 또는 ISO)`);
        exit(2);
        return;
      }
      const rows = (deps.readRunLogs ?? readRunLogs)({
        exactCategories: ['llm.usage'], events: ['llm-usage'],
        ...(sinceMs !== undefined ? { sinceMs } : {}),
      });
      const inputs = rows.map(usageData).filter((data): data is RunUsageInput => data !== null)
        .filter((data) => opts.run === undefined || data.runId === opts.run);
      const report = rollupRunUsage(inputs, { by: opts.by });
      if (opts.by === 'role') report.sort((a, b) => b.calls - a.calls);
      if (json) {
        out.log(JSON.stringify(report, null, 2));
        return;
      }
      if (report.length === 0) { out.log('(일치하는 런 사용량 없음)'); return; }
      for (const row of report) {
        if (opts.by === 'role') {
          out.log(`${row.role}  ${row.site}  ${row.model}  ${row.billingProvider}/${row.billing}  calls=${row.calls}  input=${row.inputTokens}  output=${row.outputTokens}  usdKnown=${row.usdKnown}  unknownCostCalls=${row.unknownCostCalls}  includedCalls=${row.includedCalls}  apiEquivalentUsd=${row.apiEquivalentUsd}`);
        } else {
          out.log(`${row.runId}  ${row.model}  ${row.billingProvider}/${row.billing}  hosts=${row.hostIds.join(',') || '(none)'}  calls=${row.calls}  input=${row.inputTokens}  output=${row.outputTokens}  cacheRead=${row.cacheReadInputTokens}  cacheCreation=${row.cacheCreationInputTokens}  reasoning=${row.reasoningOutputTokens}  usdKnown=${row.usdKnown}  unknownCostCalls=${row.unknownCostCalls}  includedCalls=${row.includedCalls}  apiEquivalentUsd=${row.apiEquivalentUsd}`);
        }
      }
    });

  // ⛔⭐⭐ 리셋권 소비는 ***되돌릴 수 없다*** — 서버가 크레딧을 고르고, 그 계정의 주간 창이 새로 시작한다.
  //   🩸 그래서 ⑴ `--yes` 없이는 «안 쓴다» ⑵ 쓰기 «전»에 남은 수를 보여 준다
  //      ⑶ 쓴 «뒤»에도 다시 조회해 「줄었나」를 값으로 낸다.
  //   📏 2026-09-24 현황 예: default 100%·team 100%·third 46% ⇒ third 에 쓰면 54% 가 버려진다.
  const list = deps.list ?? listCodexResetCredits;
  const consume = deps.consume ?? consumeCodexResetCredits;
  const homes = deps.homes ?? defaultHomes();
  usage
    .command('reset')
    .description('⛔ 되돌릴 수 없다 — Codex 리셋권 «하나»를 써서 그 계정의 주간 창을 지금 새로 시작한다')
    .requiredOption('--account <name>', `어느 계정인가 (${Object.keys(homes).join(' | ')})`)
    .option('--yes', '⛔ 실제로 쓴다. 없으면 «보기만» 한다(안전 기본)')
    .action(async (opts: { account: string; yes?: boolean }) => {
      const home = homes[opts.account];
      if (!home) {
        out.log(`⛔ 모르는 계정: ${opts.account} — 아는 것: ${Object.keys(homes).join(' · ')}`);
        exit(2);
        return;
      }
      const env = { ...process.env, CODEX_HOME: home };
      const before = await list({ env });
      if (!before.ok) {
        out.log(`⛔ 리셋권을 «못 읽었다» (${before.kind}) — ${before.message}`);
        exit(1);
        return;
      }
      out.log(`📊 ${opts.account} — 쓸 수 있는 리셋권 ${before.value.availableCount}개 · 총 획득 ${before.value.totalEarnedCount}`);
      if (before.value.availableCount <= 0) {
        out.log('⛔ 쓸 수 있는 리셋권이 «없다» — 아무것도 안 했다.');
        exit(1);
        return;
      }
      if (!opts.yes) {
        out.log('⚠️ 보기만 했다 — 실제로 쓰려면 --yes 를 준다.');
        out.log('   ⛔ 소비는 되돌릴 수 없고, 그 계정의 «남은 잔량»은 새 창 시작과 함께 버려진다.');
        return;
      }
      const result = await consume({ env });
      if (!result.ok) {
        out.log(`⛔ 소비 «실패» (${result.kind}) — ${result.message} · redeemRequestId=${result.redeemRequestId ?? '없음'}`);
        exit(1);
        return;
      }
      out.log(`✅ ${opts.account} 리셋권 «하나»를 썼다 — code=${result.value.code} · redeemRequestId=${result.redeemRequestId}`);
      const after = await list({ env });
      if (after.ok) out.log(`📊 남은 리셋권 ${after.value.availableCount}개 (쓰기 전 ${before.value.availableCount}개)`);
      else out.log(`⚠️ 쓴 «뒤» 조회에 실패했다(${after.kind}) — 소비 자체는 위 줄이 증거다.`);
    });

}
