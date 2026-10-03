// `elanous pod run [--pool <스펙>] [--skill <이름,…>] [--llm grok] [--deadline <초>] -- <명령…>`
// 산출 경로를 한 줄로 알리고 명령의 종료 코드로 끝난다. `--deadline` 생략 시 기존 Pod Job 상한.

import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import { listCodexAccountsInStore } from '../oauth/codex-account-store.js';
import { parsePodPool, resolvePodPoolSpec, type PoolKubectl } from '../task-orchestrator/surfaces/pod-pool.js';
import { leaseKubectl, measurePoolLease, recommendConcurrency, type PoolLeaseMeasure } from '../task-orchestrator/surfaces/pod-lease.js';
import { POD_COMMAND_DEADLINE_SECONDS, runPodCommand, type PodCommandResult, type RunPodCommandOptions } from '../task-orchestrator/surfaces/pod-command-job.js';

export interface PodCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  exit: (code: number) => void;
}

export interface PodCliDeps {
  io?: PodCliIo;
  run?: (options: RunPodCommandOptions) => Promise<PodCommandResult>;
  kubectl?: PoolKubectl;
  accounts?: () => number;
  perAccount?: () => number;
  poolSpec?: (explicit?: string) => string | null;
}

const HELP = `elanous pod run [--pool <스펙>] [--skill <이름,…>] [--llm grok] [--clone] [--deadline <초>] -- <명령…>
  하니스 없이 명령 하나를 Pod 에서 돌리고 산출 경로를 한 줄로 알린다.
  --deadline 생략 시 ${POD_COMMAND_DEADLINE_SECONDS}초(기존 Pod Job 수명 상한).`;

