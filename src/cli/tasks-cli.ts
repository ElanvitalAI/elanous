import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidArgumentError, Option, type Command } from 'commander';
import { debug } from '../debug/log.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { readNexusRuntime } from '../nexus/runtime.js';
import type { Task } from '../task-orchestrator/types.js';
import { handTask, nextMoveFor, readTaskAgentState, readTaskCard, taskAgentStatePath as taskStatePathDefault, shellQuote, TASK_CARD_PREFIX, TASK_SEATS, type TaskCard, type TaskLauncher, type TaskSeat } from '../task-agent/task-hand.js';
import { advanceMission, handMission, MissionAdvanceError, openMissionIds, recordPieceRef, type AdvanceMissionResult, type MissionDecompose, type PieceEvidenceReader } from '../task-agent/mission.js';

type TaskRow = Pick<Task, 'id' | 'title' | 'priority' | 'status' | 'createdAt' | 'approval' | 'generatedBy'>;

export interface TasksCliDeps {
  baseUrl?: string;
  bearerToken?: string;
  fetch?: typeof fetch;
  output?: (line: string) => void;
  /** `task hand --live` 의 발사기(시험 주입). 기본은 운영 config-dir 로 `harness say` 를 떼어 띄운다. */
  taskLauncher?: TaskLauncher;
  /** 과제 카드 상태 파일(시험 주입). 기본 = `effectiveInstanceRoot()/task-agent-actions.json`. */
  taskStatePath?: string;
  /** logs.db 싱크 등록(시험 주입). 기본 = `registerStandaloneLogSink`. `hand`·`show` 가 부른다. */
  registerSink?: (surface: string) => Promise<unknown>;
  /** `task hand --mission` 의 분해기(시험 주입). 기본 = 나열형은 결정론 · 아니면 `decomposeSelfDevGoal`. */
  missionDecompose?: MissionDecompose;
  /** `task advance` 의 착지 근거 읽기(시험 주입). 기본 = `predecessorState`(gh · 런 원장). */
  pieceEvidence?: PieceEvidenceReader;
}

/** `<조각id>=<값>` 반복 인자. */
function collectPair(value: string, previous: Array<[string, string]> = []): Array<[string, string]> {
  const at = value.indexOf('=');
  if (at <= 0 || at === value.length - 1) throw new InvalidArgumentError(`<조각id>=<값> 모양이 아니다: ${value}`);
  return [...previous, [value.slice(0, at), value.slice(at + 1)]];
}

function advanceLines(result: AdvanceMissionResult): string[] {
  // 제안이 끝난 미션은 다시 조회하지 않는다 — «착지 0»으로 보이지 않게 따로 적는다.
  if (result.green === 'already-proposed' && Object.keys(result.evidence).length === 0) return [`${result.missionId}\tadvance\t${result.mode}\tgreen already-proposed — 다시 조회·넘기지 않는다`];
  return [
    `${result.missionId}\tadvance\t${result.mode}\t착지 ${result.landed.length} · 준비 ${result.ready.length} · 넘김 ${result.handed.length} · green ${result.green}`,
    ...Object.entries(result.evidence).map(([id, state]) => `  근거: ${id}\t${state}${result.landed.includes(id) ? '\t착지' : ''}`),
    ...result.handed.map((piece) => `  넘김: ${piece.pieceId}\t${piece.launched ? 'launched' : piece.error ? 'failed' : 'not launched'}${piece.error ? `\t${piece.error}` : ''}`),
    ...(result.green === 'proposed' ? ['  green 제안을 미션 카드에 적었다 — 체크리스트는 바꾸지 않는다(OP/주인이 뒤집는다)'] : []),
  ];
}

/** `tasks hand`·`show` 가 남기는 `task-agent` 관측의 logs.db surface 라벨. */
export const TASK_AGENT_SINK_SURFACE = 'task-agent';

/**
 * 독립 CLI 프로세스는 데몬의 logs.db 싱크를 상속하지 않는다 — 등록하지 않으면 `debug.log('task-agent', …)` 가
 * 파일 트레일에만 남고 `elanous logs --category task-agent` 에 0건으로 보인다(10-06 실측: 카드 3장 · 이벤트 0).
 * fail-open — 등록 실패가 과제 넘기기를 막지 않는다.
 */
