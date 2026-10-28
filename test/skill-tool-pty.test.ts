import { afterEach, beforeEach, describe, expect, test , spyOn} from 'bun:test';
import { debug } from '../src/debug/log.js';
import { HARNESS_BOUNDARY_ENV, HARNESS_SPACE_ENV } from '../src/harness/harness-space.js';

import {
  getPty,
  killNonDetached,
  listPty,
  resetForTesting,
  setPtyAdapterForTesting,
} from '../src/pty-shell/registry.js';
import {
  buildPtyShellKillTool,
  buildPtyShellListTool,
  buildPtyShellPollTool,
  buildPtyShellSendTool,
  buildPtyShellStartTool,
  dispatchPtyShellKill,
  dispatchPtyShellList,
  dispatchPtyShellPoll,
  dispatchPtyShellSend,
  dispatchPtyShellStart,
} from '../src/skills/tools/pty.js';

// ─── Mock PTY adapter ───────────────────────────────────────────

type DataCb = (data: string) => void;
type ExitCb = (e: { exitCode: number; signal?: number }) => void;

interface MockController {
  emitData(s: string): void;
  emitExit(code: number, signal?: number): void;
}

const controllers: MockController[] = [];
const writes: string[] = [];
const kills: string[] = [];
const killEvents: Array<{ pid: number; signal: string }> = [];
let pidCounter = 1000;
const harnessEnv = new Map([
  [HARNESS_SPACE_ENV, process.env[HARNESS_SPACE_ENV]],
  [HARNESS_BOUNDARY_ENV, process.env[HARNESS_BOUNDARY_ENV]],
]);

function mockSpawn(): {
  pid: number;
  write(s: string): void;
  kill(sig?: string): void;
  onData(cb: DataCb): { dispose(): void };
  onExit(cb: ExitCb): { dispose(): void };
} {
  const dataCbs: DataCb[] = [];
  const exitCbs: ExitCb[] = [];
  const ctrl: MockController = {
    emitData: (s) => dataCbs.forEach(cb => cb(s)),
    emitExit: (code, signal) => exitCbs.forEach(cb => cb({ exitCode: code, signal })),
  };
  controllers.push(ctrl);
  const pid = pidCounter++;
  return {
    pid,
    write(s) { writes.push(s); },
    kill(sig) {
      const signal = sig ?? 'SIGTERM';
      kills.push(signal);
      killEvents.push({ pid, signal });
      // The synthetic process exits on a signal, as a cooperative PTY does.
      // This also cancels its escalation timer before the next test starts.
      ctrl.emitExit(0);
    },
    onData(cb) { dataCbs.push(cb); return { dispose() { /* noop */ } }; },
    onExit(cb) { exitCbs.push(cb); return { dispose() { /* noop */ } }; },
  };
}

beforeEach(() => {
  controllers.length = 0;
  writes.length = 0;
  kills.length = 0;
  killEvents.length = 0;
  delete process.env[HARNESS_SPACE_ENV];
  delete process.env[HARNESS_BOUNDARY_ENV];
  setPtyAdapterForTesting(() => mockSpawn());
});

