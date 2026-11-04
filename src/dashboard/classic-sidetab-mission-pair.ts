import { randomUUID } from 'node:crypto';
import type { ClassicSidetabMissionPairResult, ClassicSidetabMissionPairSessionRegistry, ClassicSidetabMissionResult, ClassicSidetabMissionDispatchContext } from './classic-sidetab-mission.js';
import { enqueueClassicSidetabMissionPairCompletion, type ClassicMissionNotificationEnqueue, type ClassicSidetabMissionPairCompletionResult } from './classic-sidetab-mission-job.js';
import { readClassicSidetabPairBaseSha, sidetabCandidateProtocolPrompt } from './classic-sidetab-mission-reconcile.js';

interface ClassicSidetabPairSession {
  id: string;
  cwd: string;
}

export interface StartClassicSidetabMissionPairDeps<Session extends ClassicSidetabPairSession> {
  agent: 'codex' | 'claude';
  mission: string;
  parallelMission: string;
  context?: ClassicSidetabMissionDispatchContext;
  spawnVisible: (agent: 'codex' | 'claude', missionId: string, attemptId: string) => Session | null;
  runVisible: (agent: 'codex' | 'claude', prompt: string, session: Session | null, missionId?: string) => Promise<ClassicSidetabMissionResult>;
  registry: ClassicSidetabMissionPairSessionRegistry;
  hasSession: (sessionId: string) => boolean;
  killSession: (sessionId: string) => void;
  enqueue: ClassicMissionNotificationEnqueue;
  now?: () => number;
  createId?: () => string;
  timeoutMs?: number;
  /** Test seam; production captures HEAD before either child receives its prompt. */
  baseSha?: string;
  onComplete?: (result: ClassicSidetabMissionPairCompletionResult) => void;
}

/** Production seam: start both visible PTYs, bind IDs/cancellation, and deliver one parent-linked completion receipt. */
export function startClassicSidetabMissionPair<Session extends ClassicSidetabPairSession>(
  deps: StartClassicSidetabMissionPairDeps<Session>,
): { result: ClassicSidetabMissionPairResult; completion: Promise<ClassicSidetabMissionPairCompletionResult> } {
  // Keep Codex as the last-opened PTY regardless of which mission prompt is
  // primary. The dashboard closes each popup after spawn, detaching its modal
  // while preserving the session in the sidetab registry. On the tested
  // Codex-first demo path, opening Codex last avoids a missed follow-up
  // completion marker; this is a sequencing workaround, not a fix for
  // background PTY marker detection (tracked by SIDETAB-MARKER-BACKGROUND-DETECT).
  const createId = deps.createId ?? randomUUID;
  const codexMissionId = createId();
  const claudeMissionId = createId();
  const codexAttemptId = createId();
  const claudeAttemptId = createId();
  const claudeSession = deps.spawnVisible('claude', claudeMissionId, claudeAttemptId);
  const codexSession = deps.spawnVisible('codex', codexMissionId, codexAttemptId);
  const workspaceDir = codexSession?.cwd ?? claudeSession?.cwd ?? '';
  const baseSha = deps.baseSha ?? readClassicSidetabPairBaseSha(workspaceDir);
  const hasPinnedBaseSha = typeof baseSha === 'string' && /^[0-9a-f]{40}$/i.test(baseSha);
  const missionIds = [codexSession ? codexMissionId : undefined, claudeSession ? claudeMissionId : undefined].filter((id): id is string => Boolean(id));
  const activeCodexMissionId = codexSession ? codexMissionId : undefined;
  const activeClaudeMissionId = claudeSession ? claudeMissionId : undefined;
  const sessionIds = [codexSession?.id, claudeSession?.id].filter((id): id is string => Boolean(id));
  deps.registry.register(missionIds, sessionIds);

  const codexPrompt = deps.agent === 'codex' ? deps.mission : deps.parallelMission;
  const claudePrompt = deps.agent === 'claude' ? deps.mission : deps.parallelMission;
  const startedAt = (deps.now ?? Date.now)();
  if (!hasPinnedBaseSha) {
    for (const sessionId of sessionIds) if (deps.hasSession(sessionId)) deps.killSession(sessionId);
  }
  const baseCaptureFailure = 'Could not capture a valid Git base SHA; candidate missions were not started';
  const codexCompletion = hasPinnedBaseSha
    ? deps.runVisible('codex', sidetabCandidateProtocolPrompt(codexPrompt, baseSha), codexSession, activeCodexMissionId)
    : Promise.resolve<ClassicSidetabMissionResult>({ ok: false, status: 'failed', error: baseCaptureFailure });
  const claudeCompletion = hasPinnedBaseSha
    ? deps.runVisible('claude', sidetabCandidateProtocolPrompt(claudePrompt, baseSha), claudeSession, activeClaudeMissionId)
    : Promise.resolve<ClassicSidetabMissionResult>({ ok: false, status: 'failed', error: baseCaptureFailure });
  // callId is the parent tool invocation identity; falling back to a mission id
  // preserves queue uniqueness for embedders that do not expose a call id.
  const taskId = deps.context?.callId || activeCodexMissionId || activeClaudeMissionId || createId();
  const completion = missionIds.length
    ? enqueueClassicSidetabMissionPairCompletion({
      codex: { missionId: activeCodexMissionId, taskId, parentSessionId: deps.context?.parentSessionId, startedAt, mission: codexPrompt, workspaceDir, baseSha, completion: codexCompletion },
      claude: { missionId: activeClaudeMissionId, taskId, parentSessionId: deps.context?.parentSessionId, startedAt, mission: claudePrompt, workspaceDir, baseSha, completion: claudeCompletion },
    }, deps.enqueue, deps.now, {
      timeoutMs: deps.timeoutMs,
      onTimeout: () => { for (const sessionId of sessionIds) if (deps.hasSession(sessionId)) deps.killSession(sessionId); },
      ...(deps.onComplete ? { onComplete: deps.onComplete } : {}),
    }).finally(() => deps.registry.clear(missionIds))
    : Promise.resolve<ClassicSidetabMissionPairCompletionResult>({
      codex: { ok: false, status: 'failed' as const, error: 'Codex sidetab PTY could not start' },
      claude: { ok: false, status: 'failed' as const, error: 'Claude sidetab PTY could not start' },
      status: 'error' as const, finishedAt: (deps.now ?? Date.now)(),
    });

  return {
    result: {
      pairId: `${activeCodexMissionId ?? 'codex-unavailable'}+${activeClaudeMissionId ?? 'claude-unavailable'}`,
      codex: codexSession && hasPinnedBaseSha ? { ok: true, status: 'running', path: '', interactionId: activeCodexMissionId } : { ok: false, status: 'failed', error: !hasPinnedBaseSha ? baseCaptureFailure : 'Codex sidetab PTY could not start' },
      claude: claudeSession && hasPinnedBaseSha ? { ok: true, status: 'running', path: '', interactionId: activeClaudeMissionId } : { ok: false, status: 'failed', error: !hasPinnedBaseSha ? baseCaptureFailure : 'Claude sidetab PTY could not start' },
    },
    completion,
  };
}