export async function registerTaskAgentSink(register?: (surface: string) => Promise<unknown>): Promise<void> {
  try {
    const fn = register ?? (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink;
    await fn(TASK_AGENT_SINK_SURFACE);
  } catch { /* fail-open — 파일 트레일이 진실원 */ }
}

/**
 * 기본 발사기 — 지금 도는 진입점으로 `--config-dir <운영 config>` 를 붙여 떼어 띄운다.
 * config-dir 은 명시(`--config-dir`/`--test`)가 있으면 그것, 없으면 운영 루트(`prodInstanceRoot()`)다.
 * (작업 트리에서 그냥 띄우면 test 우주로 가서 동결·몫·풀 상한 밖에서 돈다.)
 */
export async function defaultTaskLauncher(args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
  const { prodInstanceRoot } = await import('../instance/resolve.js');
  const configDir = getElanousConfigDirOverride() ?? prodInstanceRoot();
  await spawnDetachedConfirmed(spawn as unknown as DetachedSpawn, process.execPath, [process.argv[1]!, '--config-dir', configDir, ...args]);
}

/** `spawn` 의 필요한 면만(시험 주입). */
export type DetachedSpawn = (command: string, args: string[], options: { detached: true; stdio: 'ignore' }) => {
  pid?: number;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  unref(): void;
};

/** 발사 확인 대기 상한 — 'spawn'·'error' 어느 쪽도 이 안에 안 오면 pid 유무로 판정한다. */
export const SPAWN_CONFIRM_TIMEOUT_MS = 2_000;

/**
 * 떼어 띄우고 «떴는지» 확인한다 — 'spawn' 이면 성공, 'error'(ENOENT·EACCES 등)면 던진다.
 * 확인 없이 돌려주면 비동기 error 가 처리되지 않고 카드가 `launched` 로 남는다(사후 리뷰 must-fix).
 */
export function spawnDetachedConfirmed(spawnFn: DetachedSpawn, command: string, args: string[], timeoutMs = SPAWN_CONFIRM_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<DetachedSpawn>;
    try { child = spawnFn(command, args, { detached: true, stdio: 'ignore' }); } catch (error) { reject(error); return; }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      // error 리스너는 남겨 둔다 — 확인 뒤 늦게 오는 error 도 처리되지 않은 예외가 되지 않게.
      if (error) { reject(error); return; }
      child.unref();
      resolve();
    };
    const onSpawn = () => finish();
    const onError = (error: Error) => finish(error);
    child.once('spawn', onSpawn);
    child.once('error', onError);
    const timer = setTimeout(() => finish(child.pid ? undefined : new Error(`발사 확인 시간 초과(${timeoutMs}ms) · pid 없음`)), timeoutMs);
  });
}

function moveLine(card: TaskCard): string {
  const move = nextMoveFor(card);
  return `${move.kind}${move.command ? ` — elanous ${move.command.map(shellQuote).join(' ')}` : ''} (${move.reason})`;
}

function headLine(text: string): string {
  const first = text.split('\n')[0]!.trim();
  return first.length > 100 ? `${first.slice(0, 100)}…` : first;
}

function taskCardLines(card: TaskCard): string[] {
  return [
    [card.id, card.status, card.seat ?? '-', card.checklistId ?? '-', card.createdAt, card.text].join('\t'),
    ...(card.mission ? [`미션: ${card.mission} · after: ${card.after?.length ? card.after.join(', ') : '-'}`] : []),
    `다음 수: ${moveLine(card)}`,
  ];
}

/** 미션 카드 — 머리 한 줄 ⊕ 조각 한 줄씩(상태·다음 수·선행) ⊕ 간선 한 줄씩. */
function missionLines(mission: TaskCard, pieces: TaskCard[]): string[] {
  const edges = pieces.flatMap((piece) => (piece.after ?? []).map((before) => `간선: ${before} -> ${piece.id}`));
  return [
    [mission.id, 'mission', mission.seat ?? '-', mission.checklistId ?? '-', mission.createdAt, `조각 ${pieces.length} · 간선 ${edges.length} · 출처 ${mission.splitSource ?? '-'}`, headLine(mission.text)].join('\t'),
    ...pieces.map((piece) => [`조각: ${piece.id}`, piece.status, nextMoveFor(piece).kind, `after: ${piece.after?.length ? piece.after.join(',') : '-'}`, headLine(piece.text)].join('\t')),
    ...edges,
    ...(mission.greenProposal ? [`green 제안: ${mission.greenProposal.at} · 칸 ${mission.greenProposal.checklistId ?? '-'} · 근거 ${Object.entries(mission.greenProposal.evidence).map(([id, ref]) => `${id}=${ref}`).join(', ')}`] : []),
  ];
}

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const NEXUS_DOWN = '넥서스가 안 떠 있다 — `elanous nexus run`';

