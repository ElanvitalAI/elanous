// turn 조립기 통일 Phase 2 — 코딩코어 native seam 골든룰 스냅샷 가드.
//
// 골든룰: CLI(buildCliAgentTools)·continuation(buildContinuationAgentTools) 이 각자 복제하던 native
// 코딩코어 조립을 buildCodingCoreNativeSpecs 단일 출처로 이행 — 이름배열 diff=0. 두 조립기의 native
// 블록은 Read/Grep/Glob/ListDir/Edit/Write 였다(런타임 캡처). 여기서 못박아 회귀를 막는다.

import { describe, test, expect, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCliAgentTools, program, setCliAgentDispatchForTesting } from '../index.js';
import { dispatchAgent } from '../skills/tools/agent.js';
import { debug } from '../debug/log.js';
import type { AgentDefinition } from './types.js';
import type { LLMProvider, LLMStreamEvent } from '../llm.js';
import { buildCodingCoreNativeSpecs } from './coding-core-tools.js';

const agentDefinition: AgentDefinition = {
  name: 'cwd-probe',
  systemPrompt: 'Run the requested tool.',
  tools: ['Bash'],
};

function fakeProvider(turns: LLMStreamEvent[][]): LLMProvider {
  let call = 0;
  return {
    name: 'fake',
    defaultModel: 'fake-model',
    available: () => true,
    async *streamChat() {
      for (const event of turns[call++] ?? []) yield event;
    },
    async *chat(messages, opts) {
      for await (const event of this.streamChat!(messages, opts)) {
        if (event.type === 'text') yield event.delta;
      }
    },
  } as LLMProvider;
}

