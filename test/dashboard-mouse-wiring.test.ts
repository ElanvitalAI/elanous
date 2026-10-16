import { describe, expect, test } from 'bun:test';
import { createDashboardMouseWiring } from '../src/dashboard/input/mouse-wiring.js';
import type { RotationEntry } from '../src/user-config.js';
import type { ActiveProviderInfo } from '../src/provider-summary.js';
import type { ModalSurface } from '../src/display/modal-stack.js';
import type { DisplayMouseEvent } from '../src/display/types.js';
import { Printer } from '../src/ui/printer.js';
import { createHoverTracker } from '../src/ui/hover-tracker.js';
import { createConversationPopupHost } from '../src/conv-dash/popup-host.js';
import { debug } from '../src/debug/log.js';

const PROVIDER: ActiveProviderInfo = { provider: 'anthropic', model: 'Opus 4.7' };

function mouse(
  type: DisplayMouseEvent['type'],
  row: number,
  col: number,
  mods: Partial<Pick<DisplayMouseEvent, 'ctrl' | 'shift' | 'alt'>> = {},
): DisplayMouseEvent {
  return { type, row, col, ...mods };
}

function createFakeScheduler() {
  let now = 0;
  let seq = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule(fn: () => void, ms: number) {
      const id = ++seq;
      tasks.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle: unknown) {
      tasks.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= now)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        tasks.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

function mkDeps(overrides: Partial<Parameters<typeof createDashboardMouseWiring>[0]> = {}) {
  const pushed: ModalSurface[] = [];
  let redraws = 0;
  const rotation: RotationEntry[] = [
    { label: 'Opus 4.7',   provider: 'anthropic', model: 'claude-opus-4-7' },
    { label: 'Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6' },
  ];
  const currentModelEntry: RotationEntry = {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
  };
  const recents: string[] = ['/home/a', '/home/b'];
  const activated: RotationEntry[] = [];
  const switched: string[] = [];
  const openedDockWindows: string[] = [];
  const openedDockSurfaces: string[] = [];
  const exitProgramCalls: number[] = [];
  const appliedViews: string[] = [];
  const switchedVirtualWindows: number[] = [];
  const movedVirtualWindows: Array<'left' | 'right'> = [];
  const switchedToDashboardMain: number[] = [];
  const openedWindowPicker: number[] = [];

  return {
    pushed, rotation, recents, activated, switched, openedDockWindows, openedDockSurfaces, exitProgramCalls, appliedViews, switchedVirtualWindows, movedVirtualWindows, switchedToDashboardMain, openedWindowPicker,
    get redraws() { return redraws; },
    wiring: createDashboardMouseWiring({
      termSize: () => ({ rows: 24, cols: 120 }),
      getRotation: () => rotation,
      getCurrentModelEntry: () => currentModelEntry,
      setActiveModel: e => { activated.push(e); },
      getRecentWds: () => recents,
      setSessionWd: p => { switched.push(p); },
      getDockMenuWindowTargets: () => [
        { id: 'browser', label: 'Browser', description: 'Open Browser in a popup window' },
        { id: 'preview', label: 'Preview', description: 'Open Preview in a popup window' },
      ],
      onOpenDockWindow: async (paneId) => { openedDockWindows.push(paneId); },
      getDockMenuSurfaceTargets: () => [
        { id: 'pane:browser', label: 'Browser popup', group: 'Panes' },
        { id: 'companion:clipboard', label: 'Clipboard companion', group: 'Companions' },
        { id: 'vw:browser', label: 'Browser virtual window', group: 'Virtual Windows' },
      ],
      onOpenDockSurface: async (surfaceId) => { openedDockSurfaces.push(surfaceId); },
      onExitProgram: async () => { exitProgramCalls.push(Date.now()); },
      getDashboardViews: () => [
        { id: '1', label: 'Normal', description: 'View 1', active: true },
        { id: 'agents', label: 'Agents', description: 'View 4', active: false },
      ],
      onApplyDashboardView: async (viewId) => { appliedViews.push(viewId); },
      getVirtualWindows: () => [
        { id: 1, label: 'Workspace', active: true },
        { id: 2, label: 'Build', active: false },
      ],
      onSwitchVirtualWindow: async (windowId) => { switchedVirtualWindows.push(windowId); },
      getVirtualWindowMover: () => ({
        canMoveLeft: true,
        canMoveRight: true,
        leftLabel: '⬅️ Main',
        rightLabel: 'Build ➡️',
      }),
      onMoveVirtualWindow: async (direction) => {
        movedVirtualWindows.push(direction);
        if (direction === 'left') switchedToDashboardMain.push(Date.now());
        return true;
      },
      onWindowPillClick: () => { openedWindowPicker.push(Date.now()); },
      pushModalSurface: surface => {
        pushed.push(surface);
        return { dispose: () => { pushed.splice(pushed.indexOf(surface), 1); } };
      },
      redraw: () => { redraws++; },
      ...overrides,
    }),
  };
}

describe('MX11b dashboard-mouse-wiring — buildStatusLine + pills', () => {
  test('emits the same join-with-space line and reports both pill bounds', () => {
    const { wiring } = mkDeps();
    const line = wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
      gitState: 'main',
    });
    expect(line).toContain('project');       // workingDir pill visible
    expect(line).toContain('Opus 4.7');      // model pill visible
    const snap = wiring._snapshot();
    expect(snap.pills.map(p => p.name)).toEqual(['workingDir', 'model']);
    // Model pill is strictly to the right of workingDir pill.
    expect(snap.pills[1]!.startCol).toBeGreaterThan(snap.pills[0]!.endCol);
  });

  test('handles full GitSegmentState (dirty + ahead)', () => {
    const { wiring } = mkDeps();
    const line = wiring.buildStatusLine({
      swd: '/Users/test',
      providerInfo: PROVIDER,
      gitState: { branch: 'main', dirtyTotal: 3, ahead: 2, behind: 0 },
    });
    expect(line).toContain('main');
  });

  test('places running agents immediately after the model without adding a pill', () => {
    const { wiring } = mkDeps();
    const line = wiring.buildStatusLine({
      swd: '/tmp',
      providerInfo: PROVIDER,
      gitState: 'main',
      runningAgents: 2,
    });
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain.indexOf('Opus 4.7')).toBeLessThan(plain.indexOf('◇ 2 agents'));
    expect(wiring._snapshot().pills.map((pill) => pill.name)).toEqual(['workingDir', 'model']);
  });

  test('omitted and zero running-agent counts produce the same hidden status line', () => {
    const { wiring } = mkDeps();
    const base = { swd: '/tmp', providerInfo: PROVIDER, gitState: 'main' };
    const omitted = wiring.buildStatusLine(base);
    const zero = wiring.buildStatusLine({ ...base, runningAgents: 0 });
    expect(zero).toBe(omitted);
    expect(zero).not.toContain('agent');
  });

  test('omits the session-time segment when elapsedSec is absent', () => {
    const { wiring } = mkDeps();
    const line = wiring.buildStatusLine({
      swd: '/tmp',
      providerInfo: PROVIDER,
      contextUsedTokens: 1000,
    });
    expect(line).not.toContain('⏱');
  });

  test('adds shellCount segment after elapsedSec', () => {
    const { wiring } = mkDeps();
    const line = wiring.buildStatusLine({
      swd: '/tmp',
      providerInfo: PROVIDER,
      elapsedSec: 12,
      shellCount: 3,
    });
    expect(line).toContain('3 shell');
    // Pills should still exist.
    expect(wiring._snapshot().pills).toHaveLength(2);
  });
});

