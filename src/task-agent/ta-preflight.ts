import { createHash } from 'node:crypto';
import { WORK_ORDER_CRITICAL_FIELDS, WORK_ORDER_UNKNOWN, type WorkOrder } from './work-order.js';

/**
 * TA-PREFLIGHT — 자식(TA) 발사 «전에» 재개 조건 6개를 증거로 검사한다. 발사·모델 호출·네트워크 0, 순수 함수.
 * 증거가 없으면 PASS 가 아니라 UNMEASURED 이고, 하나라도 PASS 가 아니면 전체는 NOT_READY 다.
 * (RES/TA-HARNESS-STRUCTURE-68763 재개 조건 1~6 · 이미지 준비 성공을 착지 성공으로 승격하지 않는다.)
 */
export type PreflightStatus = 'PASS' | 'FAIL' | 'UNMEASURED';

export interface PreflightCondition {
  readonly id: 1 | 2 | 3 | 4 | 5 | 6;
  readonly name: string;
  readonly status: PreflightStatus;
  readonly detail: string;
}

/** 조건 3 에서 «모름» 이면 발사를 막는 지시서 칸 — 경계·예산·계약·상향. */
export const PREFLIGHT_CRITICAL_ORDER_FIELDS = WORK_ORDER_CRITICAL_FIELDS;

export interface TaPreflightEvidence {
  /** ① 요청 pin 과 child 가 실제 받은 HEAD (둘 다 40자 hex 여야 PASS · 없으면 UNMEASURED). */
  readonly source?: { readonly requestedPin?: string | null; readonly childHead?: string | null; readonly privateRepo?: boolean | null };
  /** ② 요청 pin digest 와 실제 소비(Pod imageID) digest. */
  readonly image?: { readonly expectedDigest?: string | null; readonly observedDigest?: string | null };
  /** ③ 작업 지시서 · 자동 merge 끔 · 귀속(owner 가 카드·lease 와 같은지). */
  readonly workOrder?: Pick<WorkOrder, 'cellId' | 'boundary' | 'budget' | 'contract' | 'escalation' | 'unknownFields'> | null;
  readonly autoMerge?: boolean | null;
  readonly owner?: { readonly card?: string | null; readonly lease?: string | null; readonly pod?: string | null };
  /** ④ 시간·비용: 벽시계 상한과 Job 상한(초), USD 상한. 벽시계 < Job 이어야 하고 USD 상한이 양수여야 한다. */
  readonly limits?: { readonly wallClockSec?: number | null; readonly jobDeadlineSec?: number | null; readonly usdCap?: number | null };
  /** ⑤ 중복·중지: 같은 requestId 이미 소비? · 활성 같은 골 run 수 · 최신 OP hold 가 걸려 있는지. */
  readonly launch?: { readonly requestConsumed?: boolean | null; readonly activeSameGoalRuns?: number | null; readonly opHoldActive?: boolean | null };
  /** ⑥ 입구 단일화·그라운딩. entrance 는 허용된 단일 입구(hand) 만 PASS. */
  readonly entrance?: {
    readonly name?: string | null;
    /** (구) 그라운딩 URL 설정 여부 — 설정됐다고만 말하고 닿는지는 모른다. */
    readonly groundingConfigured?: boolean | null;
    /** 설정된 그라운딩 URL 의 도달 확인(true=닿음 · false=안 닿음 · null=미측정). URL 이 있으면 도달 증거가 PASS 의 조건이다. */
    readonly groundingUrl?: string | null;
    readonly groundingReachable?: boolean | null;
    /** 그라운딩 URL 없음 = 정책상 끔(예: 대표 D2 «M2 토큰 중계 안 켬») — off:true 와 사유 원문이 함께 있어야 PASS(policy-off). */
    readonly groundingPolicy?: { readonly off?: boolean | null; readonly reason?: string | null } | null;
  };
  /**
   * ①② 정적 판정용 — «어긋나면 런을 실패시키는 코드»가 이 빌드에 있는가. 증거 파일이 스스로 주장하지 못하게
   * `tasks preflight` 가 모듈 export 를 직접 확인해 채운다(주어진 값은 덮어쓴다).
   */
  readonly failClosed?: { readonly sourceHead?: boolean | null; readonly imageDigest?: boolean | null };
}

