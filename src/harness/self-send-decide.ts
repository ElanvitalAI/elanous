import { normalizeSpaceId } from './harness-space.js';
import type { SelfSendTargetResolution } from './self-send-target.js';

export const SELF_SEND_RECENT_FRAME_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SELF_SEND_STALE_HEARTBEAT_MS = 5 * 60 * 1000;

export interface SelfSendCandidate {
  readonly spaceId: string;
  readonly mtimeMs?: number;
  readonly liveness?: 'alive' | 'dead' | 'unknown';
  readonly heartbeatAtMs?: number;
}

export interface SelfSendCandidateDisplay {
  readonly lines: readonly string[];
  readonly hiddenStaleCount: number;
}

const SELF_SEND_GOAL_ATTEMPT_SUFFIX = /^(.*)-[0-9a-f]{8}(?:-r[a-z0-9]{6})?$/;

function selfSendGoalPrefix(spaceId: string): string | undefined {
  return SELF_SEND_GOAL_ATTEMPT_SUFFIX.exec(spaceId)?.[1];
}

function newestSelfSendAttempt(members: readonly SelfSendCandidate[]): SelfSendCandidate | undefined {
  if (members.length === 0 || members.some((member) => !Number.isFinite(member.mtimeMs))) return undefined;
  let newest = members[0]!;
  for (const member of members) if (member.mtimeMs! > newest.mtimeMs!) newest = member;
  return newest;
}

