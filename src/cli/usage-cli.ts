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
import { excludeCoveredPodRawRows, rollupRunUsage, type RunUsageInput } from '../budget/run-usage-rollup.js';
import { dedupePodRollupRows } from '../../scripts/usage-rollup.js';
import { formatUsageOutcomes, outcomeTableHasCodexGrokUnknown, queryUsageOutcomes, type UsageOutcomesDeps, type UsageOutcomesReport } from '../budget/usage-outcomes.js';
import { LogStore, logsDbPath, type LogQuery, type LogStoreRow } from '../mss/logging/log-store.js';
import { LOGS_SINCE_OPTION, parseSince } from './logs-cli.js';
import { formatCodexCreditPlan, type CodexCreditPlan } from '../budget/codex-credit-plan.js';
import { codexCreditPlanFromDisk } from './codex-credit-plan-view.js';
import { getUserConfig } from '../user-config.js';
import { defaultSshRunner, type SshRunner } from '../task-agent/parent-host.js';
import { shellQuote } from '../task-agent/task-hand.js';

export interface UsageCliDeps {
  readonly collect?: typeof collectUnifiedUsage;
  /** Codex credit plan (disk only). Returns null when it cannot be read. */
  readonly creditPlan?: () => CodexCreditPlan | null;
  readonly out?: { log: (s: string) => void };
  /** Read-only LogStore query seam; returns stored llm-usage rows, newest first. */
  readonly readRunLogs?: (query: LogQuery) => LogStoreRow[];
  /** Federation seams: the configured TA parent hosts plus this HQ host, and bounded SSH. */
  readonly usageHosts?: () => { local: string; remote: string[] };
  readonly ssh?: SshRunner;
  /** 시험 심 — 실물 네트워크를 안 탄다. */
  readonly list?: typeof listCodexResetCredits;
  readonly consume?: typeof consumeCodexResetCredits;
  /** 계정 이름 → CODEX_HOME. ⛔ 여기 없는 이름은 «거부»한다(모르는 곳에 쓰지 않는다). */
  readonly homes?: Readonly<Record<string, string>>;
  readonly exit?: (code: number) => never;
  /** 런 원장 결과 표. 시험은 디렉터리를 주입한다. */
  readonly outcomes?: (sinceDays: number) => UsageOutcomesReport;
  readonly outcomeDeps?: UsageOutcomesDeps;
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

function configuredUsageHosts(): { local: string; remote: string[] } {
  const config = getUserConfig();
  const local = config.hq?.hostName?.trim() || '';
  const parents = config.taskAgent?.parentHost;
  const entries = Array.isArray(parents) ? parents : parents ? [parents] : [];
  return { local, remote: [...new Set(entries.map((entry) => entry.host?.trim()).filter((host): host is string => !!host && host !== local))] };
}

type UsageAxis = 'stage' | 'phase' | 'model' | 'account';
type ExtendedRunUsageInput = RunUsageInput & { stage?: string | null; account?: string | null; origin?: string; podJob?: string; job?: string; measured?: boolean };
type AxisUsageRow = {
  stage?: string;
  phase?: string;
  model?: string;
  account?: string;
  hostIds: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  usdKnown: number;
  unknownCostCalls: number;
  includedCalls: number;
  apiEquivalentUsd: number;
  /** 비용 순위 = usdKnown + apiEquivalentUsd — 구독 호출의 목록가 «그림자 비용»까지 더한 값. */
  rankUsd: number;
};

type FederatedUsageRow = {
  runId?: string; role?: string; site?: string; stage?: string; phase?: string; model?: string; account?: string;
  billingProvider?: string; billing?: string; hostIds: string[]; rankUsd?: number;
  calls: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number;
  cacheCreationInputTokens: number; reasoningOutputTokens: number; usdKnown: number;
  unknownCostCalls: number; includedCalls: number; apiEquivalentUsd: number;
};
type HostMeasurement = { host: string; status: 'ok' | 'unmeasured'; reason?: string };
const SUM_FIELDS = ['calls', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'reasoningOutputTokens', 'usdKnown', 'unknownCostCalls', 'includedCalls', 'apiEquivalentUsd'] as const;
const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

function validUsageRows(value: unknown, axis: 'run' | 'role' | UsageAxis): value is FederatedUsageRow[] {
  if (!Array.isArray(value)) return false;
  const key = axis === 'run' ? 'runId' : axis;
  return value.every((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const row = candidate as Record<string, unknown>;
    return typeof row[key] === 'string' && Array.isArray(row.hostIds)
      && row.hostIds.every((host: unknown) => typeof host === 'string')
      && (axis !== 'run' && axis !== 'role'
        || ['model', 'billingProvider', 'billing', ...(axis === 'role' ? ['site'] : [])]
          .every((field) => typeof row[field] === 'string'))
      && SUM_FIELDS.every((field) => {
        const number = row[field];
        return typeof number === 'number' && Number.isFinite(number) && number >= 0;
      })
      && (axis !== 'stage' && axis !== 'phase' && axis !== 'model' && axis !== 'account'
        || typeof row.rankUsd === 'number' && Number.isFinite(row.rankUsd));
  });
}

function mergeUsageRows(groups: readonly FederatedUsageRow[][], axis: 'run' | 'role' | UsageAxis): FederatedUsageRow[] {
  const merged = new Map<string, FederatedUsageRow>();
  for (const rows of groups) for (const row of rows) {
    const key = axis === 'run' ? JSON.stringify([row.runId, row.model, row.billingProvider, row.billing])
      : axis === 'role' ? JSON.stringify([row.role, row.site, row.model, row.billingProvider, row.billing])
        : JSON.stringify(row[axis]);
    const previous = merged.get(key);
    if (!previous) { merged.set(key, { ...row, hostIds: [...row.hostIds] }); continue; }
    for (const field of SUM_FIELDS) previous[field] += row[field];
    previous.hostIds = [...new Set([...previous.hostIds, ...row.hostIds])];
    if (axis === 'stage' || axis === 'phase' || axis === 'model' || axis === 'account') previous.rankUsd = previous.usdKnown + previous.apiEquivalentUsd;
  }
  return [...merged.values()];
}

function readRemoteUsage(host: string, axis: 'run' | 'role' | UsageAxis, opts: { run?: string; sinceMs?: number }, ssh: SshRunner): { rows?: FederatedUsageRow[]; reason?: string } {
  if (!SSH_HOST.test(host)) return { reason: '호스트 이름 오류' };
  const args = ['eln', '--config-dir', '"$HOME"/.elanous', 'usage', 'runs', '--by', shellQuote(axis), '--json'];
  if (opts.run !== undefined) args.push('--run', shellQuote(opts.run));
  if (opts.sinceMs !== undefined) args.push('--since', shellQuote(new Date(opts.sinceMs).toISOString()));
  try {
    // The local usage command returns [] when its store is absent. Check the
    // same configured store first so federation cannot count absence as zero.
    const result = ssh(host, 'test -f "$HOME"/.elanous/logs/logs.db || { echo usage-store-missing >&2; exit 68; }; ' + args.join(' '), 20_000);
    if (result.status === 68 || result.stderr.includes('usage-store-missing')) return { reason: '원격 logs.db 없음' };
    if (result.status !== 0) return { reason: result.status === null ? '시간 초과 또는 SSH 실패' : `SSH/원격 명령 rc=${result.status}` };
    const parsed: unknown = JSON.parse(result.stdout);
    return validUsageRows(parsed, axis) ? { rows: parsed } : { reason: '원격 JSON 형식 오류' };
  } catch { return { reason: '원격 JSON 또는 SSH 실행 오류' }; }
}

function usageData(row: LogStoreRow, unwrapPod = false): ExtendedRunUsageInput | null {
  if (row.category !== 'llm.usage' || row.event !== 'llm-usage' || !row.data) return null;
  try {
    let value: unknown = JSON.parse(row.data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const wrapper = value as { origin?: unknown; podJob?: unknown; originalData?: unknown };
    if (unwrapPod && wrapper.origin === 'pod' && wrapper.originalData !== undefined) {
      const original = typeof wrapper.originalData === 'string' ? JSON.parse(wrapper.originalData) : wrapper.originalData;
      if (!original || typeof original !== 'object' || Array.isArray(original)) return null;
      value = { ...original, origin: 'pod', podJob: wrapper.podJob };
    }
    return value as ExtendedRunUsageInput;
  } catch { return null; }
}

function stageForUsage(data: ExtendedRunUsageInput): string {
  const stages = ['authoring', 'implement', 'review', 'gate'];
  if (typeof data.stage === 'string' && data.stage.length > 0) return stages.includes(data.stage) ? data.stage : '기타';
  // 역할 대체: 저작 호출은 role 'planning' 으로 실린다(ModelRole 에 authoring 이 없다) → authoring 단계로 센다.
  const role = data.role === 'planning' ? 'authoring' : data.role;
  if (typeof role === 'string' && role.length > 0) return stages.includes(role) ? role : '기타';
  return '(none)';
}

function rollupByAxis(inputs: readonly ExtendedRunUsageInput[], axis: UsageAxis): AxisUsageRow[] {
  const groups = new Map<string, ExtendedRunUsageInput[]>();
  for (const data of inputs) {
    const value = axis === 'stage' ? stageForUsage(data)
      : axis === 'phase' ? (typeof data.phase === 'string' && data.phase.length > 0 ? data.phase : '(none)')
      : axis === 'model' ? (data.model || '(none)')
        : (data.account || '(none)');
    const group = groups.get(value) ?? [];
    group.push(data);
    groups.set(value, group);
  }
  return [...groups].map(([value, group]) => {
    const rows = rollupRunUsage(group);
    const usdKnown = rows.reduce((sum, row) => sum + row.usdKnown, 0);
    const apiEquivalentUsd = rows.reduce((sum, row) => sum + row.apiEquivalentUsd, 0);
    const result: AxisUsageRow = {
      [axis]: value,
      hostIds: [...new Set(rows.flatMap((row) => row.hostIds))],
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
      cacheReadInputTokens: rows.reduce((sum, row) => sum + row.cacheReadInputTokens, 0),
      cacheCreationInputTokens: rows.reduce((sum, row) => sum + row.cacheCreationInputTokens, 0),
      reasoningOutputTokens: rows.reduce((sum, row) => sum + row.reasoningOutputTokens, 0),
      usdKnown,
      unknownCostCalls: rows.reduce((sum, row) => sum + row.unknownCostCalls, 0),
      includedCalls: rows.reduce((sum, row) => sum + row.includedCalls, 0),
      apiEquivalentUsd,
      rankUsd: usdKnown + apiEquivalentUsd,
    };
    return result;
  }).sort((a, b) => (b.rankUsd - a.rankUsd) || (b.calls - a.calls));
}

function isUsageAxis(value: string): value is 'run' | 'role' | UsageAxis {
  return value === 'run' || value === 'role' || value === 'stage' || value === 'phase' || value === 'model' || value === 'account';
}

function formatAxisUsage(row: AxisUsageRow, axis: UsageAxis): string {
  const value = row[axis] ?? '(none)';
  return `${axis}=${value}  hosts=${row.hostIds.join(',') || '(none)'}  calls=${row.calls}  input=${row.inputTokens}  output=${row.outputTokens}  cacheRead=${row.cacheReadInputTokens}  cacheCreation=${row.cacheCreationInputTokens}  reasoning=${row.reasoningOutputTokens}  usdKnown=${row.usdKnown}  unknownCostCalls=${row.unknownCostCalls}  includedCalls=${row.includedCalls}  apiEquivalentUsd=${row.apiEquivalentUsd}  rankUsd=${row.rankUsd}`;
}

function defaultCreditPlan(): CodexCreditPlan | null {
  try { return codexCreditPlanFromDisk(); } catch { return null; }
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
      const creditPlan = (deps.creditPlan ?? defaultCreditPlan)();
      if (opts.json) {
        out.log(JSON.stringify({ ...report, codexCreditPlan: creditPlan }, null, 2));
        return;
      }
      out.log(formatUnifiedUsage(report));
      if (creditPlan) out.log(['', 'codex 크레딧', ...formatCodexCreditPlan(creditPlan).map((l) => `  ${l}`)].join('\n'));
    });

