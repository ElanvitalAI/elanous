import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { claudeBackend, codexBackend, grokBackend } from '../../../agent-mission/driver.js';
import { runVisibleAgentMission, type VisibleAgentCli, type VisibleMissionPty, type VisibleMissionResult } from '../../../sidetab-core/visible-agent-mission.js';
import { runVisibleAgentMissionPair } from '../../../sidetab-core/visible-agent-mission-pair.js';
import type { TerminalSession, TerminalSessionRegistry } from '../../../terminal/session-registry.js';

export interface AgentCliDetection {
  agent: VisibleAgentCli;
  installed: boolean;
  version: string | null;
  login: 'ready' | 'needed' | 'unknown';
  message: string;
}

export function sidetabMissionFailureLog(agent: VisibleAgentCli, result: VisibleMissionResult): {
  event: 'startup-screen-failed' | 'mission-failed';
  data: Record<string, unknown>;
} | undefined {
  if (result.ok) return undefined;
  const startupBlocked = !result.promptReady;
  return {
    event: startupBlocked ? 'startup-screen-failed' : 'mission-failed',
    data: {
      agent,
      screen: startupBlocked ? result.startupScreen ?? 'unclassified' : 'none',
      error: result.startupScreen && startupBlocked ? 'known-startup-screen-blocked' : startupBlocked ? 'startup-unclassified' : 'mission-or-result-failed',
    },
  };
}

/** Adapt a live registry session so mission results can report its real process exit code. */
export function visibleMissionPtyForTerminalSession(session: TerminalSession): VisibleMissionPty {
  const modal = session.modal;
  if (!modal) throw new Error('Cannot run a visible mission without an attached terminal modal');
  return {
    snapshot: () => modal.snapshot(),
    write: (bytes) => modal.write(bytes),
    isAlive: () => modal.isAlive(),
    exitCode: () => session.exitCode,
  };
}

