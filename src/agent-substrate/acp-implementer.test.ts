import { describe, it, expect, spyOn } from 'bun:test';
import { AcpAgent, type AcpAgentOpts, type AcpPermissionApprover } from '../acp/client.js';
import { debug } from '../debug/log.js';
import { decideImplementerPermission, makeAcpImplementer } from './acp-implementer.js';

const WORKTREE = '/tmp/run-worktree';

type Child = { spec: { command: string; args: string[] }; env: NodeJS.ProcessEnv; cwd: string };

function stubPrototype() {
  const seen: { child?: Child; approver?: AcpPermissionApprover } = {};
  const start = spyOn(AcpAgent.prototype, 'start').mockImplementation(async function (this: AcpAgent) {
    seen.child = this as unknown as Child;
  });
  const newSession = spyOn(AcpAgent.prototype, 'newSession').mockResolvedValue('session-1');
  const prompt = spyOn(AcpAgent.prototype, 'prompt').mockResolvedValue({ stopReason: 'end_turn' });
  const stop = spyOn(AcpAgent.prototype, 'stop').mockResolvedValue();
  const restore = () => { start.mockRestore(); newSession.mockRestore(); prompt.mockRestore(); stop.mockRestore(); };
  return { seen, start, newSession, prompt, stop, restore };
}

