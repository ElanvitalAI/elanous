// ── 자기 관측 집계기 `self observe` (ELN-OP-SELF-HEAL-LOOP · 0.3.35 P0 · ELN-OP-SELF-HEAL-1123) ──────────
//
// 🚨 무엇을 푸는가: OP 상주 루프의 1층 «관측» 이 지금은 사람 눈(화면 · 로그 grep)이다. 자기 도구 거부
//   (control-audit.jsonl 의 principal=eln:tool denied/executor-refused 행) · 정정/철회 우편 · 대기 우편 수를
//   시간창 안에서 세어 «회고 입력 한 줄» 로 출력한다. 2층 «인지» 까지: 같은 서명이 창 내 2회 관측되면
//   «결함 승격 후보» 로 표시하고 칸 초안 문면을 **출력만** 낸다.
// ⛔ 셀프힐링 3층(칸 생성·손 배정)은 이 PR 의 스코프 밖 — 산출물이 «초안»인 이유다. 어떤 원장 쓰기도
//   실행하지 않는다: checklist add 는 문면일 뿐이고, deps.createSelfHealCell 이음새는 미래 실행기를
//   위해 남겨 두되 이 모듈의 어떤 경로도 부르지 않는다(반증: self-heal-promote.test.ts 스파이).
// ⛔ 새 상주 프로세스 0 · 새 표 0: 읽기 전용 집계이고, 우편 원장(msg)·제어 감사(els)·루프 CLI(self/loop)
//   의 기존 이음새에 얹는다(self-timer-watch 와 같은 규율 — 일정 등록은 OP 몫, 이 PR 은 등록하지 않는다).
//
// 세 얼굴:
//   관측 = debug.log('self-observe', 'observed', { window, denied, correctionMail, pendingMail, promotions })
//   판단 근거 = SelfObservation 숫자 표 ⊕ 승격 후보(서명 · 계수 · 마지막 관측)
//   산출 = 회고 한 줄(retroLine) · 후보별 칸 초안 문면(formatSelfObservation · --json 은 SelfObservation 그대로)

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Command } from 'commander';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { parseDuration } from '../input-core/audit-tail.js';
import { canonicalSeatId, readUnreadCount } from '../msg/msg-store.js';
import { writeStdoutJson } from './stdout-json.js';

// ── 상수(집계 규칙 — 출처: OP 명령 ELN-OP-SELF-HEAL-1123 각 층) ─────────────────────────────────────

/** 1층 ①: 자기 도구 거부는 이 주체의 문이다 — eln 이 도구(agent body)로 문을 두드렸을 때의 주체. */
export const SELF_TOOL_PRINCIPAL = 'eln:tool';
/** 1층 ①: 거부로 세는 판정치 — 문 거부(denied)와 실행기 거부(executor-refused) 둘 다 «내가 막혔다». */
export const SELF_DENIAL_RESULTS: readonly string[] = ['denied', 'executor-refused'];
/** 2층: 같은 꼴 2회 = 결함으로 승격 — 1회는 사건, 2회는 꼴이다. */
export const SELF_HEAL_PROMOTION_REPEATS = 2;
/** 1층 ③: 내 결정 충돌 표지 — 이 낱말을 담은 우편은 «정정/철회된 지시» 관측으로 센다. */
export const SELF_CORRECTION_WORDS: readonly string[] = ['정정', '철회'];
/** 1층 ①: 기본 시간창 — OP 명령 원문이 «--since 1h» 로 관측을 정의한다. */
export const SELF_OBSERVE_DEFAULT_SINCE = '1h';
/** 대기 우편을 세는 기본 자리 — 칸 정의가 «eln OP 상주 루프» 이므로 관측 주체는 OP 이다. */
export const SELF_OBSERVE_DEFAULT_SEAT = 'OP';
/** 관측 debug.log 범주. */
export const SELF_OBSERVE_LOG_CATEGORY = 'self-observe';

// ── 형태 ────────────────────────────────────────────────────────────────────────────────