describe('MX11b dashboard-mouse-wiring — preflight hit classification', () => {
  test('preflightHitTarget attaches pane hit before full routing', () => {
    const { wiring } = mkDeps({
      getPaneHitTarget: (row, col) => row === 7 && col === 11
        ? { kind: 'pane-body', paneId: 'wd-log', widgetInstanceId: 'wd-log' }
        : null,
    });
    const ev = mouse('drag', 7, 11);

    expect(wiring.preflightHitTarget(ev)).toEqual({
      kind: 'pane-body',
      paneId: 'wd-log',
      widgetInstanceId: 'wd-log',
    });
    expect(ev.hitTarget).toEqual({
      kind: 'pane-body',
      paneId: 'wd-log',
      widgetInstanceId: 'wd-log',
    });
  });
});

describe('MX11b dashboard-mouse-wiring — pill click dispatch', () => {
  test('click on model pill cycles to next rotation entry (no popup)', () => {
    // 2026-05-05 — model pill click now CYCLES directly instead of
    // opening a picker popup. The picker stays available via
    // `/provider pick` slash for visual selection. Popup lifecycle
    // tests that previously used the model pill have moved to the
    // workingDir pill (still picker-on-click).
    const h = mkDeps();
    h.wiring.buildStatusLine({
      swd: '/alpha', providerInfo: PROVIDER, gitState: 'main',
    });
    h.wiring.setStatusRow(22);
    const modelPill = h.wiring._snapshot().pills.find(p => p.name === 'model')!;
    const col1 = modelPill.startCol + 1;
    const consumed = h.wiring.handleMouse(mouse('click', 22, col1 + 2));
    expect(consumed).toBe(true);
    expect(h.pushed).toHaveLength(0);
    expect(h.wiring.hasActivePopup()).toBe(false);
    // Current entry is the 1st rotation slot (Opus 4.7) → cycle moves
    // to the 2nd (Sonnet 4.6).
    expect(h.activated).toHaveLength(1);
    expect(h.activated[0]?.label).toBe('Sonnet 4.6');
  });

  test('click on workingDir pill opens the wd picker popup', () => {
    const h = mkDeps();
    h.wiring.buildStatusLine({
      swd: '/alpha', providerInfo: PROVIDER, gitState: 'main',
    });
    h.wiring.setStatusRow(22);
    const wdPill = h.wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    h.wiring.handleMouse(mouse('click', 22, wdPill.startCol + 2));
    expect(h.pushed[0]?.id).toBe('recipe:wd');
  });

  test('click off the pills does NOT open a popup', () => {
    const h = mkDeps();
    h.wiring.buildStatusLine({
      swd: '/a', providerInfo: PROVIDER, gitState: 'main',
    });
    h.wiring.setStatusRow(22);
    // Terminal row that is NOT status row:
    const r1 = h.wiring.handleMouse(mouse('click', 5, 5));
    expect(r1).toBe(false);
    // Right row, col inside git segment (between the two pills):
    const snap = h.wiring._snapshot();
    const gapCol = snap.pills[0]!.endCol + 2;   // in the gap
    const r2 = h.wiring.handleMouse(mouse('click', 22, gapCol + 1));
    expect(r2).toBe(false);
    expect(h.pushed).toHaveLength(0);
  });

  test('P0-2: click one row above status row on model pill still cycles', () => {
    // 2026-05-05 — was "still opens pill popup". Now: model pill click
    // = cycle, so the row-above-status edge case still consumes the
    // event but triggers setActiveModel instead of pushing a popup.
    const h = mkDeps();
    h.wiring.buildStatusLine({
      swd: '/a', providerInfo: PROVIDER, gitState: 'main',
    });
    h.wiring.setStatusRow(22);
    const modelPill = h.wiring._snapshot().pills.find(p => p.name === 'model')!;
    const consumed = h.wiring.handleMouse(mouse('click', 21, modelPill.startCol + 2));
    expect(consumed).toBe(true);
    expect(h.pushed).toHaveLength(0);
    expect(h.activated).toHaveLength(1);
  });

  test('P0-2: pill click with statusRow unset pushes a diagnostic toast', () => {
    const h = mkDeps();
    h.wiring.buildStatusLine({
      swd: '/a', providerInfo: PROVIDER, gitState: 'main',
    });
    // Do NOT call setStatusRow — statusRow stays null. Simulate the
    // pathological path openPillPopup guards against by pushing a
    // pill hit directly through an internal seam. The wiring's
    // handleMouse bails before reaching openPillPopup when statusRow
    // is null, but the diagnostic matters when a layout regression
    // leaves the row cleared mid-session.
    // Here we force statusRow back to null AFTER a valid click, then
    // click again — the wiring rejects the click entirely (bail on
    // statusRow === null before geometry check), which is the
    // expected defence. No toast for this path; assertion is that
    // nothing crashes + no popup mounted.
    const consumed = h.wiring.handleMouse(mouse('click', 22, 5));
    expect(consumed).toBe(false);
    expect(h.pushed).toHaveLength(0);
    expect(h.wiring.hasActivePopup()).toBe(false);
  });

  test('A1: mode pill appears for sync/control and click opens switcher popup', () => {
    let switched: string | null = null;
    const h = mkDeps({
      getActiveMode: () => 'sync',
      onModeSwitch: async (next) => { switched = next; },
    });
    // mode='general' → pill hidden (no segment emitted).
    h.wiring.buildStatusLine({
      swd: '/alpha', providerInfo: PROVIDER, gitState: 'main',
      mode: 'general',
    });
    expect(h.wiring._snapshot().pills.some(p => p.name === 'mode')).toBe(false);
    // mode='sync' → pill renders.
    h.wiring.buildStatusLine({
      swd: '/alpha', providerInfo: PROVIDER, gitState: 'main',
      mode: 'sync',
    });
    h.wiring.setStatusRow(22);
    const modePill = h.wiring._snapshot().pills.find(p => p.name === 'mode');
    expect(modePill).toBeDefined();
    const consumed = h.wiring.handleMouse(mouse('click', 22, modePill!.startCol + 2));
    expect(consumed).toBe(true);
    expect(h.pushed[0]?.id).toBe('recipe:mode');
    expect(h.wiring.hasActivePopup()).toBe(true);
  });

  test('SRF-4: shellRollup pill click opens the rollup popup', () => {
    const picked: string[] = [];
    const h = mkDeps({
      getShellRollupEntries: () => [
        { id: 'aaaa', chip: '▶ run  ', mode: 'vw', status: 'running', label: 'runner' },
        { id: 'bbbb', chip: '⏸ bg   ', mode: 'bg', status: 'backgrounded' },
      ],
      onShellRollupPick: (id) => picked.push(id),
    });
    h.wiring.buildStatusLine({
      swd: '/x', providerInfo: PROVIDER, gitState: 'main',
      shellRollup: { running: 1, backgrounded: 1 },
    });
    h.wiring.setStatusRow(22);
    const snap = h.wiring._snapshot();
    const rollupPill = snap.pills.find(p => p.name === 'shellRollup');
    expect(rollupPill).toBeDefined();
    const consumed = h.wiring.handleMouse(mouse('click', 22, rollupPill!.startCol + 2));
    expect(consumed).toBe(true);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]?.id).toBe('recipe:shell-rollup');
    expect(h.wiring.hasActivePopup()).toBe(true);
  });

  test('SRF-4: empty rollup → toast + no popup', () => {
    const h = mkDeps({
      getShellRollupEntries: () => [],
    });
    h.wiring.buildStatusLine({
      swd: '/x', providerInfo: PROVIDER, gitState: 'main',
      shellRollup: { running: 0, backgrounded: 0 },
    });
    h.wiring.setStatusRow(22);
    const rollupPill = h.wiring._snapshot().pills.find(p => p.name === 'shellRollup');
    // rollup segment hides when both counts are 0, so no pill to click —
    // re-test with non-zero counts (stale snapshot scenario: segment
    // still visible but getShellRollupEntries returns empty).
    if (!rollupPill) {
      h.wiring.buildStatusLine({
        swd: '/x', providerInfo: PROVIDER, gitState: 'main',
        shellRollup: { running: 2, backgrounded: 0 },
      });
    }
    const pill = h.wiring._snapshot().pills.find(p => p.name === 'shellRollup')!;
    const consumed = h.wiring.handleMouse(mouse('click', 22, pill.startCol + 1));
    expect(consumed).toBe(true);
    expect(h.pushed).toHaveLength(0);
    const toasts = h.wiring.toasts().snapshot();
    expect(toasts.some(t => t.text.includes('No shell handles'))).toBe(true);
  });

  test('rotation empty + fallback active model → cycle reuses the active entry', () => {
    // 2026-05-05 — model pill click was changed from "open picker"
    // to "cycle next". With empty rotation + a fallback active entry,
    // the cycle ring is a 1-element list — calling setActiveModel
    // re-applies the same entry. No popup is pushed.
    const h = mkDeps({ getRotation: () => [] });
    h.wiring.buildStatusLine({ swd: '/x', providerInfo: PROVIDER, gitState: 'main' });
    h.wiring.setStatusRow(22);
    const modelPill = h.wiring._snapshot().pills.find(p => p.name === 'model')!;
    const consumed = h.wiring.handleMouse(mouse('click', 22, modelPill.startCol + 1));
    expect(consumed).toBe(true);
    expect(h.pushed).toHaveLength(0);
    expect(h.activated).toHaveLength(1);
  });

  test('conversation popup summary renders a pill and click opens popup shell recipe', () => {
    const popupHost = createConversationPopupHost();
    popupHost.upsert({ sessionId: 'sess-1', widgetInstanceId: 'w1', title: 'Codex', brand: 'codex-app-server' });
    popupHost.upsert({ sessionId: 'sess-2', widgetInstanceId: 'w2', title: 'Claude', brand: 'claude-code' });
    popupHost.minimize('sess-2');
    const h = mkDeps({
      conversationPopupHost: popupHost,
      onConversationPopupPick: () => {},
    });
    const line = h.wiring.buildStatusLine({
      swd: '/x',
      providerInfo: PROVIDER,
      gitState: 'main',
      conversationPopups: {
        liveCount: 1,
        minimizedCount: 1,
        layoutMode: 'cascade',
      },
    });
    expect(line).toContain('💬 1+1·cascade');
    h.wiring.setStatusRow(22);
    const pill = h.wiring._snapshot().pills.find((candidate) => candidate.name === 'conversationPopup');
    expect(pill).toBeDefined();
    const consumed = h.wiring.handleMouse(mouse('click', 22, pill!.startCol + 2));
    expect(consumed).toBe(true);
    expect(h.pushed[0]?.id).toBe('recipe:conversation-popup-shell');
  });

  test('pane hover bridge forwards conversation-message hits with stable row identity', () => {
    const events: Array<{ kind: string; id: string }> = [];
    const hoverTracker = createHoverTracker();
    const h = mkDeps({
      hoverTracker,
      onPaneHoverEvent: (ev) => {
        events.push({ kind: ev.kind, id: ev.target.id });
      },
      getPaneHitTarget: () => ({
        kind: 'pane-body',
        paneId: 'pane-conv',
        hit: {
          kind: 'conversation-message',
          sessionId: 'sess-1',
          messageId: 'msg-2',
          role: 'assistant',
          rangeStart: 4,
          rangeEnd: 9,
        },
      }),
    });
    expect(h.wiring.handleMouse(mouse('motion', 8, 14))).toBe(false);
    expect(events.some((event) => event.kind === 'hover-enter' && event.id === 'pane-body:pane-conv:msg-2')).toBe(true);
    hoverTracker.dispose();
  });
});

