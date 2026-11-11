import { afterEach, describe, expect, test } from 'bun:test';
import {
  dispatchDashboardViewSwitch,
  dispatchDashboardWidgetInvoke,
  initDashboardViewTools,
  _resetDashboardViewToolsForTesting,
  type DashboardViewInfo,
  type DashboardViewOps,
  type DashboardWidgetInvokeOps,
} from '../src/skills/tools/dashboard-view.js';

afterEach(() => {
  _resetDashboardViewToolsForTesting();
});

function mkViewOps(partial: Partial<DashboardViewOps> = {}): DashboardViewOps {
  const views: DashboardViewInfo[] = [
    { id: '1', label: 'Normal', shortcut: '1', active: true },
    { id: 'agents', label: 'Agents', shortcut: '4', active: false },
  ];
  return {
    list: () => views,
    switchTo: (needle) => {
      const v = views.find(x => x.id === needle || x.shortcut === needle || x.label.toLowerCase() === needle.toLowerCase());
      return v ? v.id : null;
    },
    ...partial,
  };
}

function mkWidgetOps(partial: Partial<DashboardWidgetInvokeOps> = {}): DashboardWidgetInvokeOps {
  return {
    sendKey: (id, name, mods) => {
      if (id === 'unknown') return { ok: false, handled: false, reason: 'unknown id' };
      return { ok: true, handled: name !== 'escape' };
    },
    snapshot: (id) => id === 'unknown' ? null : { type: 'agents', state: { cursor: 0, size: 'medium' } },
    ...partial,
  };
}

describe('HT1 — DashboardViewSwitch', () => {
  test('refuses when tools not wired', async () => {
    await expect(dispatchDashboardViewSwitch({ view: '4' })).rejects.toThrow(/not wired/);
  });

  test('switches by shortcut', async () => {
    initDashboardViewTools(mkViewOps(), mkWidgetOps());
    const r = await dispatchDashboardViewSwitch({ view: '4' });
    expect(r.output).toContain('agents');
  });

  test('switches by label (case-insensitive)', async () => {
    initDashboardViewTools(mkViewOps(), mkWidgetOps());
    const r = await dispatchDashboardViewSwitch({ view: 'agents' });
    expect(r.output).toContain('agents');
  });

  test('throws with known views enumerated when needle unknown', async () => {
    initDashboardViewTools(mkViewOps(), mkWidgetOps());
    await expect(dispatchDashboardViewSwitch({ view: 'bogus' })).rejects.toThrow(/no view matched/);
    await expect(dispatchDashboardViewSwitch({ view: 'bogus' })).rejects.toThrow(/Known views/);
  });

  test('requires view arg', async () => {
    initDashboardViewTools(mkViewOps(), mkWidgetOps());
    await expect(dispatchDashboardViewSwitch({ view: '' })).rejects.toThrow(/is required/);
  });
});

describe('HT2 — DashboardWidgetInvoke', () => {
  test('fires key at widget and returns handled + snapshot', async () => {
    initDashboardViewTools(mkViewOps(), mkWidgetOps());
    const r = await dispatchDashboardWidgetInvoke({ id: 'wd-agent-roster', key: 'right' });
    expect(r.output).toContain('wd-agent-roster');
    expect(r.output).toContain('← right');
    expect(r.output).toContain('handled: true');
    expect(r.output).toContain('cursor');
  });

  test('throws for unknown widget id', async () => {
    initDashboardViewTools(mkViewOps(), mkWidgetOps());
    await expect(dispatchDashboardWidgetInvoke({ id: 'unknown', key: 'r' })).rejects.toThrow(/unknown id/);
  });

  test('encodes modifier keys into the audit line', async () => {
    let received: { name: string; ctrl?: boolean; shift?: boolean } | null = null;
    initDashboardViewTools(mkViewOps(), mkWidgetOps({
      sendKey: (_id, name, mods) => {
        received = { name, ...mods };
        return { ok: true, handled: true };
      },
    }));
    const r = await dispatchDashboardWidgetInvoke({ id: 'wd-agent-roster', key: '4', ctrl: true });
    expect(received).toEqual({ name: '4', ctrl: true, shift: false, alt: false });
    expect(r.output).toContain('+C');
  });

  test('requires id and key args', async () => {
    initDashboardViewTools(mkViewOps(), mkWidgetOps());
    await expect(dispatchDashboardWidgetInvoke({ id: '', key: 'r' })).rejects.toThrow(/'id' is required/);
    await expect(dispatchDashboardWidgetInvoke({ id: 'x', key: '' })).rejects.toThrow(/'key' is required/);
  });
});
