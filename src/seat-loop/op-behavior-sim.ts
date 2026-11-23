// OP-BEHAVIOR-SIM-EVAL (OP 배정 P0 · 0.3.34 · 19:5x «시뮬 월드·테스트 우주·이벤트 합성으로 확인»)
// 오늘 실사고 6개 중 OP 트리아지(#135500)가 정한 오늘 범위 2개(우편 30통 폭주 · 되돌릴 수 있는 결정급
// 질문)를 이벤트로 합성해 격리 우주에서 점수화한다. 기준선 main 정책 vs SEAT-OPERATING-CONTRACT(CX-4) 정책의
// 전후 숫자를 원장 원문(요청 원장 done/pending 행 · 시트 원장 at/status/inquiry 행)에서 계측한다.
// 두 층 — ① 루프(제품): runSeatLoopOnce 실구동(OP 가지는 op-판정 후보를 관측하고 조기 반환, 우편에는 손을
// 대지 않는다 — 오늘 실사고 «우편 30통이 도구 경계에서 대기»의 제품 코드 경로 그대로). ② 자리 턴(정책 시뮬):
// 제품이 계약을 구현하기 전까지 하네스가 자리 행동 정책을 적용한다 — 기준선 = 오늘 실제 자리 행동(폭주 우편
// 한 통씩 한 턴 · 결정급 질문은 사람에게 물음), 계약 = 묶음 1턴 종결 · 가역 자결(사람에게 물음 0 ·
// OP #135418). 종결은 실제 closeSeatRequests(done) 로 요청 원장에 남긴다. 실제 LLM 자리 턴(제품 프롬프트) 연결은
// 0.3.35 P0 전체 6 시나리오 e2e 로 이관(#135500).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendSeatRequestRows, closeSeatRequests, listSeatRequests, type SeatRequestRow } from '../seat-dispatch/seat-request-ledger.js';
import { runSeatLoopOnce, seatLedgerPath, type SeatDeps } from './seat-loop.js';
import type { SeatEntry, SeatItem } from './seat-loop.js';

export const INCIDENT_SCENARIOS = [
  { id: 'mail-flood-30', kind: 'mail-flood', title: '우편 30통 폭주', count: 30 },
  { id: 'approval-prompt', kind: 'approval-prompt', title: '승인 프롬프트' },
  { id: 'tool-rejection', kind: 'tool-rejection', title: '도구 거부' },
  { id: 'landing-zero', kind: 'landing-zero', title: '착지 0' },
  { id: 'crown-question', kind: 'crown-question', title: '결정급 질문' },
  { id: 'long-session-2h', kind: 'long-session', title: '2시간 긴 세션', minutes: 120 },
] as const;
export type IncidentScenarioId = (typeof INCIDENT_SCENARIOS)[number]['id'];

/** SEAT-OPERATING-CONTRACT(CX-4) 계약 정책 — 완료선은 «사람에게 물음 0 · 묶음 처리»(OP #135418). */
export type SeatOperatingPolicy = {
  /** 묶음 처리 — 폭주 우편을 한 턴에 묶는다(기준선은 한 통 한 턴). */
  bundleMail: boolean;
  /** 사람에게 물음 허용 여부 — 계약 적용 = 금지(가역 질문은 자리가 결정). */
  askHuman: boolean;
  /** 보류 시 재시도 예약 — 계약 적용 = 시도 없는 보류를 0으로 만든다. */
  retryDeferred: boolean;
};
export const BASELINE_POLICY: SeatOperatingPolicy = { bundleMail: false, askHuman: true, retryDeferred: false };
export const CONTRACT_POLICY: SeatOperatingPolicy = { bundleMail: true, askHuman: false, retryDeferred: true };

const SIM_AT = '2026-11-23T18:00:00.000Z';

