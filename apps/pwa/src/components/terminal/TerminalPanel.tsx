'use client';

// PR #2 — page-agnostic terminal panel.
//
// 기존 `/term` page.tsx 의 본문 전체를 컴포넌트로 추출. page.tsx 는 이
// 컴포넌트를 mount 하는 thin wrapper 로만 남는다. `/workspace` (PR #3)
// 도 같은 컴포넌트를 mount 하므로 single-tab vs workspace 양쪽 동작이
// 한 source 에서 발산한다.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { XtermView } from './XtermView';
import { PtyLiveView } from './PtyLiveView';
import { PtyWall } from './PtyWall';
import { wallFromSearch } from './pty-wall';
import { TerminalTabs, type InitialTerminalState } from './TerminalTabs';
import { initialTerminalNotice } from './initial-terminal-notice';
import { TuiMirrorView } from './TuiMirrorView';
import { TerminalControls } from './TerminalControls';
import { ModifierBar } from './ModifierBar';
import { MultiDeviceIndicator } from './MultiDeviceIndicator';
import { TerminalDropZone } from './TerminalDropZone';
import { TerminalChatDock, type TerminalChatDockHandle } from './TerminalChatDock';
import { TailscaleSecurityBanner } from '@/components/voice/TailscaleSecurityBanner';
import { usePointerCapability } from '@/lib/use-pointer-capability';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { checkSecureContext } from '@/lib/secure-context-guard';
import type { AttachmentMeta } from '@/lib/upload-attachment';
import { injectAttachmentPathsToTerminal } from '@/lib/inject-attachment-paths';
import { useVoiceController } from '@/voice/use-voice-controller';
import { VOICE_DOT_COLOR, VOICE_PHASE_LABEL } from '@/voice/voice-phase-styles';
import { sendToTerminal } from './terminal-input-registry';
import { debugLog } from '@/lib/debug';
import type { DaemonClient, DaemonTerminalDetailOptions, DaemonTerminalsScope, DaemonTerminalSummary } from '@/lib/daemon-client';
import {
  ptyProgressByTerminal,
  ptyTerminalProcessOutputStatusLabel,
  ptyTerminalStartedAtLabel,
  ptyTerminalLineageModel,
  ptyTerminalListRequest,
  ptyTerminalPanelModel,
  ptyTerminalRows,
  initialTerminalSelection,
  ptyRowKey,
  resolvePtyTerminalId,
  type PtyTerminalIdResolution,
  type PtyFrameState,
  type PtyLineageState,
  type PtyProgressSummary,
  type PtyScrollbackState,
  type PtyTerminalViewMode,
} from './pty-terminal-list';
import { ptyTerminalRowSummary } from './pty-terminal-row-summary';
import { renameOutcomeMessage } from './rename-outcome';
import { panePlan } from './pane-plan';
import { paneLayout, paneLayoutForSelection, type PaneLayoutResult } from './pane-layout';
import {
  nextTerminalPanelView,
  terminalPanelViewState,
  type TerminalPanelView,
} from './panel-view-state';

const ACTIVE_KEY = 'elanous.webterm.activeId';
const MINIMIZED_KEY = 'elanous.webterm.panelsMinimized';
const CHAT_DOCK_KEY = 'elanous.webterm.chatDockOpen';
// A bounded snapshot shows enough recent terminal context without making a list click expensive.
const PTY_SCROLLBACK_LINES = 100;

export function terminalDetailOptions(terminal: DaemonTerminalSummary): DaemonTerminalDetailOptions {
  return terminal.sourceRoot ? { sourceRoot: terminal.sourceRoot.dbPath } : {};
}

export function fetchPtyScrollbackDetail(
  client: Pick<DaemonClient, 'fetchTerminalScrollback'>,
  terminal: DaemonTerminalSummary,
) {
  return client.fetchTerminalScrollback(terminal.id, PTY_SCROLLBACK_LINES, terminalDetailOptions(terminal));
}

export function fetchPtyFrameDetail(
  client: Pick<DaemonClient, 'fetchTerminalFrame'>,
  terminal: DaemonTerminalSummary,
) {
  return client.fetchTerminalFrame(terminal.id, terminalDetailOptions(terminal));
}

export function TerminalPaneLayout({
  layout,
  sessionId,
  onForeignInputActivity,
  terminalIds,
  activeId = null,
  visible = true,
  clearRequests,
}: {
  layout: PaneLayoutResult;
  sessionId: string;
  onForeignInputActivity: () => void;
  terminalIds?: readonly string[];
  activeId?: string | null;
  visible?: boolean;
  clearRequests?: Readonly<Record<string, number>>;
}) {
  const slots = layout.layouts.flatMap((entry) => entry.slots);
  const slotById = new Map(slots.map((slot) => [slot.terminalId, slot]));
  const runStartIds = new Set(layout.layouts.map((entry) => entry.slots[0]?.terminalId).filter((id): id is string => Boolean(id)));
  const mountedIds = terminalIds === undefined
    ? slots.map((slot) => slot.terminalId)
    : [...new Set([...terminalIds, ...(activeId ? [activeId] : []), ...slots.map((slot) => slot.terminalId)])];
  const visibleIds = new Set(slots.length > 0 ? slots.map((slot) => slot.terminalId) : activeId ? [activeId] : []);

  return (
    <div className={visible ? 'grid h-full min-h-0 grid-cols-2 gap-2 p-2' : 'hidden'} aria-label="런별 터미널 배치">
      {layout.layouts.map(({ runId }) => (
        <section key={runId} className="sr-only" aria-label={`런 ${runId} 터미널`} />
      ))}
      {mountedIds.map((terminalId) => {
        const slot = slotById.get(terminalId);
        const shown = visible && visibleIds.has(terminalId);
        const position = slot?.position ?? (terminalId === activeId ? 'single' : 'inactive-tab');
        return (
          <div
            key={terminalId}
            className={shown
              ? `${runStartIds.has(terminalId) ? 'col-start-1 ' : ''}${slot?.position === 'split'
                ? 'min-h-0 border border-emerald-600'
                : slot?.position === 'tab'
                  ? 'min-h-0 border border-zinc-700'
                  : 'col-span-2 h-full min-h-0'}`
              : 'hidden'}
            data-pane-position={position}
            data-terminal-id={terminalId}
          >
            {slot && <p className="sr-only">{slot.position === 'split' ? '분할 터미널' : '탭 터미널'}: {terminalId}</p>}
            <XtermView
              key={terminalId}
              sessionId={sessionId}
              terminalId={terminalId}
              clearRequest={clearRequests?.[terminalId] ?? 0}
              onForeignInputActivity={onForeignInputActivity}
            />
          </div>
        );
      })}
      {layout.unknown.map(({ id, reason }) => (
        <p key={id} className="text-xs text-muted-foreground" data-terminal-id={id} data-pane-relationship={reason}>
          터미널 {id}: 관계를 알 수 없어 배치하지 않았습니다.
        </p>
      ))}
    </div>
  );
}

