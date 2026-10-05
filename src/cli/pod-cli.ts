// `elanous pod run [--pool <스펙>] [--skill <이름,…>] [--llm grok] [--deadline <초>] -- <명령…>`
// 산출 경로를 한 줄로 알리고 명령의 종료 코드로 끝난다. `--deadline` 생략 시 기존 Pod Job 상한.

import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { readPodMemoryAdvice } from './pod-memory-advice.js';
import { getUserConfig } from '../user-config.js';
import { listCodexAccountsInStore } from '../oauth/codex-account-store.js';
import { parsePodPool, resolvePodPoolSpec, podPoolHostLease, type PoolKubectl } from '../task-orchestrator/surfaces/pod-pool.js';
import { leaseKubectl, measurePoolLease, probePoolDns, recommendConcurrency, type PoolLeaseMeasure, type PoolDnsProbe } from '../task-orchestrator/surfaces/pod-lease.js';
import { POD_COMMAND_DEADLINE_SECONDS, runPodCommand, type PodCommandResult, type RunPodCommandOptions } from '../task-orchestrator/surfaces/pod-command-job.js';
import { hostLeaseCounts, leaseHasPendingPod } from '../pod-lease/host-lease.js';

export interface PodCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  exit: (code: number) => void;
}

export interface PodCliDeps {
  io?: PodCliIo;
  run?: (options: RunPodCommandOptions) => Promise<PodCommandResult>;
  kubectl?: PoolKubectl;
  dns?: (context: string, kubectl: PoolKubectl) => PoolDnsProbe;
  accounts?: () => number;
  perAccount?: () => number;
  poolSpec?: (explicit?: string) => string | null;
  harnessPool?: () => string | undefined;
  memoryAdvice?: (logsDb?: string) => ReturnType<typeof readPodMemoryAdvice>;
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
  pod.command('memory').description('실측 기반 Pod 메모리 권고 (읽기 전용)')
    .command('advise').description('골 종류별 standard 16Gi / high 32Gi 권고와 근거')
    .option('--json', '권고와 측정 근거를 JSON 으로')
    .option('--logs-db <path>', '기존 logs.db 경로')
    .action((opts: { json?: boolean; logsDb?: string }) => {
      try {
        const advice = (deps.memoryAdvice ?? readPodMemoryAdvice)(opts.logsDb);
        if (opts.json) io.log(JSON.stringify(advice));
        else for (const row of advice.byGoalType) io.log(`${row.goalType}: ${row.recommended} ${row.limit} · ${row.reason}`);
        io.exit(0);
      } catch (err) {
        io.error(err instanceof Error ? err.message : String(err));
        io.exit(1);
      }
    });
  pod.command('lease').description('Pod 풀 동시 실행 권장 (DNS 점검용 Pod 를 잠깐 만들었다 지움)')
    .command('status').description('지금 추가로 쏠 수 있는 Pod 골과 제한 근거')
    .option('--pool <spec>', '풀 스펙 — 컨텍스트[@ssh호스트][:상한][#레지스트리:포트] 쉼표')
    .option('--json', '표 대신 동일 측정값을 JSON 으로')
    .action((opts: { pool?: string; json?: boolean }) => {
      try {
        const kubectl = deps.kubectl ?? leaseKubectl;
        const spec = (deps.poolSpec ?? ((explicit?: string) => resolvePodPoolSpec(explicit, process.env, () => {
          const config = deps.harnessPool ? null : getUserConfig();
          return (deps.harnessPool?.() ?? config?.harness?.podPool) || config?.pod?.pool;
        })))(opts.pool);
        // No pool configured: mirror the Pod launch fallback to kubectl's current context.
        const current = spec ? null : kubectl(['config', 'current-context']);
        const context = spec ?? (current?.status === 0 ? current.stdout.trim() : '');
        const members = context ? parsePodPool(context) : [];
        const measure: PoolLeaseMeasure = members.length ? measurePoolLease(members, { kubectl, dns: (context) => (deps.dns ?? probePoolDns)(context, kubectl) }) : { members: [] };
        let accounts: number | null = null;
        let accountReason: string | null = null;
        try { accounts = (deps.accounts ?? (() => listCodexAccountsInStore().length))(); }
        catch { accountReason = '측정 불가: accounts'; }
        const perAccount = (deps.perAccount ?? (() => getUserConfig().pod?.lease?.perAccount ?? 4))();
        const decision = recommendConcurrency(measure, { capacity: members.reduce((sum, m) => sum + m.capacity, 0), accounts: accounts ?? -1, perAccount });
        if (!context) { decision.recommended = null; decision.limitedBy = null; decision.reason = '측정 불가: cluster (current context)'; }
        const records = members.length ? podPoolHostLease(members).live() : [];
        const host = hostLeaseCounts(records);
        // Pending Pods and Job-only reservations are disjoint; a lease for an already Pending Job is the same Job.
        const waitingJobs = decision.pending === null ? null : decision.pending +
          records.filter((r) => r.stage === 'job' && !leaseHasPendingPod(r, decision.pendingJobs ?? [])).length;
        const result = { pool: spec, ...measure, accounts, perAccount, ...decision, reserved: host.reserved, waitingJobs };
        debug.log('pod.lease', 'status', { pool: spec ? members.map((m) => ({ capacity: m.capacity })) : null, running: decision.running, pending: decision.pending, reserved: host.reserved, waitingJobs, unleasedRunning: decision.unleasedRunning, recommended: decision.recommended, limitedBy: decision.limitedBy });
        if (opts.json) io.log(JSON.stringify(result));
        else {
          io.log(`풀: ${(spec ?? context) || '?'}`);
          io.log('컨텍스트 | 상한 | Running | Pending | 메모리(상한 합/할당 가능) | CPU(할당 가능)');
          for (const m of measure.members) {
            const mem = (v: number | null) => v === null ? '?' : `${(v / 1024 ** 3).toFixed(1)}Gi`;
            io.log(`${m.context} | ${m.capacity} | ${m.running ?? '?'} | ${m.pending ?? '?'} | ${mem(m.memoryLimitBytes)}/${mem(m.allocatableMemoryBytes)} | ${m.allocatableCpuMillicores === null ? '?' : m.allocatableCpuMillicores / 1000}${m.reason ? ` (${m.reason})` : ''}`);
          }
          io.log(`실측 점유: ${measure.members.map((m) => `${m.context} ${m.running === null || m.pending === null ? '못 쟀다' : m.running + m.pending}/${m.capacity}`).join(' · ') || '?'}`);
          io.log(`권장 지금 ${decision.recommended ?? '?'} 개 더 (limitedBy=${decision.limitedBy ?? 'unknown'})${decision.reason ? ` · ${decision.reason}` : ''}`);
          io.log(`예약(저작 중) ${host.reserved} · 대기 Job ${waitingJobs ?? '?'} · 실행 ${decision.running ?? '?'}`);
          io.log(`임대 없는 실행 ${decision.unleasedRunning ?? '?'}`);
          io.log(`capacity: ${decision.capacitySlots ?? '?'} 칸 (상한 ${members.reduce((sum, m) => sum + m.capacity, 0)} − Running ${decision.running ?? '?'} − Pending ${decision.pending ?? '?'}; 권장 수에서 건강한 멤버의 임대 없는 실행 차감)`);
          io.log(`memory: ${decision.memorySlots ?? '?'} 칸 (할당 가능 − Running 하니스 상한 합; 골당 16Gi · 모든 네임스페이스의 노드별 기존 예약을 반영해 배치 가능 ${decision.placeableSlots ?? '?'} 칸)`);
          io.log(`lite: ${decision.liteMemorySlots ?? '?'} 칸 (같은 여유를 lite 골 2Gi 로 센 값 · 관측만 — 권장 수는 위 standard 기준)`);
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
    .option('--pool <spec>', '풀 스펙 — 컨텍스트[@ssh호스트][:상한][#레지스트리:포트] 쉼표')
    .option('--skill <names>', '스킬 이름(쉼표). 그 스킬 .env 만 Secret 으로 싣는다')
    .option('--llm <provider>', 'grok 만 허용 — access 사본(refresh 없음)')
    .option('--clone', '저장소를 clone 한다(비공개 · GitHub 토큰이 런 Secret 으로 간다 · 명시할 때만). 기본은 clone 없이 ~/work 에서 이미지의 elanous 로')
    .option('--deadline <seconds>', `Job 수명 상한(초). 생략 시 ${POD_COMMAND_DEADLINE_SECONDS}`)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('--lite', '네트워크 스킬(omni-crawl·omni-digest)만 쓰는 명령 — 작은 이미지 ⊕ 2Gi 한도(POD7 · clone 불가)')
    .action(async (opts: { pool?: string; skill?: string; llm?: string; clone?: boolean; deadline?: string; lite?: boolean }, command: Command) => {
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
          ...(opts.lite ? { lite: true } : {}),
          ...(deadlineSeconds !== undefined ? { deadlineSeconds } : {}),
        });
        if (result.image) io.error(`[pod] image ${result.image} · job ${result.job}`);
        io.log(result.artifactsDir);
        if (result.artifacts?.error) io.error(`산출 회수 못 함: ${result.artifacts.error}`);
        io.exit(result.exitCode);
      } catch (err) {
        io.error(err instanceof Error ? err.message : String(err));
        io.exit(1);
      }
    });
}

export { POD_COMMAND_DEADLINE_SECONDS };