/** 하네스 합성 우편의 발신자 — 제품 SeatItem.from(자리 SeatId)에 사람(CEO) 발신을 더한 시뮬 전용 확장(제품 타입 무변경). */
export type SimFrom = NonNullable<SeatItem['from']> | 'CEO';
/** 시뮬 합성 우편 — crown-question 은 사람(CEO) 발신이므로 from 을 하네스에서만 넓힌다. */
export type SimSeatItem = Omit<SeatItem, 'from'> & { from?: SimFrom };
/** 시뮬 원장 행 — item 에 하네스 확장 발신자를 그대로 담는다(JSON 원문으로 굽는다 · 제품 SeatEntry 와 필드 호환). */
export type SimSeatEntry = Omit<SeatEntry, 'item'> & { item?: SeatItem | SimSeatItem };

/** 실사고 1건을 격리 우주에 주입할 SeatItem(들)로 합성한다. 시험·러너 모두 이 함수로 입력을 만든다. */
export function incidentSeatItems(scenarioId: IncidentScenarioId): SimSeatItem[] {
  switch (scenarioId) {
    case 'mail-flood-30': {
      const out: SimSeatItem[] = [];
      for (let i = 1; i <= 30; i++) {
        out.push({
          source: 'request', kind: 'request',
          id: `sim-mail-${String(i).padStart(2, '0')}`,
          title: `폭주 우편 ${i}`,
          text: `일상 상태 보고 ${i} — 회신 불필요 (OP-BEHAVIOR-SIM-EVAL 합성 이벤트)`,
          createdAt: SIM_AT, from: 'TC',
        });
      }
      return out;
    }
    case 'approval-prompt':
      return [{
        source: 'hook', kind: 'hook-task',
        id: 'sim-approval-eln-read',
        title: '승인 프롬프트',
        text: 'eln 읽기 명령(eln release checklist status)이 승인 프롬프트로 5분+ 블록 — 우편 3통이 도구 경계에서 대기(ELN-APPROVAL-WAIT-BLOCKS-TURN)',
        createdAt: SIM_AT,
      }];
    case 'tool-rejection':
      return [{
        source: 'request', kind: 'request',
        id: 'sim-tool-reject',
        title: '도구 거부',
        text: 'RunShell script step 거부 — 실행파일 허용목록 밖 단계로 판정 요청',
        createdAt: SIM_AT, from: 'TC',
      }];
    case 'landing-zero':
      return [{
        source: 'checklist', kind: 'cell',
        id: 'sim-landing-zero',
        title: '착지 0',
        text: '게이트 PASS 판정 PR 들이 전부 착지 0 — OP 폴러 대기 중 셀 상태 갱신',
        status: 'yellow', version: '0.3.34',
        createdAt: SIM_AT,
      }];
    case 'crown-question':
      // 실제 사고 형태 그대로 — 결정급 질문은 우편(MsgPost)으로 자리에 온다. 루프의 seat-question 크로스체크
      // 경로가 아니라 요청 원장 경로로 합성해 «받은 질문» 자체를 시나리오 입력으로 쓴다.
      return [{
        source: 'request', kind: 'request',
        id: 'sim-crown-decision',
        title: '결정급 질문',
        text: '0.3.34 컷 연기 여부 — 되돌릴 수 있는 결정급 질문(가역)',
        createdAt: SIM_AT, from: 'CEO',
      }];
    case 'long-session-2h':
      return [{
        source: 'request', kind: 'request',
        id: 'sim-long-session',
        title: '2시간 긴 세션',
        text: '한 턴 2시간 — 12시간 세션 교대 규칙과 만나는 긴 세션',
        createdAt: SIM_AT, from: 'TC',
      }];
  }
}

export type SimUsageRow = { inputTokens: number; outputTokens?: number };
export type SimScore = {
  /** 인터럽트 수 — 원장에서 관측되는 중단(launched 뒤 outcome-unknown) 행 수. */
  interrupts: number;
  /** 시도 없는 보류 — wait/held/awaiting-answer 로 물린 항목 중 이후 재시도(attempting/launched/queued)가 없는 것. */
  deferralsWithoutRetry: number;
  /** 턴 수 — 서로 다른 at 값 개수. */
  turns: number;
  /** 턴당 입력 토큰 — inputTokens 합 / 턴 수. */
  inputTokensPerTurn: number;
  /** 사람에게 물은 수 — asked/hitl/inquiry 행. 계약 완료선은 0(OP #135418). */
  humanQuestions: number;
  /** 미시도 우편 — 구동 뒤에도 요청 원장에 pending/queued 로 남는 행 수(OP 조기 반환 경로 실측). */
  unattemptedRequests: number;
  /** 처리 완료 — 요청 원장에서 status='done' 으로 닫힌 행 수(closeSeatRequests 원문 기준). */
  processedRequests: number;
};
export type SimScoredRun = { scenario: string; score: SimScore };

