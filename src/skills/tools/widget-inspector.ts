import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tools: DashboardWidgetSnapshot + DashboardWidgetDescribe +
// DashboardWidgetCall — Phase 4a LLM control surface.
//
// The LLM inspects live widget state with `Snapshot`, grounds itself on
// a specific cell with `Describe`, and drives a focused widget with
// `Call` (same code path as dispatchKeyToWidget). Host wires these via
// `initWidgetInspectorTools({ host })` — the WidgetHost object alone
// is enough; every lookup flows through it.


import { dispatchKeyToWidget, type WidgetHostLike } from '../../widget-routing/widget-dispatcher.js';
import { getWidgetSnapshot, getWidgetDescription } from '../../widgets/inspector.js';
import type { Key } from '../../tui.js';

export interface WidgetInspectorOps {
  host: WidgetHostLike;
  /** Optional hook that fires after a Call succeeds — dashboards wire
   *  this to draw() so changes appear immediately. */
  afterCall?: (widgetId: string, key: Key) => void;
}

let _ops: WidgetInspectorOps | null = null;

export function initWidgetInspectorTools(ops: WidgetInspectorOps): void {
  _ops = ops;
}

export function _resetWidgetInspectorToolsForTesting(): void {
  _ops = null;
}

function need(): WidgetInspectorOps {
  if (!_ops) throw new Error('Widget inspector tools not wired — call initWidgetInspectorTools first.');
  return _ops;
}

// ─── DashboardWidgetSnapshot ──────────────────────────────────────

export function buildWidgetSnapshotTool(): LLMToolSpec {
  return {
    name: 'DashboardWidgetSnapshot',
    description:
      'Return a JSON snapshot of a widget\'s state for inspection. Widgets may provide a custom snapshot method; otherwise a safe default shallow-projects primitive fields and labels complex values. Use when you need to know "what does the agent-roster show right now?" or "what row is the cursor on?".',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Widget instance id (e.g. wd-log, wd-agent-roster, wd-browser).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchWidgetSnapshot(
  rawArgs: Record<string, unknown>,
  deps: { ops?: WidgetInspectorOps } = {},
): Promise<{ output: string }> {
  const ops = deps.ops ?? need();
  const id = String(rawArgs.id ?? '').trim();
  if (!id) throw new Error(`'id' is required`);
  const inst = ops.host.get(id);
  const def = ops.host.defFor(id);
  const ctx = ops.host.buildContext(id);
  if (!inst || !def || !ctx) {
    return { output: `DashboardWidgetSnapshot: unknown widget "${id}"` };
  }
  const snap = getWidgetSnapshot(def, inst.state, ctx);
  return { output: JSON.stringify({ id, type: def.type, state: snap }, null, 2) };
}

// ─── DashboardWidgetDescribe ──────────────────────────────────────

export function buildWidgetDescribeTool(): LLMToolSpec {
  return {
    name: 'DashboardWidgetDescribe',
    description:
      'Ask a widget to describe what sits at widget-local (row, col). Widgets with domain semantics (e.g. "row 3 = agent parse-repo") override the default to return a useful prose line. Use to ground pointer / cursor references before calling the widget.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Widget instance id.' },
        row: { type: 'number', description: 'Widget-local row (0-based, top = 0).' },
        col: { type: 'number', description: 'Widget-local col (0-based, left = 0).' },
      },
      required: ['id', 'row', 'col'],
      additionalProperties: false,
    },
  };
}

export async function dispatchWidgetDescribe(
  rawArgs: Record<string, unknown>,
  deps: { ops?: WidgetInspectorOps } = {},
): Promise<{ output: string }> {
  const ops = deps.ops ?? need();
  const id = String(rawArgs.id ?? '').trim();
  if (!id) throw new Error(`'id' is required`);
  const row = Number(rawArgs.row ?? 0);
  const col = Number(rawArgs.col ?? 0);
  const inst = ops.host.get(id);
  const def = ops.host.defFor(id);
  const ctx = ops.host.buildContext(id);
  if (!inst || !def || !ctx) {
    return { output: `DashboardWidgetDescribe: unknown widget "${id}"` };
  }
  const desc = getWidgetDescription(def, inst.state, ctx, row, col);
  return { output: desc };
}

