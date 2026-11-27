// ── SEAT-WORK-PULL 배선층 (OP #139787 · 0.3.35 P0) ──
// 자리가 IDLE 이고 맡은 일이 없으면: 로스터 큐에서 다음 칸을 당겨 그 칸 본문·판정식과 함께
// 턴을 연다. 칸 본문은 큐 노티스(source 'work-pull')로, 턴 개시는 idle 문(queueWake) inject 로.
// «일감 0» 은 큐 조회 결과 근거 줄로만 — 노티스·inject 없이 상태 카드행으로 돌아간다.
//
// KNOCK-USES-WORK-NEXT (OP 11-25 20:4x): 당기기는 `eln work next` 와 같은 함수 하나다 — workNext(seat,
// liveWorkNextDeps(seat)). 옛 유닛층(seat-loop/work-pull.ts · «내 칸·주인 없음» 만 보던 별도 큐 조회)은 지웠다:
// 리더 보유 칸·타 스페이스 P0 풀·판정 자리 분리·막힘 칸 재제안이 노크에도 그대로 적용된다.
// 이 모듈은 그 결과를 TUI 큐·idle 문에 잇는 배선일 뿐이고, 감시 지점(entry.ts idle 문 옆)에서 만들어 idle 마다 부른다.

import { listChecklist } from '../release-loop/checklist.js';
import { activeBoardVersion } from '../ops-dashboard/current-version.js';
import { workNext, type WorkNextDeps, type WorkNextResult } from '../steward/space/work-next.js';
import { liveWorkNextDeps } from '../steward/space/work-next-cli.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { wireWorkPullKnock, type PullGateVerdict } from './work-pull-knock.js';

/** 판 칸의 얇은 모양 — goal-drive(handCellState)·ledgerFingerprint 가 읽는다. */
export interface WorkCell { id: string; title: string; status: string; owner: string | null; priority: string }

/** 노크 pull 결과 — claimed(턴을 여는 칸 본문) | no-work(work-next 근거 줄). */
export type KnockPullResult =
  | { kind: 'claimed'; wip?: true; cell: { id: string }; turnOpensWith: string }
  | { kind: 'no-work'; evidence: string };

export interface SeatWorkPullDeps {
  /** 당기는 자리. */
  seat: string;
  /** 자리가 바쁜지 — busy 면 당기지 않는다(SEAT-OPERATING-CONTRACT: 진행 중 턴은 스스로 지킨다). */
  busy: () => boolean;
  /** pull 구현(주입용) — 없으면 workNext(seat, workNextDeps(seat)). */
  pull?: (seat: string) => KnockPullResult;
  /** work-next deps 공급(시험 우주 주입) — 없으면 `eln work next` 와 같은 liveWorkNextDeps. */
  workNextDeps?: (seat: string) => WorkNextDeps;
  /** WIP-CONTINUE 15 분 기록(시험 주입) — 없으면 상태 루트 파일. */
  wipStore?: WipKnockStore;
  now?: () => number;
  /** 큐 노티스 삽입 — entry.ts 의 queue.enqueueNotice. */
  enqueueNotice: (text: string, source: 'work-pull') => unknown;
  /** idle 문 두드리기 — entry.ts 의 injectKey. */
  injectKey: (key: unknown) => void;
  /** idle 문 키 — entry.ts 의 queueWake 센티널(객체 정체성으로 문을 식별). */
  queueWake: unknown;
}