export interface TaPreflightReport {
  readonly overall: 'READY' | 'NOT_READY';
  readonly conditions: readonly PreflightCondition[];
  readonly summary: { readonly pass: number; readonly fail: number; readonly unmeasured: number };
}

const HEX40 = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ALLOWED_ENTRANCE = 'hand';

const cond = (id: PreflightCondition['id'], name: string, status: PreflightStatus, detail: string): PreflightCondition => ({ id, name, status, detail });
const present = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim().length > 0;
const num = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
/** 증거 JSON 은 외부 입력 — 불리언 칸은 typeof boolean 일 때만 측정값이다(0·'false'·null 은 미측정). */
const isBool = (value: unknown): value is boolean => typeof value === 'boolean';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * 판정 법칙(여섯 조건 공통) — 입력 칸마다 «정상 · 불량(값이 있고 틀림) · 없음/미측정»을 독립적으로 분류한 뒤:
 * 불량이 하나라도 있으면 FAIL(사유를 모두 적음) → 없고 미측정이 하나라도 있으면 UNMEASURED → 전부 정상이면 PASS.
 * 한 칸이 비어 있다고 다른 칸의 알려진 불량을 숨기지 않고(알려진 나쁨이 모름보다 먼저), 비어 있거나 형식이 틀린 칸은 PASS 를 만들지 않는다.
 */
function judge(id: PreflightCondition['id'], name: string, fails: readonly string[], unknowns: readonly string[], passDetail: string): PreflightCondition {
  if (fails.length) return cond(id, name, 'FAIL', fails.join(' · '));
  if (unknowns.length) return cond(id, name, 'UNMEASURED', unknowns.join(' · '));
  return cond(id, name, 'PASS', passDetail);
}

function checkSource(e: TaPreflightEvidence['source'], fc: TaPreflightEvidence['failClosed']): PreflightCondition {
  const name = 'private repo + child 실제 HEAD';
  const fails: string[] = [];
  const unknowns: string[] = [];
  const pin = e && present(e.requestedPin) ? e.requestedPin : null;
  const child = e && present(e.childHead) ? e.childHead : null;
  const pinOk = pin !== null && HEX40.test(pin);
  const childOk = child !== null && HEX40.test(child);
  if (pin === null) unknowns.push('요청 pin 없음');
  else if (!pinOk) fails.push('요청 pin 이 40자 소문자 hex 가 아님');
  if (child !== null && !childOk) fails.push('child HEAD 가 40자 소문자 hex 가 아님');
  if (pinOk && childOk && pin !== child) fails.push(`pin ${pin.slice(0, 12)} ≠ child ${child.slice(0, 12)}`);
  // HEAD 게이트는 private 여부를 입증하지 않는다 — private 증거(불리언 true)가 따로 필요하다.
  if (e?.privateRepo === false) fails.push('private 이 아닌 origin');
  else if (e?.privateRepo !== true) unknowns.push('private repo 증거 없음(불리언 true 만 측정값)');
  // child HEAD 가 없으면(발사 전) «어긋나면 런을 실패시키는 코드 존재»가 정적 증거다.
  if (child === null && fc?.sourceHead !== true) unknowns.push('child 수신 HEAD 증거 없음 · 어긋나면 런을 실패시키는 코드 존재를 확인하지 못함');
  return judge(1, name, fails, unknowns, child === null
    ? `정적: pin ${pin?.slice(0, 12)} · private · fail-closed 코드 존재(pod-source-head-mismatch) — child HEAD 는 첫 발사 원장 pod-source-head-check 로 대조`
    : `child HEAD == pin ${child.slice(0, 12)} (private)`);
}