afterEach(() => {
  resetForTesting();
  setPtyAdapterForTesting(null);
  for (const [key, value] of harnessEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ─── Schema tests ───────────────────────────────────────────────

describe('PtyShell tool schemas', () => {
  test('start: cmd required', () => {
    expect(buildPtyShellStartTool().parameters.required).toEqual(['cmd']);
  });
  test('poll: process_id required', () => {
    expect(buildPtyShellPollTool().parameters.required).toEqual(['process_id']);
  });
  test('send: process_id + input required', () => {
    expect(buildPtyShellSendTool().parameters.required).toEqual(['process_id', 'input']);
  });
  test('kill: process_id required', () => {
    expect(buildPtyShellKillTool().parameters.required).toEqual(['process_id']);
  });

  test('PV3 — start schema advertises visibility enum', () => {
    const props = buildPtyShellStartTool().parameters.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(props.visibility).toBeDefined();
    expect(props.visibility!.enum).toEqual(['user', 'llm-only', 'both']);
    expect(props.visibility!.description).toContain('llm-only');
  });
});

// ─── Lifecycle ──────────────────────────────────────────────────

describe('PtyShellStart', () => {
  test('creates a process and returns process_id + initial yield', async () => {
    const startPromise = dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 60 });
    // Spawn can be delayed on a loaded host; emit after the adapter exists.
    while (!controllers[0]) await Bun.sleep(1);
    controllers[0].emitData('hello\n');
    const r = await startPromise;
    expect(r.output).toMatch(/process_id=pty_/);
    expect(r.output).toContain('hello');
    expect(listPty().length).toBe(1);
  });

  test('rejects start when cmd missing', async () => {
    await expect(dispatchPtyShellStart({})).rejects.toThrow(/cmd/);
  });
});

describe('PtyShellPoll', () => {
  test('returns delta since last read', async () => {
    const start = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 30 });
    const id = String(start.output.match(/process_id=(\w+)/)?.[1]);
    controllers[0].emitData('first\n');
    const a = await dispatchPtyShellPoll({ process_id: id, yield_time_ms: 30 });
    expect(a.output).toContain('first');
    controllers[0].emitData('second\n');
    const b = await dispatchPtyShellPoll({ process_id: id, yield_time_ms: 30 });
    expect(b.output).toContain('second');
    expect(b.output).not.toContain('first'); // already drained
  });

  test('unknown process_id throws', async () => {
    await expect(dispatchPtyShellPoll({ process_id: 'pty_nope' })).rejects.toThrow(/unknown/);
  });
});

describe('PtyShellSend', () => {
  test('starts an agent-owned PTY that accepts agent writes and rejects human writes until takeover', async () => {
    const start = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 30 });
    const id = String(start.output.match(/process_id=(\w+)/)?.[1]);
    const handle = getPty(id)!;
    expect(handle.accessMode).toBe('auto');
    expect(handle.canWrite('agent')).toBe(true);
    expect(handle.canWrite('human')).toBe(false);
    handle.write('human attempt', 'human');
    expect(writes).not.toContain('human attempt');

    const write = spyOn(handle, 'write');
    const settled: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'pty.arbiter' && event === 'control-settled') settled.push(data);
    }) as typeof debug.log);
    try {
      setTimeout(() => controllers[0].emitData('echoed\n'), 20);
      const r = await dispatchPtyShellSend({ process_id: id, input: 'hi\n', yield_time_ms: 60 });
      expect(write).toHaveBeenCalledWith('hi\r', 'agent');
      expect(r.output).toContain(`PtyShellSend process_id=${id} status=running bytes=`);
      expect(r.output).toContain('submitNormalized=true');
      expect(r.output).toContain('echoed');
    } finally { log.mockRestore(); }
    expect(settled).toEqual([{ id, action: 'input-text', actor: 'agent', outcome: 'success' }]);
  });

  test('keeps denied agent control output when a human-owned PTY is passed to the agent tool', async () => {
    const start = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 });
    const id = String(start.output.match(/process_id=(\w+)/)?.[1]);
    const handle = getPty(id)!;
    handle.accessMode = 'write';
    const write = spyOn(handle, 'write');
    const settled: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'pty.arbiter' && event === 'control-settled') settled.push(data);
    }) as typeof debug.log);
    try {
      const r = await dispatchPtyShellSend({ process_id: id, input: 'blocked\n', yield_time_ms: 5 });
      expect(write).not.toHaveBeenCalled();
      expect(r.submitNormalized).toBe(false);
      // ⛔ 거부문은 «셋»을 담는다 — 거부됐다 · 왜 · 무엇을 하면 되나(형제 거부문과 같은 한글 문면).
      expect(r.output).toContain('쓰기 거부');
      expect(r.output).toContain('사람이 쓰기 소유');
      expect(r.output).toContain(`elanous pty release ${id}`);
    } finally { log.mockRestore(); }
    expect(settled).toEqual([{ id, action: 'input-text', actor: 'agent', outcome: 'denied' }]);
  });

  test('reports a failed adapter write and observes it as a settled agent control action', async () => {
    const start = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 });
    const id = String(start.output.match(/process_id=(\w+)/)?.[1]);
    const handle = getPty(id)!;
    const settled: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
      if (category === 'pty.arbiter' && event === 'control-settled') settled.push(data);
    }) as typeof debug.log);
    spyOn(handle, 'write').mockImplementation(() => { throw new Error('adapter write failed'); });
    try {
      const r = await dispatchPtyShellSend({ process_id: id, input: 'broken\n', yield_time_ms: 5 });
      expect(r.submitNormalized).toBe(false);
      expect(r.output).toContain('쓰기 실패');
      expect(r.output).toContain(id);
    } finally { log.mockRestore(); }
    expect(settled).toEqual([{ id, action: 'input-text', actor: 'agent', outcome: 'write-failed' }]);
  });

  test('refuses send to dead process', async () => {
    const start = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 30 });
    const id = String(start.output.match(/process_id=(\w+)/)?.[1]);
    controllers[0].emitExit(0);
    await expect(dispatchPtyShellSend({ process_id: id, input: 'x' })).rejects.toThrow(/exited/);
  });
});

