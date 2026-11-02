import { InvalidArgumentError, type Command } from 'commander';
import { debug } from '../debug/log.js';
import type { AdvanceMissionResult, PieceEvidenceReader } from '../task-agent/mission.js';
import type { CardRunEvidenceDeps } from '../task-agent/card-evidence.js';
import type { TaskLauncher } from '../task-agent/task-hand.js';
import { registerTaskAgentSink, registerTasksRoot } from './tasks-read-cli.js';

export interface TasksAdvanceCliDeps {
  registerSink?: (surface: string) => Promise<unknown>;
  taskLauncher?: TaskLauncher;
  taskStatePath?: string;
  pieceEvidence?: PieceEvidenceReader;
  cardRunEvidence?: CardRunEvidenceDeps | false;
  output?: (line: string) => void;
}

function collectPair(value: string, previous: Array<[string, string]> = []): Array<[string, string]> {
  const at = value.indexOf('=');
  if (at <= 0 || at === value.length - 1) throw new InvalidArgumentError(`<조각id>=<값> 모양이 아니다: ${value}`);
  return [...previous, [value.slice(0, at), value.slice(at + 1)]];
}

function advanceLines(result: AdvanceMissionResult): string[] {
  if (result.green === 'already-proposed' && Object.keys(result.evidence).length === 0) {
    return [`${result.missionId}\tadvance\t${result.mode}\tgreen already-proposed — 다시 조회·넘기지 않는다`];
  }
  return [
    `${result.missionId}\tadvance\t${result.mode}\t착지 ${result.landed.length} · 준비 ${result.ready.length} · 넘김 ${result.handed.length} · green ${result.green}`,
    ...Object.entries(result.evidence).map(([id, state]) => `  근거: ${id}\t${state}${result.landed.includes(id) ? '\t착지' : ''}`),
    ...result.handed.map(
      (piece) =>
        `  넘김: ${piece.pieceId}\t${piece.launched ? 'launched' : piece.error ? 'failed' : 'not launched'}${piece.error ? `\t${piece.error}` : ''}`,
    ),
    ...(result.green === 'proposed' ? ['  green 제안을 미션 카드에 적었다 — 체크리스트는 바꾸지 않는다(OP/주인이 뒤집는다)'] : []),
  ];
}