function checkImage(e: TaPreflightEvidence['image'], fc: TaPreflightEvidence['failClosed']): PreflightCondition {
  const name = '이미지 소비 digest';
  const fails: string[] = [];
  const unknowns: string[] = [];
  const pin = e && present(e.expectedDigest) ? e.expectedDigest : null;
  const observed = e && present(e.observedDigest) ? e.observedDigest : null;
  // pin 필수 — 없으면 런타임 대조가 no-pin 으로 통과해 버린다(관측이 있어도 마찬가지로 불량).
  if (pin === null) fails.push('이미지 digest pin 필수 — 요청 pin 없음(no-pin 으로 통과해 버림)');
  else if (!DIGEST.test(pin)) fails.push('digest pin 형식 오류(sha256:64hex)');
  if (observed !== null && !DIGEST.test(observed)) fails.push('소비 digest 형식 오류(sha256:64hex)');
  if (pin !== null && observed !== null && DIGEST.test(pin) && DIGEST.test(observed) && pin !== observed) fails.push('소비 digest ≠ 요청 pin');
  if (observed === null && fc?.imageDigest !== true) unknowns.push('소비 digest 증거 없음 · 어긋나면 런을 실패시키는 코드 존재를 확인하지 못함');
  return judge(2, name, fails, unknowns, observed === null
    ? `정적: pin ${pin?.slice(0, 19)} · fail-closed 코드 존재(pod-image-digest-mismatch) — 소비 digest 는 첫 발사 원장 pod-image-digest 로 대조`
    : '소비 digest == 요청 pin');
}

function checkOrder(e: TaPreflightEvidence): PreflightCondition {
  const name = '작업 지시서 · 귀속 · 자동 merge 0';
  const fails: string[] = [];
  const unknowns: string[] = [];
  const order = e.workOrder;
  if (!order) unknowns.push('작업 지시서 없음');
  else {
    const unknownFields: unknown = order.unknownFields;
    const unknown = PREFLIGHT_CRITICAL_ORDER_FIELDS.filter((field) => (Array.isArray(unknownFields) ? unknownFields.includes(field) : true) || !present(order[field]) || order[field] === WORK_ORDER_UNKNOWN);
    if (unknown.length) fails.push(`critical 모름: ${unknown.join(', ')}`);
  }
  if (e.autoMerge === true) fails.push('자동 merge 켜짐');
  else if (!isBool(e.autoMerge)) unknowns.push('--no-auto-merge 증거 없음 또는 불리언 아님');
  // owner 귀속은 «모름 지시서 거부» 코드로 대신할 수 없다 — 세 칸이 모두 있고 같아야 PASS. 있는 칸끼리 다르면 빈 칸이 있어도 불일치는 확정(FAIL).
  const { card, lease, pod } = e.owner ?? {};
  const owners = [card, lease, pod].filter(present);
  if (new Set(owners).size > 1) fails.push(`owner 불일치 card=${card ?? '없음'} lease=${lease ?? '없음'} pod=${pod ?? '없음'}`);
  else if (owners.length < 3) unknowns.push('카드/lease/Pod owner 증거 부족');
  return judge(3, name, fails, unknowns, `owner=${card} · critical 칸 채움 · 자동 merge 0`);
}

