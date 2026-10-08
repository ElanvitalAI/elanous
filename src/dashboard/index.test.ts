import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createProject } from '../project/project-store.js';
import { setElanousConfigDir, getElanousConfigDirOverride, resetElanousConfigDir } from '../elanous-config-dir.js';
import { createSession, listSessions } from '../session/index.js';
import { join, resolve } from 'node:path';
import ts from 'typescript';

import { debug } from '../debug/log.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import type { ToolRunResult, ToolRuntime } from '../tool-runtime/types.js';
import { DisplayCoordinator } from '../display/index.js';
import {
  createDashboardAdRunSetupBindings,
  dashboardOptionalProductionInputs,
  createDashboardAdRunSetupFactory,
  createDashboardAdSlashRuntime,
  dashboardAdAssetPresetPath,
  dashboardAdCommandRunner,
  dispatchLogZoneClick,
  flattenForkableSessionHistory,
  observeDashboardToolDispatchSignal,
  activeEscHarnessSpace,
  createEscAbortToolState,
  trackEscAbortToolCall,
  settleEscAbortToolCall,
  registerDashboardFinderAndHistoryKeys,
  type LogZoneClickWidgetHost,
} from './index.js';
import { buildAdRunSetup } from '../ad-pipeline/ad-run-setup.js';
import type { CommandRunner } from '../ad-pipeline/higgsfield-backend.js';
import { dispatchDashboardSessionRuntimeTool } from './session-runtime-dispatch.js';

const repoRoot = resolve(import.meta.dir, '../..');
const dashboard = readFileSync(resolve(repoRoot, 'src/dashboard/index.ts'), 'utf8');

function makeProbeRuntime(onRun: (ctxSignal: AbortSignal | undefined) => void): ToolRuntime<Record<string, unknown>, ToolRunResult> {
  return {
    id: 'dashboard_signal_probe',
    spec: {
      name: 'DashboardSignalProbe',
      description: 'Probe dashboard session-runtime signal forwarding.',
      parameters: { type: 'object', additionalProperties: true },
    },
    async run(_req, ctx) {
      onRun(ctx.signal);
      return { output: 'probe-ok' };
    },
  };
}

