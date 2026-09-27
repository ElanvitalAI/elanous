import { describe, test, expect, beforeEach } from 'bun:test';
import {
  buildContextTools,
  dispatchContextWorkspace,
  dispatchContextPtysList,
  dispatchContextSessionsList,
  dispatchContextToolsList,
  dispatchContextEventsTail,
  dispatchContextBootstrap,
} from '../src/skills/tools/context.js';
import { ALL_CONTEXT_RUNTIMES } from '../src/tool-runtime/context-runtime.js';
import {
  getGlobalElementEventBus,
  _resetGlobalElementEventBusForTesting,
  _resetGlobalElementStateStoreForTesting,
  initElementObservability,
  publishElementEvent,
} from '../src/element-registry/index.js';
import { _teardownElementObservabilityForTesting } from '../src/element-registry/observability.js';

beforeEach(() => {
  _teardownElementObservabilityForTesting();
  _resetGlobalElementEventBusForTesting();
  _resetGlobalElementStateStoreForTesting();
  initElementObservability();
});

describe('skill-tool-context / buildContextTools', () => {
  test('returns expected number of specs', () => {
    const specs = buildContextTools();
    expect(specs).toHaveLength(9);
    expect(new Set(specs.map(s => s.name)).size).toBe(9);
    expect(ALL_CONTEXT_RUNTIMES.map(rt => rt.spec.name)).toEqual(specs.map(s => s.name));
    expect(specs.some(s => s.name === 'ContextWorkspace')).toBe(true);
    expect(specs.some(s => s.name === 'ContextBootstrap')).toBe(true);
  });
});

describe('skill-tool-context / dispatchers', () => {
  test('workspace returns cwd + platform', async () => {
    const r = await dispatchContextWorkspace({}, { cwd: '/tmp/x' });
    expect(r.workspace.cwd).toBe('/tmp/x');
    expect(r.workspace.platform).toBe(process.platform);
    expect(r.output).toContain('cwd=/tmp/x');
  });

  test('ptys.list reads from PTY registry (empty in test env)', async () => {
    const r = await dispatchContextPtysList();
    expect(Array.isArray(r.ptys)).toBe(true);
  });

  test('sessions.list passes through getter', async () => {
    const r = await dispatchContextSessionsList({}, {
      getTerminalSessions: () => [
        { id: 'abc', title: 'codex', state: 'foreground' },
      ],
    });
    expect(r.sessions[0]!.addr).toBe('sess:abc');
    expect(r.output).toContain('sess:abc');
  });

  test('tools.list returns catalog entries (default all)', async () => {
    const r = await dispatchContextToolsList({});
    expect(r.tools.length).toBeGreaterThan(0);
    expect(r.tools.some(t => t.id === 'context_workspace')).toBe(true);
  });

  test('tools.list filters by host and returns host membership', async () => {
    const r = await dispatchContextToolsList({ host: 'mcp' });
    expect(r.tools.every(t => t.host.includes('mcp') || t.host.includes('all'))).toBe(true);
    expect(r.tools.every(t => !('surface' in t))).toBe(true);
  });

  test('events.tail returns entries from the live bus', async () => {
    publishElementEvent('pty', 'x', 'create');
    publishElementEvent('pty', 'x', 'output', { bytes: 3 });
    const r = await dispatchContextEventsTail({ kinds: ['pty'], limit: 10 });
    expect(r.events.length).toBeGreaterThanOrEqual(2);
    expect(r.events[0]!.addr).toBe('pty:x');
  });

  test('bootstrap aggregates the core listings', async () => {
    const r = await dispatchContextBootstrap({}, {
      cwd: '/tmp/y',
      getTerminalSessions: () => [],
    });
    expect(r.output).toContain('cwd=/tmp/y');
    expect(r.workspace).toBeDefined();
    expect(r).not.toHaveProperty('windows');
    expect(r.output).not.toContain('windows:');
    expect(Array.isArray(r.tools)).toBe(true);
  });
});
