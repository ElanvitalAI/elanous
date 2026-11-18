// ── 여러 요청의 작업 분해·정정 시험 — sim(11-17 OP 4연속) + 단위 + one-active ──
import { describe, expect, test } from 'bun:test';
import {
  decomposeRequests, reconcilePlan, orderPlanTasks, enqueuePlan, selectNextActive, markTaskDone, patchTask,
  PRIORITY_RANK, MAX_ACTIVE_PLAN_ITEMS, SEQ_STEP, type DecomposedTask, type SeatTaskQueuePort, type TaskRequest,
} from './seat-task-decompose.js';

// ── sim fixture: 2026-11-17 OP 실제 4건 (원문 그대로) ──
const R1 = '새 판(a27fb5e1)·GLM Coding Plan(glm-5.3)으로 재기동. #37970 착지(a27fb5e1) 축하. 큐 WORK-QUEUE-1117.md 의 HAND-TUI-E 줄 다음 칸(ELN-SEAT-INBOX-TURN-BOUNDARY 부터 미완료분) 진행 · 칸 끝나면 바로 다음 칸.';
const R2 = '큐 계속 — WORK-QUEUE-1117.md 의 HAND-TUI-E 줄에서 아직 PR 안 낸 다음 칸 진행. (지금 턴 결과가 있으면 PR 번호·head40 먼저 eln msg post --from HAND-TUI-E --to OP.)';
const R3 = '#38007 RES 보류 — 현 main(31fd8e60)과 src/tui/seat-mail-boot.ts 충돌 + bun.lock 이 base 와 다름... origin/main merge(force 금지)·충돌 해소·bun.lock 은 main 것으로 → 시험(실제 출력) → 새 head OP 우편.';
const R4 = 'ELN-SEAT-TURN-PACING 은 D 도 #38013(main 위)으로 냈고 OP 가 하나로 정리 → 네 #38012 닫음(중복). ... 너는 #38007 보류 대응 + 큐 다음 칸 ELN-TASK-DECOMPOSE-MULTI-REQUEST.';

const req = (id: string, text: string, receivedAt: number, interrupt = false, context?: { nextBoard?: string }): TaskRequest =>
  ({ id, text, receivedAt, interrupt, context });

// R2 «다음 칸» — 11-17 당시 WORK-QUEUE HAND-TUI-E 줄에서 아직 PR 안 낸 칸 = ELN-SEAT-INBOX-TURN-BOUNDARY
// (그 PR #38007 이 R3 에서 RES 보류됨). 배선이 큐 상태에서 이렇게 해석해 넘겼다고 보는 것.
const R2_CTX = { nextBoard: 'ELN-SEAT-INBOX-TURN-BOUNDARY' };

// 11-17 이전 이 자리 진행 중 작업 — R4 에서 «중복 #38013» 취소되는 TURN-PACING.
function plan0(): DecomposedTask[] {
  return [{
    id: 'P0:pacing', seq: 0, title: '칸 ELN-SEAT-TURN-PACING 진행', priority: 'normal', deps: [],
    sourceRequestId: 'P0', sourceText: '(11-17 이전 인터럽트 진행 중) 칸 ELN-SEAT-TURN-PACING 진행',
    status: 'active', targets: ['ELN-SEAT-TURN-PACING'],
  }];
}

// ── 단위: 분해 ──

