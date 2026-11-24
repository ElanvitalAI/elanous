// OP-BEHAVIOR-E2E (OP 배정 P0 · 0.3.34 «시뮬 월드·테스트 우주·이벤트 합성으로 확인» — 시나리오 하네스 먼저 PR)
// 1차(op-behavior-sim.ts)가 자리 턴을 정책 함수로 시뮬한 6개 실사고를, 이번엔 **진짜 eln Next TUI 를
// 격리 우주에 띄워** 돌린다: 실제 부팅 → 실제 MsgStore 우편 → 실제 깨움 턴 → 실제 도구 경계(승인
// 프롬프트·HarnessAskUser) → 실제 debug 원장. 외부 모델만 test-fake-llm 로 갈음한다(격리 무대 env —
// 진짜 TUI PTY 시험들·게이트 포드와 같은 판). 실제 공급자 실행은 ELANOUS_OP_BEHAVIOR_E2E_REAL
// 게이트 뒤에만(전체 6 시나리오 e2e 는 0.3.35 P0 #135500).
// 점수화는 원장 원문에서: 턴 수·인터럽트 = turn-life 행(시작/끝 짝짓기), 턴당 입력 토큰 = llm.usage 행,
// 사람에게 물음 = HarnessAskUser 실제 호출(세션 전사), 처리/미시도 = 캡처에 닿은 우편 마커.
// 표(compareRuns)·시나리오 합성(incidentSeatItems)·정책(SeatOperatingPolicy)은 1차 것을 그대로 재사용한다.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { mockSeatPtySequence, type ScreenUntil, type SeatPtySequenceEvidence, type SeatPtyStep } from '../ux-sim/mock-seat-pty-sequence.js';
import {
  compareRuns,
  incidentSeatItems,
  type IncidentScenarioId,
  type SeatOperatingPolicy,
  type SimScore,
  type SimScoredRun,
  type SimUsageRow,
} from './op-behavior-sim.js';

export { BASELINE_POLICY, CONTRACT_POLICY, compareRuns, incidentSeatItems, INCIDENT_SCENARIOS } from './op-behavior-sim.js';
export type { IncidentScenarioId, SeatOperatingPolicy, SimScore, SimScoredRun } from './op-behavior-sim.js';
export type { ScreenUntil, SeatPtySequenceEvidence, SeatPtyStep } from '../ux-sim/mock-seat-pty-sequence.js';

/** 실제 공급자 e2e 게이트 — 이 env 가 켜져 있을 때만 진짜 모델 호출을 허용한다(하네스 시험은 항상 fake). */
export const E2E_REAL_PROVIDER_GATE = 'ELANOUS_OP_BEHAVIOR_E2E_REAL';

/** 격리 우주 — c6-boot-backlog 배치 그대로: 좌석 루트가 cwd·state 루트, home 은 별도(ELANOUS_SKIP_LOGIN_ENV 는 무대가 기본으로 건다). */
export type E2EUniverse = {
  /** 우주 루트 — 지우면 전부 사라진다. */
  universeRoot: string;
  /** staged TUI 의 cwd 이자 격리 state root(seats/<seat>). */
  seatRoot: string;
  seat: string;
  home: string;
  msgDb: string;
  capturePath: string;
  /** debug 원장 후보 위치 두 곳(출처: c6 — 소스 경계 안이면 `<cwd>/log` 로 흐르는 실측). */
  ledgerDirs: string[];
};

