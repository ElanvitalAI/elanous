// Unit tests for ACP subagent spawning — H3 #7.
//
// Exercises the DualRoleManager parent-child graph + cascade close
// + AcpSessionSpawnSub one-shot dispatcher via injected fake agents
// so no real subprocess is spawned.

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import {
  DualRoleManager,
  DEFAULT_HOP_CAP,
  ReentrancyError,
  UnknownSessionError,
  globalDualRoleManager,
  type ClientSessionCreateOpts,
} from '../src/acp/dual-role-manager.js';
import {
  dispatchAcpSessionSpawnSub,
  dispatchAcpSessionSend,
  dispatchAcpSessionCreate,
  buildAcpSessionSpawnSubTool,
} from '../src/skills/tools/acp-session.js';
import { debug } from '../src/debug/log.js';

// Minimal AcpAgent shape the DualRoleManager touches during
// create/send/close. The real class has many more methods we don't
// need to stub for graph tests.
function makeFakeAgent(opts: {
  sessionId?: string;
  promptResult?: { stopReason: string };
  promptImpl?: (sessionId: string, blocks: unknown, onUpdate: (u: any) => void) => Promise<{ stopReason: string }>;
} = {}) {
  let nextId = opts.sessionId ?? `fake-${Math.random().toString(36).slice(2, 8)}`;
  return {
    newSession: mock(async () => {
      const id = nextId;
      nextId = `fake-${Math.random().toString(36).slice(2, 8)}`;
      return id;
    }),
    prompt: mock(opts.promptImpl ?? (async () => opts.promptResult ?? { stopReason: 'end_turn' })),
    cancel: mock(async () => {}),
  };
}

function freshManager(): DualRoleManager {
  const m = new DualRoleManager();
  const agent = makeFakeAgent();
  m.__setAgentFactoryForTest(async () => agent as any);
  return m;
}

describe('DualRoleManager · parent-child graph', () => {
  test('clientSessionCreate({ parentSessionId }) sets child parentSessionId', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    const child = await m.clientSessionCreate({
      backendId: 'claude',
      parentSessionId: root.id,
    });
    expect(child.parentSessionId).toBe(root.id);
  });

  test("child chainDepth = parent's chainDepth + 1", async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    expect(root.chainDepth).toBe(0);
    const child = await m.clientSessionCreate({
      backendId: 'claude',
      parentSessionId: root.id,
    });
    expect(child.chainDepth).toBe(1);
    const grandchild = await m.clientSessionCreate({
      backendId: 'claude',
      parentSessionId: child.id,
    });
    expect(grandchild.chainDepth).toBe(2);
  });

  test('root has chainDepth = 0 by default', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    expect(root.chainDepth).toBe(0);
    expect(root.parentSessionId).toBeUndefined();
  });

  test('HOP_CAP breach at creation time throws ReentrancyError', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    const d1 = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    const d2 = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: d1.id });
    expect(d2.chainDepth).toBe(2);
    // Next spawn would be depth=3 which equals DEFAULT_HOP_CAP=3 → reject.
    await expect(
      m.clientSessionCreate({ backendId: 'claude', parentSessionId: d2.id }),
    ).rejects.toBeInstanceOf(ReentrancyError);
    expect(DEFAULT_HOP_CAP).toBe(3);
  });

  test('custom hopCap override is honored', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    // hopCap=1 → depth≥1 rejected.
    await expect(
      m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id, hopCap: 1 }),
    ).rejects.toBeInstanceOf(ReentrancyError);
  });

  test('unknown parentSessionId throws UnknownSessionError', async () => {
    const m = freshManager();
    await expect(
      m.clientSessionCreate({ backendId: 'claude', parentSessionId: 'acp-cli:claude:ghost' }),
    ).rejects.toBeInstanceOf(UnknownSessionError);
  });

  test('childrenOf returns direct children only', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    const a = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    const b = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    const aa = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: a.id });
    const directChildren = m.childrenOf(root.id).map(r => r.id).sort();
    expect(directChildren).toEqual([a.id, b.id].sort());
    // Grandchild NOT in direct-children set.
    expect(directChildren).not.toContain(aa.id);
  });

  test('descendantsOf BFS collects transitive descendants', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    const a = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    const b = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    const aa = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: a.id });
    const descendants = m.descendantsOf(root.id).map(r => r.id).sort();
    expect(descendants).toEqual([a.id, b.id, aa.id].sort());
  });

  test('childrenOf unknown id returns []', async () => {
    const m = freshManager();
    expect(m.childrenOf('ghost')).toEqual([]);
  });

  test('descendantsOf on leaf returns []', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    expect(m.descendantsOf(root.id)).toEqual([]);
  });
});