function taskOrder(a: TaskRow, b: TaskRow): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function taskSource(task: TaskRow): string {
  return task.generatedBy?.kind === 'external'
    ? `${task.generatedBy.provider}:${task.generatedBy.ref}` : '-';
}

function taskLine(task: TaskRow): string {
  return [task.id, task.priority, task.status, task.approval?.state ?? '-', taskSource(task), task.title].join('\t');
}

function credentials(deps: TasksCliDeps): { baseUrl: string; token?: string } | null {
  const port = deps.baseUrl !== undefined ? undefined : readNexusRuntime()?.httpPort;
  const baseUrl = deps.baseUrl ?? (port ? `http://127.0.0.1:${port}` : undefined);
  if (!baseUrl) return null;
  // Same as `connector linear sync`: an isolated (--test) universe has no acp-token and its
  // daemon accepts loopback callers without one — send the bearer only when there is one.
  let token = deps.bearerToken;
  if (token === undefined) {
    try { token = readFileSync(join(getElanousConfigDir(), 'acp-token'), 'utf8').trim() || undefined; }
    catch { token = undefined; }
  }
  return { baseUrl, ...(token ? { token } : {}) };
}

class NexusUnavailable extends Error {}

async function request(deps: TasksCliDeps, auth: { baseUrl: string; token?: string }, path: string, method = 'GET'): Promise<Response> {
  try {
    return await (deps.fetch ?? fetch)(`${auth.baseUrl}${path}`, {
      method,
      headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
    });
  } catch {
    // Fetch exceptions can include the URL or credentials; never forward their text.
    throw new NexusUnavailable();
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new Error('넥서스 응답 JSON이 유효하지 않다'); }
}

function httpError(response: Response): Error {
  // Do not echo server-supplied error bodies: they may contain credentials.
  return new Error(`HTTP ${response.status}`);
}

function handleError(error: unknown, out: (line: string) => void): void {
  if (error instanceof NexusUnavailable) {
    out(NEXUS_DOWN);
    process.exitCode = 2;
  } else {
    out(error instanceof Error ? error.message : '태스크 요청 실패');
    process.exitCode = 1;
  }
}