export function createSidetabMissionBranch(deps: {
  registry: TerminalSessionRegistry;
  setStatus(message: string): void;
  logEvent?(category: string, event: string, data: Record<string, unknown>): void;
  detectAgentCli?(agent: VisibleAgentCli): Promise<AgentCliDetection>;
  createVisibleMissionPty?(agent: VisibleAgentCli): { pty: VisibleMissionPty; cwd: string };
  visibleMissionRunner?: typeof runVisibleAgentMission;
  spawn(agent: VisibleAgentCli): boolean;
  resetLastSpawnedSession(): void;
  getLastSpawnedSession(): TerminalSession | null;
  showMain(): void;
}) {
  const registry = deps.registry;
  const missionExitObservations = new Map<string, {
    agent: VisibleAgentCli;
    category: 'agent-mission.sidetab' | 'agent-mission.sidetab-pair';
    result?: VisibleMissionResult;
    exitCode?: number | null;
    exitLogged?: boolean;
  }>();
  let controllerClosed = false;
  let unsubscribeMissionExits = () => {};
  const maybeUnsubscribeMissionExits = () => {
    if (controllerClosed && missionExitObservations.size === 0) unsubscribeMissionExits();
  };
  const trackMissionSession = (
    session: TerminalSession,
    agent: VisibleAgentCli,
    category: 'agent-mission.sidetab' | 'agent-mission.sidetab-pair',
  ) => {
    const observation: { agent: VisibleAgentCli; category: 'agent-mission.sidetab' | 'agent-mission.sidetab-pair'; result?: VisibleMissionResult; exitCode?: number | null; exitLogged?: boolean } = { agent, category };
    if (session.state === 'exited') {
      observation.exitCode = session.exitCode;
      observation.exitLogged = true;
      deps.logEvent?.(category, 'pty-exit', { agent, exitCode: session.exitCode });
    }
    missionExitObservations.set(session.id, observation);
    return observation;
  };
  const trackMissionResult = (session: TerminalSession, result: VisibleMissionResult) => {
    const observation = missionExitObservations.get(session.id);
    if (!observation) {
      if (session.state === 'exited') result.exitCode = session.exitCode;
      return;
    }
    observation.result = result;
    if (observation.exitCode !== undefined) {
      result.exitCode = observation.exitCode;
      missionExitObservations.delete(session.id);
    } else if (session.state === 'exited') {
      result.exitCode = session.exitCode;
      missionExitObservations.delete(session.id);
    }
    maybeUnsubscribeMissionExits();
  };
  unsubscribeMissionExits = registry.subscribe((event) => {
    if (event.type !== 'exited') return;
    const observation = missionExitObservations.get(event.session.id);
    if (!observation) return;
    observation.exitCode = event.session.exitCode;
    if (observation.result) {
      observation.result.exitCode = event.session.exitCode;
    }
    if (!observation.exitLogged) {
      observation.exitLogged = true;
      deps.logEvent?.(observation.category, 'pty-exit', {
        agent: observation.agent,
        exitCode: event.session.exitCode,
      });
    }
    // Exit observations must not pin the registry subscriber when spawning a
    // mission failed before a result could be returned. A late runner result
    // can still read the authoritative exit status from the exited session.
    missionExitObservations.delete(event.session.id);
    maybeUnsubscribeMissionExits();
  });
  return {
    async runMission(agent: VisibleAgentCli, mission: string) {
      if (deps.detectAgentCli) {
        let detection: AgentCliDetection;
        try { detection = await deps.detectAgentCli(agent); }
        catch (error) {
          const message = `${agent} CLI 확인에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`;
          deps.setStatus(message);
          return { ok: false, path: '', promptReady: false, missionVisible: false, promptReturned: false, completionMarker: false, error: message };
        }
        if (!detection.installed) {
          const message = `${detection.message} · 설치 확인 후 미션을 다시 요청하세요`;
          deps.setStatus(message);
          return { ok: false, path: '', promptReady: false, missionVisible: false, promptReturned: false, completionMarker: false, error: message };
        }
      }
      deps.resetLastSpawnedSession();
      const injectedMissionPty = deps.createVisibleMissionPty?.(agent);
      let modal: VisibleMissionPty;
      let cwd: string;
      let missionSession: TerminalSession | undefined;
      if (injectedMissionPty) {
        modal = injectedMissionPty.pty;
        cwd = injectedMissionPty.cwd;
      } else {
        const spawned = deps.spawn(agent);
        const session = deps.getLastSpawnedSession();
        if (!spawned || !session?.modal) {
          return { ok: false, path: '', promptReady: false, missionVisible: false, promptReturned: false, completionMarker: false, error: `${agent} side-tab PTY could not start` };
        }
        missionSession = session;
        trackMissionSession(session, agent, 'agent-mission.sidetab');
        modal = visibleMissionPtyForTerminalSession(session);
        cwd = session.cwd;
      }
      const outputPath = join(cwd, '.elanous', 'mission-results', `sidetab-${Date.now()}-${randomUUID()}.md`);
      const backend = visibleAgentBackend(agent);
      const result = await (deps.visibleMissionRunner ?? runVisibleAgentMission)({
        pty: modal,
        agent,
        mission,
        outputPath,
        onStartupScreen: (screen) => deps.logEvent?.('agent-mission.sidetab', 'startup-screen', { agent, screen }),
        handleTrust: (screen, write) => backend.handleTrust?.(screen, write) ?? false,
      });
      if (missionSession) trackMissionResult(missionSession, result);
      const failureLog = sidetabMissionFailureLog(agent, result);
      if (failureLog) deps.logEvent?.('agent-mission.sidetab', failureLog.event, failureLog.data);
      deps.showMain();
      deps.setStatus(result.ok ? `미션 결과 확인 · ${result.path}` : `미션 확인 실패 · ${result.promptReady ? agent : result.startupScreen ?? agent} · ${result.error}`);
      return result;
    },
    async runMissionPair(agent: 'codex' | 'claude', mission: string, parallelMission: string) {
      const missionId = `duo-${randomUUID()}`;
      const startedAt = Date.now();
      const members = [agent, agent === 'codex' ? 'claude' : 'codex'] as const;
      if (deps.detectAgentCli) {
        const detections = await Promise.all(members.map(async (member) => {
          try { return await deps.detectAgentCli!(member); }
          catch (error) {
            return { agent: member, installed: false, version: null, login: 'unknown' as const,
              message: `${member} CLI 확인에 실패했습니다: ${error instanceof Error ? error.message : String(error)}` };
          }
        }));
        const unavailable = detections.find(({ installed }) => !installed);
        if (unavailable) {
          const message = `${unavailable.message} · pair 미션은 두 CLI 모두 준비돼야 시작합니다`;
          deps.setStatus(message);
          return { ok: false, error: message, codex: null, claude: null };
        }
      }

      const sessions = new Map<'codex' | 'claude', TerminalSession>();
      const workspaces = new Map<'codex' | 'claude', string>();
      const ptySessions = new Map<VisibleMissionPty, TerminalSession>();
      const pair = await runVisibleAgentMissionPair({
        spawn: (member) => {
          deps.resetLastSpawnedSession();
          const injected = deps.createVisibleMissionPty?.(member);
          if (injected) {
            workspaces.set(member, injected.cwd);
            return injected.pty;
          }
          const didSpawn = deps.spawn(member);
          const session = deps.getLastSpawnedSession();
          if (!didSpawn || !session) return null;
          sessions.set(member, session);
          trackMissionSession(session, member, 'agent-mission.sidetab-pair');
          workspaces.set(member, session.cwd);
          const pty: VisibleMissionPty = {
            snapshot: () => session.preview.renderForLLM(),
            write: (bytes) => session.preview.write(bytes),
            isAlive: () => session.preview.isAlive,
            exitCode: () => session.exitCode,
          };
          ptySessions.set(pty, session);
          return pty;
        },
        dispose: (preview) => {
          const session = ptySessions.get(preview);
          if (session) registry.kill(session.id);
        },
        run: async (member, prompt, pty) => {
          const outputPath = join(workspaces.get(member)!, '.elanous', 'mission-results', `sidetab-pair-${randomUUID()}-${member}.md`);
          const backend = member === 'codex' ? codexBackend : claudeBackend;
          const result = await (deps.visibleMissionRunner ?? runVisibleAgentMission)({
            pty, agent: member, mission: prompt, outputPath,
            onStartupScreen: (screen) => deps.logEvent?.('agent-mission.sidetab-pair', 'startup-screen', { agent: member, screen }),
            handleTrust: (screen, write) => backend.handleTrust?.(screen, write) ?? false,
          });
          const session = sessions.get(member);
          if (session) trackMissionResult(session, result);
          const failureLog = sidetabMissionFailureLog(member, result);
          if (failureLog) deps.logEvent?.('agent-mission.sidetab-pair', failureLog.event, failureLog.data);
          return result;
        },
      }, agent, mission, parallelMission);
      if (pair.error) {
        deps.showMain();
        deps.setStatus(pair.error);
        return pair;
      }
      const codexWorkspace = workspaces.get('codex');
      const claudeWorkspace = workspaces.get('claude');
      if (!codexWorkspace || !claudeWorkspace || codexWorkspace !== claudeWorkspace) {
        deps.showMain();
        const error = '두 사이드탭이 같은 작업 디렉터리를 쓰지 않아 pair 합성을 안전하게 저장할 수 없습니다';
        deps.setStatus(error);
        return { ...pair, ok: false, error };
      }
      const missionByAgent = new Map([ [agent, mission], [agent === 'codex' ? 'claude' : 'codex', parallelMission] ] as const);
      const completion = await (await import('../../../tui-client/next-dashboard-runtime.js')).completeNextTuiMissionPair({
        taskId: missionId,
        codex: {
          missionId: `${missionId}-codex`, startedAt,
          mission: missionByAgent.get('codex')!, workspaceDir: codexWorkspace, result: pair.codex!,
        },
        claude: {
          missionId: `${missionId}-claude`, startedAt,
          mission: missionByAgent.get('claude')!, workspaceDir: claudeWorkspace, result: pair.claude!,
        },
      });
      const notification = completion.notification;
      const finalFile = notification?.resultPath;
      deps.logEvent?.('agent-mission.sidetab-pair', 'synthesis-result', {
        missionId, codexOk: pair.codex?.ok ?? false, claudeOk: pair.claude?.ok ?? false,
        synthesisOk: Boolean(finalFile), status: completion.status,
      });
      deps.showMain();
      deps.setStatus(finalFile
        ? `그래프 두 갈래·비교 합성 완료 · ${finalFile}`
        : '그래프 두 갈래 완료 · 기존 pair 합성 파일 저장 실패');
      return {
        ...pair,
        ok: pair.ok && completion.status === 'done' && Boolean(finalFile),
        pair: 'codex+claude',
        graph: [
          { id: 'plan', state: 'complete', task: `${mission} ⊕ ${parallelMission}` },
          { id: 'codex', state: pair.codex?.ok ? 'complete' : 'failed', task: missionByAgent.get('codex'), resultFile: pair.codex?.path },
          { id: 'claude', state: pair.claude?.ok ? 'complete' : 'failed', task: missionByAgent.get('claude'), resultFile: pair.claude?.path },
          { id: 'synthesis', state: finalFile ? 'complete' : 'failed', resultFile: finalFile },
        ],
        finalFile,
        summary: notification?.output,
      };
    },
    close() {
      if (controllerClosed) return;
      controllerClosed = true;
      maybeUnsubscribeMissionExits();
    },
  };
}

function visibleAgentBackend(agent: VisibleAgentCli) {
  if (agent === 'codex') return codexBackend;
  if (agent === 'claude') return claudeBackend;
  return grokBackend;
}
