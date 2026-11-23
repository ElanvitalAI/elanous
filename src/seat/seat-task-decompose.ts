// ── 여러 요청의 작업 분해·정정 `seat-task-decompose` (ELN-TASK-DECOMPOSE-MULTI-REQUEST · 2026-11-17) ──
//
// 🚨 무엇을 푸는가: 자리에 여러 요청이 한꺼번에·인터럽트로 연달아 오면(11-17 OP 4연속 지시가 원형),
//   «무엇을 먼저·무엇을 취소·무엇을 기존 작업과 합칠지»가 우편 글 안에만 흩어진다. 이 모듈은
//   요청 묶음을 사람이 읽는 작업 단위로 분해하고(의존·우선순위·충돌), 진행 중 계획과 새 요청을
//   정정(reconcile)해 «바뀐 점 한 줄(reportLine)»로 남긴다.
// ⭐ 원문 보존: DecomposedTask.sourceText 는 그 요청의 전문 그대로 — 요약·잘라내기 금지.
//   대체(superseded)돼도 대체 주체(host)·대체된 작업 둘 다 각자 원문을 지닌다.
// ⛔ 순수 판정 모듈 — 원장·TUI·큐 구현체 의존 0(임포트 0). 큐는 SeatTaskQueuePort 인터페이스만
//   정의한다(배선은 seat-mail-boot · 우선순위 관례는 src/tui/seat-work-queue.ts 왔같음: urgent>p0>normal).
// ⛔ LLM 추론 아님 — 정규식 휴리스틱. 못 걸러낸 것·애매한 것은 conflicts·notes 에 남겨 사람이 본다.
//
// 두 얼굴(+하나):
//   decomposeRequests — 요청 묶음 → 작업(문장 단위 분해 · 먼저/우선→p0+deps · 인터럽트→urgent+정정 대상 notes
//                        · PR #N/칸 ELN-… 대상 추출 · 보류/취소/닫음/중복 → cancellations).
//                        «보류»라도 같은 묶음에 그 대상의 대응 작업이 있으면 취소 아니라 정정(notes).
//   reconcilePlan    — 기존 작업 + 새 분해 → 취소/대체(같은 대상 · supersededBy)/재배치(인터럽트 일시 중지)/신규
//                        · «active 하나» 수습 · 신규 작업 seq 단조 부여 + reportLine.
//   selectNextActive·markTaskDone — 다음 active 선택(의존 충족 → urgent>p0>normal → seq)·완료 처리
//                        (ELN-PLAN-ONE-ACTIVE · TASK-QUEUE-CONTRACTS §6 불변식).

// ── 계약(스펙 필드) ────────────────────────────────────────────────────────────────────

/**
 * ELN-SEAT-INBOX-TURN-BOUNDARY r2 (JUD #121493) — 우편 원장이 검증한 머리글 칸(B1-A `origin` kind/seat · `intent` ·
 * `crown_directive`)의 전달 형태. 구조적으로 `src/msg/msg-context-header.ts` 의 `headerFieldsOf` 결과
 * (`Partial<ContextHeaderInput>`)와 같다 — 원장 칸이 비어 있을 때 null 이므로 fromKind/fromSeat 는
 * `Partial<ContextHeaderInput>` 처럼 `| null` 까지 그대로 받는다(r3 게이트 changed-tsc TS2322: null 없는
 * 좁은 판은 `headerFieldsOf` 결과를 `TaskRequest.header` 에 못 실었다). 큐 알림 머리글
 * «[from <자리> · <intent> · crown]» 은 이 칸을 legacy sender/kind 폴백보다 우선한다(즉시 주입 경로와 같은 규칙).
 * 이 모듈은 순수 판정 모듈(의존 import 0)이라 타입을 로컬로 정의한다.
 */
type MessageFromKind = 'human' | 'agent' | 'system' | 'tool';

export interface SourceHeaderFields {
  /** B1-A `origin.kind` — 사람 발언은 우편 원장에 오지 않으므로 폴백은 legacyFromKind(sender) 그대로. 칸이 비면 null. */
  fromKind?: MessageFromKind | null;
  /** B1-A 구조 `origin.seat` — 없으면 legacy sender 가 자리 이름이 된다. 칸이 비면 null. */
  fromSeat?: string | null;
  /** B1-A `intent` — 없으면 legacy kind 매핑(legacyIntent)이 인텐트가 된다. */
  intent?: string | null;
  /** B1-A `crown_directive` — 검증된 지시 id일 때만 머리글에 «crown» 이 붙는다(§5c). */
  crownDirective?: string | null;
}