export function registerPodCommands(program: Command, deps: PodCliDeps = {}): void {
  const io = deps.io ?? {
    log: (line: string) => console.log(line),
    error: (line: string) => console.error(line),
    exit: (code: number) => process.exit(code),
  };
  const run = deps.run ?? ((options: RunPodCommandOptions) => runPodCommand(options));
  const pod = program.command('pod').description('Pod 명령 Job — 하니스 없이 명령 하나를 돌리고 산출을 돌려받는다');
  pod.command('lease').description('Pod 풀의 읽기 전용 동시 실행 권장')
    .command('status').description('지금 추가로 쏠 수 있는 Pod 골과 제한 근거')
    .option('--pool <spec>', '풀 스펙 — 컨텍스트[@ssh호스트][:상한] 쉼표')
    .option('--json', '표 대신 동일 측정값을 JSON 으로')
    .action((opts: { pool?: string; json?: boolean }) => {
      try {
        const kubectl = deps.kubectl ?? leaseKubectl;
        const spec = (deps.poolSpec ?? ((explicit?: string) => resolvePodPoolSpec(explicit)))(opts.pool);
        // No pool configured: mirror the Pod launch fallback to kubectl's current context.
        const current = spec ? null : kubectl(['config', 'current-context']);
        const context = spec ?? (current?.status === 0 ? current.stdout.trim() : '');
        const members = context ? parsePodPool(context) : [];
        const measure: PoolLeaseMeasure = members.length ? measurePoolLease(members, { kubectl }) : { members: [] };
        let accounts: number | null = null;
        let accountReason: string | null = null;
        try { accounts = (deps.accounts ?? (() => listCodexAccountsInStore().length))(); }
        catch { accountReason = '측정 불가: accounts'; }
        const perAccount = (deps.perAccount ?? (() => getUserConfig().pod?.lease?.perAccount ?? 4))();
        const decision = recommendConcurrency(measure, { capacity: members.reduce((sum, m) => sum + m.capacity, 0), accounts: accounts ?? -1, perAccount });
        if (!context) { decision.recommended = null; decision.limitedBy = null; decision.reason = '측정 불가: cluster (current context)'; }
        const result = { pool: spec, ...measure, accounts, perAccount, ...decision };
        debug.log('pod.lease', 'status', { pool: spec ? members.map((m) => ({ capacity: m.capacity })) : null, running: decision.running, pending: decision.pending, recommended: decision.recommended, limitedBy: decision.limitedBy });
        if (opts.json) io.log(JSON.stringify(result));
        else {
          io.log('컨텍스트 | 상한 | Running | Pending | 메모리(상한 합/할당 가능) | CPU(할당 가능)');
          for (const m of measure.members) {
            const mem = (v: number | null) => v === null ? '?' : `${(v / 1024 ** 3).toFixed(1)}Gi`;
            io.log(`${m.context} | ${m.capacity} | ${m.running ?? '?'} | ${m.pending ?? '?'} | ${mem(m.memoryLimitBytes)}/${mem(m.allocatableMemoryBytes)} | ${m.allocatableCpuMillicores === null ? '?' : m.allocatableCpuMillicores / 1000}${m.reason ? ` (${m.reason})` : ''}`);
          }
          io.log(`권장 지금 ${decision.recommended ?? '?'} 개 더 (limitedBy=${decision.limitedBy ?? 'unknown'})${decision.reason ? ` · ${decision.reason}` : ''}`);
          io.log(`capacity: ${decision.capacitySlots ?? '?'} 칸 (상한 ${members.reduce((sum, m) => sum + m.capacity, 0)} − Running ${decision.running ?? '?'} − Pending ${decision.pending ?? '?'})`);
          io.log(`memory: ${decision.memorySlots ?? '?'} 칸 (할당 가능 − Running 하니스 상한 합; 골당 16Gi · 모든 네임스페이스의 노드별 기존 예약을 반영해 배치 가능 ${decision.placeableSlots ?? '?'} 칸)`);
          io.log(`accounts (관측만 · 상한 아님): ${decision.accountSlots ?? '?'} 칸 (${accounts ?? '?'} × ${perAccount} − Running ${decision.running ?? '?'})${accountReason ? ` · ${accountReason}` : ''}`);
        }
        io.exit(0);
      } catch (err) {
        io.error(err instanceof Error ? err.message : String(err));
        io.exit(1);
      }
    });
  pod.command('run')
    .description(HELP)
    .option('--pool <spec>', '풀 스펙 — 컨텍스트[@ssh호스트][:상한] 쉼표')
    .option('--skill <names>', '스킬 이름(쉼표). 그 스킬 .env 만 Secret 으로 싣는다')
    .option('--llm <provider>', 'grok 만 허용 — access 사본(refresh 없음)')
    .option('--clone', '저장소를 clone 한다(비공개 · GitHub 토큰이 런 Secret 으로 간다 · 명시할 때만). 기본은 clone 없이 ~/work 에서 이미지의 elanous 로')
    .option('--deadline <seconds>', `Job 수명 상한(초). 생략 시 ${POD_COMMAND_DEADLINE_SECONDS}`)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (opts: { pool?: string; skill?: string; llm?: string; clone?: boolean; deadline?: string }, command: Command) => {
      const argv = process.argv.slice(2);
      const sep = argv.indexOf('--');
      const fromArgv = sep >= 0 ? argv.slice(sep + 1) : [];
      const commandArgs = fromArgv.length ? fromArgv : command.args.filter((a) => a !== '--');
      if (commandArgs.length === 0) {
        io.error('pod run: `--` 뒤에 명령이 없다');
        io.exit(2);
        return;
      }
      if (opts.llm !== undefined && opts.llm !== 'grok') {
        io.error('pod run: --llm 은 grok 만 허용한다');
        io.exit(2);
        return;
      }
      let deadlineSeconds: number | undefined;
      if (opts.deadline !== undefined) {
        deadlineSeconds = Number(opts.deadline);
        if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1) {
          io.error('pod run: --deadline 은 1 이상의 정수(초)');
          io.exit(2);
          return;
        }
      }
      const skills = (opts.skill ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      try {
        const result = await run({
          command: commandArgs,
          ...(opts.pool ? { pool: opts.pool } : {}),
          ...(skills.length ? { skills } : {}),
          ...(opts.llm === 'grok' ? { llm: 'grok' as const } : {}),
          ...(opts.clone ? { clone: true } : {}),
          ...(deadlineSeconds !== undefined ? { deadlineSeconds } : {}),
        });
        if (result.image) io.error(`[pod] image ${result.image} · job ${result.job}`);
        io.log(result.artifactsDir);
        io.exit(result.exitCode);
      } catch (err) {
        io.error(err instanceof Error ? err.message : String(err));
        io.exit(1);
      }
    });
}

export { POD_COMMAND_DEADLINE_SECONDS };