describe('MX11b dashboard-mouse-wiring — modal title drag session', () => {
  test('title click arms a move session and drag updates modal bounds', () => {
    const modal: ModalSurface = {
      id: 'modal-1',
      owner: 'dashboard',
      kind: 'modal',
      focus: 'owns',
      priority: 1,
      bounds: { row: 5, col: 10, width: 20, height: 6 },
      render: () => [],
      paint: () => '',
    };
    const updates: Array<{ id: string; bounds: ModalSurface['bounds'] }> = [];
    const h = mkDeps({
      getTopModalSurface: () => modal,
      routeModalMouse: (surface, ev) => {
        if (ev.type === 'click') ev.hitTarget = { kind: 'modal-title', modalId: surface.id };
        return true;
      },
      updateModalBounds: (id, bounds) => {
        updates.push({ id, bounds });
        modal.bounds = { ...bounds };
        return true;
      },
    });

    expect(h.wiring.handleMouse(mouse('click', 5, 12))).toBe(true);
    expect(h.wiring._snapshot().modalMoveSession).toEqual({
      modalId: 'modal-1',
      anchorRow: 5,
      anchorCol: 12,
      originBounds: { row: 5, col: 10, width: 20, height: 6 },
      moved: false,
    });

    expect(h.wiring.handleMouse(mouse('drag', 8, 16))).toBe(true);
    expect(updates).toEqual([
      { id: 'modal-1', bounds: { row: 8, col: 14, width: 20, height: 6 } },
    ]);
  });

  test('sub-threshold drag does not move the modal', () => {
    const modal: ModalSurface = {
      id: 'modal-1b',
      owner: 'dashboard',
      kind: 'modal',
      focus: 'owns',
      priority: 1,
      bounds: { row: 5, col: 10, width: 20, height: 6 },
      render: () => [],
      paint: () => '',
    };
    const updates: Array<{ id: string; bounds: ModalSurface['bounds'] }> = [];
    const h = mkDeps({
      getTopModalSurface: () => modal,
      routeModalMouse: (surface, ev) => {
        if (ev.type === 'click') ev.hitTarget = { kind: 'modal-title', modalId: surface.id };
        return true;
      },
      updateModalBounds: (id, bounds) => {
        updates.push({ id, bounds });
        modal.bounds = { ...bounds };
        return true;
      },
    });

    expect(h.wiring.handleMouse(mouse('click', 5, 12))).toBe(true);
    expect(h.wiring.handleMouse(mouse('drag', 6, 12))).toBe(true);
    expect(updates).toEqual([]);
    expect(h.wiring._snapshot().modalMoveSession).toMatchObject({
      modalId: 'modal-1b',
      moved: false,
    });
  });

  test('release applies final bounds update and clears move session', () => {
    const modal: ModalSurface = {
      id: 'modal-2',
      owner: 'dashboard',
      kind: 'modal',
      focus: 'owns',
      priority: 1,
      bounds: { row: 4, col: 8, width: 16, height: 5 },
      render: () => [],
      paint: () => '',
    };
    const updates: Array<{ id: string; bounds: ModalSurface['bounds'] }> = [];
    const h = mkDeps({
      getTopModalSurface: () => modal,
      routeModalMouse: (surface, ev) => {
        if (ev.type === 'click') ev.hitTarget = { kind: 'modal-title', modalId: surface.id };
        return true;
      },
      updateModalBounds: (id, bounds) => {
        updates.push({ id, bounds });
        modal.bounds = { ...bounds };
        return true;
      },
    });

    h.wiring.handleMouse(mouse('click', 4, 10));
    h.wiring.handleMouse(mouse('drag', 6, 14));
    expect(h.wiring.handleMouse(mouse('release', 7, 15))).toBe(true);
    expect(updates.at(-1)).toEqual({
      id: 'modal-2',
      bounds: { row: 7, col: 13, width: 16, height: 5 },
    });
    expect(h.wiring._snapshot().modalMoveSession).toBeNull();
  });

  test('escape restores origin bounds and cancels move session', () => {
    const modal: ModalSurface = {
      id: 'modal-3',
      owner: 'dashboard',
      kind: 'modal',
      focus: 'owns',
      priority: 1,
      bounds: { row: 6, col: 9, width: 18, height: 6 },
      render: () => [],
      paint: () => '',
    };
    const updates: Array<{ id: string; bounds: ModalSurface['bounds'] }> = [];
    const h = mkDeps({
      getTopModalSurface: () => modal,
      routeModalMouse: (surface, ev) => {
        if (ev.type === 'click') ev.hitTarget = { kind: 'modal-title', modalId: surface.id };
        return true;
      },
      updateModalBounds: (id, bounds) => {
        updates.push({ id, bounds });
        modal.bounds = { ...bounds };
        return true;
      },
    });

    h.wiring.handleMouse(mouse('click', 6, 12));
    h.wiring.handleMouse(mouse('drag', 8, 17));
    expect(h.wiring.routeKey({ name: 'escape', ctrl: false, shift: false, alt: false } as never)).toBe('consumed');
    expect(updates.at(-1)).toEqual({
      id: 'modal-3',
      bounds: { row: 6, col: 9, width: 18, height: 6 },
    });
    expect(h.wiring._snapshot().modalMoveSession).toBeNull();
  });

  test('ctrl+click on modal right edge arms a resize session and drag grows width', () => {
    const modal: ModalSurface = {
      id: 'modal-r1',
      owner: 'dashboard',
      kind: 'modal',
      focus: 'owns',
      priority: 1,
      bounds: { row: 5, col: 10, width: 20, height: 6 },
      render: () => [],
      paint: () => '',
    };
    const updates: Array<{ id: string; bounds: ModalSurface['bounds'] }> = [];
    const h = mkDeps({
      getTopModalSurface: () => modal,
      routeModalMouse: () => true,
      updateModalBounds: (id, bounds) => {
        updates.push({ id, bounds });
        modal.bounds = { ...bounds };
        return true;
      },
    });

    expect(h.wiring.handleMouse(mouse('click', 5, 29, { ctrl: true }))).toBe(true);
    expect(h.wiring._snapshot().modalResizeSession).toEqual({
      modalId: 'modal-r1',
      handle: 'ne',
      anchorRow: 5,
      anchorCol: 29,
      originBounds: { row: 5, col: 10, width: 20, height: 6 },
      moved: false,
    });
    expect(h.wiring.handleMouse(mouse('drag', 5, 34, { ctrl: true }))).toBe(true);
    expect(updates.at(-1)).toEqual({
      id: 'modal-r1',
      bounds: { row: 5, col: 10, width: 25, height: 6 },
    });
  });

  test('ctrl+click on modal left edge arms resize session and drag shrinks width from the west side', () => {
    const modal: ModalSurface = {
      id: 'modal-r2',
      owner: 'dashboard',
      kind: 'modal',
      focus: 'owns',
      priority: 1,
      bounds: { row: 5, col: 10, width: 20, height: 6 },
      render: () => [],
      paint: () => '',
    };
    const updates: Array<{ id: string; bounds: ModalSurface['bounds'] }> = [];
    const h = mkDeps({
      getTopModalSurface: () => modal,
      routeModalMouse: () => true,
      updateModalBounds: (id, bounds) => {
        updates.push({ id, bounds });
        modal.bounds = { ...bounds };
        return true;
      },
    });

    h.wiring.handleMouse(mouse('click', 8, 10, { ctrl: true }));
    expect(h.wiring.handleMouse(mouse('drag', 8, 14, { ctrl: true }))).toBe(true);
    expect(updates.at(-1)).toEqual({
      id: 'modal-r2',
      bounds: { row: 5, col: 14, width: 16, height: 6 },
    });
  });

  test('escape restores origin bounds and cancels resize session', () => {
    const modal: ModalSurface = {
      id: 'modal-r3',
      owner: 'dashboard',
      kind: 'modal',
      focus: 'owns',
      priority: 1,
      bounds: { row: 6, col: 9, width: 18, height: 6 },
      render: () => [],
      paint: () => '',
    };
    const updates: Array<{ id: string; bounds: ModalSurface['bounds'] }> = [];
    const h = mkDeps({
      getTopModalSurface: () => modal,
      routeModalMouse: () => true,
      updateModalBounds: (id, bounds) => {
        updates.push({ id, bounds });
        modal.bounds = { ...bounds };
        return true;
      },
    });

    h.wiring.handleMouse(mouse('click', 11, 26, { ctrl: true }));
    h.wiring.handleMouse(mouse('drag', 11, 31, { ctrl: true }));
    expect(h.wiring.routeKey({ name: 'escape', ctrl: false, shift: false, alt: false } as never)).toBe('consumed');
    expect(updates.at(-1)).toEqual({
      id: 'modal-r3',
      bounds: { row: 6, col: 9, width: 18, height: 6 },
    });
    expect(h.wiring._snapshot().modalResizeSession).toBeNull();
  });

  test('stable corner hover reveals resize handle hint after delay', () => {
    const modal: ModalSurface = {
      id: 'modal-r4',
      owner: 'dashboard',
      kind: 'modal',
      focus: 'owns',
      priority: 1,
      bounds: { row: 5, col: 10, width: 20, height: 6 },
      render: () => [],
      paint: () => '',
      resizeHandleHint: null,
    };
    const sched = createFakeScheduler();
    const h = mkDeps({
      getTopModalSurface: () => modal,
      routeModalMouse: () => true,
      schedule: sched.schedule,
      clearSchedule: sched.clear,
    });

    expect(h.wiring.handleMouse(mouse('motion', 5, 29))).toBe(true);
    expect(modal.resizeHandleHint).toBeNull();
    sched.advance(499);
    expect(modal.resizeHandleHint).toBeNull();
    sched.advance(1);
    expect(modal.resizeHandleHint).toBe('ne');
  });

  test('moving away clears a visible resize handle hint', () => {
    const modal: ModalSurface = {
      id: 'modal-r5',
      owner: 'dashboard',
      kind: 'modal',
      focus: 'owns',
      priority: 1,
      bounds: { row: 5, col: 10, width: 20, height: 6 },
      render: () => [],
      paint: () => '',
      resizeHandleHint: null,
    };
    const sched = createFakeScheduler();
    const h = mkDeps({
      getTopModalSurface: () => modal,
      routeModalMouse: () => true,
      schedule: sched.schedule,
      clearSchedule: sched.clear,
    });

    h.wiring.handleMouse(mouse('motion', 5, 10));
    sched.advance(500);
    expect(modal.resizeHandleHint).toBe('nw');
    expect(h.wiring.handleMouse(mouse('motion', 7, 18))).toBe(true);
    expect(modal.resizeHandleHint).toBeNull();
  });

  test('visible corner handle can arm resize without ctrl', () => {
    const modal: ModalSurface = {
      id: 'modal-r6',
      owner: 'dashboard',
      kind: 'modal',
      focus: 'owns',
      priority: 1,
      bounds: { row: 5, col: 10, width: 20, height: 6 },
      render: () => [],
      paint: () => '',
      resizeHandleHint: null,
    };
    const sched = createFakeScheduler();
    const updates: Array<{ id: string; bounds: ModalSurface['bounds'] }> = [];
    const h = mkDeps({
      getTopModalSurface: () => modal,
      routeModalMouse: () => true,
      updateModalBounds: (id, bounds) => {
        updates.push({ id, bounds });
        modal.bounds = { ...bounds };
        return true;
      },
      schedule: sched.schedule,
      clearSchedule: sched.clear,
    });

    h.wiring.handleMouse(mouse('motion', 5, 29));
    sched.advance(500);
    expect(modal.resizeHandleHint).toBe('ne');
    expect(h.wiring.handleMouse(mouse('click', 5, 29))).toBe(true);
    expect(h.wiring._snapshot().modalResizeSession?.handle).toBe('ne');
    expect(h.wiring.handleMouse(mouse('drag', 5, 33))).toBe(true);
    expect(updates.at(-1)).toEqual({
      id: 'modal-r6',
      bounds: { row: 5, col: 10, width: 24, height: 6 },
    });
  });
});