export interface TaskRequest {
  id: string;
  text: string;
  receivedAt: number;
  interrupt?: boolean;
  /**
   * ELN-SEAT-INBOX-TURN-BOUNDARY (#121130): the mail's sender (legacy `msg_messages.sender`) — carried so the
   * queue notice can name the origin instead of paraphrasing it away. Absent for non-mail requests.
   */
  sender?: string;
  /** The mail's transport kind — the notice header's intent fallback. */
  kind?: string | null;
  /**
   * r2 (#121130 · JUD #121493): the mail ledger's VERIFIED header fields (B1-A origin kind/seat · intent ·
   * crown_directive) — the queue notice's header prefers these over the legacy sender/kind (the same rule the
   * immediate-injection path already follows). Absent for non-mail requests and legacy-only rows.
   */
  header?: SourceHeaderFields;
  /**
   * ELN-SEAT-WORK-QUEUE: priority from the message's structured fields (B1-A `priority` · 대표 crown delegation) —
   * never from wording. The decomposition takes the higher of this and its text marks.
   */
  priority?: DecomposePriority;
  /** 배선 제공 맥락 — «다음 칸» 지칭 해석용(예: WORK-QUEUE 의 다음 미PR 칸 id). 없으면 문면만으로. */
  context?: { nextBoard?: string };
}

export type DecomposePriority = 'urgent' | 'p0' | 'normal';

export interface DecomposedTask {
  id: string;
  /** 등재 순번 — 세션에서 단조 증가. 대체가 일어나도 다시 매기지 않는다(계약 불변식 1). */
  seq: number;
  /** 사람이 읽는 한 줄 — 예: «칸 ELN-SEAT-INBOX-TURN-BOUNDARY 진행» · «#38007 merge·충돌 해소·시험·보고». */
  title: string;
  priority: DecomposePriority;
  /** 다른 task id — «먼저 X» · «칸 끝나면 다음 칸» 같은 순서 지시가 여기 온다. */
  deps: string[];
  /** 원문 보존 — 요청 id. */
  sourceRequestId: string;
  /** 원문 전문 보존(절대 요약으로 대체 금지). */
  sourceText: string;
  /** 원문 발신 자리(#121130) — 큐 알림 머리글이 발신자를 그대로 적는다(원문 보존의 한 조각). */
  sourceSender?: string;
  /** 원문 transport kind — 알림 머리글의 intent 폴백용. */
  sourceKind?: string | null;
  /** r2 (#121130 · JUD #121493): 원문의 검증 머리글 칸 — 큐 알림 머리글이 legacy sourceSender/sourceKind 대신 우선한다. */
  sourceHeader?: SourceHeaderFields;
  status: 'queued' | 'active' | 'done' | 'cancelled' | 'superseded';
  /** 대체(superseded)됐을 때 이 자리를 차지한 작업 id — 원문은 둘 다 보존. */
  supersededBy?: string;
  /** 완료 근거(불변식 9) — done 전이에 필수. 시험 결과·영수증 참조 한 줄. 없으면 done 이 될 수 없다. */
  doneEvidence?: string;
  /** 이 작업이 가리키는 대상(PR «#N» · 칸 «ELN-…») — 정정 판별(대체·취소)용. 원문 보존은 sourceText 몫. */
  targets?: string[];
  /** 분해 근거가 된 원문 조각(문장). */
  segment?: string;
  /** ELN-SEAT-WORK-QUEUE: when its request arrived (epoch ms) — the «longest wait» observation reads it. */
  receivedAt?: number;
}

/** 인터럽트성 정정 지시 — «보류/취소/닫음/중복» + 대상. 대응 작업이 같은 묶음에 있으면 취소 아니라 정정. */
export interface PlanCancellation {
  target: string;
  keyword: string;
  segment: string;
}

export interface DecompositionResult {
  tasks: DecomposedTask[];
  /** 같은 대상(PR 번호·칸 이름)을 둘 이상 요청이 지정 — 병합 후보(reconcilePlan 이 합친다). */
  conflicts: string[];
  /** 인터럽트 정정 대상 · 축하/인사 무시 · «취소 아님(대응 작업 존재)» 같은 판정 근거. */
  notes: string[];
  cancellations: PlanCancellation[];
}

