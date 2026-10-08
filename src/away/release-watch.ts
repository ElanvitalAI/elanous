import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { deliver, inQuietHours, sendOutbound } from '../domains/outbound-alert.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { readReleaseRuns, type ReleaseRunNodeView, type ReleaseRunView } from '../nexus/api/ops-api.js';
import { shardsLine } from '../release-loop/gate-shards.js';
import { readPresence, type Presence } from './presence.js';

/** AWAY-MODE-1 — 외출 중 발행 현황 공백 0. 발행 런 원장(`/v1/ops/release/runs` 와 같은 판정)을 직전에 본 것과 견주어
 *  «새로 생긴 전이»만 텔레그램 한 통으로 보낸다. 같은 전이는 두 번 안 보낸다(보낸 뒤에만 기준을 옮긴다). */

export const RELEASE_SCREEN_URL = 'https://op.elanous.ai/app/ops/release';
/** 발행 중 이 간격 동안 새 전이가 없으면 «생존» 한 줄. */
export const ALIVE_EVERY_MS = 60 * 60_000;
/** 이보다 오래된 런은 따라가지 않는다 — 외출을 켠 순간 지난 판이 쏟아지지 않게. */
export const FOLLOW_WINDOW_MS = 36 * 3600_000;

export interface RunMark {
  status: string;
  /** 끝난(ok 가 정해진) 노드 수. */
  ended: number;
  /** 지금 도는 노드(있으면). */
  running?: string;
  /** 이 런에 대해 마지막으로 보낸 시각(ISO) — 생존 줄 간격의 기준. */
  sentAt: string;
  /** GATE-LIVE-OBS — 마지막으로 본 잘림·실패 조각 수. 늘면 한 줄. */
  shardsBad?: number;
}

const shardsBad = (run: ReleaseRunView): number | undefined => {
  const counts = run.gateShards?.summary.counts;
  return counts ? counts.timeout + counts.failed : undefined;
};

export interface WatchState { runs: Record<string, RunMark> }

export interface WatchMessage { text: string; urgent: boolean }

const BLOCKED = new Set(['failed', 'budget-exceeded', 'awaiting-approval']);

const clean = (text: string, max: number): string => {
  const one = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const label = (run: ReleaseRunView): string => run.version ?? run.runId.slice(0, 8);

/** 그래프의 종결 자리표 — 노드가 아니라 끝을 표시한다(런 상태로 따로 말한다). */
const TERMINAL = new Set(['done', 'failed']);

function endedNodes(run: ReleaseRunView): ReleaseRunNodeView[] {
  return run.nodes.filter((node) => node.ok !== null && !TERMINAL.has(node.nodeId));
}

function runningNode(run: ReleaseRunView): ReleaseRunNodeView | undefined {
  return run.status === 'running' ? run.nodes.find((node) => node.ok === null) : undefined;
}

function minutesSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : null;
}

/** 노드 하나가 끝났을 때의 한 줄. 게이트는 도입 수·면제를 꼭 말한다(«통과»만으로는 면제를 못 읽는다). */
export function nodeLine(node: ReleaseRunNodeView): string {
  const mark = node.ok ? '✅' : '❌';
  const facts = node.facts ?? {};
  const parts: string[] = [`${mark} ${node.nodeId}`];
  if (facts.introduced !== undefined) parts.push(`도입 ${facts.introduced}${facts.preexisting !== undefined ? ` · 기존 ${facts.preexisting}` : ''}`);
  if (node.summary) parts.push(clean(node.summary, 120));
  else if (facts.verdict) parts.push(facts.verdict);
  let line = parts.join(' · ');
  if (facts.waiver) line += `\n   ⚠️ 면제 적용: ${clean(facts.waiver, 140)}`;
  return line;
}

function blockedLine(run: ReleaseRunView): string {
  const last = endedNodes(run).at(-1);
  const where = last ? `${last.nodeId}${last.ok === false ? ' 실패' : ''}` : '노드 기록 없음';
  const why = last?.summary ? ` — ${clean(last.summary, 140)}` : '';
  if (run.status === 'awaiting-approval') {
    return `⏸ ${label(run)} 발행 승인 대기 · ${where}${why}\n   다음 수: 승인 권한자(OP·대표)가 승인해야 다음 노드로 간다`;
  }
  const kind = run.status === 'budget-exceeded' ? '예산 초과로 멈춤' : '막힘';
  return `⛔ ${label(run)} 발행 ${kind} · ${where}${why}\n   다음 수: 담당 자리(TC·OP)가 재개 또는 면제를 판단한다 — 결정이 오면 이 채널로 알린다`;
}