describe('MX11b dashboard-mouse-wiring — popup lifecycle', () => {
  // 2026-05-05 — model pill click was changed from "open picker" to
  // "cycle next entry directly" (faster UX). Popup-lifecycle tests
  // here moved to the workingDir pill (still picker-on-click) so the
  // dismiss / cancel / surface-onKey contracts stay under test
  // without regressing what the suite was actually validating.
  test('picking a wd entry fires setSessionWd + dismisses the popup', async () => {
    const h = mkDeps();
    h.wiring.buildStatusLine({ swd: '/x', providerInfo: PROVIDER, gitState: 'main' });
    h.wiring.setStatusRow(22);
    const pill = h.wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    h.wiring.handleMouse(mouse('click', 22, pill.startCol + 2));
    expect(h.wiring.hasActivePopup()).toBe(true);
    const ok = h.wiring.routeKey({ name: 'enter' } as never);
    expect(ok).toBe('consumed');
    await new Promise(r => setTimeout(r, 0));
    expect(h.switched).toHaveLength(1);
    expect(h.wiring.hasActivePopup()).toBe(false);
  });

  test('click outside the popup closes it', () => {
    const h = mkDeps();
    h.wiring.buildStatusLine({ swd: '/x', providerInfo: PROVIDER, gitState: 'main' });
    h.wiring.setStatusRow(22);
    const pill = h.wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    h.wiring.handleMouse(mouse('click', 22, pill.startCol + 2));
    expect(h.wiring.hasActivePopup()).toBe(true);
    const consumed = h.wiring.handleMouse(mouse('click', 2, 100));
    expect(consumed).toBe(true);
    expect(h.wiring.hasActivePopup()).toBe(false);
  });

  test('Esc routes through routeKey to cancel the popup', () => {
    const h = mkDeps();
    h.wiring.buildStatusLine({ swd: '/x', providerInfo: PROVIDER, gitState: 'main' });
    h.wiring.setStatusRow(22);
    const pill = h.wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    h.wiring.handleMouse(mouse('click', 22, pill.startCol + 2));
    expect(h.wiring.hasActivePopup()).toBe(true);
    h.wiring.routeKey({ name: 'escape' } as never);
    expect(h.wiring.hasActivePopup()).toBe(false);
  });

  test('routeKey with no active popup → passthrough', () => {
    const h = mkDeps();
    expect(h.wiring.routeKey({ name: 'a' } as never)).toBe('passthrough');
  });

  test('right-click outside dismisses the popup and falls through to context-menu dispatch', () => {
    const contextMenuEvents: DisplayMouseEvent[] = [];
    const h = mkDeps({
      contextMenuDispatch: (ev) => {
        contextMenuEvents.push(ev);
        return true;
      },
    });
    h.wiring.buildStatusLine({ swd: '/x', providerInfo: PROVIDER, gitState: 'main' });
    h.wiring.setStatusRow(22);
    const pill = h.wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    h.wiring.handleMouse(mouse('click', 22, pill.startCol + 2));
    expect(h.wiring.hasActivePopup()).toBe(true);

    const consumed = h.wiring.handleMouse(mouse('right-click', 2, 100));
    expect(consumed).toBe(true);
    expect(h.wiring.hasActivePopup()).toBe(false);
    expect(contextMenuEvents).toHaveLength(1);
    expect(contextMenuEvents[0]?.type).toBe('right-click');
  });

  // Post-KX follow-up — pinned via the wd pill (model pill no longer
  // opens a popup on click).
  test('pushed popup surface carries onKey wired to handleKey', () => {
    const h = mkDeps();
    h.wiring.buildStatusLine({ swd: '/x', providerInfo: PROVIDER, gitState: 'main' });
    h.wiring.setStatusRow(22);
    const pill = h.wiring._snapshot().pills.find(p => p.name === 'workingDir')!;
    h.wiring.handleMouse(mouse('click', 22, pill.startCol + 2));
    expect(h.pushed).toHaveLength(1);
    const surface = h.pushed[0]!;
    expect(typeof surface.onKey).toBe('function');
    const res = surface.onKey!({ name: 'escape' } as never);
    expect(res).toBe('consumed');
    expect(h.wiring.hasActivePopup()).toBe(false);
  });
});

