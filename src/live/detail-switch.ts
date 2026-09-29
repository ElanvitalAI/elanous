// Live 탭 «화려함 MAX» 스위치 — 상세 관측을 켜는 한 자리 (대표 2026-09-28 · 기획 #21443 §0c).
//
// 대표: «화려함의 드로백은 하니스의 부하 — 화려함 MAX(1차 마케팅 · 2차 상세 디버깅) ↔ 실용성 두 모드.
//      상세 관측에는 비용이 드니 사용자가 스스로 알고 켠다.»
// ⇒ 상세 판단 이벤트(`harness.decision`)는 이 스위치가 켜져 있을 때만 낸다. 기본은 꺼짐(실용성 모드).
//
// 상태 = `<state>/live/detail.json` `{ scope: 'all' | '<runId>', until: <epoch ms>, by?, since }`.
//   - 넥서스(`/v1/live/detail`)가 쓰고, 하니스·런(다른 프로세스)은 파일을 읽는다 — 프로세스 경계를 넘는 가장 단순한 관.
//   - `until` 이 지나면 꺼진 것이다(자동 꺼짐 · 파일을 지우는 사람이 없어도 된다).
// ⛔ 읽기 실패·깨진 파일은 «꺼짐» — 상세 관측은 비용이라 fail-closed.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { prodInstanceRoot } from '../instance/resolve.js';

export const LIVE_DETAIL_DEFAULT_TTL_MIN = 30;
export const LIVE_DETAIL_MAX_TTL_MIN = 240;
const CACHE_MS = 5_000;

export interface LiveDetailState {
  readonly scope: 'all' | string;
  readonly until: number;
  readonly since: number;
  readonly by?: string;
}

export function liveDetailPath(root: string = elanousStateRoot()): string {
  return join(root, 'live', 'detail.json');
}

function parse(raw: string): LiveDetailState | null {
  try {
    const v = JSON.parse(raw) as Partial<LiveDetailState>;
    if (typeof v.scope !== 'string' || !v.scope || typeof v.until !== 'number' || !Number.isFinite(v.until)) return null;
    return { scope: v.scope, until: v.until, since: typeof v.since === 'number' ? v.since : v.until, ...(typeof v.by === 'string' ? { by: v.by } : {}) };
  } catch { return null; }
}

/** 지금 켜져 있는 상태(없거나 지났으면 null). */
export function readLiveDetail(opts: { path?: string; now?: number } = {}): LiveDetailState | null {
  let raw: string;
  try { raw = readFileSync(opts.path ?? liveDetailPath(), 'utf8'); } catch { return null; }
  const state = parse(raw);
  if (!state) return null;
  return state.until > (opts.now ?? Date.now()) ? state : null;
}

/** 켠다(또는 끈다 — `ttlMin: 0`). 넥서스 끝점과 CLI 가 부른다. */
export function writeLiveDetail(
  input: { scope?: string; ttlMin?: number; by?: string },
  opts: { path?: string; now?: number } = {},
): LiveDetailState | null {
  const now = opts.now ?? Date.now();
  const path = opts.path ?? liveDetailPath();
  const ttl = Math.min(LIVE_DETAIL_MAX_TTL_MIN, Math.max(0, input.ttlMin ?? LIVE_DETAIL_DEFAULT_TTL_MIN));
  const scope = input.scope?.trim() || 'all';
  const state: LiveDetailState = { scope, until: now + ttl * 60_000, since: now, ...(input.by ? { by: input.by } : {}) };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
  cache = null;
  debug.log('live.detail', ttl > 0 ? 'enabled' : 'disabled', { scope, ttlMin: ttl, by: input.by ?? null });
  return ttl > 0 ? state : null;
}

export interface LiveDetailSelection {
  readonly state: LiveDetailState | null;
  readonly source: 'local' | 'production' | null;
  readonly path: string | null;
}

type DetailReadOptions = { now?: number; path?: string; prodPath?: string };
let cache: { at: number; localPath: string; prodPath: string; selection: LiveDetailSelection } | null = null;