/** 직전 표지와 지금 런을 견주어 보낼 줄을 만든다. 순수 함수 — 시험이 이것을 문다. */
export function diffRun(prev: RunMark | undefined, run: ReleaseRunView, now: number): { lines: string[]; urgent: boolean; changed: boolean } {
  const ended = endedNodes(run);
  const running = runningNode(run);
  const lines: string[] = [];
  let urgent = false;
  if (!prev) {
    // 이미 끝난 판은 조용히 기준만 잡는다 — 외출을 켤 때 지난 판이 쏟아지지 않게.
    if (run.status === 'done') return { lines, urgent, changed: true };
    // 처음 보는 런 — 지난 노드를 다시 쏟지 않고 «지금 어디인가» 한 줄로 시작한다.
    const total = run.path.filter((step) => !TERMINAL.has(step)).length || run.nodes.length;
    const where = run.status === 'running'
      ? `지금 ${running?.nodeId ?? '다음 노드 준비'}${running?.startedAt ? `(${minutesSince(running.startedAt, now)}분째)` : ''}`
      : `상태 ${run.status}`;
    lines.push(`📦 ${label(run)} 발행 따라가기 시작 · 끝난 노드 ${ended.length}${total ? `/${total}` : ''} · ${where}`);
    if (BLOCKED.has(run.status)) { lines.push(blockedLine(run)); urgent = true; }
    return { lines, urgent, changed: true };
  }
  for (const node of ended.slice(prev.ended)) {
    lines.push(nodeLine(node));
    if (node.ok === false) urgent = true;
  }
  if (running && running.nodeId !== prev.running && running.nodeId === 'gate') {
    lines.push(`▶ gate 시작${running.startedAt ? ` · ${new Date(running.startedAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false })} KST` : ''}`);
  }
  const bad = shardsBad(run);
  if (run.gateShards && bad !== undefined && bad > (prev.shardsBad ?? 0)) {
    lines.push(`⚠️ gate 조각 잘림·실패 ${bad} · ${shardsLine(run.gateShards.summary)}`);
  }
  if (run.status !== prev.status) {
    if (run.status === 'done') {
      const took = minutesSince(run.startedAt, now);
      lines.push(`🎉 ${label(run)} 발행 완료 · 노드 ${ended.length}${took !== null ? ` · ${Math.floor(took / 60)}시간 ${took % 60}분` : ''}`);
    } else if (BLOCKED.has(run.status)) {
      lines.push(blockedLine(run));
      urgent = true;
    } else if (run.status === 'running' && BLOCKED.has(prev.status)) {
      lines.push(`▶ ${label(run)} 발행 재개`);
    }
  }
  if (!lines.length && run.status === 'running' && now - Date.parse(prev.sentAt) >= ALIVE_EVERY_MS) {
    const mins = minutesSince(running?.startedAt, now);
    lines.push(`💓 ${label(run)} 발행 진행 중 · 지금 ${running?.nodeId ?? '다음 노드 준비'}${mins !== null ? `(${mins}분째)` : ''} · 끝난 노드 ${ended.length}/${run.path.filter((step) => !TERMINAL.has(step)).length || ended.length}`
      + (run.gateShards ? `\n   ${shardsLine(run.gateShards.summary)}` : ''));
  }
  const changed = lines.length > 0 || prev.ended !== ended.length || prev.status !== run.status || prev.running !== running?.nodeId
    || (bad !== undefined && bad !== prev.shardsBad);
  return { lines, urgent, changed };
}

export function markOf(run: ReleaseRunView, sentAt: string): RunMark {
  const running = runningNode(run);
  const bad = shardsBad(run);
  return { status: run.status, ended: endedNodes(run).length, ...(running ? { running: running.nodeId } : {}), sentAt,
    ...(bad !== undefined ? { shardsBad: bad } : {}) };
}

/** 따라갈 런 — 최근 36시간 안에 시작한 것만. 원장엔 «running» 인 채 버려진 옛 런이 있어 상태로 고르면 매시간 생존 줄이 샌다. */
export function followedRuns(runs: ReleaseRunView[], now: number): ReleaseRunView[] {
  return runs.filter((run) => now - Date.parse(run.startedAt) <= FOLLOW_WINDOW_MS);
}

export function composeMessage(lines: string[]): string {
  return [...lines, `↗ ${RELEASE_SCREEN_URL}`].join('\n');
}

export function watchStatePath(root: string = effectiveInstanceRoot()): string {
  return join(root, 'away', 'release-watch.json');
}

export function readWatchState(path: string = watchStatePath()): WatchState {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const runs = value && typeof value === 'object' ? (value as { runs?: unknown }).runs : undefined;
    return { runs: runs && typeof runs === 'object' ? runs as Record<string, RunMark> : {} };
  } catch { return { runs: {} }; }
}

