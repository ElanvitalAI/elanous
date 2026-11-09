import { stripAnsi, truncate, visibleWidth } from '../../tui.js';
import { debug } from '../../debug/log.js';
import type { PillBound } from '../../status/pills.js';
import type { DashboardMouseWiringDeps, DashboardStatusInput } from './mouse-wiring-types.js';
import {
  contextUsageSegment, hostSegment, sessionCwdSegment, conversationPopupSegment,
  gitSegment, modelSegment, elapsedSegment, modeSegment, ptyShellCountSegment,
  runningAgentsSegment, backgroundJobsSegment, controllerSegment, shellRollupSegment,
  sshSegment, STATUS_SEGMENT_SEPARATOR, tmuxSegment, vwSegment, runningBuildSegment,
  type GitSegmentState, type StatusBarRenderOptions,
} from '../../status/bar.js';

/** Status line rendering is independent of mouse dispatch and dashboard startup. */
export interface MouseStatusLine {
  build(input: DashboardStatusInput): string;
  pills(): readonly PillBound[];
}

export function createMouseStatusLine(deps: {
  termSize: DashboardMouseWiringDeps['termSize'];
  conversationPopupHost?: DashboardMouseWiringDeps['conversationPopupHost'];
}): MouseStatusLine {
  let pills: PillBound[] = [];
  let lastStatusOverflowKey = '';
  const build = (input: DashboardStatusInput): string => {
    const { cols } = deps.termSize();
    const opts: StatusBarRenderOptions = { theme: input.theme, compact: cols < 100 };
    const segments: Array<{ name: PillBound['name'] | null; render: string; required?: boolean }> = [
      { name: 'workingDir', render: sessionCwdSegment(input.swd, opts) },
      { name: null, render: gitSegment(input.swd, labelGitState(input.gitState, input.runningBuild ? '트리' : undefined), opts) },
    ];
    const runningBuildRender = runningBuildSegment(input.runningBuild, opts);
    if (runningBuildRender) segments.push({ name: null, render: runningBuildRender });
    segments.push({ name: 'model', render: modelSegment(input.providerInfo, opts) });
    const runningAgentsRender = runningAgentsSegment(input.runningAgents ?? 0, opts);
    if (runningAgentsRender) segments.push({ name: null, render: runningAgentsRender });
    const controllerRender = controllerSegment(input.controller, opts);
    if (controllerRender) segments.push({ name: null, render: controllerRender });
    const backgroundJobsRender = backgroundJobsSegment(input.backgroundJobs ?? null, opts);
    if (backgroundJobsRender) segments.push({ name: null, render: backgroundJobsRender, required: true });
    const modeRender = modeSegment(input.mode ?? 'general', opts);
    if (modeRender) segments.push({ name: 'mode', render: modeRender });
    if (typeof input.contextUsedTokens === 'number') segments.push({ name: null, render: contextUsageSegment(input.contextUsedTokens, opts) });
    if (input.host) segments.push({ name: null, render: hostSegment(input.host, opts) });
    if (input.tmuxLabel) segments.push({ name: null, render: tmuxSegment(input.tmuxLabel, opts) });
    else if (input.sshLabel) segments.push({ name: null, render: sshSegment(input.sshLabel, opts) });
    if (typeof input.elapsedSec === 'number') segments.push({ name: null, render: elapsedSegment(input.elapsedSec, opts) });
    const shellCount = input.shellCount ?? 0;
    if (shellCount > 0) segments.push({ name: null, render: ptyShellCountSegment(shellCount, opts) });
    if (input.shellRollup) {
      const render = shellRollupSegment(input.shellRollup, opts);
      if (render) segments.push({ name: 'shellRollup', render });
    }
    const vwRender = vwSegment(input.vw ?? null, opts);
    if (vwRender) segments.push({ name: 'virtualWindow', render: vwRender });
    if (deps.conversationPopupHost) {
      const render = conversationPopupSegment(input.conversationPopups ?? null, opts);
      if (render) segments.push({ name: 'conversationPopup', render });
    }

    const nextPills: PillBound[] = [];
    const parts: string[] = [];
    const budget = Math.max(0, cols - 1);
    const fit = fitStatusSegments(
      segments.map((seg) => visibleWidth(stripAnsi(seg.render))),
      visibleWidth(stripAnsi(STATUS_SEGMENT_SEPARATOR)),
      budget,
      segments.map((seg) => seg.required === true),
    );
    for (const placed of fit.placed) {
      const seg = segments[placed.index]!;
      if (seg.name) nextPills.push({ name: seg.name, startCol: placed.startCol, endCol: placed.startCol + placed.width });
      parts.push(seg.render);
    }
    const droppedKinds = [...new Set(fit.dropped.map((i) => statusSegmentKind(segments[i]!.render)))].sort();
    const droppedKey = droppedKinds.join(' ');
    if (droppedKey !== lastStatusOverflowKey) {
      lastStatusOverflowKey = droppedKey;
      try { debug.log('status.bar', 'overflow-fit', { cols, budget, dropped: droppedKinds, width: fit.width }); }
      catch { /* observation must not block rendering */ }
    }
    pills = nextPills;
    const line = parts.join(STATUS_SEGMENT_SEPARATOR);
    if (fit.width <= budget) return line;
    const cut = truncateToVisibleWidth(line, budget);
    pills = clampPillsToWidth(nextPills, visibleWidth(cut));
    return cut;
  };
  return { build, pills: () => pills };
}

function labelGitState(state: GitSegmentState | string | null | undefined, label: string | undefined): GitSegmentState | string | undefined {
  if (!label || state === null || state === undefined) return state ?? undefined;
  return typeof state === 'string' ? { branch: state, label } : { ...state, label };
}

export function fitStatusSegments(
  widths: readonly number[], sepWidth: number, budget: number, required: readonly boolean[] = [],
): { placed: Array<{ index: number; startCol: number; width: number }>; dropped: number[]; width: number } {
  const isRequired = (i: number): boolean => i === 0 || required[i] === true;
  const w = (i: number): number => Math.max(0, widths[i] ?? 0);
  const reserve: number[] = new Array(widths.length + 1).fill(0);
  for (let i = widths.length - 1; i >= 0; i--) {
    reserve[i] = reserve[i + 1]! + (isRequired(i + 1) && i + 1 < widths.length ? sepWidth + w(i + 1) : 0);
  }
  const placed: Array<{ index: number; startCol: number; width: number }> = [];
  const dropped: number[] = [];
  let col = 0;
  for (let i = 0; i < widths.length; i++) {
    const start = placed.length > 0 ? col + sepWidth : 0;
    if (!isRequired(i) && start + w(i) + reserve[i]! > budget) { dropped.push(i); continue; }
    placed.push({ index: i, startCol: start, width: w(i) });
    col = start + w(i);
  }
  return { placed, dropped, width: col };
}

export function statusSegmentKind(render: string): string {
  return stripAnsi(render).trim().split(/\s+/)[0] ?? '';
}

export function truncateToVisibleWidth(line: string, budget: number): string {
  if (budget <= 0) return '';
  if (visibleWidth(line) <= budget) return line;
  for (let max = budget; max > 0; max--) {
    const cut = truncate(line, max);
    if (visibleWidth(cut) <= budget) return cut;
  }
  return '';
}

export function clampPillsToWidth(pills: readonly PillBound[], shown: number): PillBound[] {
  return pills.filter((p) => p.startCol < shown).map((p) => ({ ...p, endCol: Math.min(p.endCol, shown) }));
}
