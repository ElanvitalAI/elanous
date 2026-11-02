import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { findGitDir } from '../git-fs/locate.js';
import { runVisibleAgentMission, type VisibleMissionPty, type VisibleMissionResult } from '../sidetab-core/visible-agent-mission.js';
import type { ClassicSidetabMissionDispatchContext, ClassicSidetabMissionPairSessionRegistry, ClassicSidetabMissionResult } from './classic-sidetab-mission.js';
import { redactMissionResultPath } from './mission-cli-consumer.js';
import type { ClassicMissionNotificationEnqueue } from './classic-sidetab-mission-job.js';

export type ClassicMissionAgent = 'codex' | 'claude' | 'grok';

/** Run one visible hand through the same identity/trust policy used by the classic trio entrypoint. */
export function runClassicSidetabMissionTrioMember(input: {
  member: ClassicMissionAgent;
  cwd: string;
  pty: VisibleMissionPty;
  mission: string;
  outputPath: string;
  handleTrust: (screen: string, write: (bytes: string) => void) => boolean;
}): Promise<VisibleMissionResult> {
  return runVisibleAgentMission({
    agent: input.member,
    pty: input.pty,
    mission: input.mission,
    outputPath: input.outputPath,
    handleTrust: input.handleTrust,
    allowWorkspaceTrustOnce: input.member === 'grok' && findGitDir(input.cwd)?.isWorktree === true,
    allowDemoStartupDismissalsOnce: true,
  });
}

/** Production adapter shared by the dashboard dispatch and the trio integration test.
 * The only replaceable boundary is the PTY/session adapter; member driving, trust
 * handling, exit-code capture, and result decoration stay on this path. */
