// ── 결함 주입 심 — «next-move→dispatch 간선 ⊕ push 확인 지연 unconfirmed» ─────────
//
// 🚨 왜 이것이 있나 (NEXTMOVE-HARDEN · 2026-10-21)
//   운영 로그에는 merge→next-move 1건만 있고 next-move→dispatch 0건이라 E4 가 실물로
//   증명되지 않았다. 운영 코드는 건드리면 안 되므로, 이미 있는 생산 함수를 그대로 돌려
//   같은 PR 수리 한 바퀴에서 나와야 할 두 사건을 «기다리지 않고 일으킨다».
//   ① next-move→dispatch graph-edge-taken 1건 — runRepairCycle 이 repairNextMove 판정 뒤
//      recordJourneyEdge(judged.route, 'dispatch') 로 남기는 관측.
//   ② push 확인 지연 → unconfirmed 1건 — applyRepairBundle 이 exact-head push 에 성공한 뒤
//      PR 머리 확인(CONFIRM_DELAYS_MS)이 가짜 gh 의 늙은 머리를 못 따라잡아 내는 전이.
//
// ⛔ 흉내 내지 않는다(FAULT-SCOPE-ESCAPE-LIFT 규율): 운영이 부르는 «같은» 함수를 그대로 부른다 —
//    ① runRepairCycle(src/task-agent/repair-cycle.ts) — 발사 틱 ⊕ 결과 회수(CAS) 틱
//    ② repairNextMove ⊕ judgeNextMove(src/task-agent/repair-next-move.ts · judge.ts)
//    ③ applyRepairBundle(src/task-agent/repair-branch-cas.ts) — exact-head CAS ⊕ --force-with-lease push
//    git 은 진짜 git 을 임시 bare 원격(temp-git-remote.ts)에, gh 는 공유 PATH 심(fake-bin.ts)을 쓴다.
//    kubectl·Pod·GitHub API·네트워크는 없다. 카드 상태는 임시 디렉터리 하나에만 쓰고 끝에 지운다.
//
// 영수증 = 명령 ⊕ injectionId ⊕ 결과(receipt). 시험 출력 문면 = renderFaultNextmoveDispatch(층 L2).

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { createFakeBins, type FakeBins } from './fake-bin.js';
import { createTempGitRemote, type TempGitRemote } from './temp-git-remote.js';
import { runRepairCycle, type RepairCycleInput, type RepairLaunchRequest } from '../task-agent/repair-cycle.js';
import { applyRepairBundle, REPAIR_BUNDLE_REF, type RepairCasDeps } from '../task-agent/repair-branch-cas.js';
import { readTaskCard, writeTaskCards, type TaskCard } from '../task-agent/task-hand.js';
import { recordTaskAgentShadowMove, RELAUNCH_LAUNCHED_EVENT } from '../task-agent/shadow.js';
import { installHarnessCliCommand } from '../harness/harness-cli-command.js';
import type { SupervisorJobResult } from '../self-dev/run-supervisor.js';
import { Command } from 'commander';

/** 이 심을 재는 증거 명령 — 매뉴얼 §3 과 영수증의 «명령» 칸이 같은 문자열이다. */
export const FAULT_NEXTMOVE_DISPATCH_COMMAND = 'bun test src/ux-sim/fault-nextmove-dispatch.test.ts';

const PR = 30404;
const ORIGIN_REPO = 'sim-owner/sim-repo';
const CARD_ID = 'ta-sim-nextmove';
const BRANCH = 'feature';
const JOB = 'si-sim-nextmove';
const MUST_FIX = ['fix the broken assertion'];

export interface FaultNextmoveDispatchFixture {
  /** 임시 실물 git 원격(bare·seed·checkout) — casDeps.git 이 여기에 진짜 git 을 돌린다. */
  readonly remote: TempGitRemote;
  /** 가짜 gh PATH 심 — prView 가 이름 그대로 PATH 에서 찾는다. */
  readonly fakeBins: FakeBins;
  readonly root: string;
  readonly statePath: string;
  readonly artifactDir: string;
  /** 리뷰된 PR 머리(수리 base). */
  readonly head: string;
  /** 수리 commit(머리의 자식). */
  readonly commit: string;
  readonly bundleSha256: string;
  /** 생산 확인 루프가 요청한 지연(ms) — 심의 sleep 이 기다리지 않고 적는다. */
  readonly confirmSleeps: number[];
  cleanup(): void;
}