const RETRY_STATUSES: ReadonlyArray<SeatEntry['status']> = ['attempting', 'launched', 'queued'];
const DEFERRAL_STATUSES: ReadonlyArray<SeatEntry['status']> = ['wait', 'held', 'awaiting-answer'];

/** 시트 루프 원장(SeatEntry) · llm.usage 행 · 요청 원장 행으로 시나리오 1회분을 점수화한다 — 숫자는 전부 원문에서 센다. */
export function scoreIncidentRun(entries: readonly SeatEntry[], usageRows: readonly SimUsageRow[], requestRows: readonly SeatRequestRow[] = []): SimScore {
  const turns = new Set(entries.map((e) => e.at)).size;
  const interrupts = entries.filter((e) => e.status === 'outcome-unknown').length;
  let deferralsWithoutRetry = 0;
  entries.forEach((entryRow, i) => {
    if (!DEFERRAL_STATUSES.includes(entryRow.status)) return;
    const id = entryRow.item?.id;
    if (!id) return;
    const retried = entries.slice(i + 1).some(
      (later) => later.item?.id === id && RETRY_STATUSES.includes(later.status),
    );
    if (!retried) deferralsWithoutRetry += 1;
  });
  const humanQuestions = entries.filter(
    (e) => e.status === 'asked' || e.status === 'hitl' || e.inquiry !== undefined,
  ).length;
  const inputTokens = usageRows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  return {
    interrupts,
    deferralsWithoutRetry,
    turns,
    inputTokensPerTurn: turns > 0 ? inputTokens / turns : 0,
    humanQuestions,
    unattemptedRequests: requestRows.filter((row) => row.status === 'pending' || row.status === 'queued').length,
    processedRequests: requestRows.filter((row) => row.status === 'done').length,
  };
}

/** 기준선 main vs 계약 적용 전후 숫자 비교표(OP #135418 «영수에 전후 숫자»). 마크다운 표 줄 배열. */
export function compareRuns(baseline: readonly SimScoredRun[], contract: readonly SimScoredRun[]): string[] {
  const lines = [
    '| 시나리오 | 지표 | 기준선 main | 계약 적용 |',
    '| --- | --- | --- | --- |',
  ];
  for (const base of baseline) {
    const applied = contract.find((r) => r.scenario === base.scenario);
    if (!applied) continue;
    lines.push(`| ${base.scenario} | 턴 수 | ${base.score.turns} | ${applied.score.turns} |`);
    lines.push(`| ${base.scenario} | 인터럽트 | ${base.score.interrupts} | ${applied.score.interrupts} |`);
    lines.push(`| ${base.scenario} | 시도 없는 보류 | ${base.score.deferralsWithoutRetry} | ${applied.score.deferralsWithoutRetry} |`);
    lines.push(`| ${base.scenario} | 사람에게 물음 | ${base.score.humanQuestions} | ${applied.score.humanQuestions} |`);
    lines.push(`| ${base.scenario} | 미시도 우편 | ${base.score.unattemptedRequests} | ${applied.score.unattemptedRequests} |`);
    lines.push(`| ${base.scenario} | 처리 완료(done) | ${base.score.processedRequests} | ${applied.score.processedRequests} |`);
    lines.push(
      `| ${base.scenario} | 턴당 입력 토큰 | ${base.score.inputTokensPerTurn} | ${applied.score.inputTokensPerTurn} |`,
    );
  }
  return lines;
}

