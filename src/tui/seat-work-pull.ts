// ── SEAT-WORK-PULL 배선층 (OP #139787 · 0.3.35 P0) ──
// 자리가 IDLE 이고 맡은 일이 없으면: 로스터 큐에서 다음 칸을 당겨 그 칸 본문·판정식과 함께
// 턴을 연다. 칸 본문은 큐 노티스(source 'work-pull')로, 턴 개시는 idle 문(queueWake) inject 로.
// «일감 0» 은 큐 조회 결과 근거 줄로만 — 노티스·inject 없이 상태 카드행으로 돌아간다.
//
// 큐 소스·claim 원자성은 유닛층(src/seat-loop/work-pull.ts — GREEN 커밋)이 책임진다:
// pullNextCellFor(seat, cells, {db, now, spaceOfSeat}) — 정렬(owner=자리 → 주인 없음 · 같은 스페이스
// 순 → 우선순위) 후 INSERT … ON CONFLICT DO NOTHING 원자 claim. 이 모듈은 그 결과를
// TUI 큐·idle 문에 잇는 배선일 뿐이고, 감시 지점(entry.ts idle 문 옆)에서 만들어 idle 마다 부른다.

import { checklistDevVersion, listChecklist } from '../release-loop/checklist.js';
import { pullNextCellFor, workClaimDbPath, type WorkCell, type WorkPullResult } from '../seat-loop/work-pull.js';
import { wireWorkPullKnock } from './work-pull-knock.js';

export interface SeatWorkPullDeps {
  /** 당기는 자리 — 큐 정렬(owner=자리)의 키. */
  seat: string;
  /** 자리가 바쁜지 — busy 면 당기지 않는다(SEAT-OPERATING-CONTRACT: 진행 중 턴은 스스로 지킨다). */
  busy: () => boolean;
  /** 큐 소스(주입용) — 없으면 현재 판 checklist 에서 읽는다. */
  readChecklist?: () => WorkCell[];
  /** pull 구현(주입용) — 없으면 유닛층 pullNextCellFor 원본. */
  pull?: (seat: string, cells: WorkCell[]) => WorkPullResult;
  /** 큐 노티스 삽입 — entry.ts 의 queue.enqueueNotice. */
  enqueueNotice: (text: string, source: 'work-pull') => unknown;
  /** idle 문 두드리기 — entry.ts 의 injectKey. */
  injectKey: (key: unknown) => void;
  /** idle 문 키 — entry.ts 의 queueWake 센티널(객체 정체성으로 문을 식별). */
  queueWake: unknown;
  /** claim DB 격리(stateRoot — 시험 우주가 준다). 없으면 기본 인스턴스 루트. */
  stateRoot?: string;
  /** 자리의 스페이스 소속 — «같은 스페이스 순» 정렬 키(선택). */
  spaceOfSeat?: string | null;
  now?: () => number;
}

/** 현재 판 → WorkCell 매핑(owner 없음=null · priority 없음=P2 · 판 읽기 실패 시 빈 큐 = fail-open «일감 0»). */
export function checklistCells(): WorkCell[] {
  try {
    return listChecklist(checklistDevVersion()).items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      owner: item.owner ?? null,
      priority: item.priority ?? 'P2',
    }));
  } catch {
    return [];
  }
}

/**
 * 배선 팩토리 — 반환된 함수를 자리 idle 감시 지점에서 부른다.
 * busy → null(당기지 않음). claimed → 칸 본문 노티스 + queueWake inject 1회. no-work → 근거 줄.
 */
export function createSeatWorkPull(deps: SeatWorkPullDeps): () => { claimed: string } | { noWork: string } | null {
  return () => {
    if (deps.busy()) return null;
    const cells = deps.readChecklist ? deps.readChecklist() : checklistCells();
    const pull = deps.pull ?? ((seat: string, cs: WorkCell[]) =>
      pullNextCellFor(seat, cs, {
        db: workClaimDbPath(deps.stateRoot === undefined ? {} : { stateRoot: deps.stateRoot }),
        now: deps.now === undefined ? Date.now() : deps.now(),
        spaceOfSeat: deps.spaceOfSeat ?? null,
      }));
    const result = pull(deps.seat, cells);
    if (result.kind === 'claimed') {
      deps.enqueueNotice(result.turnOpensWith, 'work-pull');
      deps.injectKey(deps.queueWake);
      return { claimed: result.cell.id };
    }
    return { noWork: result.evidence };
  };
}

/** 마운트 deps — entry.ts 탑재 지점이 닫는 값들(시험은 pullDeps 로 유닛층만 교체 주입). */
export interface SeatWorkPullMountDeps {
  /** detectSeat 결과 — null(자리 아님)이면 마운트 자체를 안 한다(사람 대화 TUI 는 당기지 않는다). */
  readonly seat: string | null;
  readonly busy: () => boolean;
  /** SEAT-NOTICE-BOOT-RACE — 자리 사람의 첫 턴 전엔 pull 조차 부르지 않는다(노크층 게이트와 같은 규칙). */
  readonly personTurnStarted: () => boolean;
  /** 큐 노티스 삽입 — entry.ts 가 queue.enqueueNotice(text, 'work-pull', …) 로 닫는다(source 는 여기 고정). */
  readonly enqueueNotice: (text: string) => unknown;
  readonly injectKey: (key: unknown) => void;
  readonly queueWake: unknown;
  /** 시험 주입 — 유닛층 pull·판 읽기·claim DB 격리 교체. */
  readonly pullDeps?: Partial<Pick<SeatWorkPullDeps, 'readChecklist' | 'pull' | 'stateRoot' | 'spaceOfSeat'>>;
  readonly intervalMs?: number;
  readonly schedule?: (fire: () => void, intervalMs: number) => () => void;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * entry.ts 탑재 조립(part 4 · OP #139787): 배선층 pull(createSeatWorkPull) + 주기 노크(wireWorkPullKnock)를
 * 한 번에 묶는다. 반환은 stop(해제) — 자리가 아니면 null(아무 배선도 없음). busy/claimed/no-work 해석은
 * 배선층이, 사람 첫 턴 게이트와 주기는 노크층이 맡는다.
 */
export function mountSeatWorkPull(deps: SeatWorkPullMountDeps): (() => void) | null {
  if (deps.seat === null) return null;
  const pull = createSeatWorkPull({
    seat: deps.seat,
    busy: deps.busy,
    enqueueNotice: (text, _source) => deps.enqueueNotice(text),
    injectKey: deps.injectKey,
    queueWake: deps.queueWake,
    ...(deps.pullDeps ?? {}),
  });
  return wireWorkPullKnock({
    pull,
    personTurnStarted: deps.personTurnStarted,
    intervalMs: deps.intervalMs,
    schedule: deps.schedule,
    log: deps.log,
  });
}