describe('DualRoleManager · cascade close', () => {
  test('closing parent closes direct children', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    const child = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    const closed = await m.clientSessionClose(root.id);
    expect(closed).toBe(true);
    expect(m.clientSessionById(root.id)).toBeUndefined();
    expect(m.clientSessionById(child.id)).toBeUndefined();
  });

  test('closing parent closes transitive grandchildren', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    const child = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    const grand = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: child.id });
    await m.clientSessionClose(root.id);
    expect(m.clientSessionById(root.id)).toBeUndefined();
    expect(m.clientSessionById(child.id)).toBeUndefined();
    expect(m.clientSessionById(grand.id)).toBeUndefined();
  });

  test('closing sibling leaves other siblings alone', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    const a = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    const b = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    await m.clientSessionClose(a.id);
    expect(m.clientSessionById(a.id)).toBeUndefined();
    // Sibling + parent still live.
    expect(m.clientSessionById(b.id)).toBeDefined();
    expect(m.clientSessionById(root.id)).toBeDefined();
  });

  test('cascade:false escape hatch closes only the target', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    const child = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    await m.clientSessionClose(root.id, { cascade: false });
    expect(m.clientSessionById(root.id)).toBeUndefined();
    // Child becomes an orphan but survives.
    expect(m.clientSessionById(child.id)).toBeDefined();
  });

  test('closing orphan (parent already gone) works cleanly', async () => {
    const m = freshManager();
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    const child = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    // Close parent without cascade → child is now an orphan root.
    await m.clientSessionClose(root.id, { cascade: false });
    // Closing the orphan directly shouldn't throw.
    const closed = await m.clientSessionClose(child.id);
    expect(closed).toBe(true);
    expect(m.clientSessionById(child.id)).toBeUndefined();
  });

  test('cascade close tears down leaves BEFORE the parent', async () => {
    const m = freshManager();
    const order: string[] = [];
    const makeTrackingAgent = (label: string) => ({
      newSession: mock(async () => label),
      prompt: mock(async () => ({ stopReason: 'end_turn' })),
      cancel: mock(async () => { order.push(`cancel:${label}`); }),
    });
    // Swap factory to produce unique agents per-create so cancel is
    // observable per-session.
    let i = 0;
    m.__setAgentFactoryForTest(async () => makeTrackingAgent(`s${i++}`) as any);
    const root = await m.clientSessionCreate({ backendId: 'claude' });
    const child = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: root.id });
    const grand = await m.clientSessionCreate({ backendId: 'claude', parentSessionId: child.id });
    await m.clientSessionClose(root.id);
    // Three cancels, leaves first.
    expect(order).toEqual([`cancel:${grand.backendSessionId}`, `cancel:${child.backendSessionId}`, `cancel:${root.backendSessionId}`]);
  });
});

describe('dispatchAcpSessionCreate with parentSessionId', () => {
  beforeEach(() => {
    const m = globalDualRoleManager();
    m.__clearForTest();
    m.__setAgentFactoryForTest(async () => makeFakeAgent() as any);
  });
  afterEach(() => {
    const m = globalDualRoleManager();
    m.__setAgentFactoryForTest(null);
    m.__clearForTest();
  });

  test('spawns child with parent link', async () => {
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    expect(root.chainDepth).toBe(0);
    expect(root.parentSessionId).toBeUndefined();
    const child = await dispatchAcpSessionCreate({
      brand: 'claude',
      parentSessionId: root.sessionId,
    });
    expect(child.parentSessionId).toBe(root.sessionId);
    expect(child.chainDepth).toBe(1);
  });

  test('empty-string parentSessionId is treated as root', async () => {
    const root = await dispatchAcpSessionCreate({ brand: 'claude', parentSessionId: '' });
    expect(root.parentSessionId).toBeUndefined();
    expect(root.chainDepth).toBe(0);
  });
});

