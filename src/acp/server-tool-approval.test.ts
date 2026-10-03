import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getUserConfig, resetUserConfig } from '../user-config.js';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { createInProcessAcpBridge } from '../tui-client/acp-transport-local.js';
import type { AcpTransportServer } from './transport/index.js';
import { acpApprovalGatedDispatch } from './core-turn-bridge.js';
import { createCodexApprovalAdapter } from './codex-approval-adapter.js';
import { answerCodexApprovalQuestion } from './turn-runner.js';
import { createAcpSessionApprovalPolicy, acpToolDenialResult, requiresAcpToolApproval } from './tool-approval.js';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  runAcpServer,
  type AcpTurnContext,
  type AcpApprovalDecision,
  type AcpToolDenialReason,
} from './server.js';

const request = (toolName: string) => ({ toolCallId: 'call-1', toolName, toolArgs: { path: 'file.txt' } });

async function withAcpClient(
  config: Record<string, unknown>,
  runTurn: NonNullable<NonNullable<Parameters<typeof runAcpServer>[0]>['runTurn']>,
  requestPermission: (req: { toolCall: { title?: string }; options: readonly { optionId: string }[] }) => Promise<unknown>,
  prompts = 1,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'acp-approval-'));
  const prior = process.env.XDG_CONFIG_HOME;
  mkdirSync(join(root, 'elanous'));
  writeFileSync(join(root, 'elanous', 'config.json'), JSON.stringify(config));
  process.env.XDG_CONFIG_HOME = root;
  resetUserConfig();
  const abort = new AbortController();
  const bridge = createInProcessAcpBridge();
  try {
    const server = runAcpServer({
      shutdownSignal: abort.signal,
      transportFactory: async (onConnection): Promise<AcpTransportServer> => {
        void onConnection({
          readable: bridge.a.readable, writable: bridge.a.writable, peerId: 'approval-config',
          close: async () => { try { await bridge.a.writable.close(); } catch {} },
        });
        return { kind: 'in-process', address: 'test://approval-config', close: async () => {} };
      },
      runTurn,
    });
    const client = new ClientSideConnection(() => ({
      async sessionUpdate() {},
      requestPermission: requestPermission as never,
    }), ndJsonStream(bridge.b.writable, bridge.b.readable));
    try {
      await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      for (let i = 0; i < prompts; i++) {
        await client.prompt({ sessionId, prompt: [{ type: 'text', text: `turn ${i}` }] });
      }
    } finally {
      abort.abort();
      try { await bridge.b.writable.close(); } catch {}
      try { await bridge.a.writable.close(); } catch {}
      await server;
    }
  } finally {
    if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior;
    resetUserConfig();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('ACP session tool approval policy', () => {
  test('read tools are not asked; write, edit, patch and shell tools are', async () => {
    const policy = createAcpSessionApprovalPolicy();
    let prompts = 0;
    const approver: AcpTurnContext['requestApproval'] = async () => {
      prompts++;
      return 'allow-once';
    };
    for (const name of ['Read', 'Grep', 'Glob', 'WebSearch', 'Plan', 'AskUserQuestion', 'functions.Read']) {
      expect(requiresAcpToolApproval(name)).toBe(false);
      expect(await policy.resolve('session-a', request(name), approver)).toEqual({ allowed: true });
    }
    expect(prompts).toBe(0);
    for (const name of ['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'Bash', 'PtyShellStart', 'functions.Write', 'codex exec']) {
      expect(requiresAcpToolApproval(name)).toBe(true);
      expect(await policy.resolve('session-a', request(name), approver)).toEqual({ allowed: true });
    }
    expect(prompts).toBe(8);
  });

  test('allow-always persists for the exact tool in the same ACP session only', async () => {
    const policy = createAcpSessionApprovalPolicy();
    const prompts: string[] = [];
    const approver: AcpTurnContext['requestApproval'] = async ({ toolName }) => {
      prompts.push(toolName);
      return 'allow-always';
    };
    expect(await policy.resolve('session-a', request('Write'), approver)).toEqual({ allowed: true });
    expect(await policy.resolve('session-a', request('Write'), approver)).toEqual({ allowed: true });
    expect(await policy.resolve('session-a', request('Edit'), approver)).toEqual({ allowed: true });
    expect(await policy.resolve('session-b', request('Write'), approver)).toEqual({ allowed: true });
    expect(prompts).toEqual(['Write', 'Edit', 'Write']);
    policy.clearSession('session-a');
    expect(await policy.resolve('session-a', request('Write'), approver)).toEqual({ allowed: true });
    expect(prompts).toEqual(['Write', 'Edit', 'Write', 'Write']);
  });

  test('a pending allow-always cannot reinstate a cleared session grant', async () => {
    const policy = createAcpSessionApprovalPolicy();
    let reply!: (decision: AcpApprovalDecision) => void;
    const pending = policy.resolve('s', request('Write'), () => new Promise((resolve) => { reply = resolve; }));
    policy.clearSession('s');
    reply('allow-always');
    expect(await pending).toEqual({ allowed: false, reason: 'cancelled' });
    expect(await policy.resolve('s', request('Write'), async () => 'deny-once'))
      .toEqual({ allowed: false, reason: 'rejected' });
  });

  test('allow-once never persists; every rejection, cancellation, timeout and approver error denies', async () => {
    const policy = createAcpSessionApprovalPolicy();
    let prompts = 0;
    const once: AcpTurnContext['requestApproval'] = async () => {
      prompts++;
      return 'allow-once';
    };
    expect(await policy.resolve('s', request('Bash'), once)).toEqual({ allowed: true });
    expect(await policy.resolve('s', request('Bash'), once)).toEqual({ allowed: true });
    expect(prompts).toBe(2);
    const expected: Array<[AcpApprovalDecision, AcpToolDenialReason]> = [
      ['deny-once', 'rejected'], ['deny-always', 'rejected'], ['cancelled', 'cancelled'], ['timeout', 'timeout'],
    ];
    for (const [decision, reason] of expected) {
      expect(await policy.resolve('s', request('Bash'), async () => decision))
        .toEqual({ allowed: false, reason });
    }
    expect(await policy.resolve('s', request('Bash'), async () => { throw new Error('transport closed'); }))
      .toEqual({ allowed: false, reason: 'error' });
    expect(await policy.resolve('s', request('Bash'), once)).toEqual({ allowed: true });
    expect(prompts).toBe(3);
  });

  test('core-turn dispatcher does not run denied, timed-out or cancelled tools and says why', async () => {
    const executed: string[] = [];
    const abort = new AbortController();
    const turn = {
      isAborted: () => abort.signal.aborted,
      approveTool: async ({ toolName }: { toolName: string }) => (
        toolName === 'Read' ? { allowed: true }
          : toolName === 'Bash' ? { allowed: false, reason: 'timeout' }
            : { allowed: false, reason: 'rejected' }),
    } as unknown as AcpTurnContext;
    const dispatch = acpApprovalGatedDispatch(turn, async (name) => {
      executed.push(name);
      return 'executed';
    }, abort.signal);
    const rejected = await dispatch('Write', {}, { callId: '1' }) as { error: string };
    expect(rejected.error).toBe('Write: 사람이 이 호출을 거절했다. 같은 턴에서 같은 도구를 다시 요청하지 말고, 이유를 묻거나 다른 길을 제안하라 — 실행하지 않았다 (tool not run: approval rejected)');
    const timedOut = await dispatch('Bash', {}, { callId: '2' }) as { error: string };
    expect(timedOut.error).toContain('답이 없었다');
    expect(await dispatch('Read', {}, { callId: '3' })).toBe('executed');
    abort.abort();
    expect((await dispatch('Read', {}, { callId: '4' }) as { error: string }).error).toContain('취소');
    expect(executed).toEqual(['Read']);
  });

  test('same-turn rejection skips only the rejected tool; next turn asks again', async () => {
    const policy = createAcpSessionApprovalPolicy();
    const denied = new Set<string>();
    const executed: string[] = [];
    const asked: string[] = [];
    const approver: AcpTurnContext['requestApproval'] = async ({ toolName }) => {
      asked.push(toolName);
      return 'deny-once';
    };
    const turn = {
      isAborted: () => false,
      approveTool: (req: ReturnType<typeof request>) => policy.resolve('s', req, approver, denied),
    } as unknown as AcpTurnContext;
    const dispatch = acpApprovalGatedDispatch(turn, async (name) => {
      executed.push(name);
      return 'executed';
    }, new AbortController().signal);
    expect((await dispatch('Bash', {}, { callId: '1' }) as { error: string }).error).toContain('다시 요청하지 말고');
    expect(asked).toEqual(['Bash']);
    expect((await dispatch('Bash', {}, { callId: '2' }) as { error: string }).error).toContain('다시 요청하지 말고');
    expect(asked).toEqual(['Bash']);
    expect((await dispatch('Write', {}, { callId: '3' }) as { error: string }).error).toContain('실행하지 않았다');
    expect(asked).toEqual(['Bash', 'Write']);
    expect(executed).toEqual([]);
    expect(await policy.resolve('s', request('Bash'), approver, new Set())).toEqual({ allowed: false, reason: 'rejected' });
    expect(asked).toEqual(['Bash', 'Write', 'Bash']);
  });

  test('concurrent same-turn calls to one tool open one sheet; the second sees the first denial (round 1 should-fix)', async () => {
    const policy = createAcpSessionApprovalPolicy();
    const denied = new Set<string>();
    let asks = 0;
    let answer!: () => void;
    const approver: AcpTurnContext['requestApproval'] = () => {
      asks++;
      return new Promise((done) => { answer = () => done('deny-once'); });
    };
    const first = policy.resolve('s', request('Bash'), approver, denied);
    const second = policy.resolve('s', request('Bash'), approver, denied);
    const other = policy.resolve('s', request('Write'), async () => { asks++; return 'allow-once'; }, denied);
    await Promise.resolve();
    await Promise.resolve();
    expect(asks).toBe(2); // Bash once (second is waiting) + Write, which is a different tool and not held back.
    answer();
    expect(await first).toEqual({ allowed: false, reason: 'rejected' });
    expect(await second).toEqual({ allowed: false, reason: 'rejected' });
    expect(await other).toEqual({ allowed: true });
    expect(asks).toBe(2);
  });

  test('concurrent same-turn calls after a timeout still ask again (timeout is not a denial)', async () => {
    const policy = createAcpSessionApprovalPolicy();
    const denied = new Set<string>();
    let asks = 0;
    const approver: AcpTurnContext['requestApproval'] = async () => { asks++; return 'timeout'; };
    const [a, b] = await Promise.all([
      policy.resolve('s', request('Bash'), approver, denied),
      policy.resolve('s', request('Bash'), approver, denied),
    ]);
    expect(a).toEqual({ allowed: false, reason: 'timeout' });
    expect(b).toEqual({ allowed: false, reason: 'timeout' });
    expect(asks).toBe(2);
  });

  test('timeout and cancellation can be asked again within the same turn; denial text keeps other reasons unchanged', async () => {
    const policy = createAcpSessionApprovalPolicy();
    const denied = new Set<string>();
    let asks = 0;
    for (const decision of ['timeout', 'cancelled'] as const) {
      for (let i = 0; i < 2; i++) {
        expect(await policy.resolve('s', request('Bash'), async () => { asks++; return decision; }, denied))
          .toEqual({ allowed: false, reason: decision });
      }
    }
    expect(asks).toBe(4);
    expect(denied.size).toBe(0);
    expect(acpToolDenialResult('Bash', 'timeout').error)
      .toBe('Bash: 사람의 답이 없었다(시한 초과) — 실행하지 않았다. 사용자에게 한 줄로 알려라 (tool not run: approval timeout)');
    expect(acpToolDenialResult('Bash', 'cancelled').error)
      .toBe('Bash: 승인 요청이 취소됐다 — 실행하지 않았다 (tool not run: approval cancelled)');
    expect(acpToolDenialResult('Bash', 'error').error)
      .toBe('Bash: 승인을 받지 못했다 — 실행하지 않았다 (tool not run: approval error)');
  });

  test('without a session gate (in-process TUI) the dispatcher is passed through untouched', () => {
    const dispatchTool = async () => 'executed';
    const turn = { isAborted: () => false } as unknown as AcpTurnContext;
    expect(acpApprovalGatedDispatch(turn, dispatchTool, new AbortController().signal)).toBe(dispatchTool);
  });

  test('codex approval question is answered through the ACP turn approver', async () => {
    const titles: string[] = [];
    const req = {
      backendId: 'codex-app-server', sessionId: 's',
      questions: [{ id: 'codex_approval', header: 'Approve?', question: 'codex exec: rm x', options: [] }],
    };
    expect(await answerCodexApprovalQuestion(req, async (r) => { titles.push(r.title); return false; }))
      .toEqual({ answers: { codex_approval: 'Reject' } });
    expect(await answerCodexApprovalQuestion(req, async () => true))
      .toEqual({ answers: { codex_approval: 'Allow once' } });
    expect(await answerCodexApprovalQuestion({ ...req, questions: [{ ...req.questions[0]!, id: 'other' }] }, async () => true))
      .toBeNull();
    expect(titles).toEqual(['codex exec: rm x']);
  });

  test('Codex ACP turn attaches this turn’s permission approver', async () => {
    const abort = new AbortController();
    const bridge = createInProcessAcpBridge();
    const received: string[] = [];
    const server = runAcpServer({
      shutdownSignal: abort.signal,
      transportFactory: async (onConnection): Promise<AcpTransportServer> => {
        void onConnection({
          readable: bridge.a.readable, writable: bridge.a.writable, peerId: 'codex-approval',
          close: async () => { try { await bridge.a.writable.close(); } catch {} },
        });
        return { kind: 'in-process', address: 'test://codex-approval', close: async () => {} };
      },
      runCodexTurn: async (opts) => {
        expect(opts.permissionApprover).toBeDefined();
        // Counter-example 6: the adapter built with the turn approver asks the
        // ACP client instead of auto-approving.
        const adapter = createCodexApprovalAdapter({ permissionApprover: opts.permissionApprover! });
        const decision = await adapter.onExecPolicyAmendment({
          sessionId: String(opts.chatId), command: ['pwd'], cwd: '/tmp', kind: 'exec-policy',
        });
        expect(decision.approved).toBe(false);
        received.push('checked');
        return { text: '', stopReason: 'end_turn' };
      },
    });
    const client = new ClientSideConnection(() => ({
      async sessionUpdate() {},
      async requestPermission(req) {
        received.push(req.toolCall.title ?? '');
        return { outcome: { outcome: 'cancelled' as const } };
      },
    }), ndJsonStream(bridge.b.writable, bridge.b.readable));
    try {
      await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'try shell' }] });
      expect(received).toEqual(['codex exec', 'checked']);
    } finally {
      abort.abort();
      try { await bridge.b.writable.close(); } catch {}
      try { await bridge.a.writable.close(); } catch {}
      await server;
    }
  });

  test('ACP prompt owns the rejection set, not the session', async () => {
    const asked: string[] = [];
    const results: Array<{ allowed: boolean; reason?: string }> = [];
    let turn = 0;
    await withAcpClient({}, async (ctx) => {
      turn++;
      for (const tool of turn === 1 ? ['Bash', 'Bash', 'Write'] : ['Bash']) {
        results.push(await ctx.approveTool!(request(tool)));
      }
    }, async (req) => {
      asked.push(req.toolCall.title ?? '');
      return { outcome: { outcome: 'selected', optionId: req.options.find((o) => o.optionId.endsWith('reject-once'))!.optionId } };
    }, 2);
    expect(asked).toEqual(['Bash', 'Write', 'Bash']);
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ allowed: false, reason: 'rejected' })));
  });

  test('configured ACP approval timeout applies to an unresponsive client; absent/invalid values keep 60000', async () => {
    const configs = [
      [{ acp: { toolApproval: { timeoutMs: 1500 } } }, 1500],
      [{}, DEFAULT_APPROVAL_TIMEOUT_MS],
      [{ acp: { toolApproval: { timeoutMs: 1.5 } } }, DEFAULT_APPROVAL_TIMEOUT_MS],
      [{ acp: { toolApproval: { timeoutMs: 0 } } }, DEFAULT_APPROVAL_TIMEOUT_MS],
    ] as const;
    for (const [config, expected] of configs) {
      const root = mkdtempSync(join(tmpdir(), 'acp-config-'));
      try {
        const path = join(root, 'config.json');
        writeFileSync(path, JSON.stringify(config));
        expect(getUserConfig(path).acp.toolApproval.timeoutMs).toBe(expected);
      } finally {
        resetUserConfig();
        rmSync(root, { recursive: true, force: true });
      }
    }
    let calls = 0;
    const started = Date.now();
    await withAcpClient({ acp: { toolApproval: { timeoutMs: 1500 } } }, async (ctx) => {
      expect(await ctx.approveTool!(request('Bash'))).toEqual({ allowed: false, reason: 'timeout' });
    }, async () => { calls++; return new Promise(() => {}); });
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('live ACP turn gates tools and clears allow-always when the last peer disconnects', async () => {
    const abort = new AbortController();
    const bridges = [createInProcessAcpBridge(), createInProcessAcpBridge()];
    let nextPeer = 0;
    let permissionRequests = 0;
    const executed: string[] = [];
    const server = runAcpServer({
      hasSession: () => true,
      shutdownSignal: abort.signal,
      transportFactory: async (onConnection): Promise<AcpTransportServer> => {
        for (const bridge of bridges) {
          void onConnection({
            readable: bridge.a.readable, writable: bridge.a.writable,
            peerId: `approval-${nextPeer++}`,
            close: async () => { try { await bridge.a.writable.close(); } catch {} },
          });
        }
        return { kind: 'in-process', address: 'test://approval', close: async () => {} };
      },
      runTurn: async (turn) => {
        for (const name of ['Write', 'Write', 'Read', 'Bash']) {
          const gate = await turn.approveTool!(request(name));
          if (gate.allowed) executed.push(name);
        }
      },
    });
    const clients = bridges.map((bridge) => new ClientSideConnection(() => ({
      async sessionUpdate() {},
      async requestPermission(req) {
        permissionRequests++;
        const kind = req.toolCall.title === 'Write' ? 'allow-always' : 'reject-once';
        return { outcome: { outcome: 'selected' as const, optionId: req.options.find((opt) => opt.optionId.endsWith(kind))!.optionId } };
      },
    }), ndJsonStream(bridge.b.writable, bridge.b.readable)));
    try {
      for (const client of clients) await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await clients[0]!.newSession({ cwd: '/tmp', mcpServers: [] });
      await clients[0]!.prompt({ sessionId, prompt: [{ type: 'text', text: 'run' }] });
      expect(executed).toEqual(['Write', 'Write', 'Read']);
      expect(permissionRequests).toBe(2);
      await bridges[0]!.b.writable.close();
      await clients[1]!.loadSession({ sessionId, cwd: '/tmp', mcpServers: [] });
      await clients[1]!.prompt({ sessionId, prompt: [{ type: 'text', text: 'again' }] });
      expect(executed).toEqual(['Write', 'Write', 'Read', 'Write', 'Write', 'Read']);
      expect(permissionRequests).toBe(4);
    } finally {
      abort.abort();
      for (const bridge of bridges) {
        try { await bridge.b.writable.close(); } catch {}
        try { await bridge.a.writable.close(); } catch {}
      }
      await server;
    }
  });
});