describe('makeAcpImplementer', () => {
  it('claude-acp child spawns the subscription ACP with cwd at the run worktree', async () => {
    const stub = stubPrototype();
    try {
      const result = await makeAcpImplementer({
        worktree: WORKTREE, env: { PATH: '/bin', NODE_ENV: 'test' }, proxyBaseUrl: 'http://localhost:3456',
      })('implement');
      expect(stub.start).toHaveBeenCalledTimes(1);
      expect(stub.prompt).toHaveBeenCalledTimes(1);
      expect(stub.stop).toHaveBeenCalledTimes(1);
      expect(stub.seen.child?.spec.command).toBe('claude-agent-acp');
      expect(stub.seen.child?.spec.args).toEqual([]);
      expect(stub.seen.child?.cwd).toBe(WORKTREE);
      expect(stub.seen.child?.env.ANTHROPIC_BASE_URL).toBe('http://localhost:3456');
      expect(result.sessionId).toBe('session-1');
    } finally {
      stub.restore();
    }
  });

  it('ANTHROPIC_API_KEY is removed from the child env', async () => {
    const stub = stubPrototype();
    try {
      await makeAcpImplementer({
        worktree: WORKTREE,
        env: { PATH: '/bin', NODE_ENV: 'test', ANTHROPIC_API_KEY: 'key', ANTHROPIC_AUTH_TOKEN: 'token', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' },
      })('implement');
      expect(stub.seen.child?.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(stub.seen.child?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(stub.seen.child?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(stub.seen.child?.env.PATH).toBe('/bin');
    } finally {
      stub.restore();
    }
  });

  // 대표 대표 결정 10-12: 밖 쓰기 거부를 걷었다 — 밖 쓰기도 허가하고 insideWorktree:false 로 관측만 남긴다.
  it('a write outside the worktree is allowed and observed with insideWorktree:false', async () => {
    let approver: AcpPermissionApprover | undefined;
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as never);
    const agent = {
      start: async () => {},
      newSession: async () => 'session-1',
      selectSessionModel: async () => null,
      prompt: async () => {
        const req = (rawInput: unknown) => ({ backendId: 'claude', sessionId: 'session-1', title: 'Write', kind: 'edit', rawInput, options: [] });
        expect(await approver!(req({ file_path: '/etc/passwd' }))).toBe(true);
        expect(await approver!(req({ file_path: `${WORKTREE}/src/a.ts` }))).toBe(true);
        return { stopReason: 'end_turn' };
      },
      stop: async () => {},
      cancel: async () => {},
    } as unknown as AcpAgent;
    try {
      const result = await makeAcpImplementer({
        worktree: WORKTREE,
        createAgent: (opts) => { approver = opts.permissionApprover; return agent; },
      })('implement');
      expect(result).toMatchObject({ allowed: 2, denied: 0 });
      const permissions = events.filter((e) => e.category === 'agent-substrate.acp-implementer' && e.event === 'permission');
      expect(permissions.map((e) => e.data)).toEqual([
        { tool: 'Write', path: '/etc/passwd', insideWorktree: false, allowed: true },
        { tool: 'Write', path: `${WORKTREE}/src/a.ts`, insideWorktree: true, allowed: true },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps the host ACP permission mode (auto) — never switches the session mode to ask', async () => {
    const modeCalls: unknown[] = [];
    const agent = {
      start: async () => {}, newSession: async () => 'session-1', selectSessionModel: async () => null,
      setSessionMode: async (...args: unknown[]) => { modeCalls.push(['setSessionMode', ...args]); },
      setSessionModel: async (...args: unknown[]) => { modeCalls.push(['setSessionModel', ...args]); },
      prompt: async () => ({ stopReason: 'end_turn' }), stop: async () => {}, cancel: async () => {},
    } as unknown as AcpAgent;
    let seen: AcpAgentOpts | undefined;
    await makeAcpImplementer({ worktree: WORKTREE, model: 'sonnet', createAgent: (o) => { seen = o; return agent; } })('implement');
    await makeAcpImplementer({ worktree: WORKTREE, resumeSessionId: 'old', createAgent: () => ({ ...agent, loadSession: async () => ({}) }) as unknown as AcpAgent })('continue');
    expect(modeCalls).toEqual([]);
    expect(JSON.stringify(seen)).not.toMatch(/permissionMode|"default"|acceptEdits/);
  });

  it('resumes an existing session with loadSession instead of newSession', async () => {
    const loaded: unknown[] = [];
    const agent = {
      start: async () => {},
      newSession: async () => { throw new Error('newSession must not be called'); },
      loadSession: async (req: unknown) => { loaded.push(req); return {}; },
      prompt: async () => ({ stopReason: 'end_turn' }),
      stop: async () => {},
      cancel: async () => {},
    } as unknown as AcpAgent;
    const result = await makeAcpImplementer({
      worktree: WORKTREE, resumeSessionId: 'old-session', createAgent: () => agent,
    })('continue');
    expect(loaded).toEqual([{ sessionId: 'old-session', cwd: WORKTREE }]);
    expect(result.sessionId).toBe('old-session');
  });
});

describe('decideImplementerPermission', () => {
  // 대표 대표 결정 10-12: 밖 쓰기도 허가한다(거부 → 허가) — 밖인지는 insideWorktree 로만 남는다. 경로 없는 쓰기는 여전히 거부.
  it('allows write kinds outside the worktree (relative escapes too) but marks them insideWorktree:false; a path-less write is still denied', () => {
    expect(decideImplementerPermission({ title: 'Edit', kind: 'edit', rawInput: { file_path: '/etc/hosts' } }, WORKTREE))
      .toEqual({ tool: 'Edit', path: '/etc/hosts', insideWorktree: false, decision: 'allow' });
    expect(decideImplementerPermission({ title: 'Edit', kind: 'edit', rawInput: { file_path: '../other/a.ts' } }, WORKTREE))
      .toMatchObject({ insideWorktree: false, decision: 'allow' });
    expect(decideImplementerPermission({ title: 'Edit', kind: 'edit', rawInput: {} }, WORKTREE))
      .toEqual({ tool: 'Edit', path: null, insideWorktree: null, decision: 'deny' });
    expect(decideImplementerPermission({ title: 'Move', kind: 'move', rawInput: { source: 'a.ts', destination: '/tmp/b.ts' } }, WORKTREE))
      .toEqual({ tool: 'Move', path: '/tmp/b.ts', insideWorktree: false, decision: 'allow' });
  });

  it('allows write kinds inside the worktree, reads, and execution at the worktree cwd', () => {
    expect(decideImplementerPermission({ title: 'Edit', kind: 'edit', rawInput: { file_path: 'src/a.ts' } }, WORKTREE))
      .toMatchObject({ insideWorktree: true, decision: 'allow' });
    expect(decideImplementerPermission({ title: 'Read', kind: 'read', rawInput: { file_path: '/etc/hosts' } }, WORKTREE).decision).toBe('allow');
    expect(decideImplementerPermission({ title: 'Bash', kind: 'execute', rawInput: { command: 'bun test' } }, WORKTREE).decision).toBe('allow');
  });

  // 대표 대표 결정 10-12: 모르는 kind 도 경로가 있으면 안팎 무관 허가(밖 거부를 걷었다) — 경로 없는 요청만 거부.
  it('unknown kinds: a path-bearing request passes inside or outside; a path-less one is denied', () => {
    expect(decideImplementerPermission({ title: 'Write File', rawInput: { file_path: 'a.ts' } }, WORKTREE).decision).toBe('allow');
    expect(decideImplementerPermission({ title: 'Write File', rawInput: { file_path: '/root/a.ts' } }, WORKTREE))
      .toMatchObject({ insideWorktree: false, decision: 'allow' });
    expect(decideImplementerPermission({ title: 'Mystery' }, WORKTREE).decision).toBe('deny');
  });
});

describe('AcpAgentOpts shape used by the implementer', () => {
  it('passes the worktree as cwd and a permission approver to the injected factory', async () => {
    let seen: AcpAgentOpts | undefined;
    const agent = {
      start: async () => {}, newSession: async () => 's', prompt: async () => ({ stopReason: 'end_turn' }),
      stop: async () => {}, cancel: async () => {},
    } as unknown as AcpAgent;
    await makeAcpImplementer({ worktree: WORKTREE, createAgent: (opts) => { seen = opts; return agent; } })('p');
    expect(seen?.cwd).toBe(WORKTREE);
    expect(typeof seen?.permissionApprover).toBe('function');
    expect(seen?.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