export function createClassicSidetabMissionTrioVisibleRunner<Session extends TrioSession>(deps: {
  ptyForSession: (session: Session) => VisibleMissionPty;
  outputPath: (agent: ClassicMissionAgent, session: Session) => string;
  handleTrust: (agent: ClassicMissionAgent, screen: string, write: (bytes: string) => void) => boolean;
  onFailure?: (agent: ClassicMissionAgent, result: VisibleMissionResult, missionId?: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): StartClassicSidetabMissionTrioDeps<Session>['runVisible'] {
  return async (agent, mission, session, missionId) => {
    const outputPath = session ? deps.outputPath(agent, session) : '';
    if (!session) return { ok: false, status: 'failed', path: outputPath, error: `${agent} sidetab PTY could not start` };
    try {
      const pty = deps.ptyForSession(session);
      const result = await runClassicSidetabMissionTrioMember({
        member: agent, cwd: session.cwd, pty, mission, outputPath,
        handleTrust: (screen, write) => deps.handleTrust(agent, screen, write),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      });
      deps.onFailure?.(agent, result, missionId);
      return { ...result, status: result.ok ? 'completed' : 'failed', interactionId: missionId, finalScreen: pty.snapshot() };
    } catch (error) {
      let finalScreen: string | undefined;
      try { finalScreen = deps.ptyForSession(session).snapshot(); } catch { /* detached PTY */ }
      return {
        ok: false, status: 'failed', path: outputPath, interactionId: missionId,
        error: error instanceof Error ? error.message : String(error), ...(finalScreen ? { finalScreen } : {}),
      };
    }
  };
}

interface TrioSession { id: string; cwd: string }
interface MissionOutcome extends ClassicSidetabMissionResult { content?: string; completionMarker?: boolean; exitCode?: number | null }
const MAX_FINAL_SCREEN_CHARS = 4_000;

export function captureClassicMissionExitObservation(
  sessionExited: boolean,
  sessionExitCode: number | null,
): Partial<Pick<ClassicSidetabMissionResult, 'exitCode' | 'exitObservation'>> {
  return sessionExited ? { exitCode: sessionExitCode, exitObservation: 'natural-exit' } : {};
}

export interface StartClassicSidetabMissionTrioDeps<Session extends TrioSession> {
  mission: string;
  context?: ClassicSidetabMissionDispatchContext;
  checkGrokAuth: () => { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;
  spawnVisible: (agent: ClassicMissionAgent, missionId: string, attemptId: string) => Session | null;
  runVisible: (agent: ClassicMissionAgent, mission: string, session: Session | null, missionId?: string) => Promise<MissionOutcome>;
  registry: ClassicSidetabMissionPairSessionRegistry;
  enqueue: ClassicMissionNotificationEnqueue;
  now?: () => number;
  createId?: () => string;
  timeoutMs?: number;
}

export interface ClassicSidetabMissionTrioStart {
  trioId: string;
  members: Record<ClassicMissionAgent, ClassicSidetabMissionResult>;
  grokFallback?: string;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_ANSWER_CHARS = 8_000;

function missionForHand(mission: string, agent: ClassicMissionAgent): string {
  return mission.replaceAll('<hand>', agent);
}

function markdownCell(value: string | undefined): string {
  return (value ?? '—').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
}

function fenced(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${value}\n${fence}`;
}

function renderTrioSynthesis(mission: string, results: Record<ClassicMissionAgent, MissionOutcome>): string {
  const agents: ClassicMissionAgent[] = ['codex', 'claude', 'grok'];
  const rows = agents.map((agent) => {
    const result = results[agent];
    const exitCode = result.exitObservation === 'cleanup-exit'
      ? '정리 종료 관측 (미션 코드 아님)'
      : result.exitObservation === 'cleanup-unobserved'
        ? '정리 요청 · 종료 미관측 (코드 미상)'
        : result.exitObservation === 'natural-exit'
          ? `자연 종료 (${result.exitCode === null ? '코드 미상' : `코드 ${result.exitCode}`})`
          : result.exitCode === undefined ? '미수집' : result.exitCode === null ? '미상' : String(result.exitCode);
    const marker = result.completionMarker === undefined ? '미수집' : result.completionMarker ? '확인' : '없음';
    return `| ${agent} | ${markdownCell(mission)} | ${markdownCell(result.path)} | ${result.ok ? '완료' : markdownCell(result.error ?? result.status ?? '실패')} | ${exitCode} | ${marker} |`;
  });
  const candidates = agents.map((agent) => {
    const result = results[agent];
    return [`### ${agent}`, `- 결과 경로: ${result.path ?? '없음'}`, `- 상태: ${result.ok ? '완료' : result.error ?? result.status ?? '실패'}`, `- 종료 코드: ${result.exitCode === undefined ? '미확인' : result.exitCode === null ? '알 수 없음' : result.exitCode}`, '', result.content?.trim() ? fenced(result.content.trim()) : '_결과 내용 없음_'].join('\n');
  });
  return [
    '# Sidetab mission synthesis record',
    '',
    '## 요청',
    fenced(mission),
    '',
    '## 손별 귀속',
    '| 손 | 맡은 일 | 결과 파일 | 결과 상태 | 종료 관측 | 완료 표식 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## 후보 결과',
    ...candidates,
    '',
    '## 채택 결과',
    '_최종 채택문은 알림을 받은 부모 응답에서 작성한다. 성공 후보가 있으면 이 후보들만 근거로 채택하고, 성공 후보가 하나면 그 결과를 그대로 채택한다._',
    '',
    '## 채택 근거',
    '_후보별 상태와 원문은 위 표에 기록했다. 실패한 손은 채택 근거에서 제외한다._',
    '',
  ].join('\n');
}

function persistTrioSynthesis(cwd: string, trioId: string, mission: string, results: Record<ClassicMissionAgent, MissionOutcome>): string {
  const safeId = trioId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || randomUUID();
  const dir = join(cwd, '.elanous', 'mission-results');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `classic-trio-synthesis-${safeId}.md`);
  writeFileSync(path, renderTrioSynthesis(mission, results), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

/** Starts three visible PTYs with one verbatim goal; an unavailable Grok degrades to Codex + Claude. */
export async function startClassicSidetabMissionTrio<Session extends TrioSession>(
  deps: StartClassicSidetabMissionTrioDeps<Session>,
): Promise<{ result: ClassicSidetabMissionTrioStart; completion: Promise<void> }> {
  const createId = deps.createId ?? randomUUID;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  // Start the two available hands before probing Grok. A delayed or stuck
  // login check must not hold Codex back from starting its demo work.
  const ids = new Map<ClassicMissionAgent, string>();
  const sessions = new Map<ClassicMissionAgent, Session | null>();
  const agents: ClassicMissionAgent[] = [];
  const spawn = (agent: ClassicMissionAgent): Session | null => {
    const missionId = createId();
    ids.set(agent, missionId);
    agents.push(agent);
    const session = deps.spawnVisible(agent, missionId, createId());
    if (!session) {
      ids.delete(agent);
      agents.pop();
      return null;
    }
    sessions.set(agent, session);
    return session;
  };
  spawn('claude');
  spawn('codex');
  const grokAuth = await deps.checkGrokAuth();
  let grokFallback = grokAuth.ok ? undefined : grokAuth.reason ?? 'Grok login unavailable';
  if (grokAuth.ok && !spawn('grok')) {
    grokFallback = 'Grok sidetab PTY could not start';
  }
  const sessionIds = [...sessions.values()].flatMap((session) => session ? [session.id] : []);
  const missionIds = [...ids.values()];
  deps.registry.register(missionIds, sessionIds);
  const outcomes = new Map<ClassicMissionAgent, Promise<MissionOutcome>>();
  const completedOutcomes = new Map<ClassicMissionAgent, MissionOutcome>();
  for (const agent of agents) {
    const session = sessions.get(agent) ?? null;
    if (agent === 'grok' && !session) continue;
    const outcome = Promise.resolve().then(() => deps.runVisible(agent, missionForHand(deps.mission, agent), session, ids.get(agent))).catch((error): MissionOutcome => ({
      ok: false, status: 'failed', error: error instanceof Error ? error.message : String(error),
    }));
    outcomes.set(agent, outcome.then((result) => { completedOutcomes.set(agent, result); return result; }));
  }
  const members: Record<ClassicMissionAgent, ClassicSidetabMissionResult> = {
    codex: sessions.get('codex') ? { ok: true, status: 'running', interactionId: ids.get('codex') } : { ok: false, status: 'failed', error: 'Codex sidetab PTY could not start' },
    claude: sessions.get('claude') ? { ok: true, status: 'running', interactionId: ids.get('claude') } : { ok: false, status: 'failed', error: 'Claude sidetab PTY could not start' },
    grok: sessions.get('grok') ? { ok: true, status: 'running', interactionId: ids.get('grok') } : { ok: false, status: 'failed', error: grokFallback ?? 'Grok sidetab PTY could not start' },
  };
  const taskId = deps.context?.callId || ids.get('codex') || ids.get('claude') || createId();
  const timeoutMs = Math.max(1, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  const settled = Promise.all([...outcomes].map(async ([agent, promise]) => [agent, await promise] as const))
    .then((results) => {
      // A timeout reports the partial evidence but leaves visible PTYs alive
      // and cancellable. Release their mission mapping only after they settle.
      deps.registry.clear(missionIds);
      return results;
    });
  const completion = Promise.race([settled.then((results) => ({ didTimeout: false, results })), timedOut.then(() => ({ didTimeout: true, results: [...completedOutcomes.entries()] as const }))]).then(({ didTimeout, results }) => {
    const finishedAt = now();
    const all: Record<ClassicMissionAgent, MissionOutcome> = {
      codex: { ...members.codex, ...(members.codex.status === 'running' ? { error: undefined } : {}) },
      claude: { ...members.claude, ...(members.claude.status === 'running' ? { error: undefined } : {}) },
      grok: { ...members.grok, ...(members.grok.status === 'running' ? { error: undefined } : {}) },
    };
    for (const [agent, outcome] of results) all[agent] = outcome;
    let synthesisPath: string | undefined;
    let synthesisError: string | undefined;
    const artifactCwd = [...sessions.values()].find((session): session is Session => Boolean(session))?.cwd;
    if (artifactCwd) {
      try {
        const trioId = `trio-${ids.get('codex') ?? ids.get('claude') ?? createId()}`;
        synthesisPath = persistTrioSynthesis(artifactCwd, trioId, deps.mission, all);
        debug.log('classic-sidetab.mission-trio', 'synthesis-record-written', {
          taskId,
          trioId,
          resultPath: synthesisPath,
          candidateCount: Object.values(all).filter((result) => Boolean(result.path || result.content)).length,
        });
      } catch (error) {
        synthesisError = error instanceof Error ? error.message : String(error);
      }
    } else {
      synthesisError = 'no sidetab workspace was available for the synthesis record';
    }
    const timeoutReason = didTimeout ? 'mission exceeded the configured safety timeout' : undefined;
    const answer = (agent: ClassicMissionAgent): string => {
      const result = all[agent];
      const screen = result.finalScreen?.trim();
      const screenRecord = screen ? `\n\n${agent} final raw PTY screen:\n${screen.length > MAX_FINAL_SCREEN_CHARS ? `${screen.slice(-MAX_FINAL_SCREEN_CHARS)}\n[screen tail truncated]` : screen}` : '';
      const initial = result.initialScreen?.trim();
      const initialRecord = initial ? `\n\n${agent} first PTY snapshot:\n${initial.length > 1_200 ? `${initial.slice(-1_200)}\n[first screen tail truncated]` : initial}` : '';
      if (timeoutReason && result.status === 'running') return `${agent}: ${timeoutReason}${initialRecord}${screenRecord}`;
      if (!result.ok) return `${agent}: ${result.error ?? 'failed; no answer returned'}${initialRecord}${screenRecord}`;
      const content = result.content?.trim();
      if (!content) return `${agent}: completed without an answer${screenRecord}`;
      const safe = redactMissionResultPath(content, result.path);
      return `${agent} candidate:\n${safe.length > MAX_ANSWER_CHARS ? `${safe.slice(0, MAX_ANSWER_CHARS)}\n[answer truncated]` : safe}${initialRecord}${screenRecord}`;
    };
    const grokFailed = Boolean(grokFallback) || !all.grok.ok;
    // When Grok cannot start, the run is explicitly a two-hand fallback;
    // do not count the unstarted Grok hand as missing coverage or a failure.
    const expectedAgents = grokFallback ? (['codex', 'claude'] as const) : (['codex', 'claude', 'grok'] as const);
    const candidateAgents = expectedAgents.filter((agent) => all[agent].ok && Boolean(all[agent].content?.trim()));
    const failedMembers = expectedAgents
      .filter((agent) => !candidateAgents.includes(agent))
      .map((agent) => ({
        agent,
        reason: timeoutReason && all[agent].status === 'running'
          ? timeoutReason
          : all[agent].error ?? (all[agent].ok ? 'completed without an answer' : all[agent].status ?? 'failed'),
      }));
    // A completed notification with at least one candidate lets the parent
    // synthesize/adopt the available work. `coverage` describes partial runs;
    // state and JSON status intentionally share the same done/error value.
    const notificationStatus = candidateAgents.length > 0 ? 'done' : 'error';
    const coverage = candidateAgents.length === 0 ? 'none' : candidateAgents.length === expectedAgents.length ? 'complete' : 'partial';
    const body = [
      `Three-hand comparison · same goal · ${grokFailed ? `Grok unavailable; continued with Codex + Claude (${all.grok.error ?? 'failed'})` : 'Codex + Claude + Grok results'}`,
      `Coverage: ${coverage}; successful candidates: ${candidateAgents.length ? candidateAgents.join(', ') : 'none'}; failed members: ${failedMembers.length ? failedMembers.map(({ agent, reason }) => `${agent} (${reason})`).join('; ') : 'none'}.`,
      `Hand evidence: ${expectedAgents.map((agent) => { const result = all[agent]; const exit = result.exitObservation === 'cleanup-exit' ? 'cleanup-exit; mission exit=unknown' : result.exitObservation === 'cleanup-unobserved' ? 'cleanup-requested; exit-unobserved' : result.exitObservation === 'natural-exit' ? `natural-exit; exit=${result.exitCode === null ? 'unknown' : result.exitCode}` : result.exitCode === undefined ? 'not captured' : result.exitCode === null ? 'unknown' : String(result.exitCode); return `${agent} ${exit}, completion-marker=${result.completionMarker === undefined ? 'not captured' : result.completionMarker ? 'yes' : 'no'}`; }).join('; ')}.`,
      synthesisPath ? `Synthesis record: ${synthesisPath}` : `Synthesis record unavailable: ${synthesisError ?? 'unknown write failure'}`,
      candidateAgents.length > 0
        ? 'Adopt or synthesize the final answer from the successful candidates only. If exactly one candidate succeeded, adopt it directly. Name failed members and never imply they succeeded.'
        : 'No candidate succeeded; explicitly report that no result can be adopted.',
      '', answer('codex'), '', answer('claude'), '', answer('grok'), '',
      candidateAgents.length > 0 ? 'Present a non-empty adopted result and a short reason.' : 'Leave the adopted result explicitly unavailable; do not fabricate one.',
    ].join('\n');
    try {
      deps.enqueue({
        taskId,
        ...(deps.context?.parentSessionId ? { parentSessionId: deps.context.parentSessionId } : {}),
        agentName: grokFailed ? 'Codex + Claude (Grok fallback)' : 'Codex + Claude + Grok',
        label: 'sidetab mission comparison',
        state: notificationStatus,
        output: JSON.stringify({ status: notificationStatus, coverage, successfulMembers: candidateAgents, failedMembers, body, artifacts: synthesisPath ? [synthesisPath] : [], id: ids.get('codex') ?? ids.get('claude') ?? taskId, grokFallback: grokFailed ? all.grok.error : undefined }),
        ...(synthesisPath ? { resultPath: synthesisPath } : {}),
        truncated: body.includes('[answer truncated]'),
        durationMs: Math.max(0, finishedAt - startedAt),
        finishedAt,
      });
    } catch { /* notification delivery cannot interrupt the missions */ }
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
  });

  return { result: { trioId: `trio-${ids.get('codex') ?? ids.get('claude') ?? createId()}`, members, ...(grokFallback ? { grokFallback } : {}) }, completion };
}