/** 자기 우주에 파일이 존재하는 동안은 꺼짐/만료/깨진 상태도 운영 폴백을 가린다. */
export function selectLiveDetail(opts: DetailReadOptions = {}): LiveDetailSelection {
  const now = opts.now ?? Date.now();
  const localPath = opts.path ?? liveDetailPath();
  const prodPath = opts.prodPath ?? (opts.path ? localPath : liveDetailPath(prodInstanceRoot()));
  if (cache && cache.localPath === localPath && cache.prodPath === prodPath && now >= cache.at && now - cache.at <= CACHE_MS) {
    const { state, source, path } = cache.selection;
    return { state: state && state.until > now ? state : null, source, path };
  }
  let source: LiveDetailSelection['source'] = 'local';
  let path = localPath;
  let raw: string | null = null;
  try { raw = readFileSync(localPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && prodPath !== localPath) {
      source = 'production';
      path = prodPath;
      try { raw = readFileSync(prodPath, 'utf8'); }
      catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === 'ENOENT') { source = null; path = ''; }
      }
    } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      source = null;
      path = '';
    }
  }
  const parsed = raw === null ? null : parse(raw);
  const selection: LiveDetailSelection = { state: parsed, source, path: source ? path : null };
  cache = { at: now, localPath, prodPath, selection };
  return { ...selection, state: parsed && parsed.until > now ? parsed : null };
}

/** 이 런에 상세 관측이 켜져 있나 — 두 뿌리에 공통인 5초 캐시. */
export function isLiveDetailOn(runId?: string, opts: DetailReadOptions = {}): boolean {
  const now = opts.now ?? Date.now();
  return matches(selectLiveDetail({ ...opts, now }).state, runId, now);
}

function matches(state: LiveDetailState | null, runId: string | undefined, now: number): boolean {
  if (!state || state.until <= now) return false;
  return state.scope === 'all' || (!!runId && state.scope === runId);
}

/** 판단 종류 — Live 탭 판단 그래프의 범례와 같다(기획 §0b). */
export type DecisionKind = 'PLAN' | 'ROUTE' | 'VERIFY' | 'HEAL' | 'ESCALATE' | 'SHIP';

export interface DecisionEvent {
  readonly kind: DecisionKind;
  /** 무엇을 판단했나(한 줄). */
  readonly what: string;
  /** 왜 — 근거(한 줄). */
  readonly reason: string;
  /** 무엇을 위해 — 목적(한 줄). */
  readonly purpose: string;
  /** 어디로 보냈나 — 다음 행선지(노드·계정·기계·사람). */
  readonly target: string;
  readonly runId?: string;
  /** 검토한 선택지 수(판단 그래프 `PATHS`). */
  readonly paths?: number;
  /** Trace(v6) 연결 칸 — 부모 런(재발사·슈퍼바이저·Pod 자식의 부모). 없으면 `ELANOUS_PARENT_RUN_ID`. */
  readonly parentRunId?: string;
  /** 하니스 페이즈(author·decompose·dispatch·implement·gate·review·land). */
  readonly phase?: 'author' | 'decompose' | 'dispatch' | 'implement' | 'gate' | 'review' | 'land';
  /** 조각(하니스 공간 id). 없으면 `ELANOUS_HARNESS_SPACE_ID`. */
  readonly shard?: string;
  /** 증거로 가는 참조(L4) — PR 번호 · 커밋 · 계정 등. 값은 짧은 식별자만(비밀 금지). */
  readonly refs?: Readonly<Record<string, string | number>>;
}

/**
 * 판단 한 건을 낸다 — MAX 스위치가 켜져 있을 때만. 꺼져 있으면 아무것도 안 한다(부하 0).
 * `runId` 를 안 주면 `ELANOUS_RUN_ID`(가장 바깥에서 찍은 런 id)를 쓴다.
 */
export function emitDecision(event: DecisionEvent, opts: DetailReadOptions = {}): boolean {
  const runId = event.runId ?? process.env.ELANOUS_RUN_ID?.trim() ?? undefined;
  if (!isLiveDetailOn(runId, opts)) return false;
  // 같은 판단이 한 프로세스의 두 경로(조회·해석)에서 같은 순간 두 번 오면 한 번만 낸다(09-28 운영 실측 · 같은 ms 두 줄).
  const now = opts.now ?? Date.now();
  const key = `${event.kind}|${event.what}|${event.target}|${runId ?? ''}`;
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return false;
  recent.set(key, now);
  if (recent.size > 256) for (const [k, t] of recent) if (now - t >= DEDUPE_MS) recent.delete(k);
  const parentRunId = event.parentRunId ?? process.env.ELANOUS_PARENT_RUN_ID?.trim() ?? undefined;
  const shard = event.shard ?? process.env.ELANOUS_HARNESS_SPACE_ID?.trim() ?? undefined;
  debug.log('harness.decision', 'decision', {
    ...event, runId: runId ?? null,
    ...(parentRunId ? { parentRunId } : {}),
    ...(shard ? { shard } : {}),
  });
  return true;
}

const DEDUPE_MS = 5_000;
const recent = new Map<string, number>();

/** 시험 전용 — 캐시를 비운다. */
export function resetLiveDetailCacheForTesting(): void { cache = null; recent.clear(); }