describe('decomposeRequests 단위', () => {
  test('문장 단위 분해 · 인사/축하 줄은 작업으로 만들지 않는다', () => {
    const r = decomposeRequests([req('r', '#37970 착지(a27fb5e1) 축하. 큐 WORK-QUEUE-1117.md 의 HAND-TUI-E 줄 다음 칸(ELN-SEAT-INBOX-TURN-BOUNDARY 부터 미완료분) 진행.', 1)]);
    expect(r.tasks.length).toBe(1);
    expect(r.tasks[0]!.title).toBe('칸 ELN-SEAT-INBOX-TURN-BOUNDARY 진행');
    expect(r.notes.some(n => n.includes('축하'))).toBe(true);
  });

  test('«칸 끝나면 바로 다음 칸» → 정책 작업 + 선행 진행 작업 dep', () => {
    const r = decomposeRequests([req('r', R1, 1)]);
    expect(r.tasks.length).toBe(2);
    const policy = r.tasks.find(t => t.title.startsWith('정책:'))!;
    expect(policy.title).toBe('정책: 칸 완료 시 바로 다음 칸 자동');
    expect(policy.deps.length).toBe(1);
  });

  test('«먼저» 지시 — 뒤 작업 dep + priority p0', () => {
    const r = decomposeRequests([req('r', R2, 1, false, R2_CTX)]);
    const report = r.tasks.find(t => t.title.startsWith('보고:'))!;
    const proceed = r.tasks.find(t => t.title.startsWith('칸 '))!;
    expect(report.priority).toBe('p0');
    expect(proceed.deps).toContain(report.id);
  });

  test('msg post 문장은 보고 작업 — 대상(--to)·내용 추출', () => {
    const r = decomposeRequests([req('r', R2, 1, false, R2_CTX)]);
    const report = r.tasks.find(t => t.title.startsWith('보고:'))!;
    expect(report.title).toBe('보고: PR 번호·head40 → OP');
  });

  test('인터럽트 요청 urgent + reconcile 대상 notes', () => {
    const r = decomposeRequests([req('r', R3, 1, true)]);
    const prTask = r.tasks.find(t => (t.targets ?? []).includes('#38007'));
    expect(prTask).toBeDefined();
    expect(prTask!.priority).toBe('urgent');
    expect(r.notes.some(n => n.startsWith('인터럽트'))).toBe(true);
  });

  test('«보류» — 같은 묶음에 그 대상 대응 작업이 있으면 취소 아님(정정) notes', () => {
    const r = decomposeRequests([req('r', R3, 1, true)]);
    expect(r.cancellations.length).toBe(0);
    expect(r.notes.some(n => n.includes('#38007 보류 — 같은 묶음에 대응 작업 있음'))).toBe(true);
  });

  test('«중복» 지시 — 취소 후보는 키워드에 붙은 대상만(가리킴 제외)', () => {
    const r = decomposeRequests([req('r', R4, 1)]);
    expect(r.cancellations.some(c => c.target === '#38012')).toBe(true); // «#38012 닫음» — 직접 수식
    expect(r.cancellations.some(c => c.target === '#38013')).toBe(false); // «#38013(main 위)으로 냈고» — 가리킴만
    expect(r.tasks.length).toBe(2); // TURN-PACING 취소 문장 + 다음 칸 지시(칸 작업)
  });
});

// ── sim: 11-17 OP 4연속 재생 ──

