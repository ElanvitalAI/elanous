// ── coding surface 가 shell 실행 tool 을 노출하는가 (2026-07-17) ──────────────
//
// essential-mode 코딩 에이전트가 codex/claude-code 급이 되려면 편집만이 아니라
// 실행(test/git/gh/launchctl)이 필요하다. coding/turn·coding/agent surface 의
// defaultRuntimeFamilyIds 에 'bash'·'run-shell' family 를 추가했다. 회귀 방지:
// family names 는 runtime ID(bash·run_shell)여야 하며 spec name(Bash/RunShell)이
// 아니다 — resolver 가 ToolRuntime.id 로 키하기 때문(이 미스매치가 첫 시도 버그).

import { describe, it, expect, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionRuntimeToolSpecs, dispatchSessionRuntimeTool, parseSessionSurfaceSlash, resolveSessionSurfaceProfile, type SessionRuntimeDispatchDeps, type SessionSurfaceId } from './index.js';
import { debug } from '../debug/log.js';
import { resetUserConfig } from '../user-config.js';
import { bashRuntime } from '../tool-runtime/bash-runtime.js';
import { runShellRuntime } from '../tool-runtime/run-shell-runtime.js';
import { registerAllDefaultToolRuntimes } from '../tool-runtime/index.js';
import { listToolRuntimes } from '../tool-runtime/registry.js';
import { globalAgentRegistry } from '../agent/registry.js';
import type { LLMProvider } from '../llm.js';

/** 중단 신호가 올 때까지 매달리는 공급자. 키 없는 우주(게이트 Pod·빈 HOME)에선
 *  배경 자식이 공급자 해석 실패로 «즉시» error 로 끝나 registry.abort 가 no-op 이
 *  된다 — 그러면 «부모 신호 → 자식 controller» 사슬을 잴 수 없다(0.2.29 gate pod-20).
 *  test/agent-runner.test.ts 의 hangingProvider 와 같은 꼴. */
function hangingProvider(): LLMProvider {
  async function hang(opts: { signal?: AbortSignal } | undefined): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const sig = opts?.signal;
      const err = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (!sig) return;
      if (sig.aborted) { reject(err()); return; }
      sig.addEventListener('abort', () => reject(err()), { once: true });
    });
  }
  return {
    name: 'hang',
    defaultModel: 'hang',
    available: () => true,
    async *streamChat(_msgs, opts) { await hang(opts); },
    async *chat(_msgs, opts) { await hang(opts); },
  };
}

function exposed(surfaceId: SessionSurfaceId): string[] {
  return buildSessionRuntimeToolSpecs({
    userText: '이 코드 분석하고 테스트 돌려줘',
    hostTools: [],
    runtimeTools: [bashRuntime, runShellRuntime],
    preferredSurfaceId: surfaceId,
  }).map(s => s.name);
}

function withModelSurfaceConfig<T>(config: object, callback: () => T): T {
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const xdg = mkdtempSync(join(tmpdir(), 'session-runtime-model-surface-'));
  try {
    mkdirSync(join(xdg, 'elanous'), { recursive: true });
    writeFileSync(join(xdg, 'elanous', 'config.json'), JSON.stringify(config));
    process.env.XDG_CONFIG_HOME = xdg;
    resetUserConfig();
    return callback();
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    resetUserConfig();
    rmSync(xdg, { recursive: true, force: true });
  }
}

function runtimeDispatchDeps(overrides: Partial<SessionRuntimeDispatchDeps> = {}): SessionRuntimeDispatchDeps {
  return {
    getToolRuntime: () => undefined,
    dispatchToolRuntime: async () => ({ dispatched: 'runtime' }),
    dispatchPluginTool: async () => ({ ok: false, error: 'unexpected plugin dispatch' }),
    ...overrides,
  };
}

function agentSpawnEvents() {
  return debug.events().filter(event => event.category === 'agent.spawn' && event.event === 'dispatch');
}

