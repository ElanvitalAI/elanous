import { describe, expect, test } from 'bun:test';
import { ENTRANCE_REGISTRY, NATIVE_TOOL_BY_ENTRANCE_ID } from '../src/self-dev/entrance-registry.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMToolSpec } from '../src/llm.js';
import type { LLMToolDef } from '../src/plugins/core/types.js';
import type { ToolRuntime } from '../src/tool-runtime/types.js';
import { buildSessionRuntimeToolSpecs } from '../src/session-runtime/index.js';
import { resetUserConfig } from '../src/user-config.js';
import { debug } from '../src/debug/log.js';

// ⛔ 별도 파일인 이유 — 이 파일을 «만든» PR 은 기존 기대값을 건드리지 않았다.
//   ⚠️ 그 문장은 「이 파일의 기대값이 영영 안 바뀐다」는 뜻이 아니다. 고정 목록이 바뀌면
//   여기 `expected` 도 «같이» 바뀐다(실제로 `#7349` → `#7351` 에서 한 줄 바뀌었다).
//   가르는 것은 «어느 파일을 건드리나»다 — 남의 기대값이 아니라 이 목록의 기대값이다.
//
//  session-runtime.test.ts 에는 이 PR 과 무관하게 실패하던 케이스가 있고(scheduler 라우팅
//  회귀 등), 같은 파일을 편집하면 "기능 추가" 와 "남의 기대값 수정" 이 한 diff 에 섞여
//  귀속이 불가능해진다. 실제로 초안이 그 실패 테스트를 지워서 무인 리뷰에 잡혔다 —
//  깨진 것을 정답으로 굳히는 형태였다.
describe('essential dashboard catalog', () => {

  test('essential dashboard catalog is fixed while rich retains dynamic matching', () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const xdg = mkdtempSync(join(tmpdir(), 'session-runtime-model-surface-'));
    try {
      mkdirSync(join(xdg, 'elanous'), { recursive: true });
      writeFileSync(join(xdg, 'elanous', 'config.json'), '{}');
      process.env.XDG_CONFIG_HOME = xdg;
      resetUserConfig();

      const essentialHostTools: LLMToolDef[] = [
      ...['ops_status', 'logs_query', 'autopilot_missions', 'self_recall', 'memory_recall', 'session_manage', 'schedule_manage', 'fact_check', 'se_build'].map(name => ({
        name,
        description: name,
        parameters: { type: 'object' },
        handler: async () => ({}),
      })),
      { name: 'debug_getState', description: 'debug', parameters: { type: 'object' }, handler: async () => ({}) },
    ];
    const essentialRuntimeTools: ToolRuntime<Record<string, unknown>, any>[] = [
      ['bash', 'Bash'], ['run_shell', 'RunShell'], ['pty_shell_start', 'PtyShellStart'],
      ['pty_shell_poll', 'PtyShellPoll'], ['pty_shell_send', 'PtyShellSend'],
      ['pty_shell_kill', 'PtyShellKill'], ['pty_shell_list', 'PtyShellList'], ['run_tests', 'run_tests'],
      ['elanous_skills_list', 'elanous_skills_list'], ['skill_exec', 'skill_exec'],
    ].map(([id, name]) => ({ id, spec: { name, description: name, parameters: { type: 'object' } }, run: async () => ({ output: 'ok' }) }));
    const optionalTools = [
      'GetDashboardState',
      'TerminalModalList', 'TerminalModalObserve', 'TerminalModalFocus', 'TerminalModalDetach', 'TerminalModalKill',
    ].map(name => ({ name, description: name, parameters: { type: 'object' } }));
    const expected = [
      'Read', 'Grep', 'Glob', 'ListDir', 'Edit', 'Write',
      'Agent', 'AgentOutput', 'AgentReply', 'AgentStop', 'AgentList',
      // ⭐ 고정 목록(`ESSENTIAL_NATIVE_RULE_IDS`)에 들어온 순서 그대로 적는다.
      //    RunDevHarness is explicit-only; the isolated empty config above asserts its default absence.
      //    ⛔ `SelfOrchestrate` 는 «은퇴»했다 — `src/self-dev/entrance-registry.ts` 가
      //       `{ id: 'nl-self-orchestrate', … status: 'retired' }` 로 «선언»하고 있다.
      //       ⇒ 이 목록이 그 은퇴를 안 따라가서 이 시험이 빨갛게 남아 있었다(🅕 30차 전수 분류).
      'SelfImplement',
      'ops_status', 'autopilot_missions', 'self_recall', 'memory_recall', 'session_manage',
      'schedule_manage', 'fact_check', 'se_build', 'logs_query',
      'Bash', 'RunShell',
      'PtyShellStart', 'PtyShellPoll', 'PtyShellSend', 'PtyShellKill', 'PtyShellList',
      'run_tests', 'elanous_skills_list', 'skill_exec', 'GetDashboardState',
      'TerminalModalList', 'TerminalModalObserve', 'TerminalModalFocus', 'TerminalModalDetach', 'TerminalModalKill',
    ];

    // ⛔⭐ **은퇴 선언을 «읽어» 문다** — 주석은 못 문다(🅕 30차 · 무인 리뷰 `#13070` 지적).
    //    이 고정 목록이 다시 늙는 형태는 「도구가 은퇴했는데 여기가 안 따라간다」 하나뿐이다.
    //    ⇒ 레지스트리에서 «retired» 를 읽어 그 도구 이름이 목록에 «없음»을 문다.
    const retiredEntrances = ENTRANCE_REGISTRY.filter((entrance) => entrance.status === 'retired');
    const retiredTools = retiredEntrances
      .map((entrance) => NATIVE_TOOL_BY_ENTRANCE_ID[entrance.id])
      .filter((name): name is string => typeof name === 'string');
    // ⛔ 모집단 0이면 아래 루프는 «공허참»이다 — 그래서 «몇 개를 봤는지»를 «찍는다».
    //    ⚠️ 여기서 `toBeGreaterThan(0)` 으로 «막지» 않는다: 매핑된 은퇴 도구가 현재 «하나»뿐이라
    //       그것을 정당하게 되살리면 이 시험이 «틀린 이유로» 빨개진다(🅕 30차 실측).
    //    ⇒ 대신 ⑴ 분모를 찍고 ⑵ «매핑 자체»가 비지 않았음을 문다(그쪽은 은퇴 여부와 무관하다).
    console.log(
      `[essential-catalog] retiredEntrances=${retiredEntrances.length} `
      + `mappedRetiredTools=${retiredTools.length} (${retiredTools.join(', ') || 'none'})`,
    );
    expect(Object.keys(NATIVE_TOOL_BY_ENTRANCE_ID).length).toBeGreaterThan(0);
    for (const tool of retiredTools) expect(expected).not.toContain(tool);
    const essential = (userText: string) => buildSessionRuntimeToolSpecs({
      userText,
      hostTools: essentialHostTools,
      runtimeTools: essentialRuntimeTools,
      optionalTools,
      rich: false,
    }).map(spec => spec.name);

    expect(essential('이 코드의 버그를 고쳐줘')).toEqual(expected);
    expect(essential('debug trace와 외부 웹 검색을 해줘')).toEqual(expected);
    const dynamicNames = buildSessionRuntimeToolSpecs({
      userText: 'debug trace를 점검해줘',
      hostTools: essentialHostTools,
      runtimeTools: essentialRuntimeTools,
      optionalTools,
      rich: true,
    }).map(spec => spec.name);
    expect(dynamicNames).toContain('debug_getState');
    expect(buildSessionRuntimeToolSpecs({
      userText: 'debug trace를 점검해줘',
      hostTools: essentialHostTools,
      runtimeTools: essentialRuntimeTools,
      optionalTools,
    }).map(spec => spec.name)).toEqual(dynamicNames);

    const records: Array<{ event: string; data: { surfaceId?: string; toolCount?: number } }> = [];
    const off = debug.registerSink({
      name: 'essential-session-runtime-profile-test',
      emit: record => records.push({ event: record.event, data: record.data as { surfaceId?: string; toolCount?: number } }),
    });
    try {
      expect(essential('프로필 관측도 남겨줘')).toEqual(expected);
    } finally {
      off?.();
    }
    expect(records).toContainEqual({
      event: 'surface-profile-resolved',
      data: expect.objectContaining({ surfaceId: 'coding/turn', toolCount: expected.length }),
    });

    const withoutLogsHost = buildSessionRuntimeToolSpecs({
      userText: '최근 로그를 조회해줘',
      runtimeTools: essentialRuntimeTools,
      hostTools: essentialHostTools.filter(tool => tool.name !== 'logs_query'),
      optionalTools,
      rich: false,
    }).map(spec => spec.name);
    expect(withoutLogsHost).not.toContain('logs_query');

    const unavailableInEssential = ['Bash', 'PtyShellStart', 'TerminalModalObserve', 'logs_query'];
    expect(buildSessionRuntimeToolSpecs({
      userText: '비활성 도구도 노출되는지 점검해줘',
      hostTools: essentialHostTools,
      runtimeTools: essentialRuntimeTools,
      optionalTools,
      rich: false,
      toolAvailability: Object.fromEntries(unavailableInEssential.map(name => [name, false])),
      }).map(spec => spec.name)).toEqual(expected.filter(name => !unavailableInEssential.includes(name)));
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      resetUserConfig();
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});
