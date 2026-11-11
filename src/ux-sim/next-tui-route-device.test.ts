import { describe, expect, test } from 'bun:test';
import { NEXT_TUI_INPUT_CONTEXT, NEXT_TUI_ROUTE_REGISTRY } from '../tui/core/registry.js';
import { simulateNextTuiHelp, simulateNextTuiRoute } from './next-tui-route-device.js';

describe('next TUI route device', () => {
  test('routes slash commands and fixed natural language through the production registry', () => {
    expect(simulateNextTuiRoute('/help')?.id).toBe('help.next');
    expect(simulateNextTuiRoute('도움말')?.id).toBe('help.next');
    expect(simulateNextTuiRoute('/quit')?.id).toBe('session.quit');
    expect(simulateNextTuiRoute('오늘 날씨 알려줘')).toBeNull();
  });

  test('applies role and maturity gates and leaves unknown input unrouted', () => {
    expect(simulateNextTuiRoute('/side', { ...NEXT_TUI_INPUT_CONTEXT, role: 'general' })).toBeNull();
    expect(simulateNextTuiRoute('/side')?.id).toBe('sidetab');
    expect(simulateNextTuiRoute('/help', { ...NEXT_TUI_INPUT_CONTEXT, maturity: 'experimental' })).toBeNull();
    expect(simulateNextTuiRoute('/not-a-command')).toBeNull();
  });

  test('keeps all implemented command families in the single table', () => {
    for (const [input, action] of [
      ['/session new', 'session.new'], ['/clear', 'session.new'], ['/compact', 'session.compact'], ['/resume abc', 'session.resume'],
      ['/loop stop', 'loop'], ['/model fast', 'model'], ['/provider switch', 'model'], ['/harness runs', 'harness'],
      ['/sidetab close', 'sidetab'], ['/terminal help', 'terminal'], ['/signals status', 'signals'],
    ] as const) {
      expect(simulateNextTuiRoute(input)?.id).toBe(action);
    }
  });

  test('/harness ask and runs resolve through the registered lazy harness branch', () => {
    const harness = simulateNextTuiRoute('/harness ask 목표');
    expect(harness).toMatchObject({
      id: 'harness',
      branchHost: 'harness',
      branchModule: './branches/harness.js',
      slashPrefixes: ['/harness'],
    });
    expect(simulateNextTuiRoute('/harness runs')).toBe(harness);
    expect(simulateNextTuiHelp().join('\n')).toContain('/harness — 하니스 명령');
  });

  test('projects enabled registry commands into help, including a newly plugged route', () => {
    const pluggedRoute = {
      id: 'feature.new', action: 'command', slash: ['/new-feature'], slashPrefixes: [], phrases: [],
      roles: ['human'], minimumMaturity: 'stable', requiredFlags: [],
    } as const;
    const help = simulateNextTuiHelp(NEXT_TUI_INPUT_CONTEXT, [...NEXT_TUI_ROUTE_REGISTRY, pluggedRoute]).join('\n');
    expect(help).toContain('/new-feature');
    expect(help).toContain('/signals — 신호 확인');
    expect(help).toContain('Keys');
  });

  test('omits routes disabled by role, maturity, or flags', () => {
    const gatedRoute = {
      id: 'feature.gated', action: 'command', slash: ['/gated'], slashPrefixes: [], phrases: [],
      roles: ['human'], minimumMaturity: 'beta', requiredFlags: ['feature-gated'],
    } as const;
    const routes = [...NEXT_TUI_ROUTE_REGISTRY, gatedRoute];
    expect(simulateNextTuiHelp({ ...NEXT_TUI_INPUT_CONTEXT, role: 'general' }, routes).join('\n')).not.toContain('/gated');
    expect(simulateNextTuiHelp({ ...NEXT_TUI_INPUT_CONTEXT, maturity: 'experimental', flags: new Set(['feature-gated']) }, routes).join('\n')).not.toContain('/gated');
    expect(simulateNextTuiHelp({ ...NEXT_TUI_INPUT_CONTEXT, maturity: 'beta' }, routes).join('\n')).not.toContain('/gated');
    expect(simulateNextTuiHelp({ ...NEXT_TUI_INPUT_CONTEXT, maturity: 'beta', flags: new Set(['feature-gated']) }, routes).join('\n')).toContain('/gated');
  });
});