describe('PtyShellKill', () => {
  test('signals SIGTERM by default and unregisters', async () => {
    const start = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 30 });
    const id = String(start.output.match(/process_id=(\w+)/)?.[1]);
    const r = await dispatchPtyShellKill({ process_id: id });
    expect(kills).toEqual(['SIGTERM']);
    expect(r.output).toContain('killed=true');
    expect(listPty().length).toBe(0);
  });

  test('respects custom signal', async () => {
    const start = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 30 });
    const id = String(start.output.match(/process_id=(\w+)/)?.[1]);
    await dispatchPtyShellKill({ process_id: id, signal: 'SIGKILL' });
    expect(kills).toEqual(['SIGKILL']);
  });

  test('killing already-exited process reports killed=false', async () => {
    const start = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 30 });
    const id = String(start.output.match(/process_id=(\w+)/)?.[1]);
    controllers[0].emitExit(0);
    const r = await dispatchPtyShellKill({ process_id: id });
    expect(r.output).toContain('killed=false');
  });
});

// ─── Registry policy ────────────────────────────────────────────

describe('PtyShellSend — 말미 개행 정규화 (INCIDENT #5829)', () => {
  const cases: Array<[string, string, string, boolean]> = [
    // [설명, 입력, 실제로 쓰여야 하는 바이트, submitNormalized]
    ['LF → CR',            'a\n',      'a\r',      true],
    ['CRLF → CR 하나',      'a\r\n',    'a\r',      true],
    ['이미 CR → 그대로',     'a\r',      'a\r',      false],
    ['개행 없음 → 안 붙임',   'a',        'a',        false],
    ['⭐ 중간 개행 보존',     'a\nb\n',   'a\nb\r',   true],
  ];
  for (const [name, input, expected, normalized] of cases) {
    test(name, async () => {
      const start = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 });
      const id = String(start.output.match(/process_id=(\w+)/)?.[1]);
      getPty(id)!.accessMode = 'auto';
      writes.length = 0;
      const r = await dispatchPtyShellSend({ process_id: id, input, yield_time_ms: 5 });
      expect(writes).toContain(expected);
      expect(r.submitNormalized).toBe(normalized);
    });
  }

  // ⭐ 무인 리뷰 should-fix — 관측이 **입력 본문을 흘리지 않는지** 고정한다.
  //    분류값·불리언·길이만 남아야 한다(사용자 데이터 유출 방지).
  test('관측에 입력 본문이 실리지 않는다', async () => {
    const seen: unknown[] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((c: string, _e: string, d?: unknown) => {
      if (c === 'pty.shell-send') seen.push(d);
    }) as typeof debug.log);
    try {
      const start = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 });
      const id = String(start.output.match(/process_id=(\w+)/)?.[1]);
      getPty(id)!.accessMode = 'auto';
      await dispatchPtyShellSend({ process_id: id, input: 'SECRET_BODY\n', yield_time_ms: 5 });
    } finally { spy.mockRestore(); }
    expect(seen.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(seen);
    expect(dumped).not.toContain('SECRET_BODY');   // ⛔ 원문
    expect(dumped).toContain('trailingNewline');   // ✅ 분류값
  });
});