function checkLimits(e: TaPreflightEvidence['limits']): PreflightCondition {
  const name = '시간 · 비용 상한';
  const fails: string[] = [];
  const unknowns: string[] = [];
  const wall = e && num(e.wallClockSec) ? e.wallClockSec : null;
  const job = e && num(e.jobDeadlineSec) ? e.jobDeadlineSec : null;
  const usd = e && num(e.usdCap) ? e.usdCap : null;
  // 숫자가 아닌 칸(없음·null·문자열·NaN·Infinity)은 측정값이 아니다 · 숫자인데 0 이하는 불량.
  for (const [label, value] of [['wallClock', wall], ['jobDeadline', job], ['USD 상한', usd]] as const) {
    if (value === null) unknowns.push(`${label} 미지정 또는 숫자 아님`);
    else if (value <= 0) fails.push(`${label} 이 0 이하`);
  }
  if (wall !== null && job !== null && wall > 0 && job > 0 && wall >= job) fails.push(`wallClock ${wall}s ≥ job ${job}s — 자식이 결과를 들고 끝날 여유 없음`);
  return judge(4, name, fails, unknowns, `wallClock ${wall}s < job ${job}s · USD cap ${usd}`);
}

function checkLaunch(e: TaPreflightEvidence['launch']): PreflightCondition {
  const name = '중복 · 중지 · 최신 OP hold';
  const fails: string[] = [];
  const unknowns: string[] = [];
  if (e?.opHoldActive === true) fails.push('최신 OP hold 가 걸려 있음');
  else if (!isBool(e?.opHoldActive)) unknowns.push('OP hold 미측정 또는 불리언 아님');
  if (e?.requestConsumed === true) fails.push('같은 requestId 이미 소비됨(재시도는 새 요청으로)');
  else if (!isBool(e?.requestConsumed)) unknowns.push('requestId 소비 여부 미측정 또는 불리언 아님');
  if (isCount(e?.activeSameGoalRuns)) { if (e.activeSameGoalRuns > 0) fails.push(`같은 골 활성 run ${e.activeSameGoalRuns}`); }
  else unknowns.push('활성 run 수 미측정 또는 0 이상 정수 아님');
  return judge(5, name, fails, unknowns, 'hold 없음 · 미소비 · 활성 중복 0');
}

/** 그라운딩 URL 형식 — http(s) 절대 URL 이고 호스트가 있어야 한다. */
function groundingUrlOk(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0; } catch { return false; }
}

function checkEntrance(e: TaPreflightEvidence['entrance']): PreflightCondition {
  const name = '단일 입구 · 그라운딩';
  // 입구·그라운딩 증거 객체 자체가 없으면 URL 이 없다는 것도 확정이 아니다 — 알 수 없음.
  if (!e) return cond(6, name, 'UNMEASURED', '입구·그라운딩 증거 없음');
  const fails: string[] = [];
  const unknowns: string[] = [];
  const entrance = e && present(e.name) ? e.name : null;
  if (entrance === null) unknowns.push('입구 증거 없음');
  else if (entrance !== ALLOWED_ENTRANCE) fails.push(`허용 입구는 ${ALLOWED_ENTRANCE} 하나 — 받은 값 ${entrance}`);
  const url = e && present(e.groundingUrl) ? e.groundingUrl : null;
  const configured = url !== null || e?.groundingConfigured === true;
  if (configured) {
    // 설정된 URL 은 «문자열(형식 맞음) + 도달 측정 true» 가 PASS 조건 — 형식 오류·안 닿음=FAIL · 문자열 없음·도달 미측정=UNMEASURED(조용한 skip 금지). 정책 끔 주장은 URL 이 있으면 쓰지 않는다.
    if (url === null) unknowns.push('groundingConfigured 만 있고 URL 문자열 증거 없음');
    else if (!groundingUrlOk(url)) fails.push('그라운딩 URL 형식 오류(http(s)://호스트 필요)');
    if (e?.groundingReachable === false) fails.push('그라운딩 URL 이 설정됐으나 닿지 않음');
    else if (e?.groundingReachable !== true) unknowns.push('그라운딩 URL 설정됨 · 도달 미측정');
  } else {
    // URL 없음 — 정책 끔 + 사유 원문이 있어야 PASS(사유는 가공하지 않고 기록). 없으면 FAIL.
    const policy = e?.groundingPolicy;
    if (!(policy?.off === true && present(policy.reason))) fails.push('그라운딩 URL 없음 · 정책 끔 사유도 없음(no-grounding-url 로 조용히 skip 됨)');
  }
  const policy = e?.groundingPolicy;
  return judge(6, name, fails, unknowns, configured ? `입구 ${entrance} · 그라운딩 설정됨 · 도달 확인` : `입구 ${entrance} · 그라운딩 policy-off — 사유: ${policy?.reason}`);
}

