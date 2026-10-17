import { describe, expect, test } from 'bun:test';

import type { ToolRuntime } from '../src/tool-runtime/types.js';
import { buildSessionRuntimeToolSpecs } from '../src/session-runtime/index.js';

// ⛔ 이 파일이 지키는 것: "카탈로그에 등록했으니 TUI 에도 뜬다" 는 거짓이다.
//
//  native-tool-catalog 의 `surface: [...,'dashboard',...]` 는 skill 러너가 읽는 필드이고
//  TUI 세션 카탈로그는 session-runtime 의 family 표에서 조립된다. 오늘 같은 구조를 두 번
//  겪었다 — Agent(#5916) · PersistentGrounding(라이브 census 33, 34 아님).
//  ⇒ family 등록이 빠지면 라이브에서만 드러나므로 여기서 고정한다.
function runtimeStub(id: string, name: string): ToolRuntime<Record<string, unknown>, unknown> {
  return { id, spec: { name, description: name, parameters: { type: 'object' } }, run: async () => ({ ok: true }) };
}

describe('essential catalog exposes persistent grounding', () => {
  test('persistent_grounding lands in the essential TUI catalog when its runtime is registered', () => {
    const names = buildSessionRuntimeToolSpecs({
      userText: '아무 문장',
      hostTools: [],
      runtimeTools: [runtimeStub('persistent_grounding', 'PersistentGrounding')],
    }).map(spec => spec.name);

    expect(names).toContain('PersistentGrounding');
  });

  test('it is absent when no runtime is registered — exposure follows the registry, not the catalog file', () => {
    const names = buildSessionRuntimeToolSpecs({
      userText: '아무 문장',
      hostTools: [],
      runtimeTools: [],
    }).map(spec => spec.name);

    expect(names).not.toContain('PersistentGrounding');
  });

  // ⭐ 이름을 고정한다 — 수만 보면 노출 변화가 정당한 추가인지 카탈로그 누수인지 알 수 없다.
  // `AgentList`는 essential native family의 정당한 추가이며, retired `SelfOrchestrate`는 노출되지 않는다.
  test('essential catalog has the expected members once every fixture family is supplied', () => {
    const hostTools = ['ops_status', 'autopilot_missions', 'self_recall', 'memory_recall',
      'session_manage', 'schedule_manage', 'fact_check', 'se_build']
      .map(name => ({ name, description: name, parameters: { type: 'object' }, handler: async () => ({}) }));
    const runtimeTools = [
      ['bash', 'Bash'], ['run_shell', 'RunShell'],
      ['pty_shell_start', 'PtyShellStart'], ['pty_shell_poll', 'PtyShellPoll'],
      ['pty_shell_send', 'PtyShellSend'], ['pty_shell_kill', 'PtyShellKill'],
      ['pty_shell_list', 'PtyShellList'], ['run_tests', 'run_tests'],
      ['persistent_grounding', 'PersistentGrounding'],
    ].map(([id, name]) => runtimeStub(id, name));
    const optionalTools = ['GetDashboardState', 'TerminalModalList', 'TerminalModalObserve',
      'TerminalModalFocus', 'TerminalModalDetach', 'TerminalModalKill']
      .map(name => ({ name, description: name, parameters: { type: 'object' } }));

    const names = buildSessionRuntimeToolSpecs({
      userText: '아무 문장', hostTools, runtimeTools, optionalTools,
    }).map(spec => spec.name);

    expect(names).toEqual([
      'Read', 'Grep', 'Glob', 'ListDir', 'Edit', 'Write',
      'Agent', 'AgentOutput', 'AgentReply', 'AgentStop', 'AgentList', 'SelfImplement',
      'ops_status', 'autopilot_missions', 'self_recall', 'memory_recall', 'session_manage',
      'schedule_manage', 'fact_check', 'se_build',
      'Bash', 'RunShell',
      'PtyShellStart', 'PtyShellPoll', 'PtyShellSend', 'PtyShellKill', 'PtyShellList',
      'run_tests', 'PersistentGrounding',
      'GetDashboardState',
      'TerminalModalList', 'TerminalModalObserve', 'TerminalModalFocus', 'TerminalModalDetach', 'TerminalModalKill',
    ]);
  });
});
