import { randomUUID } from 'node:crypto';
import { resolveBackendSpawn, claudeBackend, codexBackend, grokBackend } from '../../agent-mission/driver.js';
import { DisplayCoordinator } from '../../display/coordinator.js';
import { createDisplayEventBus } from '../../display/events.js';
import { createTerminalModalRouter } from '../../terminal/terminal-modal-router.js';
import { getSessionCwd } from '../../session/working-dir.js';
import { TerminalSessionRegistry, type TerminalSession } from '../../terminal/session-registry.js';
import { requestRemotePtyControl } from '../../pty-shell/pty-control-ipc.js';
import { listPtyManifestRows } from '../../pty-shell/pty-manifest.js';
import { debug } from '../../debug/log.js';
import { redactSecretText } from '../../debug/secret-redaction.js';
import { runVisibleAgentMission, type VisibleAgentCli, type VisibleMissionPty } from '../../sidetab-core/visible-agent-mission.js';
import type { Key } from '../../tui.js';
import type { SidetabRow } from './list.js';
import { createHerdrSidetabPortal, herdrPaneIdFromSidetabRow, type HerdrSidetabPortal } from './herdr-portal.js';
import { createSidetabMissionBranch, type AgentCliDetection } from '../branches/sidetab/mission.js';
import { readSidetabAgent, sendSidetabAgent, sidetabAgentLaunch, type SidetabAgent } from '../../tui-client/sidetab-agent-pty.js';
import type { CompleteTerminalObservation, WorkspacePtyTarget } from '../../sidetab-core/workspace-input.js';
import { createFullTranscriptCapture } from './full-transcript.js';

export type SidetabCharacter = 'shell' | 'elanous' | VisibleAgentCli | 'hermes';

export interface SidetabAttachmentController {
  attach(row: SidetabRow): boolean;
  select(row: SidetabRow): boolean;
  showMain(): void;
  spawn(character: SidetabCharacter): boolean;
  spawnSideAgent(agent: SidetabAgent): string | undefined;
  readSideAgent(row: SidetabRow): string | undefined;
  sendSideAgent(row: SidetabRow, input: string): Promise<boolean>;
  observeSidechat(target: WorkspacePtyTarget): CompleteTerminalObservation | undefined;
  runMission(agent: VisibleAgentCli, mission: string): Promise<Awaited<ReturnType<typeof runVisibleAgentMission>>>;
  runMissionPair(agent: 'codex' | 'claude', mission: string, parallelMission: string): Promise<unknown>;
  kill(row: SidetabRow): boolean;
  handleKey(key: Key): boolean;
  hasModal(): boolean;
  hasRemoteView(): boolean;
  refresh(): void;
  close(): void;
}

export { sidetabMissionFailureLog, visibleMissionPtyForTerminalSession } from '../branches/sidetab/mission.js';
export type { AgentCliDetection } from '../branches/sidetab/mission.js';

