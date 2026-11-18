// SEAT-IDLE-STALL-SENTINEL 한 틱 — 수집 → 표본 이력 결합 → 판정 → 사건(`seat.sentinel` ⊕ `graph.view`) → 처방.
// 처방은 기본 «제안»(그림자)이다. 실행은 ELANOUS_SEAT_SENTINEL_ACTUATE=1 (또는 opts.actuate) 일 때만,
// 그리고 msg-wake 가 쓰는 같은 관문(herdrPrompt: pane list 에서 idle 인 지원 agent 만 · 제출 직전 재확인)만 지난다.
//
// 일정(이 칸에서는 등록하지 않는다): 상주 프로세스를 새로 두지 않는다. 한 번 돌고 끝나는 틱이고,
// 그래프 러너 루프(graphs/ops/seat-sentinel.yaml · loop.trigger.cron "* * * * *" · stage shadow)로 감싸
// `elanous loop`/`elanous schedule` 이 1분마다 부르게 하는 것이 후속 칸이다. 상태는 표본 이력 파일 하나뿐이다.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { herdrPrompt, type HerdrCliRunner, type HerdrPromptResult } from '../pty-shell/herdr-prompt.js';
import { remoteHerdrRunner } from '../loops/msg-wake.js';
import { collectSeatObservations, type SeatObservation, type SeatSentinelCollectDeps } from './seat-sentinel-collect.js';
import {
  appendSeatSample, classifySeatHealth, DEFAULT_SEAT_SENTINEL_POLICY, seatSentinelGraphEvents,
  type SeatActivitySample, type SeatHealthResult, type SeatSentinelPolicy,
} from './seat-sentinel.js';
import type { GraphViewEvent } from '../graph-view/model.js';

/** Actuation flag. Default off: prescriptions are logged as proposals only. */
export const SEAT_SENTINEL_ACTUATE_ENV = 'ELANOUS_SEAT_SENTINEL_ACTUATE';
// 출처: herdr-prompt HERDR_PROMPT_ACTIVITY_WINDOW_MS(5초) 제출 뒤 관측 ⊕ SSH 왕복 여유.
export const SEAT_SENTINEL_PROMPT_TIMEOUT_MS = 10_000;
const MS_PER_MINUTE = 60_000;

export interface SeatSentinelState {
  readonly version: 1;
  readonly samples: Readonly<Record<string, readonly SeatActivitySample[]>>;
  /** Last actuation per seat (epoch ms) — the cooldown. */
  readonly actuatedAt: Readonly<Record<string, number>>;
}

export interface SeatSentinelActuation {
  readonly seat: string;
  readonly prescription: SeatHealthResult['prescription'];
  readonly result: 'proposed' | 'skipped' | 'submitted' | 'refused';
  readonly reason: string;
}

export interface SeatSentinelTickResult {
  readonly at: string;
  readonly actuate: boolean;
  readonly results: readonly SeatHealthResult[];
  readonly actuations: readonly SeatSentinelActuation[];
  readonly graphEvents: readonly GraphViewEvent[];
}

export interface SeatSentinelTickDeps extends SeatSentinelCollectDeps {
  readonly now?: () => Date;
  readonly policy?: SeatSentinelPolicy;
  /** Turn prescriptions into input. Default: env ELANOUS_SEAT_SENTINEL_ACTUATE === '1' (off). */
  readonly actuate?: boolean;
  readonly collect?: (now: Date) => Promise<SeatObservation[]>;
  readonly loadState?: () => SeatSentinelState | null;
  readonly saveState?: (state: SeatSentinelState) => void;
  readonly log?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** The only input path: the msg-wake herdr gate. Injected in tests. */
  readonly prompt?: (target: string, text: string, run: HerdrCliRunner | undefined) => Promise<Pick<HerdrPromptResult, 'ok' | 'accepted' | 'reason'>>;
}

export function seatSentinelStatePath(root: string = effectiveInstanceRoot()): string {
  return join(root, 'seat-sentinel', 'state.json');
}

function loadStateFile(path: string): SeatSentinelState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SeatSentinelState>;
    if (parsed.version !== 1 || !parsed.samples || typeof parsed.samples !== 'object') return null;
    return { version: 1, samples: parsed.samples, actuatedAt: parsed.actuatedAt ?? {} };
  } catch { return null; }
}

function saveStateFile(path: string, state: SeatSentinelState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state) + '\n');
  renameSync(tmp, path);
}

/** Fixed wake/continue lines — no dynamic mail body ever goes into a pane. */
export function seatSentinelPromptText(seat: string, result: SeatHealthResult): string {
  if (result.prescription === 'continue') return '계속';
  const mail = result.evidence.unackedAssignments?.map((row) => `#${row.id}`).join(' ');
  return mail
    ? `[seat-sentinel] 미ack 배정 우편 ${mail} — eln msg list --to ${seat} 로 읽고 수락·거절·사유를 남겨라`
    : `[seat-sentinel] 할 일이 남아 있다 — 자기 계획·칸(eln msg list --to ${seat} · release checklist)을 이어서 하라`;
}