export interface PlanRevision {
  /** 다음 플랜에 그대로 남는 작업 — 기존 유지(대체 host 포함) + 신규 추가(queued). */
  kept: DecomposedTask[];
  /** priority·deps 재조정된 기존 작업 — 인터럽트로 urgent 신규 뒤로 일시 중지된 진행 작업 등. */
  rescheduled: DecomposedTask[];
  cancelled: DecomposedTask[];
  /** 기존 작업(host)이 대체한 새 작업(supersededBy 지정 · 원문은 host·superseded 둘 다 보존). */
  superseded: DecomposedTask[];
  /** 바뀐 점 한 줄 — 예: «TURN-PACING 취소(중복 #38013) · #38007 대응 유지 · TASK-DECOMPOSE 추가». */
  reportLine: string;
}

/** 큐 등재 포트 — 구현체(배선)와 디커플드. 이 모듈은 정의만 한다. */
export interface SeatTaskQueuePort {
  enqueue(task: DecomposedTask): void;
  snapshot(): readonly DecomposedTask[];
}

// ── 판정 재료 ─────────────────────────────────────────────────────────────────────────

export const PRIORITY_RANK: Record<DecomposePriority, number> = { urgent: 0, p0: 1, normal: 2 };

/**
 * «active 하나» — 계획에 동시에 active 로 둘 수 있는 작업 수 상한(계약 불변식).
 * 출처: 내부 문서 `ELN-STEER-AND-TOOL-WATCHDOG` §6 작업 큐 계약(ELN-TASK-QUEUE-CONTRACTS) —
 * «in_progress 는 한 번에 하나» 불변식 채택. 시험은 이 상수로 단언한다(NUMGUARD — 숫자 리터럴 단언 금지).
 */
export const MAX_ACTIVE_PLAN_ITEMS = 1;

/**
 * 취소 키워드 «붙음» 판정 허용 간격(문자 수) — «#N RES 보류» 처럼 짧은 수식어가 끼어 있어도
 * 키워드가 직접 수식하는 것으로 본다. 시험은 이 상수로 단언한다(NUMGUARD — 숫자 리터럴 단언 금지).
 */
export const CANCEL_ATTACH_MAX_GAP = 8;

/**
 * 세션 seq 단조 증가 폭 — reconcilePlan 신규 등재 시 기존 최대 seq 뒤에 붙는 간격.
 * 시험은 이 상수로 파생 seq 를 만든다(NUMGUARD — 숫자 리터럴 인라인 금지).
 */
export const SEQ_STEP = 1;

/** 문장/지시 단위 — 마침표·« · »·« — »·« + » (붙어 있는 «·»·«→» 는 한 작업의 단계로 남긴다). */
const SEGMENT_SPLIT = /(?<=[.!?…])\s+|\s·\s|\s—\s|\s\+\s/;
const RE_TARGET = /(ELN-[A-Z0-9-]+|#\d+)/g;
const CONGRAT = /(축하|고생|감사|수고)/;
const CANCEL_KEYWORD = /(보류|취소|닫음|중복|되돌림)/;
const ACTIONABLE = /(진행|처리|대응|대처|시험|해소|merge|보고|msg post|다음 칸|발급)/i;
/** Words/marks in a request that make it urgent. A plain list of string literals (not a regex) — the same set as before. */
const URGENT_MARKS: readonly string[] = ['🔴', '👑', '충돌', '긴급'];
const isUrgentText = (text: string): boolean => URGENT_MARKS.some((mark) => text.includes(mark));
const P0_MARK = /(\bp0\b|먼저|우선)/i;
const POLICY_RE = /^(.+?)\s*(?:이|가)?\s*끝나면\s*(.+)$/;
const QUEUE_CTX = /WORK-QUEUE-\d+\.md\s*(?:의\s*)?[A-Z][A-Z0-9-]*\s*줄(?:에서|부터)?\s*/;

function extractTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(RE_TARGET)) if (!out.includes(m[0]!)) out.push(m[0]!);
  return out;
}

function head(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function cleanSegment(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^\((.*)\)$/, '$1').replace(/^\[(.*)\]$/, '$1');
  return s.replace(/[.!?…]+$/, '').trim();
}

function cancelKeywordOf(seg: string): string {
  return CANCEL_KEYWORD.exec(seg)?.[0] ?? '취소';
}