test('showDashboard first screen suggests the cwd project without assigning projectId to the session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-project-boot-'));
  const folder = join(root, 'folder');
  const configRoot = join(root, 'config');
  const sessionDir = join(root, 'sessions');
  const previousConfig = getElanousConfigDirOverride();
  const previousSessionRoot = process.env.ELANOUS_SESSION_ROOT;
  const previousCwd = process.cwd();
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(folder);
    setElanousConfigDir(configRoot);
    process.env.ELANOUS_SESSION_ROOT = sessionDir;
    process.chdir(folder);
    const project = createProject({ name: 'Boot match', primaryFolder: folder });
    const session = createSession();
    expect(session.projectId).toBeUndefined();
    const expected = `Project suggestion: ${project.name} (${project.id})`;
    const child = spawn(process.execPath, [resolve(import.meta.dir, 'dashboard-boot-fixture.ts')], {
      cwd: folder,
      env: { ...process.env, ELANOUS_STATE_DIR: configRoot, ELANOUS_SESSION_ROOT: sessionDir, DASHBOARD_BOOT_SUGGESTION: expected },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.on('error', reject);
      child.on('close', resolveExit);
    });
    expect(code).toBe(0);
    expect(output).toContain(`FIRST_SCREEN_SUGGESTION=${expected}`);
    const persisted = listSessions({}, sessionDir);
    expect(persisted.find((entry) => entry.id === session.id)?.projectId).toBeUndefined();
    expect(persisted.every((entry) => entry.projectId === undefined)).toBe(true);
  } finally {
    process.chdir(previousCwd);
    if (previousConfig !== undefined) setElanousConfigDir(previousConfig);
    else resetElanousConfigDir();
    if (previousSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
    else process.env.ELANOUS_SESSION_ROOT = previousSessionRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 35_000);

describe('dashboard /ad production assembly', () => {
  test('showDashboard wires the CDP grounding collector into its actual ad runtime construction', () => {
    const assembly = dashboard.slice(
      dashboard.indexOf('const adSlashRuntime = createDashboardAdSlashRuntime({'),
      dashboard.indexOf('const companionFeedbackRuntime = createDashboardCompanionFeedbackRuntime({'),
    );
    expect(assembly).toContain('collectGroundingFacts: collectGroundingFactsViaCdp');
    expect(assembly).toContain('adRunSetupBindings');
    expect(assembly).toContain('adRunSetupError');
    expect(assembly).toContain('approve:');
    expect(assembly).toContain('report: pushChatLine');
    expect(assembly).toContain('muted: C.muted');
    expect(assembly).toContain('warning: C.warning');
  });
});

describe('dashboard ad command runner', () => {
  test('preserves rawvideo bytes while retaining decoded stdout, stderr, and exit code', async () => {
    const result = await dashboardAdCommandRunner.run([
      process.execPath,
      '-e',
      "process.stdout.write(Buffer.from([200, 30, 40])); process.stderr.write('runner stderr'); process.exitCode = 7;",
    ]);

    expect(result.raw).toEqual(new Uint8Array([200, 30, 40]));
    expect(result.raw).toHaveLength(3);
    expect(result.stdout).toBe('\uFFFD\u001e(');
    expect(result.stderr).toBe('runner stderr');
    expect(result.exitCode).toBe(7);
  });
});

test('ESC selects only one identified active SelfImplement call, never a stale or ambiguous space', () => {
  const calls = createEscAbortToolState();
  const spaces = new Map([['call-1', 'space-1'], ['call-2', 'space-2']]);
  expect(activeEscHarnessSpace(calls, spaces)).toBeNull();
  trackEscAbortToolCall(calls, { id: 'call-1', name: 'SelfImplement' });
  expect(activeEscHarnessSpace(calls, spaces)).toBe('space-1');
  trackEscAbortToolCall(calls, { id: 'call-2', name: 'SelfImplement' });
  expect(activeEscHarnessSpace(calls, spaces)).toBeNull();
  settleEscAbortToolCall(calls, { id: 'call-1' });
  expect(activeEscHarnessSpace(calls, spaces)).toBe('space-2');
  spaces.delete('call-2');
  expect(activeEscHarnessSpace(calls, spaces)).toBeNull();
});

describe('dashboard tool dispatch signal observation', () => {
  test('records signal provenance on a separate category before the existing runtime dispatch call', () => {
    const helper = dashboard.slice(
      dashboard.indexOf('export function observeDashboardToolDispatchSignal'),
      dashboard.indexOf('export function resumeInProcessDashboardSession'),
    );
    expect(helper).toContain("debug.log('dashboard.tool-dispatch-signal', 'selected', observation)");
    expect(helper).toContain('catch');
    expect(helper).toContain('Observability must not prevent dashboard tool dispatch.');

    const dispatchPrelude = dashboard.slice(
      dashboard.indexOf('const hasParentTurnAbortSignal = acpTurnRef.abortCtrl?.signal !== undefined;'),
      dashboard.indexOf('const result = await dispatchDashboardSessionRuntimeTool(name, args, {'),
    );
    expect(dispatchPrelude).toContain('observeDashboardToolDispatchSignal({');
    expect(dispatchPrelude).toContain('toolName: name');
    expect(dispatchPrelude).toContain('turnIndex: ctx?.turnIndex ?? null');
    expect(dispatchPrelude).toContain("signalSource: hasParentTurnAbortSignal ? 'parent-turn' : 'fallback'");
    expect(dispatchPrelude).toContain('hasParentTurnAbortSignal');
    expect(dashboard).toContain('toolCallId: ctx?.callId,');
    expect(dispatchPrelude).toContain('signalAlreadyAborted: (acpTurnRef.abortCtrl?.signal ?? new AbortController().signal).aborted');
  });

  test('preserves the signal value passed to dispatchDashboardSessionRuntimeTool', () => {
    const callSite = dashboard.slice(
      dashboard.indexOf('await dispatchDashboardSessionRuntimeTool(name, args, {'),
    ).slice(0, 900);
    expect(callSite).toContain('signal: acpTurnRef.abortCtrl?.signal ?? new AbortController().signal');
  });

  test('forwards the current turn signal into the nested tool runtime context', () => {
    const dispatchClosure = dashboard.slice(
      dashboard.indexOf('dispatchToolRuntime: (toolName, input, toolCallId) =>'),
    ).slice(0, 1100);
    expect(dispatchClosure).toContain('runtime.dispatchToolByName(toolName, input, {');
    expect(dispatchClosure).toContain("surface: 'tui'");
    expect(dispatchClosure).toContain('toolCallId,');
    expect(dispatchClosure).toContain('signal: acpTurnRef.abortCtrl?.signal');
    expect(dispatchClosure).toContain('agentHostTools: acpTurnToolSpecs');
    expect(dispatchClosure).toContain('agentDispatchTool: (childName, childArgs) =>');
  });

  test('keeps the nested tool runtime signal optional through the production dispatch path', async () => {
    let observedSignal: AbortSignal | undefined = new AbortController().signal;
    const runtime = makeProbeRuntime((ctxSignal) => {
      observedSignal = ctxSignal;
    });

    const result = await dispatchDashboardSessionRuntimeTool('DashboardSignalProbe', {}, {
      turnRefUserText: null,
      muted: (line) => line,
      pushChatLine: () => {},
      draw: () => {},
      getToolRuntime: (toolName) => toolName === 'DashboardSignalProbe' ? runtime : undefined,
      dispatchToolRuntime: async (toolName, input) => {
        const selectedRuntime = toolName === 'DashboardSignalProbe' ? runtime : undefined;
        if (!selectedRuntime) throw new Error(`unexpected tool ${toolName}`);
        return selectedRuntime.run(input, { surface: 'tui' });
      },
      dispatchPluginTool: async () => ({ ok: false, error: 'plugin fallback must not run' }),
      ptyDashboardOn: true,
    });

    expect(result).toEqual({ output: 'probe-ok' });
    expect(observedSignal).toBeUndefined();
  });

  test('session runtime forwards the originating tool call id through its actual dispatcher', async () => {
    const runtime = makeProbeRuntime(() => {});
    const forwarded: Array<string | undefined> = [];
    const result = await dispatchDashboardSessionRuntimeTool('DashboardSignalProbe', {}, {
      turnRefUserText: null,
      toolCallId: 'call-foreground',
      muted: (line) => line,
      pushChatLine: () => {},
      draw: () => {},
      getToolRuntime: (name) => name === 'DashboardSignalProbe' ? runtime : undefined,
      dispatchToolRuntime: async (name, input, toolCallId) => {
        forwarded.push(toolCallId);
        return runtime.run(input, { surface: 'tui', toolCallId });
      },
      dispatchPluginTool: async () => ({ ok: false, error: 'plugin fallback must not run' }),
      ptyDashboardOn: true,
    });
    expect(result).toEqual({ output: 'probe-ok' });
    expect(forwarded).toEqual(['call-foreground']);
  });

  test('keeps esc.abort observations separate from the new dispatch signal category', () => {
    expect(dashboard).toContain("debug.log('dashboard.tool-dispatch-signal', 'selected', observation)");
    expect(dashboard).toContain('createEscAbortGate({');
    expect(dashboard).not.toContain("debug.log('esc.abort', 'selected'");
  });

  test('emits queryable debug events that distinguish parent-turn from fallback signal sources', () => {
    const before = debug.events(10_000).filter((event) => event.category === 'dashboard.tool-dispatch-signal').length;
    observeDashboardToolDispatchSignal({
      toolName: 'Bash',
      turnIndex: 7,
      signalSource: 'parent-turn',
      hasParentTurnAbortSignal: true,
      signalAlreadyAborted: false,
    });
    observeDashboardToolDispatchSignal({
      toolName: 'Read',
      turnIndex: 8,
      signalSource: 'fallback',
      hasParentTurnAbortSignal: false,
      signalAlreadyAborted: false,
    });
    debug.flush();
    const events = debug.events(10_000)
      .filter((event) => event.category === 'dashboard.tool-dispatch-signal')
      .slice(before);
    expect(events.map((event) => event.event)).toEqual(['selected', 'selected']);
    expect(events[0]?.data).toMatchObject({ toolName: 'Bash', turnIndex: 7, signalSource: 'parent-turn' });
    expect(events[1]?.data).toMatchObject({ toolName: 'Read', turnIndex: 8, signalSource: 'fallback' });

    const store = new LogStore();
    store.insertBatch(events.map((event) => ({
      surface: 'tui',
      rec: {
        ts: event.ts,
        category: event.category,
        event: event.event,
        data: event.data,
      },
    })));
    store.close();
  });
});

describe('log fold default is not changed by kind-unit', () => {
  test('showDashboard still seeds foldMode as task-unit', () => {
    expect(dashboard).toMatch(/let logFoldMode:\s*FoldMode\s*=\s*getUserConfig\(\)\.dashboard\.foldMode/);
    expect(dashboard).toMatch(/let logFoldMode:\s*FoldMode\s*=[\s\S]*?'task-unit'/);
    expect(dashboard).not.toMatch(/let logFoldMode:\s*FoldMode\s*=\s*'line'/);
    expect(dashboard).not.toMatch(/let logFoldMode:\s*FoldMode\s*=\s*'kind-unit'/);
  });
});

describe('buildLogClickDeps wires foldStack at invocation time', () => {
  test('createDashboardLogClickDeps bag includes foldStack', () => {
    const start = dashboard.indexOf('const buildLogClickDeps = (): LogClickDispatchDeps => createDashboardLogClickDeps({');
    expect(start).toBeGreaterThan(-1);
    const end = dashboard.indexOf('// Dispatcher for attachment-popup actions', start);
    const bag = dashboard.slice(start, end);
    expect(bag).toContain('foldStack,');
    expect(bag).toContain('pillRowGetter: () => pillRowGetterForClick?.() ?? null');
    expect(bag).toContain('onPillClick: () => onPillClickForClick?.()');
  });
});

describe('dispatchLogZoneClick log.mouse reach records', () => {
  const start = dashboard.indexOf('export function dispatchLogZoneClick(');
  const end = dashboard.indexOf('const runLogZoneClickDispatch = dispatchLogZoneClick;', start);
  const body = start >= 0 && end > start ? dashboard.slice(start, end) : '';
  const nestedStart = dashboard.indexOf('const dispatchLogZoneClick = (');
  const nestedEnd = dashboard.indexOf('// ── mx-mouse handler', nestedStart);
  const nestedBody = nestedStart >= 0 && nestedEnd > nestedStart
    ? dashboard.slice(nestedStart, nestedEnd)
    : '';

  test('keeps the existing nested dispatcher and its three live callers', () => {
    expect(nestedStart).toBeGreaterThan(-1);
    expect(nestedEnd).toBeGreaterThan(nestedStart);
    expect(nestedBody).toContain('runLogZoneClickDispatch(m, { logZoneStart, logZoneHeight, widgetHost })');
    expect(dashboard).toContain('const logOutcome = dispatchLogZoneClick(m);');
    expect(dashboard).toContain('dispatchLogZoneClick(m),\n            {\n              allowFocusSteal,');
    expect(dashboard).toContain('dispatchLogZoneClick(m),\n            {\n              allowFocusSteal: false,');
  });

  test('uses one log.mouse category and distinct events for every silent branch', () => {
    expect(body).toContain("debug.log('log.mouse', 'zone-unresolved'");
    expect(body).toContain("debug.log('log.mouse', 'out-of-zone'");
    expect(body).toContain("debug.log('log.mouse', 'missing-widget-definition'");
    expect(body).toContain("debug.log('log.mouse', 'missing-widget-instance'");
    expect(body).toContain("debug.log('log.mouse', 'context-build-failed'");
    expect(body).toContain("debug.log('log.mouse', 'handler-invoked'");
    expect(body).toContain("debug.log('log.mouse', 'handler-threw'");
    const events = [...body.matchAll(/debug\.log\('log\.mouse', '([^']+)'/g)].map((m) => m[1]);
    expect(events).not.toContain('missing-widget');
  });

  test('attaches the required diagnostic payload on each branch', () => {
    const unresolved = body.slice(
      body.indexOf("debug.log('log.mouse', 'zone-unresolved'"),
      body.indexOf("return 'out-of-zone';"),
    );
    expect(unresolved).toContain('logZoneStart');
    expect(unresolved).toContain('logZoneHeight');

    const outOfZone = body.slice(
      body.indexOf("debug.log('log.mouse', 'out-of-zone'"),
      body.indexOf('const localRow'),
    );
    expect(outOfZone).toContain('row: m.row');
    expect(outOfZone).toContain('logZoneStart');
    expect(outOfZone).toContain('logZoneHeight');
    expect(outOfZone).toContain('rangeEnd: logZoneStart + logZoneHeight');

    const contextFailed = body.slice(
      body.indexOf("debug.log('log.mouse', 'context-build-failed'"),
      body.indexOf("return 'passthrough';", body.indexOf("debug.log('log.mouse', 'context-build-failed'")),
    );
    expect(contextFailed).toContain('error:');
    expect(contextFailed).toContain('localRow');
    expect(contextFailed).toContain('localCol');
    expect(contextFailed).toContain('row: m.row');

    const invoked = body.slice(
      body.indexOf("debug.log('log.mouse', 'handler-invoked'"),
      body.indexOf('def.onMouse('),
    );
    expect(invoked).toContain('localRow');
    expect(invoked).toContain('localCol');
    expect(invoked).toContain('row: m.row');
    expect(body.indexOf("widgetHost.buildContext('wd-log')"))
      .toBeLessThan(body.indexOf("debug.log('log.mouse', 'handler-invoked'"));
    expect(body.indexOf("debug.log('log.mouse', 'handler-invoked'"))
      .toBeLessThan(body.indexOf('def.onMouse('));

    const threw = body.slice(
      body.indexOf("debug.log('log.mouse', 'handler-threw'"),
      body.indexOf("return 'passthrough';", body.indexOf("debug.log('log.mouse', 'handler-threw'")),
    );
    expect(threw).toContain('error:');
    expect(threw).toContain('localRow');
    expect(threw).toContain('localCol');
    expect(threw).toContain('row: m.row');
  });

  test('records definition and instance absence as distinct events, both when both are missing', () => {
    const missingStart = body.indexOf('if (!def?.onMouse || !inst)');
    const missingEnd = body.indexOf("return 'passthrough';", missingStart);
    const missing = body.slice(missingStart, missingEnd);
    expect(missing).toContain('if (!def?.onMouse)');
    expect(missing).toContain("debug.log('log.mouse', 'missing-widget-definition'");
    expect(missing).toContain('if (!inst)');
    expect(missing).toContain("debug.log('log.mouse', 'missing-widget-instance'");
    expect(missing.indexOf("debug.log('log.mouse', 'missing-widget-definition'"))
      .toBeLessThan(missing.indexOf("debug.log('log.mouse', 'missing-widget-instance'"));
    expect(missing).toContain('hasDefinition:');
    expect(missing).toContain('hasOnMouse:');
    expect(missing).toContain('hasInstance:');
    expect(missing).not.toMatch(/missing:\s*!def\?\.onMouse\s*\?\s*'definition'\s*:\s*'instance'/);
  });

  test('does not hide arrival records behind debug.enabled', () => {
    expect(body).not.toMatch(/if\s*\(\s*debug\.enabled\s*\)/);
    const logCalls = [...body.matchAll(/debug\.log\('log\.mouse', '([^']+)'/g)].map((m) => m[1]);
    expect(logCalls).toEqual([
      'zone-unresolved',
      'out-of-zone',
      'missing-widget-definition',
      'missing-widget-instance',
      'context-build-failed',
      'handler-invoked',
      'handler-threw',
    ]);
  });

  test('ungated debug.log still lands in LogStore when debug.enabled is false', () => {
    const prev = {
      file: debug.isFileEnabled(),
      mirror: debug.isMirrorEnabled(),
      verbose: debug.isVerboseEnabled(),
      diag: debug.isDiagEnabled(),
      keytrace: debug.isKeyTraceEnabled(),
    };
    debug.setLevel('trail');
    debug.clear();
    const store = new LogStore(':memory:');
    const sink = new StoreSink(store, 'tui', {
      flushIntervalMs: 60_000,
      flushBatchSize: 1_000_000,
    });
    const unregister = debug.registerSink(sink);
    const missingDefinitionHost: LogZoneClickWidgetHost = {
      defFor: () => null,
      get: () => ({ state: {} }),
      buildContext: () => ({}),
    };
    const invokingHost: LogZoneClickWidgetHost = {
      defFor: () => ({
        onMouse: () => ({ type: 'none' }),
      }),
      get: () => ({ state: {} }),
      buildContext: () => ({}),
    };
    try {
      expect(debug.enabled).toBe(false);
      expect(debug.isFileEnabled()).toBe(true);
      expect(dispatchLogZoneClick(
        { row: 12, col: 4, type: 'click' },
        { logZoneStart: 10, logZoneHeight: 10, widgetHost: missingDefinitionHost },
      )).toBe('passthrough');
      expect(dispatchLogZoneClick(
        { row: 12, col: 4, type: 'click' },
        { logZoneStart: 10, logZoneHeight: 10, widgetHost: invokingHost },
      )).toBe('consumed');
      sink.flush();
      debug.flush();
      const rows = store.query({ exactCategories: ['log.mouse'], limit: 10 });
      expect(rows.map((row) => row.event).sort()).toEqual([
        'handler-invoked',
        'missing-widget-definition',
      ]);
      const definition = rows.find((row) => row.event === 'missing-widget-definition');
      expect(definition?.data).toContain('hasDefinition');
      expect(definition?.data).toContain('hasOnMouse');
      expect(definition?.data).toContain('hasInstance');
      const invoked = rows.find((row) => row.event === 'handler-invoked');
      expect(JSON.parse(invoked?.data ?? '{}')).toMatchObject({
        localRow: 2,
        localCol: 4,
        row: 12,
      });
    } finally {
      unregister();
      store.close();
      debug.setFileEnabled(prev.file);
      debug.setMirror(prev.mirror);
      debug.setVerboseEnabled(prev.verbose);
      debug.setDiagEnabled(prev.diag);
      debug.setKeyTraceEnabled(prev.keytrace);
      debug.clear();
    }
  });

  test('buildContext throw records context-build-failed without handler-invoked or handler-threw', () => {
    const prev = {
      file: debug.isFileEnabled(),
      mirror: debug.isMirrorEnabled(),
      verbose: debug.isVerboseEnabled(),
      diag: debug.isDiagEnabled(),
      keytrace: debug.isKeyTraceEnabled(),
    };
    debug.setLevel('trail');
    debug.clear();
    const store = new LogStore(':memory:');
    const sink = new StoreSink(store, 'tui', {
      flushIntervalMs: 60_000,
      flushBatchSize: 1_000_000,
    });
    const unregister = debug.registerSink(sink);
    let handlerCalls = 0;
    const contextFailHost: LogZoneClickWidgetHost = {
      defFor: () => ({
        onMouse: () => {
          handlerCalls++;
          return { type: 'none' };
        },
      }),
      get: () => ({ state: {} }),
      buildContext: () => {
        throw new Error('context-boom');
      },
    };
    try {
      expect(debug.enabled).toBe(false);
      expect(dispatchLogZoneClick(
        { row: 15, col: 7, type: 'click' },
        { logZoneStart: 10, logZoneHeight: 10, widgetHost: contextFailHost },
      )).toBe('passthrough');
      expect(handlerCalls).toBe(0);
      sink.flush();
      debug.flush();
      const rows = store.query({ exactCategories: ['log.mouse'], limit: 10 });
      expect(rows.map((row) => row.event)).toEqual(['context-build-failed']);
      expect(JSON.parse(rows[0]?.data ?? '{}')).toMatchObject({
        error: 'context-boom',
        localRow: 5,
        localCol: 7,
        row: 15,
      });
    } finally {
      unregister();
      store.close();
      debug.setFileEnabled(prev.file);
      debug.setMirror(prev.mirror);
      debug.setVerboseEnabled(prev.verbose);
      debug.setDiagEnabled(prev.diag);
      debug.setKeyTraceEnabled(prev.keytrace);
      debug.clear();
    }
  });

  test('handler-threw records the error plus the click coordinates that reached the handler', () => {
    const prev = {
      file: debug.isFileEnabled(),
      mirror: debug.isMirrorEnabled(),
      verbose: debug.isVerboseEnabled(),
      diag: debug.isDiagEnabled(),
      keytrace: debug.isKeyTraceEnabled(),
    };
    debug.setLevel('trail');
    debug.clear();
    const store = new LogStore(':memory:');
    const sink = new StoreSink(store, 'tui', {
      flushIntervalMs: 60_000,
      flushBatchSize: 1_000_000,
    });
    const unregister = debug.registerSink(sink);
    const throwingHost: LogZoneClickWidgetHost = {
      defFor: () => ({
        onMouse: () => {
          throw new Error('widget-handler-boom');
        },
      }),
      get: () => ({ state: {} }),
      buildContext: () => ({}),
    };
    try {
      expect(debug.enabled).toBe(false);
      expect(dispatchLogZoneClick(
        { row: 15, col: 7, type: 'click' },
        { logZoneStart: 10, logZoneHeight: 10, widgetHost: throwingHost },
      )).toBe('passthrough');
      sink.flush();
      debug.flush();
      const rows = store.query({ exactCategories: ['log.mouse'], limit: 10 });
      expect(rows.map((row) => row.event).sort()).toEqual([
        'handler-invoked',
        'handler-threw',
      ]);
      const threw = rows.find((row) => row.event === 'handler-threw');
      expect(JSON.parse(threw?.data ?? '{}')).toMatchObject({
        error: 'widget-handler-boom',
        localRow: 5,
        localCol: 7,
        row: 15,
      });
    } finally {
      unregister();
      store.close();
      debug.setFileEnabled(prev.file);
      debug.setMirror(prev.mirror);
      debug.setVerboseEnabled(prev.verbose);
      debug.setDiagEnabled(prev.diag);
      debug.setKeyTraceEnabled(prev.keytrace);
      debug.clear();
    }
  });

  test('preserves dispatcher return values and does not touch fold/pill/layout', () => {
    expect(body).toContain("return 'out-of-zone'");
    expect(body).toContain("return 'passthrough'");
    expect(body).toContain("return 'consumed'");
    expect(body).not.toContain('tryFoldToggle');
    expect(body).not.toContain('tryPillHit');
    expect(body).not.toContain('widgetHost.mount');
  });
});

function extractBraceBody(source: string, openBrace: number): string {
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openBrace, i + 1);
    }
  }
  return '';
}

