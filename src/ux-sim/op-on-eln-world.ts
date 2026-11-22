import { OP_WORLD_REPLAY_SCENES } from './op-world-replay.js';

/** An in-memory simulation ledger with no production mail, PR or clock adapter. */
export interface OpWorldOrder {
  id: string;
  task: string;
  priority: 'P0' | 'P1';
  instruction: string;
  supersedes?: string;
  /** #39377 shouldFix a: 정정으로 무효화된 지시는 삭제하지 않고 canceled 표지로 남긴다. */
  canceled?: true;
}

export interface OpWorldReport { id: string; from: string; body: string }

export interface OpWorldWorker {
  id: string;
  specialties: readonly string[];
  status: 'ready' | 'delayed' | 'stopped' | 'failed';
  assignment: string | null;
  heartbeat: string;
}

export interface OpWorldPullRequest {
  id: string;
  head: string;
  gate: { head: string; status: 'pass' | 'fail' | 'pending' };
  review: { head: string; verdict: 'pass' | 'warn' | 'hold'; mustFix: number; roundsRemaining: number };
  state: 'open' | 'landed';
}

export interface OpWorldAction {
  type: 'assign' | 'hold' | 'land' | 'report' | 'recover';
  target: string;
  reason: string;
  evidence: readonly string[];
  worker?: string;
  /** Structured A/B replay choice — replaces reason-text guessing in the evaluator. */
  choice?: { choice: 'A' | 'B'; evidenceId: string };
  /** #39377 terra mustFix ②: 재현 처분 토큰(op-world-evaluator.ts 열거) — reason 정규식 채점 금지. */
  disposition?: string;
}

export interface OpWorldActionResult {
  action: OpWorldAction;
  status: 'accepted' | 'denied' | 'retry';
  detail: string;
}

export interface OpWorldSnapshot {
  sceneId: string;
  now: string;
  triggers: readonly ('half-hour-card' | 'hourly-check')[];
  orders: readonly OpWorldOrder[];
  reports: readonly OpWorldReport[];
  workers: readonly OpWorldWorker[];
  pullRequests: readonly OpWorldPullRequest[];
  memory: readonly { id: string; text: string }[];
  actionResults: readonly OpWorldActionResult[];
}

const SEATS = ['sim-release', 'sim-platform', 'sim-ux', 'sim-review', 'sim-runtime', 'sim-spare'] as const;
const SCENES = ['planning-flood', 'corrected-order', 'failed-lane', 'hourly-convergence'] as const;
const ORDER_GROUPS = [
  [
    ['export-check', '원격 export-check 기본과 대체 경로를 검증하라.'],
    ['ffmpeg-build', '공유 빌드의 ffmpeg 막힘을 병행 조사하라.'],
    ['version-stamp', 'ffmpeg 빌드 통과 뒤 버전 스탬프를 진행하라.'],
    ['onboard-design', '로그인 후 복원 목록 설계 버전을 확인하라.'],
    ['onboard-sim', '격리 테스트 회원의 복원 목록을 검증하라.'],
    ['review-backlog', '현 head 판정과 옛 판정을 구분하라.'],
    ['register-hosts', '호스트 등록부 갱신 시각을 비교하라.'],
    ['run-receipts', '실행 ID와 결과 원문 경로를 남겨라.'],
  ],
  [
    ['export-check', '정정: sim-node-b을 기본으로, 무응답이면 등록 대체 호스트를 써라.'],
    ['onboard-sim', '정정: 합성 목록만 검증하라. 자격 동기와 실제 복원은 범위 밖이다.'],
    ['land-now', '현재 head에서 pregate와 리뷰를 대조해 착지 후보를 분류하라.'],
    ['side-badge', '배너 문구 회귀를 UX에 배정하라.'],
    ['stale-head', '새 커밋 이후 기존 영수 효력을 재확인하라.'],
    ['split-pr', '다중 파일 수리는 사람이 격리 worktree에서 직접 담당한다. TA 신규 발사는 시범 칸만.'],
    ['seat-register', '멎은 자리와 느린 자리를 구분하라.'],
    ['parallel-build', '기존 빌드와 겹치지 않는 후속을 골라라.'],
  ],
  [
    ['recover-lane', '죽은 탭의 마지막 영수에서 대체 레인으로 이관하라.'],
    ['stale-registration', '등록부와 마지막 heartbeat를 대조하라.'],
    ['resume-gate', '실패 갈래의 재개 위치를 검증하라.'],
    ['review-budget', '리뷰 상한 소진 항목의 남은 수정 근거를 보존하라.'],
    ['isolation', '격리 장면의 운영 호스트 접근을 거부하라.'],
    ['baseline', '같은 환경에서 얻은 성공 기준을 붙여라.'],
    ['memory', '어제 미완 약속을 보고에 포함하라.'],
  ],
  [
    ['gate-recheck', '새 head의 영수를 다시 대조하라.'],
    ['hourly-report', '착지, 대기, 막힘을 한국어로 결론부터 보고하라.'],
    ['run-dedupe', '영수가 있는 조치를 중복 집행하지 마라.'],
    ['dependencies', '버전 스탬프의 선행 빌드 결과를 재확인하라.'],
    ['open-work', '열린 PR을 현재 컷과 대조하라.'],
    ['follow-up', '실패 장면을 다음 점검 항목으로 남겨라.'],
    ['preserve-ledger', '재시작 후에도 미이행 지시와 착지 기록을 이어 보라.'],
  ],
] as const;

