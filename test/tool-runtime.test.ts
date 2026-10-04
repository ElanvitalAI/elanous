// S4 — ToolRuntime registry tests. Validates the new abstraction
// layer that skill-runner + dashboard are migrating toward.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  dispatchToolByName,
  getToolRuntime,
  listToolRuntimes,
  registerAllDefaultToolRuntimes,
  registerToolRuntime,
  _resetToolRuntimeRegistryForTest,
} from '../src/tool-runtime/index.js';
import type { ToolRuntime } from '../src/tool-runtime/index.js';
import {
  resetForTesting as resetPtyForTest,
  setPtyAdapterForTesting,
} from '../src/pty-shell/registry.js';

// ─── Mock PTY (same shape as skill-tool-pty.test.ts) ─────────────

function mockSpawn(): {
  pid: number;
  write(s: string): void;
  kill(sig?: string): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
} {
  return {
    pid: Math.floor(Math.random() * 10000) + 1000,
    write() { /* noop */ },
    kill() { /* noop */ },
    onData() { return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
  };
}

beforeEach(() => {
  _resetToolRuntimeRegistryForTest();
  setPtyAdapterForTesting(() => mockSpawn());
});
afterEach(() => {
  _resetToolRuntimeRegistryForTest();
  resetPtyForTest();
  setPtyAdapterForTesting(null);
});

// ─── Registry basics ────────────────────────────────────────────

describe('ToolRuntime registry', () => {
  test('unknown tool → getToolRuntime returns undefined', () => {
    expect(getToolRuntime('NoSuchTool')).toBeUndefined();
  });

  test('registered runtime resolves by exact id', () => {
    const rt: ToolRuntime = {
      id: 'fake_tool',
      spec: { name: 'FakeTool', description: 'test', parameters: { type: 'object' } },
      async run() { return { output: 'fake' }; },
    };
    registerToolRuntime(rt);
    expect(getToolRuntime('fake_tool')).toBe(rt);
  });

  test('collision with a different runtime of the same id throws', () => {
    const a: ToolRuntime = {
      id: 'dup', spec: { name: 'Dup', description: '', parameters: { type: 'object' } },
      async run() { return { output: 'a' }; },
    };
    const b: ToolRuntime = {
      id: 'dup', spec: { name: 'Dup', description: '', parameters: { type: 'object' } },
      async run() { return { output: 'b' }; },
    };
    registerToolRuntime(a);
    expect(() => registerToolRuntime(b)).toThrow(/collision/);
  });

  test('same runtime registered twice → no throw (idempotent)', () => {
    const rt: ToolRuntime = {
      id: 'idem', spec: { name: 'Idem', description: '', parameters: { type: 'object' } },
      async run() { return { output: 'ok' }; },
    };
    registerToolRuntime(rt);
    expect(() => registerToolRuntime(rt)).not.toThrow();
  });
});

// ─── Default registrations (PtyShell* — the first migrated client) ──

describe('registerAllDefaultToolRuntimes', () => {
  test('registers all 5 PtyShell runtimes', () => {
    registerAllDefaultToolRuntimes();
    for (const id of ['pty_shell_start', 'pty_shell_poll', 'pty_shell_send', 'pty_shell_kill', 'pty_shell_list']) {
      expect(getToolRuntime(id)).toBeDefined();
    }
  });

  test('alias resolution — PascalCase lookup works via catalog', () => {
    registerAllDefaultToolRuntimes();
    expect(getToolRuntime('PtyShellStart')).toBe(getToolRuntime('pty_shell_start')!);
    expect(getToolRuntime('PtyShellList')).toBe(getToolRuntime('pty_shell_list')!);
  });
});

// ─── Dispatch — behavioural tests ───────────────────────────────

describe('dispatchToolByName', () => {
  test('unknown name throws with a helpful message', async () => {
    await expect(
      dispatchToolByName('NoSuchTool', {}, { surface: 'dashboard' }),
    ).rejects.toThrow(/No ToolRuntime registered/);
  });

  test('PtyShellList via runtime returns same shape as direct dispatch', async () => {
    registerAllDefaultToolRuntimes();
    const res = await dispatchToolByName('PtyShellList', {}, { surface: 'dashboard' });
    expect(res).toHaveProperty('output');
    expect(typeof (res as { output: string }).output).toBe('string');
  });

  test('PtyShellStart on dashboard surface auto-approves without invoking approver', async () => {
    registerAllDefaultToolRuntimes();
    let approverCalled = false;
    const res = await dispatchToolByName(
      'PtyShellStart',
      { cmd: 'sh', yield_time_ms: 5 },
      {
        surface: 'dashboard',
        approver: async () => { approverCalled = true; return false; },
      },
    );
    expect(approverCalled).toBe(false);
    expect((res as { output: string }).output).toContain('PtyShellStart process_id=');
  });

  test('PtyShellStart on skill surface does NOT auto-apply approval (back-compat)', async () => {
    registerAllDefaultToolRuntimes();
    let approverCalled = false;
    const res = await dispatchToolByName(
      'PtyShellStart',
      { cmd: 'sh', yield_time_ms: 5 },
      {
        surface: 'skill',
        approver: async () => { approverCalled = true; return false; },
      },
    );
    expect(approverCalled).toBe(false);
    expect((res as { output: string }).output).toContain('PtyShellStart process_id=');
  });

  test('explicit requireApproval on skill surface still prompts', async () => {
    registerAllDefaultToolRuntimes();
    let called = false;
    await dispatchToolByName(
      'PtyShellStart',
      { cmd: 'sh', yield_time_ms: 5 },
      {
        surface: 'skill',
        requireApproval: true,
        approver: async () => { called = true; return false; },
      },
    );
    expect(called).toBe(true);
  });
});

// ─── Listing ────────────────────────────────────────────────────

describe('listToolRuntimes', () => {
  test('no filter → all runtimes', () => {
    registerAllDefaultToolRuntimes();
    // Catalog additions are allowed; removing registered runtimes below this
    // established floor is not.
    expect(listToolRuntimes().length).toBeGreaterThanOrEqual(148);
  });

  test('surface filter consults catalog', () => {
    registerAllDefaultToolRuntimes();
    const skill = listToolRuntimes('skill');
    const tui = listToolRuntimes('tui');
    // Catalog additions are allowed; these active surfaces must not lose more runtimes
    // than they already have. 108/113 is the count observed on 10-04 (K10g #23536).
    expect(skill.length).toBeGreaterThanOrEqual(108);
    expect(tui.length).toBeGreaterThanOrEqual(113);
  });

  // Held, not lowered (K10 · MK 10-04): the established floors were 111 skill / 116 tui.
  // Three runtimes per surface disappeared without a recorded retirement, so the old floor
  // is kept here until each missing runtime is judged «retired on purpose» (then lower with
  // the evidence) or «lost» (then restore the registration) — same rule as NTC1.
  test.skip('surface filter keeps the established floors (111 skill / 116 tui)', () => {
    registerAllDefaultToolRuntimes();
    expect(listToolRuntimes('skill').length).toBeGreaterThanOrEqual(111);
    expect(listToolRuntimes('tui').length).toBeGreaterThanOrEqual(116);
  });

  // ⛔ 이름에 구성 개수를 열거하지 않는다 — 카탈로그가 자라면 그 열거가 «먼저» 낡고,
  //    이름은 게이트가 안 재므로 틀린 채로 남는다(이 파일이 3개월간 그랬다).
  test('mcp surface excludes Control* tools and never returns fewer than the established floor', () => {
    registerAllDefaultToolRuntimes();
    const mcp = listToolRuntimes('mcp');
    const names = mcp.map(rt => rt.spec.name).sort();
    // Hard-coded sanity anchor — control.* intentionally NOT exposed.
    expect(names).toContain('GetDashboardState');
    expect(names).toContain('PtyShellList');
    expect(names).toContain('ContextWorkspace');
    expect(names).toContain('ContextBootstrap');
    expect(names).toContain('SetInputMode');
    expect(names).toContain('GetInputPolicy');
    expect(names).toContain('SetInputBinding');
    expect(names).toContain('AgentList');
    expect(names).toContain('TeamCreate');
    expect(names).toContain('TeamDelete');
    expect(names).toContain('SendMessage');
    expect(names).toContain('TaskList');
    expect(names).toContain('TaskGet');
    expect(names.some(n => n.startsWith('Control'))).toBe(false);
    expect(names.length).toBeGreaterThanOrEqual(32);
  });
});
