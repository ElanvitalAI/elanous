/**
 * COORD-ENTRANCE-FOLD · 0.2.42 칸 · TASK-AGENT(OP 디스패처) — 셸 디스패처 은퇴 결정 카드.
 *
 * 배경: 대표 10-19 «중간층(런 닥터 r3·rework · 입구 디스패처)이 0.2.35 최우선 병목» ·
 * seat-state/OP/PLAN-mid-tier-loops-2026-10-19.md §5.
 *
 * 판정 신호: 조율자 그림자가 ④ 빌더로 같은 칸·같은 지시서를 달력 기준 3일 연속
 * 디스패치하면 «셸 디스패처 은퇴» 결정 카드를 기존 결정 원장(src/decisions/decision-ledger.ts,
 * `decisions/decisions.jsonl`) 부가 형식 그대로 정확히 1장 올린다.
 *
 * 그림자 디스패치 원장(<root>/seat-state/OP/coordinator-shadow-dispatch.jsonl)은
 * 조율자 그림자 디스패처가 한 줄씩 적는 JSONL 이다:
 *   {"date":"2026-03-02","agent":"builder-4","cell":"src/x/y.ts","directive":"DIR-123"}
 * (별칭 허용: date=day · agent=target · cell=lane · directive=directiveId)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DecisionLedger } from '../../decisions/decision-ledger.js';
import { withFileLockSync } from '../../storage/file-lock.js';
import { findGitDir } from '../../git-fs/locate.js';

export interface CoordinatorShadowDispatch {
  /** 달력 날짜(YYYY-MM-DD, 생산 기록은 UTC ISO 날짜). */
  date: string;
  /** 대상 에이전트(예: builder-4). */
  agent: string;
  /** 작업을 받은 과제 소유 seat (`tasks hand --seat`). */
  recipient?: string;
  /** 칸(대상 경로). */
  cell: string;
  /** 지시서 id. */
  directive: string;
}

export interface CoordinatorShadowStreak {
  agent: string;
  recipient?: string;
  cell: string;
  directive: string;
  /** 연속을 이룬 세 달력 날짜(직전2일·오늘, 오름차순). */
  dates: [string, string, string];
}

export interface CoordinatorShadowTickOptions {
  /** 저장소/worktree 루트 — 그림자 디스패치 원장 기준 경로. 생산 기본: cwd 트리. */
  root?: string;
  /** 결정 원장 stateDir. 생산 기본: elanousStateRoot(). */
  stateDir?: string;
  /** 시계 주입(생산: 실제 Date). */
  now?: () => Date;
  /** 원장 행 직접 주입(시험용 — 생산 호출 경로는 그대로 지나간다). */
  dispatches?: CoordinatorShadowDispatch[];
}

export interface CoordinatorShadowTickResult {
  /** 판정 기준일(YYYY-MM-DD). */
  checked: string;
  evidence: CoordinatorShadowStreak | null;
  /** 올라간(또는 이미 있던) 결정 카드 id. */
  cardId?: string;
  /** 같은 스탬프(칸+지시서+마지막 날) 카드가 이미 있어 1장만 유지됐을 때. */
  skipped?: 'duplicate';
}

/** 그림자 디스패치 원장 생산 기본 경로. */
export function coordinatorShadowJournalPath(root: string): string {
  return join(root, 'seat-state', 'OP', 'coordinator-shadow-dispatch.jsonl');
}

/** Resolve the containing checkout when the CLI was started from a repository subdirectory. */
export function resolveCoordinatorShadowRoot(cwd = process.cwd()): string {
  return findGitDir(cwd)?.root ?? cwd;
}

/** launcher가 work-order를 받아들인 뒤 그림자 근거만 덧붙인다. 발사 결정·인자는 읽거나 바꾸지 않는다. */
export function recordCoordinatorShadowDispatch(
  root: string,
  row: CoordinatorShadowDispatch,
): void {
  const path = coordinatorShadowJournalPath(root);
  mkdirSync(dirname(path), { recursive: true });
  withFileLockSync(`${path}.lock`, () => appendFileSync(path, `${JSON.stringify(row)}\n`));
}