export interface TerminalPanelProps {
  /** PTY id read by the page from `?pty=`; an id chooses a row only when unique across roots. */
  initialPtyId?: string | null;
  /** Called for a direct list-row click, not the initial URL selection. */
  onPtySelection?: (terminal: DaemonTerminalSummary) => void;
}

/** TERM1 — how long the plain terminal view waits before loading the PTY list. */
export const PTY_LIST_DEFER_MS = 1_200;

export function TerminalPanel({ initialPtyId = null, onPtySelection }: TerminalPanelProps = {}) {
  const { client, config, sessionId } = useDaemon();
  // WT-X-1 — auto-reveal mobile modifier bar on touch devices
  // (`@media (pointer: coarse)`). Desktop users with a mouse never
  // see it; iPad / iPhone get it for free. Hybrid devices (Surface,
  // ChromeOS tablet mode) toggle as the user docks/undocks.
  const { isCoarsePointer } = usePointerCapability();
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [clearRequests, setClearRequests] = useState<Readonly<Record<string, number>>>({});
  const [tabIds, setTabIds] = useState<readonly string[]>([]);
  const [liveDismissed, setLiveDismissed] = useState(false);
  const [livePty, setLivePty] = useState<DaemonTerminalSummary | null>(null);
  // 터미널 나란히(드라이브 RFC ⑥ 2단계) — 주소 `?wall=a,b` 로도 연다(마운트 뒤에 읽는다 · #418).
  const [wall, setWall] = useState<string[] | null>(null);
  // «무대» 보기(`&stage=1` · 🅢 12:4x 녹화용) — 채팅 독·툴바를 덮고 터미널이 화면 높이 전부 · 의도 띠 글자 한 단계 크게.
  const [wallStage, setWallStage] = useState(false);
  useEffect(() => {
    const search = window.location?.search ?? '';
    const w = wallFromSearch(search);
    if (w.length) setWall(w);
    if (new URLSearchParams(search).get('stage') === '1') setWallStage(true);
  }, []);
  const [initialTerminalState, setInitialTerminalState] = useState<InitialTerminalState>({ status: 'pending' });
  // ⛔ 렌더당 «한 번»만 계산한다 — 두 번 부르면 화면 분기와 배너가 서로 다른 결과를 쓸 수 있다
  //    (무인 리뷰 should-fix · 2026-08-18 `#10105`).
  const initialNotice = initialTerminalNotice(initialTerminalState, terminalId !== null);
  const handleInitialTerminalState = useCallback((state: InitialTerminalState): void => {
    setInitialTerminalState(state);
    if (state.status === 'pending') setTerminalId(null);
  }, []);
  // ⛔ 자동 초기 선택은 «한 번»만 돈다 — 사람이 고른 뒤엔 도구가 다시 안 고른다.
  const initialPickDoneRef = useRef(false);
  const initialPickSkipLoggedRef = useRef(false);
  // ⭐P2 (capture substrate) — observe mode swaps the main view to the
  // read-only live TUI mirror (self-reported dashboard frames · P2-c).
  const [panelView, setPanelView] = useState<TerminalPanelView>('terminal');
  const panelState = terminalPanelViewState(panelView);
  const selectPanelView = useCallback((selected: TerminalPanelView) => {
    setPanelView((current) => nextTerminalPanelView(current, selected));
  }, []);
  // Direct links search every instance; opening the list without a link remains local.
  const [includeAllPtyInstances, setIncludeAllPtyInstances] = useState(Boolean(initialPtyId));
  const [ptyRows, setPtyRows] = useState<DaemonTerminalSummary[]>([]);
  const [ptyScope, setPtyScope] = useState<DaemonTerminalsScope>();
  const [ptyProgress, setPtyProgress] = useState<ReadonlyMap<string, PtyProgressSummary>>(new Map());
  const [ptyListState, setPtyListState] = useState<'idle' | 'loading' | 'error'>('loading');
  // ⛔ The selected ROW, not its id. Ids repeat across manifest roots in the
  //    federated list, so an id cannot say which row is selected — and every
  //    follow-up request would then pick whichever row sorted first.
  const [selectedPty, setSelectedPty] = useState<DaemonTerminalSummary | null>(null);
  // ⛔ 「조회가 실패했다」를 「목록이 비었다」로 접지 않는다. 목록 요청이 error 로 끝나면
  //    ptyRows 는 [] 이고, 그것을 그대로 해석기에 넣으면 reason 이 'empty-terminal-list' 로
  //    나와 ***화면이 「목록이 비었다」는 «틀린 사실»을 말한다***(리뷰 must-fix 2026-08-19).
  const [initialPtyResolution, setInitialPtyResolution] = useState<PtyTerminalIdResolution | { kind: 'list-unavailable' } | null>(null);
  // URL PTY selection initializes once after the federated list resolves;
  // it opens the live view without activating a shell tab.
  const initialPtyPickDoneRef = useRef(false);
  const selectedPtyId = selectedPty?.id ?? null;
  const selectedPtyKey = selectedPty ? ptyRowKey(selectedPty) : null;
  // Preserve the established raw scrollback view until a person explicitly asks for the rendered grid.
  const [ptyViewMode, setPtyViewMode] = useState<PtyTerminalViewMode>('raw');
  const [scrollbackByPty, setScrollbackByPty] = useState<ReadonlyMap<string, PtyScrollbackState>>(new Map());
  const [frameByPty, setFrameByPty] = useState<ReadonlyMap<string, PtyFrameState>>(new Map());
  const [ptyLineage, setPtyLineage] = useState<PtyLineageState>({ status: 'unrequested' });
  const ptySnapshotRequestRef = useRef(0);
  const ptyLineageRequestRef = useRef(0);
  useEffect(() => {
    if (panelView !== 'terminal' && panelView !== 'pty-list') return;
    let cancelled = false;
    setPtyListState('loading');
    // TERM1 · 10-02 — on the plain terminal view the PTY list is secondary: let the shell come up first, and let a
    // second run of this effect (the client object settles right after mount) cancel the first instead of doubling
    // the two heaviest calls (`/v1/terminals` ⊕ 200 log lines — 1.7–6.6 s each on the busy ops daemon).
    // A link that names a PTY (`initialPtyId`) needs the list at once — only the plain terminal entry waits.
    const delay = panelView === 'terminal' && !initialPtyId ? PTY_LIST_DEFER_MS : 0;
    const timer = setTimeout(() => { void (async () => {
      try {
        const [terminalResult, progressResult] = await Promise.all([
          client.listTerminals(ptyTerminalListRequest(includeAllPtyInstances)),
          client.listProgressFrames().catch((error) => {
            debugLog('webterm.pty-list.progress.error', { reason: String(error) });
            return null;
          }),
        ]);
        if (cancelled) return;
        setPtyRows(ptyTerminalRows(terminalResult.terminals));
        setPtyScope(terminalResult.scope);
        setPtyProgress(progressResult ? ptyProgressByTerminal(progressResult.logs) : new Map());
        setPtyListState('idle');
      } catch (error) {
        if (cancelled) return;
        setPtyRows([]);
        setPtyScope(undefined);
        setPtyProgress(new Map());
        setPtyListState('error');
        debugLog('webterm.pty-list.error', { reason: String(error) });
      }
    })(); }, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, includeAllPtyInstances, panelView, initialPtyId]);
  useEffect(() => {
    if (selectedPtyKey !== null && !ptyRows.some((terminal) => ptyRowKey(terminal) === selectedPtyKey)) {
      ptySnapshotRequestRef.current += 1;
      ptyLineageRequestRef.current += 1;
      setSelectedPty(null);
      setPtyLineage({ status: 'unrequested' });
    }
  }, [ptyRows, selectedPtyKey]);
  const requestPtySnapshot = useCallback((terminal: DaemonTerminalSummary, mode: PtyTerminalViewMode): void => {
    const { id } = terminal;
    // Caches are keyed by row, not id: two rows can share an id across roots, and a
    // shared cache slot would show the other universe's screen while this one loads.
    const key = ptyRowKey(terminal);
    const requestId = ++ptySnapshotRequestRef.current;
    if (mode === 'raw') {
      setScrollbackByPty((current) => new Map(current).set(key, { status: 'loading' }));
      void fetchPtyScrollbackDetail(client, terminal).then((result) => {
        if (ptySnapshotRequestRef.current !== requestId || result.id !== id) return;
        setScrollbackByPty((current) => new Map(current).set(key, { status: 'ready', scrollback: result.scrollback }));
      }).catch((error) => {
        if (ptySnapshotRequestRef.current !== requestId) return;
        setScrollbackByPty((current) => new Map(current).set(key, { status: 'error' }));
        debugLog('webterm.pty-list.scrollback.error', { id, reason: String(error) });
      });
      return;
    }
    setFrameByPty((current) => new Map(current).set(key, { status: 'loading' }));
    void fetchPtyFrameDetail(client, terminal).then((result) => {
      if (ptySnapshotRequestRef.current !== requestId || result.id !== id) return;
      setFrameByPty((current) => new Map(current).set(key, {
        status: 'ready', frame: result.frame, frameAt: result.frameAt, frameSource: result.frameSource,
      }));
    }).catch((error) => {
      if (ptySnapshotRequestRef.current !== requestId) return;
      setFrameByPty((current) => new Map(current).set(key, { status: 'error' }));
      debugLog('webterm.pty-list.frame.error', { id, reason: String(error) });
    });
  }, [client]);
  // Preserve the clicked row for details and the live view. Duplicate ids across
  // manifest roots must not silently select a different row.
  const handlePtySelection = useCallback((terminal: DaemonTerminalSummary, direct = false): void => {
    const { id } = terminal;
    if (direct) {
      setLiveDismissed(false);
      setLivePty(terminal);
      onPtySelection?.(terminal);
    }
    // Re-selecting the same ROW is idempotent; a same-id row from another root is
    // a different row and must select.
    if (selectedPtyKey === ptyRowKey(terminal)) return;
    const requestId = ++ptyLineageRequestRef.current;
    setSelectedPty(terminal);
    setPtyLineage({ status: 'loading' });
    requestPtySnapshot(terminal, ptyViewMode);
    void client.fetchTerminalLineage(id).then((lineage) => {
      if (ptyLineageRequestRef.current !== requestId || lineage.key !== id) return;
      setPtyLineage({ status: 'ready', lineage });
    }).catch((error) => {
      if (ptyLineageRequestRef.current !== requestId) return;
      setPtyLineage({ status: 'error' });
      debugLog('webterm.pty-list.lineage.error', { id, reason: String(error) });
    });
  }, [client, onPtySelection, ptyViewMode, requestPtySnapshot, selectedPtyKey]);
  // ⛔⭐ 계약: 주소의 `?pty=` 는 ***「초기값」***이지 «양방향 동기»가 아니다.
  //    이 효과는 «한 번»만 돌고 잠긴다 — 마운트 뒤 뒤로가기/앞으로가기로 그 값이 바뀌어도
  //    다시 해석하지 않는다. 그것은 결손이 아니라 «이 착지의 결정»이다(리뷰 should-fix 2026-08-19):
  //    사람이 목록에서 고른 선택을 URL 변화가 «되돌리는» 것이 더 나쁘기 때문이다.
  //    ⇒ 양방향 동기를 원하면 「사람이 고른 선택 vs 주소가 준 선택」의 우선순위를 «먼저» 정해야 한다.
  useEffect(() => {
    if (initialPtyPickDoneRef.current || ptyListState === 'loading') return;
    initialPtyPickDoneRef.current = true;
    if (!initialPtyId) return;
    // ⛔ 목록 조회가 «실패»했으면 빈 목록을 근거로 판정하지 않는다 — 「없다」와 「못 읽었다」는 다른 값이다.
    if (ptyListState === 'error') {
      setInitialPtyResolution({ kind: 'list-unavailable' });
      setPanelView('pty-list');
      debugLog('webterm.initial-pty-selection', { ptyId: initialPtyId, kind: 'list-unavailable', reason: 'pty-list-error' });
      return;
    }
    const resolution = resolvePtyTerminalId(initialPtyId, ptyRows);
    setInitialPtyResolution(resolution);
    if (resolution.kind !== 'selected') setPanelView('pty-list');
    debugLog('webterm.initial-pty-selection', { ptyId: initialPtyId, kind: resolution.kind, reason: resolution.reason });
    if (resolution.kind === 'selected') {
      handlePtySelection(resolution.terminal);
      setLivePty(resolution.terminal);
    }
  }, [handlePtySelection, initialPtyId, ptyListState, ptyRows]);
  const handlePtyViewMode = useCallback((mode: PtyTerminalViewMode): void => {
    if (mode === ptyViewMode) return;
    setPtyViewMode(mode);
    // The selected row itself — never a lookup by id, which could resolve to a
    // same-id row from a different root and fetch the wrong universe's screen.
    if (selectedPty) requestPtySnapshot(selectedPty, mode);
  }, [ptyViewMode, requestPtySnapshot, selectedPty]);
  const handlePtyRename = useCallback(async (terminal: DaemonTerminalSummary): Promise<void> => {
    const name = window.prompt('새 PTY 이름을 입력하세요.', terminal.nickname ?? '');
    if (name === null) return;
    // 이름 변경은 되돌릴 수 있으므로 별도 확인 없이 진행한다.
    try {
      const result = await client.renameTerminal(terminal.id, name);
      const message = renameOutcomeMessage(result);
      if (result.status === 'success') toast.success(message);
      else toast.error(message);
    } catch (error) {
      toast.error(`PTY 이름 변경 요청에 실패했습니다: ${String(error)}`);
    }
  }, [client]);
  const ptyListModel = useMemo(
    () => ptyTerminalPanelModel(
      includeAllPtyInstances,
      ptyRows,
      ptyScope,
      selectedPtyKey,
      scrollbackByPty,
      ptyViewMode,
      frameByPty,
    ),
    [frameByPty, includeAllPtyInstances, ptyRows, ptyScope, ptyViewMode, scrollbackByPty, selectedPtyKey],
  );
  const ptyLineageModel = useMemo(
    () => ptyTerminalLineageModel(selectedPtyId, ptyLineage),
    [ptyLineage, selectedPtyId],
  );
  // ⛔⭐ 선택이 «화면»을 정한다 (대표 2026-08-17: *"아이디를 선택한 순간 터미널 화면도
  //  바뀌어야 하고 전체 select 가 바뀌어야 합니다"*).
  //  📏 그 전 실물 — 아래 렌더는 배치에 항목이 «하나라도» 있으면 그 배치를 그리고,
  //     선택을 따르는 단일 뷰는 «배치가 빈 경우에만» 살아났다. 그래서 칩을 눌러도
  //     Dock 부제만 바뀌고 화면은 그대로였다.
  //  ⭐ 선택된 터미널이 속한 런으로 좁힌다 — 창분할(#115)은 «그 런 안에서» 그대로 유지된다.
  //  ⛔ 선택이 어느 런에도 없으면 좁힌 결과가 비고, 렌더가 단일 XtermView 로 «떨어진다».
  const terminalPaneLayout = useMemo(
    () => paneLayoutForSelection(
      (livePty !== null || (initialPtyId !== null && !liveDismissed))
        ? paneLayout(panePlan(ptyRows.filter((row) => row.id !== (livePty?.id ?? initialPtyId) && tabIds.includes(row.id))))
        : paneLayout(panePlan(ptyRows)),
      terminalId ?? '',
    ),
    [ptyRows, tabIds, livePty, liveDismissed, initialPtyId, terminalId],
  );
  // ⛔⭐ 첫 화면이 «클라이언트가 지어낸» preview-1 에 갇히지 않게 (대표 2026-08-17).
  //  저장된 선택이 있으면 이 효과는 «아무것도 안 한다»(위 restore 가 ref 를 세운다).
  useEffect(() => {
    if (initialPickDoneRef.current || initialPtyId) return;
    if (ptyListState === 'loading') return;
    // ⛔ 「목록이 비어서 안 골랐다」도 «값으로» 남긴다 — 조용히 빠져나가면
    //   다음 사람이 「자동 선택이 왜 안 돌았나」를 물을 자리가 없다(실측으로 걸렸다).
    if (ptyRows.length === 0) {
      if (!initialPickSkipLoggedRef.current) {
        initialPickSkipLoggedRef.current = true;
        debugLog('webterm.initial-selection', { skipped: true, reason: 'no-terminals', listState: ptyListState });
      }
      return;
    }
    initialPickDoneRef.current = true;
    const picked = initialTerminalSelection({
      storedId: null,
      fallbackId: terminalId,
      terminals: ptyRows,
    });
    debugLog('webterm.initial-selection', { terminalId: picked.terminalId, reason: picked.reason, rowCount: ptyRows.length });
    if (picked.terminalId !== terminalId) setTerminalId(picked.terminalId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyRows, ptyListState]);

  const [foreignActivityTick, setForeignActivityTick] = useState(0);
  const [panelsMinimized, setPanelsMinimized] = useState(false);
  const [chatDockOpen, setChatDockOpen] = useState(true);
  const [recording, setRecording] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  const [tabIntent, setTabIntent] = useState<{ intent: 'next' | 'prev' | number; nonce: number } | null>(null);
  const handleTabIntent = useCallback((intent: 'next' | 'prev' | number): void => {
    setTabIntent({ intent, nonce: Date.now() });
  }, []);
  const dockRef = useRef<TerminalChatDockHandle>(null);
  // Phase 2 (webterm voice control · PLAN v1.1) — TerminalPanel is
  // voice owner. Single useVoiceController instance · 3 mic entry
  // points share it · activeMicSource decides STT-final routing:
  //   'dock'     → :agent auto-send via TerminalChatDock.submitVoiceTranscript
  //   'controls' → registered terminal input sender (TUI Alt+V dictation 흡수)
  // ref pattern (latestRouteRef) keeps the long-lived voice callback
  // pointing at the latest closure (mirrors ChatLayout `handleSubmitRef`).
  const [activeMicSource, setActiveMicSource] = useState<'none' | 'dock' | 'controls'>('none');
  const activeMicSourceRef = useRef(activeMicSource);
  activeMicSourceRef.current = activeMicSource;
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;

  const handleVoiceTranscript = useCallback((text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const source = activeMicSourceRef.current;
    if (source === 'controls') {
      // STT → xterm stdin — append a trailing space so quick repeated
      // dictations don't collide ('ls' + 'la' becoming 'lsla'). The
      // user still presses Enter manually, mirroring claude-code style
      // dictation: voice types, human commits.
      const tid = terminalIdRef.current;
      if (!tid) return;
      if (!sendToTerminal(tid, trimmed + ' ')) {
        debugLog('webterm.voice.stdin-inject-failed', { len: trimmed.length, terminalId: tid, reason: 'no-sender' });
        toast.error('터미널 입력 전송 실패 — 터미널 연결을 확인하고 다시 말해 주세요.');
        return;
      }
      debugLog('webterm.voice.stdin-inject', { len: trimmed.length, terminalId: tid });
    } else if (source === 'dock') {
      dockRef.current?.submitVoiceTranscript(trimmed);
    } else {
      debugLog('webterm.voice.transcript-no-source', { len: trimmed.length });
    }
  }, []);

  const voiceWsUrl = client.voiceWsUrl();
  const voice = useVoiceController({
    wsUrl: voiceWsUrl,
    ...(config.token ? { token: config.token } : {}),
    onTranscript: handleVoiceTranscript,
  });

  // Disable mic UI when daemon URL not configured OR origin can't host
  // mic capture (HTTP CGNAT etc — banner takes care of guidance).
  const secureCtx = useMemo(() => checkSecureContext(), []);
  const voiceConfigured = Boolean(config.baseUrl);
  const voiceDisabled = !voiceConfigured || !secureCtx.isSecure;

  // Toggle helpers — set activeMicSource *before* triggering the
  // controller so the next STT final routes to the right place.
  // Switching from one source to the other while active stops first
  // (voice.toggle internally does start/stop based on .active).
  const toggleVoiceFromDock = useCallback((): void => {
    if (voice.active && activeMicSource === 'dock') {
      setActiveMicSource('none');
      void voice.toggle();
    } else {
      setActiveMicSource('dock');
      if (!voice.active) void voice.toggle();
    }
  }, [voice, activeMicSource]);

  const toggleVoiceFromControls = useCallback((): void => {
    if (voice.active && activeMicSource === 'controls') {
      setActiveMicSource('none');
      void voice.toggle();
    } else {
      setActiveMicSource('controls');
      if (!voice.active) void voice.toggle();
    }
  }, [voice, activeMicSource]);

  // Panel-level voice prop builders — same shape for dock + controls
  // (mirrors ChatInputVoiceProps). Memoized so child re-renders only
  // when actual voice state changes.
  const dockVoiceProp = useMemo(() => ({
    active: voice.active && activeMicSource === 'dock',
    phase: voice.phase,
    dotColor: VOICE_DOT_COLOR[voice.phase],
    phaseLabel: VOICE_PHASE_LABEL[voice.phase],
    disabled: voiceDisabled,
    onToggle: toggleVoiceFromDock,
  }), [voice.active, voice.phase, activeMicSource, voiceDisabled, toggleVoiceFromDock]);

  const controlsVoiceProp = useMemo(() => ({
    active: voice.active && activeMicSource === 'controls',
    phase: voice.phase,
    dotColor: VOICE_DOT_COLOR[voice.phase],
    phaseLabel: VOICE_PHASE_LABEL[voice.phase],
    disabled: voiceDisabled,
    onToggle: toggleVoiceFromControls,
  }), [voice.active, voice.phase, activeMicSource, voiceDisabled, toggleVoiceFromControls]);

  // WV-6 (BACKLOG-webterm §2.4 · 2026-05-07) — Cmd/Ctrl+Shift+M push-to-toggle
  // mirror chat ChatLayout PP-V-1 (FU PR #1891). Mac Cmd · Win/Linux Ctrl 둘
  // 다 받음. webterm 안에서는 dock 이 자연 활성 surface (chat 과 같은 :agent
  // 패턴) — chord 발화 시 dock 을 자동 open + activeMicSource='dock' 으로
  // toggleVoiceFromDock 호출. modifier 동반이라 xterm input · ChatInput
  // textarea 안에서도 충돌 없음 ("M" 단독 입력 보존).
  // ref 패턴 — toggleVoiceFromDock 가 매 렌더 재생성되므로 long-lived
  // listener 가 항상 latest closure 를 호출하도록 ref 미러.
  const toggleVoiceFromDockRef = useRef(toggleVoiceFromDock);
  toggleVoiceFromDockRef.current = toggleVoiceFromDock;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key.toLowerCase() !== 'm') return;
      if (!ev.shiftKey) return;
      if (!ev.metaKey && !ev.ctrlKey) return;
      // Browser default — Chrome/Safari Cmd+Shift+M opens window menu
      // on macOS; we own the chord here for mic toggle. Same wire as
      // chat ChatLayout — both surfaces respect 같은 chord.
      ev.preventDefault();
      debugLog('webterm.voice.shortcut.toggle');
      setChatDockOpen(true);
      void toggleVoiceFromDockRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(ACTIVE_KEY);
    if (stored && stored.length > 0 && (!initialPtyId || stored !== initialPtyId)) {
      setTerminalId(stored);
      initialPickDoneRef.current = true; // 사람이 고른 것이 있다 — 자동 선택은 «안 돈다»
    }
    const minStored = window.localStorage.getItem(MINIMIZED_KEY);
    if (minStored === '1') setPanelsMinimized(true);
    const dockStored = window.localStorage.getItem(CHAT_DOCK_KEY);
    if (dockStored === '0') setChatDockOpen(false);
  }, []);

  const onActiveChange = (next: string): void => {
    setTerminalId(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ACTIVE_KEY, next);
    }
  };

  const handleAttached = useCallback(async (entries: AttachmentMeta[]): Promise<void> => {
    if (!sessionId || !terminalId || entries.length === 0) return;
    const paths = entries.map((e) => e.path).filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (paths.length === 0) {
      debugLog('webterm.attach.no-path', { count: entries.length });
      return;
    }
    const result = await injectAttachmentPathsToTerminal({ terminalId, paths });
    if (result.injected) {
      const summary = paths.length === 1
        ? '터미널에 path 첨부됨'
        : `${paths.length} paths 터미널에 첨부됨`;
      const suffix = result.copied ? ' · clipboard 도 복사' : '';
      toast.success(summary + suffix);
    } else {
      toast.error('터미널 inject 실패 — 직접 paste 해주세요');
    }
  }, [client, sessionId, terminalId]);

  const toggleMinimized = (): void => {
    setPanelsMinimized((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(MINIMIZED_KEY, next ? '1' : '0');
      }
      return next;
    });
  };

  const toggleChatDock = (): void => {
    // 2026-05-07 사용자 dogfood feedback — panelsMinimized 가 true 일
    // 때는 dock 자체가 unmount 라 토글이 silent 였음 ("토글 했는데 변화
    // 없음"). minimized 면 같이 expand 시켜 사용자 의도 (chat dock
    // 보이게) 가 즉시 가시화되도록.
    if (panelsMinimized) {
      setPanelsMinimized(false);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(MINIMIZED_KEY, '0');
      }
      // dock open 도 같이 보장 — 사용자가 "보이게" 의도한 것이므로.
      setChatDockOpen(true);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(CHAT_DOCK_KEY, '1');
      }
      return;
    }
    setChatDockOpen((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(CHAT_DOCK_KEY, next ? '1' : '0');
        // Force the xterm fit() in the next frame so the cell grid
        // catches up with the new container box. ResizeObserver fires
        // async after layout, which adds a 1-2 frame perceptual lag
        // when toggling the dock. Synthesizing a `resize` event here
        // makes the resize-controller's window-listener trigger
        // synchronously alongside the toggle.
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event('resize'));
        });
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <TerminalTabs
        activeId={terminalId}
        onActiveChange={(id) => { onActiveChange(id); setLivePty(null); setLiveDismissed(true); setPanelView('terminal'); }}
        onInitialTerminalState={handleInitialTerminalState}
        minimized={panelsMinimized}
        onToggleMinimize={toggleMinimized}
        recording={recording}
        peerCount={peerCount}
        chatDockOpen={chatDockOpen}
        onToggleChatDock={toggleChatDock}
        tabIntent={tabIntent}
        onTabsChange={setTabIds}
        suspendInitialSpawn={Boolean(initialPtyId) && !liveDismissed}
      />
      {initialNotice.fallbackBanner && (
        <p className="border-b border-amber-700/50 bg-amber-950/30 px-3 py-1 text-xs text-amber-200" role="status">
          {initialNotice.fallbackBanner}
        </p>
      )}
      {/* Phase 2 — single banner above the toolbar covers all 3 mic
          entry points (dock header / ChatInput / TerminalControls). */}
      <TailscaleSecurityBanner />
      {/* Subtabs keep the existing terminal and TUI observation surfaces
          while adding the daemon's PTY registry as a read-only list. */}
      <div className={panelsMinimized ? 'hidden' : 'flex items-center gap-2 border-b border-zinc-800 px-3 py-1'}>
        <button
          type="button"
          aria-pressed={panelState.buttons[0].selected}
          onClick={() => { setLivePty(null); setLiveDismissed(true); selectPanelView('terminal'); }}
          className={`rounded px-2 py-1 text-xs ${panelState.buttons[0].selected ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
        >
          터미널
        </button>
        <button
          type="button"
          aria-pressed={panelState.buttons[1].selected}
          onClick={() => { setLivePty(null); setLiveDismissed(true); selectPanelView('observe'); }}
          className={`rounded px-2 py-1 text-xs ${panelState.buttons[1].selected ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
          title="자기신고하는 elanous 대시보드 TUI 를 라이브로 관측(읽기 전용)"
        >
          🖥 TUI 관측 {panelState.buttons[1].selected ? 'ON' : 'OFF'}
        </button>
        <button
          type="button"
          aria-pressed={panelState.buttons[2].selected}
          onClick={() => { setLivePty(null); setLiveDismissed(true); selectPanelView('pty-list'); }}
          className={`rounded px-2 py-1 text-xs ${panelState.buttons[2].selected ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
        >
          PTY 목록
        </button>
        <button
          type="button"
          aria-pressed={wall !== null}
          onClick={() => setWall((w) => (w === null ? [] : null))}
          className={`rounded px-2 py-1 text-xs ${wall !== null ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
          data-elanous-action="pty-wall"
        >
          ▦ 나란히
        </button>
      </div>
      {terminalId ? <div className={panelsMinimized || panelView !== 'terminal' || livePty !== null || (initialPtyId && !liveDismissed) ? 'hidden' : 'contents'}>
        <MultiDeviceIndicator
          foreignActivityTick={foreignActivityTick}
          onPeerCountChange={setPeerCount}
        />
        <TerminalControls
          terminalId={terminalId}
          onClear={() => setClearRequests((current) => ({ ...current, [terminalId]: (current[terminalId] ?? 0) + 1 }))}
          onRecordingChange={setRecording}
          onAttached={handleAttached}
          voice={controlsVoiceProp}
        />
        {isCoarsePointer && <ModifierBar terminalId={terminalId} />}
        <TerminalDropZone onAttached={handleAttached} />
      </div> : null}
      <div className="relative flex-1 min-h-0">
        {wall !== null && (
          <div className={wallStage ? 'fixed inset-0 z-50' : 'absolute inset-0 z-20'} data-pty-wall-stage={wallStage ? '1' : undefined}>
            <PtyWall rows={ptyRows} client={client} initial={wall} stage={wallStage} onClose={() => { setWall(null); const p = new URLSearchParams(window.location.search); p.delete('wall'); window.history.replaceState(null, '', `${window.location.pathname}${p.toString() ? `?${p}` : ''}`); }} />
          </div>
        )}
        <TerminalPaneLayout
          layout={terminalPaneLayout}
          sessionId={sessionId}
          terminalIds={tabIds.filter((id) => id !== livePty?.id && (liveDismissed || id !== initialPtyId))}
          activeId={terminalId && (terminalId === livePty?.id || (!liveDismissed && terminalId === initialPtyId)) ? null : terminalId}
          clearRequests={clearRequests}
          visible={terminalId !== null && panelView === 'terminal' && livePty === null && (!initialPtyId || liveDismissed)}
          onForeignInputActivity={() => setForeignActivityTick((n) => n + 1)}
        />
        {livePty && <PtyLiveView key={ptyRowKey(livePty)} terminal={livePty} client={client} onClose={() => { setLiveDismissed(true); setLivePty(null); selectPanelView('terminal'); }} />}
        {!livePty && panelView === 'terminal' && (!terminalId || (initialPtyId && !liveDismissed)) ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
            {/* ⛔ 목록 조회가 «실패»했는데 주소가 PTY 를 가리키고 있었다면, 그 사실이 여기서도 보여야 한다.
                종전엔 이 갈래가 일반 안내만 내서 ***「못 읽었다」가 사람에게 «전혀» 닿지 않았다***
                (리뷰 must-fix 2026-08-19 — 그리고 그것이 내 첫 회귀 시험을 vacuous 하게 만들었다). */}
            {initialPtyResolution?.kind === 'list-unavailable' && (
              <p className="text-xs text-rose-500" aria-label="URL PTY 선택 상태">
                PTY 목록을 읽지 못해 주소의 PTY {initialPtyId}를 확인할 수 없습니다. 목록이 비었다는 뜻이 «아닙니다».
              </p>
            )}
            <span>{initialNotice.placeholder}</span>
          </div>
        ) : livePty ? null : panelView === 'pty-list' ? (
          <div className="h-full overflow-auto p-3" aria-label="데몬 PTY 목록">
            <label className="mb-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ptyListModel.includeAll}
                onChange={(event) => setIncludeAllPtyInstances(event.target.checked)}
              />
              다른 인스턴스도 보기
            </label>
            {ptyListModel.scopeSummary && (
              <p className="mb-3 text-xs text-muted-foreground" aria-label="PTY 목록 범위 요약">
                {ptyListModel.scopeSummary}
              </p>
            )}
            {initialPtyResolution?.kind === 'ambiguous' && (
              <p className="mb-3 text-xs text-amber-500" role="status" aria-label="URL PTY 선택 상태">
                주소의 PTY {initialPtyId}가 {initialPtyResolution.candidates.length}개 행과 맞아 선택하지 않았습니다.
              </p>
            )}
            {initialPtyResolution?.kind === 'list-unavailable' && (
              <p className="mb-3 text-xs text-rose-500" role="status" aria-label="URL PTY 선택 상태">
                PTY 목록을 읽지 못해 주소의 PTY {initialPtyId}를 확인할 수 없습니다. 목록이 비었다는 뜻이 «아닙니다».
              </p>
            )}
            {initialPtyResolution?.kind === 'not-found' && (
              <p className="mb-3 text-xs text-rose-500" role="status" aria-label="URL PTY 선택 상태">
                주소의 PTY {initialPtyId}를 찾지 못했습니다 ({initialPtyResolution.reason}).
              </p>
            )}
            {ptyListModel.rows.find((item) => item.view)?.view?.visible && (
              <div className="mb-3 flex gap-2" aria-label="PTY 화면 보기">
                {ptyListModel.rows.find((item) => item.view)!.view!.modes.map((mode) => (
                  <button
                    key={mode.mode}
                    type="button"
                    aria-pressed={mode.selected}
                    onClick={() => handlePtyViewMode(mode.mode)}
                    className={`rounded px-2 py-1 text-xs ${mode.selected ? 'bg-emerald-700 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            )}
            {ptyListState === 'loading' ? (
              <p className="text-sm text-muted-foreground">PTY 목록을 불러오는 중…</p>
            ) : ptyListState === 'error' ? (
              <p className="text-sm text-rose-500">PTY 목록을 불러오지 못했습니다.</p>
            ) : ptyRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">데몬이 아는 PTY가 없습니다.</p>
            ) : (
              <ul className="space-y-2">
                {ptyListModel.rows.map((item) => {
                  const { terminal } = item;
                  const summary = ptyTerminalRowSummary(terminal);
                  const activity = ptyProgress.get(terminal.id);
                  return (
                    <li key={ptyRowKey(terminal)} className={`rounded border p-2 text-sm ${item.selected ? 'border-emerald-500' : 'border-border'}`}>
                      <button
                        type="button"
                        className="w-full text-left"
                        aria-pressed={item.selected}
                        onClick={() => handlePtySelection(terminal, true)}
                      >
                        <p className="font-medium">{summary.title}</p>
                        {summary.details.map((detail, index) => (
                          <p
                            key={`${terminal.id}-${detail}`}
                            className={index === 0
                              ? 'font-mono text-xs text-muted-foreground'
                              : 'text-xs text-muted-foreground'}
                          >
                            {detail}
                          </p>
                        ))}
                        {activity && (
                          <p className="mt-1 text-xs text-muted-foreground" aria-label={`현재 활동: ${activity.status === 'complete' ? '완료' : '진행 중'}`}>
                            {activity.status === 'complete' ? '완료' : '진행 중'}: {activity.line}
                            {activity.hasMissingFrames ? ' · 일부 진행 프레임 누락' : ''}
                          </p>
                        )}
                      </button>
                      <button
                        type="button"
                        className="mt-2 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-700"
                        onClick={() => { void handlePtyRename(terminal); }}
                      >
                        이름 바꾸기
                      </button>
                      {item.selected && ptyLineageModel && (
                        <section className="mt-2 rounded bg-zinc-900 p-2 text-xs" aria-label="선택 PTY 계보">
                          <p className="font-medium">계보</p>
                          {ptyLineageModel.kind === 'loading' && <p className="text-muted-foreground">계보를 불러오는 중…</p>}
                          {ptyLineageModel.kind === 'error' && <p className="text-rose-400">계보를 불러오지 못했습니다.</p>}
                          {ptyLineageModel.kind === 'empty' && <p className="text-muted-foreground">연결된 다른 화면이 없습니다.</p>}
                          {ptyLineageModel.unreadablePayloadsSummary && (
                            <p className="text-muted-foreground">{ptyLineageModel.unreadablePayloadsSummary}</p>
                          )}
                          {ptyLineageModel.groups.map((group) => (
                            <div key={`${group.joinedBy}-${group.key}`} className="mt-2">
                              <p className="font-mono">묶음: {group.joinedBy} · {group.key}</p>
                              <ul className="mt-1 space-y-1">
                                {group.rows.map((lineageRow) => (
                                  <li
                                    key={lineageRow.ptyId}
                                    className={lineageRow.selected ? 'rounded bg-emerald-900 px-1 text-emerald-100' : ''}
                                  >
                                    {lineageRow.selected ? '현재 선택 · ' : ''}{lineageRow.ptyId} · {lineageRow.kind} · {lineageRow.instance} · {ptyTerminalProcessOutputStatusLabel(lineageRow.alive, lineageRow.closed)} · 시작 {ptyTerminalStartedAtLabel(lineageRow.startedAt)}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </section>
                      )}
                      {item.view && (
                        <div className="mt-2">
                          {item.view.display.frameInfo && (
                            <p className="mb-1 font-mono text-xs text-muted-foreground" aria-label="렌더 화면 정보">
                              {item.view.display.frameInfo}
                            </p>
                          )}
                          {item.view.display.frameMetadata && (
                            <p className="mb-1 text-xs text-muted-foreground" aria-label="렌더 프레임 메타데이터">
                              관측: {item.view.display.frameMetadata.frameAt} · 출처: {item.view.display.frameMetadata.frameSource}
                            </p>
                          )}
                          <pre className={`whitespace-pre-wrap rounded bg-zinc-950 p-2 text-xs ${item.view.display.kind === 'error' ? 'text-rose-400' : 'text-zinc-100'}`}>
                            {item.view.display.text}
                          </pre>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : panelView === 'observe' ? (
          // key={sessionId} → remount on session change so no previous-session
          // frame can flash before state resets (structural isolation · review).
          <TuiMirrorView key={sessionId} sessionId={sessionId} />
        ) : null}
      </div>
      {terminalId && !panelsMinimized && panelView === 'terminal' && !livePty && (!initialPtyId || liveDismissed) && (
        <TerminalChatDock
          ref={dockRef}
          terminalId={terminalId}
          open={chatDockOpen}
          onTabIntent={handleTabIntent}
          voice={dockVoiceProp}
        />
      )}
    </div>
  );
}