export function createE2EUniverse(opts: { universeRoot?: string; seat?: string } = {}): E2EUniverse {
  const universeRoot = opts.universeRoot ?? mkdtempSync(join(tmpdir(), 'opbse2e-'));
  const seat = opts.seat ?? 'OPSEAT';
  const seatRoot = join(universeRoot, 'seats', seat);
  const home = join(universeRoot, 'home');
  // c6 배치: home 아래 elanous-hq/seat-state/<seat> · 좌석 루트에 .elanous 마커(원장이 좌석 디렉터리로 핀 고정)·config.json.
  mkdirSync(join(home, 'elanous-hq', 'seat-state', seat), { recursive: true });
  mkdirSync(join(seatRoot, '.elanous'), { recursive: true });
  mkdirSync(join(seatRoot, 'msg'), { recursive: true });
  writeFileSync(join(seatRoot, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  return {
    universeRoot, seatRoot, seat, home,
    msgDb: join(seatRoot, 'msg', 'messages.db'),
    capturePath: join(seatRoot, 'fake-llm-capture.jsonl'),
    ledgerDirs: [join(seatRoot, '.elanous', 'debug'), join(seatRoot, 'log')],
  };
}

export function rmE2EUniverse(uni: E2EUniverse): void {
  rmSync(uni.universeRoot, { recursive: true, force: true });
}

/** 시나리오로 굽은 우편 1건의 계획 — marker 는 캡처 판독 열쇠(마커가 캡처에 닿으면 «턴에 전달됨»). */
export type IncidentMailPlan = { marker: string; from: string; body: string; intent: 'request' | 'info' };

/** incidentSeatItems(1차)를 **실제 MsgStore**(제품 저장 경로)에 굽는다 — 폭주는 count 로 자른다(하네스 시험 3통, 실 30통은 실제 공급자 게이트 뒤). */
export function seedIncidentMail(uni: E2EUniverse, scenarioId: IncidentScenarioId, opts: { count?: number } = {}): IncidentMailPlan[] {
  const items = incidentSeatItems(scenarioId);
  const selected = opts.count === undefined ? items : items.slice(0, opts.count);
  const store = new MsgStore(uni.msgDb);
  try {
    return selected.map((item) => {
      const marker = item.id;
      const body = `${item.title} — ${item.text} [${marker}]`;
      const from = typeof item.from === 'string' && item.from ? item.from : 'TC';
      const intent: IncidentMailPlan['intent'] = item.kind === 'request' ? 'request' : 'info';
      store.post({ from, to: uni.seat, body, intent });
      return { marker, from, body, intent };
    });
  } finally { store.close(); }
}

/** test-fake-llm 무대 프리셋 — 규칙 응답(마커→답)·스크립트 도구 호출·측정 사용량(결정론 토큰 원장 행). */
export type FakeLlmPreset = {
  response?: string;
  responseRules?: ReadonlyArray<{ when: string; text: string }>;
  toolCall?: { when: string; name: string; args: Record<string, unknown> };
  measuredUsage?: { inputTokens: number; outputTokens: number };
};

/** 기준선/계약 정책 프리셋 — 같은 시나리오를 정책별로 돌릴 때의 fake-LLM 동작 차이(승인/거부의 도구 호출은 호출자가 시나리오별로 주입). */
export function policyPreset(policy: SeatOperatingPolicy, scenarioId: IncidentScenarioId, markers: readonly string[]): FakeLlmPreset {
  const measuredUsage = { inputTokens: 1200, outputTokens: 60 };
  switch (scenarioId) {
    case 'mail-flood-30': {
      const responseRules = markers.map((marker) => ({
        when: marker,
        text: policy.bundleMail
          ? `OPBSE2E_CONTRACT_BUNDLE — ${markers.length}통 묶음 1턴 종결(${marker} 포함)`
          : `OPBSE2E_BASELINE_ONE — ${marker} 한 통 읽고 종결`,
      }));
      return { responseRules, measuredUsage };
    }
    case 'crown-question':
      // 기준선 = 결정급 질문은 사람에게(HarnessAskUser 실제 호출) · 계약 = 가역 자결(물음 0).
      return policy.askHuman
        ? {
            toolCall: { when: 'sim-crown-decision', name: 'HarnessAskUser',
              args: { questions: ['0.3.34 컷 연기 여부 — 되돌릴 수 있는 결정입니다. 연기할까요?'] } },
            response: 'OPBSE2E_CROWN_ASKED.', measuredUsage,
          }
        : { response: 'OPBSE2E_CROWN_SELF_DECIDE — 가역 자결: 컷 유지, 게이트 RED 시 철회 조건 원장 기록.', measuredUsage };
    case 'approval-prompt':
    case 'tool-rejection':
      // 경계 사건 자체는 호출자가 주입하는 도구 호출(승인 필요 argv / 기본 거부) — 프리셋은 턴 마무리 응답만.
      return { response: 'OPBSE2E_BOUNDARY_DONE.', measuredUsage };
    default:
      // landing-zero·long-session-2h 의 입력은 루프층(1차 sim) 유지 — TUI 턴 측정은 실제 공급자 게이트 뒤(0.3.35 #135500).
      return { response: 'OPBSE2E_REPLY', measuredUsage };
  }
}

/** 무대 env 블록 — 이름은 src/ux-sim/fake-llm.ts 의 상수 원문(AS_PROVIDER·MEASURED_USAGE 는 비상수 env). */
export function fakeLlmStageEnv(uni: E2EUniverse, preset: FakeLlmPreset = {}): Record<string, string> {
  return {
    ELANOUS_TEST_FAKE_LLM: '1',
    ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
    ELANOUS_TEST_FAKE_LLM_CAPTURE: uni.capturePath,
    ...(preset.response !== undefined ? { ELANOUS_TEST_FAKE_LLM_RESPONSE: preset.response } : {}),
    ...(preset.responseRules !== undefined ? { ELANOUS_TEST_FAKE_LLM_RESPONSE_RULES: JSON.stringify(preset.responseRules) } : {}),
    ...(preset.toolCall !== undefined ? { ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify(preset.toolCall) } : {}),
    ...(preset.measuredUsage !== undefined ? { ELANOUS_TEST_FAKE_LLM_MEASURED_USAGE: JSON.stringify(preset.measuredUsage) } : {}),
  };
}

export type E2EStageSpec = {
  ready?: { label?: string; until?: ScreenUntil; timeoutMs?: number };
  steps: SeatPtyStep[];
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
  /** 단계 기본 시한(ready 포함) — 각 단계가 자기 timeoutMs 를 가지면 그것이 이긴다. */
  timeoutMs?: number;
  quitKeys?: string;
  exitTimeoutMs?: number;
};

/** 진짜 eln Next TUI 를 격리 우주에 띄운다(c6-boot-backlog·진짜 TUI PTY 시험들과 같은 인자·env 판). */
export async function runE2EStage(uni: E2EUniverse, preset: FakeLlmPreset, spec: E2EStageSpec): Promise<SeatPtySequenceEvidence> {
  const defaultTimeout = spec.timeoutMs ?? 60_000;
  return mockSeatPtySequence({
    executable: process.execPath,
    args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
    root: uni.seatRoot,
    rows: spec.rows ?? 40,
    cols: spec.cols ?? 100,
    env: {
      HOME: uni.home,
      ELANOUS_SESSION_ROOT: join(uni.seatRoot, 'sessions'),
      ELANOUS_CONFIG_DIR: uni.seatRoot,
      ...fakeLlmStageEnv(uni, preset),
      ...(spec.env ?? {}),
    },
    ready: {
      label: spec.ready?.label ?? 'boot',
      until: spec.ready?.until ?? 'Ctrl+Q quit',
      timeoutMs: spec.ready?.timeoutMs ?? defaultTimeout,
    },
    steps: spec.steps,
    quitKeys: spec.quitKeys,
    exitTimeoutMs: spec.exitTimeoutMs,
  });
}

// ── 원장 판독(전부 실제 파일 행 — c6 의 판독기 판) ──

export type TurnLifeRow = { event: string; data: unknown };
export type E2EUsageRow = SimUsageRow;

type LedgerRow = { category?: string; event?: string; data?: unknown };

/** c6 실측: 종료 직후 플러시가 늦을 수 있다 — 행이 보일 때까지 최대 waitMs(기본 2s) 기다린다.
 * r8 RCA(11-24 20:1x): 부팅 행이 이미 있으면 rows.length>0 로 즉시 반환돼, 늦게 flush되는
 * seat.approval 같은 행을 놓쳤다 — until 조건이 있으면 그 조건이 채워질 때까지 같은 창에서 계속 기다린다. */
async function readLedgerRows(uni: E2EUniverse, waitMs = 2_000, until?: (rows: LedgerRow[]) => boolean): Promise<LedgerRow[]> {
  const read = (): LedgerRow[] => uni.ledgerDirs.flatMap((dir) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => (name.startsWith('debug-') || name.startsWith('chat-')) && name.endsWith('.log'))
      .sort()
      .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean))
      .flatMap((line) => {
        try { return [JSON.parse(line) as LedgerRow]; } catch { return []; }
      });
  });
  let rows = read();
  const satisfied = () => (until ? until(rows) : rows.length > 0);
  for (let waitedMs = 0; !satisfied() && waitedMs < waitMs; waitedMs += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    rows = read();
  }
  return rows;
}