/** ④ 빌더 판별 — «빌더④» «④빌더» «builder-4» «builder_4» «builder 4» «b4» 계열을 받는다. */
function fourthBuilderAgentKey(agent: string): string | null {
  const key = agent.normalize('NFC').replace(/\s+/g, '').toLowerCase();
  return /^(?:builder|b)[-_]?4$/.test(key) || /^④?빌더4$/.test(key) || key === '④빌더' || key === '빌더④'
    ? 'builder-4'
    : null;
}

export function isFourthBuilderAgent(agent: string): boolean {
  return fourthBuilderAgentKey(agent) !== null;
}

function shiftDay(isoDay: string, delta: number): string {
  const date = new Date(`${isoDay}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 조율자 그림자 디스패치 기록에서 오늘과 직전 2일치를 읽어,
 * 대상이 ④ 빌더이고 칸·지시서가 같은 달력 기준 3일 연속인 모든 쌍을 반환한다.
 * 연속 끊김(칸·지시서·대상이 다르거나 하루 무디스패치)이면 해당 streak 는 성립하지 않는다.
 */
export function detectBuilderThreeDayStreak(
  dispatches: readonly CoordinatorShadowDispatch[],
  today: string,
): CoordinatorShadowStreak | null {
  return detectBuilderThreeDayStreaks(dispatches, today)[0] ?? null;
}

/** 오늘의 3일 창에서 모든 적격 (agent, cell, directive) 쌍을 돌려 각 쌍의 카드를 독립 판정한다. */
export function detectBuilderThreeDayStreaks(
  dispatches: readonly CoordinatorShadowDispatch[],
  today: string,
): CoordinatorShadowStreak[] {
  if (!DAY_PATTERN.test(today)) throw new Error(`calendar day required: ${today}`);
  const window: [string, string, string] = [shiftDay(today, -2), shiftDay(today, -1), today];
  const groups = new Map<string, { agent: string; recipient?: string; recipientDate?: string; cell: string; directive: string; days: Set<string> }>();
  for (const row of dispatches) {
    if (!row || typeof row.date !== 'string' || !DAY_PATTERN.test(row.date)) continue;
    const builderKey = fourthBuilderAgentKey(String(row.agent ?? ''));
    if (!builderKey) continue;
    const recipient = typeof row.recipient === 'string' ? row.recipient : undefined;
    const cell = String(row.cell ?? '');
    const directive = String(row.directive ?? '');
    if (!cell || !directive) continue;
    const key = `${builderKey}\u0000${cell}\u0000${directive}`;
    const group = groups.get(key) ?? { agent: row.agent, cell, directive, days: new Set<string>() };
    if (recipient && window.includes(row.date as typeof window[number])
      && (!group.recipientDate || row.date >= group.recipientDate)) {
      group.recipient = recipient;
      group.recipientDate = row.date;
    }
    group.days.add(row.date);
    groups.set(key, group);
  }
  const keys = [...groups.keys()].sort();
  return keys.flatMap(key => {
    const group = groups.get(key)!;
    return window.every(day => group.days.has(day))
      ? [{ agent: group.agent, ...(group.recipient ? { recipient: group.recipient } : {}), cell: group.cell, directive: group.directive, dates: [...window] as [string, string, string] }]
      : [];
  });
}

function readDispatchJournal(path: string): CoordinatorShadowDispatch[] {
  if (!existsSync(path)) return [];
  const rows: CoordinatorShadowDispatch[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    // JSON.parse 가 성공하는 비객체 행(`null`·스칼라 등)도 파손 행이다 — 판독에서 건너뛴다.
    if (typeof raw !== 'object' || raw === null) continue;
    const date = raw.day ?? raw.date;
    const agent = raw.target ?? raw.agent;
    const recipient = raw.recipient ?? raw.seat;
    const cell = raw.lane ?? raw.cell;
    const directive = raw.directiveId ?? raw.directive;
    if (typeof date === 'string' && typeof agent === 'string' && typeof cell === 'string' && typeof directive === 'string') {
      rows.push({ date, agent, ...(typeof recipient === 'string' ? { recipient } : {}), cell, directive });
    }
  }
  return rows;
}

/** «셸 디스패처 은퇴» 결정 카드의 영구 idempotency ref(같은 칸+지시서에는 한 장만). */
export function retirementCardStamp(evidence: CoordinatorShadowStreak): string {
  return `coordinator-shadow-streak:${evidence.cell}:${evidence.directive}`;
}

/**
 * 조율자 루프의 하루 틱 — 그림자 디스패치 3일 연속 판정 → 셸 디스패처 은퇴 결정 카드 1장.
 * 카드는 기존 결정 원장(DecisionLedger.raise) 부가 형식 그대로 append 되고,
 * 같은 3일 창에서 성립한 모든 칸+지시서 쌍을 각자 판정하고, 카드가 이미 있으면 재사용한다.
 * (날짜가 바뀌어도 쌍마다 1장 유지).
 */
export async function tick(options: CoordinatorShadowTickOptions = {}): Promise<CoordinatorShadowTickResult> {
  const root = resolveCoordinatorShadowRoot(options.root ?? process.cwd());
  const now = options.now ?? (() => new Date());
  const dispatches = options.dispatches ?? readDispatchJournal(coordinatorShadowJournalPath(root));
  const today = now().toISOString().slice(0, 10);
  const evidences = detectBuilderThreeDayStreaks(dispatches, today);
  const evidence = evidences[0] ?? null;
  if (!evidence) return { checked: today, evidence: null };

  const ledger = new DecisionLedger({ ...(options.stateDir ? { stateDir: options.stateDir } : {}), now, repoRoot: root });
  const outcomes = evidences.map(item => {
    const stamp = retirementCardStamp(item);
    const alreadyRaised = ledger.list({ status: 'all' }).some(entry =>
      Array.isArray(entry.refs) && entry.refs.includes(stamp));
    const entry = ledger.raiseOnce({
      title: `셸 디스패처 은퇴 — ${item.cell} × ${item.directive} 3일 연속`,
      category: 'other',
      scqa: {
        s: '조율자 그림자가 ④ 빌더로 같은 칸·같은 지시서를 달력 기준 3일 연속 디스패치했다.',
        c: '중간층 입구 디스패처가 같은 지시를 반복 산출하는 0.2.35 최우선 병목 신호가 실측됐다.',
        q: '셸 디스패처를 은퇴시키고 입구를 조율자 그림자로 고정할까?',
        a: '셸 디스패처 은퇴 결정 카드를 원장에 올리고 후속 조치를 연다.',
      },
      options: [
        { key: 'a', label: '은퇴 승인', consequence: '입구 디스패처를 조율자 그림자로 고정하고 셸 디스패처를 은퇴시킨다' },
        { key: 'b', label: '관찰 연장', consequence: '은퇴를 보류하고 3일 연속 판정 관찰을 계속한다' },
      ],
      recommendation: { option: 'a', why: '같은 칸·같은 지시서가 달력 기준 3일 연속 — 판정 신호 충족' },
      raisedBy: { agent: 'orchestrator-tick', track: 'OP' },
      refs: [
        stamp,
        `agent:${item.agent}`,
        ...(item.recipient ? [`recipient:${item.recipient}`] : []),
        `cell:${item.cell}`,
        `directive:${item.directive}`,
        `dates:${item.dates.join(',')}`,
      ],
    }, stamp);
    return { evidence: item, cardId: entry.id, alreadyRaised };
  });
  return { checked: today, evidence, cardId: outcomes[0]!.cardId,
    ...(outcomes.every(outcome => outcome.alreadyRaised) ? { skipped: 'duplicate' as const } : {}) };
}