export function registerTasksCommands(program: Command, deps: TasksCliDeps = {}): void {
  let activeToken: string | undefined;
  const output = deps.output ?? console.log;
  const out = (line: string) => output(activeToken ? line.replaceAll(activeToken, '[redacted]') : line);
  const authenticate = () => {
    const auth = credentials(deps);
    activeToken = auth?.token;
    if (!auth) throw new NexusUnavailable();
    return auth;
  };
  const tasks = program.command('tasks').alias('task').description('TOX 태스크 조회 및 승인 · TASK-AGENT 과제 넘기기(hand)');

  tasks.command('list')
    .description('우선순위와 생성 시각 순으로 태스크 보기')
    .option('--status <s>', '상태로 필터')
    .option('--provider <p>', '외부 출처로 필터')
    .option('--json', 'JSON 출력')
    .action(async (opts: { status?: string; provider?: string; json?: boolean }) => {
      try {
        activeToken = undefined;
        const auth = authenticate();
        const response = await request(deps, auth, '/v1/tasks');
        if (!response.ok) throw httpError(response);
        const body = await responseJson(response) as { tasks?: Array<Pick<TaskRow, 'id' | 'status'>> };
        if (!Array.isArray(body?.tasks)) throw new Error('넥서스 태스크 목록 형식이 유효하지 않다');
        const cards = body.tasks.filter((task) => !opts.status || task.status === opts.status);
        // The list endpoint returns board cards without approval or provenance.
        // Obtain those fields from the detail endpoint rather than displaying guesses.
        const rows: TaskRow[] = [];
        for (const card of cards) {
          const detail = await request(deps, auth, `/v1/tasks/${encodeURIComponent(card.id)}`);
          if (!detail.ok) throw httpError(detail);
          const data = await responseJson(detail) as { task?: TaskRow };
          if (!data?.task || data.task.id !== card.id) throw new Error('넥서스 태스크 상세 형식이 유효하지 않다');
          if (!opts.provider || (data.task.generatedBy?.kind === 'external' && data.task.generatedBy.provider === opts.provider)) rows.push(data.task);
        }
        rows.sort(taskOrder);
        if (opts.json) out(JSON.stringify(rows));
        else {
          out('id\t우선순위\t상태\t승인\t출처\t제목');
          for (const row of rows) out(taskLine(row));
        }
      } catch (error) { handleError(error, out); }
    });

  tasks.command('hand [text]')
    .description('TASK-AGENT 에 과제 한 줄을 넘긴다 — 카드를 적고 첫 수(harness say --substrate pod --merge-by-host)를 고른다 · 기본 shadow(발사 0) · `--mission` 이면 조각 카드 ⊕ 선후로 쪼개 선행 없는 조각만 넘긴다')
    .addOption(new Option('--seat <seat>', `과제 자리 (${TASK_SEATS.join('|')})`).choices([...TASK_SEATS]))
    .option('--checklist <cellId>', '릴리스 체크리스트 칸 id')
    .option('--mission <text>', '미션 문면 — 조각(`- …`·`① …`·`1. …` ⊕ `after: 1`)으로 나열돼 있으면 결정론, 아니면 분해기로 쪼갠다')
    .option('--live', '실제로 발사한다(기본은 shadow — 명령만 출력)')
    .option('--json', 'JSON 출력')
    .action(async (text: string | undefined, opts: { seat?: TaskSeat; checklist?: string; mission?: string; live?: boolean; json?: boolean }) => {
      await registerTaskAgentSink(deps.registerSink);
      if ((text === undefined) === (opts.mission === undefined)) {
        out('과제 한 줄 «또는» --mission <문면> 중 하나만 준다');
        process.exitCode = 1;
        return;
      }
      if (opts.mission !== undefined) {
        try {
          const result = await handMission({
            text: opts.mission,
            ...(opts.seat ? { seat: opts.seat } : {}),
            ...(opts.checklist ? { checklistId: opts.checklist } : {}),
            live: opts.live === true,
            ...(deps.taskStatePath ? { statePath: deps.taskStatePath } : {}),
            launcher: deps.taskLauncher ?? defaultTaskLauncher,
            ...(deps.missionDecompose ? { decompose: deps.missionDecompose } : {}),
          });
          if (opts.json) out(JSON.stringify(result));
          else {
            out(`${result.mission.id}\tmission\t${result.mode}\t조각 ${result.pieces.length} · 간선 ${result.edges.length} · 출처 ${result.source}`);
            for (const piece of result.pieces) {
              out([piece.card.id, piece.launched ? 'launched' : piece.error ? 'failed' : 'not launched', `${piece.move.kind} (${piece.move.reason})`, headLine(piece.card.text)].join('\t'));
              if (piece.move.command) out(`  elanous ${piece.move.command.map(shellQuote).join(' ')}`);
              if (piece.error) out(`  ${piece.error}`);
            }
            for (const [before, after] of result.edges) out(`간선: ${before} -> ${after}`);
            if (result.mode === 'shadow') out('(shadow — 띄우지 않았다 · 띄우려면 --live)');
          }
          if (result.pieces.some((piece) => piece.error)) process.exitCode = 1;
        } catch (error) {
          out(error instanceof Error ? error.message : '미션 넘기기 실패');
          process.exitCode = 1;
        }
        return;
      }
      try {
        const result = await handTask({
          text: text!,
          ...(opts.seat ? { seat: opts.seat } : {}),
          ...(opts.checklist ? { checklistId: opts.checklist } : {}),
          live: opts.live === true,
          ...(deps.taskStatePath ? { statePath: deps.taskStatePath } : {}),
          launcher: deps.taskLauncher ?? defaultTaskLauncher,
        });
        if (opts.json) out(JSON.stringify(result));
        else {
          out(`${result.card.id}\t${result.mode}\t${result.launched ? 'launched' : 'not launched'}`);
          out(`elanous ${result.move.command!.map(shellQuote).join(' ')}`);
          if (!result.launched) out('(shadow — 띄우지 않았다 · 띄우려면 --live)');
        }
      } catch (error) {
        out(error instanceof Error ? error.message : '과제 넘기기 실패');
        process.exitCode = 1;
      }
    });

  tasks.command('advance [missionId]')
    .description('TASK-AGENT 미션 ② — 조각의 PR 병합(근거: `--pr`/`--goal` 로 카드에 적은 PR 번호·골 id)으로 착지를 가르고 새로 준비된 조각만 한 번 넘긴다 · 모두 착지면 green «제안»만 적는다 · 기본 shadow(발사 0)')
    .option('--all', 'green 제안이 아직 없는 미션 전부')
    .option('--pr <pieceId=N>', '조각 카드에 그 런의 PR 번호를 적는다(반복 가능)', collectPair)
    .option('--goal <pieceId=goalId>', '조각 카드에 골 id(16자)를 적는다 — 런 원장 pr-opened 로 PR 을 찾는다(반복 가능)', collectPair)
    .option('--live', '준비된 조각을 실제로 발사한다(기본은 shadow)')
    .option('--json', 'JSON 출력')
    .action(async (missionId: string | undefined, opts: { all?: boolean; pr?: Array<[string, string]>; goal?: Array<[string, string]>; live?: boolean; json?: boolean }) => {
      await registerTaskAgentSink(deps.registerSink);
      const started = Date.now();
      if ((missionId === undefined) === (opts.all !== true)) {
        const reason = '미션 id «또는» --all 중 하나만 준다';
        try { debug.log('task-agent', 'mission-advance', { missionId: missionId ?? null, all: opts.all === true, mode: opts.live ? 'live' : 'shadow', stage: 'cli-args', error: reason, ms: Date.now() - started }); } catch { /* fail-soft */ }
        out(reason);
        process.exitCode = 1;
        return;
      }
      const statePath = deps.taskStatePath;
      try {
        // 근거 인자는 운영자 입력이다 — 모양을 «먼저» 전부 검사해 하나라도 틀리면 아무것도 적지 않고 진행도 안 한다.
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
        // 기록 실패(없는 조각 · 제안된 미션)는 그 근거만 실패로 적고 계속 — `--all` 의 나머지 미션을 막지 않는다.
        const refFailures: string[] = [];
        for (const [pieceId, ref] of refs) {
          try { recordPieceRef(pieceId, ref, statePath, missionId); } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (missionId !== undefined) throw error;
            refFailures.push(reason);
          }
        }
        const ids = missionId !== undefined ? [missionId] : openMissionIds(statePath);
        const results: AdvanceMissionResult[] = [];
        const failures: Array<{ missionId: string; error: string }> = [];
        for (const id of ids) {
          try {
            results.push(await advanceMission(id, {
              live: opts.live === true,
              ...(statePath ? { statePath } : {}),
              launcher: deps.taskLauncher ?? defaultTaskLauncher,
              ...(deps.pieceEvidence ? { readEvidence: deps.pieceEvidence } : {}),
            }));
          } catch (error) {
            // 미션 id 하나면 그대로 실패 · --all 이면 그 미션만 실패로 적고 다음 미션으로 간다(크론이 한 미션에 막히지 않게).
            if (missionId !== undefined) throw error;
            failures.push({ missionId: id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (missionId === undefined) {
          // --all 은 호출마다 요약 한 줄 — 대상 0·근거 기록 실패뿐인 호출도 관측에 남는다(미션별 줄은 advanceMission 이 남긴다).
          try { debug.log('task-agent', 'mission-advance', { missionId: null, all: true, mode: opts.live ? 'live' : 'shadow', stage: 'all-summary', missions: ids.length, advanced: results.length, failures: failures.map((failure) => failure.missionId), refFailures: refFailures.length, ms: Date.now() - started }); } catch { /* fail-soft */ }
        }
        if (opts.json) out(JSON.stringify(missionId !== undefined ? results[0] : failures.length || refFailures.length ? { results, failures, refFailures } : results));
        else {
          if (results.length === 0 && failures.length === 0) out('넘길 미션이 없다 (green 제안 전 미션 0)');
          for (const failure of failures) out(`${failure.missionId}\tadvance\tfailed\t${failure.error}`);
          for (const reason of refFailures) out(`근거 기록 실패: ${reason}`);
          for (const result of results) for (const line of advanceLines(result)) out(line);
          if (!opts.live && results.some((result) => result.handed.length > 0)) out('(shadow — 띄우지 않았다 · 띄우려면 --live)');
        }
        if (failures.length || refFailures.length || results.some((result) => result.handed.some((piece) => piece.error))) process.exitCode = 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : '미션 진행 실패';
        // advanceMission 에 닿기 전(근거 인자 검사·기록)에 멈춘 호출도 한 줄 — 관측이 «호출마다» 남는다.
        // advanceMission 안에서 던진 것은 거기서 이미 남겼다(같은 오류를 두 번 적지 않는다).
        if (!(error instanceof MissionAdvanceError)) {
          try { debug.log('task-agent', 'mission-advance', { missionId: missionId ?? null, all: opts.all === true, mode: opts.live ? 'live' : 'shadow', stage: 'cli-args', error: reason, ms: Date.now() - started }); } catch { /* fail-soft */ }
        }
        out(reason);
        process.exitCode = 1;
      }
    });

  tasks.command('show <id>')
    .description(`태스크 상세 보기 (id 가 \`${TASK_CARD_PREFIX}\` 로 시작하면 TASK-AGENT 과제 카드 ⊕ 다음 수)`)
    .option('--json', 'JSON 출력')
    .action(async (id: string, opts: { json?: boolean }) => {
      if (id.startsWith(TASK_CARD_PREFIX)) {
        await registerTaskAgentSink(deps.registerSink);
        let card: TaskCard | undefined;
        try { card = readTaskCard(id, deps.taskStatePath); } catch (error) {
          out(error instanceof Error ? error.message : '과제 카드 읽기 실패');
          process.exitCode = 1;
          return;
        }
        if (!card) { out(`과제 카드 없음: ${id}`); process.exitCode = 1; return; }
        if (card.pieces) {
          let all: Record<string, TaskCard>;
          try { all = readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(deps.taskStatePath ?? taskStatePathDefault()).tasks ?? {}; } catch (error) {
            out(error instanceof Error ? error.message : '과제 카드 읽기 실패');
            process.exitCode = 1;
            return;
          }
          const pieces = card.pieces.map((pieceId) => all[pieceId]).filter((piece): piece is TaskCard => piece !== undefined);
          const missingPieces = card.pieces.filter((pieceId) => !all[pieceId]);
          if (opts.json) {
            out(JSON.stringify({ card, nextMove: nextMoveFor(card), pieces: pieces.map((piece) => ({ card: piece, nextMove: nextMoveFor(piece) })), missingPieces }));
            if (missingPieces.length) process.exitCode = 1;
          }
          else {
            for (const line of missionLines(card, pieces)) out(line);
            for (const missing of missingPieces) { out(`조각 카드 없음: ${missing} — 선후 기록이 불완전하다`); process.exitCode = 1; }
          }
          return;
        }
        if (opts.json) out(JSON.stringify({ card, nextMove: nextMoveFor(card) }));
        else for (const line of taskCardLines(card)) out(line);
        return;
      }
      try {
        activeToken = undefined;
        const auth = authenticate();
        const response = await request(deps, auth, `/v1/tasks/${encodeURIComponent(id)}`);
        if (!response.ok) throw httpError(response);
        const data = await responseJson(response) as { task?: TaskRow };
        if (!data?.task) throw new Error('넥서스 태스크 상세 형식이 유효하지 않다');
        if (opts.json) out(JSON.stringify(data));
        else {
          out(taskLine(data.task));
          out(JSON.stringify(data, null, 2));
        }
      } catch (error) { handleError(error, out); }
    });

  tasks.command('approve <id...>')
    .description('외부 태스크 승인')
    .action(async (ids: string[]) => {
      try {
        activeToken = undefined;
        const auth = authenticate();
        let failed = false;
        for (const id of ids) {
          try {
            const response = await request(deps, auth, `/v1/tasks/${encodeURIComponent(id)}/approve`, 'POST');
            if (!response.ok) {
              out(`${id}\tfailed HTTP ${response.status}`);
              failed = true;
              continue;
            }
            const result = await responseJson(response) as { already?: boolean };
            out(`${id}\t${result?.already ? 'already' : 'approved'}`);
          } catch (error) {
            if (error instanceof NexusUnavailable) {
              out(`${id}\tfailed ${NEXUS_DOWN}`);
              process.exitCode = 2;
            } else {
              out(`${id}\tfailed 응답 JSON이 유효하지 않다`);
              failed = true;
            }
          }
        }
        if (failed && process.exitCode !== 2) process.exitCode = 1;
      } catch (error) { handleError(error, out); }
    });
}
