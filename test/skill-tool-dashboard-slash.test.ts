import { afterEach, describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';

import { buildDashboardSlashRegistry } from '../src/dashboard/slash-runtime/dashboard-handlers.js';
import { executeImmediateDashboardSlash } from '../src/dashboard/input/slash-executor.js';
import {
  buildDashboardSlashExecuteTool,
  dispatchDashboardSlashExecute,
  initDashboardSlashExecutor,
  _resetDashboardSlashExecutorForTesting,
  ALLOWED_SLASHES,
} from '../src/skills/tools/dashboard-slash.js';

afterEach(() => {
  _resetDashboardSlashExecutorForTesting();
});

describe('buildDashboardSlashExecuteTool', () => {
  test('schema includes name + args', () => {
    const t = buildDashboardSlashExecuteTool();
    expect(t.name).toBe('DashboardSlashExecute');
    const p = t.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(p.required).toContain('name');
    expect(p.properties.args).toBeDefined();
  });
});

describe('dispatchDashboardSlashExecute', () => {
  test('throws when no handler is wired', async () => {
    await expect(dispatchDashboardSlashExecute({ name: 'status' }))
      .rejects.toThrow(/not wired/);
  });

  test('throws when name is empty', async () => {
    await expect(dispatchDashboardSlashExecute(
      { name: '' },
      { handler: async () => ({ ok: true, name: '', args: [] }) },
    )).rejects.toThrow(/name.*required/);
  });

  test('blocked slash refuses without calling handler', async () => {
    let called = false;
    const handler = async () => { called = true; return { ok: true, name: 'quit', args: [] }; };
    const r = await dispatchDashboardSlashExecute({ name: 'quit' }, { handler });
    expect(r.output).toContain('refused');
    expect(r.output).toContain('block-list');
    expect(called).toBe(false);
  });

  test('unknown slash refuses without calling handler', async () => {
    let called = false;
    const handler = async () => { called = true; return { ok: true, name: 'mystery', args: [] }; };
    const r = await dispatchDashboardSlashExecute({ name: 'mystery' }, { handler });
    expect(r.output).toContain('not on the LLM allow-list');
    expect(called).toBe(false);
  });

  test('allow-listed slash dispatches + captures log lines', async () => {
    const handler = async ({ name, args }: { name: string; args: string[] }) => ({
      ok: true,
      name, args,
      logLines: [`  ran ${name}`, `  got ${args.length} args`],
    });
    const r = await dispatchDashboardSlashExecute(
      { name: 'status', args: [] },
      { handler },
    );
    expect(r.output).toContain('ok');
    expect(r.output).toContain('ran status');
  });

  test('handler failure surfaces error message', async () => {
    const handler = async () => ({
      ok: false, name: 'term', args: [], message: 'kaboom',
    });
    const r = await dispatchDashboardSlashExecute(
      { name: 'term', args: ['spawn'] },
      { handler },
    );
    expect(r.output).toContain('failed');
    expect(r.output).toContain('kaboom');
  });

  test('leading slash is stripped', async () => {
    let captured = '';
    const handler = async ({ name }: { name: string; args: string[] }) => {
      captured = name;
      return { ok: true, name, args: [] };
    };
    await dispatchDashboardSlashExecute({ name: '/status' }, { handler });
    expect(captured).toBe('status');
  });

  test('initDashboardSlashExecutor wires the default handler', async () => {
    let called = 0;
    initDashboardSlashExecutor(async () => { called++; return { ok: true, name: 's', args: [] }; });
    await dispatchDashboardSlashExecute({ name: 'status' });
    expect(called).toBe(1);
  });

  test('allow-list includes common commands', () => {
    expect(ALLOWED_SLASHES).toContain('term');
    expect(ALLOWED_SLASHES).not.toContain('window'); // D1a: VW `/window` 는 essential 에서 지워졌다
    expect(ALLOWED_SLASHES).toContain('claude');
    expect(ALLOWED_SLASHES).not.toContain('quit');
    expect(ALLOWED_SLASHES).not.toContain('debug');
  });
});

describe('ALLOWED_SLASHES — «약속한 이름»이 실제로 닿는가', () => {
  // 🔑 이 절이 막는 사고: 허용목록에만 있고 «아무 데도 닿지 않는» 이름은
  //   툴이 큐에 넣고 ok:true 를 돌려주므로, ***모델에게 실패를 성공으로 보고***한다.
  //   📏 2026-08-21 실측으로 'keys'·'keybindings' 가 정확히 그 상태였다.

  const registered = new Set(buildDashboardSlashRegistry().names());

  // 레거시 switch 는 «부를 수 있는 표면»이 없어 소스에서 읽는다.
  // ⛔ 읽기가 실패하면 집합이 비고 이 시험이 «조용히 통과»하므로, 비었는지를 «먼저» 막는다.
  const dashboardSource = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url).pathname, 'utf8');
  const dispatchAt = dashboardSource.indexOf('const slashOutcome = await dashboardSlashRegistry.dispatch(cmdLower, args, slashCtx);');
  const switchAt = dashboardSource.indexOf('switch (cmdLower) {', dispatchAt);
  const legacy = new Set(
    [...dashboardSource.slice(switchAt, switchAt + 60_000).matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]!),
  );

  const immediateDeps = {
    getStatusLines: () => ['status'],
    openSurfaceCatalog: () => true,
  };
  // ⛔ 인자 «0개»로만 치면 「인자를 요구하는」 즉시 명령이 「안 닿는다」로 «잘못» 보인다
  //   (📏 2026-08-21: /surf 는 args.length >= 1 일 때만 처리되는데 라이브에선 «작동»한다).
  //   ⇒ 대표 인자 하나를 같이 태운다. 실행이 던지면 그 시도만 «없던 것»으로 본다.
  const reachesImmediate = (name: string): boolean =>
    [[], ['catalog']].some((args) => {
      try {
        return executeImmediateDashboardSlash({ name, args }, immediateDeps) !== null;
      } catch {
        return false;
      }
    });

  test('the legacy-switch scan is not silently empty', () => {
    // ⛔ 「0건」이 「없다」가 아니라 「못 읽었다」일 수 있다 — 그것을 먼저 가른다.
    expect(dispatchAt).toBeGreaterThanOrEqual(0);
    expect(switchAt).toBeGreaterThan(dispatchAt);
    expect(legacy.size).toBeGreaterThan(0);
  });

  test('every allow-listed name is reachable by at least one dispatcher', () => {
    const unreachable = ALLOWED_SLASHES.filter(
      (name) => !registered.has(name) && !legacy.has(name) && !reachesImmediate(name),
    );
    expect(unreachable).toEqual([]);
  });

  test('a name that reaches nothing is rejected by this contract', () => {
    // 반증 — 이 시험이 «무는지»를 이 시험 자신이 보인다.
    const invented = 'definitely-not-a-slash-command';
    expect(registered.has(invented)).toBe(false);
    expect(legacy.has(invented)).toBe(false);
    expect(reachesImmediate(invented)).toBe(false);
    expect([invented].filter((n) => !registered.has(n) && !legacy.has(n) && !reachesImmediate(n))).toEqual([invented]);
  });
});
