// ── PR 리뷰 반응 standing 폴러 (L3 · 2026-07-23) ─────────────────────────────
//
// PLAN-review-reactive-completion-loop-2026-07-23 · P4(L3 standing).
// review-loop(L1/L2)은 사람이 1회 트리거해야 했다. L3 는 그 트리거조차 무인화한다:
//   opt-in 라벨(auto-review)이 붙은 열린 PR 을 주기 폴링 → **새 사람 리뷰**를 감지하면
//   자동으로 runReviewLoop(pr) 발동(→ codex rework → tsc/test → ACP 심판 → 자율머지).
//
// 안전 경계(무인 자율):
//   - opt-in 라벨만: 대표가 라벨을 붙인 PR 만 대상. 라벨 없으면 절대 안 건드림(HITL=라벨 결정).
//   - 무한루프 방지: review-loop 이 남긴 자동 코멘트(이모지 마커)는 봇 신호로 skip → 사람 리뷰만 트리거.
//   - dedup 커서: pr_review_state(pr PK, last_review_key) — 이미 처리한 리뷰 재발동 안 함.
//   - rate limit: 사이클당 최대 maxTriggers 건(기본 1·codex 미션 동시 1개 제약).
//
// 재사용: repo-watch.ts(폴링·sqlite 커서·주입 seam 패턴)·runReviewLoop(발동 대상·완성)·gh CLI.
// 이 모듈은 순수 판정 + 주입 gh/db/trigger. 실행: `elanous agent-mission review-watch`(CLI·index.ts · `codex` 는 하위호환 alias).
// 거버넌스: 운영 데몬 미배선(테스트격리 폴러). standing cron 등록은 대표(운영) 몫.

import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { AUTO_REVIEW_LABEL } from '../self-implement/context-capsule.js';
import { resolveReworkBackendChoice, runReviewLoop, type ReviewLoopOpts, type ReviewLoopResult, type ReviewVerdict } from './review-loop.js';
import type { ReviewResult } from '../agent-substrate/pr-reviewer.js';

/** 1차 리뷰 결과(ReviewResult) → review-loop injectedReview. fail→reinforce(mustFix)·pass/warn→ok(clean). 순수. */
export function mapReviewToInjected(r: ReviewResult): { verdict: ReviewVerdict; asks: string[] } {
  if (r.verdict === 'fail') return { verdict: 'reinforce', asks: r.mustFix };
  return { verdict: 'ok', asks: [] };
}

/** [ISO] ELANOUS_STATE_DIR 존중(lazy) — 테스트격리 시 .elanous-test 로 스코프. */
// ⚠️ 상태 경로 codex-mission 유지(agent-agnostic 리네임에도) — 기존 워치 DB 고아화 방지. 코드만 agent-mission.
export function prReviewWatchDbPath(): string { return join(elanousStateRoot(), 'codex-mission/pr_review_watch.db'); }

/** opt-in 기본 라벨 — 대표가 이 라벨을 붙인 PR 만 무인 발동 대상. CLI --label 로 오버라이드.
 *  SSoT=self-implement 의 AUTO_REVIEW_LABEL(G8 자기판단이 부착·L3 폴러가 감시 — 같은 라벨). */
export const DEFAULT_WATCH_LABEL = AUTO_REVIEW_LABEL;

/**
 * review-loop 이 남기는 자동 코멘트의 프리픽스 마커. 이 마커로 시작하는 최신 코멘트는
 * 봇 신호로 간주해 skip 한다(자기가 남긴 코멘트를 새 리뷰로 오인 → 무한루프 방지의 핵심).
 * review-loop.ts 가 실제로 남기는 프리픽스와 동기화(✅ 반영·🔁 rework·🛑 park·⚠️ 미완·❓ 모호).
 */
export const AUTO_COMMENT_MARKERS = ['✅', '🔁', '🛑', '⚠️', '❓', '📥'] as const;

/** review-loop 이 `gh pr review --approve`에 쓰는 고정 self-review 헤드라인. */
const AUTO_REVIEW_HEADLINES = ['✅ 자동 리뷰 승인(LGTM):'] as const;

/** renderReview가 PR comment로 내보내는 세 verdict 헤드라인. */
const AUTO_PR_REVIEW_HEADLINE = /^(?:✅|⚠️|⛔) 자율 PR 리뷰: (?:PASS|WARN|FAIL)\b/;

/** GitHub 봇 계정 — gh 인증 계정(사람)으로 남긴 자동 코멘트는 body 마커로 걸러야 함(아래 isBotSignal). */
export const BOT_LOGINS = new Set(['github-actions[bot]', 'codex[bot]', 'dependabot[bot]']);