describe('coding-core-tools — Phase 2 골든룰(native 이름배열 diff=0)', () => {
  test('buildCodingCoreNativeSpecs 이름배열 = 종전 CLI·continuation native 블록', () => {
    const names = buildCodingCoreNativeSpecs().map((s) => s.name);
    // coding/chat 조립기 통일로 의도적으로 포함된 하위 에이전트 다섯 도구도 이 기준선이 소유한다.
    expect(names).toEqual([
      'Read',
      'Grep',
      'Glob',
      'ListDir',
      'Edit',
      'Write',
      'Agent',
      'AgentOutput',
      'AgentReply',
      'AgentStop',
      'AgentList',
    ]);
  });

  test('연속 호출이 안정적(순수·부작용 없음 — 서피스 무관 재사용 안전)', () => {
    const a = buildCodingCoreNativeSpecs().map((s) => s.name);
    const b = buildCodingCoreNativeSpecs().map((s) => s.name);
    expect(a).toEqual(b);
  });

  test('각 spec 은 dispatch 가능한 형태(name·description 보유)', () => {
    for (const s of buildCodingCoreNativeSpecs()) {
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
    }
  });

  test('trusted working directory propagates to Bash without adding a model-controlled cwd argument', async () => {
    const childCwd = await mkdtemp(join(tmpdir(), 'elanous-cli-child-'));
    try {
      const catalog = buildCliAgentTools(undefined, undefined, childCwd);
      const result = await catalog.dispatch('Bash', { command: 'pwd' }) as { output: string };

      expect(catalog.workingDirectory).toBe(childCwd);
      expect(result.output.trim()).toBe(await realpath(childCwd));
    } finally {
      await rm(childCwd, { recursive: true, force: true });
    }
  });

  test('trusted working directory binds every relative native file tool path', async () => {
    const childCwd = await mkdtemp(join(tmpdir(), 'elanous-cli-child-'));
    try {
      await writeFile(join(childCwd, 'probe.txt'), 'child catalog\n');
      await mkdir(join(childCwd, 'explicit-dir'));
      await writeFile(join(childCwd, 'explicit-dir', 'explicit.txt'), 'explicit child catalog\n');
      const catalog = buildCliAgentTools(undefined, undefined, childCwd);
      const read = await catalog.dispatch('Read', { file_path: 'probe.txt' }) as { output: string };
      const grep = await catalog.dispatch('Grep', { pattern: 'child' }) as { output: string };
      const glob = await catalog.dispatch('Glob', { pattern: '*.txt' }) as { output: string };
      const list = await catalog.dispatch('ListDir', {}) as { output: string };
      const explicit = await catalog.dispatch('ListDir', { path: 'explicit-dir' }) as { output: string };
      await catalog.dispatch('Edit', { file_path: 'probe.txt', old_string: 'child', new_string: 'bound' });
      await catalog.dispatch('Write', { file_path: 'written.txt', content: 'bound\n' });

      expect(read.output).toContain('child catalog');
      expect(grep.output).toContain('probe.txt');
      expect(glob.output).toContain(join(childCwd, 'probe.txt'));
      expect(list.output).toContain('probe.txt');
      expect(explicit.output).toContain('explicit.txt');
      expect(readFileSync(join(childCwd, 'probe.txt'), 'utf8')).toBe('bound catalog\n');
      expect(readFileSync(join(childCwd, 'written.txt'), 'utf8')).toBe('bound\n');
    } finally {
      await rm(childCwd, { recursive: true, force: true });
    }
  });

  test('omitted working directory remains dispatch-time dynamic for Bash and relative file tools', async () => {
    const originalCwd = process.cwd();
    const laterCwd = await mkdtemp(join(tmpdir(), 'elanous-cli-later-cwd-'));
    try {
      await writeFile(join(laterCwd, 'probe.txt'), 'late-bound cwd\n');
      const catalog = buildCliAgentTools();

      process.chdir(laterCwd);
      const bash = await catalog.dispatch('Bash', { command: 'pwd' }) as { output: string };
      const read = await catalog.dispatch('Read', { file_path: 'probe.txt' }) as { output: string };

      expect(bash.output.trim()).toBe(await realpath(laterCwd));
      expect(read.output).toContain('late-bound cwd');
    } finally {
      process.chdir(originalCwd);
      await rm(laterCwd, { recursive: true, force: true });
    }
  });

  test('dispatchAgent reports one agent.spawn mismatch only when its trusted catalog disagrees with assigned cwd', async () => {
    debug.enable();
    debug.clear();
    const assignedCwd = process.cwd();
    await dispatchAgent(
      { description: 'mismatch probe', prompt: 'p', isolation: 'cwd' },
      {
        provider: fakeProvider([[{ type: 'text', delta: 'done' }]]),
        resolveAgentDef: () => agentDefinition,
        buildChildToolCatalog: () => ({
          specs: [],
          dispatch: async () => 'unused',
          workingDirectory: '/different-trusted-cwd',
        }),
      },
    );
    const mismatches = debug.tail(30).filter(line => line.includes('[agent.spawn]') && line.includes('tool-cwd-mismatch'));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain(assignedCwd);
    expect(mismatches[0]).toContain('/different-trusted-cwd');
  });

  test('CLI agent dispatch action passes its child cwd catalog factory to dispatchAgent', async () => {
    const requestedCwd = await mkdtemp(join(tmpdir(), 'elanous-dispatch-child-'));
    const printed = spyOn(console, 'log').mockImplementation(() => {});
    let factoryCwd: string | undefined;
    try {
      setCliAgentDispatchForTesting(async (_args, deps) => {
        expect(deps?.buildChildToolCatalog).toBeDefined();
        const catalog = deps!.buildChildToolCatalog!(requestedCwd);
        factoryCwd = catalog.workingDirectory;
        const result = await catalog.dispatch('Bash', { command: 'pwd' }) as { output: string };
        expect(result.output.trim()).toBe(await realpath(requestedCwd));
        return { output: 'done', agent: 'cwd-probe', durationMs: 1, maxTurns: 1, taskId: 'task-cwd', cid: 'cid-cwd' };
      });
      await program.parseAsync(['node', 'elanous', 'agent', 'dispatch', 'cwd-probe', 'pwd', '--quiet']);
      expect(factoryCwd).toBe(requestedCwd);
    } finally {
      setCliAgentDispatchForTesting(undefined);
      printed.mockRestore();
      await rm(requestedCwd, { recursive: true, force: true });
    }
  });

  test('dispatchAgent treats a symlinked catalog cwd as the assigned directory', async () => {
    debug.enable();
    debug.clear();
    const linkRoot = await mkdtemp(join(tmpdir(), 'elanous-assigned-cwd-link-'));
    const linkedCwd = join(linkRoot, 'cwd-link');
    try {
      await symlink(process.cwd(), linkedCwd);
      await dispatchAgent(
        { description: 'symlink cwd probe', prompt: 'p', isolation: 'cwd' },
        {
          provider: fakeProvider([[{ type: 'text', delta: 'done' }]]),
          resolveAgentDef: () => agentDefinition,
          buildChildToolCatalog: () => ({ specs: [], dispatch: async () => 'unused', workingDirectory: linkedCwd }),
        },
      );
      expect(debug.tail(30).filter(line => line.includes('tool-cwd-mismatch'))).toHaveLength(0);
    } finally {
      await rm(linkRoot, { recursive: true, force: true });
    }
  });

  test('dispatchAgent emits no mismatch when the catalog agrees or no catalog factory is supplied', async () => {
    debug.enable();
    debug.clear();
    await dispatchAgent(
      { description: 'matching probe', prompt: 'p', isolation: 'cwd' },
      {
        provider: fakeProvider([[{ type: 'text', delta: 'done' }]]),
        resolveAgentDef: () => agentDefinition,
        buildChildToolCatalog: (cwd) => ({ specs: [], dispatch: async () => 'unused', workingDirectory: cwd }),
      },
    );
    await dispatchAgent(
      { description: 'unknown catalog probe', prompt: 'p' },
      { provider: fakeProvider([[{ type: 'text', delta: 'done' }]]), resolveAgentDef: () => agentDefinition },
    );
    expect(debug.tail(40).filter(line => line.includes('tool-cwd-mismatch'))).toHaveLength(0);
  });
});