/** 현재 판 → WorkCell 매핑(owner 없음=null · priority 없음=P2 · 판 읽기 실패 시 빈 배열). */
export function checklistCells(): WorkCell[] {
  try {
    return listChecklist(activeBoardVersion()).items.map((item) => ({
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

/** WIP-CONTINUE — one internal «continue your cell» turn per cell per 15 min (persisted across restarts). */
export const WIP_CONTINUE_EVERY_MS = 15 * 60_000;

/** Persisted «last wip-continue knock» per seat·cell — `<state>/steward/wip-continue-knocks.json`. */
export interface WipKnockStore { readonly last: (key: string) => number | undefined; readonly mark: (key: string, at: number) => void }

export function fileWipKnockStore(path = join(effectiveInstanceRoot(), 'steward', 'wip-continue-knocks.json')): WipKnockStore {
  const read = (): Record<string, number> => { try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>; } catch { return {}; } };
  return {
    last: (key) => { const v = read()[key]; return typeof v === 'number' ? v : undefined; },
    mark: (key, at) => {
      const rows = read(); rows[key] = at;
      for (const k of Object.keys(rows)) if (at - rows[k]! > 24 * 3_600_000) delete rows[k];
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(rows)); renameSync(`${path}.tmp`, path);
    },
  };
}

export const wipContinueTurn = (cellId: string, line: string): string =>
  `[SEAT-WORK-PULL · wip-continue] continue your cell ${cellId}: take the next step toward its done-when. `
  + `If it is already done on main (PR merged / evidence exists) close it green with that evidence. `
  + `If it is blocked → \`eln work block ${cellId} --on <seat> --reason <why>\` then \`eln work next\`. (${line})`;

/**
 * work-next 결과 → 노크 결과. code 0 = 새 claim · code 4 = 내 ACTIVE 칸(WIP 1) — idle 이면 «계속» 턴 하나,
 * 같은 자리·칸은 15 분에 한 번(영속) · code 3 = «일감 0» ⊕ work-next 근거 분해.
 */
export function knockResultOf(r: WorkNextResult, seat: string, wip: { store: WipKnockStore; now: number }): KnockPullResult {
  if (r.code === 0) {
    const lend = r.lentTo ? ` · pool.lend → ${r.lentTo}` : '';
    return { kind: 'claimed', cell: { id: r.cell.id }, turnOpensWith: `[SEAT-WORK-PULL · eln work next] ${r.line}${lend}` };
  }
  if (r.code === 4) {
    const key = `${seat.toUpperCase()}:${r.cell.id}`;
    let last: number | undefined;
    try { last = wip.store.last(key); } catch { last = undefined; }
    if (last !== undefined && wip.now - last < WIP_CONTINUE_EVERY_MS) return { kind: 'no-work', evidence: `${r.line} (wip-continue knocked ${Math.round((wip.now - last) / 60_000)} min ago)` };
    try { wip.store.mark(key, wip.now); } catch { /* an unwritable store only risks one extra knock */ }
    return { kind: 'claimed', wip: true, cell: { id: r.cell.id }, turnOpensWith: wipContinueTurn(r.cell.id, r.line) };
  }
  return { kind: 'no-work', evidence: r.breakdown ? `${r.line} — ${r.breakdown}` : r.line };
}

/**
 * 배선 팩토리 — 반환된 함수를 자리 idle 감시 지점에서 부른다.
 * busy → null(당기지 않음). claimed → 칸 본문 노티스 + queueWake inject 1회. no-work → 근거 줄.
 */
export function createSeatWorkPull(deps: SeatWorkPullDeps): () => { claimed: string; wip?: true } | { noWork: string } | null {
  const pull = deps.pull ?? ((seat: string) => knockResultOf(workNext(seat, (deps.workNextDeps ?? liveWorkNextDeps)(seat)), seat,
    { store: deps.wipStore ?? fileWipKnockStore(), now: (deps.now ?? Date.now)() }));
  return () => {
    if (deps.busy()) return null;
    let result: KnockPullResult;
    try { result = pull(deps.seat); } catch (error) { return { noWork: `일감 조회 실패 — ${error instanceof Error ? error.message : String(error)}` }; }
    if (result.kind === 'claimed') {
      deps.enqueueNotice(result.turnOpensWith, 'work-pull');
      deps.injectKey(deps.queueWake);
      return result.wip ? { claimed: result.cell.id, wip: true } : { claimed: result.cell.id };
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
  /** PULL-KNOCK-HAND-GATE — 있으면 이 판정이 문을 연다(사람 턴 ∨ 턴 끝남 ∨ 손 자리 90 s 정착). entry.ts 가 boot-wake 와 같은 판정을 준다. */
  readonly gate?: () => PullGateVerdict;
  /** 큐 노티스 삽입 — entry.ts 가 queue.enqueueNotice(text, 'work-pull', …) 로 닫는다(source 는 여기 고정). */
  readonly enqueueNotice: (text: string) => unknown;
  readonly injectKey: (key: unknown) => void;
  readonly queueWake: unknown;
  /** 시험 주입 — 유닛층 pull·판 읽기·claim DB 격리 교체. */
  readonly pullDeps?: Partial<Pick<SeatWorkPullDeps, 'pull' | 'workNextDeps' | 'wipStore' | 'now'>>;
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
    ...(deps.gate === undefined ? {} : { gate: deps.gate }),
    intervalMs: deps.intervalMs,
    schedule: deps.schedule,
    log: deps.log,
  });
}