/** 같은 PR 수리 한 바퀴에 필요한 실물 상태를 임시 경로에 세운다. GitHub API·네트워크 없음. */
function createFaultNextmoveDispatchFixture(): FaultNextmoveDispatchFixture {
  const remote = createTempGitRemote();
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), 'ux-sim-nextmove-'));
    const checkout = remote.checkout;
    const git = remote.git;
    // clone 은 seed 의 로컬 신원을 물려받지 않는다(GIT_CONFIG_GLOBAL 이 비어 있음) — 체크아웃에 심어준다.
    git(checkout, ['config', 'user.email', 'sim@example.test']);
    git(checkout, ['config', 'user.name', 'ux-sim fault nextmove']);
    // PR 가지 — 리뷰된 머리 A. 원격에도 둔다(CAS 가 임대 비교할 기준).
    git(checkout, ['checkout', '-q', '-b', BRANCH]);
    writeFileSync(join(checkout, 'CHANGE.md'), 'pr base\n');
    git(checkout, ['add', 'CHANGE.md']);
    git(checkout, ['commit', '-q', '-m', 'pr base']);
    const head = git(checkout, ['rev-parse', 'HEAD']);
    git(checkout, ['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`]);
    // 수리 commit B — 머리의 자식. 원격은 아직 A 에 있다.
    writeFileSync(join(checkout, 'CHANGE.md'), 'pr base\nfixed\n');
    git(checkout, ['add', 'CHANGE.md']);
    git(checkout, ['commit', '-q', '-m', 'repair fix']);
    const commit = git(checkout, ['rev-parse', 'HEAD']);
    // 수리 bundle — 생산 REPAIR_BUNDLE_REF 그대로.
    git(checkout, ['update-ref', REPAIR_BUNDLE_REF, commit]);
    const artifactDir = join(root, 'pod-artifacts', JOB, 'repair');
    mkdirSync(artifactDir, { recursive: true });
    const bundlePath = join(artifactDir, 'commit.bundle');
    git(checkout, ['bundle', 'create', bundlePath, REPAIR_BUNDLE_REF]);
    const bundleSha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
    // 가짜 gh — 운영 prView 의 --json 인자 그대로. 머리는 «늙은» A 로 고정(확인 지연을 내는 장치).
    const ghView = JSON.stringify({
      state: 'OPEN', headRefOid: head, headRefName: BRANCH,
      isCrossRepository: false, headRepository: { nameWithOwner: ORIGIN_REPO },
    });
    const fakeBins = createFakeBins({ gh: { stdout: `${ghView}\n` } });
    // TA 카드 — 수리 틱이 읽는 상태 파일.
    const statePath = join(root, 'task-agent-actions.json');
    const card: TaskCard = {
      id: CARD_ID, text: 'fix the PR', seat: 'TC',
      createdAt: '2026-10-21T08:00:00.000Z', status: 'launched', history: [],
      pr: { number: PR, url: `https://github.com/${ORIGIN_REPO}/pull/${PR}` },
      childLlm: { provider: 'openai-codex', model: 'gpt-6-sol' },
    };
    writeTaskCards(statePath, [card]);
    let cleaned = false;
    return {
      remote, fakeBins, root, statePath, artifactDir, head, commit, bundleSha256, confirmSleeps: [],
      cleanup(): void {
        if (cleaned) return;
        cleaned = true;
        fakeBins.cleanup();
        remote.cleanup();
        if (root !== undefined) rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    remote.cleanup();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * 생산 applyRepairBundle 에 줄 CAS deps — ⛔ 판정 로직(CAS·push·확인 지연 루프)은 여기 하나도 없다.
 * `RepairCasDeps` 는 생산이 주입 자리로 열어 둔 I/O 어댑터 셋뿐이고, 셋 다 바깥 세계만 바꾼다:
 *   · git        — 진짜 git 을 그대로 spawn 한다. 바꾸는 것은 env(임시 원격의 GIT_CONFIG_GLOBAL 등) 하나.
 *   · prView     — 진짜 `gh pr view <pr> --json …` 를 PATH 의 가짜 gh 심에 spawn 하고 JSON 꼴만 옮긴다.
 *                  생산 어댑터의 필드 검증은 복사하지 않는다(가짜 gh 가 늘 같은 꼴을 내 판정에 안 든다).
 *   · originRepo — 임시 원격은 file:// 라 github 신원이 없다. 신원 한 줄만 심이 준다.
 */
function casDeps(fixture: FaultNextmoveDispatchFixture): RepairCasDeps {
  const ghEnv = { ...process.env, PATH: fixture.fakeBins.path() };
  return {
    git(cwd, args) {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...fixture.remote.gitEnv } });
      return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    },
    prView(cwd, pr) {
      const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'state,headRefOid,headRefName,isCrossRepository,headRepository'],
        { cwd, encoding: 'utf8', timeout: 30_000, env: ghEnv });
      if (r.status !== 0) return null;
      const v = JSON.parse(String(r.stdout)) as {
        state: string; headRefOid: string; headRefName: string; isCrossRepository: boolean; headRepository: { nameWithOwner: string };
      };
      return { state: v.state, head: v.headRefOid, branch: v.headRefName, crossRepository: v.isCrossRepository, headRepo: v.headRepository.nameWithOwner };
    },
    originRepo: () => ORIGIN_REPO,
    // 확인 지연 루프(CONFIRM_DELAYS_MS)는 생산 그대로 돈다 — 실제로 기다리지만 않는다(Atomics.wait 블로킹 제거).
    sleep: (ms) => { fixture.confirmSleeps.push(ms); },
  };
}

