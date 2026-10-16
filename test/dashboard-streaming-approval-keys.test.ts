import { describe, expect, test } from 'bun:test';

import type { ApprovalModalHandle, ApprovalModalRouter } from '../src/approval-modal.js';
import { routeStreamingApprovalModalKey } from '../src/dashboard/index.js';
import type { Key } from '../src/tui.js';
import { tuiSourceText } from './helpers/dashboard-source.js';

function key(name: string): Key {
  return { name, ctrl: false, shift: false };
}

function router(current: ApprovalModalHandle | null, handleKey?: (event: unknown) => 'consumed' | 'passthrough'): {
  router: ApprovalModalRouter;
  events: unknown[];
} {
  const events: unknown[] = [];
  return {
    events,
    router: {
      current: () => current,
      currentKind: () => current ? 'approval' : null,
      set: () => false,
      handleKey: (event) => {
        events.push(event);
        return handleKey?.(event) ?? (current ? 'consumed' : 'passthrough');
      },
      _resetForTesting: () => {},
    },
  };
}

describe('dashboard streaming approval and question keys', () => {
  test('routes question navigation and confirmation keys through the active modal router', () => {
    const active = {} as ApprovalModalHandle;
    const t = router(active);

    expect(routeStreamingApprovalModalKey(key('down'), t.router)).toBe(true);
    expect(routeStreamingApprovalModalKey(key('enter'), t.router)).toBe(true);
    expect(t.events).toEqual([
      { name: 'down', ctrl: false, shift: false, alt: false, sequence: undefined },
      { name: 'enter', ctrl: false, shift: false, alt: false, sequence: undefined },
    ]);
  });

  test('routes approval navigation and confirmation keys through the active modal router', () => {
    const active = {} as ApprovalModalHandle;
    const t = router(active);

    expect(routeStreamingApprovalModalKey(key('left'), t.router)).toBe(true);
    expect(routeStreamingApprovalModalKey(key('y'), t.router)).toBe(true);
    expect(t.events).toHaveLength(2);
  });

  test('passes through when no approval or question modal is active', () => {
    const t = router(null);

    expect(routeStreamingApprovalModalKey(key('down'), t.router)).toBe(false);
    expect(t.events).toEqual([]);
  });

  test('keeps the active interrupt confirmation ahead of the approval router in production streaming wiring', () => {
    const source = tuiSourceText();
    const start = source.indexOf('const cleanup = attachStreamingKeys(async (key) => {');
    const end = source.indexOf('await runStreamingKeyUnifiedDispatch(key);', start);
    const handler = source.slice(start, end);

    expect(handler.indexOf('routeStreamingEscapeKey(')).toBeGreaterThanOrEqual(0);
    expect(handler.indexOf('routeStreamingApprovalModalKey(key)')).toBeGreaterThan(handler.indexOf('routeStreamingEscapeKey('));
    expect(handler).toContain('if (routeStreamingApprovalModalKey(key)) return;');
  });

  test('consumes a throwing active modal key before hard-quit and unified streaming dispatch', () => {
    const active = {} as ApprovalModalHandle;
    const throwing = router(active, () => { throw new Error('modal failure'); });
    const healthy = router(active);
    const source = tuiSourceText();
    const start = source.indexOf('const cleanup = attachStreamingKeys(async (key) => {');
    const end = source.indexOf('await runStreamingKeyUnifiedDispatch(key);', start);
    const handler = source.slice(start, end);

    expect(() => routeStreamingApprovalModalKey(key('down'), throwing.router)).not.toThrow();
    expect(routeStreamingApprovalModalKey(key('down'), throwing.router)).toBe(true);
    expect(handler).toContain('if (routeStreamingApprovalModalKey(key)) return;');
    expect(handler.indexOf('if (routeStreamingApprovalModalKey(key)) return;')).toBeLessThan(handler.indexOf('if (key.ctrl && (key.name === \'q\' || key.name === \'ㅂ\'))'));
    expect(routeStreamingApprovalModalKey(key('enter'), healthy.router)).toBe(true);
    expect(healthy.events).toHaveLength(1);
  });
});