function formatSelfSendHeartbeatAge(heartbeatAtMs: number, now: number): string | undefined {
  if (!Number.isFinite(heartbeatAtMs)) return undefined;
  const seconds = Math.floor(Math.max(0, now - heartbeatAtMs) / 1_000);
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

export function formatSelfSendCandidateDisplay(
  candidates: readonly SelfSendCandidate[],
  { includeStale = false, now }: { includeStale?: boolean; now: number },
): SelfSendCandidateDisplay {
  const recent: SelfSendCandidate[] = [];
  const stale: SelfSendCandidate[] = [];
  for (const candidate of candidates) {
    const mtimeMs = candidate.mtimeMs;
    if (Number.isFinite(mtimeMs) && mtimeMs! >= now - SELF_SEND_RECENT_FRAME_WINDOW_MS && mtimeMs! <= now) recent.push(candidate);
    else stale.push(candidate);
  }
  const displayed = includeStale ? [...recent, ...stale] : recent;
  const groups = new Map<string, SelfSendCandidate[]>();
  for (const candidate of candidates) {
    const prefix = selfSendGoalPrefix(candidate.spaceId);
    if (prefix === undefined) continue;
    const members = groups.get(prefix);
    if (members) members.push(candidate);
    else groups.set(prefix, [candidate]);
  }
  return {
    lines: displayed.map((candidate) => {
      const timestamp = Number.isFinite(candidate.mtimeMs) ? new Date(candidate.mtimeMs!).toISOString() : '알 수 없음';
      const prefix = selfSendGoalPrefix(candidate.spaceId);
      const members = prefix === undefined ? undefined : groups.get(prefix);
      let annotation = '';
      if (members && new Set(members.map((member) => member.spaceId)).size >= 2) {
        annotation = '  · 같은 골의 다른 시도';
        const newest = newestSelfSendAttempt(members);
        if (newest !== undefined && candidate.mtimeMs === newest.mtimeMs) annotation += ' · 가장 최근';
      }
      const liveness = candidate.liveness ?? 'unknown';
      const heartbeatAge = liveness === 'alive' && candidate.heartbeatAtMs !== undefined
        ? formatSelfSendHeartbeatAge(candidate.heartbeatAtMs, now) : undefined;
      const livenessAnnotation = liveness === 'alive'
        ? `  · 자식 생존${heartbeatAge === undefined ? '' : ` (heartbeat ${heartbeatAge})`}`
        : liveness === 'dead' ? '  · 자식 사망 (heartbeat alive=false)' : '';
      return `  ${candidate.spaceId}  마지막 프레임: ${timestamp}${annotation}${livenessAnnotation}`;
    }),
    hiddenStaleCount: includeStale ? 0 : stale.length,
  };
}

export interface SelfSendRunScreen {
  logStoreStatus: string;
  logStorePath: string;
  screenKey?: string | null;
  lastEvent?: { category: string; event: string; timestamp: string } | null;
  missingStatus?: 'awaiting-start' | 'pipeline-failed' | 'cleaned' | 'not-found' | string;
}

export interface SelfSendLedger {
  runId: string;
  entries: readonly { event: string; data: Record<string, unknown> }[];
}

export interface SelfSendDecisionInput {
  space?: string;
  opts: { stop?: boolean; memo?: string; run?: string; includeStale?: boolean; readWait?: string };
  now: number;
}

export interface SelfSendDecisionDeps {
  resolveRunScreen(runId: string): SelfSendRunScreen;
  podFragmentsForRun(runId: string): readonly { spaceId: string }[];
  resolveTarget(space: string): SelfSendTargetResolution;
  isPodFragment(spaceId: string): boolean;
  screens(): readonly SelfSendCandidate[];
  ledgers(): readonly SelfSendLedger[];
  runScreenKey(runId: string): string | null | undefined;
}

export type SelfSendDecision =
  | { kind: 'refuse'; message: string; exitCode: 1 | 2 }
  | { kind: 'send'; spaceId: string; channel: 'inbox' | 'pod'; warnings: readonly string[] };

const refuse = (message: string, exitCode: 1 | 2): SelfSendDecision => ({ kind: 'refuse', message, exitCode });

export function decideSelfSend(input: SelfSendDecisionInput, deps: SelfSendDecisionDeps): SelfSendDecision {
  const { space, opts, now } = input;
  if (space !== undefined && opts.run !== undefined) return refuse('--run 과 space 는 함께 사용할 수 없습니다.\n', 2);
  if (opts.run !== undefined && opts.run.trim() === '') return refuse('--run 에 빈 runId 를 줄 수 없습니다.\n', 2);
  let requestedSpace = space;
  let podRunSpace: string | undefined;
  if (opts.run !== undefined) {
    const resolved = deps.resolveRunScreen(opts.run);
    if (resolved.logStoreStatus !== 'read' && resolved.screenKey) {
      return refuse(`run 화면 해석 불가: 로그 스토어 ${resolved.logStoreStatus} (${resolved.logStorePath})\n`, 1);
    }
    if (!resolved.screenKey) {
      const fragments = deps.podFragmentsForRun(opts.run);
      if (fragments.length === 1) requestedSpace = podRunSpace = fragments[0]!.spaceId;
      else {
        if (fragments.length > 1) return refuse(`run 의 Pod 조각이 여러 개입니다: ${opts.run}. space 이름으로 다시 보내세요:\n${fragments.map((fragment) => `  ${fragment.spaceId}`).join('\n')}\n`, 2);
        if (resolved.logStoreStatus !== 'read') {
          return refuse(`run 화면 해석 불가: 로그 스토어 ${resolved.logStoreStatus} (${resolved.logStorePath}) · Pod 조각 기록도 0\n`, 1);
        }
        const last = resolved.lastEvent;
        const lastDetail = last
          ? ` 마지막 이벤트: ${last.category}/${last.event} (${Number.isFinite(Date.parse(last.timestamp)) ? `${Math.max(0, Math.floor((now - Date.parse(last.timestamp)) / 60_000))}분 전` : '시각 알 수 없음'})`
          : ' 마지막 이벤트: 없음';
        const status = resolved.missingStatus;
        const guidance = status === 'awaiting-start'
          ? '아직 화면을 띄우기 전입니다. 되묻기에 답하거나 저작이 끝날 때까지 기다리세요.'
          : status === 'pipeline-failed' ? '파이프라인이 오류로 멈췄습니다. 해당 error를 읽어 원인을 수리하세요.'
            : status === 'cleaned' ? '하니스가 정리되어 화면이 없습니다. 필요하면 새 런을 시작하세요.'
              : status === 'not-found' ? '이 runId의 이벤트가 없습니다. runId와 인스턴스 우주를 확인하세요.'
                : '화면을 아직 분류할 수 없습니다. 마지막 이벤트를 조사하세요.';
        return refuse(`run 화면 해석 불가: ${guidance}${lastDetail} (${opts.run}) · Pod 조각 기록도 0\n`, 1);
      }
    } else requestedSpace = normalizeSpaceId(resolved.screenKey);
  }
  const hasMemo = opts.memo !== undefined;
  if (opts.stop && hasMemo) return refuse('self send에서는 --stop 과 --memo를 함께 사용할 수 없습니다.\n', 2);
  if (!opts.stop && !hasMemo) return refuse('self send에는 --stop 또는 --memo <sentence>가 필요합니다.\n', 2);
  if (space !== undefined) {
    const resolution = deps.resolveTarget(space);
    if (resolution.kind === 'refuse') {
      const hint = resolution.hint === undefined ? '' : ` 대신 space ${resolution.hint}를 지정하세요.`;
      const reason = resolution.reason === 'tui-self-report-has-no-inbox-reader'
        ? 'tui 자기 보고 대상에는 control inbox를 읽는 쪽이 없습니다.'
        : resolution.reason === 'pty-not-found' ? '지정한 PTY를 찾을 수 없습니다.'
          : '지정한 PTY에 연결된 harness space가 없습니다.';
      return refuse(`self send 대상 거절: ${reason}${hint}\n`, 2);
    }
    requestedSpace = resolution.spaceId;
  }
  if (requestedSpace !== undefined && (podRunSpace !== undefined || deps.isPodFragment(requestedSpace))) {
    return { kind: 'send', spaceId: requestedSpace, channel: 'pod', warnings: [] };
  }
  const screens = deps.screens();
  const explicitScreen = requestedSpace === undefined ? undefined : screens.find((screen) => screen.spaceId === requestedSpace);
  if (requestedSpace !== undefined && !explicitScreen) {
    const candidates = screens.length === 0 ? '  (후보 없음)' : screens.map((screen) => `  ${screen.spaceId}`).join('\n');
    if (opts.run !== undefined) return refuse(`run 화면 해석 불가: 해석한 화면이 없습니다: ${requestedSpace} (${opts.run})\n`, 1);
    return refuse(`알 수 없는 self send 대상 space: ${requestedSpace}. 후보 중 하나를 지정하세요:\n${candidates}\n`, 2);
  }
  if (space !== undefined && explicitScreen) {
    const goalPrefix = selfSendGoalPrefix(explicitScreen.spaceId);
    const sameGoalAttempts = goalPrefix === undefined ? [] : screens.filter((screen) => selfSendGoalPrefix(screen.spaceId) === goalPrefix);
    const newest = newestSelfSendAttempt(sameGoalAttempts);
    if (newest !== undefined && newest.spaceId !== explicitScreen.spaceId && newest.mtimeMs! > explicitScreen.mtimeMs!) {
      return refuse(`지정한 self send 대상은 같은 골의 더 최근 시도로 교체되었습니다: ${explicitScreen.spaceId} → ${newest.spaceId}. 더 최근 space를 지정해 다시 보내세요.\n`, 2);
    }
  }
  if (requestedSpace === undefined && screens.length !== 1) {
    const display = formatSelfSendCandidateDisplay(screens, { includeStale: opts.includeStale, now });
    const candidates = screens.length === 0 ? '  (후보 없음)' : [
      ...display.lines,
      ...(display.hiddenStaleCount > 0 ? [`  오래된 후보 ${display.hiddenStaleCount}개 숨김 (--include-stale로 표시)`] : []),
    ].join('\n');
    return refuse(`soft stop 대상이 모호합니다. space를 지정하세요. 후보와 마지막 프레임 시각:\n${candidates}\n`, 2);
  }
  const selectedScreen = requestedSpace === undefined ? screens[0]! : explicitScreen!;
  const warnings: string[] = [];
  if (hasMemo) {
    let runId = opts.run;
    let lifecycle: 'continuing' | 'terminal' | 'unknown' = 'unknown';
    try {
      const ledgers = deps.ledgers();
      if (runId === undefined) {
        for (const candidate of ledgers) {
          if (normalizeSpaceId(deps.runScreenKey(candidate.runId) ?? '') === selectedScreen.spaceId) {
            runId = candidate.runId;
            break;
          }
        }
      }
      if (runId !== undefined) {
        const ledger = ledgers.find((candidate) => candidate.runId === runId)?.entries;
        if (ledger !== undefined) {
          for (const entry of ledger) {
            if (entry.event === 'start' || entry.event === 'run-start' || (entry.event === 'run-status' && entry.data.runStatus === 'running')) lifecycle = 'continuing';
            else if (entry.event === 'terminal' || entry.event === 'run-status') lifecycle = 'terminal';
          }
        }
      }
    } catch { /* unreadable lifecycle evidence remains unknown */ }
    if (lifecycle === 'terminal') {
      return refuse(`self send 대상 런이 이미 종료되었습니다: ${runId ?? selectedScreen.spaceId}. 메모를 기록하지 않았습니다. 새 런을 시작해 다시 보내세요.\n`, 2);
    }
    if (lifecycle === 'unknown') warnings.push(`경고: self send 대상 런의 lifecycle 상태를 알 수 없습니다: ${runId ?? selectedScreen.spaceId}. 기록은 계속합니다.\n`);
  } else if (selectedScreen.liveness === 'dead') {
    return refuse(`self send 대상 자식이 heartbeat alive=false로 사망한 상태입니다: ${selectedScreen.spaceId}. 메모를 기록하지 않았습니다. 새 런을 시작하거나 살아 있는 space를 지정해 다시 보내세요.\n`, 2);
  }
  if (selectedScreen.liveness === 'unknown') warnings.push(`경고: self send 대상의 heartbeat 상태를 알 수 없습니다: ${selectedScreen.spaceId}. 기록은 계속합니다.\n`);
  if (selectedScreen.liveness === 'alive' && selectedScreen.heartbeatAtMs !== undefined && now - selectedScreen.heartbeatAtMs > SELF_SEND_STALE_HEARTBEAT_MS) {
    warnings.push(`경고: self send 대상 space가 죽어 보입니다: ${selectedScreen.spaceId}. heartbeat가 5분보다 오래되어 메모가 전달되지 않을 수 있습니다.\n`);
  }
  return { kind: 'send', spaceId: selectedScreen.spaceId, channel: 'inbox', warnings };
}