/**
 * 취소 후보는 키워드에 «붙은» 대상만(mustFix 11-17) — 발화 문장에 등장하는 대상 전부를 잡으면
 * 정본까지 취소되는 사고가 난다(«… #38013(main 위)으로 냈고 … #38012 닫음(중복)» 사례).
 * «붙음» = 대상 뒤 CANCEL_ATTACH_MAX_GAP 안(다른 대상이 사이에 없을 때) 키워드가 오는 것:
 * «#38012 닫음»·«#38007 RES 보류»·«ELN-SEAT-TURN-PACING 취소».
 * «#N(main 위)으로 냈고»·«#N 로 정리»·«중복 #N»(키워드가 앞에 오는 형태) 처럼 정본을 «가리키기만 하는»
 * #N 은 제외 — 키워드와 대상 사이가 멀거나 다른 대상이 먼저 오면 «가리킴»이지 «수식»이 아니다.
 */
function attachedCancelTargets(seg: string, targets: string[]): string[] {
  const attached: string[] = [];
  for (const target of targets) {
    const at = seg.indexOf(target);
    if (at < 0) continue;
    const after = seg.slice(at + target.length);
    // 주제 — 대상이 문장 머리 + 조사(은/는/이/가): «ELN-SEAT-TURN-PACING 은 … 닫음(중복)» — 문장 전체가 이 대상 서술.
    const isTopic = at === 0 && /^\s*(?:은|는|이|가)(?:\s|$)/.test(after);
    const kw = CANCEL_KEYWORD.exec(after);
    const nextOther = Math.min(...targets.filter(t => t !== target).map(t => after.indexOf(t)).filter(i => i >= 0));
    const directlyModified = kw !== null
      && (nextOther === Infinity || kw.index < nextOther)
      && kw.index <= CANCEL_ATTACH_MAX_GAP;
    if (isTopic || directlyModified) attached.push(target);
  }
  return attached;
}

function verbOf(text: string): string {
  return (/(진행|처리|대응|대처)/.exec(text) ?? [])[1] ?? '진행';
}

function directiveWord(text: string): string {
  return (/(대응|진행|처리|보고|merge|시험|해소)/i.exec(text) ?? [])[1] ?? '대응';
}

/** «칸 끝나면 바로 다음 칸» → «칸 완료 시 다음 칸 자동» (정책 문장 정규화). 없으면 null. */
function policyTitle(seg: string): string | null {
  const m = POLICY_RE.exec(seg);
  if (!m) return null;
  return `${m[1]!.trim()} 완료 시 ${m[2]!.trim()} 자동`;
}

/** 실행 단계 추출 — «merge·충돌 해소·시험·보고» 같은 title 조각. */
function extractSteps(seg: string): string[] {
  const steps: string[] = [];
  if (/merge/i.test(seg)) steps.push('merge');
  if (/충돌\s*해소/.test(seg)) steps.push('충돌 해소');
  if (/시험|테스트/.test(seg)) steps.push('시험');
  if (/보고|우편|msg post/.test(seg)) steps.push('보고');
  return steps;
}

function segPriority(req: TaskRequest, seg: string): DecomposePriority {
  const fromText: DecomposePriority = req.interrupt || isUrgentText(req.text) ? 'urgent' : P0_MARK.test(seg) ? 'p0' : 'normal';
  // The structured priority (WORK-QUEUE) is a floor: a 대표/urgent message is urgent whatever its words say.
  return req.priority !== undefined && PRIORITY_RANK[req.priority] < PRIORITY_RANK[fromText] ? req.priority : fromText;
}

/** 칸 이름의 사람 라벨 — «ELN-SEAT-TURN-PACING»→«TURN-PACING» · «ELN-TASK-DECOMPOSE-MULTI-REQUEST»→«TASK-DECOMPOSE». */
function shortBoardLabel(boardId: string): string {
  const s = boardId.replace(/^ELN-SEAT-/, '').replace(/^ELN-/, '');
  const parts = s.split('-');
  return parts.length > 2 ? parts.slice(0, 2).join('-') : s;
}

/** reportLine 용 짧은 라벨 — 칸 이름 → PR 번호 → title 머리. */
function labelOf(task: DecomposedTask): string {
  const targets = task.targets ?? extractTargets(task.title);
  const board = targets.find(t => t.startsWith('ELN-'));
  if (board) return shortBoardLabel(board);
  const pr = targets.find(t => t.startsWith('#'));
  if (pr) return pr;
  return head(task.title.replace(/^보고:\s*/, ''), 24);
}

// ── 분해 ─────────────────────────────────────────────────────────────────────────────