// ──────────────────── 순수 판정 로직 ─────────────────────

/** 자동 신호 판별. comment는 선두 마커와 자율 PR 리뷰 헤드라인을, review는 고정 self-approval 헤드라인만 사용한다. */
export function isBotSignal(author: string, body: string, mode: 'comment' | 'review' = 'comment'): boolean {
  if (BOT_LOGINS.has(author)) return true;
  const trimmed = body.trimStart();
  if (mode === 'review') return AUTO_REVIEW_HEADLINES.some(headline => trimmed.startsWith(headline));
  return AUTO_COMMENT_MARKERS.some(marker => trimmed.startsWith(marker)) || AUTO_PR_REVIEW_HEADLINE.test(trimmed);
}

export interface ReviewSignal {
  /** dedup 커서 키 — 리뷰 submittedAt / 코멘트 createdAt(ISO). 같으면 이미 처리. */
  key: string;
  author: string;
  body: string;
  /** 봇 자동 신호 아님(=사람 리뷰) → 트리거 후보. */
  isHuman: boolean;
}

interface RawReviews {
  reviews?: Array<{ body?: string; author?: { login?: string }; submittedAt?: string }>;
  comments?: Array<{ body?: string; author?: { login?: string }; createdAt?: string }>;
}

/** gh json → 최신(newest) 리뷰/코멘트 1개를 신호로. 본문 없는 건 무시. 없으면 null. */
export function pickLatestSignal(raw: RawReviews): ReviewSignal | null {
  const entries: Array<{ key: string; author: string; body: string; mode: 'comment' | 'review' }> = [];
  for (const r of raw.reviews ?? []) {
    const body = (r.body ?? '').trim();
    if (body && r.submittedAt) entries.push({ key: r.submittedAt, author: r.author?.login ?? 'unknown', body, mode: 'review' });
  }
  for (const c of raw.comments ?? []) {
    const body = (c.body ?? '').trim();
    if (body && c.createdAt) entries.push({ key: c.createdAt, author: c.author?.login ?? 'unknown', body, mode: 'comment' });
  }
  if (entries.length === 0) return null;
  // newest-first (ISO 문자열 사전순 == 시간순).
  entries.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const top = entries[0]!;
  return { key: top.key, author: top.author, body: top.body, isHuman: !isBotSignal(top.author, top.body, top.mode) };
}

// ──────────────────── IO (gh 폴링·상태 db) ──────────────────────────────

export type RunGh = (args: string[]) => string;

export type ReviewWatchGhErrorKind = 'auth' | 'not-found' | 'missing-binary' | 'other';

export class ReviewWatchGhError extends Error {
  readonly name = 'ReviewWatchGhError';

  constructor(readonly kind: ReviewWatchGhErrorKind, message: string, cause?: unknown) {
    super(message, { cause });
  }
}

/** gh CLI 실패의 stderr와 spawn 오류를 구분한다. 분류 이외의 호출/재시도 정책은 호출부가 결정한다. */
export function classifyReviewWatchGhError(error: unknown): ReviewWatchGhError {
  if (error instanceof ReviewWatchGhError) return error;
  const details = error && typeof error === 'object' ? error as { message?: unknown; stderr?: unknown; code?: unknown } : {};
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  const stderr = details.stderr == null ? '' : String(details.stderr);
  const text = `${stderr}\n${message}`;
  let kind: ReviewWatchGhErrorKind = 'other';
  if (details.code === 'ENOENT' || /\b(?:gh:\s*)?command not found\b|\bgh:\s*not found\b|\bspawn gh ENOENT\b|\bexecutable file not found\b/i.test(text)) {
    kind = 'missing-binary';
  } else if (/\b401\b|\bunauthorized\b|\bbad credentials\b|\bnot logged in\b|\bgh auth login\b|\bauthenticat(?:e|ion)\b/i.test(text)) {
    kind = 'auth';
  } else if (/\b404\b|\bnot found\b/i.test(text)) {
    kind = 'not-found';
  }
  return new ReviewWatchGhError(kind, stderr.trim() || message, error);
}

// env: process.env — cron/launchd 최소 PATH 에서도 ensure-bin-path 가 보강한 PATH 로 gh(/opt/homebrew/bin)를
// 찾도록 명시 전달(Bun 은 env 미전달 시 startup 스냅샷 PATH 로 해석 → 무음실패).
const defaultRunGh: RunGh = (args) => execFileSync('gh', args, { encoding: 'utf-8', timeout: 60_000, maxBuffer: 20 * 1024 * 1024, env: process.env });