// ─── DashboardWidgetCall ──────────────────────────────────────────

/** Synthetic key events the Call tool accepts — restrict to keys widgets
 *  typically declare in behaviors (j/k/g/G/Home/End/PgUp/PgDn/Enter/
 *  Escape/space/A/a/left/right/up/down). Explicit allow-list avoids
 *  letting the LLM send arbitrary bytes into the pane handler. */
const CALL_ALLOWED_KEYS = new Set([
  'j', 'k', 'h', 'l', 'down', 'up', 'left', 'right',
  'g', 'G', 'home', 'end',
  'pageup', 'pagedown',
  'enter', 'escape', 'space', 'tab',
  'A', 'a', 'd', 'u', 'n', 'r', 'p',
]);

export function buildWidgetCallTool(): LLMToolSpec {
  return {
    name: 'DashboardWidgetCall',
    description:
      'Send a synthetic key event to a widget through the same dispatchKeyToWidget path a user keystroke takes. Use this to drive a widget after inspecting it — e.g. move cursor to row N with repeated j presses, or hit Enter to submit. Only behavior-safe keys are accepted (no arbitrary bytes).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Widget instance id.' },
        key: {
          type: 'string',
          description: 'Key name — one of: j/k/h/l/down/up/left/right/g/G/home/end/pageup/pagedown/enter/escape/space/tab/A/a/d/u/n/r/p.',
        },
        ctrl: { type: 'boolean', description: 'Ctrl modifier (e.g. Ctrl+d halfpage).', default: false },
        shift: { type: 'boolean', description: 'Shift modifier.', default: false },
        repeat: { type: 'number', description: 'Dispatch the key N times (default 1; max 50).', default: 1 },
      },
      required: ['id', 'key'],
      additionalProperties: false,
    },
  };
}

export async function dispatchWidgetCall(
  rawArgs: Record<string, unknown>,
  deps: { ops?: WidgetInspectorOps } = {},
): Promise<{ output: string }> {
  const ops = deps.ops ?? need();
  const id = String(rawArgs.id ?? '').trim();
  if (!id) throw new Error(`'id' is required`);
  const keyName = String(rawArgs.key ?? '').trim();
  if (!keyName) throw new Error(`'key' is required`);
  if (!CALL_ALLOWED_KEYS.has(keyName)) {
    return { output: `DashboardWidgetCall refused: key "${keyName}" not in allow-list. Valid: ${[...CALL_ALLOWED_KEYS].sort().join(', ')}.` };
  }
  const ctrl = Boolean(rawArgs.ctrl ?? false);
  const shift = Boolean(rawArgs.shift ?? false);
  const repeatRaw = Number(rawArgs.repeat ?? 1);
  const repeat = Math.max(1, Math.min(50, Number.isFinite(repeatRaw) ? Math.floor(repeatRaw) : 1));

  const inst = ops.host.get(id);
  if (!inst) return { output: `DashboardWidgetCall: unknown widget "${id}"` };

  const key: Key = { name: keyName, ctrl, shift } as Key;
  let consumed = 0;
  let lastAction: string = 'none';
  for (let i = 0; i < repeat; i++) {
    const action = dispatchKeyToWidget(ops.host, id, key);
    if (action && (action as { type?: string }).type !== 'none') {
      consumed++;
      lastAction = (action as { type: string }).type;
    }
    ops.afterCall?.(id, key);
  }
  return {
    output: `DashboardWidgetCall ${id} key=${keyName}${ctrl ? '+ctrl' : ''}${shift ? '+shift' : ''} repeat=${repeat} consumed=${consumed}/${repeat} lastAction=${lastAction}`,
  };
}