/** control-audit.jsonl 한 줄(집계가 쓰는 부분집합). ts 는 ISO-8601, at 은 epoch-ms(작성기 쌍). */
export interface SelfAuditRow {
  ts: string;
  principal?: string;
  kind?: string;
  action?: string;
  result?: string;
  reason?: string;
  sha256?: string;
  at?: number;
}

/** 우편 원장 한 줄 — msg_messages 의 created_at ⊕ body(정정/철회 계수에 필요한 최소판). */
export interface SelfMailRow {
  createdAt: string;
  body: string;
}

/** 2층 산출 — 결함 승격 후보(칸 초안 문면 포함). 실행은 아니다. */
export interface SelfPromotionCandidate {
  readonly signature: string;
  readonly cellId: string;
  readonly repeats: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly reason: string;
  readonly sha256: string;
  readonly draft: string;
}

/** 1층+2층 산출 — 회고 표 «관측» 칸의 숫자들. 측정불가는 0 이 아니라 null 이다(측정불가 ≠ 0). */
export interface SelfObservation {
  readonly since: string;
  readonly until: string;
  readonly denied: number;
  readonly correctionMail: number | null;
  readonly pendingMail: number | null;
  readonly promotionCandidates: readonly SelfPromotionCandidate[];
  /** ts 를 해석할 수 없어 창 안팎을 판정 못 한 감사 줄 수 — 버린 것이 아니라 못 잰 것이다. */
  readonly undatedAudit: number;
}

// ── 파서(문자열 입력 — 시험은 인라인 픽스처로, 실기는 파일/DB 어댑터가 같은 문자열을 만든다) ─────────────

/** JSONL → SelfAuditRow. 빈 줄·깨진 줄은 건너뛴다(한 줄이 깨져도 나머지 창은 산다). */
export function parseSelfAuditRows(text: string): SelfAuditRow[] {
  const rows: SelfAuditRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value !== null && typeof value === 'object' && typeof (value as { ts?: unknown }).ts === 'string') {
        rows.push(value as SelfAuditRow);
      }
    } catch { /* 한 줄이 깨진 것은 그 줄의 결함이다 — 전체 창을 버리지 않는다 */ }
  }
  return rows;
}

/** JSONL → SelfMailRow. 빈 줄·깨진 줄·createdAt 없는 줄은 건너뛴다. */
export function parseSelfMailRows(text: string): SelfMailRow[] {
  const rows: SelfMailRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value !== null && typeof value === 'object' && typeof (value as { createdAt?: unknown }).createdAt === 'string') {
        rows.push(value as SelfMailRow);
      }
    } catch { /* 우편 한 줄이 깨져도 나머지 창은 센다 */ }
  }
  return rows;
}

// ── 시간창 ───────────────────────────────────────────────────────────────────────────────

/** `--since 1h`·`30m` 같은 기간 또는 ISO 날짜를 [since, until] ISO 창으로. 양 끝은 닫힌다(경계값 포함). */
export function selfObserveWindow(since: string | undefined, now: Date): { since: string; until: string } {
  const untilMs = now.getTime();
  if (!Number.isFinite(untilMs)) throw new Error('invalid --since: current time is not finite');
  const raw = (since ?? SELF_OBSERVE_DEFAULT_SINCE).trim();
  const durationMs = parseDuration(raw);
  const sinceMs = durationMs !== null ? untilMs - durationMs : Date.parse(raw);
  if (!Number.isFinite(sinceMs)) throw new Error(`invalid --since: ${raw}`);
  if (sinceMs > untilMs) throw new Error(`invalid --since: start (${raw}) is after now`);
  return { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() };
}

/** 창 판정 — ts 가 창 안(양 끝 포함)인가. 파싱 실패는 undefined(미측정, 제외 아님). */
function withinWindow(ts: string, window: { since: string; until: string }): boolean | undefined {
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return undefined;
  return at >= Date.parse(window.since) && at <= Date.parse(window.until);
}

