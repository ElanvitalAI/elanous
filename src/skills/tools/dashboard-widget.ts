import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tools: DashboardWidgetList + DashboardWidgetToggle +
// DashboardPaneFocus — T6-K5.
//
// Surface the live widget inventory + pane focus to the LLM in
// control mode. "Toggling" a widget for MVP means
// setting its state.focused flag — actual hide/show lives with
// the layout host and isn't wired here.
//
// Deps:
//   initDashboardWidgetTools(hostOps)
//     hostOps.list()           → WidgetInfo[]
//     hostOps.toggleFocus(id)  → boolean (new focused state)
//     hostOps.focusPane(name)  → boolean (whether the focus set)
//
// The dashboard wires these to widgetHost + workingDir.focus.



export interface WidgetInfo {
  id: string;
  type: string;
  focused: boolean;
  meta?: Record<string, unknown>;
}

export interface DashboardWidgetHostOps {
  list: () => WidgetInfo[];
  toggleFocus: (id: string) => boolean | null;
  focusPane: (name: string) => boolean;
  listPanes: () => string[];
}

let _ops: DashboardWidgetHostOps | null = null;

export function initDashboardWidgetTools(ops: DashboardWidgetHostOps): void {
  _ops = ops;
}

export function _resetDashboardWidgetToolsForTesting(): void {
  _ops = null;
}

function need(): DashboardWidgetHostOps {
  if (!_ops) throw new Error('DashboardWidget tools not wired — call initDashboardWidgetTools first.');
  return _ops;
}

// ─── DashboardWidgetList ──────────────────────────────────────────

export function buildDashboardWidgetListTool(): LLMToolSpec {
  return {
    name: 'DashboardWidgetList',
    description:
      'List every live widget instance on the current view with id, type, and focus state. Use in control mode to see what is on screen before manipulating it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  };
}

export async function dispatchDashboardWidgetList(
  _rawArgs: Record<string, unknown>,
  deps: { ops?: DashboardWidgetHostOps } = {},
): Promise<{ output: string }> {
  const ops = deps.ops ?? need();
  const widgets = ops.list();
  if (widgets.length === 0) {
    return { output: 'DashboardWidgetList — (no widgets on screen)' };
  }
  const lines = [`DashboardWidgetList (${widgets.length})`];
  for (const w of widgets) {
    const mark = w.focused ? '●' : '○';
    lines.push(`  ${mark} ${w.id}  type=${w.type}`);
  }
  return { output: lines.join('\n') };
}

// ─── DashboardWidgetToggle ────────────────────────────────────────

export function buildDashboardWidgetToggleTool(): LLMToolSpec {
  return {
    name: 'DashboardWidgetToggle',
    description:
      'Toggle a widget\'s focus flag by id. Returns the new state or an error when the id is unknown. Non-destructive — this just shifts which widget paints with the active color.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Widget instance id (e.g. wd-log, wd-preview).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchDashboardWidgetToggle(
  rawArgs: Record<string, unknown>,
  deps: { ops?: DashboardWidgetHostOps } = {},
): Promise<{ output: string }> {
  const ops = deps.ops ?? need();
  const id = String(rawArgs.id ?? '').trim();
  if (!id) throw new Error(`'id' is required`);
  const result = ops.toggleFocus(id);
  if (result === null) {
    throw new Error(`DashboardWidgetToggle: unknown widget id "${id}"`);
  }
  return {
    output: `DashboardWidgetToggle ${id} focused=${result}`,
  };
}

// ─── DashboardPaneFocus ───────────────────────────────────────────

export function buildDashboardPaneFocusTool(): LLMToolSpec {
  return {
    name: 'DashboardPaneFocus',
    description:
      'Set the dashboard\'s focused pane by name (browser, preview, log, scratch, obsidian, input). Returns ok=true when the focus moved; false when the name is unknown or the pane isn\'t in the current view.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Pane name — one of the values returned by DashboardWidgetList\'s paneNames hint.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  };
}

export async function dispatchDashboardPaneFocus(
  rawArgs: Record<string, unknown>,
  deps: { ops?: DashboardWidgetHostOps } = {},
): Promise<{ output: string }> {
  const ops = deps.ops ?? need();
  const name = String(rawArgs.name ?? '').trim().toLowerCase();
  if (!name) throw new Error(`'name' is required`);
  const valid = ops.listPanes();
  if (!valid.includes(name)) {
    return {
      output: `DashboardPaneFocus refused: "${name}" not a known pane. Valid: ${valid.join(', ')}.`,
    };
  }
  const ok = ops.focusPane(name);
  return {
    output: `DashboardPaneFocus ${name} ok=${ok}`,
  };
}