export function decomposeRequests(requests: TaskRequest[], opts: { seqStart?: number } = {}): DecompositionResult {
  const tasks: DecomposedTask[] = [];
  const notes: string[] = [];
  const candidates: PlanCancellation[] = [];
  const ordered = [...requests].sort((a, b) => a.receivedAt - b.receivedAt);
  // 묶음 안 등재 순번 — 받은 순·문장 순(재정렬 없음). 세션 단조 seq 는 reconcilePlan 이 등재 시 부여.
  let seqNext = opts.seqStart ?? 0;

  for (const req of ordered) {
    const segments = req.text.split(SEGMENT_SPLIT).map(cleanSegment).filter(s => s.length > 0);
    const reqTasks: DecomposedTask[] = [];
    // 대상 상속용 — 문맥 문장에 대상이 없을 때 요청 첫 대상을 쓴다(예: «#38007 보류» 뒤 «merge → 시험» 지시).
    let primaryTarget: string | null = null;

    for (const seg of segments) {
      if (CONGRAT.test(seg)) {
        notes.push(`${req.id} 인사/축하 줄 무시: «${head(seg, 24)}»`);
        continue;
      }
      const policy = policyTitle(seg);
      const targets = extractTargets(seg);
      if (policy) {
        reqTasks.push({
          id: `${req.id}:${reqTasks.length}`, seq: seqNext++, title: `정책: ${policy}`, priority: segPriority(req, seg),
          deps: [], sourceRequestId: req.id, sourceText: req.text, status: 'queued', targets, segment: seg,
        });
        continue;
      }
      if (targets.length && primaryTarget === null) primaryTarget = targets[0]!;
      if (CANCEL_KEYWORD.test(seg) && !ACTIONABLE.test(seg)) {
        // 취소 «후보» 수집 — 키워드에 붙은 대상만(계약 불변식 10: 새 발화 ≠ 자동 개정 — 파싱은 후보 표시만
        // 남기고 실제 cancelled 전이는 계획 도구(reconcilePlan)·사용자 몫이다).
        const attached = attachedCancelTargets(seg, targets);
        if (attached.length > 0) {
          for (const target of attached) candidates.push({ target, keyword: cancelKeywordOf(seg), segment: seg });
        } else {
          notes.push(`${req.id} 취소성 언급(키워드에 붙은 대상 없음${targets.length > 0 ? ` — 가리킴만: ${targets.join('·')}` : ' — 대상 없음'} — 작업으로 만들지 않음): «${head(seg, 24)}»`);
        }
        continue;
      }
      if (/msg post/.test(seg)) {
        const dest = /--to\s+([A-Z][A-Z0-9-]+)/.exec(seg)?.[1];
        const what = /PR 번호·head40/.test(seg)
          ? 'PR 번호·head40'
          : (seg.match(/PR 번호|head40|결과/g) ?? []).join('·') || '결과';
        reqTasks.push({
          id: `${req.id}:${reqTasks.length}`, seq: seqNext++, title: `보고: ${what || '결과'}${dest ? ` → ${dest}` : ''}`,
          priority: segPriority(req, seg), deps: [], sourceRequestId: req.id, sourceText: req.text,
          status: 'queued', targets, segment: seg,
        });
        continue;
      }
      if (ACTIONABLE.test(seg)) {
        let taskTargets = targets.length > 0 ? targets : primaryTarget !== null ? [primaryTarget] : [];
        if (taskTargets.length === 0 && /다음\s*칸/.test(seg) && req.context?.nextBoard) {
          taskTargets = [req.context.nextBoard];
        }
        const board = taskTargets.find(t => t.startsWith('ELN-'));
        const pr = taskTargets.find(t => t.startsWith('#'));
        const steps = extractSteps(seg);
        const title = board !== undefined
          ? `칸 ${board} ${verbOf(seg)}`
          : pr !== undefined
            ? `#${pr.slice(1)} ${steps.length > 0 ? steps.join('·') : verbOf(seg)}`
            : head(seg.replace(QUEUE_CTX, '').replace(/^큐\s*/, '').trim(), 44);
        reqTasks.push({
          id: `${req.id}:${reqTasks.length}`, seq: seqNext++, title, priority: segPriority(req, seg), deps: [],
          sourceRequestId: req.id, sourceText: req.text, status: 'queued', targets: taskTargets, segment: seg,
        });
        continue;
      }
      // 나머지는 맥락(문맥) — 작업 아님. 원문은 sourceText 전문으로 보존된다.
    }

    // «먼저/우선» 표시 작업 뒤로 같은 요청의 나머지 작업 dep — 순서 지시 반영.
    const firstIdx = reqTasks.findIndex(t => t.segment !== undefined && P0_MARK.test(t.segment!));
    if (firstIdx >= 0) {
      for (let i = 0; i < reqTasks.length; i++) {
        if (i !== firstIdx) reqTasks[i]!.deps.push(reqTasks[firstIdx]!.id);
      }
    }
    // 정책 작업(«칸 끝나면 다음 칸»)은 같은 요청의 앞 작업들 뒤에.
    for (let i = 0; i < reqTasks.length; i++) {
      if (!reqTasks[i]!.title.startsWith('정책:')) continue;
      for (let j = 0; j < i; j++) {
        if (!reqTasks[i]!.deps.includes(reqTasks[j]!.id)) reqTasks[i]!.deps.push(reqTasks[j]!.id);
      }
    }
    if (req.interrupt) notes.push(`인터럽트(${req.id}) — 진행 중 작업 정정(reconcile) 대상: 일시 중지 후 재계획`);
    // 원문 발신자·transport kind 는 요청의 작업마다 보존(#121130 — 큐 알림이 원문을 그대로 싣는다).
    tasks.push(...reqTasks.map(task => ({
      ...task,
      ...(req.sender !== undefined ? { sourceSender: req.sender } : {}),
      ...(req.kind !== undefined ? { sourceKind: req.kind } : {}),
      ...(req.header !== undefined ? { sourceHeader: req.header } : {}),
    })));
  }

  // 취소 후보 중 같은 묶음에 그 대상의 대응 작업이 있으면 취소 아님 — 정정(reconcile) 대상.
  const actionableTargets = new Set(tasks.flatMap(t => t.targets ?? []));
  const cancellations: PlanCancellation[] = [];
  for (const c of candidates) {
    if (actionableTargets.has(c.target)) {
      notes.push(`${c.target} ${c.keyword} — 같은 묶음에 대응 작업 있음: 취소 아님(정정)`);
      continue;
    }
    cancellations.push(c);
  }

  // 묶음 안 같은 대상 충돌 — 병합 후보.
  const conflicts: string[] = [];
  const byTarget = new Map<string, DecomposedTask[]>();
  for (const t of tasks) {
    for (const target of t.targets ?? []) {
      const list = byTarget.get(target) ?? [];
      list.push(t);
      byTarget.set(target, list);
    }
  }
  for (const [target, list] of byTarget) {
    if (list.length > 1) {
      const froms = [...new Set(list.map(t => t.sourceRequestId))].join('·');
      conflicts.push(`${target} — 요청 ${froms} 이 같은 대상 지정(병합 후보 · reconcilePlan 이 합침)`);
    }
  }

  return { tasks, conflicts, notes, cancellations };
}

