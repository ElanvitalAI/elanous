import type { LLMToolSpec } from '../../llm/tool-spec.js';
// HT1/HT2 — Native tools: DashboardViewSwitch + DashboardWidgetInvoke.
//
// Lets the LLM (in control / skill modes) flip dashboard
// views by id/shortcut/label and fan-out synthetic key events at
// widget instances. Both tools are the minimum hook surface needed
// to drive V7 (Widget Playground) from outside the interactive key
// loop — useful for automated UI smoke tests and for MCP clients
// that want to manipulate the dashboard from a remote process.
//
// Non-destructive: neither tool can kill widgets or create panes —
// just change which view is active and deliver keystrokes that the
// target widget's onKey already understands.



export interface DashboardViewInfo {
  id: string;
  label: string;
  shortcut?: string;
  active: boolean;
}

export interface DashboardViewOps {
  list: () => DashboardViewInfo[];
  /** Switch by id/label/shortcut. Returns the activated view's id on
   *  success, null when the needle matched nothing. */
  switchTo: (needle: string) => string | null;
}

export interface DashboardWidgetInvokeOps {
  /** True when the widget exists and accepted the key. False when the
   *  widget consumed it but reported 'none', or when id is unknown. */
  sendKey: (widgetId: string, name: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean }) => { ok: boolean; handled: boolean; reason?: string };
  /** Snapshot of the widget's current state (best-effort — state
   *  shape is widget-specific). Returns null when id is unknown. */
  snapshot: (widgetId: string) => { type: string; state: unknown } | null;
}

let _viewOps: DashboardViewOps | null = null;
let _widgetOps: DashboardWidgetInvokeOps | null = null;

export function initDashboardViewTools(ops: DashboardViewOps, widgetOps: DashboardWidgetInvokeOps): void {
  _viewOps = ops;
  _widgetOps = widgetOps;
}

export function _resetDashboardViewToolsForTesting(): void {
  _viewOps = null;
  _widgetOps = null;
}

function needView(): DashboardViewOps {
  if (!_viewOps) throw new Error('DashboardViewSwitch not wired — call initDashboardViewTools first.');
  return _viewOps;
}

function needWidget(): DashboardWidgetInvokeOps {
  if (!_widgetOps) throw new Error('DashboardWidgetInvoke not wired — call initDashboardViewTools first.');
  return _widgetOps;
}

// ─── DashboardViewSwitch ─────────────────────────────────────────

export function buildDashboardViewSwitchTool(): LLMToolSpec {
  return {
    name: 'DashboardViewSwitch',
    description:
      'Switch the dashboard to a different view by id, label, or shortcut. '
      + 'Example needles: "1", "Normal", "playground", "7", "agents". '
      + 'Use DashboardWidgetList after switching to see which widgets '
      + 'the new view renders.',
    parameters: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          description: 'View id, label, or numeric shortcut (e.g. "7" or "playground").',
        },
      },
      required: ['view'],
      additionalProperties: false,
    },
  };
}

export async function dispatchDashboardViewSwitch(
  rawArgs: Record<string, unknown>,
  deps: { ops?: DashboardViewOps } = {},
): Promise<{ output: string }> {
  const ops = deps.ops ?? needView();
  const view = String(rawArgs.view ?? '').trim();
  if (!view) throw new Error(`'view' is required`);
  const activatedId = ops.switchTo(view);
  if (!activatedId) {
    const known = ops.list().map(v => `${v.id}${v.shortcut ? `(${v.shortcut})` : ''}`).join(', ');
    throw new Error(`DashboardViewSwitch: no view matched "${view}". Known views: ${known}`);
  }
  return { output: `DashboardViewSwitch ${view} → ${activatedId}` };
}

// ─── DashboardWidgetInvoke ───────────────────────────────────────

export function buildDashboardWidgetInvokeTool(): LLMToolSpec {
  return {
    name: 'DashboardWidgetInvoke',
    description:
      'Fire a synthetic key event at a widget instance. The widget\'s '
      + 'onKey handler receives a KeyEvent { name, ctrl?, shift?, alt? } '
      + 'just as if the user had pressed the key. Useful for exercising '
      + 'V7 (Widget Playground) from automation or MCP clients. Returns '
      + 'ok=true + handled flag from the widget\'s EventResult. Also '
      + 'returns a post-invoke state snapshot for inspection.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Widget instance id (see DashboardWidgetList).' },
        key: {
          type: 'string',
          description: 'KeyEvent.name — e.g. "up", "down", "left", "right", "tab", "enter", "r", "1".',
        },
        ctrl:  { type: 'boolean', description: 'Ctrl modifier. Default false.' },
        shift: { type: 'boolean', description: 'Shift modifier. Default false.' },
        alt:   { type: 'boolean', description: 'Alt modifier. Default false.' },
      },
      required: ['id', 'key'],
      additionalProperties: false,
    },
  };
}

export async function dispatchDashboardWidgetInvoke(
  rawArgs: Record<string, unknown>,
  deps: { ops?: DashboardWidgetInvokeOps } = {},
): Promise<{ output: string }> {
  const ops = deps.ops ?? needWidget();
  const id = String(rawArgs.id ?? '').trim();
  const key = String(rawArgs.key ?? '').trim();
  if (!id)  throw new Error(`'id' is required`);
  if (!key) throw new Error(`'key' is required`);
  const mods = {
    ctrl:  rawArgs.ctrl === true,
    shift: rawArgs.shift === true,
    alt:   rawArgs.alt === true,
  };
  const result = ops.sendKey(id, key, mods);
  if (!result.ok) {
    throw new Error(`DashboardWidgetInvoke ${id} ← ${key}: ${result.reason ?? 'unknown id'}`);
  }
  const snap = ops.snapshot(id);
  const snapTxt = snap ? JSON.stringify(snap.state).slice(0, 240) : '(snapshot unavailable)';
  return {
    output: [
      `DashboardWidgetInvoke ${id} ← ${key}${mods.ctrl ? '+C' : ''}${mods.shift ? '+S' : ''}${mods.alt ? '+A' : ''}`,
      `  handled: ${result.handled}`,
      `  state: ${snapTxt}`,
    ].join('\n'),
  };
}