/** One sentinel tick. Never throws for one seat's failure; the result lists every seat. */
export async function runSeatSentinelTick(deps: SeatSentinelTickDeps = {}): Promise<SeatSentinelTickResult> {
  const now = (deps.now ?? (() => new Date()))();
  const policy = deps.policy ?? DEFAULT_SEAT_SENTINEL_POLICY;
  const actuate = deps.actuate ?? process.env[SEAT_SENTINEL_ACTUATE_ENV] === '1';
  const log = deps.log ?? ((category, event, data) => debug.log(category, event, data));
  const previous = (deps.loadState ?? (() => loadStateFile(seatSentinelStatePath())))() ?? { version: 1, samples: {}, actuatedAt: {} };

  const observations = await (deps.collect ?? ((at: Date) => collectSeatObservations(at, deps)))(now);
  const samples: Record<string, SeatActivitySample[]> = {};
  const results: SeatHealthResult[] = [];
  for (const observation of observations) {
    samples[observation.seat] = appendSeatSample(previous.samples[observation.seat] ?? [], observation.sample, policy);
    const result = classifySeatHealth({
      seat: observation.seat, host: observation.host, route: observation.route, statusSource: observation.statusSource,
      samples: samples[observation.seat]!, openWork: observation.openWork, mail: observation.mail,
      ...(observation.lastOutputAt !== undefined ? { lastOutputAt: observation.lastOutputAt } : {}),
    }, now, policy);
    results.push(result);
    log('seat.sentinel', 'verdict', { seat: result.seat, verdict: result.verdict, prescription: result.prescription,
      reason: result.reason, evidence: result.evidence, mode: actuate ? 'live' : 'shadow' });
  }

  const actuatedAt: Record<string, number> = { ...previous.actuatedAt };
  const actuations: SeatSentinelActuation[] = [];
  const bySeat = new Map(observations.map((observation) => [observation.seat, observation]));
  for (const result of results) {
    if (result.prescription === 'none') continue;
    const observation = bySeat.get(result.seat)!;
    const record = (row: Omit<SeatSentinelActuation, 'seat' | 'prescription'>) => {
      const entry = { seat: result.seat, prescription: result.prescription, ...row };
      actuations.push(entry);
      log('seat.sentinel', row.result === 'proposed' ? 'proposal' : 'actuation', { ...entry, verdict: result.verdict });
    };
    // restart-proposal and notify-op are always OP's: the sentinel never restarts a seat.
    if (!actuate || result.prescription === 'restart-proposal' || result.prescription === 'notify-op') {
      record({ result: 'proposed', reason: actuate ? 'op-decides' : 'shadow' });
      continue;
    }
    if (observation.route !== 'herdr' || !observation.target || !observation.optIn) { record({ result: 'skipped', reason: 'no-opt-in-herdr-route' }); continue; }
    const last = actuatedAt[result.seat];
    if (last !== undefined && now.getTime() - last < policy.actuateCooldownMinutes * MS_PER_MINUTE) { record({ result: 'skipped', reason: 'cooldown' }); continue; }
    const prompt = deps.prompt ?? ((target: string, text: string, runner: HerdrCliRunner | undefined) =>
      herdrPrompt({ target, text, anyAgent: true, requirePaneListStatus: true, timeoutMs: SEAT_SENTINEL_PROMPT_TIMEOUT_MS },
        runner ? { run: runner } : {}));
    try {
      const run = deps.herdrRunFor ? deps.herdrRunFor(observation.host)
        : observation.host === 'local' ? undefined : remoteHerdrRunner(observation.host);
      const outcome = await prompt(observation.target, seatSentinelPromptText(result.seat, result), run);
      if (outcome.accepted) actuatedAt[result.seat] = now.getTime();
      record({ result: outcome.ok && outcome.accepted ? 'submitted' : 'refused', reason: String(outcome.reason) });
    } catch (error) {
      record({ result: 'refused', reason: error instanceof Error ? error.name : 'error' });
    }
  }

  const graphEvents = seatSentinelGraphEvents(results, now.getTime(), { loopId: `seat-sentinel:${now.toISOString()}`, actuate });
  for (const event of graphEvents) log('graph.view', event.type, { ...event });
  (deps.saveState ?? ((state: SeatSentinelState) => saveStateFile(seatSentinelStatePath(), state)))({ version: 1, samples, actuatedAt });
  return { at: now.toISOString(), actuate, results, actuations, graphEvents };
}