describe('registry — concurrency cap', () => {
  test('reaps exited PTYs, LRU-evicts live non-detached PTYs, and rejects only with no eviction candidate', async () => {
    const idFrom = (output: string) => String(output.match(/process_id=(\w+)/)?.[1]);

    const exited = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 });
    const exitedId = idFrom(exited.output);
    for (let i = 1; i < 8; i++) await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 });
    controllers[0].emitExit(0);

    const afterReap = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 });
    const afterReapId = idFrom(afterReap.output);
    expect(listPty().length).toBe(8);
    expect(listPty().some(h => h.id === exitedId)).toBe(false);
    expect(listPty().some(h => h.id === afterReapId)).toBe(true);

    resetForTesting();
    setPtyAdapterForTesting(() => mockSpawn());
    kills.length = 0;
    killEvents.length = 0;
    const liveIds: string[] = [];
    const livePids: number[] = [];
    for (let i = 0; i < 8; i++) {
      const started = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 });
      liveIds.push(idFrom(started.output));
      livePids.push(pidCounter - 1);
    }
    await dispatchPtyShellPoll({ process_id: liveIds[0], yield_time_ms: 5 });

    const afterEvict = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 });
    const afterEvictId = idFrom(afterEvict.output);
    expect(killEvents).toEqual([{ pid: livePids[1], signal: 'SIGKILL' }]);
    expect(kills).toEqual(['SIGKILL']);
    expect(listPty().length).toBe(8);
    expect(listPty().some(h => h.id === liveIds[0])).toBe(true);
    expect(listPty().some(h => h.id === liveIds[1])).toBe(false);
    expect(listPty().some(h => h.id === afterEvictId)).toBe(true);

    resetForTesting();
    setPtyAdapterForTesting(() => mockSpawn());
    for (let i = 0; i < 8; i++) await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5, detach: true });
    await expect(dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 })).rejects.toThrow(/max 8 concurrent PTY shells reached/);
  });
});

describe('registry — auto-kill on skill end', () => {
  test('killNonDetached kills non-detached, keeps detached', async () => {
    const a = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 });
    const b = await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5, detach: true });
    const idB = String(b.output.match(/process_id=(\w+)/)?.[1]);
    const killed = killNonDetached();
    expect(killed).toBeGreaterThanOrEqual(1);
    expect(listPty().some(h => h.id === idB)).toBe(true);
    expect(listPty().some(h => h.id !== idB)).toBe(false);
  });
});

describe('catalog registration', () => {
  test('all 4 PTY tools have probe + hide on missing node-pty', async () => {
    const { nativeToolCatalog } = await import('../src/native-tool-catalog.js');
    for (const id of ['pty_shell_start', 'pty_shell_poll', 'pty_shell_send', 'pty_shell_kill']) {
      const e = nativeToolCatalog.find(t => t.id === id);
      expect(e).toBeDefined();
      expect(e!.probe?.kind).toBe('custom');
      expect(e!.probe?.onFail).toBe('hide');
    }
  });
});

// ─── P1: Ghostty TERM propagation ───────────────────────────────

