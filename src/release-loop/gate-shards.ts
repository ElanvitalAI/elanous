// GATE-LIVE-OBS — 게이트 «조각 상태» 한 장(`<ledger>/release/<v>/gate-logs/cut/shards.json`)의 계약.
// 쓰는 쪽 = gate-node(TC · GATE-TIMEOUT-HEAL) · 읽는 쪽 = /v1/ops/release/runs ⊕ 외출 알림(UX).
// 로그가 아니라 발행 원장 파일인 이유: 게이트 사건은 실행 트리의 test 우주로 가지만 원장은 운영 한 곳이다(TC·OP 10-07 19:12).
// ⛔ 못 읽으면 `null` — 「조각 0」으로 읽지 않는다.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { releaseLedgerRoot } from '../instance/resolve.js';

export const SHARD_STATES = ['pending', 'running', 'done', 'retry', 'timeout', 'failed'] as const;
export type ShardState = typeof SHARD_STATES[number];

export interface GateShard {
  id: string;
  state: ShardState;
  startedAt?: string;
  endedAt?: string;
  /** 설치(install) 단계에 쓴 초. */
  installSec?: number;
  rc?: number;
  /** 대기 이유(예: «CPU 부족 31.2/32»). pending 일 때 화면이 그대로 보인다. */
  waitReason?: string;
  /** 계획 분 — 남은 시간 추정의 재료. */
  plannedMin?: number;
}

/** 게이트 노드의 판정 결과 — 끝난 조각의 rc≠0 을 «새로 생긴 실패»와 «기존 실패»로 가른 수. */
export interface GateShardsVerdict {
  introduced: number;
  preexisting: number;
}

export interface GateShardsFile {
  v: 1;
  version: string;
  updatedAt: string;
  shards: GateShard[];
  /** 판정이 나기 전에는 없다. 옛 파일(필드 없음)도 그대로 읽는다 — `v` 를 올리지 않는다. */
  verdict?: GateShardsVerdict;
}

export function gateShardsPath(version: string, root: string = releaseLedgerRoot()): string {
  return join(root, 'release', version, 'gate-logs', 'cut', 'shards.json');
}

const str = (value: unknown, max = 160): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function shardOf(value: unknown): GateShard | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = str(raw.id, 80);
  const state = SHARD_STATES.find((s) => s === raw.state);
  if (!id || !state) return null;
  const startedAt = str(raw.startedAt, 40);
  const endedAt = str(raw.endedAt, 40);
  const installSec = num(raw.installSec);
  const rc = num(raw.rc);
  const waitReason = str(raw.waitReason);
  const plannedMin = num(raw.plannedMin);
  return {
    id, state,
    ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}),
    ...(installSec !== undefined ? { installSec } : {}), ...(rc !== undefined ? { rc } : {}),
    ...(waitReason ? { waitReason } : {}), ...(plannedMin !== undefined ? { plannedMin } : {}),
  };
}

function verdictOf(value: unknown): GateShardsVerdict | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const introduced = num(raw.introduced);
  const preexisting = num(raw.preexisting);
  return introduced !== undefined && preexisting !== undefined ? { introduced, preexisting } : undefined;
}

/** 파일이 없거나 깨졌으면 null. 알 수 없는 상태값의 조각은 버리되 파일 전체는 살린다(깨진 verdict 도 필드만 버린다). */
export function readGateShards(path: string): GateShardsFile | null {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.v !== 1 || !Array.isArray(raw.shards)) return null;
  const version = str(raw.version, 40);
  const updatedAt = str(raw.updatedAt, 40);
  if (!version || !updatedAt) return null;
  const verdict = verdictOf(raw.verdict);
  return {
    v: 1, version, updatedAt, shards: raw.shards.map(shardOf).filter((s): s is GateShard => s !== null),
    ...(verdict ? { verdict } : {}),
  };
}