describe('ACP client prompt call ledger', () => {
  beforeEach(() => globalDualRoleManager().__clearForTest());
  afterEach(() => {
    globalDualRoleManager().__setAgentFactoryForTest(null);
    globalDualRoleManager().__clearForTest();
  });

  test('one ACP prompt row per Send/SpawnSub, with peer model and child linkage, no synthetic HTTP host', async () => {
    const m = globalDualRoleManager();
    m.__setAgentFactoryForTest(async () => ({
      ...makeFakeAgent(),
      getSessionModels: () => ({ currentModelId: 'claude-sonnet-4', availableModels: [] }),
    }) as any);
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    const child = await dispatchAcpSessionCreate({ brand: 'claude', parentSessionId: root.sessionId });
    const secret = 'private prompt sk-test-do-not-log';
    await dispatchAcpSessionSend({ sessionId: child.sessionId, message: secret });
    const oneShot = await dispatchAcpSessionSpawnSub({
      parentSessionId: root.sessionId, brand: 'claude', initialMessage: secret,
    });
    for (const sessionId of [child.sessionId, oneShot.sessionId]) {
      const rows = debug.events(500).filter(e => e.category === 'llm.delegate'
        && e.event === 'prompt' && (e.data as any)?.sessionId === sessionId);
      expect(rows).toHaveLength(1);
      expect(debug.events(500).filter(e => e.category === 'llm.call'
        && (e.data as any)?.sessionId === sessionId)).toHaveLength(0);
      expect(rows[0]?.data).toMatchObject({
        provider: 'claude', model: 'claude-sonnet-4', host: null,
        sessionId, parentSessionId: root.sessionId, role: 'child',
        requestedBy: 'acp.session/prompt', selectionSource: 'session', billing: 'subscription',
      });
      expect(JSON.stringify(rows[0])).not.toContain(secret);
    }
  });

  test('unknown peer model stays null and failed ACP prompt still counts once', async () => {
    const m = globalDualRoleManager();
    m.__setAgentFactoryForTest(async () => makeFakeAgent({
      promptImpl: async () => { throw new Error('ACP prompt failed'); },
    }) as any);
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    const child = await dispatchAcpSessionCreate({ brand: 'claude', parentSessionId: root.sessionId });
    await expect(dispatchAcpSessionSend({ sessionId: child.sessionId, message: 'private failure prompt' }))
      .rejects.toThrow('ACP prompt failed');
    const rows = debug.events(500).filter(e => e.category === 'llm.delegate'
      && e.event === 'prompt' && (e.data as any)?.sessionId === child.sessionId);
    expect(rows).toHaveLength(1);
    expect(debug.events(500).filter(e => e.category === 'llm.call'
      && (e.data as any)?.sessionId === child.sessionId)).toHaveLength(0);
    expect(rows[0]?.data).toMatchObject({ model: null, host: null, selectionSource: 'explicit' });
    expect(JSON.stringify(rows[0])).not.toContain('private failure prompt');
  });
  test('peer model probe failure is fail-soft: prompt still dispatches with unknown model', async () => {
    const m = globalDualRoleManager();
    const agent = { ...makeFakeAgent(), getSessionModels: () => { throw new Error('model probe unavailable'); } };
    m.__setAgentFactoryForTest(async () => agent as any);
    const child = await dispatchAcpSessionCreate({ brand: 'claude' });
    await dispatchAcpSessionSend({ sessionId: child.sessionId, message: 'PRIVATE_PROBE_PROMPT' });
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    const rows = debug.events(500).filter(e => e.category === 'llm.delegate'
      && e.event === 'prompt' && (e.data as any)?.sessionId === child.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ model: null, host: null });
    expect(JSON.stringify(rows[0])).not.toContain('PRIVATE_PROBE_PROMPT');
    expect(debug.events(500).filter(e => e.category === 'llm.call'
      && (e.data as any)?.sessionId === child.sessionId)).toHaveLength(0);
  });
});