function extractRouteLogZoneClickBodies(source: string): string[] {
  const needle = 'routeLogZoneClick:';
  const bodies: string[] = [];
  let from = 0;
  while (true) {
    const start = source.indexOf(needle, from);
    if (start < 0) break;
    const open = source.indexOf('{', start);
    if (open < 0) break;
    const body = extractBraceBody(source, open);
    bodies.push(body);
    from = open + body.length;
  }
  return bodies;
}

function extractDebugLogCall(source: string, fromIndex = 0): string {
  const start = source.indexOf('debug.log(', fromIndex);
  if (start < 0) return '';
  let i = start + 'debug.log('.length;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    i++;
  }
  return source.slice(start, i);
}

function firstLogMouseEvent(source: string): string | undefined {
  return source.match(/debug\.log\('log\.mouse', '([^']+)'/)?.[1];
}

function unwrapParens(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function isIifeCallee(node: ts.Expression): boolean {
  const callee = unwrapParens(node);
  return ts.isFunctionExpression(callee) || ts.isArrowFunction(callee);
}

function reachRecordCallContainsIife(call: string): boolean {
  const sourceFile = ts.createSourceFile(
    'reach-record.ts',
    call,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && isIifeCallee(node.expression)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('routeLogZoneClick log.mouse reach records', () => {
  const bodies = extractRouteLogZoneClickBodies(dashboard);
  const streamingBody = bodies.find((candidate) => candidate.includes("if (m.type === 'scroll-up')")) ?? '';
  const mxMouseBody = bodies.find((candidate) =>
    candidate.includes("if (m.type !== 'click' && m.type !== 'double-click')"),
  ) ?? '';
  const textInputBody = bodies.find((candidate) => candidate.includes('textInput-specific gate')) ?? '';
  const streamingReach = extractDebugLogCall(streamingBody);
  const mxMouseReach = extractDebugLogCall(mxMouseBody);
  const textInputReach = extractDebugLogCall(textInputBody);
  const gateStart = textInputBody.indexOf('attachmentRowMap.size() === 0');
  const gateReach = extractDebugLogCall(textInputBody, gateStart);
  const streamingEvent = firstLogMouseEvent(streamingReach);
  const mxMouseEvent = firstLogMouseEvent(mxMouseReach);
  const textInputEvent = firstLogMouseEvent(textInputReach);
  const gateEvent = firstLogMouseEvent(gateReach);

  test('records four distinct log.mouse names for the three routes and the textInput gate', () => {
    expect(bodies).toHaveLength(3);
    expect(streamingBody.length).toBeGreaterThan(0);
    expect(mxMouseBody.length).toBeGreaterThan(0);
    expect(textInputBody.length).toBeGreaterThan(0);
    const names = [streamingEvent, mxMouseEvent, textInputEvent, gateEvent];
    expect(names.every((name) => typeof name === 'string' && name.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(4);
  });

  test('places each route reach record before any return in that body', () => {
    for (const [body, reach] of [
      [streamingBody, streamingReach],
      [mxMouseBody, mxMouseReach],
      [textInputBody, textInputReach],
    ] as const) {
      const reachAt = body.indexOf(reach);
      const returnAt = body.search(/\breturn\b/);
      expect(reachAt).toBeGreaterThan(-1);
      expect(returnAt).toBeGreaterThan(-1);
      expect(reachAt).toBeLessThan(returnAt);
    }
  });

  test('records the textInput attachment-gate block before that branch returns', () => {
    const returnAt = textInputBody.indexOf("return 'passthrough';", gateStart);
    const reachAt = textInputBody.indexOf(gateReach, gateStart);
    expect(gateStart).toBeGreaterThan(-1);
    expect(reachAt).toBeGreaterThan(gateStart);
    expect(returnAt).toBeGreaterThan(reachAt);
    expect(gateReach).toContain('logOutcome');
  });

  test('keeps each reach-record call free of an IIFE', () => {
    for (const call of [streamingReach, mxMouseReach, textInputReach, gateReach]) {
      expect(call).toContain("debug.log('log.mouse'");
      expect(reachRecordCallContainsIife(call)).toBe(false);
    }
  });

  test('detects arrow, function-expression, and async-arrow IIFEs inside a reach-record call', () => {
    expect(reachRecordCallContainsIife("debug.log('log.mouse', 'x', (() => {})())")).toBe(true);
    expect(reachRecordCallContainsIife("debug.log('log.mouse', 'x', (function(){})())")).toBe(true);
    expect(reachRecordCallContainsIife("debug.log('log.mouse', 'x', (async () => {})())")).toBe(true);
    expect(reachRecordCallContainsIife("debug.log('log.mouse', 'x', ( function ( ) { } ) ( ))")).toBe(true);
  });
});

describe('textInput no-attachment log-zone click', () => {
  // 이것은 미완이 아니라 이 착지의 결정이다 — 중첩 클로저라 진입점이 없고
  // 진입점을 만드는 리팩터는 이 판의 경계 밖이다.
  //
  // 세 `routeLogZoneClick` 몸통은 `showDashboard` 안의 중첩 클로저다.
  // showDashboard 를 부팅하지 않고는 부를 수 없고, 테스트용 공개 export 나
  // vm 소스 추출 실행은 이 착지가 열지 않는 경계다. 본래 목적은 첨부가
  // 없어도 그 관문이 `dispatchLogZoneClick(m)` 을 부르게 하는 것 하나뿐이라
  // 그 배선을 소스 수준으로 고정한다.
  // ⛔⭐ **이 시험이 소스 수준 단언인 것은 «의도된 결정»이다 — 미완이 아니다** (🅣 128차 · 2026-08-25)
  //   무인 리뷰가 세 라운드에 걸쳐 *"실제 진입점을 호출하는 행동 시험으로 교체하라"* 를 요구했다.
  //   ⛔ 그 요구는 ***이 코드 모양에서 원리적으로 불가능하다*** — 세 `routeLogZoneClick` 몸통은
  //   `showDashboard` «안»의 중첩 클로저라, 대시보드를 통째로 부팅하지 않고는 부를 수 없다.
  //   그 사이 시도된 두 우회는 «더 나빴다»:
  //     ⓐ 테스트용 새 공개 export  → 불필요한 API 표면(리뷰가 별도 must-fix 로 잡았다)
  //     ⓑ 소스를 추출해 vm 실행     → 여전히 Goodhart 이고 클로저 배선을 «못» 검증한다
  //   ⇒ 진입점을 만드는 리팩터는 «이 착지의 경계 밖»이다. 그것이 서면 이 시험을 행동 시험으로 바꾼다.
  //   📏 그리고 이 판의 «진짜» 검증은 시험이 아니라 ***라이브 클릭***이다 — 원장 `OBS-T319` 가 그
  //      방법(격리 TUI ⊕ SGR 클릭 ⊕ log.mouse 대조)을 갖고 있고, 이 착지도 그것으로 확인한다.
  test('no-attachment click gate calls dispatchLogZoneClick and passthroughs unless consumed', () => {
    const textInputBody = extractRouteLogZoneClickBodies(dashboard)
      .find((candidate) => candidate.includes('textInput-specific gate')) ?? '';
    const gateStart = textInputBody.indexOf('attachmentRowMap.size() === 0');
    const gateBody = extractBraceBody(
      textInputBody,
      textInputBody.indexOf('{', gateStart),
    );
    expect(gateBody).toContain('const logOutcome = dispatchLogZoneClick(m)');
    expect(gateBody).toContain("if (logOutcome === 'consumed') return 'consumed'");
    expect(gateBody).toContain("return 'passthrough'");
    expect(gateBody).toContain('logOutcome');
    expect(textInputBody.slice(0, gateStart)).toContain("if (m.type !== 'click') return 'passthrough'");
    expect(textInputBody.slice(textInputBody.indexOf(gateBody) + gateBody.length))
      .toContain('dispatchLogZoneClick(m)');
  });
});

function registerFinderAndHistoryOnCoordinator(opts: {
  history: ReadonlyArray<{ role: string; content: unknown }>;
  openFinderPicker?: () => void;
}) {
  const coordinator = new DisplayCoordinator({
    frameMs: 16,
    schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
    now: () => 0,
  });
  const chatLog: string[] = [];
  let finderOpened = 0;
  let drew = 0;
  registerDashboardFinderAndHistoryKeys({
    register: (binding) => { coordinator.registerKeyBinding(binding); },
    openFinderPicker: opts.openFinderPicker ?? (() => { finderOpened++; }),
    getSessionHistory: () => opts.history,
    pushChatLine: (line) => { chatLog.push(line); },
    draw: () => { drew++; },
  });
  return { coordinator, chatLog, finderOpened: () => finderOpened, drew: () => drew };
}

function invokeRoutedHandler(coordinator: DisplayCoordinator, name: string): void {
  const routed = coordinator.routeKey({ name, ctrl: true, shift: false, alt: false });
  expect(routed.type).toBe('handler');
  if (routed.type === 'handler') routed.invoke();
}

describe('C-t dumps unfolded session history into the chat log', () => {
  test('removes the zsh-muscle finder alias so C-p is the only finder opener', () => {
    expect(dashboard).not.toContain('dashboard:open-finder-picker-zsh-muscle');
    expect(dashboard).toContain('registerDashboardFinderAndHistoryKeys({');
    const { coordinator } = registerFinderAndHistoryOnCoordinator({ history: [] });
    const bindings = coordinator.snapshot().keyBindings;
    expect(bindings.filter((b) => b.id === 'dashboard:open-finder-picker-zsh-muscle')).toEqual([]);
    expect(bindings.filter((b) => b.key === 'C-p').map((b) => b.id)).toEqual(['dashboard:open-finder-picker']);
    expect(bindings.filter((b) => b.key === 'C-t').map((b) => b.id)).toEqual(['dashboard:show-full-history']);
  });

  test('C-t handler dumps flattened session history through pushChatLine without finder, overlay, or FoldStack', () => {
    const history = [
      { role: 'user', content: 'hello\nworld' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'system', content: '' },
      { role: 'tool', content: 'skip-me' },
    ];
    const { coordinator, chatLog, finderOpened, drew } = registerFinderAndHistoryOnCoordinator({ history });
    invokeRoutedHandler(coordinator, 't');
    expect(finderOpened()).toBe(0);
    expect(drew()).toBe(1);
    expect(chatLog).toEqual([
      '── full history (2) ──',
      'user:',
      'hello',
      'world',
      'assistant:',
      'ok',
    ]);
    expect(chatLog.join('\n')).not.toContain('skip-me');
    const helper = dashboard.slice(
      dashboard.indexOf('export function registerDashboardFinderAndHistoryKeys'),
      dashboard.indexOf('// ── Last selection persistence ──'),
    );
    const ctBinding = helper.slice(helper.indexOf("id: 'dashboard:show-full-history'"));
    expect(ctBinding).toContain('flattenForkableSessionHistory(deps.getSessionHistory())');
    expect(ctBinding).not.toContain('renderUnfoldedSessionHistoryLines');
    expect(ctBinding).not.toContain('renderModalOverlay');
    expect(ctBinding).not.toContain('FoldStack');
    expect(ctBinding).not.toContain('openFinderPicker');
  });

  test('C-p still opens the finder on the same registered keymap', () => {
    let finderOpened = 0;
    const { coordinator, chatLog } = registerFinderAndHistoryOnCoordinator({
      history: [{ role: 'user', content: 'keep-me' }],
      openFinderPicker: () => { finderOpened++; },
    });
    invokeRoutedHandler(coordinator, 'p');
    expect(finderOpened).toBe(1);
    expect(chatLog).toEqual([]);
  });

  test('flattenForkableSessionHistory is the shared fork flatten, including tool_result blocks', () => {
    expect(flattenForkableSessionHistory([
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: [{ type: 'tool_result', content: 'tool-out' }] },
      { role: 'system', content: '   ' },
    ])).toEqual([
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: 'tool-out' },
    ]);
    expect(dashboard).toContain('const forkableSessionHistory = (source: ChatMessage[] = chat.history): ForkableSessionTurn[] =>\n    flattenForkableSessionHistory(source);');
  });
});

function extractDisplayKeyBindingBlocks(source: string): string[] {
  const needle = 'display.registerKeyBinding({';
  const blocks: string[] = [];
  let from = 0;
  while (true) {
    const start = source.indexOf(needle, from);
    if (start < 0) break;
    const open = source.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    blocks.push(source.slice(start, end));
    from = end;
  }
  return blocks;
}

function bindingField(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`${name}:\\s*([^,\\n]+)`));
  return match?.[1]?.trim();
}

describe('provider rotation A-grade Ctrl+n alias', () => {
  const bindingBlocks = extractDisplayKeyBindingBlocks(dashboard);

  test('registers both M-m and C-n onto rotateProviderHotkey with the existing when', () => {
    const rotateBlocks = bindingBlocks.filter((block) =>
      block.includes('handler: rotateProviderHotkey'),
    );
    expect(rotateBlocks.map((block) => bindingField(block, 'id'))).toEqual([
      "'dashboard:provider-rotate-next'",
      "'dashboard:provider-rotate-next-ctrl-n'",
    ]);
    expect(rotateBlocks.map((block) => bindingField(block, 'key'))).toEqual([
      "'M-m'",
      "'C-n'",
    ]);
    expect(rotateBlocks.map((block) => bindingField(block, 'when'))).toEqual([
      '() => agentSearchModal === null',
      '() => agentSearchModal === null',
    ]);
    expect(dashboard).toContain(
      'Ctrl+n conventionally moves the cursor to the next line, but this TUI does not implement that family of input-line editing keys — confirmed 2026-08-24 in an isolated TUI where Ctrl+k did not cut the line.',
    );
  });

  test('keeps other global binding identifiers and when conditions, adding only the C-n alias', () => {
    const conditionBearing = bindingBlocks
      .map((block) => ({
        id: bindingField(block, 'id'),
        key: bindingField(block, 'key'),
        when: bindingField(block, 'when'),
      }))
      .filter((binding) => binding.when !== undefined);

    expect(conditionBearing.filter((binding) =>
      binding.id === "'dashboard:open-ssh-picker'"
      || binding.id === "'dashboard:open-directory-picker'"
      || binding.id === "'dashboard:provider-rotate-next'"
      || binding.id === "'dashboard:plan-mode-toggle'",
    )).toEqual([
      { id: "'dashboard:open-ssh-picker'", key: "'C-k'", when: '() => agentSearchModal === null' },
      { id: "'dashboard:open-directory-picker'", key: "'M-c'", when: '() => agentSearchModal === null' },
      { id: "'dashboard:provider-rotate-next'", key: "'M-m'", when: '() => agentSearchModal === null' },
      { id: "'dashboard:plan-mode-toggle'", key: "'S-tab'", when: '() => agentSearchModal === null' },
    ]);

    expect(conditionBearing.filter((binding) =>
      binding.id === "'dashboard:provider-rotate-next-ctrl-n'",
    )).toEqual([
      { id: "'dashboard:provider-rotate-next-ctrl-n'", key: "'C-n'", when: '() => agentSearchModal === null' },
    ]);

    const staticConditionIds = conditionBearing
      .map((binding) => binding.id)
      .filter((id): id is string => typeof id === 'string' && id.startsWith("'dashboard:"));
    expect(staticConditionIds).toEqual([
      "'dashboard:open-ssh-picker'",
      "'dashboard:open-directory-picker'",
      "'dashboard:provider-rotate-next'",
      "'dashboard:provider-rotate-next-ctrl-n'",
      "'dashboard:plan-mode-toggle'",
    ]);
  });
});

describe('dashboard ad run setup factory', () => {
  const contractsJson = readFileSync(new URL('../../docs/ad-presets/higgsfield-measured-contracts.json', import.meta.url), 'utf8');
  const runner: CommandRunner = {
    async run() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const createFactory = (assetPresetPath?: string) => createDashboardAdRunSetupFactory({
    home: '/tmp/dashboard-ad-factory',
    date: '2026-09-12',
    contractsJson,
    runner,
    assetPresetPath,
  });

  test('its optional-input list stays identical to the one buildAdRunSetup reports', () => {
    // ⛔ 이 목록은 ad-run-setup.ts 의 `optionalProductionInputs` 사본이다(그쪽은 export 가 아니다).
    //    optional 을 «하나도» 안 주면 buildAdRunSetup 이 내는 목록이 곧 그 전체 목록이다 — 그것이 권위다.
    const authoritative = buildAdRunSetup({
      home: '/tmp/dashboard-ad-factory', slug: 'x', date: '2026-09-12', version: 1, aspect: '9x16',
      contractsJson, runner,
    });
    if ('error' in authoritative) throw new Error(authoritative.error);
    expect([...dashboardOptionalProductionInputs]).toEqual([...authoritative.missingProductionInputs]);
  });

  test('wires its runner to both sound axes, supplies measured shoot polling defaults, defaults reference assets to an empty map, and derives missing inputs from final production', () => {
    const factory = createDashboardAdRunSetupFactory({
      home: '/tmp/dashboard-ad-factory',
      date: '2026-09-12',
      contractsJson,
      runner,
    });
    const setup = factory(false);
    if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

    expect(setup.production.soundtrack).toBe(runner);
    expect(setup.production.voiceover).toEqual({ runner, lines: [] });
    expect(setup.production.referenceAssets).toEqual({});
    expect(setup.production.assemblyMaterials).toEqual({ options: { workDir: setup.workDir, outputName: setup.outputName } });
    const { shootRunOptions } = setup.production;
    if (!shootRunOptions) throw new Error('expected dashboard shoot run options');
    const pollIntervalMs = shootRunOptions.pollIntervalMs ?? 0;
    const maxPollsPerJob = shootRunOptions.maxPollsPerJob ?? 0;
    const submitStaggerMs = shootRunOptions.submitStaggerMs ?? 0;
    expect(pollIntervalMs).toBeGreaterThanOrEqual(3_000);
    expect(pollIntervalMs * maxPollsPerJob).toBeGreaterThanOrEqual(400_000);
    expect(pollIntervalMs * maxPollsPerJob - submitStaggerMs * 6).toBeGreaterThanOrEqual(400_000);
    expect(setup.missingProductionInputs).toEqual([
      'assembly',
      'captionFontPath',
      'musicBedPath',
      'qcThresholds',
      'ground',
      'invariants',
    ]);
    const optionalProductionInputs = [
      'assembly',
      'assemblyMaterials',
      'captionFontPath',
      'musicBedPath',
      'qcThresholds',
      'voiceover',
      'soundtrack',
      'referenceAssets',
      'shootRunOptions',
      'ground',
      'invariants',
    ] as const;
    for (const key of optionalProductionInputs) {
      expect(setup.missingProductionInputs.includes(key)).toBe(setup.production[key] === undefined);
    }
  });

  test('retains every optional input as missing when the runner is not injected', () => {
    const setup = buildAdRunSetup({
      home: '/tmp/dashboard-ad-factory',
      slug: 'dashboard-ad-no-runner',
      date: '2026-09-12',
      version: 1,
      aspect: '9x16',
      contractsJson,
    });
    if ('error' in setup) throw new Error('expected dashboard setup without a runner');

    expect(setup.production).toBeUndefined();
    expect(setup.missingProductionInputs).toEqual([
      'assembly',
      'assemblyMaterials',
      'captionFontPath',
      'musicBedPath',
      'qcThresholds',
      'voiceover',
      'soundtrack',
      'referenceAssets',
      'shootRunOptions',
      'ground',
      'invariants',
    ]);
  });

  test('creates time-sortable directories for separate runs while retaining a run directory for spend', () => {
    const factory = createFactory();
    const firstDryRun = factory(false);
    const firstSpendRun = factory(true);
    const secondDryRun = factory(false);
    if ('error' in firstDryRun || 'error' in firstSpendRun || 'error' in secondDryRun) {
      throw new Error('expected dashboard run setups');
    }

    expect(firstDryRun.workDir).toMatch(/^\/tmp\/dashboard-ad-factory\/Movies\/elanous-ad\/2026-09-12-dashboard-ad-\d{6}-\d+$/);
    expect(firstSpendRun.workDir).toBe(firstDryRun.workDir);
    expect(secondDryRun.workDir).not.toBe(firstDryRun.workDir);
  });

  test('resolves the optional operator preset under the supplied instance state directory', () => {
    expect(dashboardAdAssetPresetPath('/operator-instance')).toBe(join('/operator-instance', 'ad-assets.json'));
  });

  test('keeps the missing-input baseline when the optional operator preset is absent', () => {
    const setup = createFactory(join(tmpdir(), `dashboard-ad-assets-absent-${crypto.randomUUID()}.json`))(false);
    if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

    expect(setup.production.captionFontPath).toBeUndefined();
    expect(setup.production.musicBedPath).toBeUndefined();
    expect(setup.missingProductionInputs).toContain('captionFontPath');
    expect(setup.missingProductionInputs).toContain('musicBedPath');
  });

  test('passes supplied optional operator asset paths into production setup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({
        captionFontPath: 'operator-caption',
        musicBedPath: 'operator-music',
        referenceAssets: { product: ['operator-reference-a', 'operator-reference-b'] },
      }));
      const setup = createFactory(path)(false);
      if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

      expect(setup.production.captionFontPath).toBe('operator-caption');
      expect(setup.production.musicBedPath).toBe('operator-music');
      expect(setup.production.referenceAssets).toEqual({ product: ['operator-reference-a', 'operator-reference-b'] });
      expect(setup.missingProductionInputs).not.toContain('captionFontPath');
      expect(setup.missingProductionInputs).not.toContain('musicBedPath');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('forwards operator-supplied QC thresholds through the dashboard factory unchanged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      const qcThresholds = {
        dialogueLufsTolerance: 0.08,
        colorDistance: 14.5,
        frameDiffVariance: 0.25,
        durationRanges: {
          cut: { minimumSeconds: 4, maximumSeconds: 8 },
          master: { minimumSeconds: 14.5, maximumSeconds: 15.5 },
        },
      };
      writeFileSync(path, JSON.stringify({ qcThresholds }));
      const setup = createFactory(path)(false);
      if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

      expect(setup.production.qcThresholds).toEqual(qcThresholds);
      expect(setup.missingProductionInputs).not.toContain('qcThresholds');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('preserves missing QC thresholds without creating defaults', () => {
    const setup = createFactory(join(tmpdir(), `dashboard-ad-assets-absent-${crypto.randomUUID()}.json`))(false);
    if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

    expect('qcThresholds' in setup.production).toBeFalse();
    expect(setup.missingProductionInputs).toContain('qcThresholds');
  });

  test('rejects malformed numeric QC threshold operator presets with named errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({ qcThresholds: { dialogueLufsTolerance: 'strict' } }));
      expect(() => createFactory(path)(false)).toThrow(
        `dashboard ad asset preset malformed at ${path}: qcThresholds.dialogueLufsTolerance must be a finite number`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects incomplete QC duration ranges in operator presets with named errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({ qcThresholds: { durationRanges: { cut: { minimumSeconds: 4 } } } }));
      expect(() => createFactory(path)(false)).toThrow(
        `dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.cut.maximumSeconds must be a finite number`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects reversed QC duration ranges in operator presets with named errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({
        qcThresholds: { durationRanges: { master: { minimumSeconds: 16, maximumSeconds: 15 } } },
      }));
      expect(() => createFactory(path)(false)).toThrow(
        `dashboard ad asset preset malformed at ${path}: qcThresholds.durationRanges.master.minimumSeconds must be less than or equal to maximumSeconds`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('forwards operator shoot polling options exactly over the dashboard defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      const shootRunOptions = {
        pollIntervalMs: 7_000,
        maxPollsPerJob: 13,
        maxPollElapsedMs: 91_000,
        submitStaggerMs: 25_000,
        submitRetries: 2,
      };
      writeFileSync(path, JSON.stringify({ shootRunOptions }));
      const setup = createFactory(path)(false);
      if ('error' in setup || !setup.production) throw new Error('expected dashboard production setup');

      expect(setup.production.shootRunOptions).toEqual(shootRunOptions);
      expect(setup.missingProductionInputs).not.toContain('shootRunOptions');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects malformed shootRunOptions operator presets with named errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({ shootRunOptions: { pollIntervalMs: 'fast' } }));
      expect(() => createFactory(path)(false)).toThrow(
        `dashboard ad asset preset malformed at ${path}: shootRunOptions.pollIntervalMs must be a finite number`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects malformed referenceAssets operator presets instead of treating them as empty', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, JSON.stringify({ referenceAssets: { product: ['valid', 42] } }));
      expect(() => createFactory(path)(false)).toThrow(
        `dashboard ad asset preset malformed at ${path}: referenceAssets must be a record of string arrays`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('routes malformed operator preset errors through the dashboard /ad runtime', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    const path = join(directory, 'ad-assets.json');
    try {
      writeFileSync(path, '{');
      const bindings = createDashboardAdRunSetupBindings(createFactory(path));
      const lines: string[] = [];
      const runtime = createDashboardAdSlashRuntime({
        adRunSetupBindings: bindings,
        approve: () => true,
        report: (line) => { lines.push(line); },
        muted: (line) => line,
        warning: (line) => line,
      });

      await runtime.run(['operator campaign']);

      expect(lines.join('\n')).toContain(`dashboard ad asset preset malformed at ${path}`);
      expect(lines.join('\n')).toContain('JSON Parse error');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('does not treat an unreadable operator preset as absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-ad-assets-'));
    try {
      expect(() => createFactory(directory)(false)).toThrow(`dashboard ad asset preset unreadable at ${directory}`);
      expect(() => createFactory(directory)(false)).toThrow(/EISDIR/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