// ── 2층: 서명·승격 ───────────────────────────────────────────────────────────────────────

/** 사유 정규화 — 공백 접기 ⊕ 숫자 일반화(uid·카운트 같은 매번 다른 값은 꼴이 아니다). */
export function normalizeDenialReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().replace(/\d+/g, '#');
}

/**
 * 반복 꼴 서명 = 정규화 키 — 문 종류(action) ⊕ 판정(result) ⊕ 정규화 사유 ⊕ 명령/도구 해시(sha256).
 * 같은 명령이 같은 사유로 두 번 막히면 같은 서명이 두 번 관측된다(ELN-OP-SELF-HEAL-1123 2층).
 */
export function denialSignature(row: SelfAuditRow): string {
  return [
    row.action ?? '',
    row.result ?? '',
    normalizeDenialReason(row.reason ?? ''),
    row.sha256 ?? '',
  ].join('|');
}

/** 서명 → 칸 이름. ELN-OP-SELF-<서명 8자리> — 같은 꼴이면 같은 이름이 돼야 추적이 닫힌다. */
export function selfHealCellId(signature: string): string {
  return `ELN-OP-SELF-${createHash('sha256').update(signature).digest('hex').slice(0, 8).toUpperCase()}`;
}

/** 칸 초안 문면 — 붙여 넣으면 그대로 실행될 한 줄. 이 모듈은 이 문면을 «출력»만 한다(실행 금지). */
export function promotionDraft(cellId: string, nextVersion: string, repeats: number, signature: string, reason: string, lastAt: string): string {
  return `ELANOUS_TRACK=OP eln release checklist add ${cellId} --version ${nextVersion}`
    + ` — 근거: ELN-OP-SELF-HEAL-1123 2층 «같은 꼴 ${repeats}회 = 결함 승격» · 서명 ${signature}`
    + ` · 사유 ${reason || '(없음)'} · 마지막 관측 ${lastAt}`;
}

