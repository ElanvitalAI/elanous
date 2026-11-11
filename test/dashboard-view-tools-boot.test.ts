import { describe, expect, test } from 'bun:test';

import { bootDashboardViewTools } from '../src/dashboard/view-tools-boot.js';
import type {
  DashboardViewInfo,
  DashboardWidgetInvokeOps,
} from '../src/skills/tools/dashboard-view.js';

describe('bootDashboardViewTools', () => {
  test('wires view listing and widget invoke delegation', () => {
    let installed:
      | {
        list: () => DashboardViewInfo[];
        switchTo: (needle: string) => string | null;
      }
      | undefined;
    let widgetOps: DashboardWidgetInvokeOps | undefined;
    let draws = 0;
    let switchedTo: string | null = null;
    let receivedEvent: unknown;
    let receivedContext: unknown;

    bootDashboardViewTools({
      initDashboardViewTools: (viewOps, invokeOps) => {
        installed = viewOps;
        widgetOps = invokeOps;
      },
      listViews: () => [
        { id: 'normal', label: 'Normal', shortcut: '1', active: true },
        { id: 'agents', label: 'Agents', shortcut: '4', active: false },
      ],
      switchViewByNeedle: (needle) => {
        switchedTo = needle;
        return needle === '4' ? 'agents' : null;
      },
      getWidget: (id) => id === 'wd-agent-roster'
        ? { type: 'agents', state: { cursor: 3 } }
        : null,
      getWidgetDef: (id) => id === 'wd-agent-roster'
        ? {
            onKey: (ev, _state, ctx) => {
              receivedEvent = ev;
              receivedContext = ctx;
              return { type: 'refresh' };
            },
          }
        : null,
      buildWidgetContext: (id) => ({ id, kind: 'ctx' }),
      draw: () => { draws += 1; },
    });

    expect(installed?.list()).toHaveLength(2);
    expect(installed?.switchTo('4')).toBe('agents');
    expect(switchedTo).toBe('4');
    expect(widgetOps?.snapshot('wd-agent-roster')).toEqual({
      type: 'agents',
      state: { cursor: 3 },
    });
    expect(widgetOps?.sendKey('wd-agent-roster', 'enter', { ctrl: true })).toEqual({
      ok: true,
      handled: true,
    });
    expect(receivedEvent).toEqual({ name: 'enter', ctrl: true, shift: false, alt: false });
    expect(receivedContext).toEqual({ id: 'wd-agent-roster', kind: 'ctx' });
    expect(draws).toBe(1);
  });

  test('returns descriptive failure for unknown widget or missing onKey', () => {
    let widgetOps: DashboardWidgetInvokeOps | undefined;

    bootDashboardViewTools({
      initDashboardViewTools: (_viewOps, invokeOps) => { widgetOps = invokeOps; },
      listViews: () => [],
      switchViewByNeedle: () => null,
      getWidget: (id) => id === 'known' ? { type: 'viewer', state: {} } : null,
      getWidgetDef: () => ({}),
      buildWidgetContext: () => null,
      draw: () => {},
    });

    expect(widgetOps?.sendKey('missing', 'space', {})).toEqual({
      ok: false,
      handled: false,
      reason: 'unknown widget id "missing"',
    });
    expect(widgetOps?.sendKey('known', 'space', {})).toEqual({
      ok: false,
      handled: false,
      reason: 'widget "known" (type viewer) has no onKey handler',
    });
  });
});