// ── 정정 ─────────────────────────────────────────────────────────────────────────────

function cancelReason(c: PlanCancellation, cancelled: DecomposedTask): string {
  if (c.segment.includes('중복')) {
    const own = new Set(cancelled.targets ?? extractTargets(cancelled.title));
    const other = extractTargets(c.segment).find(t => t.startsWith('#') && !own.has(t));
    if (other !== undefined) return `중복 ${other}`;
  }
  return c.keyword;
}

export function reconcilePlan(
  existingTasks: DecomposedTask[],
  incoming: DecompositionResult,
  opts: { nextSeq?: number } = {},
): PlanRevision {
  // 1) 취소 — «보류/되돌림/취소/중복/닫음». 단, 대응 작업이 남은 대상은 취소하지 않는다(정정).
  const actionableTargets = new Set(incoming.tasks.flatMap(t => t.targets ?? []));
  const cancelled: DecomposedTask[] = [];
  const cancelParts: string[] = [];
  const cancelledIds = new Set<string>();
  for (const c of incoming.cancellations) {
    if (actionableTargets.has(c.target)) continue;
    for (const ex of existingTasks) {
      if (cancelledIds.has(ex.id) || ex.status === 'cancelled' || ex.status === 'superseded') continue;
      const targets = ex.targets ?? extractTargets(ex.title);
      if (!targets.includes(c.target)) continue;
      cancelledIds.add(ex.id);
      cancelled.push({ ...ex, status: 'cancelled' });
      cancelParts.push(`${labelOf(ex)} 취소(${cancelReason(c, ex)})`);
    }
  }

  const survivors = existingTasks.filter(t => !cancelledIds.has(t.id));

  // 2) 대체 — 같은 대상(PR 번호·칸 이름)의 새 작업은 기존 작업(host)이 대체(흡수). 원문은 host·superseded 둘 다 보존.
  //    종결(done·cancelled·superseded) host 로는 대체하지 않는다 — 그 대상의 새 지시는 새 작업으로 등재.
  const superseded: DecomposedTask[] = [];
  const mergeParts: string[] = [];
  const hostIds = new Set<string>();
  const hostBump = new Map<string, DecomposePriority>();
  const supersededTaskIds = new Set<string>();
  for (const task of incoming.tasks) {
    const host = survivors.find(ex =>
      !isTerminal(ex) && (task.targets ?? []).some(t => (ex.targets ?? extractTargets(ex.title)).includes(t)));
    if (host === undefined) continue;
    superseded.push({ ...task, status: 'superseded', supersededBy: host.id });
    supersededTaskIds.add(task.id);
    hostIds.add(host.id);
    mergeParts.push(`${labelOf(host)} ${directiveWord(task.segment ?? task.title)} 유지`);
    const current = hostBump.get(host.id) ?? host.priority;
    hostBump.set(host.id, PRIORITY_RANK[task.priority] < PRIORITY_RANK[current] ? task.priority : current);
  }

  // 3) 신규 추가 — 붙일 host 가 없는 작업. 세션 seq 는 여기서 단조 부여(기존 최대 뒤 · 다시 매기지 않음).
  const added: DecomposedTask[] = [];
  const addParts: string[] = [];
  const nextSeq = opts.nextSeq ?? (existingTasks.length > 0 ? Math.max(...existingTasks.map(t => t.seq)) + 1 : 0);
  for (const task of incoming.tasks) {
    if (supersededTaskIds.has(task.id)) continue;
    added.push({ ...task, status: 'queued', seq: nextSeq + added.length });
    addParts.push(`${labelOf(task)} 추가`);
  }

  // 4) 인터럽트 — 진행 중(active) 작업 일시 중지: urgent 신규·재지시 작업 뒤로 deps 재조정.
  const rescheduled: DecomposedTask[] = [];
  const reschedParts: string[] = [];
  const hasInterrupt = incoming.notes.some(n => n.startsWith('인터럽트'));
  if (hasInterrupt) {
    const waitIds = [
      ...added.filter(t => t.priority === 'urgent').map(t => t.id),
      ...superseded.filter(t => t.priority === 'urgent').map(t => t.supersededBy!),
    ];
    for (const ex of survivors) {
      if (ex.status !== 'active' || hostIds.has(ex.id)) continue;
      rescheduled.push({ ...ex, status: 'queued', deps: [...new Set([...ex.deps, ...waitIds])] });
      reschedParts.push(`${labelOf(ex)} 정정(진행 일시 중지)`);
    }
  }

  const kept: DecomposedTask[] = [];
  for (const ex of survivors) {
    if (rescheduled.some(r => r.id === ex.id)) continue;
    const bump = hostBump.get(ex.id);
    kept.push(bump !== undefined && bump !== ex.priority ? { ...ex, priority: bump } : ex);
  }
  kept.push(...added);

  // 5) «active 하나» 불변식(계약 §6 · MAX_ACTIVE_PLAN_ITEMS) — 초과 active 는 선택 규칙(우선순위 → seq) 1개만 남기고 대기 복귀.
  const guardParts: string[] = [];
  const actives = [...kept, ...rescheduled].filter(t => t.status === 'active');
  if (actives.length > MAX_ACTIVE_PLAN_ITEMS) {
    const [keepActive, ...extra] = [...actives]
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.seq - b.seq);
    const demoteIds = new Set(extra.map(t => t.id));
    for (let i = 0; i < kept.length; i++) {
      if (demoteIds.has(kept[i]!.id)) kept[i] = { ...kept[i]!, status: 'queued' };
    }
    guardParts.push(`${labelOf(keepActive!)} 진행 유지(active 초과분 대기 복귀)`);
  }

  const parts = [...cancelParts, ...reschedParts, ...mergeParts, ...addParts, ...guardParts];
  return { kept, rescheduled, cancelled, superseded, reportLine: parts.length > 0 ? parts.join(' · ') : '변경 없음' };
}