// BACKLOG L1b — CLI 도구 풀에서 ToolSearch 가 실제로 돈다(종전: `plugin tool unavailable in CLI: ToolSearch`).
describe('CLI dispatcher routes ToolSearch (BACKLOG L1b)', () => {
  test('select:Read returns the spec instead of the plugin-unavailable error', async () => {
    const catalog = buildCliAgentTools(undefined, undefined, process.cwd());
    const r = await catalog.dispatch('ToolSearch', { query: 'select:Read' });
    const text = JSON.stringify(r);
    expect(text).not.toContain('unavailable in CLI');
    expect(text).toContain('Read');
  });
});

// 대표 09-25 「이원화하면 스펙이 빠질 위험」 — 실제 CLI 도구 목록으로 불변식을 문다.
describe('tool profile invariants on the real CLI tool list', () => {
  test('full keeps every tool; coding ∪ removed = full; nothing falls between', async () => {
    const { buildUserConfig } = await import('../user-config.js');
    const { applyToolProfile, parseToolProfile } = await import('./tool-profile.js');
    const cfg = buildUserConfig('/nonexistent-elanous-probe/config.json');
    (cfg as { finance?: { enabled?: boolean } }).finance = { ...((cfg as { finance?: object }).finance ?? {}), enabled: true };
    const all = buildCliAgentTools(cfg, undefined, process.cwd()).specs.map((s) => s.name);
    expect(all).toContain('finance_quote');
    const full = applyToolProfile(all.map((name) => ({ name })), parseToolProfile('full'));
    expect(full.tools!.map((t) => t.name)).toEqual(all);
    const coding = applyToolProfile(all.map((name) => ({ name })), parseToolProfile('coding'));
    expect([...coding.tools!.map((t) => t.name), ...coding.removed].sort()).toEqual([...all].sort());
    expect(coding.removed.length).toBeGreaterThan(0);
  });

  // CHILD-TOOL-PROFILE-TRIM — 10-10 실측 27개(스키마 26,742자) → 코딩 도구 9개만 남는다.
  test('coding on the real CLI list (Plan on) leaves exactly the nine coding tools', async () => {
    const { applyToolProfile, parseToolProfile } = await import('./tool-profile.js');
    const all = buildCliAgentTools(undefined, { sessionId: 'trim-probe', emitFeedback: () => {} }, process.cwd()).specs;
    const coding = applyToolProfile(all, parseToolProfile('coding'));
    expect(coding.tools!.map((t) => t.name).sort()).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'ListDir', 'MarkStepDone', 'Plan', 'Read', 'Write']);
    expect([...coding.tools!.map((t) => t.name), ...coding.removed].sort()).toEqual(all.map((s) => s.name).sort());
  });
});

// 대표 09-25 — 기본 모드에서 뺀 금융 도구도 자식이 상황을 보고 ToolSearch 로 불러 쓸 수 있다(전체 목록에서 찾는다).
test('a finance tool omitted by the coding profile is still reachable through ToolSearch', async () => {
  const { buildUserConfig } = await import('../user-config.js');
  const cfg = buildUserConfig('/nonexistent-elanous-probe/config.json');
  (cfg as { finance?: { enabled?: boolean } }).finance = { ...((cfg as { finance?: object }).finance ?? {}), enabled: true };
  const catalog = buildCliAgentTools(cfg, undefined, process.cwd());
  const r = JSON.stringify(await catalog.dispatch('ToolSearch', { query: 'select:finance_quote' }));
  expect(r).toContain('finance_quote');
  expect(r).not.toContain('unavailable in CLI');
});

// CHILD-TOOL-PROFILE-TRIM — coding 에서 빠진 운영 도구도 ToolSearch 로 닿는다.
test('coo_admin omitted by the coding profile is still reachable through ToolSearch', async () => {
  const catalog = buildCliAgentTools(undefined, undefined, process.cwd());
  const r = JSON.stringify(await catalog.dispatch('ToolSearch', { query: 'select:coo_admin' }));
  expect(r).toContain('coo_admin');
  expect(r).not.toContain('unavailable in CLI');
});
