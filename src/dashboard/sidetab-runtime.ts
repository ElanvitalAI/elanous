import { createVwFilterPickerModal } from '../ui/vw-filter-picker-modal.js';
import type { ModalSurface } from '../display/modal-stack.js';
import type { Key } from '../tui.js';
import { loadSidetabRows, type SidetabRow } from '../sidetab-core/model.js';

export interface DashboardSidetabRuntimeDeps {
  currentSessionId: () => string | undefined;
  termSize: () => { cols: number; rows: number };
  loadRows?: (sessionId?: string) => SidetabRow[];
  pushModal: (surface: ModalSurface) => { dispose: () => void };
  attach: (row: SidetabRow) => void;
  spawnShell: () => void;
  detach: (row: SidetabRow | null) => void;
  kill: (row: SidetabRow) => void;
  returnToParent: () => void;
  status: (message: string) => void;
}

export interface DashboardSidetabRuntime {
  routeKey: (key: Key) => boolean;
  beginPrefix: () => void;
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
      deps.status('사이드탭 키: s 목록 · p 부모 · 1–9 연결 · n 새 셸 · d 분리 · k 종료');
      return true;
    }
    if (key.ctrl && !key.alt && (key.name === '\\' || key.name === 'backslash')) {
      beginPrefix();
      return true;
    }
    return false;
  };

  return {
    routeKey,
    beginPrefix,
    close() {
      prefixPending = false;
      closePanel();
    },
  };
}