describe('sim 11-17 OP 4연속', () => {
  test('R1 — 칸 진행 + 칸 완료 시 다음 칸 정책 · 원문 보존', () => {
    const r = decomposeRequests([req('R1', R1, 1)]);
    expect(r.tasks.map(t => t.title)).toEqual([
      '칸 ELN-SEAT-INBOX-TURN-BOUNDARY 진행',
      '정책: 칸 완료 시 바로 다음 칸 자동',
    ]);
    for (const t of r.tasks) {
      expect(t.sourceText).toBe(R1);
      expect(t.sourceRequestId).toBe('R1');
    }
  });

  test('R2 — 보고 p0 + 다음 미PR 칸 진행 · R1 칸 작업 유지(대체)', () => {
    const r1 = decomposeRequests([req('R1', R1, 1)]);
    const r2 = decomposeRequests([req('R2', R2, 2, false, R2_CTX)]);
    expect(r2.tasks.map(t => t.title)).toEqual(['칸 ELN-SEAT-INBOX-TURN-BOUNDARY 진행', '보고: PR 번호·head40 → OP']);
    // «먼저» — 진행 작업이 보고 작업 뒤로(dep) · 보고는 p0
    const report2 = r2.tasks.find(t => t.title.startsWith('보고:'))!;
    expect(r2.tasks.find(t => t.title.startsWith('칸 '))!.deps).toContain(report2.id);
    expect(report2.priority).toBe('p0');
    const rev2 = reconcilePlan(orderPlanTasks(r1.tasks).map(activeify), r2);
    expect(rev2.kept.find(t => t.title === '칸 ELN-SEAT-INBOX-TURN-BOUNDARY 진행')).toBeDefined();
    expect(rev2.kept.find(t => t.title.startsWith('보고:'))!.priority).toBe('p0');
    expect(rev2.superseded.length).toBe(1);
    expect(rev2.superseded[0]!.supersededBy).toBeDefined();
    expect(rev2.reportLine).toContain('PR 번호·head40 → OP 추가');
  });

  test('R3 — 진행 칸 일시 중지 + #38007 urgent 신규 · 원문 보존', () => {
    const rev3 = reconcilePlan(planAfter2().map(activeify), res3());
    const pause = rev3.rescheduled.find(t => t.title === '칸 ELN-SEAT-INBOX-TURN-BOUNDARY 진행');
    expect(pause).toBeDefined();
    // 기대값 유도: reschedule deps = 이 요청(res3)의 urgent 태스크 id 목록
    const urgentIds = res3().tasks.filter(t => t.priority === 'urgent').map(t => t.id);
    expect(pause!.deps).toEqual(urgentIds);
    const prTask = rev3.kept.find(t => (t.targets ?? []).includes('#38007'));
    expect(prTask).toBeDefined();
    expect(prTask!.priority).toBe('urgent');
    expect(prTask!.title).toBe('#38007 merge·충돌 해소·시험·보고');
    expect(prTask!.sourceText).toBe(R3);
    expect(rev3.cancelled.length).toBe(0);
  });

  test('R4 — TURN-PACING 취소(중복 #38013) · #38007 유지 · TASK-DECOMPOSE 추가 · reportLine 한 줄', () => {
    const rev4 = reconcilePlan(planAfter3(), decomposeRequests([req('R4', R4, 4, true)]));
    // 기대값 유도: planAfter3() 시점 TURN-PACING 진행 작업 전부가 취소 대상(id 일치 · status 는 취소로 전이)
    const pacingIds = planAfter3().filter(t => (t.targets ?? []).includes('ELN-SEAT-TURN-PACING')).map(t => t.id);
    expect(rev4.cancelled.filter(t => (t.targets ?? []).includes('ELN-SEAT-TURN-PACING')).map(t => t.id)).toEqual(pacingIds);
    expect(rev4.cancelled.filter(t => (t.targets ?? []).includes('ELN-SEAT-TURN-PACING')).every(t => t.status === 'cancelled')).toBe(true);
    expect(rev4.reportLine).toContain('TURN-PACING 취소(중복 #38013)');
    expect(rev4.kept.find(t => (t.targets ?? []).includes('#38007'))).toBeDefined();
    const newBoard = rev4.kept.find(t => (t.targets ?? []).includes('ELN-TASK-DECOMPOSE-MULTI-REQUEST'));
    expect(newBoard).toBeDefined();
    expect(newBoard!.sourceText).toBe(R4);
    expect(rev4.reportLine).toContain('TASK-DECOMPOSE 추가');
    expect(rev4.reportLine.split('\n').length).toBe(1);
  });

  test('mustFix — «#38013(main 위)으로 냈고 … #38012 닫음(중복)» 정본 #38013 은 취소 안 됨(불변식 10)', () => {
    // #38013 정본 작업이 포함된 계획 + R4 발화 — 발화 파싱만으로 가리킴 대상 #38013 이 취소되지 않는다.
    const canonSeq = Math.max(...planAfter3().map(t => t.seq)) + SEQ_STEP;
    const canon: DecomposedTask = {
      id: 'P0:canon', seq: canonSeq, title: '#38013 merge·시험·보고', priority: 'normal', deps: [],
      sourceRequestId: 'P0', sourceText: '정본 #38013 작업', status: 'queued', targets: ['#38013'],
    };
    const rev = reconcilePlan([...planAfter3(), canon], decomposeRequests([req('R4', R4, 4, true)]));
    expect(rev.cancelled.some(t => (t.targets ?? []).includes('#38013'))).toBe(false);
    expect(rev.kept.find(t => t.id === canon.id)!.status).not.toBe('cancelled');
    // 후보 수집 자체가 «붙은» 대상만: 닫힌 중복 #38012(«#N 닫음») 은 후보, 정본 #38013 은 가리킴이라 제외.
    const r4 = decomposeRequests([req('R4', R4, 4, true)]);
    expect(r4.cancellations.some(c => c.target === '#38012')).toBe(true);
    expect(r4.cancellations.some(c => c.target === '#38013')).toBe(false);
  });
});

