import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { registerDashboardLayoutDisplayRuntimes } from '../src/dashboard/layout-display-runtime-registration.js';

describe('registerDashboardLayoutDisplayRuntimes', () => {
  test('dashboard boot reaches the display-only registration without retired VW boot imports or calls', () => {
    const boot = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url), 'utf8');
    const registration = readFileSync(new URL('../src/dashboard/layout-display-runtime-registration.ts', import.meta.url), 'utf8');
    expect(boot).toContain("import { registerDashboardLayoutDisplayRuntimes } from './layout-display-runtime-registration.js'");
    expect(boot).toContain('registerDashboardLayoutDisplayRuntimes({');
    expect(boot).not.toMatch(/\b(?:initVirtualWindowTools|registerLayoutRuntimes)\s*\(/);
    expect(boot).not.toMatch(/(?:skills\/tools\/virtual-windows|tool-runtime\/layout-runtimes)\.js/);
    expect(registration).toContain("import { registerDisplayControlRuntimes } from '../tool-runtime/display-control-runtimes.js'");
    expect(registration).not.toMatch(/\bregisterLayoutRuntimes\b|layout-runtimes\.js/);
  });

  test('registers display-control without a virtual-window registry or layout runtime', () => {
    const displayCalls: unknown[] = [];
    const coordinator = { kind: 'display-coordinator' };
    const mouseDispatch = () => true;
    const menuProviderRegistry = { kind: 'menu-provider-registry' };
    const contextMenuRegistry = { kind: 'context-menu-registry' };
    const tooltipResolver = () => null;

    registerDashboardLayoutDisplayRuntimes({
      coordinator: coordinator as never,
      mouseDispatch: mouseDispatch as never,
      menuProviderRegistry: menuProviderRegistry as never,
      contextMenuRegistry: contextMenuRegistry as never,
      tooltipResolver: tooltipResolver as never,
      registerDisplayControl: ((opts) => { displayCalls.push(opts); }) as never,
    });

    expect(displayCalls).toEqual([{
      coordinator,
      mouseDispatch,
      menuProviderRegistry,
      contextMenuRegistry,
      tooltipResolver,
    }]);
  });
});