export function evaluateTaPreflight(evidence: TaPreflightEvidence): TaPreflightReport {
  const conditions = [
    checkSource(evidence.source, evidence.failClosed), checkImage(evidence.image, evidence.failClosed), checkOrder(evidence),
    checkLimits(evidence.limits), checkLaunch(evidence.launch), checkEntrance(evidence.entrance),
  ];
  const count = (status: PreflightStatus): number => conditions.filter((c) => c.status === status).length;
  const summary = { pass: count('PASS'), fail: count('FAIL'), unmeasured: count('UNMEASURED') };
  return { overall: summary.pass === conditions.length ? 'READY' : 'NOT_READY', conditions, summary };
}

/** 영수증이 «이 발사에만» 유효하도록 박는 대상 — 카드/칸/commit 중 최소 하나. */
export interface TaPreflightTarget { readonly card?: string; readonly cell?: string; readonly commit?: string }

/**
 * 영수증 target 은 «검사한 증거»와 같은 대상이어야 한다 — 아니면 commit Y 로 READY 받은 증거에 --commit X 영수증이 박혀 X 발사를 통과시킨다.
 * commit ↔ source.requestedPin, cell ↔ workOrder.cellId. 증거에 없는 대상 필드는 대조할 수 없으므로 불일치로 본다. card 는 증거에 대응 칸이 없어 대조하지 않는다.
 * 일치하면 null, 아니면 사유.
 */
export function targetEvidenceMismatch(evidence: TaPreflightEvidence, target: TaPreflightTarget): string | null {
  if (target.commit !== undefined && evidence.source?.requestedPin !== target.commit) {
    return `--commit ${target.commit.slice(0, 12)} ≠ 증거 source.requestedPin ${typeof evidence.source?.requestedPin === 'string' ? evidence.source.requestedPin.slice(0, 12) : '없음'}`;
  }
  if (target.cell !== undefined && evidence.workOrder?.cellId !== target.cell) {
    return `--cell ${target.cell} ≠ 증거 workOrder.cellId ${typeof evidence.workOrder?.cellId === 'string' ? evidence.workOrder.cellId : '없음'}`;
  }
  return null;
}

/**
 * 영수증 본문 — createdAt(생성 시각)·target(발사 대상)을 본문에 박는다. 관문은 파일 mtime 이 아니라 이 createdAt 으로 새것을 판정한다.
 * defaultAssumed = 코드 기본값(관측 아님) — evidence 와 섞지 않고 따로 적는다.
 */
export function taPreflightReceipt(evidence: TaPreflightEvidence, report: TaPreflightReport, defaultAssumed?: Readonly<Record<string, number>>, meta?: { readonly createdAt: string; readonly target?: TaPreflightTarget }): { json: string; sha256: string } {
  const json = `${JSON.stringify({ kind: 'ta-preflight', ...(meta ? { createdAt: meta.createdAt, target: meta.target ?? {} } : {}), report, evidence, ...(defaultAssumed ? { defaultAssumed } : {}) }, null, 2)}\n`;
  return { json, sha256: createHash('sha256').update(json).digest('hex') };
}

export function renderTaPreflight(report: TaPreflightReport): string {
  const lines = report.conditions.map((c) => `${c.status.padEnd(10)} ${c.id}. ${c.name} — ${c.detail}`);
  return [...lines, `${report.overall} (pass ${report.summary.pass} · fail ${report.summary.fail} · unmeasured ${report.summary.unmeasured})`].join('\n');
}