// ── «active 하나» — 다음 active 선택·완료(ELN-PLAN-ONE-ACTIVE · 계약 §6) ─────────────────

/** 종결 상태 — 이 이상 상태가 바뀌지 않음(완료·취소·대체). */
function isTerminal(t: DecomposedTask): boolean {
  return t.status === 'done' || t.status === 'cancelled' || t.status === 'superseded';
}

/**
 * 다음 active 선택 — 의존이 충족된 queued 중 우선순위(urgent>p0>normal) → seq 순(계약 §6).
 * 의존 충족 = dep 이 종결 상태거나 계획 밖 id. 종결·active 작업은 후보가 아니다.
 */
export function selectNextActive(tasks: DecomposedTask[]): DecomposedTask | undefined {
  const byId = new Map(tasks.map(t => [t.id, t] as const));
  const ready = tasks.filter(t =>
    t.status === 'queued'
    && t.deps.every(d => {
      const dep = byId.get(d);
      return dep === undefined || isTerminal(dep);
    }));
  if (ready.length === 0) return undefined;
  return [...ready].sort((a, b) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.seq - b.seq)[0];
}

/**
 * 작업 완료 — 해당 id 만 done 으로(불변식 9). seq·원문 그대로(queued→active→done 전이의 종착).
 * 근거(evidence) 필수 — 시험 결과·영수증 참조. 비었으면 전이하지 않고 throw(«자식의 끝 ≠ 계획 완료»).
 */