/** The mission ② entry without importing the complete tasks command registry. */
export function registerTasksAdvanceCommand(program: Command, deps: TasksAdvanceCliDeps = {}): void {
  const tasks = program.commands.find((command) => command.name() === 'tasks') ?? registerTasksRoot(program);
  const out = deps.output ?? ((line: string) => console.log(line));
  tasks
    .command('advance [missionId]')
    .description(
      'TASK-AGENT 미션 ② — 조각의 PR 병합(근거: `--pr`/`--goal` 로 카드에 적은 PR 번호·골 id)으로 착지를 가르고 새로 준비된 조각만 한 번 넘긴다 · 모두 착지면 green «제안»만 적는다 · 기본 shadow(발사 0)',
    )
    .option('--all', 'green 제안이 아직 없는 미션 전부')
    .option('--pr <pieceId=N>', '조각 카드에 그 런의 PR 번호를 적는다(반복 가능)', collectPair)
    .option('--goal <pieceId=goalId>', '조각 카드에 골 id(16자)를 적는다 — 런 원장 pr-opened 로 PR 을 찾는다(반복 가능)', collectPair)
    .option('--live', '준비된 조각을 실제로 발사한다(기본은 shadow)')
    .option('--json', 'JSON 출력')
    .action(
      async (
        missionId: string | undefined,
        opts: {
          all?: boolean;
          pr?: Array<[string, string]>;
          goal?: Array<[string, string]>;
          live?: boolean;
          json?: boolean;
        },
      ) => {
        await registerTaskAgentSink(deps.registerSink);
        const mission = await import('../task-agent/mission.js');
        const started = Date.now();
        if ((missionId === undefined) === (opts.all !== true)) {
          const reason = '미션 id «또는» --all 중 하나만 준다';
          try {
            debug.log('task-agent', 'mission-advance', {
              missionId: missionId ?? null,
              all: opts.all === true,
              mode: opts.live ? 'live' : 'shadow',
              stage: 'cli-args',
              error: reason,
              ms: Date.now() - started,
            });
          } catch {
            /* fail-soft */
          }
          out(reason);
          process.exitCode = 1;
          return;
        }
        const statePath = deps.taskStatePath;
        try {
          const refs: Array<[string, { pr: number } | { goalId: string }]> = [
            ...(opts.pr ?? []).map(([pieceId, value]): [string, { pr: number }] => {
              if (!/^#?[1-9]\d*$/.test(value)) throw new Error(`PR 번호가 아니다: ${value}`);
              return [pieceId, { pr: Number(value.replace(/^#/, '')) }];
            }),
            ...(opts.goal ?? []).map(([pieceId, value]): [string, { goalId: string }] => {
              if (!/^[a-f0-9]{16}$/.test(value)) throw new Error(`골 id 는 16자 hex 다: ${value}`);
              return [pieceId, { goalId: value }];
            }),
          ];
          const twice = refs.map(([pieceId]) => pieceId).filter((pieceId, at, all) => all.indexOf(pieceId) !== at);
          if (twice.length) throw new Error(`한 조각에 근거를 두 번 줬다(--pr·--goal 은 조각마다 하나): ${[...new Set(twice)].join(', ')}`);
          const refFailures: string[] = [];
          for (const [pieceId, ref] of refs) {
            try {
              mission.recordPieceRef(pieceId, ref, statePath, missionId);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              if (missionId !== undefined) throw error;
              refFailures.push(reason);
            }
          }
          const ids = missionId !== undefined ? [missionId] : mission.openMissionIds(statePath);
          const results: AdvanceMissionResult[] = [];
          const failures: Array<{ missionId: string; error: string }> = [];
          let launcher = deps.taskLauncher;
          if (opts.live && !launcher) launcher = (await import('./tasks-cli.js')).defaultTaskLauncher;
          for (const id of ids) {
            try {
              results.push(
                await mission.advanceMission(id, {
                  live: opts.live === true,
                  ...(statePath ? { statePath } : {}),
                  ...(launcher ? { launcher } : {}),
                  ...(deps.pieceEvidence ? { readEvidence: deps.pieceEvidence } : {}),
                  ...(deps.cardRunEvidence ? { runEvidence: deps.cardRunEvidence } : {}),
                }),
              );
            } catch (error) {
              if (missionId !== undefined) throw error;
              failures.push({
                missionId: id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (missionId === undefined) {
            try {
              debug.log('task-agent', 'mission-advance', {
                missionId: null,
                all: true,
                mode: opts.live ? 'live' : 'shadow',
                stage: 'all-summary',
                missions: ids.length,
                advanced: results.length,
                failures: failures.map((failure) => failure.missionId),
                refFailures: refFailures.length,
                ms: Date.now() - started,
              });
            } catch {
              /* fail-soft */
            }
          }
          if (opts.json)
            out(
              JSON.stringify(
                missionId !== undefined ? results[0] : failures.length || refFailures.length ? { results, failures, refFailures } : results,
              ),
            );
          else {
            if (results.length === 0 && failures.length === 0) out('넘길 미션이 없다 (green 제안 전 미션 0)');
            for (const failure of failures) out(`${failure.missionId}\tadvance\tfailed\t${failure.error}`);
            for (const reason of refFailures) out(`근거 기록 실패: ${reason}`);
            for (const result of results) for (const line of advanceLines(result)) out(line);
            if (!opts.live && results.some((result) => result.handed.length > 0)) out('(shadow — 띄우지 않았다 · 띄우려면 --live)');
          }
          if (failures.length || refFailures.length || results.some((result) => result.handed.some((piece) => piece.error)))
            process.exitCode = 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : '미션 진행 실패';
          if (!(error instanceof mission.MissionAdvanceError)) {
            try {
              debug.log('task-agent', 'mission-advance', {
                missionId: missionId ?? null,
                all: opts.all === true,
                mode: opts.live ? 'live' : 'shadow',
                stage: 'cli-args',
                error: reason,
                ms: Date.now() - started,
              });
            } catch {
              /* fail-soft */
            }
          }
          out(reason);
          process.exitCode = 1;
        }
      },
    );
}