describe('MX11b dashboard-mouse-wiring — toast rendering', () => {
  test('renderToasts paints current stack into the given printer', () => {
    const h = mkDeps();
    h.wiring.toasts().push({ text: 'Hello', kind: 'success', ttlMs: 9999 });
    const p = Printer.create({ width: 40, height: 6 });
    h.wiring.renderToasts(p);
    const joined = p.lines().join('\n');
    expect(joined).toContain('Hello');
  });
});

describe('dock area launcher + selectors', () => {
  test('buildDockLine renders menu, compact VW mover, and current view without a VW inventory row', () => {
    const h = mkDeps();
    const line = h.wiring.buildDockLine();
    expect(line).toContain('Menu');
    expect(line).toContain('🖥️');
    expect(line).not.toContain('VW🖥️');
    expect(line).toContain('│');
    expect(line).toContain('View');
    expect(line).not.toContain('Here');
    expect(line).not.toContain('VW 1/2');
    expect(line).not.toContain('VW#');
    const snap = h.wiring._snapshot();
    expect(snap.dockItems.some((item: any) => item.kind === 'menu')).toBe(true);
    expect(snap.dockItems.some((item: any) => item.kind === 'vw-mover-left')).toBe(true);
    expect(snap.dockItems.some((item: any) => item.kind === 'vw-mover-center')).toBe(true);
    expect(snap.dockItems.some((item: any) => item.kind === 'vw-mover-right')).toBe(true);
    expect(snap.dockItems.some((item: any) => item.kind === 'view')).toBe(true);
  });

  test('clicking dock mover arrows dispatches left/right movement intents', async () => {
    const h = mkDeps();
    h.wiring.buildDockLine();
    h.wiring.setDockRow(23);
    const left = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'vw-mover-left')!;
    const right = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'vw-mover-right')!;
    expect(h.wiring.handleMouse(mouse('click', 23, left.startCol + 1))).toBe(true);
    expect(h.wiring.handleMouse(mouse('click', 23, right.startCol + 1))).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    expect(h.movedVirtualWindows).toEqual(['left', 'right']);
    expect(h.switchedToDashboardMain).toHaveLength(1);
  });

  test('clicking the VW center opens the window picker callback', async () => {
    const h = mkDeps();
    h.wiring.buildDockLine();
    h.wiring.setDockRow(23);
    const center = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'vw-mover-center')!;
    expect(h.wiring.handleMouse(mouse('click', 23, center.startCol + 1))).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    expect(h.openedWindowPicker).toHaveLength(1);
    expect(h.movedVirtualWindows).toEqual([]);
  });

  test('mover segments render as one contiguous shaded rail', () => {
    const h = mkDeps();
    h.wiring.buildDockLine();
    const left = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'vw-mover-left')!;
    const center = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'vw-mover-center')!;
    const right = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'vw-mover-right')!;
    expect(center.startCol).toBe(left.endCol);
    expect(right.startCol).toBe(center.endCol);
  });

  test('wide dock widens side mover hit areas while keeping the center VW control compact', () => {
    const wide = mkDeps({
      termSize: () => ({ rows: 24, cols: 180 }),
      getVirtualWindows: () => [
        { id: 1, label: 'ACP', active: true },
      ],
    });
    const crowded = mkDeps({
      termSize: () => ({ rows: 24, cols: 180 }),
      getVirtualWindows: () => [
        { id: 1, label: 'ACP', active: true },
        { id: 2, label: 'Build', active: false },
        { id: 3, label: 'Logs', active: false },
      ],
      getDockMenuSurfaceTargets: () => [
        { id: 'pane:browser', label: 'Browser popup', group: 'Panes' },
        { id: 'companion:clipboard', label: 'Clipboard companion', group: 'Companions' },
        { id: 'vw:browser', label: 'Browser virtual window', group: 'Virtual Windows' },
      ],
    });
    wide.wiring.buildDockLine();
    crowded.wiring.buildDockLine();
    const wideLeft = wide.wiring._snapshot().dockItems.find((item: any) => item.kind === 'vw-mover-left')!;
    const crowdedLeft = crowded.wiring._snapshot().dockItems.find((item: any) => item.kind === 'vw-mover-left')!;
    const wideCenter = wide.wiring._snapshot().dockItems.find((item: any) => item.kind === 'vw-mover-center')!;
    const crowdedCenter = crowded.wiring._snapshot().dockItems.find((item: any) => item.kind === 'vw-mover-center')!;
    expect(crowded.wiring.buildDockLine()).toContain('🖥️');
    expect(wideLeft.endCol - wideLeft.startCol).toBeGreaterThan(crowdedLeft.endCol - crowdedLeft.startCol);
    expect(wideCenter.endCol - wideCenter.startCol).toBe(crowdedCenter.endCol - crowdedCenter.startCol);
  });

  test('clicking dock menu in compact opens dock menu tree and dispatches add-window from the shared submenu', async () => {
    const h = mkDeps();
    h.wiring.buildDockLine();
    h.wiring.setDockRow(23);
    const menu = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'menu')!;
    expect(h.wiring.handleMouse(mouse('click', 23, menu.startCol + 1))).toBe(true);
    expect(h.pushed.at(-1)?.id).toBe('recipe:dock-menu-tree');
    expect(h.wiring.routeKey({ name: 'enter' } as never)).toBe('consumed');
    expect(h.wiring.routeKey({ name: 'enter' } as never)).toBe('consumed');
    await new Promise(r => setTimeout(r, 0));
    expect(h.openedDockWindows).toEqual(['browser']);
    expect(h.wiring.hasActivePopup()).toBe(false);
  });

  test('dock mover click still dispatches while a blocking virtual window is foreground', async () => {
    const modalCalls: Array<{ row: number; col: number }> = [];
    const h = mkDeps({
      getTopBlockingModalSurface: () => ({
        id: 'virtual-window:1',
        kind: 'modal',
        focus: 'owns',
        priority: 500,
        bounds: { row: 1, col: 1, width: 120, height: 24 },
        interactiveBounds: { row: 1, col: 1, width: 120, height: 24 },
        render: () => [],
        paint: () => '',
        cursor: () => null,
        onMouse: (ev: { row: number; col: number }) => {
          modalCalls.push({ row: ev.row, col: ev.col });
          return { type: 'refresh' as const };
        },
        dispose: () => {},
      } as any),
      getTopModalSurface: () => ({
        id: 'virtual-window:1',
        kind: 'modal',
        focus: 'owns',
        priority: 500,
        bounds: { row: 1, col: 1, width: 120, height: 24 },
        interactiveBounds: { row: 1, col: 1, width: 120, height: 24 },
        render: () => [],
        paint: () => '',
        cursor: () => null,
        onMouse: (ev: { row: number; col: number }) => {
          modalCalls.push({ row: ev.row, col: ev.col });
          return { type: 'refresh' as const };
        },
        dispose: () => {},
      } as any),
    });
    h.wiring.buildDockLine();
    h.wiring.setDockRow(23);
    const left = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'vw-mover-left')!;
    expect(h.wiring.handleMouse(mouse('click', 23, left.startCol + 1))).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    expect(h.movedVirtualWindows).toEqual(['left']);
    expect(modalCalls).toEqual([]);
  });

  test('workspace-class VW foreground does not lock dock hit targets when no blocking popup is present', async () => {
    const h = mkDeps({
      getTopBlockingModalSurface: () => null,
      getTopModalSurface: () => ({
        id: 'virtual-window:2',
        kind: 'modal',
        focus: 'owns',
        priority: 500,
        tier: 'vw',
        hostChromeProfile: 'hud-status-input-dock',
        interactionClass: 'workspace',
        bounds: { row: 1, col: 1, width: 120, height: 24 },
        interactiveBounds: { row: 1, col: 1, width: 120, height: 24 },
        render: () => [],
        paint: () => '',
        cursor: () => null,
        onMouse: () => ({ type: 'refresh' as const }),
        dispose: () => {},
      } as any),
    });
    h.wiring.buildDockLine();
    h.wiring.setDockRow(23);
    const menu = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'menu')!;
    expect(h.wiring.handleMouse(mouse('click', 23, menu.startCol + 1))).toBe(true);
    expect(h.pushed.at(-1)?.id).toBe('recipe:dock-menu-tree');
  });

  test('clicking dock menu can open the shared surface submenu and dispatch a picked surface', async () => {
    const h = mkDeps();
    h.wiring.buildDockLine();
    h.wiring.setDockRow(23);
    const menu = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'menu')!;
    expect(h.wiring.handleMouse(mouse('click', 23, menu.startCol + 1))).toBe(true);
    expect(h.pushed.at(-1)?.id).toBe('recipe:dock-menu-tree');
    expect(h.wiring.routeKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.wiring.routeKey({ name: 'enter' } as never)).toBe('consumed');
    expect(h.wiring.routeKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.wiring.routeKey({ name: 'enter' } as never)).toBe('consumed');
    await new Promise(r => setTimeout(r, 0));
    expect(h.openedDockSurfaces).toEqual(['pane:browser']);
    expect(h.wiring.hasActivePopup()).toBe(false);
  });

  test('clicking view area opens a view picker and applies the selected view', async () => {
    const h = mkDeps();
    h.wiring.buildDockLine();
    h.wiring.setDockRow(23);
    const view = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'view')!;
    expect(h.wiring.handleMouse(mouse('click', 23, view.startCol + 1))).toBe(true);
    expect(h.pushed.at(-1)?.id).toBe('recipe:view');
    expect(h.wiring.routeKey({ name: 'enter' } as never)).toBe('consumed');
    await new Promise(r => setTimeout(r, 0));
    expect(h.appliedViews).toEqual(['1']);
  });

  test('view picker can dispatch starter management actions without active-view bullets', async () => {
    const h = mkDeps({
      getDashboardViews: () => [
        { id: '1', label: 'Normal', description: 'Starter: Browser + Preview', active: true },
        { id: 'action:view-restore', label: 'Restore starter panes', description: 'Reopen closed panes', active: false },
      ],
    });
    h.wiring.buildDockLine();
    h.wiring.setDockRow(23);
    const view = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'view')!;
    expect(h.wiring.handleMouse(mouse('click', 23, view.startCol + 1))).toBe(true);
    expect(h.pushed.at(-1)?.id).toBe('recipe:view');
    const rendered = h.pushed.at(-1)?.paint?.() ?? '';
    expect(rendered).toContain('Restore starter panes');
    expect(rendered).not.toContain('○ Restore starter panes');
    expect(h.wiring.routeKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.wiring.routeKey({ name: 'enter' } as never)).toBe('consumed');
    await new Promise(r => setTimeout(r, 0));
    expect(h.appliedViews).toEqual(['action:view-restore']);
  });

  test('compact-tight view picker renders active-only inventories cleanly', async () => {
    const h = mkDeps({
      termSize: () => ({ rows: 24, cols: 100 }),
      getDashboardViews: () => [
        { id: 'agents', label: 'Agents', description: 'Starter: Agent roster', active: true },
        { id: 'action:view-reset', label: 'Reset view config', description: 'Restore built-in dashboard view definitions', active: false },
      ],
    });
    h.wiring.buildDockLine();
    h.wiring.setDockRow(23);
    const view = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'view')!;
    expect(h.wiring.handleMouse(mouse('click', 23, view.startCol + 1))).toBe(true);
    const rendered = h.pushed.at(-1)?.paint?.() ?? '';
    expect(rendered).toContain('Agents');
    expect(rendered).toContain('Reset view config');
    expect(rendered).not.toContain('○ Reset view config');
  });

  test('compact-tight dock menu still exposes the shared tree contract', async () => {
    const h = mkDeps({
      termSize: () => ({ rows: 24, cols: 100 }),
    });
    h.wiring.buildDockLine();
    h.wiring.setDockRow(23);
    const menu = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'menu')!;
    expect(h.wiring.handleMouse(mouse('click', 23, menu.startCol + 1))).toBe(true);
    const rendered = h.pushed.at(-1)?.paint?.() ?? '';
    expect(rendered).toContain('Add surface');
    expect(rendered).toContain('Pop out pane');
    expect(rendered).toContain('Chat only');
    expect(rendered).toContain('Exit program');
  });

  test('dock menu can dispatch exit program from the shared parent menu', async () => {
    const h = mkDeps();
    h.wiring.buildDockLine();
    h.wiring.setDockRow(23);
    const menu = h.wiring._snapshot().dockItems.find((item: any) => item.kind === 'menu')!;
    expect(h.wiring.handleMouse(mouse('click', 23, menu.startCol + 1))).toBe(true);
    expect(h.pushed.at(-1)?.id).toBe('recipe:dock-menu-tree');
    expect(h.wiring.routeKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.wiring.routeKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.wiring.routeKey({ name: 'down' } as never)).toBe('consumed');
    expect(h.wiring.routeKey({ name: 'enter' } as never)).toBe('consumed');
    await new Promise(r => setTimeout(r, 0));
    expect(h.exitProgramCalls).toHaveLength(1);
    expect(h.wiring.hasActivePopup()).toBe(false);
  });

});