describe('PtyShell term propagation', () => {
  test('schema advertises term in properties', () => {
    const props = buildPtyShellStartTool().parameters.properties as Record<string, { description?: string }>;
    expect(props.term).toBeDefined();
    expect(props.term.description).toMatch(/xterm-ghostty/);
  });

  test('start accepts xterm-ghostty and forwards to adapter', async () => {
    const spawned: Array<Record<string, unknown>> = [];
    setPtyAdapterForTesting((o) => {
      spawned.push({ term: o.term, env: o.env });
      return mockSpawn();
    });
    await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5, term: 'xterm-ghostty' });
    expect(spawned[0]).toBeDefined();
    expect(spawned[0].term).toBe('xterm-ghostty');
  });

  test('start without term uses default xterm-256color', async () => {
    const spawned: Array<Record<string, unknown>> = [];
    setPtyAdapterForTesting((o) => {
      spawned.push({ term: o.term });
      return mockSpawn();
    });
    await dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5 });
    // The opts.term is undefined; registry applies DEFAULT_TERM_NAME
    // at spawn time — adapter gets `undefined` on the StartOpts, but
    // the REAL spawn wraps it into `name: term`. For the test adapter
    // we only assert opts.term was untouched (undefined is OK).
    expect(spawned[0].term).toBeUndefined();
  });

  test('start rejects unsupported term', async () => {
    await expect(
      dispatchPtyShellStart({ cmd: 'sh', yield_time_ms: 5, term: 'dec-vt220' as string }),
    ).rejects.toThrow(/unsupported term/);
  });
});

// ─── Dashboard promotion: approval gate ──────────────────────────
// S1: dispatchPtyShellStart gains a requireApproval branch used by
// the dashboard chat loop. Skill-runner does NOT pass this, so
// back-compat path stays unchanged.

// ─── List (S3) ──────────────────────────────────────────────────

describe('PtyShellList', () => {
  test('empty registry → "no active processes" message', () => {
    const r = dispatchPtyShellList();
    expect(r.output).toContain('no active');
  });

  test('lists spawned processes with id + state + cmd', async () => {
    await dispatchPtyShellStart({ cmd: 'sh', args: ['-c', 'echo hi'], yield_time_ms: 5 });
    await dispatchPtyShellStart({ cmd: 'bash', yield_time_ms: 5, detach: true });
    const r = dispatchPtyShellList();
    expect(r.output).toContain('2 process(es)');
    expect(r.output).toContain('running');
    expect(r.output).toContain('detach');      // second was detach:true
    expect(r.output).toContain('auto-kill');    // first was not
    expect(r.output).toContain('cmd="sh"');
  });

  test('tool spec has no required args', () => {
    expect(buildPtyShellListTool().parameters.required).toBeUndefined();
  });

  test('catalog entry present + host covers skill/tui/mcp', async () => {
    const { nativeToolCatalog } = await import('../src/native-tool-catalog.js');
    const e = nativeToolCatalog.find(t => t.id === 'pty_shell_list');
    expect(e).toBeDefined();
    expect(e!.host).toEqual(['skill', 'tui', 'mcp']);
    expect(e!.safety).toEqual(['read-only']);
  });
});

describe('PtyShellStart approval (dashboard scope)', () => {
  test('default dispatch skips approver (skill back-compat)', async () => {
    let approverCalled = false;
    const res = await dispatchPtyShellStart(
      { cmd: 'sh', yield_time_ms: 5 },
      { approver: async () => { approverCalled = true; return false; } },
    );
    // Without requireApproval: true, the approver is never consulted.
    expect(approverCalled).toBe(false);
    expect(res.output).toContain('PtyShellStart');
  });

  test('requireApproval=true + approver denies → no spawn, explanatory output', async () => {
    const before = listPty().length;
    const res = await dispatchPtyShellStart(
      { cmd: 'sh', yield_time_ms: 5 },
      { requireApproval: true, approver: async () => false },
    );
    expect(res.output).toContain('denied');
    expect(res.output).toContain('cmd=sh');
    expect(listPty().length).toBe(before);  // nothing spawned
  });

  test('requireApproval=true + approver allows → spawn proceeds', async () => {
    let prompt: { cmd: string; args?: string[]; cwd?: string } | null = null;
    const res = await dispatchPtyShellStart(
      { cmd: 'sh', args: ['-c', 'echo hi'], workdir: '/tmp', yield_time_ms: 5 },
      {
        requireApproval: true,
        approver: async (req) => { prompt = req; return true; },
      },
    );
    expect(prompt).not.toBeNull();
    expect(prompt!.cmd).toBe('sh');
    expect(prompt!.args).toEqual(['-c', 'echo hi']);
    expect(prompt!.cwd).toBe('/tmp');
    expect(res.output).toContain('PtyShellStart process_id=');
  });
});