export function writeWatchState(state: WatchState, path: string = watchStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

export interface TickDeps {
  presence?: () => Presence;
  runs?: () => ReleaseRunView[] | 'unavailable';
  readState?: () => WatchState;
  writeState?: (state: WatchState) => void;
  /** 보통 줄 — 야간 무음이면 아침까지 보류된다. */
  send?: (text: string) => boolean;
  /** 막힘·실패 — 야간 무음을 뚫는다. */
  sendUrgent?: (text: string) => boolean;
  now?: () => number;
}

export type TickOutcome =
  | { outcome: 'present' }
  | { outcome: 'unavailable' }
  | { outcome: 'quiet'; followed: number }
  | { outcome: 'sent'; followed: number; lines: number; urgent: boolean }
  | { outcome: 'send-failed'; followed: number; lines: number; urgent: boolean };

export interface UrgentIo {
  quiet: () => boolean;
  outbound: (text: string, kind: string) => boolean;
  deliver: (text: string, kind: string) => 'daemon' | 'direct' | false;
}

/** 막힘·실패 차선 — 야간 무음이면 보류 큐를 건너뛰고 바로 보낸다(`deliver`), 아니면 평소 길(`sendOutbound`). */
export function makeUrgentSender(io: UrgentIo = { quiet: () => inQuietHours(), outbound: sendOutbound, deliver: (t, k) => deliver(t, k) }): (text: string) => boolean {
  return (text) => io.quiet() ? io.deliver(text, 'ops-alert') !== false : io.outbound(text, 'ops-alert');
}

const defaultSendUrgent = makeUrgentSender();

/** 한 번 본다. 자리에 있으면 아무것도 안 한다(기준도 지운다 — 다음 외출이 지난 일을 다시 보내지 않게). */
export function releaseWatchTick(deps: TickDeps = {}): TickOutcome {
  const presence = (deps.presence ?? readPresence)();
  const writeState = deps.writeState ?? ((state: WatchState) => writeWatchState(state));
  if (!presence.away) {
    const state = (deps.readState ?? readWatchState)();
    if (Object.keys(state.runs).length) writeState({ runs: {} });
    return { outcome: 'present' };
  }
  const all = (deps.runs ?? (() => readReleaseRuns(null, undefined, { facts: true })))();
  if (all === 'unavailable') {
    try { debug.log('away.release-watch', 'runs-unavailable', {}); } catch { /* fail-open */ }
    return { outcome: 'unavailable' };
  }
  const now = (deps.now ?? Date.now)();
  const nowIso = new Date(now).toISOString();
  const state = (deps.readState ?? readWatchState)();
  const runs = followedRuns(all, now);
  const lines: string[] = [];
  let urgent = false;
  const next: WatchState = { runs: {} };
  let changed = false;
  for (const run of [...runs].reverse()) {
    const prev = state.runs[run.runId];
    const diff = diffRun(prev, run, now);
    lines.push(...diff.lines);
    urgent ||= diff.urgent;
    changed ||= diff.changed;
    next.runs[run.runId] = diff.lines.length ? markOf(run, nowIso) : { ...markOf(run, prev?.sentAt ?? nowIso) };
  }
  if (Object.keys(state.runs).some((id) => !next.runs[id])) changed = true;
  if (!lines.length) {
    if (changed) writeState(next);
    return { outcome: 'quiet', followed: runs.length };
  }
  const text = composeMessage(lines);
  const ok = urgent ? (deps.sendUrgent ?? defaultSendUrgent)(text) : (deps.send ?? ((t: string) => sendOutbound(t, 'op-report')))(text);
  try { debug.log('away.release-watch', ok ? 'sent' : 'send-failed', { followed: runs.length, lines: lines.length, urgent }); } catch { /* fail-open */ }
  // 못 보냈으면 기준을 옮기지 않는다 — 다음 틱이 같은 줄을 다시 시도한다(중복 대신 누락을 막는 쪽).
  if (ok) writeState(next);
  return { outcome: ok ? 'sent' : 'send-failed', followed: runs.length, lines: lines.length, urgent };
}

/** /release · away status 가 쓰는 «지금» 요약 — 가장 최근 런 하나. */
export function releaseNowText(runs: ReleaseRunView[] | 'unavailable', now: number = Date.now()): string {
  if (runs === 'unavailable') return '발행 런 원장을 못 읽었다(권한·디스크) — 「없다」가 아니다';
  const run = runs[0];
  if (!run) return `발행 런 기록 없음\n↗ ${RELEASE_SCREEN_URL}`;
  const ended = endedNodes(run);
  const running = runningNode(run);
  const total = run.path.filter((step) => !TERMINAL.has(step)).length || run.nodes.length;
  const head = `📦 ${label(run)} · ${run.status} · 끝난 노드 ${ended.length}${total ? `/${total}` : ''}`;
  const lines = [head];
  if (running) {
    const mins = minutesSince(running.startedAt, now);
    lines.push(`지금: ${running.nodeId}${mins !== null ? ` (${mins}분째)` : ''}`);
    if (run.gateShards) lines.push(`   ${shardsLine(run.gateShards.summary)}`);
  }
  const last = ended.at(-1);
  if (last) lines.push(`마지막: ${nodeLine(last)}`);
  if (BLOCKED.has(run.status)) lines.push(blockedLine(run));
  const started = minutesSince(run.startedAt, now);
  if (started !== null) lines.push(`시작 ${Math.floor(started / 60)}시간 ${started % 60}분 전`);
  lines.push(`↗ ${RELEASE_SCREEN_URL}`);
  return lines.join('\n');
}
