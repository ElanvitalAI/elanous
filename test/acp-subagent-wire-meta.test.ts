// Follow-up #4 — Subagent wire meta 실 송신 tests.
//
// Verifies the plumbing from `AcpSessionSpawnSub` →
// `DualRoleManager.clientSessionSend({meta})` →
// `AcpAgent.prompt(..., meta?)` end to end. A fake AcpAgent captures
// the `meta` argument so we can assert the canonical
// SUBAGENT_SESSION_INFO_META_KEY rides the wire.

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import {
  DualRoleManager,
  globalDualRoleManager,
} from '../src/acp/dual-role-manager.js';
import {
  dispatchAcpSessionCreate,
  dispatchAcpSessionSpawnSub,
} from '../src/skills/tools/acp-session.js';
import {
  readSubagentMeta,
  SUBAGENT_SESSION_INFO_META_KEY,
} from '../src/acp/subagent-meta.js';

function makeFakeAgent(opts: {
  sessionId?: string;
  captureMeta?: Array<Record<string, unknown> | undefined>;
} = {}) {
  let nextId = opts.sessionId ?? `fake-${Math.random().toString(36).slice(2, 8)}`;
  return {
    newSession: mock(async () => {
      const id = nextId;
      nextId = `fake-${Math.random().toString(36).slice(2, 8)}`;
      return id;
    }),
    prompt: mock(async (
      _sid: string,
      _blocks: unknown,
      onUpdate: (u: any) => void,
      meta?: Record<string, unknown>,
    ) => {
      opts.captureMeta?.push(meta);
      onUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ok' },
      });
      return { stopReason: 'end_turn' };
    }),
    cancel: mock(async () => {}),
  };
}

describe('DualRoleManager · clientSessionSend({meta}) pass-through', () => {
  test('meta forwarded to agent.prompt', async () => {
    const captured: Array<Record<string, unknown> | undefined> = [];
    const mgr = new DualRoleManager();
    mgr.__setAgentFactoryForTest(async () => makeFakeAgent({
      sessionId: 'sA',
      captureMeta: captured,
    }) as any);
    const rec = await mgr.clientSessionCreate({ backendId: 'claude' });
    await mgr.clientSessionSend({
      sessionId: rec.id,
      message: 'hi',
      meta: { custom: { foo: 'bar' } },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ custom: { foo: 'bar' } });
  });

  test('no meta → agent.prompt called with meta=undefined', async () => {
    const captured: Array<Record<string, unknown> | undefined> = [];
    const mgr = new DualRoleManager();
    mgr.__setAgentFactoryForTest(async () => makeFakeAgent({
      sessionId: 'sB',
      captureMeta: captured,
    }) as any);
    const rec = await mgr.clientSessionCreate({ backendId: 'claude' });
    await mgr.clientSessionSend({ sessionId: rec.id, message: 'hi' });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBeUndefined();
  });
});

describe('AcpSessionSpawnSub · wire meta', () => {
  let captured: Array<Record<string, unknown> | undefined>;
  beforeEach(() => {
    captured = [];
    const m = globalDualRoleManager();
    m.__clearForTest();
    let idx = 0;
    m.__setAgentFactoryForTest(async () => makeFakeAgent({
      sessionId: `spawn-${idx++}`,
      captureMeta: captured,
    }) as any);
  });
  afterEach(() => {
    const m = globalDualRoleManager();
    m.__setAgentFactoryForTest(null);
    m.__clearForTest();
  });

  test('spawns child with canonical subagent meta key on the wire', async () => {
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    const result = await dispatchAcpSessionSpawnSub({
      parentSessionId: root.sessionId,
      brand: 'claude',
      initialMessage: 'hi',
    });
    // Root had no send; only the child's send carried meta.
    expect(captured).toHaveLength(1);
    const meta = captured[0];
    expect(meta).toBeDefined();
    expect(Object.keys(meta!)).toContain(SUBAGENT_SESSION_INFO_META_KEY);
    const parsed = readSubagentMeta(meta!);
    expect(parsed).not.toBeNull();
    expect(parsed!.parentSessionId).toBe(root.sessionId);
    expect(parsed!.sessionId).toBe(result.sessionId);
  });

  test('round-trip preserves parent link after wire ride', async () => {
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    const result = await dispatchAcpSessionSpawnSub({
      parentSessionId: root.sessionId,
      brand: 'claude',
      initialMessage: 'hello',
    });
    const parsed = readSubagentMeta(captured[0]!);
    // Round-trip invariant: writeSubagentMeta → pass through wire → readSubagentMeta
    // yields the same parent / session ids the dispatcher intended.
    expect(parsed).toEqual({
      parentSessionId: root.sessionId,
      sessionId: result.sessionId,
    });
  });

  test('non-spawn-sub sends do not carry subagent meta', async () => {
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    await globalDualRoleManager().clientSessionSend({
      sessionId: root.sessionId,
      message: 'top-level send',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBeUndefined();
  });
});

describe('AcpAgent.prompt · _meta forwarding', () => {
  test('undefined meta → request omits _meta field', async () => {
    // Mock the internal connection to capture the PromptRequest shape.
    const captured: Array<Record<string, unknown>> = [];
    const fake = {
      spec: { id: 'claude' },
      connection: {
        prompt: async (req: Record<string, unknown>) => {
          captured.push(req);
          return { stopReason: 'end_turn' };
        },
      },
      pendingBySession: new Map(),
    };
    // Call the prompt method directly via Function.prototype.call on the
    // class prototype — this gives us a unit test of the method
    // without starting a subprocess.
    const { AcpAgent } = await import('../src/acp/client.js');
    await AcpAgent.prototype.prompt.call(
      fake as any,
      'sess-1' as any,
      [{ type: 'text', text: 'hi' }] as any,
      () => {},
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!).not.toHaveProperty('_meta');
    expect(captured[0]!.prompt).toEqual([{ type: 'text', text: 'hi' }]);

    const grokFake = {
      spec: { id: 'grok' },
      connection: {
        prompt: async () => {
          throw new Error('Authentication required. Run `grok login` to re-authenticate.');
        },
      },
      pendingBySession: new Map(),
    };
    // The actionable hint intentionally follows host capability: graphical
    // hosts receive OAuth, while headless Linux/WSL receives device auth.
    // Keep this fake-connection check independent of process-global env state.
    const supportedGrokLoginHint = /grok login --(?:oauth|device-auth)`/;
    await expect(AcpAgent.prototype.prompt.call(
      grokFake as any,
      'sess-grok' as any,
      [{ type: 'text', text: 'hi' }] as any,
      () => {},
    )).rejects.toThrow(supportedGrokLoginHint);
    expect('grok login --oauth=invalid').not.toMatch(supportedGrokLoginHint);
    expect('grok login --oauth --other').not.toMatch(supportedGrokLoginHint);
  });

  test('meta supplied → request carries _meta blob verbatim', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fake = {
      spec: { id: 'claude' },
      connection: {
        prompt: async (req: Record<string, unknown>) => {
          captured.push(req);
          return { stopReason: 'end_turn' };
        },
      },
      pendingBySession: new Map(),
    };
    const { AcpAgent } = await import('../src/acp/client.js');
    const metaBlob = { [SUBAGENT_SESSION_INFO_META_KEY]: { parentSessionId: 'p', sessionId: 'c' } };
    await AcpAgent.prototype.prompt.call(
      fake as any,
      'sess-2' as any,
      [{ type: 'text', text: 'hi' }] as any,
      () => {},
      metaBlob,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!._meta).toEqual(metaBlob);
  });
});
