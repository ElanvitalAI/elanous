import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveBackendSpawn, claudeBackend, codexBackend } from '../../agent-mission/driver.js';
import { DisplayCoordinator } from '../../display/coordinator.js';
import { createDisplayEventBus } from '../../display/events.js';
import { createTerminalModalRouter } from '../../terminal/terminal-modal-router.js';
import { getSessionCwd } from '../../session/working-dir.js';
import { TerminalSessionRegistry, type TerminalSession } from '../../terminal/session-registry.js';
import { requestRemotePtyControl } from '../../pty-shell/pty-control-ipc.js';
import { runVisibleAgentMission, type VisibleMissionPty, type VisibleMissionResult } from '../../sidetab-core/visible-agent-mission.js';
import type { Key } from '../../tui.js';
import type { SidetabRow } from './list.js';
import { createHerdrSidetabPortal, herdrPaneIdFromSidetabRow, type HerdrSidetabPortal } from './herdr-portal.js';

export type SidetabCharacter = 'shell' | 'elanous' | 'codex' | 'claude';

export interface SidetabAttachmentController {
  attach(row: SidetabRow): boolean;
  select(row: SidetabRow): boolean;
  showMain(): void;
  spawn(character: SidetabCharacter): boolean;
  runMission(agent: 'codex' | 'claude', mission: string): Promise<Awaited<ReturnType<typeof runVisibleAgentMission>>>;
  kill(row: SidetabRow): boolean;
  handleKey(key: Key): boolean;
  hasModal(): boolean;
  hasRemoteView(): boolean;
  refresh(): void;
  close(): void;
}

export interface AgentCliDetection {
  agent: 'codex' | 'claude';
  installed: boolean;
  version: string | null;
  login: 'ready' | 'needed' | 'unknown';
  message: string;
}