export function openPrReviewWatchDb(path: string = prReviewWatchDbPath()): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS pr_review_state(
    pr TEXT PRIMARY KEY, last_review_key TEXT, last_seen TEXT
  )`);
  return db;
}

export function getLastReviewKey(db: Database, pr: string): string | null {
  const row = db.prepare(`SELECT last_review_key FROM pr_review_state WHERE pr=?`).get(pr) as { last_review_key: string | null } | undefined;
  return row?.last_review_key ?? null;
}

export function setLastReviewKey(db: Database, pr: string, key: string, now: string): void {
  db.run(`INSERT INTO pr_review_state(pr, last_review_key, last_seen) VALUES (?,?,?)
          ON CONFLICT(pr) DO UPDATE SET last_review_key=excluded.last_review_key, last_seen=excluded.last_seen`,
    [pr, key, now]);
}

/** opt-in 라벨이 붙은 열린 PR 번호 목록(READ-ONLY 배치). 조회 실패는 분류해 전달한다. */
export function fetchLabeledOpenPrs(label: string, deps: { runGh?: RunGh } = {}): string[] {
  const runGh = deps.runGh ?? defaultRunGh;
  try {
    const out = runGh(['pr', 'list', '--state', 'open', '--label', label, '--limit', '100', '--json', 'number']);
    const rows = JSON.parse(out || '[]') as Array<{ number: number }>;
    return rows.map(r => String(r.number));
  } catch (e) {
    // ⚠️ gh 실패를 무음으로 []로 삼키면 (gh not-in-PATH·auth·network) 라벨 PR 이 항상 0 으로 보여 파이프라인이
    //   조용히 사문화된다(이 버그의 근본). 반드시 관측을 남긴다 — 조회 0 이 '진짜 0' 인지 'gh 실패' 인지 구분.
    const error = classifyReviewWatchGhError(e);
    debug.log('review-watch', 'list-prs-error', { label, error: error.message, kind: error.kind }, { level: 'error' });
    throw error;
  }
}

/** PR 의 최신 리뷰/코멘트 신호 조회(READ-ONLY). 실패=null. */
export function fetchLatestSignal(pr: string, deps: { runGh?: RunGh } = {}): ReviewSignal | null {
  const runGh = deps.runGh ?? defaultRunGh;
  try {
    const out = runGh(['pr', 'view', pr, '--json', 'reviews,comments']);
    return pickLatestSignal(JSON.parse(out) as RawReviews);
  } catch {
    return null;
  }
}

/** 최신 사람(비봇) 신호 — 리뷰는 무본문(bare APPROVE/REQUEST_CHANGES)도 인정, 코멘트는 본문 있는 것만.
 *  봇 계정/자동마커(self-dev 자기 코멘트) 제외. 트리거 판정의 기준(더 최신 봇 신호는 무시). */
export function pickLatestHumanSignal(raw: RawReviews): ReviewSignal | null {
  const entries: Array<{ key: string; author: string; body: string }> = [];
  for (const r of raw.reviews ?? []) {
    const author = r.author?.login ?? 'unknown';
    const body = (r.body ?? '').trim();
    if (r.submittedAt && !isBotSignal(author, body, 'review')) entries.push({ key: r.submittedAt, author, body });
  }
  for (const c of raw.comments ?? []) {
    const author = c.author?.login ?? 'unknown';
    const body = (c.body ?? '').trim();
    if (body && c.createdAt && !isBotSignal(author, body)) entries.push({ key: c.createdAt, author, body });
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)); // newest-first
  const top = entries[0]!;
  return { key: top.key, author: top.author, body: top.body, isHuman: true };
}

/** PR 신호 분석 — 최신 신호(봇 포함·관측/skip-bot 표기용) + 최신 사람 신호(트리거 판정용·봇 무시). */
export interface SignalAnalysis { latest: ReviewSignal | null; latestHuman: ReviewSignal | null; }
export function analyzeSignals(raw: RawReviews): SignalAnalysis {
  return { latest: pickLatestSignal(raw), latestHuman: pickLatestHumanSignal(raw) };
}

/** PR 신호 분석 조회(READ-ONLY). 조회 실패는 분류해 전달한다. */
export function fetchSignalAnalysis(pr: string, deps: { runGh?: RunGh } = {}): SignalAnalysis {
  const runGh = deps.runGh ?? defaultRunGh;
  try {
    return analyzeSignals(JSON.parse(runGh(['pr', 'view', pr, '--json', 'reviews,comments'])) as RawReviews);
  } catch (e) {
    throw classifyReviewWatchGhError(e);
  }
}

// ──────────────────── 오케스트레이션 (1사이클) ──────────────────────────

export interface PrReviewWatchDeps {
  runGh?: RunGh;
  db?: Database;
  now?: () => string;
  /** 감시 대상 opt-in 라벨(기본 auto-review). */
  label?: string;
  /** 사이클당 최대 발동 건수(기본 1·codex rate limit). */
  maxTriggers?: number;
  /** review-loop 발동 옵션(--final-judge/--auto-merge 등). */
  reviewLoopOpts?: ReviewLoopOpts;
  /** 발동 함수(주입 seam·기본 runReviewLoop). dry-run 이면 no-op 주입. */
  trigger?: (pr: string, opts: ReviewLoopOpts) => Promise<ReviewLoopResult | null>;
  /** ★ 자동 초기리뷰어(§2b) — 리뷰가 아직 없는 라벨 PR 에 1차 리뷰를 발동(사람 0 파이프라인). */
  autoInitialReview?: boolean;
  /** 1차 리뷰 seam — PR 번호 → {verdict, asks}(review-loop injectedReview). 기본=reviewPullRequest(CLI 주입·null=리뷰 실패). */
  initialReviewer?: (pr: string) => Promise<{ verdict: ReviewVerdict; asks: string[] } | null>;
}

export interface PrReviewWatchOutcome {
  pr: string;
  /** triggered=발동함 · signal-error=해당 PR 신호 조회 실패 · initial-review-failed=초기리뷰 시도 후 null 반환 · initial-review-error=초기리뷰 예외 · dedup=이미 처리한 리뷰 · bot=자동신호 skip · none=신호없음 · capped=발동한도 초과 대기. */
  status: 'triggered' | 'signal-error' | 'initial-review-failed' | 'initial-review-error' | 'dedup' | 'bot' | 'none' | 'capped';
  error?: ReviewWatchGhErrorKind;
  reviewKey?: string;
  result?: ReviewLoopResult | null;
}

const defaultTrigger = (pr: string, opts: ReviewLoopOpts) => runReviewLoop(pr, opts);

/** 감시 1사이클 — 라벨 PR 폴링 → 새 사람 리뷰 감지 → runReviewLoop 발동(사이클당 maxTriggers 건). */
export async function runPrReviewWatchCycle(deps: PrReviewWatchDeps = {}): Promise<PrReviewWatchOutcome[] & { authErrors: number }> {
  const db = deps.db ?? openPrReviewWatchDb();
  const ownDb = !deps.db;
  const now = deps.now?.() ?? new Date().toISOString();
  const label = deps.label ?? DEFAULT_WATCH_LABEL;
  const maxTriggers = deps.maxTriggers ?? 1;
  const trigger = deps.trigger ?? defaultTrigger;
  const reviewLoopOpts = deps.reviewLoopOpts ?? {};
  const ghDep = deps.runGh ? { runGh: deps.runGh } : {};

  const outcomes: PrReviewWatchOutcome[] = [];
  let triggered = 0;
  let authErrors = 0;
  try {
    let prs: string[];
    try {
      prs = fetchLabeledOpenPrs(label, ghDep);
    } catch (e) {
      const error = classifyReviewWatchGhError(e);
      debug.log('review-watch', 'cycle-failed', { label, error: error.kind }, { level: 'error' });
      throw error;
    }
    const rework = resolveReworkBackendChoice(reviewLoopOpts);
    debug.log('review-watch', 'cycle-start', {
      label, prs: prs.length, maxTriggers,
      reworkBackend: rework.backend,
      reworkBackendSource: rework.source,
    });

    for (const pr of prs) {
      let analysis: SignalAnalysis;
      try {
        analysis = fetchSignalAnalysis(pr, ghDep);
      } catch (e) {
        const error = classifyReviewWatchGhError(e);
        if (error.kind === 'auth') authErrors++;
        debug.log('review-watch', 'signal-error', { pr, kind: error.kind, error: error.message }, { level: 'error' });
        outcomes.push({ pr, status: 'signal-error', error: error.kind });
        continue;
      }
      const { latest, latestHuman } = analysis;
      // ★ 트리거 판정은 '최신 미처리 사람 신호(latestHuman)' 기준 — 봇/자기 자동 신호는 무시한다.
      //   ⚠️ self-dev PR 은 내부 리뷰노드/자동 코멘트를 gh 인증 계정(사람 계정)으로 남겨 봇 신호(마커)를
      //   갖는다. '최신 절대 신호'로 판정하면 (a) 봇 신호가 최신이라 skip-bot dead-end(triggered=0 상시의
      //   근본), (b) 사람 리뷰 뒤 봇 코멘트가 오면 유효 사람 리뷰를 영영 못 소비한다. 사람 신호만 골라 판정.
      if (!latestHuman) {
        // 사람 리뷰/코멘트가 하나도 없음 = person-0 초기리뷰 대상(신호 전무 or 봇/자기 신호만).
        if (deps.autoInitialReview && deps.initialReviewer) {
          const priorKey = getLastReviewKey(db, pr);
          if (priorKey?.startsWith('initial:')) {
            // 이미 1차 리뷰를 발동함 — 이후는 review-loop 이 진행(자기 자동 코멘트로 재초기리뷰 방지).
            outcomes.push({ pr, status: 'dedup', reviewKey: priorKey });
            continue;
          }
          if (triggered >= maxTriggers) { outcomes.push({ pr, status: 'capped' }); continue; }
          debug.log('review-watch', 'initial-review-start', { pr, ...(latest ? { priorSignal: latest.author } : {}) });
          let ir: { verdict: ReviewVerdict; asks: string[] } | null;
          try { ir = await deps.initialReviewer(pr); }
          catch (e) {
            debug.log('review-watch', 'initial-review-error', { pr, error: (e as Error).message }, { level: 'error' });
            outcomes.push({ pr, status: 'initial-review-error' });
            continue;
          }
          if (!ir) {
            debug.log('review-watch', 'initial-review-null', { pr }, { level: 'warn' });
            outcomes.push({ pr, status: 'initial-review-failed' });
            continue;
          }
          {
            let result: ReviewLoopResult | null = null;
            try { result = await trigger(pr, { ...reviewLoopOpts, injectedReview: ir }); }
            catch (e) { debug.log('review-watch', 'trigger-error', { pr, error: (e as Error).message }, { level: 'error' }); }
            setLastReviewKey(db, pr, `initial:${now}`, now); // 재초기리뷰 방지 커서
            triggered++;
            debug.log('review-watch', 'initial-reviewed', { pr, verdict: ir.verdict, action: result?.action ?? 'error' });
            outcomes.push({ pr, status: 'triggered', reviewKey: `initial:${now}`, result });
            continue;
          }
        }
        // auto-initial-review 미설정 — 신호 전무=none·봇 신호만=skip-bot(관측). 초기리뷰 null 반환은 위에서 initial-review-failed로 기록한다.
        if (!latest) { outcomes.push({ pr, status: 'none' }); continue; }
        debug.log('review-watch', 'skip-bot', { pr, author: latest.author });
        outcomes.push({ pr, status: 'bot', reviewKey: latest.key });
        continue;
      }
      // 사람 신호 존재 → 최신 미처리 사람 신호로 발동(더 최신 봇 신호는 무시).
      const lastKey = getLastReviewKey(db, pr);
      if (latestHuman.key === lastKey) { outcomes.push({ pr, status: 'dedup', reviewKey: latestHuman.key }); continue; }

      // 새(미처리) 사람 리뷰 — 발동 후보. rate limit 초과면 다음 사이클로(커서 안 건드림).
      if (triggered >= maxTriggers) {
        debug.log('review-watch', 'capped', { pr, triggered, maxTriggers });
        outcomes.push({ pr, status: 'capped', reviewKey: latestHuman.key });
        continue;
      }

      debug.log('review-watch', 'new-review', { pr, author: latestHuman.author, reviewKey: latestHuman.key, bodyChars: latestHuman.body.length });
      let result: ReviewLoopResult | null = null;
      try {
        result = await trigger(pr, reviewLoopOpts);
      } catch (e) {
        debug.log('review-watch', 'trigger-error', { pr, error: (e as Error).message }, { level: 'error' });
      }
      // 발동한 사람 신호 키로 커서 갱신 — 같은 리뷰 재발동 방지(새 사람 리뷰가 와야 재발동).
      setLastReviewKey(db, pr, latestHuman.key, now);
      triggered++;
      debug.log('review-watch', 'triggered', { pr, reviewKey: latestHuman.key, action: result?.action ?? 'error' });
      outcomes.push({ pr, status: 'triggered', reviewKey: latestHuman.key, result });
    }
    debug.log('review-watch', 'cycle-done', { label, scanned: prs.length, triggered, authErrors });
    return Object.assign(outcomes, { authErrors });
  } finally {
    if (ownDb) db.close();
  }
}
