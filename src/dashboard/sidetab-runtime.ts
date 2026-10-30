import { createVwFilterPickerModal } from '../ui/vw-filter-picker-modal.js';
import type { ModalSurface } from '../display/modal-stack.js';
import type { Key } from '../tui.js';
import { loadSidetabRows, type SidetabRow } from '../sidetab-core/model.js';

export interface DashboardLocalAgentSession {
  id: string;
  title: string;
  kind: 'shell' | 'coding-agent';
  agentBrand?: 'claude-code' | 'codex' | 'gemini';
  state: 'foreground' | 'background' | 'exited';
}

export interface DashboardMissionResult {
  ok: boolean;
  path: string;
  content?: string;
  firstLine?: string;
  promptReady: boolean;
  missionVisible: boolean;
  promptReturned: boolean;
  completionMarker: boolean;
  error?: string;
}

/** Convert popup startup/adapter exceptions into the same explicit mission outcome. */
export async function runDashboardAgentMission<TSession, TModal>(deps: {
  agent: string;
  requestedOutputPath?: string;
  open: () => TSession | undefined;
  modal: (session: TSession) => TModal | null | undefined;
  outputPath: (session: TSession, requested?: string) => string;
  run: (session: TSession, modal: TModal, outputPath: string) => Promise<DashboardMissionResult>;
  close: (session: TSession) => void;
}): Promise<DashboardMissionResult> {
  let session: TSession | undefined;
  let resultPath = deps.requestedOutputPath ?? '';
  try {
    session = deps.open();
    if (session === undefined) throw new Error(`${deps.agent} PTY could not start`);
    const modal = deps.modal(session);
    if (!modal) throw new Error(`${deps.agent} PTY could not start`);
    resultPath = deps.outputPath(session, deps.requestedOutputPath);
    return await deps.run(session, modal, resultPath);
  } catch (error) {
    return {
      ok: false,
      path: resultPath,
      promptReady: false,
      missionVisible: false,
      promptReturned: false,
      completionMarker: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (session !== undefined) {
      try { deps.close(session); } catch { /* closing a failed popup must not replace its mission result */ }
    }
  }
}

/** Keep locally spawned coding-agent tabs attachable even when no PTY manifest row exists. */
export function mergeLocalAgentSessions(
  rows: readonly SidetabRow[],
  sessions: readonly DashboardLocalAgentSession[],
): SidetabRow[] {
  const knownSessionIds = new Set(rows.map((row) => row.sessionId).filter((id): id is string => Boolean(id)));
  const localAgents = sessions
    .filter((session) => session.kind === 'coding-agent' && session.state !== 'exited' && !knownSessionIds.has(session.id))
    .map((session): SidetabRow => ({
      id: session.id,
      label: session.title,
      kind: session.agentBrand ?? 'coding-agent',
      // Terminal foreground/background says where the session is attached,
      // not whether the agent is currently working. Do not infer turn state.
      badge: 'unknown',
      sessionId: session.id,
    }));
  return [...rows, ...localAgents];
}

export interface DashboardSidetabRuntimeDeps {
  currentSessionId: () => string | undefined;
  termSize: () => { cols: number; rows: number };
  loadRows?: (sessionId?: string) => SidetabRow[];
  pushModal: (surface: ModalSurface) => { dispose: () => void };
  attach: (row: SidetabRow) => void;
  spawnShell: () => void;
  spawnAgent: (agent: 'codex' | 'claude') => void;
  runMission: (agent: 'codex' | 'claude', mission: string, outputPath?: string) => Promise<DashboardMissionResult>;
  detach: (row: SidetabRow | null) => void;
  kill: (row: SidetabRow) => void;
  returnToParent: () => void;
  status: (message: string) => void;
}

export interface DashboardSidetabRuntime {
  loadRows: (sessionId?: string) => SidetabRow[];
  routeKey: (key: Key) => boolean;
  beginPrefix: () => void;
  openAgent: DashboardSidetabRuntimeDeps['spawnAgent'];
  runMission: DashboardSidetabRuntimeDeps['runMission'];
  close: () => void;
}

/** Classic dashboard controls for the shared sidetab model. */
export function createDashboardSidetabRuntime(
  deps: DashboardSidetabRuntimeDeps,
): DashboardSidetabRuntime {
  const getRows = deps.loadRows ?? ((sessionId) => loadSidetabRows(false, sessionId));
  let prefixPending = false;
  let modalDispose: (() => void) | null = null;
  let panel: ReturnType<typeof createVwFilterPickerModal> | null = null;
  let panelRows: SidetabRow[] = [];

  const closePanel = (): void => {
    const dispose = modalDispose;
    modalDispose = null;
    panel = null;
    panelRows = [];
    dispose?.();
  };

  const attach = (row: SidetabRow): void => {
    closePanel();
    if (row.currentProcess) {
      deps.returnToParent();
      return;
    }
    deps.attach(row);
  };

  const selectedRow = (): SidetabRow | null => {
    const item = panel?.state().items[panel.state().selectedIdx];
    return item?.payload && typeof item.payload === 'object'
      ? item.payload as SidetabRow
      : null;
  };

  const confirmKill = (row: SidetabRow | null): void => {
    if (!row || row.currentProcess) {
      deps.status('현재 classic TUI 세션은 종료할 수 없습니다');
      return;
    }
    closePanel();
    let dispose: (() => void) | null = null;
    const confirm = createVwFilterPickerModal({
      id: `classic-sidetab-kill-${Date.now().toString(36)}`,
      bounds: { row: 3, col: 2, width: Math.min(52, Math.max(24, deps.termSize().cols - 4)), height: 7 },
      title: `종료 확인 · ${row.label}`,
      width: Math.min(52, Math.max(24, deps.termSize().cols - 4)),
      maxVisible: 2,
      primaryActionLabel: '선택',
      cancelActionLabel: '취소',
      footerHint: '기본 취소 · 종료를 선택해야 PTY를 끝냅니다',
      onQuery: () => [
        { label: '취소', payload: 'cancel' },
        { label: '종료', payload: 'kill' },
      ],
      onAccept: (item) => {
        dispose?.();
        dispose = null;
        if (item.payload === 'kill') deps.kill(row);
      },
      onCancel: () => {
        dispose?.();
        dispose = null;
      },
    });
    dispose = deps.pushModal(confirm.surface).dispose;
  };

  const openPanel = (): void => {
    if (modalDispose) {
      closePanel();
      deps.returnToParent();
      return;
    }
    const { cols, rows } = deps.termSize();
    if (cols < 34 || rows < 12) {
      deps.status('사이드탭은 최소 34칸 × 12줄이 필요합니다');
      return;
    }
    const sessionId = deps.currentSessionId();
    panelRows = getRows(sessionId).filter((row) => row.badge !== 'exited');
    const width = Math.min(64, cols - 4);
    const maxVisible = Math.max(1, Math.min(8, rows - 10));
    const panelHeight = Math.min(rows - 2, 8 + Math.min(maxVisible, panelRows.length));
    panel = createVwFilterPickerModal({
      id: `classic-sidetab-${Date.now().toString(36)}`,
      bounds: { row: Math.max(1, Math.floor((rows - panelHeight) / 2)), col: Math.max(1, Math.floor((cols - width) / 2)), width, height: panelHeight },
      title: 'Classic sidetab · this session and children',
      width,
      maxVisible,
      primaryActionLabel: '연결',
      cancelActionLabel: '닫기',
      footerHint: 'Enter 연결 · n 새 셸 · d 분리 · k 종료 · Esc 닫기',
      onQuery: (query) => {
        const normalized = query.trim().toLocaleLowerCase();
        return panelRows
          .filter((row) => !normalized || `${row.label} ${row.kind} ${row.badge}`.toLocaleLowerCase().includes(normalized))
          .map((row) => ({ label: `${row.currentProcess ? '● 현재' : '○'} ${row.badge} ${row.label}`, payload: row }));
      },
      onAccept: (item) => {
        const row = item.payload as SidetabRow;
        attach(row);
      },
      onCancel: closePanel,
    });
    const defaultOnKey = panel.surface.onKey;
    panel.surface.onKey = (event) => {
      if (!event.ctrl && !event.alt && event.name.toLowerCase() === 'n') {
        closePanel();
        deps.spawnShell();
        return 'consumed';
      }
      if (!event.ctrl && !event.alt && event.name.toLowerCase() === 'd') {
        const row = selectedRow();
        closePanel();
        deps.detach(row);
        return 'consumed';
      }
      if (!event.ctrl && !event.alt && event.name.toLowerCase() === 'k') {
        confirmKill(selectedRow());
        return 'consumed';
      }
      return defaultOnKey?.(event) ?? 'passthrough';
    };
    modalDispose = deps.pushModal(panel.surface).dispose;
  };

  const chooseIndex = (index: number): void => {
    const rows = getRows(deps.currentSessionId()).filter((row) => row.badge !== 'exited');
    const row = rows[index];
    if (!row) {
      deps.status(`사이드탭 ${index + 1}번 항목 없음`);
      return;
    }
    attach(row);
  };

  const beginPrefix = (): void => {
    if (prefixPending) return;
    closePanel();
    prefixPending = true;
    deps.status('사이드탭 키 대기 · s/p/1–9/n/d/k/Esc');
  };

  const routeKey = (key: Key): boolean => {
    if (panel) {
      const panelResult = panel.surface.onKey?.(key as never);
      if (panelResult && panelResult !== 'passthrough') return true;
    }
    if (prefixPending) {
      prefixPending = false;
      const name = key.name.toLowerCase();
      if (key.name === 'escape' || key.name === 'esc') {
        closePanel();
        deps.returnToParent();
        return true;
      }
      if (!key.ctrl && !key.alt && name === 's') {
        openPanel();
        return true;
      }
      if (!key.ctrl && !key.alt && name === 'p') {
        closePanel();
        deps.returnToParent();
        return true;
      }
      if (!key.ctrl && !key.alt && /^[1-9]$/.test(key.name)) {
        chooseIndex(Number(key.name) - 1);
        return true;
      }
      if (!key.ctrl && !key.alt && name === 'n') {
        closePanel();
        deps.spawnShell();
        return true;
      }
      if (!key.ctrl && !key.alt && (name === 'c' || name === 'a')) {
        closePanel();
        deps.spawnAgent(name === 'c' ? 'codex' : 'claude');
        return true;
      }
      if (!key.ctrl && !key.alt && name === 'd') {
        closePanel();
        deps.detach(null);
        return true;
      }
      if (!key.ctrl && !key.alt && name === 'k') {
        const row = getRows(deps.currentSessionId()).filter((item) => item.badge !== 'exited')
          .find((item) => !item.currentProcess) ?? null;
        confirmKill(row);
        return true;
      }
      deps.status('사이드탭 키: s 목록 · p 부모 · 1–9 연결 · c Codex · a Claude · n 새 셸 · d 분리 · k 종료');
      return true;
    }
    if (key.ctrl && !key.alt && (key.name === '\\' || key.name === 'backslash')) {
      beginPrefix();
      return true;
    }
    return false;
  };

  return {
    loadRows: (sessionId) => getRows(sessionId ?? deps.currentSessionId()),
    routeKey,
    beginPrefix,
    openAgent: deps.spawnAgent,
    runMission: deps.runMission,
    close() {
      prefixPending = false;
      closePanel();
    },
  };
}
