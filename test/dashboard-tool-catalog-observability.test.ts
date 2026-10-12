import { describe, expect, test, spyOn } from 'bun:test';
import type { LLMToolSpec } from '../src/llm.js';
import { debug } from '../src/debug/log.js';
import { buildDashboardOptionalToolSpecs } from '../src/dashboard/optional-tool-spec-runtime.js';
import { registerDashboardCoreHostTools } from '../src/dashboard/index.js';
import { recordDashboardToolCatalog } from '../src/dashboard/tool-catalog-observability.js';
import { buildSessionRuntimeToolSpecs } from '../src/session-runtime/index.js';
import { PluginHost } from '../src/plugins/core/host.js';
import { LOGS_QUERY_SPEC } from '../src/domains/logs-tool.js';
import {
  _resetToolRuntimeRegistryForTest,
  listToolRuntimes,
  registerAllDefaultToolRuntimes,
} from '../src/tool-runtime/index.js';

const tool = (name: string): LLMToolSpec => ({
  name,
  description: '',
  parameters: { type: 'object' },
});

/** ⛔ 전역 diag 상태를 무조건 false 로 덮지 않는다 — 이 파일이 다른 테스트의 설정을
 *  조용히 끄면, 끄고 나서 실패하는 테스트의 원인이 여기라는 것을 아무도 못 찾는다(리뷰 should-fix). */
function withDiag<T>(fn: () => T): T {
  const prev = debug.enabled;
  debug.setDiagEnabled(true);
  try { return fn(); } finally { debug.setDiagEnabled(prev); }
}

describe('dashboard tool catalog observability', () => {
  test('live dashboard core host registration exposes and dispatches logs_query once in essential TUI', async () => {
    const host = new PluginHost({ log: () => {}, hudSet: () => {}, requestRender: () => {}, focusPane: () => {} });
    registerDashboardCoreHostTools(host);
    registerAllDefaultToolRuntimes();
    const assemble = (availability?: Record<string, boolean>) => buildSessionRuntimeToolSpecs({
      userText: '최근 30분 task-agent 로그에서 exit-classified 몇 건이야?',
      hostTools: host.hostLLMTools(),
      runtimeTools: listToolRuntimes('tui'),
      pluginTools: host.activePluginLLMTools(),
      toolAvailability: availability,
      rich: false,
    });
    const logs = assemble().filter(spec => spec.name === 'logs_query');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(LOGS_QUERY_SPEC);
    expect(assemble({ logs_query: false }).map(spec => spec.name)).not.toContain('logs_query');

    const registered = host.hostLLMTools().find(tool => tool.name === 'logs_query');
    expect(registered).toBeDefined();
    const handlerCall = spyOn(registered!, 'handler');
    try {
      const result = await host.dispatchTool('logs_query', { sinceMinutes: 30, event: 'exit-classified' });
      expect(result.ok).toBe(true);
      expect(handlerCall).toHaveBeenCalledTimes(1);
    } finally {
      handlerCall.mockRestore();
    }
  });

  test('records every assembled tool name with its surface and assembler', () => {
    const records: Array<{ category: string; event: string; data: unknown }> = [];
    const off = debug.registerSink({
      name: 'dashboard-tool-catalog-observability-test',
      emit: (record) => records.push({
        category: record.category,
        event: record.event,
        data: record.data,
      }),
    });

    try {
      withDiag(() => recordDashboardToolCatalog('tui-session-42', [
        tool('Read'), tool('Grep'), tool('Glob'), tool('ListDir'), tool('Edit'), tool('Write'),
        tool('SelfImplement'), tool('ToolSearch'),
      ]));
    } finally {
      off?.();
    }

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      category: 'capability.resolve',
      event: 'tool-catalog-assembled',
      data: {
        sessionId: 'tui-session-42',
        surface: 'tui-dashboard',
        assembler: 'buildSessionRuntimeToolSpecs',
        toolCount: 8,
        tools: ['Read', 'Grep', 'Glob', 'ListDir', 'Edit', 'Write', 'SelfImplement', 'ToolSearch'],
      },
    });
  });

  test('records the complete TUI runtime assembly', () => {
    _resetToolRuntimeRegistryForTest();
    const optionalTools = buildDashboardOptionalToolSpecs({
      userConfig: {
        shell: {
          allowDashboardOptionalTools: true,
          allowDashboardBash: false,
          allowDashboardTerminalInject: false,
          allowDashboardApiCall: false,
          allowDashboardRunShell: false,
          allowDashboardState: false,
        },
      } as any,
      termSize: () => ({ cols: 80, rows: 24 }),
      registerAllDefaultToolRuntimes,
      setTerminalModalRuntimeDeps: () => {},
      buildBashTool: () => tool('Bash'),
      buildTerminalInjectTool: () => tool('TerminalInject'),
      buildApiCallTool: () => tool('ApiCall'),
      buildRunShellTool: () => tool('RunShell'),
      buildDashboardStateTool: () => tool('GetDashboardState'),
      buildTerminalModalTools: () => [],
    });
    const tools = buildSessionRuntimeToolSpecs({
      userText: 'run this command in a PTY shell',
      hostTools: [],
      runtimeTools: listToolRuntimes('tui'),
      optionalTools,
    });
    const names = tools.map((tool) => tool.name);
    const records: Array<{ category: string; event: string; data: { tools: string[] } }> = [];
    const off = debug.registerSink({
      name: 'dashboard-pty-catalog-assembly-test',
      emit: (record) => records.push({
        category: record.category,
        event: record.event,
        data: record.data as { tools: string[] },
      }),
    });

    try {
      withDiag(() => recordDashboardToolCatalog('tui-pty-runtime-assembly', tools));
    } finally {
      off?.();
      _resetToolRuntimeRegistryForTest();
    }

    expect(names).toEqual([
      'Read', 'Grep', 'Glob', 'ListDir', 'Edit', 'Write',
      'Agent', 'AgentOutput', 'AgentReply', 'AgentStop', 'AgentList',
      'Bash', 'RunShell', 'PtyShellStart', 'PtyShellPoll', 'PtyShellSend',
      'PtyShellKill', 'PtyShellList', 'run_tests', 'elanous_skills_list', 'skill_exec',
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      category: 'capability.resolve',
      event: 'tool-catalog-assembled',
      data: { tools: names },
    });
    expect(new Set(records[0]!.data.tools).size).toBe(records[0]!.data.tools.length);
  });

  // ⛔ 배열 상한만 풀면 `stringMax`(256)가 긴 이름을 자른다. 잘린 이름은
  //    "그 툴이 카탈로그에 있었나" 에 **틀린 답**을 주고, 그것이 이 이벤트의 존재 이유다.
  test('a pathologically long tool name is not clipped either', () => {
    const longName = `Tool${'X'.repeat(400)}`;
    const records: Array<{ data: unknown }> = [];
    const off = debug.registerSink({
      name: 'dashboard-tool-catalog-long-name-test',
      emit: (record) => records.push({ data: record.data }),
    });
    try {
      withDiag(() => recordDashboardToolCatalog('tui-session-43', [tool(longName)]));
    } finally {
      off?.();
    }
    const data = records[0]?.data as { tools: string[] };
    expect(data.tools).toEqual([longName]);
    expect(data.tools[0]).toHaveLength(longName.length);
  });
});