export interface FaultNextmoveDispatchObservation {
  /** 이번 주입의 식별자 — 영수증 칸. */
  readonly injectionId: string;
  /** ① next-move→dispatch graph-edge-taken 관측(debug sink 원문). */
  readonly edge: { readonly count: number; readonly record: Record<string, unknown> | undefined; readonly decision: string };
  /** ② push 확인 지연 → unconfirmed 전이. */
  readonly unconfirmed: { readonly decision: string; readonly status: string | undefined; readonly reason: string };
  /** 회수 틱 뒤 임시 원격의 PR 가지 머리 — 수리 commit 이면 exact-head push 가 실제로 됐다. */
  readonly remoteHead: string;
  /** 장치가 세운 수리 commit — remoteHead 와 대조한다. */
  readonly repairCommit: string;
  /** 가짜 gh PATH 심이 실제로 불린 횟수. */
  readonly ghCalls: number;
  /** 생산 확인 루프가 요청한 지연(ms) — 확인 지연이 «생산 루프를 다 돈 뒤» unconfirmed 가 됐다는 증거. */
  readonly confirmSleeps: readonly number[];
  /** HARNESS-FULL-GRAPH-NEXTMOVE — 한 수의 id 를 세 원문에서 읽은 값(결정 = next-move 노드 출구 · 간선 · 실제 발사 요청). */
  readonly moveId: { readonly decision: string | undefined; readonly edge: string | undefined; readonly dispatch: string | undefined;
    /** NEXTMOVE-GENERAL-RELAUNCH-MOVEID — 회수 틱이 결과 파일과 짝지어 카드 `repair-result` 줄에 실은 값. */
    readonly consumed: string | undefined };
  /** 두 틱이 낸 알림(심이 받아 적음 · 운영 우편함 0). */
  readonly notified: readonly { seat: string; body: string }[];
  /** 영수증 = 명령 ⊕ injectionId ⊕ 결과. */
  readonly receipt: { readonly command: string; readonly injectionId: string; readonly result: string };
}

