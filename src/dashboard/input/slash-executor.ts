import type { SlashExecuteRequest, SlashExecuteResult } from '../../skills/tools/dashboard-slash.js';
import type { PaneFocus } from '../../workspace-types.js';
import { dashboardStatusSummaryLines } from '../dashboard-status-lines.js';

export interface ImmediateDashboardSlashDeps {
  getStatusLines: () => string[];
  openPaneModal?: (pane: PaneFocus) => void;
  openBrowserPreviewModal?: () => void;
  openSurfaceInVw?: (surface: 'browser' | 'preview' | 'browser-preview' | 'scratch') => boolean;
  openSurfaceCatalog?: () => boolean;
  openCompanionSurface?: (
    surface: 'clipboard' | 'memo' | 'detail',
    target: 'popup' | 'vw',
  ) => boolean;
}

export function executeImmediateDashboardSlash(
  req: SlashExecuteRequest,
  deps: ImmediateDashboardSlashDeps,
): SlashExecuteResult | null {
  // `/status` = human lines only · `/status --debug` = with the internal detail block (TUI-SLASH-DECIDE-NOW C).
  if ((req.name === 'status' || req.name === 'st')
    && (req.args.length === 0 || (req.args.length === 1 && req.args[0] === '--debug'))) {
    const lines = deps.getStatusLines();
    return {
      ok: true,
      name: req.name,
      args: req.args,
      logLines: req.args.length === 0 ? dashboardStatusSummaryLines(lines) : lines,
    };
  }
  if ((req.name === 'surface' || req.name === 'surf') && req.args.length >= 1) {
    const arg = req.args[0]!.toLowerCase();
    const target = (req.args[1] ?? '').toLowerCase();
    if (arg === 'catalog' || arg === 'cat' || arg === 'menu') {
      const opened = deps.openSurfaceCatalog?.() ?? false;
      if (!opened) return null;
      return {
        ok: true,
        name: req.name,
        args: req.args,
        logLines: ['Opened the surface catalog.'],
      };
    }
    const pane =
      arg === 'browser' || arg === 'b' ? 'browser'
      : arg === 'preview' || arg === 'p' ? 'preview'
      : arg === 'log' || arg === 'l' ? 'log'
      : arg === 'scratch' || arg === 's' ? 'scratch'
      : arg === 'obsidian' || arg === 'o' || arg === 'ob' ? 'obsidian'
      : arg === 'skill' || arg === 'skills' || arg === 'k' ? 'skill-browser'
      : arg === 'skill-file' || arg === 'file' || arg === 'f' ? 'skill-file'
      : arg === 'agents' || arg === 'agent-roster' || arg === 'a' ? 'agent-roster'
      : arg === 'detail' || arg === 'd' ? 'agent-detail'
      : arg === 'browser-preview' || arg === 'bp' ? 'browser-preview'
      : null;
    const companion =
      arg === 'clipboard' || arg === 'clip' || arg === 'c' ? 'clipboard'
      : arg === 'memo' || arg === 'm' ? 'memo'
      : arg === 'detail-viewer' || arg === 'detail-pane' ? 'detail'
      : arg === 'detail' || arg === 'dv' ? 'detail'
      : null;
    if (target === 'vw' || target === 'window') {
      if (companion) {
        const opened = deps.openCompanionSurface?.(companion, 'vw') ?? false;
        if (!opened) return null;
        return {
          ok: true,
          name: req.name,
          args: req.args,
          logLines: [`Opened ${companion} companion in the current virtual window.`],
        };
      }
      if (
        pane === 'browser'
        || pane === 'preview'
        || pane === 'browser-preview'
        || pane === 'scratch'
      ) {
        const opened = deps.openSurfaceInVw?.(pane) ?? false;
        if (!opened) return null;
        return {
          ok: true,
          name: req.name,
          args: req.args,
          logLines: [`Opened ${pane} surface in a virtual window.`],
        };
      }
      return null;
    }
    if (companion) {
      const opened = deps.openCompanionSurface?.(companion, 'popup') ?? false;
      if (!opened) return null;
      return {
        ok: true,
        name: req.name,
        args: req.args,
        logLines: [`Opened ${companion} companion.`],
      };
    }
    if (pane === 'browser-preview') {
      deps.openBrowserPreviewModal?.();
      return {
        ok: true,
        name: req.name,
        args: req.args,
        logLines: ['Opened browser + preview surface.'],
      };
    }
    if (pane) {
      deps.openPaneModal?.(pane);
      return {
        ok: true,
        name: req.name,
        args: req.args,
        logLines: [`Opened ${pane} surface.`],
      };
    }
    return null;
  }
  return null;
}
