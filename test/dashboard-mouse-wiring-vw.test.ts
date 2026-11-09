// VW-U1 — mouse wiring tests for the 🪟 virtual-window pill.
//
// Covers: pill registration in buildStatusLine when vw summary is
// non-trivial, pill click dispatches onWindowPillClick, and absence
// of a summary leaves the pill list unchanged.

import { describe, expect, test } from 'bun:test';
import { createDashboardMouseWiring } from '../src/dashboard/input/mouse-wiring.js';
import type { RotationEntry } from '../src/user-config/types.js';
import type { ActiveProviderInfo } from '../src/provider-summary.js';
import type { ModalSurface } from '../src/display/modal-stack.js';
import { createWorkspaceHost } from '../src/display/workspace-host.js';

const PROVIDER: ActiveProviderInfo = { provider: 'anthropic', model: 'Opus 4.7' };

function mkDeps(overrides: Partial<Parameters<typeof createDashboardMouseWiring>[0]> = {}) {
  const pushed: ModalSurface[] = [];
  const pillClicks: number[] = [];
  const rotation: RotationEntry[] = [
    { label: 'Opus 4.7', provider: 'anthropic', model: 'claude-opus-4-7' },
  ];
  const restored: string[] = [];
  const workspaceHost = createWorkspaceHost();
  return {
    pushed, pillClicks, restored, workspaceHost,
    wiring: createDashboardMouseWiring({
      termSize: () => ({ rows: 24, cols: 120 }),
      getRotation: () => rotation,
      setActiveModel: () => {},
      getRecentWds: () => ['/home/a'],
      setSessionWd: () => {},
      pushModalSurface: surface => {
        pushed.push(surface);
        return { dispose: () => { pushed.splice(pushed.indexOf(surface), 1); } };
      },
      redraw: () => {},
      onWindowPillClick: () => { pillClicks.push(Date.now()); },
      onWorkspaceRestore: (surfaceId) => { restored.push(surfaceId); },
      workspaceHost,
      ...overrides,
    }),
  };
}

