// `elanous pod run [--pool <스펙>] [--skill <이름,…>] [--llm grok] [--deadline <초>] -- <명령…>`
// 산출 경로를 한 줄로 알리고 명령의 종료 코드로 끝난다. `--deadline` 생략 시 기존 Pod Job 상한.

import type { Command } from 'commander';
import { POD_COMMAND_DEADLINE_SECONDS, runPodCommand, type PodCommandResult, type RunPodCommandOptions } from '../task-orchestrator/surfaces/pod-command-job.js';

export interface PodCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  exit: (code: number) => void;
}

export interface PodCliDeps {
  io?: PodCliIo;
  run?: (options: RunPodCommandOptions) => Promise<PodCommandResult>;
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