export function sidetabMissionFailureLog(agent: 'codex' | 'claude', result: VisibleMissionResult): {
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

export function createSidetabAttachmentController(deps: {
  drawBase(): void;
  termSize(): { cols: number; rows: number };
  setStatus(message: string): void;
  drawRemoteFrame(frame: string): void;
  logEvent?(category: string, event: string, data: Record<string, unknown>): void;
  herdrPortal?: HerdrSidetabPortal;
  /** Owned by OPT; a missing detector keeps the hook inert until its API lands. */
  detectAgentCli?(agent: 'codex' | 'claude'): Promise<AgentCliDetection>;
  /** Test seam for exercising the visible mission path without launching an external CLI. */
  createVisibleMissionPty?(agent: 'codex' | 'claude'): { pty: VisibleMissionPty; cwd: string };
  /** Runner seam keeps the controller path testable with short deterministic mission timeouts. */
  visibleMissionRunner?: typeof runVisibleAgentMission;
}): SidetabAttachmentController {
  const eventBus = createDisplayEventBus();
  const coordinator = new DisplayCoordinator({
    termSize: deps.termSize,
    onRender: () => deps.drawBase(),
    writeOverlay: (ansi) => { try { process.stdout.write(ansi); } catch { /* TUI closed */ } },
  });
  const registry = new TerminalSessionRegistry({ coordinator, eventBus });
  const modalRouter = createTerminalModalRouter();
  let attachedSessionId: string | null = null;
  let detachPrefixPending = false;
  let remotePtyId: string | null = null;
  let remoteTakenOver = false;
  let remoteFrameTimer: ReturnType<typeof setInterval> | null = null;
  let remoteFramePending = false;
  let remoteHasFrame = false;
  const herdrPortal = deps.herdrPortal ?? createHerdrSidetabPortal();
  let herdrPaneId: string | null = null;
  let herdrTakenOver = false;
  let herdrFrameTimer: ReturnType<typeof setInterval> | null = null;
  let herdrFramePending = false;
  const herdrInputQueues = new Map<string, Promise<void>>();

  const enqueueHerdrInput = (paneId: string, send: () => Promise<void>): void => {
    const previous = herdrInputQueues.get(paneId) ?? Promise.resolve();
    let current: Promise<void>;
    current = previous.catch(() => {}).then(send).catch((error: unknown) => {
      if (herdrPaneId === paneId) deps.setStatus(`Herdr 입력 실패 · ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (herdrInputQueues.get(paneId) === current) herdrInputQueues.delete(paneId);
    });
    herdrInputQueues.set(paneId, current);
  };
  let lastSpawnedSession: TerminalSession | null = null;

  const stopRemote = (): void => {
    if (remoteFrameTimer !== null) clearInterval(remoteFrameTimer);
    remoteFrameTimer = null;
    const previous = remotePtyId;
    remotePtyId = null;
    if (previous && remoteTakenOver) void requestRemotePtyControl(previous, 'release', undefined, { timeoutMs: 500 }).catch(() => {});
    remoteTakenOver = false;
    remoteHasFrame = false;
    deps.drawRemoteFrame('');
  };

  const stopHerdr = (): void => {
    if (herdrFrameTimer !== null) clearInterval(herdrFrameTimer);
    herdrFrameTimer = null;
    herdrPaneId = null;
    herdrTakenOver = false;
    deps.drawRemoteFrame('');
  };

  const startHerdr = (row: SidetabRow): boolean => {
    const paneId = herdrPaneIdFromSidetabRow(row);
    if (!paneId || !herdrPortal.enabled()) {
      deps.setStatus('Herdr 연결은 HERDR_ENV=1인 관리 세션에서만 사용할 수 있습니다');
      return false;
    }
    stopRemote();
    stopHerdr();
    herdrPaneId = paneId;
    const refresh = async (): Promise<void> => {
      if (herdrFramePending || herdrPaneId !== paneId) return;
      herdrFramePending = true;
      try {
        const frame = await herdrPortal.readPane(paneId);
        if (herdrPaneId === paneId) deps.drawRemoteFrame(frame);
      } catch (error) {
        if (herdrPaneId === paneId) deps.setStatus(`Herdr pane 읽기 실패 · ${error instanceof Error ? error.message : String(error)}`);
      } finally { herdrFramePending = false; }
    };
    void refresh();
    herdrFrameTimer = setInterval(() => { void refresh(); }, 250);
    deps.setStatus('Herdr pane 관측 · t takeover · Esc / Ctrl+\\ 복귀 · Ctrl+Q 전체 종료 (Ctrl+[는 Esc로 읽힐 수 있음)');
    return true;
  };

  const startRemote = (row: SidetabRow): boolean => {
    if (!row.ptyId) return false;
    stopHerdr();
    stopRemote();
    remotePtyId = row.ptyId;
    const id = row.ptyId;
    const refresh = async (): Promise<void> => {
      if (remoteFramePending || remotePtyId !== id) return;
      remoteFramePending = true;
      try {
        const result = await requestRemotePtyControl(id, 'snapshot', { ansi: true }, { timeoutMs: 450 });
        if (remotePtyId === id && result.status === 'success') {
          if (!result.screen?.trim()) {
            stopRemote();
            deps.setStatus('PTY 화면이 비어 있어 채팅 화면을 유지합니다');
            return;
          }
          remoteHasFrame = true;
          deps.drawRemoteFrame(result.screen ?? '');
        }
        else if (remotePtyId === id && result.status !== 'success') {
          if (!remoteHasFrame) stopRemote();
          deps.setStatus(`PTY 화면 읽기 실패 · ${result.status}`);
        }
      } catch (error) {
        if (remotePtyId === id) {
          if (!remoteHasFrame) stopRemote();
          deps.setStatus(`PTY 화면 읽기 오류 · ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        remoteFramePending = false;
      }
    };
    void refresh();
    remoteFrameTimer = setInterval(() => { void refresh(); }, 75);
    deps.setStatus('원격 PTY 화면 · t takeover · Ctrl+\\ 후 ↑/↓ 전환');
    return true;
  };

  const sessionForRow = (row: SidetabRow): TerminalSession | undefined =>
    row.sessionId ? registry.get(row.sessionId) : undefined;

  const setModal = (session: TerminalSession): boolean => {
    if (!session.modal) return false;
    attachedSessionId = session.id;
    modalRouter.set(session.modal, {
      onClose: () => {
        registry.detach(session.id);
        attachedSessionId = null;
        deps.setStatus('PTY 분리됨 · 사이드탭에서 다시 선택 가능');
        deps.drawBase();
      },
    });
    deps.setStatus('PTY 입력 중 · Ctrl+\\ d 분리 · Ctrl+Q는 PTY에 전달');
    coordinator.requestRenderNow({ force: true });
    return true;
  };

  const spawn = (character: SidetabCharacter): boolean => {
    const { cols, rows } = deps.termSize();
    if (cols < 40 || rows < 8) {
      deps.setStatus('PTY 모달은 최소 40칸 × 8줄이 필요합니다');
      return false;
    }
    const id = `next-sidetab-${randomUUID()}`;
    const cwd = getSessionCwd();
    const title = character === 'claude' ? 'claude-code' : character;
    const common = {
      id,
      title,
      cwd,
      useRegistry: true,
      registryKind: character === 'claude' ? 'claude' : character,
      registryNickname: `${character} · Next TUI`,
      registryOrigin: { originRoot: 'elanous-internal', controller: 'next-tui-sidetab' },
      registryPurpose: `next-tui-sidetab:${id}`,
      registrySeat: process.env.COORD_ID?.trim() || 'unknown',
      kind: character === 'shell' ? 'shell' as const : 'coding-agent' as const,
      ...(character === 'claude' ? { agentBrand: 'claude-code' as const } : character === 'codex' ? { agentBrand: 'codex' as const } : {}),
    };
    try {
      let command: string | undefined;
      let env: Record<string, string> | undefined;
      let unsetEnv: string[] | undefined;
      if (character === 'elanous') command = 'elanous --tui next';
      if (character === 'codex' || character === 'claude') {
        const backend = character === 'codex' ? codexBackend : claudeBackend;
        const spec = resolveBackendSpawn(backend, process.env);
        command = [spec.cmd, ...spec.args].map(shellQuote).join(' ');
        env = spec.env;
        // buildPtyEnv applies the driver's explicit auth scrub list after
        // merging captured login-shell variables; keep PATH/HOME/TERM intact.
        unsetEnv = [...spec.unsetEnv];
      }
      const session = registry.spawn({
        ...common,
        ...(command ? { command } : {}),
        ...(env ? { env } : {}),
        ...(unsetEnv ? { unsetEnv } : {}),
        onExit: () => {
          if (attachedSessionId === id) {
            modalRouter.set(null);
            attachedSessionId = null;
            deps.setStatus(`${title} 종료됨 · 사이드탭으로 돌아옴`);
            deps.drawBase();
          }
        },
      }, { termCols: cols, termRows: rows });
      lastSpawnedSession = session;
      if (character === 'codex' || character === 'claude') {
        deps.setStatus(`${character} 실행 · agent-mission 구독 경로 scrub 적용(${unsetEnv?.length ?? 0}개 env 제거)`);
      }
      return setModal(session);
    } catch (error) {
      deps.setStatus(`${character} 실행 실패: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  return {
    attach(row) {
      stopRemote();
      if (row.kind === 'herdr') return startHerdr(row);
      if (row.currentProcess) {
        showMain();
        return true;
      }
      const session = sessionForRow(row);
      if (!session) {
        deps.setStatus('이 항목은 Next TUI에서 만든 세션이 아닙니다 · shell/agent 세션만 attach할 수 있습니다');
        return false;
      }
      if (session.state === 'exited') {
        deps.setStatus('종료된 PTY는 attach할 수 없습니다');
        return false;
      }
      const { cols, rows } = deps.termSize();
      const attached = registry.attach(session.id, { termCols: cols, termRows: rows });
      return attached ? setModal(attached) : false;
    },
    select(row) {
      if (row.kind === 'herdr') return startHerdr(row);
      if (row.ptyId && !row.currentProcess && !sessionForRow(row)) return startRemote(row);
      if (row.currentProcess) {
        showMain();
        return true;
      }
      return this.attach(row);
    },
    showMain,
    spawn,
    async runMission(agent, mission) {
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
      lastSpawnedSession = null;
      const injectedMissionPty = deps.createVisibleMissionPty?.(agent);
      let modal: VisibleMissionPty;
      let cwd: string;
      if (injectedMissionPty) {
        modal = injectedMissionPty.pty;
        cwd = injectedMissionPty.cwd;
      } else {
        const spawned = spawn(agent);
        const session = lastSpawnedSession as TerminalSession | null;
        if (!spawned || !session?.modal) {
          return { ok: false, path: '', promptReady: false, missionVisible: false, promptReturned: false, completionMarker: false, error: `${agent} side-tab PTY could not start` };
        }
        modal = session.modal;
        cwd = session.cwd;
      }
      const outputPath = join(cwd, '.elanous', 'mission-results', `sidetab-${Date.now()}.md`);
      const backend = agent === 'codex' ? codexBackend : claudeBackend;
      const result = await (deps.visibleMissionRunner ?? runVisibleAgentMission)({
        pty: modal,
        agent,
        mission,
        outputPath,
        onStartupScreen: (screen) => deps.logEvent?.('agent-mission.sidetab', 'startup-screen', { agent, screen }),
        handleTrust: (screen, write) => backend.handleTrust?.(screen, write) ?? false,
      });
      const failureLog = sidetabMissionFailureLog(agent, result);
      if (failureLog) deps.logEvent?.('agent-mission.sidetab', failureLog.event, failureLog.data);
      showMain();
      deps.setStatus(result.ok ? `미션 결과 확인 · ${result.path}` : `미션 확인 실패 · ${result.promptReady ? agent : result.startupScreen ?? agent} · ${result.error}`);
      return result;
    },
    kill(row) {
      if (row.currentProcess) {
        deps.setStatus('현재 TUI 세션은 사이드탭에서 종료할 수 없습니다');
        return false;
      }
      const session = sessionForRow(row);
      if (!session) {
        if (row.ptyId) {
          void requestRemotePtyControl(row.ptyId, 'terminate', undefined, { timeoutMs: 1_000 }).then((result) => {
            deps.setStatus(result.status === 'success' ? 'PTY 종료 요청 완료' : `PTY 종료 거부 · ${result.status}`);
          }).catch((error: unknown) => deps.setStatus(`PTY 종료 오류 · ${error instanceof Error ? error.message : String(error)}`));
          return true;
        }
        deps.setStatus('이 항목은 이 Next TUI에서 종료할 수 없습니다');
        return false;
      }
      if (attachedSessionId === session.id) {
        modalRouter.set(null);
        attachedSessionId = null;
      }
      registry.kill(session.id);
      deps.setStatus(`${session.title} 종료 요청 완료`);
      return true;
    },
    handleKey(key) {
      if (herdrPaneId) {
        if (key.name.toLowerCase() === 'escape') {
          stopHerdr();
          deps.setStatus('Herdr pane에서 복귀');
          return true;
        }
        if (key.ctrl && key.name.toLowerCase() === 'q') {
          stopHerdr();
          deps.setStatus('Herdr pane에서 복귀');
          return false;
        }
        if (key.ctrl && (key.name === '\\' || key.raw === '\x1c')) {
          stopHerdr();
          deps.setStatus('Herdr pane에서 복귀');
          return false;
        }
        if (key.name.toLowerCase() === 't' && !herdrTakenOver) {
          herdrTakenOver = true;
          deps.setStatus('Herdr pane takeover · Esc로 복귀');
          return true;
        }
        const raw = key.raw;
        if (herdrTakenOver && raw) {
          const paneId = herdrPaneId;
          if (raw.includes('\x00')) {
            deps.setStatus('NUL 입력은 Herdr pane에 보낼 수 없습니다');
            return true;
          }
          const send = (raw.length === 1 && (raw.charCodeAt(0) < 32 || raw.charCodeAt(0) === 0x7f)) || raw.startsWith('\x1b')
            ? () => herdrPortal.sendKey(paneId, raw)
            : () => herdrPortal.sendText(paneId, raw);
          enqueueHerdrInput(paneId, send);
          return true;
        }
        return true;
      }
      if (remotePtyId) {
        // Keep global TUI controls reachable while a remote snapshot is displayed.
        if (key.ctrl && key.name.toLowerCase() === 'q') return false;
        if (key.name.toLowerCase() === 't' && !remoteTakenOver) {
          const id = remotePtyId;
          void requestRemotePtyControl(id, 'takeover', undefined, { timeoutMs: 1_000 }).then((result) => {
            if (remotePtyId !== id) return;
            remoteTakenOver = result.status === 'success';
            deps.setStatus(remoteTakenOver ? '사람 입력 takeover 완료 · 전환 때 release' : `takeover 거부 · ${result.reason ?? result.status}`);
          }).catch((error: unknown) => {
            if (remotePtyId === id) deps.setStatus(`takeover 오류 · ${error instanceof Error ? error.message : String(error)}`);
          });
          return true;
        }
        if (remoteTakenOver && key.raw) {
          const id = remotePtyId;
          void requestRemotePtyControl(id, 'input-key', { chars: key.raw }, { timeoutMs: 500 }).then((result) => {
            if (remotePtyId === id && result.status !== 'success') deps.setStatus(`PTY 입력 실패 · ${result.status}`);
          }).catch((error: unknown) => {
            if (remotePtyId === id) deps.setStatus(`PTY 입력 오류 · ${error instanceof Error ? error.message : String(error)}`);
          });
          return true;
        }
        return true;
      }
      if (!modalRouter.current()) return false;
      if (detachPrefixPending) {
        detachPrefixPending = false;
        if (key.name.toLowerCase() === 'd') {
          modalRouter.close();
          coordinator.requestRenderNow({ force: true });
          return true;
        }
        deps.setStatus('분리 취소 · Ctrl+\\ d 를 눌러 분리');
        coordinator.requestRenderNow({ force: true });
        return true;
      }
      if (key.ctrl && key.name === '\\') {
        detachPrefixPending = true;
        deps.setStatus('분리 키 대기 · d');
        return true;
      }
      const routed = modalRouter.handleKey({
        name: key.name,
        sequence: key.raw,
        ctrl: key.ctrl,
        shift: key.shift,
        alt: key.alt,
      });
      if (routed !== 'passthrough') coordinator.requestRenderNow({ force: true });
      return routed !== 'passthrough';
    },
    hasModal: () => modalRouter.current() !== null,
    hasRemoteView: () => remotePtyId !== null || herdrPaneId !== null,
    refresh: () => coordinator.requestRenderNow({ force: true }),
    close() {
      stopRemote();
      stopHerdr();
      modalRouter.close();
      for (const session of registry.list()) registry.kill(session.id);
    },
  };

  function showMain(): void {
    stopRemote();
    stopHerdr();
    if (attachedSessionId === null) return;
    modalRouter.close();
    coordinator.requestRenderNow({ force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