/** 턴 경계 — turn-life 행(원장 원문). 시종 짝짓기로 인터럽트(시작만 있고 끝 없는 턴)를 잰다. */
export async function readTurnLifeRows(uni: E2EUniverse, opts: { waitMs?: number } = {}): Promise<TurnLifeRow[]> {
  const rows = await readLedgerRows(uni, opts.waitMs);
  return rows.flatMap((row) => row.category === 'turn-life' && row.event ? [{ event: row.event, data: row.data }] : []);
}

/** llm.usage 행 — 측정된 inputTokens 행만(fake MEASURED_USAGE 가 결정론 수를 싣는다). */
export async function readUsageRows(uni: E2EUniverse, opts: { waitMs?: number } = {}): Promise<E2EUsageRow[]> {
  const rows = await readLedgerRows(uni, opts.waitMs);
  return rows.flatMap((row) => {
    if (row.category !== 'llm.usage' || row.event !== 'llm-usage') return [];
    const data = typeof row.data === 'string' ? (() => { try { return JSON.parse(row.data) as Record<string, unknown>; } catch { return undefined; } })() : row.data;
    if (data === null || typeof data !== 'object') return [];
    const fields = data as Record<string, unknown>;
    if (typeof fields.inputTokens !== 'number' || !Number.isFinite(fields.inputTokens)) return [];
    return [{ inputTokens: fields.inputTokens, ...(typeof fields.outputTokens === 'number' ? { outputTokens: fields.outputTokens } : {}) }];
  });
}