const OBSERVATIONS = [
  ['PR pregate 완료', '응답 지연', '합성 회원만 사용', '리뷰 head 불일치', '선행 빌드 대기', '대체 레인 유휴'],
  ['기본 호스트 타임아웃', '대체 호스트 응답', '실제 복원 미측정', 'WARN must-fix 0', 'ffmpeg 빌드 대기', '배정 중복 의심'],
  ['pregate 실패', 'heartbeat 정체', '상태 보고 준비', '리뷰 상한 소진 및 must-fix 2', '실패 입력 보존', '대체 레인 비어 있음'],
  ['현 head 영수 갱신', '등록부 대조 완료', '합성 목록 확인', '현 head PASS', '스탬프 선행 빌드 실패', '수복 이관 중복 금지'],
] as const;

const MEMORY = [
  { id: 'mem-build-order', text: '어제 결정: ffmpeg 공유 빌드 영수 전에 버전 스탬프를 진행하지 않는다.' },
  { id: 'mem-restore-scope', text: '어제 약속: 로그인 1회→복원 목록 합성 근거만 제출한다.' },
  { id: 'mem-land-head', text: '어제 결정: 현 head pregate와 리뷰가 필요하다. 현 head WARN must-fix 0은 착지 후보이다.' },
];

function request(id: string, head: string, status: OpWorldPullRequest['gate']['status'],
  verdict: OpWorldPullRequest['review']['verdict'], reviewHead = head): OpWorldPullRequest {
  return {
    id, head, gate: { head, status },
    review: { head: reviewHead, verdict, mustFix: verdict === 'hold' ? 2 : 0, roundsRemaining: verdict === 'hold' ? 0 : 2 },
    state: 'open',
  };
}