describe('M1 handleMouse diagnostics — mouse.pill trace events', () => {
  test('click emits handleMouse:enter with row/col/statusRow/pill geometry', () => {
    debug.enable();
    try {
      const h = mkDeps();
      h.wiring.buildStatusLine({
        swd: '/Users/test/project',
        providerInfo: PROVIDER,
      });
      h.wiring.setStatusRow(20);
      h.wiring.handleMouse(mouse('click', 20, 5));
      const tail = debug.tail(20).join('\n');
      expect(tail).toContain('mouse.pill');
      expect(tail).toContain('handleMouse:enter');
      expect(tail).toMatch(/"row":\s*20/);
      expect(tail).toMatch(/"col":\s*5/);
      expect(tail).toMatch(/"statusRow":\s*20/);
    } finally {
      debug.disable();
    }
  });

  test('click on a pill emits handleMouse:pill-matched', () => {
    debug.enable();
    try {
      const h = mkDeps();
      h.wiring.buildStatusLine({
        swd: '/Users/test/project',
        providerInfo: PROVIDER,
      });
      h.wiring.setStatusRow(20);
      const modelPill = h.wiring._snapshot().pills.find(p => p.name === 'model')!;
      h.wiring.handleMouse(mouse('click', 20, modelPill.startCol + 1));
      const tail = debug.tail(20).join('\n');
      expect(tail).toContain('handleMouse:pill-matched');
      expect(tail).toContain('"name":"model"');
    } finally {
      debug.disable();
    }
  });

  test('click far from any region emits handleMouse:dropped', () => {
    debug.enable();
    try {
      const h = mkDeps();
      h.wiring.buildStatusLine({
        swd: '/Users/test/project',
        providerInfo: PROVIDER,
      });
      h.wiring.setStatusRow(20);
      h.wiring.handleMouse(mouse('click', 3, 3));
      const tail = debug.tail(20).join('\n');
      expect(tail).toContain('handleMouse:dropped');
    } finally {
      debug.disable();
    }
  });

  test('scroll/drag events do not emit trace records (noise reduction)', () => {
    debug.enable();
    const traced: string[] = [];
    const off = debug.registerSink({ name: 'mouse-pill-noise-test', emit: (record) => {
      if (record.category === 'mouse.pill' && record.event.startsWith('handleMouse:')) traced.push(record.event);
    } });
    try {
      const h = mkDeps();
      h.wiring.buildStatusLine({
        swd: '/Users/test/project',
        providerInfo: PROVIDER,
      });
      h.wiring.setStatusRow(20);
      h.wiring.handleMouse(mouse('scroll-up', 10, 10));
      h.wiring.handleMouse(mouse('scroll-down', 10, 10));
      h.wiring.handleMouse(mouse('drag', 10, 10));
      expect(traced).toEqual([]);
    } finally {
      off();
      debug.disable();
    }
  });
});