// ── ELN-PLAN-ONE-ACTIVE — status(done·superseded)·seq·«active 하나»·다음 active 선택 ──

describe('ELN-PLAN-ONE-ACTIVE', () => {
  test('status 전이 — markTaskDone 은 해당 작업만 done, 나머지·원문·seq 불변 · 근거 필수(불변식 9)', () => {
    const base = planAfter2();
    const target = base.find(t => t.title.startsWith('보고:')) ?? base[0]!;
    // 근거 없으면 done 전이 거부(throw)
    expect(() => markTaskDone(base, target.id, ' ')).toThrow();
    const after = markTaskDone(base, target.id, "시험 통과 영수증 r-1");
    expect(after.find(t => t.id === target.id)!.status).toBe('done');
    expect(after.find(t => t.id === target.id)!.doneEvidence).toBe("시험 통과 영수증 r-1");
    expect(after.filter(t => t.status === 'done').map(t => t.id)).toEqual([target.id]);
    expect(after.find(t => t.id === target.id)!.seq).toBe(target.seq);
    expect(after.find(t => t.id === target.id)!.sourceText).toBe(target.sourceText);
  });

  test('patchTask — 항목 단위 패치: seq·원문·근거 불변 · 종결 항목 패치 거부', () => {
    const base = planAfter2();
    const target = base[0]!;
    const patched = patchTask(base, target.id, { title: '칸 ELN-SEAT-INBOX-TURN-BOUNDARY 진행(보류 대응 포함)', priority: 'p0' });
    const got = patched.find(t => t.id === target.id)!;
    expect(got.title).toBe('칸 ELN-SEAT-INBOX-TURN-BOUNDARY 진행(보류 대응 포함)');
    expect(got.priority).toBe('p0');
    expect(got.seq).toBe(target.seq);
    expect(got.sourceText).toBe(target.sourceText);
    // 종결 항목은 패치 거부
    const donePlan = markTaskDone(base, target.id, "merge 영수증 #38013");
    expect(() => patchTask(donePlan, target.id, { title: '바꾼 제목' })).toThrow();
  });

  test('reconcilePlan — 종결된 대상의 새 지시는 대체 아니라 신규 추가(수명 이어감)', () => {
    const donePlan = markTaskDone(plan0(), 'P0:pacing', "merge 영수증 #38013");
    const r = decomposeRequests([req('R5', '칸 ELN-SEAT-TURN-PACING 진행', 5)]);
    const rev = reconcilePlan(donePlan, r);
    expect(rev.superseded.length).toBe(0);
    expect(rev.kept.find(t => t.targets?.includes('ELN-SEAT-TURN-PACING') && t.status === 'queued')).toBeDefined();
    expect(rev.kept.find(t => t.id === 'P0:pacing')!.status).toBe('done');
  });

  test('대체(superseded) — 종결 아닌 host 만 흡수 · 원문 둘 다 보존', () => {
    const rev2 = reconcilePlan(orderPlanTasks(decomposeRequests([req('R1', R1, 1)]).tasks), decomposeRequests([req('R2', R2, 2, false, R2_CTX)]));
    expect(rev2.superseded.length).toBe(1);
    const sup = rev2.superseded[0]!;
    const host = rev2.kept.find(t => t.id === sup.supersededBy)!;
    expect(sup.status).toBe('superseded');
    expect(sup.sourceText).toBe(R2);
    expect(host.sourceText).toBe(R1);
  });

  test('seq — 신규 작업은 기존 최대 seq 뒤에 단조 부여, 대체·취소로 다시 매기지 않음', () => {
    const plan = planAfter2();
    const r5 = decomposeRequests([req('R5', '칸 ELN-SEAT-TURN-PACING 진행 · #38012 닫음', 5)]);
    const rev = reconcilePlan(plan, r5);
    const keptAlive = rev.kept;
    const maxExistingSeq = Math.max(...plan.map(t => t.seq));
    // 기대값 유도: 추가된(added) 작업의 seq 는 maxExistingSeq+1 부터 연속
    const addedSeqs = keptAlive.filter(t => t.seq > maxExistingSeq).map(t => t.seq);
    expect(addedSeqs).toEqual(Array.from({ length: addedSeqs.length }, (_, i) => maxExistingSeq + 1 + i));
    // 기존 작업 seq 불변
    for (const ex of plan) {
      const still = keptAlive.find(t => t.id === ex.id) ?? rev.cancelled.find(t => t.id === ex.id);
      expect(still!.seq).toBe(ex.seq);
    }
  });

  test('«active 하나» — reconcile 후 active ≤ 1 (초과분 대기 복귀 · reportLine 고지)', () => {
    // 두 active 가 섞인 플랜(위반 시뮬레이션)에 새 요청 정정 → 1개만 active
    const two = planAfter2().map((t, i) => ({ ...t, status: i === 0 ? ('active' as const) : t.status }));
    const bothActive = two.map(t => t.id === two[1]!.id ? { ...t, status: 'active' as const } : t);
    const r5 = decomposeRequests([req('R5', '큐 계속 — 다음 칸 진행', 5)]);
    const rev = reconcilePlan(bothActive, r5);
    const alive = [...rev.kept, ...rev.rescheduled];
    expect(alive.filter(t => t.status === 'active').length).toBeLessThanOrEqual(MAX_ACTIVE_PLAN_ITEMS);
    expect(rev.reportLine).toContain('active 초과분 대기 복귀');
  });

  test('selectNextActive — 의존 충족 → urgent>p0>normal → seq', () => {
    const r2 = decomposeRequests([req('R2', R2, 2, false, R2_CTX)]);
    // 보고(p0)가 «먼저» — 칸 작업은 보고 뒤(dep). 보고부터 선택된다.
    const next = selectNextActive(orderPlanTasks(r2.tasks));
    expect(next!.title.startsWith('보고:')).toBe(true);
    // 보고를 종결하면 이제 칸 작업이 후보로 풀린다
    const afterReport = markTaskDone(r2.tasks, next!.id, "우편 #81502 발송 영수증");
    expect(selectNextActive(afterReport)!.title.startsWith('칸 ')).toBe(true);
  });

  test('selectNextActive — 의존 미충족(선행 queued)이면 선택 안 됨', () => {
    const r2 = decomposeRequests([req('R2', R2, 2, false, R2_CTX)]);
    const boardTask = r2.tasks.find(t => t.title.startsWith('칸 '))!;
    const reportTask = r2.tasks.find(t => t.title.startsWith('보고:'))!;
    // 선행(보고)이 계획 안에 queued 로 남아 있으면 칸 작업은 미충족 — 보고가 선택된다
    expect(selectNextActive([boardTask, reportTask])!.id).toBe(reportTask.id);
    // 선행을 종결하면 칸 작업이 풀린다(아래 toBe 는 픽스처 boardTask.id 유도값)
    expect(selectNextActive([boardTask, markTaskDone(r2.tasks, reportTask.id, "보고 우편 영수증").find(t => t.id === boardTask.id)!])!.id).toBe(boardTask.id);
  });

  test('selectNextActive — 같은 priority 면 seq 이른 것', () => {
    const mk = (id: string, seq: number): DecomposedTask => ({
      id, seq, title: `t${id}`, priority: 'normal', deps: [], sourceRequestId: 'r', sourceText: '', status: 'queued',
    });
    expect(selectNextActive([mk('a', 3), mk('b', 1)])?.id).toBe('b');
  });

  test('one-active 전 사이클 — 완료 → 다음 선택 → 재완료, 항상 active ≤ 1', () => {
    let plan = orderPlanTasks(decomposeRequests([req('R1', R1, 1)]).tasks)
      .map((t, i) => (i === 0 ? activeify(t) : t));
    let guard = 0;
    while (plan.some(t => t.status !== 'done' && t.status !== 'cancelled' && t.status !== 'superseded')) {
      const activeNow = plan.filter(t => t.status === 'active');
      expect(activeNow.length).toBeLessThanOrEqual(MAX_ACTIVE_PLAN_ITEMS);
      const cur = activeNow[0] ?? selectNextActive(plan);
      expect(cur).toBeDefined();
      plan = markTaskDone(plan, cur!.id, `사이클 근거 ${cur!.title}`);
      const nextActive = selectNextActive(plan);
      if (nextActive) plan = plan.map(t => (t.id === nextActive.id ? { ...t, status: 'active' as const } : t));
      if (++guard > 10) throw new Error('one-active 사이클 무한 루프');
    }
    expect(plan.every(t => t.status === 'done' || t.status === 'cancelled' || t.status === 'superseded')).toBe(true);
  });

  test('enqueuePlan — 종결(done) 작업은 등재 제외', () => {
    const r1 = decomposeRequests([req('R1', R1, 1)]);
    const r2 = decomposeRequests([req('R2', R2, 2, false, R2_CTX)]);
    const rev = reconcilePlan(r1.tasks, r2);
    const done = markTaskDone(rev.kept, rev.kept[0]!.id, "merge 영수증 시험 r-2");
    const enq: DecomposedTask[] = [];
    const queue: SeatTaskQueuePort = { enqueue: t => void enq.push(t), snapshot: () => enq };
    const ordered = enqueuePlan(queue, { ...rev, kept: done });
    expect(ordered.every(t => t.status !== 'done')).toBe(true);
    expect(ordered.some(t => t.id === rev.kept[0]!.id)).toBe(false);
  });
});

