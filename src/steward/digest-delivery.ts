/**
 * 스튜어드 발송 모듈 — 흐름 판정 변화 브리핑(OVW-BRIEF · RFC §A4·§A7).
 *
 * §A4 — 브리핑은 판정이 «마지막으로 브리핑한 값»과 달라질 때만 한 줄.
 * §A7 — 경계값 플래핑 방지: «2연속» 같은 판정으로 관측될 때만 발송.
 * 발송 킨드 = `ops-report`(운영 봇) — 스튜어드 digest 와 같은 통로, 트레이딩 봇으로는 내려가지 않는다.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { collectOverview, parseSince } from '../ops/overview-collect.js';
import { VERDICT_LABEL, VERDICTS, computeVerdict, type OverviewSnapshot, type Verdict, type VerdictResult } from '../ops/overview.js';

/** 브리핑 상태 파일 — 인스턴스 루트 기준 상대 경로. */
export const VERDICT_BRIEF_STATE = 'steward/verdict-brief.json';

export interface VerdictBriefState {
  /** 마지막 관측 판정 — streak 를 센다. */
  lastObserved: Verdict | null;
  /** 마지막으로 «브리핑을 보낸» 판정 — 이 값과 같으면 다시 보내지 않는다(§A4). */
  lastBriefed: Verdict | null;
  /** lastObserved 가 «연속»으로 관측된 횟수 — 2 이상이어야 발송한다(§A7). */
  streak: number;
}

export function emptyVerdictBriefState(): VerdictBriefState {
  return { lastObserved: null, lastBriefed: null, streak: 0 };
}

/** 판정 한 번 관측 — 같은 판정이면 streak 를 쌓고, 다른 판정이면 1로 되돌린다. */
export function observeVerdict(state: VerdictBriefState, observed: Verdict): VerdictBriefState {
  if (state.lastObserved === observed) return { ...state, streak: state.streak + 1 };
  return { lastBriefed: state.lastBriefed, lastObserved: observed, streak: 1 };
}

/** 발송 조건 — §A7(2연속 관측) ⊕ §A4(마지막 브리핑과 다른 판정). */
export function briefDue(state: VerdictBriefState): boolean {
  return state.streak >= 2 && state.lastObserved !== state.lastBriefed;
}

/** 브리핑 한 줄 — 새 판정 ⊕ 이전 판정(있으면) ⊕ 첫 사유 ⊕ 첫 다음 행동. */
export function formatVerdictBrief(current: VerdictResult, previous: Verdict | null): string {
  const one = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const reason = one(current.reasons[0]);
  const next = one(current.nextActions[0]);
  const from = previous ? ` (이전 ${VERDICT_LABEL[previous]})` : '';
  return `스튜어드 흐름 · 판정 변화 ${VERDICT_LABEL[current.verdict]}${from}${reason ? ` · ${reason}` : ''}${next ? ` · 다음: ${next}` : ''}`;
}

export interface VerdictBriefDeps {
  /** 판정 계산용 스냅샷 — 기본: `elanous ops overview` CLI 와 같은 창(최근 1h)으로 수집. */
  collect?: () => Promise<OverviewSnapshot>;
  /** 브리핑 발송 — 기본: 킨드 `ops-report`(운영 봇)으로 직접 발송. */
  send?: (text: string) => Promise<void>;
  /** 상태 파일 경로 — 기본: <root>/steward/verdict-brief.json. */
  statePath?: string;
}

export function verdictBriefStatePath(root: string): string {
  return join(root, VERDICT_BRIEF_STATE);
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

function readBriefState(path: string): VerdictBriefState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<VerdictBriefState>;
    if (isVerdict(raw.lastObserved) && (raw.lastBriefed == null || isVerdict(raw.lastBriefed)) && typeof raw.streak === 'number') {
      return { lastObserved: raw.lastObserved, lastBriefed: raw.lastBriefed ?? null, streak: raw.streak };
    }
  } catch {
    /* 상태가 없거나 깨졌으면 새로 시작한다 — 다음 관측이 streak 를 다시 쌓는다. */
  }
  return emptyVerdictBriefState();
}

function writeBriefState(path: string, state: VerdictBriefState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** 스튜어드 운영 발송 — 킨드 `ops-report`(운영 봇). digest 와 같은 통로, 다른 줄. */
export async function sendStewardReport(text: string): Promise<void> {
  const { deliver } = await import('../domains/outbound-alert.js');
  if (!deliver(text, 'ops-report')) throw new Error('steward report delivery failed');
}

/**
 * 흐름 판정을 관측해, «2연속 같은 판정»이 «마지막 브리핑과 다를 때»만 한 줄을 보낸다(§A4·§A7).
 * 관측(streak)은 항상 상태로 남고, 마지막 브리핑 값은 발송 성공 뒤에만 진행한다 —
 * 실패한 브리핑은 다음 틱의 같은 판정 관측이 재시도한다.
 * @returns 보낸 브리핑 원문 — 이번 관측에서 보내지 않았으면 null.
 */
export async function briefVerdictChange(root: string, deps: VerdictBriefDeps = {}): Promise<string | null> {
  const collect = deps.collect ?? defaultCollect;
  const snapshot = await collect();
  const result = computeVerdict(snapshot);
  const statePath = deps.statePath ?? verdictBriefStatePath(root);
  const state = readBriefState(statePath);
  const observed = observeVerdict(state, result.verdict);
  if (!briefDue(observed)) {
    writeBriefState(statePath, observed);
    debug.log('steward.verdict-brief', 'held', { verdict: result.verdict, streak: observed.streak });
    return null;
  }
  const text = formatVerdictBrief(result, state.lastBriefed);
  await (deps.send ?? sendStewardReport)(text);
  writeBriefState(statePath, { ...observed, lastBriefed: result.verdict });
  debug.log('steward.verdict-brief', 'sent', { verdict: result.verdict, previous: state.lastBriefed });
  return text;
}

async function defaultCollect(): Promise<OverviewSnapshot> {
  const { ms, label } = parseSince(undefined);
  return collectOverview({ sinceMs: ms, sinceLabel: label });
}