/** 같은 PR 수리 한 바퀴를 생산 함수로 돌려 두 사건을 낸다. 발사·회수 두 틱이다. */
export async function simFaultNextmoveDispatch(): Promise<FaultNextmoveDispatchObservation> {
  const fixture = createFaultNextmoveDispatchFixture();
  const injectionId = `fnd-${randomBytes(6).toString('hex')}`;
  const firstTick = new Date('2026-10-21T08:00:00.000Z');
  const secondTick = new Date('2026-10-21T08:01:00.000Z');
  const edges: Record<string, unknown>[] = [];
  const decisions: Record<string, unknown>[] = [];
  const off = debug.registerSink({
    name: `ux-sim-fault-nextmove-dispatch-${injectionId}`,
    emit: (record) => {
      if (record.category === 'self-implement' && record.event === 'graph-edge-taken') edges.push(record.data as Record<string, unknown>);
      if (record.category === 'self-implement' && record.event === 'pipeline-node-exit'
        && (record.data as Record<string, unknown> | undefined)?.node === 'next-move') decisions.push(record.data as Record<string, unknown>);
    },
  });
  // ⛔ 생산 기본 notify(`msg post`)·request(detached elanous spawn)에 «절대» 닿지 않게 두 틱 모두 기록용 심을 준다.
  //    상태 전이가 바뀌어 기본값으로 떨어지면 운영 우편함·실제 발사가 된다(리뷰 r1).
  const notified: { seat: string; body: string }[] = [];
  const notify = (seat: string, body: string): void => { notified.push({ seat, body }); };
  try {
    const base = (now: Date): RepairCycleInput => ({
      // 매 틱 직전의 카드 원문 — 틱 ① 이 repairs 를 적은 뒤 틱 ② 는 그걸 다시 읽어야 회수 경로로 간다.
      card: readTaskCard(CARD_ID, fixture.statePath)!, statePath: fixture.statePath, repo: fixture.remote.checkout,
      pr: PR, head: fixture.head, branch: BRANCH, mustFix: MUST_FIX,
      liveMoves: new Set(['narrow-relaunch']), now, notify,
      modelAvailability: { codexSubscription: false, grokSubscription: false },
    });
    const deps = casDeps(fixture);
    // 틱 ① — 발사. runRepairCycle 이 repairNextMove 판정 뒤 recordJourneyEdge('dispatch') 를 남긴다.
    const launched: RepairLaunchRequest[] = [];
    const first = await runRepairCycle({ ...base(firstTick), request: async (request: RepairLaunchRequest) => { launched.push(request); } });
    const launch = launched[0];
    if (launched.length !== 1 || launch === undefined) {
      throw new Error(`fault-nextmove-dispatch: 발사 틱이 수리 요청을 ${launched.length}건 냈다(기대 1) · decision=${first.decision} · reason=${first.reason}`);
    }
    // 수리 worker 가 끝 JSON ⊕ artifact 를 남겼다(생산 회수 경로가 읽는 꼴 그대로).
    const result = { pr: PR, baseHead: fixture.head, runId: launch.runId, commit: fixture.commit, bundleSha256: fixture.bundleSha256 };
    writeFileSync(join(fixture.artifactDir, 'result.json'), JSON.stringify(result));
    // 생산 runRepairWorker 는 받은 --move-id 를 결과 파일에 그대로 싣는다(RepairWorkerResult.moveId).
    writeFileSync(launch.resultPath, JSON.stringify({
      pr: PR, head: fixture.head, runId: launch.runId, ok: true, job: JOB,
      artifactDir: fixture.artifactDir, result, moveId: launch.moveId,
    }));
    // 틱 ② — 결과 회수. 생산 applyRepairBundle 이 exact-head CAS push 에 성공하고
    // PR 머리 확인이 늙은 가짜 gh 머리를 못 따라잡아 unconfirmed 로 돌아온다.
    const relaunched: RepairLaunchRequest[] = [];
    const second = await runRepairCycle({
      ...base(secondTick),
      request: async (request: RepairLaunchRequest) => { relaunched.push(request); },
      apply: (request) => applyRepairBundle(request, deps),
    });
    if (relaunched.length !== 0) throw new Error(`fault-nextmove-dispatch: 회수 틱이 다시 발사했다(${relaunched.length}건) · decision=${second.decision}`);
    const stored = readTaskCard(CARD_ID, fixture.statePath);
    const unconfirmed = {
      decision: second.decision,
      status: stored?.repairs?.[0]?.status,
      reason: second.reason,
    };
    const edgeCount = edges.filter((edge) => edge.from === 'next-move' && edge.to === 'dispatch').length;
    const asId = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
    const moveId = {
      // 발사 요청과 같은 runId 의 결정만 짝짓는다(결정이 여럿이어도 남의 결정과 대조하지 않게).
      decision: asId(decisions.find((row) => row.runId === launch.runId)?.moveId),
      edge: asId(edges.find((edge) => edge.from === 'next-move' && edge.to === 'dispatch')?.moveId),
      dispatch: launch.moveId,
      consumed: asId(stored?.history.find((entry) => entry.event === 'repair-result' && entry.runId === launch.runId)?.moveId),
    };
    const remoteHead = fixture.remote.git(fixture.remote.checkout, ['ls-remote', 'origin', `refs/heads/${BRANCH}`]).split('\t')[0] ?? '';
    const ghCalls = fixture.fakeBins.calls().filter((call) => call.name === 'gh').length;
    const receipt = {
      command: FAULT_NEXTMOVE_DISPATCH_COMMAND,
      injectionId,
      result: `graph-edge-taken(next-move→dispatch)=${edgeCount} · unconfirmed=${unconfirmed.status === 'unconfirmed' ? 1 : 0}`,
    };
    return {
      injectionId,
      edge: { count: edgeCount, record: edges.find((edge) => edge.from === 'next-move' && edge.to === 'dispatch'), decision: first.decision },
      unconfirmed,
      remoteHead,
      moveId,
      repairCommit: fixture.commit,
      ghCalls,
      confirmSleeps: [...fixture.confirmSleeps],
      notified,
      receipt,
    };
  } finally {
    off();
    fixture.cleanup();
  }
}