// ── 정렬·등재 ──

describe('orderPlanTasks / enqueuePlan', () => {
  test('urgent > p0 > normal · dep 먼저', () => { urgentCheck(); });
  function urgentCheck(): void {
    const a: DecomposedTask = { id: 'a', seq: 0, title: '일반', priority: 'normal', deps: [], sourceRequestId: 'r', sourceText: '', status: 'queued' };
    const b: DecomposedTask = { id: 'b', seq: 1, title: '긴급', priority: 'urgent', deps: [], sourceRequestId: 'r', sourceText: '', status: 'queued' };
    const c: DecomposedTask = { id: 'c', seq: 2, title: 'p0', priority: 'p0', deps: ['a'], sourceRequestId: 'r', sourceText: '', status: 'queued' };
    expect(orderPlanTasks([a, b, c]).map(t => t.id)).toEqual(['b', 'a', 'c']);
  }

  test('enqueuePlan — 큐 등재 + 우선순위 순', () => {
    const r1 = decomposeRequests([req('R1', R1, 1)]);
    const r2 = decomposeRequests([req('R2', R2, 2, false, R2_CTX)]);
    const rev = reconcilePlan(r1.tasks, r2);
    const enq: DecomposedTask[] = [];
    const queue: SeatTaskQueuePort = { enqueue: t => void enq.push(t), snapshot: () => enq };
    const ordered = enqueuePlan(queue, rev);
    expect(ordered.length).toBe(3);
    expect(queue.snapshot().length).toBe(3);
  });
});

// ── helpers ──

function res3() { return decomposeRequests([req('R3', R3, 3, true)]); }

function activeify(t: DecomposedTask): DecomposedTask { return { ...t, status: 'active' }; }

function planAfter2(): DecomposedTask[] {
  const r1 = decomposeRequests([req('R1', R1, 1)]);
  return reconcilePlan(reconcilePlan(plan0(), r1).kept, decomposeRequests([req('R2', R2, 2, false, R2_CTX)])).kept;
}

function planAfter3(): DecomposedTask[] {
  const rev3 = reconcilePlan(planAfter2().map(activeify), res3());
  return [...rev3.kept, ...rev3.rescheduled];
}

test('urgent marks: the red mark and the two urgent words make a request urgent, plain text does not (same set as the old regex)', () => {
  const expected: [string, boolean][] = [['🔴 진행 부탁', true], ['지금 충돌 해소 진행', true], ['긴급 건 처리', true], ['일반 요청 진행', false]];
  for (const [text, urgent] of expected) {
    const r = decomposeRequests([req('r', text, 1)]);
    expect([text, r.tasks.some((task) => task.priority === 'urgent')]).toEqual([text, urgent]);
  }
});