export function createOpOnElnWorld(start = '2026-11-21T08:30:00+09:00') {
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) throw new Error('Invalid simulated OP clock start');
  const specialties = [['release'], ['infra'], ['ux'], ['review'], ['runtime'], ['release', 'infra', 'runtime']];
  const freshWorkers = (heartbeat: string): OpWorldWorker[] => SEATS.map((id, index) => ({
    id, specialties: specialties[index]!, status: 'ready', assignment: null, heartbeat,
  }));
  let workers = freshWorkers(new Date(startMs).toISOString());
  let requests = [
    request('sim-pr-ready', 'sim-head-a', 'pass', 'pass'),
    request('sim-pr-stale', 'sim-head-b2', 'pass', 'pass', 'sim-head-b1'),
    request('sim-pr-warn', 'sim-head-c', 'pass', 'warn'),
    request('sim-pr-build', 'sim-head-d', 'pending', 'hold'),
  ];
  const pendingOrders = new Map<string, OpWorldOrder>();
  /** #39377 terra r4 mustFix 0: 배정되어 pendingOrders 에서 뺀 지시도 정정 취소 표지를 위해 여기 보존한다. */
  const assignedOrders = new Map<string, OpWorldOrder>();
  const actionResults: OpWorldActionResult[] = [];
  let scene = -1;
  let orderCount = 0;
  let toolFailureInjected = false;
  let caseReportTargets: ReadonlySet<string> | null = null;

  function nextSnapshot(): OpWorldSnapshot | null {
    if (scene + 1 >= SCENES.length + OP_WORLD_REPLAY_SCENES.length) return null;
    scene += 1;
    const time = new Date(startMs + scene * 30 * 60 * 1_000);
    const now = time.toISOString();
    const triggers: OpWorldSnapshot['triggers'] = time.getUTCMinutes() === 0
      ? ['half-hour-card', 'hourly-check']
      : ['half-hour-card'];
    const replay = OP_WORLD_REPLAY_SCENES[scene - SCENES.length];
    if (replay) {
      workers = freshWorkers(now);
      requests = structuredClone([...replay.pullRequests]);
      pendingOrders.clear();
      actionResults.length = 0;
      for (const order of replay.orders) pendingOrders.set(order.id, order);
      caseReportTargets = 'independentCases' in replay && replay.independentCases === true
        ? new Set(replay.orders.map((order) => order.task))
        : null;
      return structuredClone({
        sceneId: replay.id, now, triggers: caseReportTargets ? [] : triggers,
        orders: replay.orders, reports: replay.reports, workers, pullRequests: requests,
        memory: caseReportTargets ? [] : MEMORY, actionResults,
      });
    }
    workers[1]!.status = scene === 0 ? 'ready' : scene === 1 ? 'delayed' : 'stopped';
    workers[4]!.status = scene < 2 ? 'ready' : 'failed';
    for (const worker of workers) {
      if (worker.status === 'ready' || worker.status === 'failed') worker.heartbeat = now;
    }
    const spare = workers[5]!;
    const completedSpareAssignment = scene === 2 && spare.assignment === 'crown-8' ? spare.assignment : null;
    if (scene === 2) {
      if (completedSpareAssignment) spare.assignment = null;
      if (!workers[4]!.assignment) workers[4]!.assignment = 'sim-existing-failed-run';
    }
    if (scene === 3) {
      const stale = requests[1]!;
      stale.review = { ...stale.review, head: stale.head };
      requests[3]!.gate.status = 'fail';
    }

    for (const [index, [task, instruction]] of ORDER_GROUPS[scene]!.entries()) {
      const supersedes = scene === 1 && index < 2 ? ['crown-1', 'crown-5'][index] : undefined;
      if (supersedes) {
        // #39377 terra r4 mustFix 0: 대기 중이든 이미 배정돼 빠졌든 이전 지시를 canceled 표지로 원장에 남긴다.
        const supersededOrder = pendingOrders.get(supersedes) ?? assignedOrders.get(supersedes);
        if (supersededOrder) pendingOrders.set(supersedes, { ...supersededOrder, canceled: true });
        const supersededWorker = workers.find((worker) => worker.assignment === supersedes);
        if (supersededWorker) supersededWorker.assignment = null;
      }
      const id = `crown-${++orderCount}`;
      pendingOrders.set(id, {
        id, task, instruction, priority: index < 3 ? 'P0' : 'P1',
        ...(supersedes === undefined ? {} : { supersedes }),
      });
    }

    const reports = Array.from({ length: 25 }, (_, index) => ({
      id: `report-${scene * 25 + index + 1}`,
      from: SEATS[index % SEATS.length]!,
      body: scene === 2 && index % SEATS.length === 5 && completedSpareAssignment
        ? `기존 배정 ${completedSpareAssignment} 종료, 대체 레인 유휴`
        : scene === 2 && index % SEATS.length === 5 && spare.assignment
          ? `기존 배정 ${spare.assignment} 진행 중, 대체 레인 사용 불가`
          : `보고 ${Math.floor(index / SEATS.length) + 1}: ${OBSERVATIONS[scene]![index % SEATS.length]}`,
    }));
    return structuredClone({
      sceneId: SCENES[scene]!, now, triggers, orders: [...pendingOrders.values()], reports,
      workers, pullRequests: requests, memory: MEMORY, actionResults,
    });
  }

  function execute(action: OpWorldAction): Omit<OpWorldActionResult, 'action'> {
    const accepted = (detail: string) => ({ status: 'accepted' as const, detail });
    const denied = (detail: string) => ({ status: 'denied' as const, detail });
    const destination = workers.find((worker) => worker.id === action.worker);
    const activeOrder = [...pendingOrders.values()].find((order) => !order.canceled
      && (order.task === action.target || order.id === action.target));
    switch (action.type) {
      case 'report':
        return caseReportTargets && !caseReportTargets.has(action.target)
          ? denied('replay reports require an active case task ID')
          : accepted('recorded in the simulated report ledger');
      case 'hold':
        return requests.some((item) => item.id === action.target) || activeOrder
          ? accepted('recorded in the simulated hold ledger')
          : denied('hold requires an active directive or simulated PR');
      case 'assign': {
        if (!activeOrder || destination?.status !== 'ready' || destination.assignment) {
          return denied('assignment requires an active directive and an available simulated worker');
        }
        if (activeOrder.task === 'version-stamp' && requests.find((item) => item.id === 'sim-pr-build')?.state !== 'landed') {
          return denied('version stamp is blocked until the shared ffmpeg build passes');
        }
        destination.assignment = activeOrder.id;
        assignedOrders.set(activeOrder.id, activeOrder);
        pendingOrders.delete(activeOrder.id);
        return accepted('recorded in the simulated worker ledger');
      }
      case 'recover': {
        const source = workers.find((worker) => worker.id === action.target);
        if (!source?.assignment || (source.status !== 'stopped' && source.status !== 'failed')
          || destination?.status !== 'ready' || destination.assignment) {
          return denied('recovery requires a blocked assignment and an idle simulated worker');
        }
        if (!toolFailureInjected) {
          toolFailureInjected = true;
          return { status: 'retry', detail: 'injected ledger timeout; no transfer applied' };
        }
        destination.assignment = source.assignment;
        source.assignment = null;
        return accepted('assignment transferred once in the simulated worker ledger');
      }
      case 'land': {
        const item = requests.find((candidate) => candidate.id === action.target);
        if (!item || item.state !== 'open') return denied('PR is missing or already landed');
        if (item.gate.head !== item.head || item.gate.status !== 'pass'
          || item.review.head !== item.head || item.review.mustFix !== 0 || item.review.verdict === 'hold') {
          return denied('current-head passing gate and a review with no must-fix are required');
        }
        item.state = 'landed';
        return accepted('landed in the simulated PR ledger');
      }
    }
  }

  function applyActions(proposals: readonly OpWorldAction[]): readonly OpWorldActionResult[] {
    if (scene < 0) throw new Error('Advance to a simulated scene before submitting actions');
    return proposals.map((proposal) => {
      const action = structuredClone(proposal);
      if (action.type === 'assign') {
        const pending = pendingOrders.get(action.target);
        if (pending && !pending.canceled) action.target = pending.task;
      }
      if (action.type === 'assign' || action.type === 'recover') {
        const candidates = workers.filter((seat) => seat.id !== action.target && action.evidence.includes(seat.id));
        if (!action.worker && candidates.length === 1) action.worker = candidates[0]!.id;
      }
      const result = { action, ...execute(action) };
      actionResults.push(result);
      return structuredClone(result);
    });
  }

  return { nextSnapshot, applyActions };
}