describe('coding surface — shell 실행 tool 노출', () => {
  it('coding/turn 이 Bash·RunShell 을 노출한다(편집+실행 완전체)', () => {
    const names = exposed('coding/turn');
    expect(names).toContain('Bash');
    expect(names).toContain('RunShell');
    // 기존 편집/탐색 tool 도 유지
    expect(names).toContain('Read');
    expect(names).toContain('Edit');
  });

  it('coding/agent 도 Bash·RunShell 을 노출한다(골 소유 에이전트는 실행 필수)', () => {
    const names = exposed('coding/agent');
    expect(names).toContain('Bash');
    expect(names).toContain('RunShell');
  });

  it('legacy coding/chat slash ID resolves to the same non-empty coding/turn tool catalog', () => {
    const legacy = parseSessionSurfaceSlash(['coding/chat']);
    const canonical = parseSessionSurfaceSlash(['coding/turn']);
    expect(legacy).toEqual(canonical);
    expect(legacy.kind).toBe('set');
    if (legacy.kind !== 'set' || canonical.kind !== 'set') return;

    const legacyNames = exposed(legacy.surfaceId);
    const canonicalNames = exposed(canonical.surfaceId);
    expect(legacyNames).toEqual(canonicalNames);
    expect(legacyNames).not.toHaveLength(0);
  });

  // TUI-DIET-D1-TAIL — the essential catalog is surface-independent, so the former
  // «research 표면엔 skills 없음» half (legacy per-surface catalog) was removed.
  it('coding 표면은 skills 목록과 명시 실행기를 함께 노출한다', () => {
    registerAllDefaultToolRuntimes();
    const runtimeTools = listToolRuntimes('tui');
    for (const surfaceId of ['coding/turn', 'coding/agent'] as const) {
      const names = buildSessionRuntimeToolSpecs({
        userText: '설치된 스킬을 찾아 실행해줘',
        hostTools: [],
        runtimeTools,
        preferredSurfaceId: surfaceId,
      }).map(spec => spec.name);
      expect(names).toContain('elanous_skills_list');
      expect(names).toContain('skill_exec');
    }
  });

  it('기본 modelSurface가 없는 하니스 요청은 coding/agent를 고르되 RunDevHarness를 노출하지 않는다', () => {
    withModelSurfaceConfig({}, () => {
      const harnessText = '개발 하니스로 이 저장소 버그를 고쳐줘';
      const names = buildSessionRuntimeToolSpecs({ userText: harnessText, hostTools: [], runtimeTools: [] }).map(spec => spec.name);

      expect(resolveSessionSurfaceProfile({ userText: harnessText }).id).toBe('coding/agent');
      expect(names).not.toContain('RunDevHarness');
      // TUI-DIET-D1-TAIL — the essential catalog drops Edit/Write on a harness phrase (legacy kept Edit).
      expect(names).not.toContain('Edit');
    });
  });

  // TUI-DIET-D1-TAIL — «modelSurface:true 면 RunDevHarness 노출» 은 레거시 카탈로그 갈래만 지켰다.
  // essential 카탈로그는 RunDevHarness 를 싣지 않는다(native-tool-catalog defaultEnabled:false · #8515).

  it('기존 ops·research 의도는 하니스 어휘가 함께 있어도 기존 surface 우선순위를 유지한다', () => {
    expect(resolveSessionSurfaceProfile({ userText: 'acp session 하니스로 개발해줘' }).id).toBe('ops-fleet/agent');
    expect(resolveSessionSurfaceProfile({ userText: '대시보드 하니스로 개발해줘' }).id).toBe('ops-ui/agent');
    expect(resolveSessionSurfaceProfile({ userText: 'research 하니스로 개발해줘' }).id).toBe('research/agent');
    expect(resolveSessionSurfaceProfile({ userText: '웹 검색 하니스로 개발해줘' }).id).toBe('research/turn');
  });

  it('family names 는 runtime ID 여야 한다(spec name 아님 — resolver 는 tool.id 로 키)', () => {
    // 회귀 가드: bashRuntime.id='bash'(spec 'Bash'), runShellRuntime.id='run_shell'.
    expect(bashRuntime.id).toBe('bash');
    expect(runShellRuntime.id).toBe('run_shell');
  });

  it('실경로 회귀 가드: listToolRuntimes(tui) 가 bash·run_shell 을 포함한다', () => {
    // native-tool-catalog 의 surface 목록이 catalog 필터 — bash 가 ['skill'] 로만
    // 제한되면 여기서 빠져 coding surface 에 못 실림(2026-07-17 인시던트). family
    // 배선만으론 부족하고 catalog surface 도 'tui' 를 포함해야 한다.
    registerAllDefaultToolRuntimes();
    const ids = listToolRuntimes('tui').map(t => t.id);
    expect(ids).toContain('bash');
    expect(ids).toContain('run_shell');
  });

  // ── T1 substrate 상시화 (RFC §3 · P2 · 2026-07-17) ──────────────────
  // shell/PTY 실행은 domain-무관 world-I/O substrate 라 coding surface 만이
  // 아니라 research·control·ops surface 에도 상시 노출된다(대표 지시 "T1 실제
  // 상시화"). before≠after: 이전엔 coding surface 만 shell 을 얻었다. 노출만
  // 변경 — 실행 안전은 bash sandbox / PtyShell 승인 게이트가 유지.
  it('research·control·ops surface 도 T1 shell substrate 를 상시 노출한다', () => {
    registerAllDefaultToolRuntimes();
    const rt = listToolRuntimes('tui');
    for (const surfaceId of ['research/turn', 'research/agent', 'control/agent', 'ops-ui/agent', 'ops-fleet/agent'] as const) {
      const names = buildSessionRuntimeToolSpecs({
        userText: '점검해줘',
        hostTools: [],
        runtimeTools: rt,
        preferredSurfaceId: surfaceId,
      }).map(s => s.name);
      expect(names).toContain('Bash');
      expect(names).toContain('RunShell');
      expect(names).toContain('PtyShellStart');
    }
  });

  it('T1 runtime substrate 는 availability-gated — 미배선 surface 는 phantom 없음', () => {
    // runtimeTools 를 안 넘기면(available 0) shell 이 상시여도 안 뜬다.
    const names = buildSessionRuntimeToolSpecs({
      userText: '점검해줘',
      hostTools: [],
      runtimeTools: [],
      preferredSurfaceId: 'ops-fleet/agent',
    }).map(s => s.name);
    expect(names).not.toContain('Bash');
    expect(names).not.toContain('PtyShellStart');
  });

  it('coding surface 가 대화형 PTY(PtyShellStart/Poll/Send/Kill)를 노출한다', () => {
    // essential 셸 = Bash(one-shot) + PtyShell*(대화형 REPL·dev server·watcher,
    // codex unified_exec 대응). 실경로(listToolRuntimes)로 검증 — 노출은 family
    // 배선이 좌우(dispatch 는 별도 shell.allowDashboardPty 게이트).
    registerAllDefaultToolRuntimes();
    const names = buildSessionRuntimeToolSpecs({
      userText: 'python3 REPL 열어줘',
      hostTools: [],
      runtimeTools: listToolRuntimes('tui'),
      preferredSurfaceId: 'coding/turn',
    }).map(s => s.name);
    expect(names).toContain('PtyShellStart');
    expect(names).toContain('PtyShellPoll');
    expect(names).toContain('PtyShellSend');
    expect(names).toContain('PtyShellKill');
  });

  it('runtime 없는 Agent 폴백은 부모 도구·dispatcher·중단 신호를 자식에 보존한다', async () => {
    debug.clear();
    const controller = new AbortController();
    const hostTools = [{ name: 'Read', description: 'read', parameters: { type: 'object' } }];
    const dispatchTool = spyOn({ dispatchTool: async () => ({ ok: true }) }, 'dispatchTool');
    const childTools = [{ name: 'ChildRead', description: 'child read', parameters: { type: 'object' } }];
    const childDispatchTool = spyOn({ dispatchTool: async () => ({ child: true }) }, 'dispatchTool');
    const buildChildToolCatalog = spyOn({
      buildChildToolCatalog: (cwd: string) => ({
        specs: childTools,
        dispatch: childDispatchTool,
        workingDirectory: cwd,
      }),
    }, 'buildChildToolCatalog');
    // 실제 spawn 을 그대로 부르되 공급자만 매달리는 가짜로 — 자식이 abort 전에 끝나지 않게.
    const realSpawn = globalAgentRegistry.spawn.bind(globalAgentRegistry);
    const spawn = spyOn(globalAgentRegistry, 'spawn').mockImplementation(spawnOpts => realSpawn({ ...spawnOpts, provider: spawnOpts.provider ?? hangingProvider() }));

    try {
      const result = await dispatchSessionRuntimeTool('Agent', { description: 'inherit tools', prompt: 'inspect', run_in_background: true, isolation: 'cwd' }, runtimeDispatchDeps({
        signal: controller.signal,
        agentHostTools: hostTools,
        agentDispatchTool: dispatchTool,
        buildChildToolCatalog,
      })) as { taskId: string };

      const spawnOpts = spawn.mock.calls[0]?.[0];
      expect(agentSpawnEvents()).toEqual([expect.objectContaining({ data: expect.objectContaining({ tools: ['ChildRead'], noTools: false }) })]);
      expect(buildChildToolCatalog).toHaveBeenCalledTimes(1);
      expect(spawnOpts?.tools).toEqual(childTools);
      expect(spawnOpts?.dispatchTool).toBe(childDispatchTool);
      await spawnOpts?.dispatchTool?.('ChildRead', { file_path: 'child.ts' });
      expect(childDispatchTool).toHaveBeenCalledWith('ChildRead', { file_path: 'child.ts' });
      expect(dispatchTool).not.toHaveBeenCalled();
      controller.abort();
      expect(globalAgentRegistry.get(result.taskId)?.controller.signal.aborted).toBe(true);

      await dispatchSessionRuntimeTool('Agent', { description: 'no child catalog', prompt: 'inspect', run_in_background: true, isolation: 'cwd' }, runtimeDispatchDeps({
        agentHostTools: hostTools,
        agentDispatchTool: dispatchTool,
      }));
      expect(buildChildToolCatalog).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[1]?.[0]?.tools).toEqual(hostTools);
      expect(spawn.mock.calls[1]?.[0]?.dispatchTool).toBe(dispatchTool);
    } finally {
      for (const r of spawn.mock.results) {
        const id = (r.value as { task?: { id?: string } } | undefined)?.task?.id;
        if (id) globalAgentRegistry.abort(id);
      }
      spawn.mockRestore();
    }
  });

  it('runtime 없는 Agent 폴백은 부모 도구가 없을 때만 빈손 강등을 관측한다', async () => {
    debug.clear();

    await dispatchSessionRuntimeTool('Agent', { description: 'no inherited tools', prompt: 'inspect', run_in_background: true }, runtimeDispatchDeps());

    expect(agentSpawnEvents()).toEqual([expect.objectContaining({ data: expect.objectContaining({ tools: [], noTools: true }) })]);
    expect(debug.events()).toContainEqual(expect.objectContaining({
      category: 'session-runtime.dispatch',
      event: 'agent-runtime-fallback-no-tools',
      data: expect.objectContaining({ toolName: 'Agent', runtimeAvailable: false, hostToolCount: 0 }),
    }));
  });

  it('runtime path와 native dispatcher는 inline Agent 폴백 관측 없이 기존 dispatch paths를 유지한다', async () => {
    debug.clear();
    const runtimeCalls: string[] = [];
    const nativeCalls: string[] = [];
    const deps = runtimeDispatchDeps({
      getToolRuntime: name => name === 'Agent' ? { id: 'agent', spec: { name: 'Agent', description: '', parameters: {} }, run: async () => ({}) } : undefined,
      dispatchToolRuntime: async name => {
        runtimeCalls.push(name);
        return { dispatched: 'runtime' };
      },
      dispatchNativeTool: async name => {
        nativeCalls.push(name);
        return { dispatched: 'native' };
      },
    });

    expect(await dispatchSessionRuntimeTool('Agent', { description: 'runtime path', prompt: 'inspect' }, deps)).toEqual({ dispatched: 'runtime' });
    expect(await dispatchSessionRuntimeTool('Read', { file_path: '/tmp/ignored' }, deps)).toEqual({ dispatched: 'native' });
    expect(await dispatchSessionRuntimeTool('Agent', { description: 'native path', prompt: 'inspect' }, runtimeDispatchDeps({
      dispatchNativeTool: async name => {
        nativeCalls.push(name);
        return { dispatched: 'native' };
      },
    }))).toEqual({ dispatched: 'native' });
    expect(runtimeCalls).toEqual(['Agent']);
    expect(nativeCalls).toEqual(['Read', 'Agent']);
    expect(agentSpawnEvents()).toEqual([]);
    expect(debug.events().some(event => event.event === 'agent-runtime-fallback-no-tools')).toBe(false);
  });
});