/** 현재 판 → 다음 판(«--version <다음판>»): 0.3.34-dev.0 → 0.3.35. 전개판(배포본)은 그대로 1 올린다. */
export function nextReleaseVersion(current: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.]+)?$/.exec(current.trim());
  if (!match) throw new Error(`invalid version for next release: ${current}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

// ── 1층+2층 집계(순수 — 모든 입력은 주입, 시험은 인라인 문자열로) ─────────────────────────────────

/**
 * 관측 집계: 창 안 거부 계수 · 정정/철회 우편 계수 · 대기 우편 수 · 반복 꼴 승격 후보.
 * 우편 원장을 못 읽으면 mailRows=null — 그때 correctionMail 은 0 이 아니라 null(측정불가)이다.
 */
export function observeSelfSignals(input: {
  readonly window: { since: string; until: string };
  readonly auditRows: readonly SelfAuditRow[];
  readonly mailRows: readonly SelfMailRow[] | null;
  readonly pendingMail: number | null;
  readonly nextVersion: string;
}): SelfObservation {
  const { window } = input;
  let denied = 0;
  let undatedAudit = 0;
  const bySignature = new Map<string, { repeats: number; firstAt: string; lastAt: string; reason: string; sha256: string }>();
  for (const row of input.auditRows) {
    const inside = withinWindow(row.ts, window);
    if (inside === undefined) { undatedAudit++; continue; }
    if (!inside) continue;
    if (row.principal !== SELF_TOOL_PRINCIPAL || !SELF_DENIAL_RESULTS.includes(row.result ?? '')) continue;
    denied++;
    const signature = denialSignature(row);
    const slot = bySignature.get(signature);
    if (slot) {
      slot.repeats++;
      if (row.ts > slot.lastAt) slot.lastAt = row.ts;
      if (row.ts < slot.firstAt) slot.firstAt = row.ts;
    } else {
      bySignature.set(signature, { repeats: 1, firstAt: row.ts, lastAt: row.ts, reason: row.reason ?? '', sha256: row.sha256 ?? '' });
    }
  }
  const promotionCandidates = [...bySignature.entries()]
    .filter(([, slot]) => slot.repeats >= SELF_HEAL_PROMOTION_REPEATS)
    .map(([signature, slot]) => {
      const cellId = selfHealCellId(signature);
      return {
        signature,
        cellId,
        repeats: slot.repeats,
        firstAt: slot.firstAt,
        lastAt: slot.lastAt,
        reason: slot.reason,
        sha256: slot.sha256,
        draft: promotionDraft(cellId, input.nextVersion, slot.repeats, signature, slot.reason, slot.lastAt),
      };
    })
    .sort((a, b) => b.repeats - a.repeats || a.lastAt.localeCompare(b.lastAt) || a.signature.localeCompare(b.signature));
  let correctionMail: number | null = null;
  if (input.mailRows !== null) {
    correctionMail = 0;
    for (const mail of input.mailRows) {
      const inside = withinWindow(mail.createdAt, window);
      if (inside !== true) continue;
      if (SELF_CORRECTION_WORDS.some(word => mail.body.includes(word))) correctionMail++;
    }
  }
  return { since: window.since, until: window.until, denied, correctionMail, pendingMail: input.pendingMail, promotionCandidates, undatedAudit };
}

// ── 렌더 ────────────────────────────────────────────────────────────────────────────────

/** 회고 입력 한 줄 — 매시 회고 표 «관측» 칸에 이 문자열을 그대로 넣는다. 측정불가는 숫자 대신 말로. */
export function retroLine(observation: SelfObservation): string {
  const value = (count: number | null): string => count === null ? '측정불가' : String(count);
  return `관측 ${observation.since} — ${observation.until}`
    + `: 도구거부 ${observation.denied} · 정정/철회 ${value(observation.correctionMail)}`
    + ` · 대기우편 ${value(observation.pendingMail)} · 승격후보 ${observation.promotionCandidates.length}`;
}

/** 사람 출력 — 회고 한 줄 + 후보별 칸 초안(실행 아님). */
export function formatSelfObservation(observation: SelfObservation): string {
  const lines = [retroLine(observation)];
  for (const candidate of observation.promotionCandidates) {
    lines.push(`결함 승격 후보 ${candidate.cellId} — 서명 ${candidate.signature} · 창 내 ${candidate.repeats}회 · 마지막 ${candidate.lastAt}`);
    lines.push(`  칸 초안(실행 아님 — 붙여넣기 전에 사람이 본다): ${candidate.draft}`);
  }
  return lines.join('\n');
}

// ── 읽기 어댑터(실기 — 전부 읽기 전용) ────────────────────────────────────────────────────────

/** `<state>/els/control-audit.jsonl` 전문. 없으면 빈 창(문이 한 번도 안 적은 것이다 — 0 거부). */
export function readControlAuditText(root: string = elanousStateRoot()): string {
  const path = join(root, 'els', 'control-audit.jsonl');
  try { return readFileSync(path, 'utf8'); }
  catch { return ''; }
}

/** 창 안 우편(created_at ⊕ body) — msg 원장을 못 읽으면 null(측정불가). SQL 예비거르기는 ISO 문자열 정렬에 의존하고(모든 created_at 이 toISOString 류라 사전식=시간순), 최종 창 판정은 코어의 Date.parse 가 다시 한다. */
export function readCorrectionMailRows(window: { since: string; until: string }, root: string = elanousStateRoot()): SelfMailRow[] | null {
  const path = join(root, 'msg', 'messages.db');
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    try {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='msg_messages'").get()) return null;
      return db.query('SELECT created_at AS createdAt, body FROM msg_messages WHERE created_at >= ?')
        .all(window.since) as SelfMailRow[];
    } finally { db.close(); }
  } catch { return null; }
}

/** 자리의 대기(안 읽은) 우편 수 — msg-store 의 기존 단일 창구를 그대로 쓴다. 못 읽으면 null. */
export function readPendingMailCount(seat: string, root: string = elanousStateRoot()): number | null {
  return readUnreadCount(canonicalSeatId(seat), join(root, 'msg', 'messages.db'));
}

/** 현재 판(package.json version) — 다음 판 계산의 입력. */
export function readCurrentVersion(repo: string = resolve(import.meta.dir, '../..')): string {
  const raw = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof raw.version !== 'string' || !raw.version.trim()) throw new Error('package.json version is missing');
  return raw.version;
}

// ── CLI — 기존 `self` 명령군에 얹는다(새 최상위 명령 금지 · dependence 게이지와 같은 이음새) ─────────────

export interface SelfObserveDeps {
  readonly now?: () => Date;
  /** 상태 뿌리(`<state>/els` · `<state>/msg` 가 여기 산다). */
  readonly root?: string;
  readonly readAudit?: (root: string) => string;
  readonly readMail?: (window: { since: string; until: string }, root: string) => SelfMailRow[] | null;
  readonly readPending?: (seat: string, root: string) => number | null;
  readonly readVersion?: () => string;
  readonly out?: Pick<Console, 'log'>;
  /**
   * 셀프힐링 칸 생성 실행기 — 3층의 미래 이음새. 이 PR 은 어디서도 부르지 않는다(산출물이 초안인 이유).
   * 반증 시험이 스파이로 «호출 0회»를 잠근다: 승격 후보가 나와도 초안은 출력일 뿐 실행이 아니다.
   */
  readonly createSelfHealCell?: (draft: string, candidate: SelfPromotionCandidate) => void | Promise<void>;
}

function handle(action: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(action).catch(error => {
    console.error(`self observe: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

/** `elanous self observe [--since 1h] [--seat OP] [--json]` — 읽기만 한다. 원장 쓰기 0. */
export function registerSelfObserveCommand(self: Command, deps: SelfObserveDeps = {}): void {
  self.command('observe')
    .description('ELN-OP-SELF-HEAL-LOOP — 자기 관측 집계(도구 거부 · 정정/철회 우편 · 대기 우편 → 회고 한 줄 · 반복 꼴 칸 초안은 출력만)')
    .option('--since <duration-or-date>', `Start of window: duration (e.g. 1h) or ISO date (default ${SELF_OBSERVE_DEFAULT_SINCE})`, SELF_OBSERVE_DEFAULT_SINCE)
    .option('--seat <id>', `Seat whose pending mail is counted (default ${SELF_OBSERVE_DEFAULT_SEAT})`, SELF_OBSERVE_DEFAULT_SEAT)
    .option('--json', 'JSON output')
    .action((opts: { since: string; seat: string; json?: boolean }) => handle(async () => {
      const now = (deps.now ?? (() => new Date()))();
      const root = deps.root ?? elanousStateRoot();
      const window = selfObserveWindow(opts.since, now);
      const observation = observeSelfSignals({
        window,
        auditRows: parseSelfAuditRows((deps.readAudit ?? readControlAuditText)(root)),
        mailRows: (deps.readMail ?? readCorrectionMailRows)(window, root),
        pendingMail: (deps.readPending ?? readPendingMailCount)(opts.seat, root),
        nextVersion: nextReleaseVersion((deps.readVersion ?? readCurrentVersion)()),
      });
      debug.log(SELF_OBSERVE_LOG_CATEGORY, 'observed', {
        window, denied: observation.denied, correctionMail: observation.correctionMail,
        pendingMail: observation.pendingMail, promotions: observation.promotionCandidates.length,
        undatedAudit: observation.undatedAudit, seat: opts.seat,
      });
      if (opts.json) { await writeStdoutJson(JSON.stringify(observation) + '\n'); return; }
      // 줄별 호출 — 회고 한 줄과 후보 줄이 한 out.log 호출에 합쳐지지 않는다(소비자는 줄 단위로 본다).
      for (const line of formatSelfObservation(observation).split('\n')) (deps.out ?? console).log(line);
    }));
}
