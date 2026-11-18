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
import { readSidetabAgent, sendSidetabAgent, sendSidetabAgentKeys, sidetabAgentLaunch, sidetabAgentStatus, type SidetabAgent } from '../../tui-client/sidetab-agent-pty.js';
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
  sendSideAgentKeys(row: SidetabRow, names: readonly string[]): boolean;
  sideAgentStatus(row: SidetabRow): ReturnType<typeof sidetabAgentStatus>;
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
      deps.setStatus('PTY detach failed · ' + (host ?? 'local') + ':' + id);
    });
  };
  const enqueueRemoteInput = (host: string | null, id: string, token: number, send: () => Promise<void>): void => {
    void enqueueRemoteOperation(host, id, async () => {
      if (remotePtyId !== id || remoteHost !== host || remoteAttachmentToken !== token || !remoteTakenOver) {
        deps.logEvent?.('sidetab.remote', 'send-cancelled', { host, ptyId: id, reason: 'attachment-changed-before-send' });
        deps.setStatus('PTY input cancelled · not sent to ' + (host ?? 'local') + ':' + id + ' on target switch');
        return;
      }
      try {
        await send();
        deps.logEvent?.('sidetab.remote', 'send-result', { host, ptyId: id, result: 'sent' });
      } catch (error) {
        const attachmentChanged = remotePtyId !== id || remoteHost !== host || remoteAttachmentToken !== token;
        const reason = error instanceof Error ? error.message : String(error);
        deps.logEvent?.('sidetab.remote', 'send-failed', { host, ptyId: id, reason, attachmentChanged, outcome: 'unknown', userVisible: true });
        deps.setStatus('PTY input outcome unknown · ' + (host ?? 'local') + ':' + id + ' · ' + reason);
      }
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      deps.logEvent?.('sidetab.remote', 'operation-failed', { host, ptyId: id, reason });
      deps.setStatus('PTY remote op failed · ' + (host ?? 'local') + ':' + id + ' · ' + reason);
    });
  };

  const enqueueHerdrInput = (paneId: string, send: () => Promise<void>): void => {
    const previous = herdrInputQueues.get(paneId) ?? Promise.resolve();
    let current: Promise<void>;
    current = previous.catch(() => {}).then(send).catch((error: unknown) => {
      if (herdrPaneId === paneId) deps.setStatus(`Herdr input failed · ${error instanceof Error ? error.message : String(error)}`);
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
      deps.setStatus('Herdr connect requires an admin session with HERDR_ENV=1');
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
        if (herdrPaneId === paneId) deps.setStatus(`Herdr pane read failed · ${error instanceof Error ? error.message : String(error)}`);
      } finally { herdrFramePending = false; }
    };
    void refresh();
    herdrFrameTimer = setInterval(() => { void refresh(); }, 250);
    deps.setStatus('Herdr pane observe · t takeover · Esc / Ctrl+\\ back · Ctrl+Q quit all (Ctrl+[ may read as Esc)');
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
            deps.setStatus('PTY screen empty · keeping chat view');
            return;
          }
          remoteHasFrame = true;
          deps.drawRemoteFrame(result.screen ?? '');
        }
        else if (isCurrentAttachment() && result.status !== 'success') {
          if (!remoteHasFrame) stopRemote();
          deps.setStatus(`PTY screen read failed · ${result.status}`);
        }
      } catch (error) {
        if (isCurrentAttachment()) {
          if (host) debug.log('sidetab.remote', 'host-unreachable', { host, ptyId: id, reason: error instanceof Error ? error.message : String(error) });
          if (!remoteHasFrame) stopRemote();
          deps.setStatus(`PTY screen read error · ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        remoteFramePending = false;
      }
    };
    void refresh();
    remoteFrameTimer = setInterval(() => { void refresh(); }, host ? 1_000 : 75);
    deps.setStatus('Remote PTY screen · t takeover · Ctrl+\\ then ↑/↓ switch');
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
        deps.setStatus('PTY detached · reselect in sidetab');
        deps.drawBase();
      },
    });
    deps.setStatus('PTY input · Ctrl+\\ d detach · Ctrl+Q passes to PTY');
    coordinator.requestRenderNow({ force: true });
    return true;
  };

  const spawn = (character: SidetabCharacter, background = false): boolean => {
    const { cols, rows } = deps.termSize();
    if (cols < 40 || rows < 8) {
      deps.setStatus('PTY modal needs at least 40 cols × 8 rows');
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
            deps.setStatus(`${title} exited · back to sidetab`);
            deps.drawBase();
          }
        },
      }, { termCols: cols, termRows: rows });
      lastSpawnedSession = session;
      transcripts.set(session.id, transcript);
      if (character === 'codex' || character === 'claude' || character === 'hermes') {
        deps.setStatus(`${character} started · agent-mission subscribe path scrub (${unsetEnv?.length ?? 0} env removed)`);
      }
      if (background) {
        registry.detach(session.id);
        deps.setStatus(`${character} sidetab PTY started · ${session.id}`);
        return true;
      }
      return setModal(session);
    } catch (error) {
      deps.setStatus(`${character} start failed: ${error instanceof Error ? error.message : String(error)}`);
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
        deps.setStatus('Not a Next TUI session · only shell/agent sessions can attach');
        return false;
      }
      if (session.state === 'exited') {
        deps.setStatus('Cannot attach an exited PTY');
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
    sendSideAgentKeys(row, names) {
      return row.sessionId ? sendSidetabAgentKeys(registry, row.sessionId, names) : false;
    },
    sideAgentStatus(row) {
      return row.sessionId ? sidetabAgentStatus(registry, row.sessionId) : undefined;
    },
    runMission: missionBranch.runMission,
    runMissionPair: missionBranch.runMissionPair,
    kill(row) {
      if (row.currentProcess) {
        deps.setStatus('Current TUI session cannot be killed from sidetab');
        return false;
      }
      const session = sessionForRow(row);
      if (!session) {
        if (row.ptyId) {
          void requestRemotePtyControl(row.ptyId, 'terminate', undefined, { timeoutMs: 1_000 }).then((result) => {
            deps.setStatus(result.status === 'success' ? 'PTY kill requested' : `PTY kill refused · ${result.status}`);
          }).catch((error: unknown) => deps.setStatus(`PTY kill error · ${error instanceof Error ? error.message : String(error)}`));
          return true;
        }
        deps.setStatus('This item cannot be killed from this Next TUI');
        return false;
      }
      if (attachedSessionId === session.id) {
        modalRouter.set(null);
        attachedSessionId = null;
      }
      registry.kill(session.id);
      deps.setStatus(`${session.title} stop requested`);
      return true;
    },
    handleKey(key) {
      if (herdrPaneId) {
        if (key.name.toLowerCase() === 'escape') {
          stopHerdr();
          deps.setStatus('Back from Herdr pane');
          return true;
        }
        if (key.ctrl && key.name.toLowerCase() === 'q') {
          stopHerdr();
          deps.setStatus('Back from Herdr pane');
          return false;
        }
        if (key.ctrl && (key.name === '\\' || key.raw === '\x1c')) {
          stopHerdr();
          deps.setStatus('Back from Herdr pane');
          return false;
        }
        if (key.name.toLowerCase() === 't' && !herdrTakenOver) {
          herdrTakenOver = true;
          deps.setStatus('Herdr pane takeover · Esc to return');
          return true;
        }
        const raw = key.raw;
        if (herdrTakenOver && raw) {
          const paneId = herdrPaneId;
          if (raw.includes('\x00')) {
            deps.setStatus('Cannot send NUL input to Herdr pane');
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
            deps.setStatus('Human input takeover done · release on switch');
          }).catch((error: unknown) => {
            if (remotePtyId === id && remoteHost === host && remoteAttachmentToken === token) deps.setStatus(`takeover error · ${error instanceof Error ? error.message : String(error)}`);
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
        deps.setStatus('Detach cancelled · press Ctrl+\\ d to detach');
        coordinator.requestRenderNow({ force: true });
        return true;
      }
      if (key.ctrl && key.name === '\\') {
        detachPrefixPending = true;
        deps.setStatus('Waiting for detach key · d');
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
