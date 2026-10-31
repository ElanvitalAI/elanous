import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClassicSidetabMissionDispatchContext, ClassicSidetabMissionPairSessionRegistry, ClassicSidetabMissionResult } from './classic-sidetab-mission.js';
import { redactMissionResultPath } from './mission-cli-consumer.js';
import type { ClassicMissionNotificationEnqueue } from './classic-sidetab-mission-job.js';

export type ClassicMissionAgent = 'codex' | 'claude' | 'grok';

interface TrioSession { id: string; cwd: string }
interface MissionOutcome extends ClassicSidetabMissionResult { content?: string }
const MAX_FINAL_SCREEN_CHARS = 4_000;

export interface StartClassicSidetabMissionTrioDeps<Session extends TrioSession> {
  mission: string;
  context?: ClassicSidetabMissionDispatchContext;
  checkGrokAuth: () => { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;
  spawnVisible: (agent: ClassicMissionAgent, missionId: string, attemptId: string) => Session | null;
  runVisible: (agent: ClassicMissionAgent, mission: string, session: Session | null, missionId?: string) => Promise<MissionOutcome>;
  registry: ClassicSidetabMissionPairSessionRegistry;
  hasSession: (sessionId: string) => boolean;
  killSession: (sessionId: string) => void;
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
    return `| ${agent} | ${markdownCell(mission)} | ${markdownCell(result.path)} | ${result.ok ? '완료' : markdownCell(result.error ?? result.status ?? '실패')} |  |`;
  });
  const candidates = agents.map((agent) => {
    const result = results[agent];
    return [`### ${agent}`, `- 결과 경로: ${result.path ?? '없음'}`, `- 상태: ${result.ok ? '완료' : result.error ?? result.status ?? '실패'}`, '', result.content?.trim() ? fenced(result.content.trim()) : '_결과 내용 없음_'].join('\n');
  });
  return [
    '# Sidetab mission synthesis record',
    '',
    '## 요청',
    fenced(mission),
    '',
    '## 손별 귀속',
    '| 손 | 맡은 일 | 결과 파일 | 결과 상태 | 채택 여부 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## 후보 결과',
    ...candidates,
    '',
    '## 채택 결과',
    '_부모 응답에서 확정_',
    '',
    '## 채택 근거',
    '_부모 응답에서 확정_',
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
  // Start the first hand before the bounded subscribed-access probe. The
  // probe may need a network round-trip, but must not consume the whole
  // 30-second three-hand startup budget before any visible work begins.
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
  for (const agent of agents) {
    const session = sessions.get(agent) ?? null;
    if (agent === 'grok' && !session) continue;
    outcomes.set(agent, Promise.resolve().then(() => deps.runVisible(agent, deps.mission, session, ids.get(agent))).catch((error) => ({
      ok: false, status: 'failed', error: error instanceof Error ? error.message : String(error),
    })));
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
    timeout = setTimeout(() => {
      for (const sessionId of sessionIds) if (deps.hasSession(sessionId)) deps.killSession(sessionId);
      resolve();
    }, timeoutMs);
  });
  const settled = Promise.all([...outcomes].map(async ([agent, promise]) => [agent, await promise] as const));
  const completion = Promise.race([settled.then((results) => ({ didTimeout: false, results })), timedOut.then(() => ({ didTimeout: true, results: [] as const }))]).then(({ didTimeout, results }) => {
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
    const timeoutReason = didTimeout ? 'mission exceeded the one-hour safety timeout' : undefined;
    const answer = (agent: ClassicMissionAgent): string => {
      const result = all[agent];
      const screen = result.finalScreen?.trim();
      const screenRecord = screen ? `\n\n${agent} final raw PTY screen:\n${screen.length > MAX_FINAL_SCREEN_CHARS ? `${screen.slice(-MAX_FINAL_SCREEN_CHARS)}\n[screen tail truncated]` : screen}` : '';
      const initial = result.initialScreen?.trim();
      const initialRecord = initial ? `\n\n${agent} first PTY snapshot:\n${initial.length > 1_200 ? `${initial.slice(-1_200)}\n[first screen tail truncated]` : initial}` : '';
      if (timeoutReason && (result.status === 'running' || result.error === undefined)) return `${agent}: ${timeoutReason}${initialRecord}${screenRecord}`;
      if (!result.ok) return `${agent}: ${result.error ?? 'failed; no answer returned'}${initialRecord}${screenRecord}`;
      const content = result.content?.trim();
      if (!content) return `${agent}: completed without an answer${screenRecord}`;
      const safe = redactMissionResultPath(content, result.path);
      return `${agent} candidate:\n${safe.length > MAX_ANSWER_CHARS ? `${safe.slice(0, MAX_ANSWER_CHARS)}\n[answer truncated]` : safe}${initialRecord}${screenRecord}`;
    };
    const grokFailed = !all.grok.ok;
    const body = [
      `Three-hand comparison · same goal · ${grokFailed ? `Grok unavailable; continued with Codex + Claude (${all.grok.error ?? 'failed'})` : 'Codex + Claude + Grok results'}`,
      synthesisPath ? `Synthesis record: ${synthesisPath}` : `Synthesis record unavailable: ${synthesisError ?? 'unknown write failure'}`,
      'The record contains the candidate results and attribution table; fill its adoption and rationale sections with the selected synthesis.',
      '', answer('codex'), '', answer('claude'), '', answer('grok'), '',
      'Compare the available candidates, select or combine the strongest answer, and present the adopted result with a short reason. Do not claim an unavailable or failed candidate succeeded.',
    ].join('\n');
    try {
      deps.enqueue({
        taskId,
        ...(deps.context?.parentSessionId ? { parentSessionId: deps.context.parentSessionId } : {}),
        agentName: grokFailed ? 'Codex + Claude (Grok fallback)' : 'Codex + Claude + Grok',
        label: 'sidetab mission comparison',
        state: all.codex.ok && all.claude.ok ? 'done' : 'error',
        output: JSON.stringify({ status: grokFailed ? 'partial' : 'done', body, artifacts: synthesisPath ? [synthesisPath] : [], id: ids.get('codex') ?? ids.get('claude') ?? taskId, grokFallback: grokFailed ? all.grok.error : undefined }),
        ...(synthesisPath ? { resultPath: synthesisPath } : {}),
        truncated: body.includes('[answer truncated]'),
        durationMs: Math.max(0, finishedAt - startedAt),
        finishedAt,
      });
    } catch { /* notification delivery cannot interrupt the missions */ }
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
    for (const sessionId of sessionIds) if (deps.hasSession(sessionId)) deps.killSession(sessionId);
    deps.registry.clear(missionIds);
  });

  return { result: { trioId: `trio-${ids.get('codex') ?? ids.get('claude') ?? createId()}`, members, ...(grokFallback ? { grokFallback } : {}) }, completion };
}