/** tmp → rename — 읽는 쪽이 반쯤 쓴 파일을 보지 않게. */
export function writeGateShards(path: string, file: GateShardsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`);
  renameSync(tmp, path);
}

/**
 * GATE-LIVE-OBS-RC-WORDING ⓒ — the gate node writes its verdict into the board it already keeps, after judging.
 * No board (a local, non-Pod gate) ⇒ false and nothing is written: a verdict never creates a board out of thin air.
 */
export function recordGateShardsVerdict(path: string, verdict: GateShardsVerdict, now: Date = new Date()): boolean {
  const file = readGateShards(path);
  if (!file) return false;
  writeGateShards(path, { ...file, updatedAt: now.toISOString(), verdict });
  return true;
}

export interface GateShardsSummary {
  total: number;
  counts: Record<ShardState, number>;
  /** 대기 이유별 조각 수(많은 순). */
  waitReasons: Array<{ reason: string; count: number }>;
  /** 남은 분 추정 — 계획 분이 모자라면 null(«추정 불가»). */
  etaMin: number | null;
  /** 끝났지만 rc≠0 인 조각 수 — 쓰는 쪽의 `done` 은 «조각 끝»일 뿐 «통과»가 아니다(판정은 게이트 노드가 기존/새로 가른다).
   *  0.2.20 컷 실측: 끝난 넷이 모두 rc 1 인데 화면이 «통과»로 읽었다. */
  doneWithFailures: number;
  /** 게이트 노드의 판정(기존/새로). null = «판정 전» — 「새 실패 0」과 다른 값이다.
   *  `summarizeShards` 는 늘 채운다(선택 필드인 것은 이 요약을 손으로 만드는 픽스처·읽는 쪽을 깨지 않으려는 것). */
  verdict?: GateShardsVerdict | null;
  /** 도는 조각 중 계획 분을 가장 많이 넘긴 분(없으면 0). 넘겼으면 etaMin 은 «하한»일 뿐이라 화면이 그렇게 말한다
   *  — canary 10-07 실측: 계획 0.1분 · 실제 22분 → 넘김을 안 보이면 내내 «남은 약 0분». */
  overrunMin: number;
  /** 파일이 마지막으로 바뀐 뒤 지난 분. 크면 쓰는 쪽이 멎었다는 뜻이다. */
  staleMin: number | null;
}

const minutesBetween = (fromIso: string | undefined, now: number): number | null => {
  const at = fromIso ? Date.parse(fromIso) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, (now - at) / 60_000) : null;
};

/**
 * 남은 시간 추정: 도는 조각은 «계획 − 경과», 기다리는 조각(pending·retry)은 계획 분을 지금 도는 자리 수로 나눠 뒤에 잇는다.
 * 도는 조각이 없으면 자리 1로 본다. 계획 분이 없는 조각이 하나라도 남아 있으면 null.
 */
function estimate(shards: GateShard[], now: number): number | null {
  const running = shards.filter((s) => s.state === 'running');
  const waiting = shards.filter((s) => s.state === 'pending' || s.state === 'retry');
  if (!running.length && !waiting.length) return 0;
  if ([...running, ...waiting].some((s) => s.plannedMin === undefined)) return null;
  const runningLeft = running.map((s) => Math.max(0, s.plannedMin! - (minutesBetween(s.startedAt, now) ?? 0)));
  const slots = Math.max(1, running.length);
  const waitingSum = waiting.reduce((sum, s) => sum + s.plannedMin!, 0);
  return Math.ceil(Math.max(0, ...runningLeft) + waitingSum / slots);
}

export function summarizeShards(file: GateShardsFile, now: number = Date.now()): GateShardsSummary {
  const counts = Object.fromEntries(SHARD_STATES.map((s) => [s, 0])) as Record<ShardState, number>;
  const reasons = new Map<string, number>();
  for (const shard of file.shards) {
    counts[shard.state] += 1;
    if (shard.waitReason && (shard.state === 'pending' || shard.state === 'retry')) {
      reasons.set(shard.waitReason, (reasons.get(shard.waitReason) ?? 0) + 1);
    }
  }
  const stale = minutesBetween(file.updatedAt, now);
  const overrun = Math.max(0, ...file.shards
    .filter((s) => s.state === 'running' && s.plannedMin !== undefined)
    .map((s) => (minutesBetween(s.startedAt, now) ?? 0) - s.plannedMin!));
  return {
    total: file.shards.length,
    counts,
    waitReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    doneWithFailures: file.shards.filter((s) => s.state === 'done' && s.rc !== undefined && s.rc !== 0).length,
    verdict: file.verdict ?? null,
    etaMin: estimate(file.shards, now),
    overrunMin: Math.floor(overrun),
    staleMin: stale === null ? null : Math.floor(stale),
  };
}

export const SHARD_WORD: Record<ShardState, string> = {
  pending: '대기', running: '돌기', done: '끝', retry: '재시도', timeout: '잘림', failed: '실패',
};

/**
 * `끝` 꼬리. 기존 실패가 있는 판에선 조각 전부가 rc 1 로 끝난다(0.2.21 컷: 24/24) — 그래서 판정 전엔 rc≠0 을 «실패»라 부르지 않고,
 * 판정 뒤엔 새로 생긴 실패만 싣는다(기존 실패 수는 줄에 안 싣는다).
 */
function doneTail(summary: GateShardsSummary): string {
  if (summary.verdict) return summary.verdict.introduced > 0 ? `(새 실패 ${summary.verdict.introduced})` : '';
  return summary.doneWithFailures ? `(rc≠0 ${summary.doneWithFailures} · 기존 실패 포함 · 판정 전)` : '';
}

/** 외출 알림·/release 한 줄 — «조각 24 · 돌기 5 · 대기 8(CPU 부족 8) · 잘림 2 · 끝 9(rc≠0 3 · 기존 실패 포함 · 판정 전) · 남은 약 40분». */
export function shardsLine(summary: GateShardsSummary): string {
  const order: ShardState[] = ['running', 'pending', 'retry', 'timeout', 'failed', 'done'];
  const parts = [`조각 ${summary.total}`];
  for (const state of order) {
    const n = summary.counts[state];
    if (!n) continue;
    const why = state === 'pending' && summary.waitReasons.length
      ? `(${summary.waitReasons.slice(0, 2).map((w) => `${w.reason} ${w.count}`).join(' · ')})` : '';
    const reported = state === 'done' ? doneTail(summary) : '';
    parts.push(`${SHARD_WORD[state]} ${n}${why}${reported}`);
  }
  if (summary.overrunMin >= 1) parts.push(`계획보다 ${summary.overrunMin}분 넘게 도는 중 — 남은 시간 추정 불가`);
  else parts.push(summary.etaMin === null ? '남은 시간 추정 불가(계획 분 없음)' : `남은 약 ${summary.etaMin}분`);
  if (summary.staleMin !== null && summary.staleMin >= 15) parts.push(`⚠️ ${summary.staleMin}분째 갱신 없음`);
  return parts.join(' · ');
}