export function markTaskDone(tasks: DecomposedTask[], id: string, evidence: string): DecomposedTask[] {
  const trimmed = evidence.trim();
  if (trimmed.length === 0) {
    throw new Error(`done 전이 거부(${id}) — 근거 필드 필수(불변식 9): 시험·영수증 참조를 한 줄 넣어야 한다`);
  }
  return tasks.map(t => (t.id === id ? { ...t, status: 'done', doneEvidence: trimmed } : t));
}

/** 항목 단위 패치 — id 로 찾아 표시 필드만 갱신. seq·원문(sourceText)·근거(doneEvidence)·상태 종결은 못 바꾼다. */
export interface TaskPatch {
  title?: string;
  priority?: DecomposePriority;
  deps?: string[];
  targets?: string[];
}

/** 계획 갱신은 항목 단위 패치(+seq · 계약 L58) — seq 는 등재 시 단조 부여가 유일, 패치로 절대 다시 매기지 않는다. */
export function patchTask(tasks: DecomposedTask[], id: string, patch: TaskPatch): DecomposedTask[] {
  return tasks.map(t => {
    if (t.id !== id) return t;
    if (isTerminal(t)) {
      throw new Error(`패치 거부(${id}) — 종결(done·cancelled·superseded) 작업은 패치할 수 없다`);
    }
    return {
      ...t,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.deps !== undefined ? { deps: patch.deps } : {}),
      ...(patch.targets !== undefined ? { targets: patch.targets } : {}),
      seq: t.seq,
    };
  });
}

// ── 큐 등재 ──────────────────────────────────────────────────────────────────────────

/** 우선순위(urgent>p0>normal) → dep 순서 — dep 이 깔린 것 먼저, 순환/외부 dep 이면 순서 보존.
 *  active 는 맥 앞(«active 하나» — 상태는 바꾸지 않는다). */
export function orderPlanTasks(tasks: DecomposedTask[]): DecomposedTask[] {
  const actives = tasks.filter(t => t.status === 'active');
  const rest = tasks.filter(t => t.status !== 'active');
  return [...actives, ...orderRest(rest)];
}

function orderRest(tasks: DecomposedTask[]): DecomposedTask[] {
  const ids = new Set(tasks.map(t => t.id));
  const done = new Set<string>();
  const remaining = [...tasks];
  const out: DecomposedTask[] = [];
  while (remaining.length > 0) {
    let first = remaining.findIndex(t => t.deps.every(d => !ids.has(d) || done.has(d)));
    if (first < 0) first = 0;
    let best = first;
    for (let i = first + 1; i < remaining.length; i++) {
      const t = remaining[i]!;
      const ready = t.deps.every(d => !ids.has(d) || done.has(d));
      if (ready && PRIORITY_RANK[t.priority] < PRIORITY_RANK[remaining[best]!.priority]) best = i;
    }
    const [task] = remaining.splice(best, 1);
    done.add(task!.id);
    out.push(task!);
  }
  return out;
}

/** 정정 결과를 큐 포트에 등재 — kept+rescheduled 중 종결(done·cancelled·superseded) 제외, 실행 순서로. 등재한 목록을 돌려준다. */
export function enqueuePlan(queue: SeatTaskQueuePort, revision: PlanRevision): DecomposedTask[] {
  const ordered = orderPlanTasks([...revision.kept, ...revision.rescheduled].filter(t => !isTerminal(t)));
  for (const task of ordered) queue.enqueue(task);
  return ordered;
}