/** CLI·시험 출력 한 화면 — 영수증(명령 ⊕ injectionId ⊕ 결과)과 두 사건 원문(층 L2). */
export function renderFaultNextmoveDispatch(observation: FaultNextmoveDispatchObservation): string[] {
  return [
    'fault-nextmove-dispatch · 층 L2 · 생산 runRepairCycle/repairNextMove/applyRepairBundle 직접 호출(GitHub API·네트워크 0)',
    `  receipt: command=${observation.receipt.command} ⊕ injectionId=${observation.receipt.injectionId} ⊕ result=${observation.receipt.result}`,
    `  ① graph-edge-taken: ${JSON.stringify(observation.edge.record ?? {})}`,
    `  ⓜ moveId: ${renderMoveIds(observation.moveId)}`,
    `  ② unconfirmed: decision=${observation.unconfirmed.decision} · status=${observation.unconfirmed.status ?? '-'} · reason=${observation.unconfirmed.reason}`,
    `  원격 PR 가지 머리: ${observation.remoteHead.slice(0, 12)} · 수리 commit ${observation.repairCommit.slice(0, 12)} · push ${observation.remoteHead === observation.repairCommit ? '됨' : '안 됨'}`,
    `  확인 지연 루프 요청(ms): ${observation.confirmSleeps.join(',') || '-'} · 알림 ${observation.notified.length}건(심이 받음)`,
    `  가짜 gh 심 호출: ${observation.ghCalls}회 · 발사 틱 판정: ${observation.edge.decision}`,
  ];
}

/** 수 id 네 원문 한 줄 — 넷이 다 같아야 «일치». */
function renderMoveIds(ids: { decision: string | undefined; edge: string | undefined; dispatch: string | undefined; consumed: string | undefined }): string {
  const same = ids.decision !== undefined && [ids.edge, ids.dispatch, ids.consumed].every((id) => id === ids.decision);
  return `decision=${ids.decision ?? '-'} · graph-edge-taken=${ids.edge ?? '-'} · dispatch=${ids.dispatch ?? '-'} · consumed=${ids.consumed ?? '-'} · ${same ? '일치' : '불일치'}`;
}

// ── NEXTMOVE-GENERAL-RELAUNCH-MOVEID — 일반 재발사(TA terminal → `harness say` 문자열 경로) 한 건 ─────────
//   생산 recordTaskAgentShadowMove(shadow.ts) → executeNextAction(actions.ts) 를 그대로 돌리고, 실행부가 낸 argv 를
//   생산 `harness say` CLI 파서(installHarnessCliCommand)에 그대로 먹인다. ⛔ 실제 발사·spawn 0 — command 는 argv 를 적기만 하고,
//   say 처리기는 문장만 받아 적는다. 카드 상태는 임시 디렉터리 하나에만 쓰고 끝에 지운다.

export const FAULT_NEXTMOVE_GENERAL_COMMAND = 'bun test src/self-dev/graph-nextmove-moveid.test.ts -t "general relaunch device"';

export interface FaultNextmoveGeneralObservation {
  readonly injectionId: string;
  readonly executorResult: string | null;
  /** 실행부가 낸 발사 argv(하나). */
  readonly argv: readonly string[];
  /** 결정(next-move 노드 출구) · graph-edge-taken · 발사(harness say 가 받은 값) · 카드 history(relaunch-launched). */
  readonly moveId: { readonly decision: string | undefined; readonly edge: string | undefined; readonly dispatch: string | undefined; readonly consumed: string | undefined };
  readonly receipt: { readonly command: string; readonly injectionId: string; readonly result: string };
}