  usage
    .command('runs')
    .description('저장된 llm-usage 로그를 런·역할·단계·phase·모델·계정별로 집계한다')
    .option('--run <runId>', '런 ID 정확 일치')
    .option('--by <axis>', '집계 축 (run | role | stage | phase | model | account)', 'run')
    .option(...LOGS_SINCE_OPTION)
    .option('--hosts <scope>', '호스트 연합 (all: 이 호스트 + 설정된 taskAgent.parentHost)')
    .option('--json', '집계 행 JSON 출력')
    .action((opts: { run?: string; by: string; since?: string; hosts?: string; json?: boolean }, command: Command) => {
      const json = opts.json || command.optsWithGlobals<{ json?: boolean }>().json;
      if (!isUsageAxis(opts.by)) {
        out.log('⛔ --by 는 run | role | stage | model | account');
        exit(2);
        return;
      }
      const sinceMs = opts.since === undefined ? undefined : parseSince(opts.since);
      if (sinceMs === null) {
        out.log(`⛔ --since 파싱 불가: '${opts.since}' (30s/15m/2h/7d 또는 ISO)`);
        exit(2);
        return;
      }
      if (opts.hosts !== undefined && opts.hosts !== 'all') {
        out.log(`⛔ --hosts 는 all 만 지원: '${opts.hosts}'`);
        exit(2);
        return;
      }
      const localUnavailable = opts.hosts === 'all' && !deps.readRunLogs && !existsSync(logsDbPath())
        ? '로컬 logs.db 없음' : undefined;
      const emitFederated = (localRows: FederatedUsageRow[], localFailure?: string): void => {
        const roster = (deps.usageHosts ?? configuredUsageHosts)();
        if (!roster.local) {
          const reason = 'hq.hostName 설정 없음 — 로컬 호스트와 원격 중복 여부를 확인할 수 없음';
          const hosts = [...new Set(roster.remote)].map((host) => ({ host, status: 'unmeasured' as const, reason: '로컬 식별 불가로 조회 중지' }));
          if (json) out.log(JSON.stringify({ rows: [], hosts, complete: false, reason }, null, 2));
          else out.log(`호스트 연합: 못 잼 (${reason})`);
          return;
        }
        const hosts: HostMeasurement[] = [localFailure
          ? { host: roster.local, status: 'unmeasured', reason: localFailure }
          : { host: roster.local, status: 'ok' }];
        const parts: FederatedUsageRow[][] = localFailure ? [] : [localRows];
        const rosterReason = roster.remote.length === 0 ? 'taskAgent.parentHost 설정 없음' : undefined;
        for (const host of [...new Set(roster.remote.filter((name) => name !== roster.local))]) {
          const remote = readRemoteUsage(host, opts.by as 'run' | 'role' | UsageAxis,
            { run: opts.run, sinceMs }, deps.ssh ?? defaultSshRunner);
          if (remote.rows) { hosts.push({ host, status: 'ok' }); parts.push(remote.rows); }
          else hosts.push({ host, status: 'unmeasured', reason: remote.reason ?? '원인 미상' });
        }
        const complete = !rosterReason && hosts.every((host) => host.status === 'ok');
        const rows = mergeUsageRows(parts, opts.by as 'run' | 'role' | UsageAxis);
        if (opts.by === 'role') rows.sort((a, b) => b.calls - a.calls);
        if (opts.by === 'stage' || opts.by === 'phase' || opts.by === 'model' || opts.by === 'account') rows.sort((a, b) => (b.rankUsd ?? 0) - (a.rankUsd ?? 0) || b.calls - a.calls);
        if (json) { out.log(JSON.stringify({ rows, hosts, complete, ...(rosterReason ? { reason: rosterReason } : {}) }, null, 2)); return; }
        out.log(`호스트 ${hosts.filter((host) => host.status === 'ok').length}/${hosts.length} 측정 · ${complete ? '완결' : '부분 합계'}`);
        if (rosterReason) out.log(`호스트 목록: 못 잼 (${rosterReason})`);
        for (const host of hosts) if (host.status === 'unmeasured') out.log(`${host.host}: 못 잼 (${host.reason})`);
        if (rows.length === 0) { out.log('(일치하는 런 사용량 없음)'); return; }
        for (const row of rows) {
          if (opts.by === 'stage' || opts.by === 'phase' || opts.by === 'model' || opts.by === 'account') out.log(formatAxisUsage(row as AxisUsageRow, opts.by));
          else if (opts.by === 'role') out.log(`${row.role}  ${row.site}  ${row.model}  ${row.billingProvider}/${row.billing}  calls=${row.calls}  input=${row.inputTokens}  output=${row.outputTokens}  usdKnown=${row.usdKnown}  unknownCostCalls=${row.unknownCostCalls}  includedCalls=${row.includedCalls}  apiEquivalentUsd=${row.apiEquivalentUsd}`);
          else out.log(`${row.runId}  ${row.model}  ${row.billingProvider}/${row.billing}  hosts=${row.hostIds.join(',') || '(none)'}  calls=${row.calls}  input=${row.inputTokens}  output=${row.outputTokens}  cacheRead=${row.cacheReadInputTokens}  cacheCreation=${row.cacheCreationInputTokens}  reasoning=${row.reasoningOutputTokens}  usdKnown=${row.usdKnown}  unknownCostCalls=${row.unknownCostCalls}  includedCalls=${row.includedCalls}  apiEquivalentUsd=${row.apiEquivalentUsd}`);
        }
      };
      let rows: LogStoreRow[] = [];
      let localFailure = localUnavailable;
      if (!localFailure) {
        try {
          rows = (deps.readRunLogs ?? readRunLogs)({
            exactCategories: ['llm.usage'], events: ['llm-usage'],
            ...(sinceMs !== undefined ? { sinceMs } : {}),
          });
        } catch (error) {
          if (opts.hosts !== 'all') throw error;
          localFailure = '로컬 logs.db 조회 실패';
        }
      }
      const unwrapPod = opts.by === 'stage' || opts.by === 'phase' || opts.by === 'model' || opts.by === 'account';
      // ⭐ METER-POD-ROLLUP-GAP-2 — Pod 사용량 재방출 행(podRollupKey)은 «더 완전한 한 행»만 센다(키 없는 행은 그대로).
      const selected = rows.map((row) => usageData(row, unwrapPod))
        .filter((data): data is ExtendedRunUsageInput => data !== null)
        .filter((data) => opts.run === undefined || data.runId === opts.run);
      // A returned Pod raw row and its host rollup describe the same usage. Keep raw rows when no measured rollup exists.
      const inputs = dedupePodRollupRows(unwrapPod ? excludeCoveredPodRawRows(selected) : selected);
      if (opts.by === 'stage' || opts.by === 'phase' || opts.by === 'model' || opts.by === 'account') {
        const report = rollupByAxis(inputs, opts.by);
        if (opts.hosts === 'all') { emitFederated(report, localFailure); return; }
        if (json) {
          out.log(JSON.stringify(report, null, 2));
          return;
        }
        if (report.length === 0) { out.log('(일치하는 런 사용량 없음)'); return; }
        for (const row of report) out.log(formatAxisUsage(row, opts.by));
        return;
      }
      const report = rollupRunUsage(inputs, { by: opts.by });
      if (opts.hosts === 'all') { emitFederated(report, localFailure); return; }
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
  const outcomes = deps.outcomes ?? ((sinceDays: number) => queryUsageOutcomes(sinceDays, deps.outcomeDeps));
  usage
    .command('outcomes')
    .description('프로바이더별 무인 착지율 · 라운드 수 · 막힘 사유 분포 (런 원장 childProvider · 미기록은 불명)')
    .option('--days <n>', '최근 N일', '2')
    .option('--json', 'JSON 출력')
    .action((opts: { days?: string; json?: boolean }, command: Command) => {
      const json = opts.json || command.optsWithGlobals<{ json?: boolean }>().json;
      const days = Number(opts.days);
      if (!Number.isFinite(days) || days <= 0) {
        out.log(`⛔ --days 는 양의 수: '${opts.days}'`);
        exit(2);
        return;
      }
      const report = outcomes(days);
      if (json) {
        out.log(JSON.stringify({ ...report, hasCodexGrokUnknown: outcomeTableHasCodexGrokUnknown(report) }, null, 2));
        return;
      }
      out.log(formatUsageOutcomes(report));
    });

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
