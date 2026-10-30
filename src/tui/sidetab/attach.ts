import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveBackendSpawn, claudeBackend, codexBackend } from '../../agent-mission/driver.js';
import { DisplayCoordinator } from '../../display/coordinator.js';
import { createDisplayEventBus } from '../../display/events.js';
import { createTerminalModalRouter } from '../../terminal/terminal-modal-router.js';
import { getSessionCwd } from '../../session/working-dir.js';
import { TerminalSessionRegistry, type TerminalSession } from '../../terminal/session-registry.js';
import { requestRemotePtyControl } from '../../pty-shell/pty-control-ipc.js';
import { runVisibleAgentMission } from '../../sidetab-core/visible-agent-mission.js';
import type { Key } from '../../tui.js';
import type { SidetabRow } from './list.js';

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

export function createSidetabAttachmentController(deps: {
  drawBase(): void;
  termSize(): { cols: number; rows: number };
  setStatus(message: string): void;
  drawRemoteFrame(frame: string): void;
  /** Owned by OPT; a missing detector keeps the hook inert until its API lands. */
  detectAgentCli?(agent: 'codex' | 'claude'): Promise<AgentCliDetection>;
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

  const startRemote = (row: SidetabRow): boolean => {
    if (!row.ptyId) return false;
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
          return { ok: false, path: '', promptReady: false, missionVisible: false, completionMarker: false, error: message };
        }
        if (!detection.installed) {
          const message = `${detection.message} · 설치 확인 후 미션을 다시 요청하세요`;
          deps.setStatus(message);
          return { ok: false, path: '', promptReady: false, missionVisible: false, completionMarker: false, error: message };
        }
      }
      lastSpawnedSession = null;
      if (!spawn(agent) || !lastSpawnedSession?.modal) {
        return { ok: false, path: '', promptReady: false, missionVisible: false, completionMarker: false, error: `${agent} side-tab PTY could not start` };
      }
      const session = lastSpawnedSession;
      const outputPath = join(session.cwd, '.elanous', 'mission-results', `sidetab-${Date.now()}.md`);
      const backend = agent === 'codex' ? codexBackend : claudeBackend;
      const result = await runVisibleAgentMission({
        pty: session.modal,
        mission,
        outputPath,
        handleTrust: (screen, write) => backend.handleTrust?.(screen, write) ?? false,
      });
      showMain();
      deps.setStatus(result.ok ? `미션 결과 확인 · ${result.path}` : `미션 확인 실패 · ${result.error}`);
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
    hasRemoteView: () => remotePtyId !== null,
    refresh: () => coordinator.requestRenderNow({ force: true }),
    close() {
      stopRemote();
      modalRouter.close();
      for (const session of registry.list()) registry.kill(session.id);
    },
  };

  function showMain(): void {
    stopRemote();
    if (attachedSessionId === null) return;
    modalRouter.close();
    coordinator.requestRenderNow({ force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