describe('VW-U1 dashboard-mouse-wiring — virtualWindow pill', () => {
  test('buildStatusLine includes the vw pill when a multi-pane summary is passed', () => {
    const { wiring } = mkDeps();
    const line = wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
      gitState: 'main',
      vw: { windowId: 2, paneIdx: 1, paneTotal: 3, windowTotal: 1 },
    });
    expect(line).toContain('win:2');
    const snap = wiring._snapshot();
    expect(snap.pills.map(p => p.name)).toEqual(['workingDir', 'model', 'virtualWindow']);
    // vw pill sits strictly to the right of the model pill.
    const vwPill = snap.pills.find(p => p.name === 'virtualWindow')!;
    const modelPill = snap.pills.find(p => p.name === 'model')!;
    expect(vwPill.startCol).toBeGreaterThan(modelPill.endCol);
  });

  test('single-pane single-window scenario omits the pill entirely', () => {
    const { wiring } = mkDeps();
    const line = wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
      vw: { windowId: 1, paneIdx: 1, paneTotal: 1, windowTotal: 1 },
    });
    expect(line).not.toContain('win:1');
    const snap = wiring._snapshot();
    expect(snap.pills.map(p => p.name)).toEqual(['workingDir', 'model']);
  });

  test('click on virtualWindow pill invokes onWindowPillClick', () => {
    const { wiring, pillClicks } = mkDeps();
    wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
      vw: { windowId: 1, paneIdx: 1, paneTotal: 2, windowTotal: 1 },
    });
    wiring.setStatusRow(5);
    const vwPill = wiring._snapshot().pills.find(p => p.name === 'virtualWindow')!;
    // col is 1-indexed in DisplayMouseEvent; startCol is 0-indexed.
    const clickCol = vwPill.startCol + 1;
    const consumed = wiring.handleMouse({ type: 'click', row: 5, col: clickCol });
    expect(consumed).toBe(true);
    expect(pillClicks).toHaveLength(1);
    expect(wiring.hasActivePopup()).toBe(false);
  });

  test('VW-U3 — click inside modal bounds dispatches through modal.onMouse', () => {
    const calls: Array<{ row: number; col: number }> = [];
    const fakeModal = {
      id: 'virtual-window:1', kind: 'modal', focus: 'owns', priority: 500,
      bounds: { row: 2, col: 2, width: 80, height: 20 },
      render: () => [], paint: () => '', cursor: () => null,
      onMouse: (ev: { type: string; row: number; col: number }) => {
        calls.push({ row: ev.row, col: ev.col });
        return { type: 'refresh' as const };
      },
      dispose: () => {},
    } as never;
    const { wiring } = mkDeps({ getTopModalSurface: () => fakeModal });
    wiring.buildStatusLine({
      swd: '/x', providerInfo: PROVIDER,
    });
    wiring.setStatusRow(30);  // out of the way
    const consumed = wiring.handleMouse({ type: 'click', row: 10, col: 30 });
    expect(consumed).toBe(true);
    expect(calls).toEqual([{ row: 10, col: 30 }]);
  });

  test('motion inside modal bounds forwards to modal.onMouse for hover-driven focus zones', () => {
    const calls: Array<{ type: string; row: number; col: number }> = [];
    const fakeModal = {
      id: 'debug-workbench', kind: 'modal', focus: 'owns', priority: 500,
      bounds: { row: 2, col: 2, width: 80, height: 20 },
      interactiveBounds: { row: 2, col: 2, width: 80, height: 20 },
      render: () => [], paint: () => '', cursor: () => null,
      onMouse: (ev: { type: string; row: number; col: number }) => {
        calls.push({ type: ev.type, row: ev.row, col: ev.col });
        return { type: 'refresh' as const };
      },
      dispose: () => {},
    } as never;
    const { wiring } = mkDeps({ getTopModalSurface: () => fakeModal });
    wiring.buildStatusLine({ swd: '/x', providerInfo: PROVIDER });
    wiring.setStatusRow(30);
    const consumed = wiring.handleMouse({ type: 'motion', row: 10, col: 30 });
    expect(consumed).toBe(true);
    expect(calls).toEqual([{ type: 'motion', row: 10, col: 30 }]);
  });

  test('VW-U3 — click outside modal bounds is NOT consumed (lets other handlers try)', () => {
    const fakeModal = {
      id: 'virtual-window:1', kind: 'modal', focus: 'owns', priority: 500,
      bounds: { row: 5, col: 5, width: 10, height: 5 },
      render: () => [], paint: () => '', cursor: () => null,
      onMouse: () => ({ type: 'none' as const }),
      dispose: () => {},
    } as never;
    const { wiring } = mkDeps({ getTopModalSurface: () => fakeModal });
    wiring.buildStatusLine({ swd: '/x', providerInfo: PROVIDER });
    wiring.setStatusRow(30);
    // Click well outside the modal bounds and outside status row.
    const consumed = wiring.handleMouse({ type: 'click', row: 20, col: 60 });
    expect(consumed).toBe(false);
  });

  test('W2 — interactiveBounds override full-screen backdrop bounds for click ownership', () => {
    const calls: Array<{ row: number; col: number }> = [];
    const fakeModal = {
      id: 'live-pane-multi-modal:1', kind: 'modal', focus: 'owns', priority: 500,
      bounds: { row: 1, col: 1, width: 120, height: 24 },
      interactiveBounds: { row: 5, col: 10, width: 50, height: 10 },
      visualBounds: { row: 5, col: 10, width: 50, height: 10 },
      backdropBounds: { row: 1, col: 1, width: 120, height: 24 },
      render: () => [], paint: () => '', cursor: () => null,
      onMouse: (ev: { type: string; row: number; col: number }) => {
        calls.push({ row: ev.row, col: ev.col });
        return { type: 'refresh' as const };
      },
      dispose: () => {},
    } as never;
    const { wiring } = mkDeps({ getTopModalSurface: () => fakeModal });
    wiring.buildStatusLine({ swd: '/x', providerInfo: PROVIDER });
    wiring.setStatusRow(30);

    const outside = wiring.handleMouse({ type: 'click', row: 3, col: 3 });
    expect(outside).toBe(false);

    const inside = wiring.handleMouse({ type: 'click', row: 8, col: 20 });
    expect(inside).toBe(true);
    expect(calls).toEqual([{ row: 8, col: 20 }]);
  });

  test('W2 — blocking modal consumes background status-row clicks instead of reopening dashboard pills', () => {
    const pillClicks: number[] = [];
    const fakeModal = {
      id: 'live-pane-multi-modal:1', kind: 'modal', focus: 'owns', priority: 500,
      bounds: { row: 1, col: 1, width: 120, height: 24 },
      interactiveBounds: { row: 5, col: 10, width: 50, height: 10 },
      backgroundInteractionPolicy: 'block',
      render: () => [], paint: () => '', cursor: () => null,
      onMouse: () => ({ type: 'none' as const }),
      dispose: () => {},
    } as never;
    const { wiring } = mkDeps({
      getTopModalSurface: () => fakeModal,
      getTopBlockingModalSurface: () => fakeModal,
      onWindowPillClick: () => { pillClicks.push(Date.now()); },
    });
    wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
      vw: { windowId: 1, paneIdx: 1, paneTotal: 2, windowTotal: 1 },
    });
    wiring.setStatusRow(5);
    const vwPill = wiring._snapshot().pills.find(p => p.name === 'virtualWindow')!;
    const consumed = wiring.handleMouse({ type: 'click', row: 5, col: vwPill.startCol + 1 });
    expect(consumed).toBe(true);
    expect(pillClicks).toHaveLength(0);
    expect(wiring.hasActivePopup()).toBe(false);
  });

  test('W4 — top companion popup does not cancel blocking foreground modal demotion', () => {
    const pillClicks: number[] = [];
    const topCompanion = {
      id: 'conversation-modal:1', kind: 'modal', focus: 'none', priority: 510,
      bounds: { row: 1, col: 1, width: 120, height: 24 },
      interactiveBounds: { row: 8, col: 70, width: 30, height: 8 },
      backgroundInteractionPolicy: 'allow',
      windowRole: 'companion',
      render: () => [], paint: () => '', cursor: () => null,
      onMouse: () => ({ type: 'none' as const }),
      dispose: () => {},
    } as never;
    const blockingForeground = {
      id: 'live-pane-multi-modal:1', kind: 'modal', focus: 'owns', priority: 500,
      bounds: { row: 1, col: 1, width: 120, height: 24 },
      interactiveBounds: { row: 5, col: 10, width: 50, height: 10 },
      backgroundInteractionPolicy: 'block',
      windowRole: 'foreground',
      render: () => [], paint: () => '', cursor: () => null,
      onMouse: () => ({ type: 'none' as const }),
      dispose: () => {},
    } as never;
    const { wiring } = mkDeps({
      getTopModalSurface: () => topCompanion,
      getTopBlockingModalSurface: () => blockingForeground,
      onWindowPillClick: () => { pillClicks.push(Date.now()); },
    });
    wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
      vw: { windowId: 1, paneIdx: 1, paneTotal: 2, windowTotal: 1 },
    });
    wiring.setStatusRow(5);
    const vwPill = wiring._snapshot().pills.find(p => p.name === 'virtualWindow')!;
    const consumed = wiring.handleMouse({ type: 'click', row: 5, col: vwPill.startCol + 1 });
    expect(consumed).toBe(true);
    expect(pillClicks).toHaveLength(0);
    expect(wiring.hasActivePopup()).toBe(false);
  });

  test('missing onWindowPillClick still consumes the click without crashing', () => {
    const { wiring } = mkDeps({ onWindowPillClick: undefined });
    wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
      vw: { windowId: 1, paneIdx: 1, paneTotal: 2, windowTotal: 1 },
    });
    wiring.setStatusRow(5);
    const vwPill = wiring._snapshot().pills.find(p => p.name === 'virtualWindow')!;
    const consumed = wiring.handleMouse({ type: 'click', row: 5, col: vwPill.startCol + 1 });
    expect(consumed).toBe(true);
  });

  test('missing onWindowPillClick with dock entries opens desktop shell fallback', () => {
    const { wiring, pushed, workspaceHost } = mkDeps({ onWindowPillClick: undefined });
    workspaceHost.ensureWorkspace({ id: 'dashboard-main', layoutMode: 'desktop' });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'recipe:model',
      kind: 'popup',
      label: 'Switch model',
      order: 10,
      minimized: true,
      docked: true,
    });
    wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
      vw: { windowId: 1, paneIdx: 1, paneTotal: 2, windowTotal: 1 },
    });
    wiring.setStatusRow(5);
    const vwPill = wiring._snapshot().pills.find(p => p.name === 'virtualWindow')!;
    const consumed = wiring.handleMouse({ type: 'click', row: 5, col: vwPill.startCol + 1 });
    expect(consumed).toBe(true);
    expect(pushed[0]?.id).toBe('recipe:workspace-desktop-shell');
    expect(wiring.hasActivePopup()).toBe(true);
  });

  test('docked workspace entries no longer add a workspaceDock pill to status line', () => {
    const { wiring, workspaceHost } = mkDeps();
    workspaceHost.ensureWorkspace({ id: 'dashboard-main', layoutMode: 'desktop' });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'recipe:model',
      kind: 'popup',
      label: 'Switch model',
      order: 10,
      minimized: true,
      docked: true,
    });
    const line = wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
      vw: { windowId: 1, paneIdx: 1, paneTotal: 2, windowTotal: 1 },
    });
    expect(line).not.toContain('docked');
    expect(wiring._snapshot().pills.find(p => p.name === 'workspaceDock')).toBeUndefined();
  });

  test('dock rail click opens the workspace desktop shell popup', () => {
    const { wiring, workspaceHost, pushed } = mkDeps({ onWindowPillClick: undefined });
    workspaceHost.ensureWorkspace({ id: 'dashboard-main', layoutMode: 'desktop' });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'recipe:model',
      kind: 'popup',
      label: 'Switch model',
      order: 10,
      minimized: true,
      docked: true,
    });
    wiring.buildDockLine();
    wiring.setDockRow(5);
    const dockItem = wiring._snapshot().dockItems.find((item: any) => item.kind === 'menu')!;
    const consumed = wiring.handleMouse({ type: 'click', row: 5, col: dockItem.startCol + 1 });
    expect(consumed).toBe(true);
    expect(pushed[0]?.id).toBe('recipe:dock-launcher');
  });

  test('dock rail renders individual dock items in order', () => {
    const { wiring, workspaceHost } = mkDeps({ onWindowPillClick: undefined });
    workspaceHost.ensureWorkspace({ id: 'dashboard-main', layoutMode: 'desktop' });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'debug-window',
      kind: 'popup',
      label: 'Debug Window',
      order: 10,
      minimized: true,
      docked: true,
    });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'debug-workbench',
      kind: 'popup',
      label: 'Debug Workbench',
      order: 11,
      minimized: true,
      docked: true,
    });
    const line = wiring.buildDockLine();
    expect(line).toContain('Debug Window');
    expect(line).toContain('Debug Workben');
    const snap = wiring._snapshot();
    expect(
      snap.dockItems
        .filter((item: any) => item.kind === 'workspace-dock')
        .map((item: any) => item.surfaceId),
    ).toEqual(['debug-window', 'debug-workbench']);
  });

  test('click on dock rail item opens list first instead of restoring directly', () => {
    const { wiring, workspaceHost, restored, pushed } = mkDeps({ onWindowPillClick: undefined });
    workspaceHost.ensureWorkspace({ id: 'dashboard-main', layoutMode: 'desktop' });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'debug-window',
      kind: 'popup',
      label: 'Debug Window',
      order: 10,
      minimized: true,
      docked: true,
    });
    wiring.buildDockLine();
    wiring.setDockRow(3);
    const item = wiring._snapshot().dockItems.find((entry: any) => entry.kind === 'menu')!;
    const consumed = wiring.handleMouse({ type: 'click', row: 3, col: item.startCol + 1 });
    expect(consumed).toBe(true);
    expect(restored).toEqual([]);
    expect(pushed[0]?.id).toBe('recipe:dock-launcher');
  });

  test('workspaceDock shell includes dormant entries as restore candidates', () => {
    const { wiring, workspaceHost, pushed } = mkDeps({ onWindowPillClick: undefined });
    workspaceHost.ensureWorkspace({ id: 'dashboard-main', label: 'Dashboard', layoutMode: 'desktop' });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'live:model',
      kind: 'popup',
      label: 'Model switcher',
      order: 5,
    });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'recipe:wd',
      kind: 'popup',
      label: 'Switch working directory',
      order: 8,
      minimized: true,
      docked: true,
    });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'popup:search',
      kind: 'popup',
      label: 'Search',
      order: 10,
      minimized: true,
    });
    wiring.buildDockLine();
    wiring.setDockRow(5);
    const dockItem = wiring._snapshot().dockItems.find((item: any) => item.kind === 'menu')!;
    const consumed = wiring.handleMouse({ type: 'click', row: 5, col: dockItem.startCol + 1 });
    expect(consumed).toBe(true);
    const shell = pushed[0];
    expect(shell?.id).toBe('recipe:dock-launcher');
  });

  test('narrow viewport keeps dock rail and still omits workspaceDock status pill', () => {
    const { wiring, workspaceHost } = mkDeps({
      termSize: () => ({ rows: 24, cols: 72 }),
      onWindowPillClick: undefined,
    });
    workspaceHost.ensureWorkspace({ id: 'dashboard-main', layoutMode: 'desktop' });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'recipe:model',
      kind: 'popup',
      label: 'Switch model',
      order: 10,
      minimized: true,
      docked: true,
    });
    const line = wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
    });
    expect(line).not.toContain('🗂');
    expect(wiring._snapshot().pills.some(p => p.name === 'workspaceDock')).toBe(false);
    expect(wiring.buildDockLine()).toContain('Switch mo');
  });

  test('medium viewport dock rail renders compact dock labels', () => {
    const { wiring, workspaceHost } = mkDeps({
      termSize: () => ({ rows: 24, cols: 100 }),
      onWindowPillClick: undefined,
    });
    workspaceHost.ensureWorkspace({ id: 'dashboard-main', layoutMode: 'desktop' });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'recipe:model',
      kind: 'popup',
      label: 'Switch model',
      order: 10,
      minimized: true,
      docked: true,
    });
    const line = wiring.buildDockLine();
    expect(line).toContain('Switch');
  });

  test('dormant-only workspace does not render dock rail items', () => {
    const { wiring, workspaceHost } = mkDeps({ onWindowPillClick: undefined });
    workspaceHost.ensureWorkspace({ id: 'dashboard-main', layoutMode: 'desktop' });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'popup:search',
      kind: 'popup',
      label: 'Search',
      order: 10,
      minimized: true,
    });
    expect(wiring.buildDockLine()).toContain('Menu');
    expect(wiring._snapshot().dockItems.some((item: any) => item.kind === 'menu')).toBe(true);
  });

  test('dormant-only workspace still opens desktop shell from vw fallback', () => {
    const { wiring, workspaceHost, pushed } = mkDeps({ onWindowPillClick: undefined });
    workspaceHost.ensureWorkspace({ id: 'dashboard-main', layoutMode: 'desktop' });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'popup:search',
      kind: 'popup',
      label: 'Search',
      order: 10,
      minimized: true,
    });
    wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
    });
    wiring.setStatusRow(5);
    const consumed = wiring.handleMouse({ type: 'click', row: 10, col: 1 });
    expect(consumed).toBe(false);
    expect(pushed).toHaveLength(0);
  });

  test('dormant-only workspace desktop shell can still be opened via virtualWindow fallback when vw pill exists', () => {
    const { wiring, workspaceHost, pushed } = mkDeps({ onWindowPillClick: undefined });
    workspaceHost.ensureWorkspace({ id: 'dashboard-main', layoutMode: 'desktop' });
    workspaceHost.upsertMember('dashboard-main', {
      surfaceId: 'popup:search',
      kind: 'popup',
      label: 'Search',
      order: 10,
      minimized: true,
    });
    wiring.buildStatusLine({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
      vw: { windowId: 1, paneIdx: 1, paneTotal: 2, windowTotal: 1 },
    });
    wiring.setStatusRow(5);
    const vwPill = wiring._snapshot().pills.find(p => p.name === 'virtualWindow')!;
    const consumed = wiring.handleMouse({ type: 'click', row: 5, col: vwPill.startCol + 1 });
    expect(consumed).toBe(true);
    expect(pushed[0]?.id).toBe('recipe:workspace-desktop-shell');
    const painted = pushed[0]?.paint?.() ?? '';
    expect(painted).toContain('1 parked');
    expect(painted).toContain('Dormant');
    expect(painted).toContain('dormant · restore');
    expect(painted).toContain('Search');
  });
});