export async function simFaultNextmoveGeneralRelaunch(): Promise<FaultNextmoveGeneralObservation> {
  const injectionId = `fng-${randomBytes(6).toString('hex')}`;
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-nextmove-general-'));
  const runId = `run-sim-general-${injectionId.slice(4)}`;
  const statePath = join(root, 'task-agent-actions.json');
  const card: TaskCard = { id: 'ta-sim-general', text: 'feature ask', seat: 'TC', createdAt: '2026-10-22T08:00:00.000Z',
    status: 'launched', history: [], runId };
  writeTaskCards(statePath, [card]);
  const rows: { category: string; event: string; data: Record<string, unknown> }[] = [];
  const off = debug.registerSink({ name: `ux-sim-fault-nextmove-general-${injectionId}`, emit: (record) => {
    if (record.category === 'self-implement' || record.category === 'harness') rows.push({ category: record.category, event: record.event, data: record.data as Record<string, unknown> });
  } });
  try {
    const argvs: string[][] = [];
    const job = { taskId: 't', feature: 'feature ask', status: 'done' } as SupervisorJobResult;
    const move = await recordTaskAgentShadowMove({ runId, stopReason: 'no-progress', results: [job] }, {
      // 빈 env — Pod·카드 힌트 없이 HQ 로컬 런으로 판단한다(운영 env 를 읽지 않는다).
      env: {} as NodeJS.ProcessEnv, statePath, log: () => {}, liveMoves: new Set(['narrow-relaunch']),
      loadGate: { loadMax: 2, load1: () => 0.5 },
      command: async (args) => { argvs.push(args); return { status: 0, stdout: '' }; },
    });
    if (argvs.length !== 1) throw new Error(`fault-nextmove-general: 발사 argv ${argvs.length}건(기대 1) · executorResult=${move.executorResult}`);
    // 발사 받는 쪽 — 생산 harness say 파서에 그 argv 를 그대로(처리기는 문장만 적는다 · 발사 0).
    const program = new Command().exitOverride();
    const said: string[][] = [];
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',
      say: async (words: string[]) => { said.push(words); } } as never);
    await program.parseAsync(['node', 'elanous', ...argvs[0]!]);
    if (said.length !== 1) throw new Error(`fault-nextmove-general: harness say 처리기 호출 ${said.length}건(기대 1)`);
    const asId = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
    const stored = readTaskCard(card.id, statePath);
    const moveId = {
      decision: asId(rows.find((row) => row.event === 'pipeline-node-exit' && row.data.node === 'next-move' && row.data.runId === runId)?.data.moveId),
      edge: asId(rows.find((row) => row.event === 'graph-edge-taken' && row.data.from === 'next-move' && row.data.to === 'dispatch')?.data.moveId),
      dispatch: asId(rows.find((row) => row.category === 'harness' && row.event === 'move-id-received')?.data.moveId),
      consumed: asId(stored?.history.find((entry) => entry.event === RELAUNCH_LAUNCHED_EVENT && entry.runId === runId)?.moveId),
    };
    return {
      injectionId, executorResult: move.executorResult, argv: argvs[0]!, moveId,
      receipt: { command: FAULT_NEXTMOVE_GENERAL_COMMAND, injectionId, result: renderMoveIds(moveId) },
    };
  } finally {
    off();
    rmSync(root, { recursive: true, force: true });
  }
}

export function renderFaultNextmoveGeneralRelaunch(observation: FaultNextmoveGeneralObservation): string[] {
  return [
    'fault-nextmove-dispatch · 일반 재발사 · 층 L2 · 생산 recordTaskAgentShadowMove/executeNextAction/harness say 파서 직접 호출(발사·spawn 0)',
    `  receipt: command=${observation.receipt.command} ⊕ injectionId=${observation.receipt.injectionId} ⊕ result=${observation.receipt.result}`,
    `  실행부 결과: ${observation.executorResult ?? '-'} · argv 꼬리: ${JSON.stringify(observation.argv.slice(-2))}`,
    `  ⓜ moveId: ${renderMoveIds(observation.moveId)}`,
  ];
}