/** seat.approval 행 — 무인 자리 승인 경계의 감사 기록(자동 승인·OP 질의) 원장 원문. */
export async function readSeatApprovalRows(uni: E2EUniverse, opts: { waitMs?: number } = {}): Promise<Array<{ event: string; data: unknown }>> {
  // r8 RCA: 부팅 행이 있어도 seat.approval 행 자체가 보일 때까지 waitMs 창 안에서 재폴한다.
  const rows = await readLedgerRows(uni, opts.waitMs, (rs) => rs.some((row) => row.category === 'seat.approval' && row.event));
  return rows.flatMap((row) => row.category === 'seat.approval' && row.event ? [{ event: row.event, data: row.data }] : []);
}

/** 캡처(모델이 실제로 받은 요청 원문) — fake-llm 이 우주 종료 전까지 굽는다. */
export function readCaptureRows(uni: E2EUniverse): Array<{ messages: unknown[] }> {
  if (!existsSync(uni.capturePath)) return [];
  const raw = readFileSync(uni.capturePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as { messages: unknown[] });
}

export function captureIndexOf(uni: E2EUniverse, needle: string): { found: boolean; index: number } {
  const rows = readCaptureRows(uni);
  const index = rows.findIndex((row) => JSON.stringify(row.messages).includes(needle));
  return { found: index >= 0, index };
}

// ── 점수화 — 1차 SimScore 어휘로 옮긴다(표는 compareRuns 하나) ──

export type E2EObservations = {
  turnLife: readonly TurnLifeRow[];
  usage: readonly E2EUsageRow[];
  /** 시드한 우편 수. */
  mailsSeeded: number;
  /** 캡처에 닿은 마커 수(= 턴에 전달되어 처리된 우편). */
  mailsDelivered: number;
  /** HarnessAskUser 실제 호출 수(세션 전사 행 기준) = 사람에게 물음. */
  asksObserved: number;
  /** 승인 프롬프트 프레임 수(도구 경계에서 물린 턴의 화면 증거). */
  approvalFrames: number;
};

/** 원장 관측 → 1차 SimScore. 출처: turns·interrupts = turn-life 짝짓기, 토큰 = llm.usage 합/턴, 물음 = 실제 ask 호출, 처리/미시도 = 전달 마커.
 *  deferralsWithoutRetry 축은 이 층이 아직 예약(0) — 보류·재시도 원문 계측은 실제 공급자 실행(0.3.35 #135500)에서 연다. */
export function toSimScore(obs: E2EObservations): SimScore {
  const starts = obs.turnLife.filter((row) => row.event === 'turn-life:turn-start').length;
  const ends = obs.turnLife.filter((row) => row.event === 'turn-life:turn-end').length;
  const inputTokens = obs.usage.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  return {
    turns: starts,
    interrupts: Math.max(0, starts - ends),
    deferralsWithoutRetry: 0,
    inputTokensPerTurn: starts > 0 ? inputTokens / starts : 0,
    humanQuestions: obs.asksObserved,
    processedRequests: obs.mailsDelivered,
    unattemptedRequests: Math.max(0, obs.mailsSeeded - obs.mailsDelivered),
  };
}

/** e2e 관측을 1차 비교표 어휘로 — compareRuns([기준선], [계약]) 에 그대로 넣는다. */
export function e2eScoredRun(scenario: string, score: Partial<SimScore>): SimScoredRun {
  return {
    scenario,
    score: {
      interrupts: 0, deferralsWithoutRetry: 0, turns: 0, inputTokensPerTurn: 0,
      humanQuestions: 0, unattemptedRequests: 0, processedRequests: 0,
      ...score,
    },
  };
}