export function createSidetabAttachmentController(deps: {
  drawBase(): void;
  termSize(): { cols: number; rows: number };
  setStatus(message: string): void;
  drawRemoteFrame(frame: string): void;
  logEvent?(category: string, event: string, data: Record<string, unknown>): void;
  herdrPortal?: HerdrSidetabPortal;
  /** Owned by OPT; a missing detector keeps the hook inert until its API lands. */
  detectAgentCli?(agent: VisibleAgentCli): Promise<AgentCliDetection>;
  /** Test seam for exercising the visible mission path without launching an external CLI. */
  createVisibleMissionPty?(agent: VisibleAgentCli): { pty: VisibleMissionPty; cwd: string };
  /** Runner seam keeps the controller path testable with short deterministic mission timeouts. */
  visibleMissionRunner?: typeof runVisibleAgentMission;
  /** Test seam for exercising real session-exit propagation through the controller. */
  terminalRegistry?: TerminalSessionRegistry;
  /** Test seam for remote PTY transport and takeover races. */
  remotePtyCommand?(host: string, args: readonly string[]): Promise<string>;
}): SidetabAttachmentController {
  const eventBus = createDisplayEventBus();
  const coordinator = new DisplayCoordinator({
    termSize: deps.termSize,
    onRender: () => deps.drawBase(),
    writeOverlay: (ansi) => { try { process.stdout.write(ansi); } catch { /* TUI closed */ } },
  });
  const registry = deps.terminalRegistry ?? new TerminalSessionRegistry({ coordinator, eventBus });
  const transcripts = new Map<string, ReturnType<typeof createFullTranscriptCapture>>();
  let controllerClosed = false;
  const modalRouter = createTerminalModalRouter();
  let attachedSessionId: string | null = null;
  let detachPrefixPending = false;
  let remotePtyId: string | null = null;
  let remoteHost: string | null = null;
  let remoteTakenOver = false;
  let remoteAttachmentToken = 0;
  let remoteFrameTimer: ReturnType<typeof setInterval> | null = null;
  let remoteFramePending = false;
  let remoteHasFrame = false;
  const herdrPortal = deps.herdrPortal ?? createHerdrSidetabPortal();
  let herdrPaneId: string | null = null;
  let herdrTakenOver = false;
  let herdrFrameTimer: ReturnType<typeof setInterval> | null = null;
  let herdrFramePending = false;
  const herdrInputQueues = new Map<string, Promise<void>>();
  const remoteOperationQueues = new Map<string, Promise<void>>();
  const runRemotePtyCommand = async (host: string, args: readonly string[]): Promise<string> => {
    if (deps.remotePtyCommand) return deps.remotePtyCommand(host, args);
    const { runRemoteElnPty } = await import('./remote.js');
    return runRemoteElnPty(host, args);
  };
  const runRemotePtyControl = async (host: string | null, id: string, action: 'takeover' | 'release'): Promise<void> => {
    if (host) { await runRemotePtyCommand(host, ['pty', action, id]); return; }
    const result = await requestRemotePtyControl(id, action, undefined, { timeoutMs: action === 'takeover' ? 1_000 : 500 });
    if (result.status !== 'success') throw new Error(result.reason ?? result.status);
  };
  const enqueueRemoteOperation = (host: string | null, id: string, operation: () => Promise<void>): Promise<void> => {
    const key = (host ?? 'local') + '\0' + id;
    const previous = remoteOperationQueues.get(key) ?? Promise.resolve();
    let current: Promise<void>;
    current = previous.catch(() => {}).then(operation).finally(() => {
      if (remoteOperationQueues.get(key) === current) remoteOperationQueues.delete(key);
    });
    remoteOperationQueues.set(key, current);
    return current;
  };
  const releaseRemotePty = (host: string | null, id: string): void => {
    void enqueueRemoteOperation(host, id, () => runRemotePtyControl(host, id, 'release')).catch((error: unknown) => {
      deps.logEvent?.('sidetab.remote', 'release-failed', { host, ptyId: id, error: error instanceof Error ? error.message : String(error) });
      deps.setStatus('PTY 해제 실패 · ' + (host ?? 'local') + ':' + id);
    });
  };
  const enqueueRemoteInput = (host: string | null, id: string, token: number, send: () => Promise<void>): void => {
    void enqueueRemoteOperation(host, id, async () => {
      if (remotePtyId !== id || remoteHost !== host || remoteAttachmentToken !== token || !remoteTakenOver) {
        deps.logEvent?.('sidetab.remote', 'send-cancelled', { host, ptyId: id, reason: 'attachment-changed-before-send' });
        deps.setStatus('PTY 입력 취소 · 대상 전환으로 ' + (host ?? 'local') + ':' + id + '에 보내지 않았습니다');
        return;
      }
      try {
        await send();
        deps.logEvent?.('sidetab.remote', 'send-result', { host, ptyId: id, result: 'sent' });
      } catch (error) {
        const attachmentChanged = remotePtyId !== id || remoteHost !== host || remoteAttachmentToken !== token;
        const reason = error instanceof Error ? error.message : String(error);
        deps.logEvent?.('sidetab.remote', 'send-failed', { host, ptyId: id, reason, attachmentChanged, outcome: 'unknown', userVisible: true });
        deps.setStatus('PTY 입력 결과 불명(전송 여부 확인 불가) · ' + (host ?? 'local') + ':' + id + ' · ' + reason);
      }
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      deps.logEvent?.('sidetab.remote', 'operation-failed', { host, ptyId: id, reason });
      deps.setStatus('PTY 원격 작업 실패 · ' + (host ?? 'local') + ':' + id + ' · ' + reason);
    });
  };

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
    const previousHost = remoteHost;
    remoteAttachmentToken += 1;
    remotePtyId = null;
    remoteHost = null;
    if (previous && remoteTakenOver) releaseRemotePty(previousHost, previous);
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
    remoteHost = row.remoteHost ?? null;
    const host = remoteHost;
    const id = row.ptyId;
    deps.logEvent?.('sidetab.remote', 'attach-request', { ptyId: id, host });
    const token = ++remoteAttachmentToken;
    const isCurrentAttachment = (): boolean => remotePtyId === id && remoteHost === host && remoteAttachmentToken === token;
    const refresh = async (): Promise<void> => {
      if (remoteFramePending || !isCurrentAttachment()) return;
      remoteFramePending = true;
      try {
        if (host) debug.log('sidetab.remote', 'peek', { host, ptyId: id });
        const result = host
          ? { status: 'success' as const, screen: await runRemotePtyCommand(host, ['pty', 'snapshot', id, '--ansi']) }
          : await requestRemotePtyControl(id, 'snapshot', { ansi: true }, { timeoutMs: 450 });
        if (isCurrentAttachment() && result.status === 'success') {
          if (!result.screen?.trim()) {
            stopRemote();
            deps.setStatus('PTY 화면이 비어 있어 채팅 화면을 유지합니다');
            return;
          }
          remoteHasFrame = true;
          deps.drawRemoteFrame(result.screen ?? '');
        }
        else if (isCurrentAttachment() && result.status !== 'success') {
          if (!remoteHasFrame) stopRemote();
          deps.setStatus(`PTY 화면 읽기 실패 · ${result.status}`);
        }
      } catch (error) {
        if (isCurrentAttachment()) {
          if (host) debug.log('sidetab.remote', 'host-unreachable', { host, ptyId: id, reason: error instanceof Error ? error.message : String(error) });
          if (!remoteHasFrame) stopRemote();
          deps.setStatus(`PTY 화면 읽기 오류 · ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        remoteFramePending = false;
      }
    };
    void refresh();
    remoteFrameTimer = setInterval(() => { void refresh(); }, host ? 1_000 : 75);
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

  const spawn = (character: SidetabCharacter, background = false): boolean => {
    const { cols, rows } = deps.termSize();
    if (cols < 40 || rows < 8) {
      deps.setStatus('PTY 모달은 최소 40칸 × 8줄이 필요합니다');
      return false;
    }
    const id = `next-sidetab-${randomUUID()}`;
    const transcript = createFullTranscriptCapture();
    const cwd = getSessionCwd();
    const title = character === 'claude' ? 'claude-code' : character === 'grok' ? 'grok-build' : character;
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
      ...(character === 'claude' ? { agentBrand: 'claude-code' as const } : character === 'codex' || character === 'grok' || character === 'hermes' ? { agentBrand: character } : {}),
    };
    try {
      let command: string | undefined;
      let env: Record<string, string> | undefined;
      let unsetEnv: string[] | undefined;
      if (character === 'elanous') command = 'elanous --tui next';
      if (character === 'codex' || character === 'claude' || character === 'hermes') {
        const spec = sidetabAgentLaunch(character, process.env);
        command = spec.command;
        env = spec.env;
        unsetEnv = [...spec.unsetEnv];
      } else if (character === 'grok') {
        const backend = visibleAgentBackend(character);
        const spec = resolveBackendSpawn(backend, process.env);
        command = [spec.cmd, ...spec.args].map(shellQuote).join(' ');
        env = spec.env;
        // buildPtyEnv applies the driver's explicit auth scrub list after
        // merging captured login-shell variables; keep PATH/HOME/TERM intact.
        unsetEnv = [...spec.unsetEnv];
      }
      const session = registry.spawn({
        ...common,
        onRawOutput: (chunk) => transcript.append(chunk),
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
      transcripts.set(session.id, transcript);
      if (character === 'codex' || character === 'claude' || character === 'hermes') {
        deps.setStatus(`${character} 실행 · agent-mission 구독 경로 scrub 적용(${unsetEnv?.length ?? 0}개 env 제거)`);
      }
      if (background) {
        registry.detach(session.id);
        deps.setStatus(`${character} 사이드탭 PTY 실행 · ${session.id}`);
        return true;
      }
      return setModal(session);
    } catch (error) {
      deps.setStatus(`${character} 실행 실패: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const missionBranch = createSidetabMissionBranch({
    registry,
    setStatus: deps.setStatus,
    logEvent: deps.logEvent,
    detectAgentCli: deps.detectAgentCli,
    createVisibleMissionPty: deps.createVisibleMissionPty,
    visibleMissionRunner: deps.visibleMissionRunner,
    spawn,
    resetLastSpawnedSession: () => { lastSpawnedSession = null; },
    getLastSpawnedSession: () => lastSpawnedSession,
    showMain,
  });

  return {
    observeSidechat(target) {
      if (target.remoteHost) return undefined;
      const manifest = listPtyManifestRows().find((row) => row.id === target.ptyId);
      if (!manifest || !manifest.alive || manifest.ownerPid !== target.ownerPid
        || manifest.startedAt !== target.ptyStartedAt || manifest.outputBytesTotal === undefined
        || manifest.outputBytesTotal < 0) return undefined;
      const sessionId = manifest.purpose?.startsWith('next-tui-sidetab:')
        ? manifest.purpose.slice('next-tui-sidetab:'.length) : '';
      const session = registry.get(sessionId);
      const transcript = transcripts.get(sessionId);
      if (!session || session.state === 'exited' || !transcript
        || transcript.bytes() !== manifest.outputBytesTotal) return undefined;
      const text = transcript.transcript();
      const screen = redactSecretText(session.preview.renderForLLM());
      if (!text?.trim() || !screen.trim()) return undefined;
      return {
        target, screen, transcript: text, observedAt: new Date().toISOString(),
        activityAt: manifest.outputBytesTotal, coverage: 'full',
      };
    },
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
    spawnSideAgent(agent) {
      return spawn(agent, true) ? lastSpawnedSession?.id : undefined;
    },
    readSideAgent(row) {
      return row.sessionId ? readSidetabAgent(registry, row.sessionId) : undefined;
    },
    sendSideAgent(row, input) {
      return row.sessionId ? sendSidetabAgent(registry, row.sessionId, input) : Promise.resolve(false);
    },
    runMission: missionBranch.runMission,
    runMissionPair: missionBranch.runMissionPair,
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
          const host = remoteHost;
          const token = remoteAttachmentToken;
          void enqueueRemoteOperation(host, id, async () => {
            const isCurrent = (): boolean => remotePtyId === id && remoteHost === host && remoteAttachmentToken === token;
            if (!isCurrent()) return;
            await runRemotePtyControl(host, id, 'takeover');
            if (!isCurrent()) {
              // This operation is serialized with a later takeover for the same target.
              await runRemotePtyControl(host, id, 'release');
              return;
            }
            remoteTakenOver = true;
            deps.setStatus('사람 입력 takeover 완료 · 전환 때 release');
          }).catch((error: unknown) => {
            if (remotePtyId === id && remoteHost === host && remoteAttachmentToken === token) deps.setStatus(`takeover 오류 · ${error instanceof Error ? error.message : String(error)}`);
          });
          return true;
        }
        if (remoteTakenOver && key.raw) {
          const id = remotePtyId!;
          const raw = key.raw!;
          const host = remoteHost;
          const token = remoteAttachmentToken;
          if (host) debug.log('sidetab.remote', 'send', { host, ptyId: id, chars: raw.length });
          const send = async (): Promise<void> => {
            if (host) {
              const enter = raw === '\r' || raw === '\n';
              const args = ['pty', 'text', id, enter ? '' : raw, ...(enter ? ['--enter'] : []), '--actor', 'human'];
              await runRemotePtyCommand(host, args);
              return;
            }
            const result = await requestRemotePtyControl(id, 'input-key', { chars: raw }, { timeoutMs: 500 });
            if (result.status !== 'success') throw new Error(result.status);
          };
          enqueueRemoteInput(host, id, token, send);
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
      if (controllerClosed) return;
      controllerClosed = true;
      stopRemote();
      stopHerdr();
      modalRouter.close();
      for (const session of registry.list()) registry.kill(session.id);
      transcripts.clear();
      missionBranch.close();
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

function visibleAgentBackend(agent: VisibleAgentCli) {
  if (agent === 'codex') return codexBackend;
  if (agent === 'claude') return claudeBackend;
  return grokBackend;
}