export type IncidentRunOptions = {
  /** 격리 우주 루트(--config-dir 격리와 같은 축 — 임시 디렉터리를 권장). */
  root: string;
  policy: SeatOperatingPolicy;
  /** 구동 틱 수(기본 6 — now() 가 틱마다 여러 번 불려 시계가 흐르므로, 자정을 넘어 원장 파일이 굽히기 전에 끝나는 범위). */
  ticks?: number;
  /** 틱당 시계 진행 분(기본 1 — long-session 은 120). */
  minutesPerTick?: number;
  /** 추가 SeatDeps 주입(격리 시험용 슬림). */
  deps?: Partial<SeatDeps>;
};

/** 시나리오 1개를 격리 우주에서 구동한다 — 합성 이벤트를 요청 원장에 뿌리고 runSeatLoopOnce 를 틱 수만큼 돌려 원장을 점수화한다. */
export async function runIncidentScenario(
  scenarioId: IncidentScenarioId,
  opts: IncidentRunOptions,
): Promise<{ entries: SeatEntry[]; score: SimScore; scenario: string }> {
  const { root, policy } = opts;
  const ticks = opts.ticks ?? 6;
  const minutesPerTick = opts.minutesPerTick ?? (scenarioId === 'long-session-2h' ? 120 : 1);
  let clock = new Date('2026-11-23T18:00:00.000Z');
  const now = () => {
    clock = new Date(clock.getTime() + minutesPerTick * 60_000);
    return clock;
  };
  const read = (path: string): string => {
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
  };
  const items = incidentSeatItems(scenarioId);
  const rowFor = (item: SimSeatItem, text: string): SeatRequestRow => ({
    key: item.id, seat: 'OP', status: 'pending', text, queuedAt: '2026-11-23T18:00:00.000Z',
  });
  const requestPath = join(root, 'seat-requests', 'requests.jsonl');
  // 양쪽 다리에 «같은 30통» 이 도착한다 — 계약 다리도 입력을 미리 묶지 않는다(묶음은 자리 턴이 한다).
  appendSeatRequestRows(requestPath, items
    .filter((i) => i.source === 'request' || i.source === 'hook')
    .map((i) => rowFor(i, `${i.title} — ${i.text}`)));
  const deps: SeatDeps = {
    root, repo: root, now, read,
    config: { mode: 'on', seats: ['OP'] },
    versions: () => (scenarioId === 'landing-zero' ? ['0.3.34'] : []),
    schedules: () => (scenarioId === 'landing-zero' ? [{ version: '0.3.34', cutAt: '2099-01-01T00:00:00Z' }] : []),
    checklistItems: () => scenarioId === 'landing-zero'
      ? [{ id: 'sim-landing-zero', title: '착지 0', status: 'yellow' }]
      : [],
    pullRequests: async () => [],
    // 기준선 정책만 사람에게 물을 수 있다 — 계약 적용은 자리가 결정한다(«사람에게 물음 0»).
    inquire: policy.askHuman
      ? (seat, item) => ({ to: 'CEO', question: `${item.title} — 결정급 확인 요청` })
      : () => null,
    run: async () => '',
    ...opts.deps,
  };
  // ── 자리 턴 정책 시뮬(SEAT-OPERATING-CONTRACT #135418 — 제품 구현 전까지 하네스가 자리 행동을 적용) ──
  // 기준선 = 오늘 실제 자리 행동(폭주 우편 한 통씩 한 턴 · 결정급 질문은 사람에게 물음).
  // 계약 = 묶음 1턴 종결 · 가역 결정 자결(사람에게 물음 0). 종결은 실제 closeSeatRequests(done) 로 원문에 남는다.
  let simTurnDone = false;
  const appendSimEntry = (entry: SimSeatEntry) => {
    const ledgerFile = seatLedgerPath('OP', root, clock);
    mkdirSync(dirname(ledgerFile), { recursive: true });
    appendFileSync(ledgerFile, `${JSON.stringify(entry)}\n`);
  };
  const openRows = () => listSeatRequests(root, { seat: 'OP' })
    .filter((row) => row.status === 'pending' || row.status === 'queued');
  const seatAgentTurn = () => {
    const open = openRows();
    if (!open.length || simTurnDone) return;
    if (scenarioId === 'mail-flood-30') {
      if (policy.bundleMail) {
        simTurnDone = true;
        const at = now().toISOString();
        const covered = open.map((row) => row.key);
        const bundleItem: SeatItem = {
          source: 'request', kind: 'request', id: 'sim-mail-bundle', title: '우편 30통 묶음',
          text: `계약 묶음 처리 — ${covered.length}통을 1턴에 종결: ${covered.join(', ')}`,
        };
        appendSimEntry({ seat: 'OP', at, status: 'attempting', item: bundleItem, reason: '계약 — 묶음 처리(한 턴에 전부)' });
        appendSimEntry({ seat: 'OP', at, status: 'resolved', item: bundleItem, reason: `묶음 종결 ${covered.length}통 — 사람에게 물음 0` });
        closeSeatRequests(root, covered, { reason: `계약 묶음 처리 — sim-mail-bundle 1턴 종결(${covered.length}통)`, status: 'done', now: clock });
      } else {
        const next = open[0]!;
        const item = items.find((i) => i.id === next.key);
        if (!item) return;
        const at = now().toISOString();
        appendSimEntry({ seat: 'OP', at, status: 'attempting', item, reason: '기준선 자리 행동 — 한 통씩 한 턴' });
        appendSimEntry({ seat: 'OP', at, status: 'resolved', item, reason: '회신 불필요 상태 보고 — 읽고 종결' });
        closeSeatRequests(root, [next.key], { reason: '기준선 자리 턴 — 개별 종결', status: 'done', now: clock });
      }
      return;
    }
    if (scenarioId === 'crown-question') {
      const item = items[0]!;
      simTurnDone = true;
      const at = now().toISOString();
      if (policy.askHuman) {
        appendSimEntry({ seat: 'OP', at, status: 'asked', item, inquiry: { to: 'CEO', question: `${item.title} — 결정급 확인 요청` }, reason: '기준선 자리 행동 — 결정급 질문은 사람에게' });
      } else {
        appendSimEntry({ seat: 'OP', at, status: 'attempting', item, reason: '계약 — 가역 결정은 자리가 자결' });
        appendSimEntry({ seat: 'OP', at, status: 'resolved', item, reason: '가역 자결: 컷 유지 — 되돌림 조건(게이트 RED 시 철회) 원장 기록' });
        closeSeatRequests(root, [item.id], { reason: '계약 자결 — 가역 결정 기록 후 종결', status: 'done', now: clock });
      }
    }
  };
  const seenWait = new Set<string>();
  for (let tick = 0; tick < ticks; tick++) {
    await runSeatLoopOnce('OP', deps);
    seatAgentTurn();
    if (policy.retryDeferred) {
      // 계약 정책 — 보류 즉시 재시도: wait 로 물린 항목을 다시 pending 으로 뿌려 시도 없는 보류를 0으로 만든다.
      const ledger = readLedgerEntries(root, now());
      for (const e of ledger) {
        if (DEFERRAL_STATUSES.includes(e.status) && e.item?.id && !seenWait.has(e.item.id)) {
          seenWait.add(e.item.id);
          const original = items.find((i) => i.id === e.item!.id);
          if (original) appendSeatRequestRows(requestPath, [rowFor(original, `${original.title} — ${original.text}`)]);
        }
      }
    }
  }
  const entries = readLedgerEntries(root, now());
  return { entries, score: scoreIncidentRun(entries, [], listSeatRequests(root, { seat: 'OP' })), scenario: scenarioId };
}

/** 우주 루트의 OP 시트 루프 원장을 읽어 SeatEntry 배열로 돌려준다(당일 파일만). */
export function readLedgerEntries(root: string, at: Date): SeatEntry[] {
  const path = seatLedgerPath('OP', root, at);
  if (!existsSync(path)) return [];
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  if (!raw.trim()) return [];
  return raw.trim().split('\n').map((line) => JSON.parse(line) as SeatEntry);
}