describe('dispatchAcpSessionSpawnSub', () => {
  beforeEach(() => {
    const m = globalDualRoleManager();
    m.__clearForTest();
    m.__setAgentFactoryForTest(async () => makeFakeAgent({
      promptImpl: async (_sid, _blocks, onUpdate) => {
        onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'sub-agent result ' },
        });
        onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        });
        return { stopReason: 'end_turn' };
      },
    }) as any);
  });
  afterEach(() => {
    const m = globalDualRoleManager();
    m.__setAgentFactoryForTest(null);
    m.__clearForTest();
  });

  test('happy path returns aggregated child output + chainDepth', async () => {
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    const result = await dispatchAcpSessionSpawnSub({
      parentSessionId: root.sessionId,
      brand: 'claude',
      initialMessage: 'summarize these notes',
    });
    expect(result.output).toBe('sub-agent result done');
    expect(result.stopReason).toBe('end_turn');
    expect(result.parentSessionId).toBe(root.sessionId);
    expect(result.chainDepth).toBe(1);
    expect(result.truncated).toBe(false);
  });

  test('child is torn down automatically after turn resolves', async () => {
    const m = globalDualRoleManager();
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    const result = await dispatchAcpSessionSpawnSub({
      parentSessionId: root.sessionId,
      brand: 'claude',
      initialMessage: 'hi',
    });
    expect(m.clientSessionById(result.sessionId)).toBeUndefined();
    // Parent still live.
    expect(m.clientSessionById(root.sessionId)).toBeDefined();
  });

  test('unknown parentSessionId → UnknownSessionError propagates', async () => {
    await expect(
      dispatchAcpSessionSpawnSub({
        parentSessionId: 'acp-cli:claude:ghost',
        brand: 'claude',
        initialMessage: 'hi',
      }),
    ).rejects.toBeInstanceOf(UnknownSessionError);
  });

  test('unknown brand → throws validation error', async () => {
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    await expect(
      dispatchAcpSessionSpawnSub({
        parentSessionId: root.sessionId,
        brand: 'llama' as any,
        initialMessage: 'hi',
      }),
    ).rejects.toThrow(/unknown brand/i);
  });

  test('empty initialMessage rejected', async () => {
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    await expect(
      dispatchAcpSessionSpawnSub({
        parentSessionId: root.sessionId,
        brand: 'claude',
        initialMessage: '',
      }),
    ).rejects.toThrow(/initialMessage/);
  });

  test('empty parentSessionId rejected', async () => {
    await expect(
      dispatchAcpSessionSpawnSub({
        parentSessionId: '',
        brand: 'claude',
        initialMessage: 'hi',
      }),
    ).rejects.toThrow(/parentSessionId/);
  });

  test('HOP_CAP breach at spawn → ReentrancyError', async () => {
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    const d1 = await dispatchAcpSessionCreate({ brand: 'claude', parentSessionId: root.sessionId });
    const d2 = await dispatchAcpSessionCreate({ brand: 'claude', parentSessionId: d1.sessionId });
    // Depth would be 3 → reject.
    await expect(
      dispatchAcpSessionSpawnSub({
        parentSessionId: d2.sessionId,
        brand: 'claude',
        initialMessage: 'hi',
      }),
    ).rejects.toBeInstanceOf(ReentrancyError);
  });

  test('maxOutputChars truncates the output', async () => {
    const root = await dispatchAcpSessionCreate({ brand: 'claude' });
    const result = await dispatchAcpSessionSpawnSub({
      parentSessionId: root.sessionId,
      brand: 'claude',
      initialMessage: 'hi',
      maxOutputChars: 10,
    });
    expect(result.output.length).toBe(10);
    expect(result.truncated).toBe(true);
  });

  test('buildAcpSessionSpawnSubTool returns valid LLMToolSpec', () => {
    const spec = buildAcpSessionSpawnSubTool();
    expect(spec.name).toBe('AcpSessionSpawnSub');
    expect(spec.parameters.required).toEqual(['parentSessionId', 'brand', 'initialMessage']);
  });
});
