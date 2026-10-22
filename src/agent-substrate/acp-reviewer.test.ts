import { describe, it, expect, spyOn } from 'bun:test';
import { DEFAULT_REVIEW_BACKEND, defaultAcpReviewTimeoutSec, isReadOnlyReviewTool, makeAcpReviewLLM, makeLazyAcpReviewLLM } from './acp-reviewer.js';
import { debug } from '../debug/log.js';
import { AcpAgent, type AcpAgentOpts } from '../acp/client.js';
import { AcpAgentManager } from '../acp/agent-manager.js';
import { CODEX_APP_SERVER_CAPS } from '../acp/codex-app-server-agent.js';
import type { ReviewImage } from './pr-reviewer.js';
import type { ElanousCapabilities } from '../acp/capabilities.js';
import { resolveTeamclaudeReviewRoute, subscriptionReviewerSpawn } from '../self-dev/review-provider-fallback.js';
import { withFakeBins } from '../ux-sim/fake-bin.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAcpBackend } from '../acp/backend-registry.js';

// ⛔⭐⭐ 기본 백엔드 회귀 가드 (2026-08-01 · JDG-S9).
//   이 계약은 **아무 테스트도 안 걸고 있었다** — 기본값을 바꿔도 게이트가 초록이었다.
//   ⇒ *"게이트가 초록이다" 가 "그 계약이 지켜진다" 가 아니다*(이 창 22차의 반복 교훈).
//   claude-code-acp@0.16.2 가 -32602 로 툴콜 알림을 잃으므로 codex 가 기본이어야 한다.
//   ⚠️ 이 단언을 바꾸려면 INCIDENT-2026-08-01-… 의 근본이 수리됐는지 먼저 확인한다.
describe('DEFAULT_REVIEW_BACKEND', () => {
  it('기본 리뷰 백엔드는 codex 다 (claude-code-acp -32602 회피 · JDG-S9)', () => {
    expect(DEFAULT_REVIEW_BACKEND).toBe('codex');
  });
});

// ★ 리뷰어 퍼미션 화이트리스트(#5171 셀프리뷰 지적 반영) — read-only 만 허가, 변경/실행 차단.
describe('isReadOnlyReviewTool', () => {
  it('read-only kind 는 허가', () => {
    for (const k of ['read', 'search', 'fetch', 'think', 'switch_mode']) {
      expect(isReadOnlyReviewTool(k, 'anything')).toBe(true);
    }
  });

  it('변경/실행 kind 는 title 이 read-ish 여도 거부(kind 우선)', () => {
    for (const k of ['edit', 'delete', 'move', 'execute']) {
      expect(isReadOnlyReviewTool(k, 'Read the file')).toBe(false);
    }
  });

  it('Write/Bash(변경 kind) 거부', () => {
    expect(isReadOnlyReviewTool('edit', 'Write File')).toBe(false);
    expect(isReadOnlyReviewTool('execute', 'Bash: rm -rf')).toBe(false);
  });

  it('kind 미상이면 title 휴리스틱으로 read 계열만 허가', () => {
    expect(isReadOnlyReviewTool(undefined, 'Read File')).toBe(true);
    expect(isReadOnlyReviewTool(undefined, 'Grep')).toBe(true);
    expect(isReadOnlyReviewTool(undefined, 'Glob pattern')).toBe(true);
    expect(isReadOnlyReviewTool('other', 'List directory')).toBe(true);
  });

  it('kind 미상 + 비-read title 은 보수적 거부', () => {
    expect(isReadOnlyReviewTool(undefined, 'Write File')).toBe(false);
    expect(isReadOnlyReviewTool(undefined, 'Run command')).toBe(false);
    expect(isReadOnlyReviewTool('other', 'Execute script')).toBe(false);
    expect(isReadOnlyReviewTool(undefined, '')).toBe(false);
  });
});

// ⛔⭐⭐⭐ ACP 기본 백엔드 결속 — **세 경로가 한 값을 공유해야 한다** (2026-08-01 · JDG-S9).
//   교차 리뷰에서 `acp-reviewer` → `acp-judge` → `autopilot-run` **셋이 갈려** 있었고,
//   ***-32602 를 실제로 낸 것은 내가 처음 안 고친 심판 경로였다.***
//   ⇒ 한 곳만 고치고 "그 기능을 고쳤다" 로 읽지 않는다. 이 검사가 전수를 고정한다.
describe('ACP 기본 백엔드 결속 (전수)', () => {
  const paths = [
    ['../agent-mission/acp-judge.ts', 'input.backend ?? DEFAULT_REVIEW_BACKEND'],
    ['../cli/autopilot-run.ts', 'opts.backend ?? DEFAULT_REVIEW_BACKEND'],
  ] as const;
  for (const [rel, expected] of paths) {
    it(`${rel} 이 상수를 공유한다`, async () => {
      const src = await Bun.file(new URL(rel, import.meta.url)).text();
      expect(src).toContain(expected);
      expect(src).not.toMatch(/backend \?\? 'claude'/);
    });
  }
});

const unsupportedCapabilities = {
  protocolVersion: 1,
  prompt: { image: false, audio: false },
  loadSession: false,
} as ElanousCapabilities;

function reviewAgent(opts: AcpAgentOpts, capabilities?: ElanousCapabilities): AcpAgent {
  return {
    start: async () => { if (capabilities) opts.onCapabilities?.(capabilities); },
    newSession: async () => 'session-1',
    selectSessionModel: async () => null,
    prompt: async () => ({ stopReason: 'end_turn' }),
    stop: async () => {},
    cancel: async () => {},
  } as unknown as AcpAgent;
}

describe('ACP reviewer backend factory', () => {
  it('uses a review-owned ACP child with the configured executor and scrubbed environment', async () => {
    const spawn = subscriptionReviewerSpawn({ provider: 'claude-acp' }, {
      PATH: '/bin', ANTHROPIC_API_KEY: 'key', ANTHROPIC_AUTH_TOKEN: 'token', NODE_ENV: 'test',
    }, 'http://localhost:3456');
    let child: { spec: { command: string; args: string[] }; env: NodeJS.ProcessEnv } | undefined;
    const start = spyOn(AcpAgent.prototype, 'start').mockImplementation(async function (this: AcpAgent) {
      child = this as unknown as typeof child;
    });
    const newSession = spyOn(AcpAgent.prototype, 'newSession').mockResolvedValue('session-1');
    const prompt = spyOn(AcpAgent.prototype, 'prompt').mockResolvedValue({ stopReason: 'end_turn' });
    const stop = spyOn(AcpAgent.prototype, 'stop').mockResolvedValue();
    const manager = spyOn(AcpAgentManager.prototype, 'getAgent');
    try {
      await makeAcpReviewLLM({ cwd: process.cwd(), backend: 'claude', backendSpec: spawn.backendSpec, env: spawn.env })('review');
      expect(start).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(manager).not.toHaveBeenCalled();
      // The ACP adapter, never the interactive `teamclaude run`/`claude` CLI (that never answers the handshake).
      expect(child?.spec.command).toBe('claude-agent-acp');
      expect(child?.spec.args).toEqual([]);
      expect(child?.env.ANTHROPIC_BASE_URL).toBe('http://localhost:3456');
      expect(child?.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(child?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      start.mockRestore(); newSession.mockRestore(); prompt.mockRestore(); stop.mockRestore(); manager.mockRestore();
    }
  });
  it('bounds the whole handshake (start → session → model select) with one deadline and stops the child', async () => {
    for (const [hang, phase] of [['start', 'initialize'], ['newSession', 'session-new'], ['selectSessionModel', 'model-select']] as const) {
      const agent = reviewAgent({ backendId: 'review-backend' });
      (agent as unknown as Record<string, unknown>)[hang] = () => new Promise(() => {});
      const stop = spyOn(agent, 'stop');
      const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
      const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
        if (category === 'acp-review') events.push({ event, data });
      }) as never);
      try {
        const t0 = Date.now();
        await expect(makeAcpReviewLLM({ cwd: process.cwd(), backend: 'review-backend', model: 'opus',
          handshakeTimeoutMs: 100, createAgent: () => agent })('review')).rejects.toThrow('ACP handshake timeout');
        expect(Date.now() - t0).toBeLessThan(5_000);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(events.find(e => e.event === 'error')?.data).toMatchObject({ phase, provider: 'review-backend', toolCalls: 0,
          elapsedMs: expect.any(Number), phaseElapsedMs: expect.any(Number), classification: 'acp-timeout' });
      } finally { log.mockRestore(); }
    }
  });
  it('stops a production Grok child whose start never completes', async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'acp-review') events.push({ event, data });
    }) as never);
    const start = spyOn(AcpAgent.prototype, 'start').mockImplementation(async () => new Promise(() => {}));
    const stop = spyOn(AcpAgent.prototype, 'stop').mockResolvedValue();
    try {
      await expect(makeAcpReviewLLM({ cwd: process.cwd(), backend: 'grok', handshakeTimeoutMs: 30 })('review'))
        .rejects.toThrow('ACP_REVIEW_TIMEOUT:grok: ACP handshake timeout');
      expect(stop).toHaveBeenCalledTimes(1);
      expect(events.find(e => e.event === 'error')?.data).toMatchObject({
        phase: 'spawn-initialize', provider: 'grok', toolCalls: 0, classification: 'acp-timeout',
        elapsedMs: expect.any(Number), phaseElapsedMs: expect.any(Number),
      });
    } finally { start.mockRestore(); stop.mockRestore(); log.mockRestore(); }
  });

  it('reaps a real Grok ACP subprocess after its initialize handshake stalls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-acp-review-timeout-'));
    const pidFile = join(dir, 'child.pid');
    const childFile = join(dir, 'stalled-agent.ts');
    writeFileSync(childFile, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
    let pid: number | undefined;
    try {
      await expect(makeAcpReviewLLM({
        cwd: dir,
        backend: 'grok',
        backendSpec: { ...getAcpBackend('grok'), id: 'grok-test-fixture', command: process.execPath, args: [childFile], extraBinCandidates: [] },
        env: { PATH: process.env.PATH ?? '/usr/bin' },
        handshakeTimeoutMs: 1_000,
      })('review')).rejects.toThrow('ACP_REVIEW_TIMEOUT:grok: ACP handshake timeout');
      expect(existsSync(pidFile)).toBe(true);
      pid = Number(readFileSync(pidFile, 'utf8'));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      let alive = true;
      for (let attempt = 0; attempt < 50; attempt++) {
        try { process.kill(pid, 0); } catch { alive = false; break; }
        await Bun.sleep(20);
      }
      expect(alive).toBe(false);
    } finally {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 5_000);

  it('canonicalizes a friendly backend alias, records its transport, and uses a review-owned manager', async () => {
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const agent = reviewAgent({ backendId: 'codex-app-server' });
    const getAgent = spyOn(AcpAgentManager.prototype, 'getAgent').mockResolvedValue(agent);
    const stopAll = spyOn(AcpAgentManager.prototype, 'stopAll').mockResolvedValue();
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as never);
    try {
      await makeAcpReviewLLM({ cwd: process.cwd(), backend: 'codex' })('review prompt');
      expect(getAgent).toHaveBeenCalledWith('codex', expect.objectContaining({ cwd: process.cwd() }));
      expect(stopAll).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual({
        category: 'acp-review',
        event: 'start',
        data: expect.objectContaining({
          requestedBackend: 'codex',
          backend: 'codex-app-server',
          transport: 'codex-app-server',
        }),
      });
    } finally {
      getAgent.mockRestore();
      stopAll.mockRestore();
      log.mockRestore();
    }
  });

  it('keeps the injected agent seam arbitrary and responsible for start and stop', async () => {
    let createdBackend: string | undefined;
    const agent = reviewAgent({ backendId: 'review-backend' });
    const start = spyOn(agent, 'start');
    const stop = spyOn(agent, 'stop');
    await makeAcpReviewLLM({
      cwd: process.cwd(),
      backend: 'review-backend',
      createAgent: (opts) => {
        createdBackend = opts.backendId;
        return agent;
      },
    })('review prompt');
    expect(createdBackend).toBe('review-backend');
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('disposes each review-owned manager after repeated reviews without accumulating process hooks', async () => {
    const baseline = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    const start = spyOn(AcpAgent.prototype, 'start').mockResolvedValue();
    const newSession = spyOn(AcpAgent.prototype, 'newSession').mockResolvedValue('session-1');
    const prompt = spyOn(AcpAgent.prototype, 'prompt').mockResolvedValue({ stopReason: 'end_turn' });
    const stop = spyOn(AcpAgent.prototype, 'stop').mockResolvedValue();
    try {
      const review = makeAcpReviewLLM({ cwd: process.cwd(), backend: 'claude', resolveClaudeRoute: () => ({ reason: 'teamclaude-unavailable' }) });
      await review('first review');
      await review('second review');
      expect(stop).toHaveBeenCalledTimes(2);
      expect(process.listenerCount('exit')).toBe(baseline.exit);
      expect(process.listenerCount('SIGINT')).toBe(baseline.sigint);
      expect(process.listenerCount('SIGTERM')).toBe(baseline.sigterm);
    } finally {
      start.mockRestore();
      newSession.mockRestore();
      prompt.mockRestore();
      stop.mockRestore();
    }
  });

  it('releases manager process hooks when factory agent startup rejects', async () => {
    const baseline = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    const start = spyOn(AcpAgent.prototype, 'start').mockRejectedValue(new Error('start rejected'));
    const stop = spyOn(AcpAgent.prototype, 'stop').mockResolvedValue();
    try {
      await expect(makeAcpReviewLLM({ cwd: process.cwd(), backend: 'claude', resolveClaudeRoute: () => ({ reason: 'teamclaude-unavailable' }) })('review prompt'))
        .rejects.toThrow('start rejected');
      expect(process.listenerCount('exit')).toBe(baseline.exit);
      expect(process.listenerCount('SIGINT')).toBe(baseline.sigint);
      expect(process.listenerCount('SIGTERM')).toBe(baseline.sigterm);
    } finally {
      start.mockRestore();
      stop.mockRestore();
    }
  });
});

describe('ACP review timeout diagnosis', () => {
  it('classifies a Grok prompt that never settles before the first tool call and stops the child', async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'acp-review') events.push({ event, data });
    }) as never);
    const agent = reviewAgent({ backendId: 'grok' });
    const cancel = spyOn(agent, 'cancel').mockResolvedValue();
    const stop = spyOn(agent, 'stop');
    const prompt = spyOn(agent, 'prompt').mockImplementation(async () => new Promise(() => {}));
    try {
      const started = Date.now();
      await expect(makeAcpReviewLLM({ cwd: '.', backend: 'grok', timeoutMs: 40, createAgent: () => agent })('review'))
        .rejects.toThrow('ACP_REVIEW_TIMEOUT:grok:');
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(events.find(e => e.event === 'error')?.data).toMatchObject({
        backend: 'grok', provider: 'grok', phase: 'prompt', toolCalls: 0, allowed: 0,
        classification: 'pre-tool-timeout', elapsedMs: expect.any(Number), phaseElapsedMs: expect.any(Number),
      });
    } finally {
      prompt.mockRestore(); cancel.mockRestore(); stop.mockRestore(); log.mockRestore();
    }
  });

  it('rejects the timed-out review even when cancel resolves a partial prompt immediately', async () => {
    const agent = reviewAgent({ backendId: 'grok' });
    let finishPrompt: (() => void) | undefined;
    let chunkSent = false;
    agent.prompt = (async (_sid, _blocks, onUpdate) => {
      const update = onUpdate as Parameters<AcpAgent['prompt']>[2];
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial review' } } as Parameters<typeof update>[0]);
      chunkSent = true;
      return new Promise<{ stopReason: 'end_turn' }>((resolve) => {
        finishPrompt = () => resolve({ stopReason: 'end_turn' });
      });
    }) as AcpAgent['prompt'];
    agent.cancel = async () => { finishPrompt?.(); };
    await expect(makeAcpReviewLLM({ cwd: '.', backend: 'grok', timeoutMs: 30, createAgent: () => agent })('review'))
      .rejects.toThrow('ACP_REVIEW_TIMEOUT:grok:');
    expect(chunkSent).toBe(true);
  });

  it('keeps the non-Grok timeout reason and never labels it as Grok recovery', async () => {
    const agent = reviewAgent({ backendId: 'claude' });
    agent.prompt = (async () => new Promise(() => {})) as AcpAgent['prompt'];
    await expect(makeAcpReviewLLM({ cwd: '.', backend: 'claude', timeoutMs: 30, createAgent: () => agent })('review'))
      .rejects.toThrow('ACP 리뷰 타임아웃(30ms·툴콜 0)');
  });

  it('counts ACP tool updates once per tool ID even without a permission request', async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'acp-review') events.push({ event, data });
    }) as never);
    try {
      await expect(makeAcpReviewLLM({ cwd: '.', backend: 'grok', timeoutMs: 40, createAgent: (opts) => {
        const agent = reviewAgent(opts);
        agent.prompt = (async (_sid, _blocks, onUpdate) => {
          const update = onUpdate as Parameters<AcpAgent['prompt']>[2];
          update({ sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read file', kind: 'read', status: 'in_progress' } as Parameters<typeof update>[0]);
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed' } as Parameters<typeof update>[0]);
          return new Promise(() => {});
        }) as AcpAgent['prompt'];
        return agent;
      } })('review')).rejects.toThrow('ACP_REVIEW_TIMEOUT:grok: 40ms·툴콜 1');
      expect(events.find(e => e.event === 'error')?.data).toMatchObject({ phase: 'prompt', toolCalls: 1, allowed: 0, classification: 'acp-timeout' });
    } finally { log.mockRestore(); }
  });

  it('does not mistake a permission request for an ACP tool call', async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'acp-review') events.push({ event, data });
    }) as never);
    try {
      await expect(makeAcpReviewLLM({ cwd: '.', backend: 'grok', timeoutMs: 30, createAgent: (opts) => {
        const agent = reviewAgent(opts);
        agent.prompt = (async () => {
          await opts.permissionApprover?.({ title: 'Read file', kind: 'read' } as Parameters<NonNullable<AcpAgentOpts['permissionApprover']>>[0]);
          return new Promise(() => {});
        }) as AcpAgent['prompt'];
        return agent;
      } })('review')).rejects.toThrow('ACP_REVIEW_TIMEOUT:grok: 30ms·툴콜 0');
      expect(events.find(e => e.event === 'error')?.data).toMatchObject({ toolCalls: 0, allowed: 1, classification: 'pre-tool-timeout' });
    } finally { log.mockRestore(); }
  });
});

describe('ACP review capability observation', () => {
  it('records negotiated backend capabilities as separate queryable fields', async () => {
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as never);
    try {
      await makeAcpReviewLLM({
        cwd: process.cwd(),
        backend: 'claude',
        createAgent: (opts) => reviewAgent(opts, unsupportedCapabilities),
      })('review prompt');
    } finally {
      log.mockRestore();
    }
    expect(events).toContainEqual({
      category: 'acp-review',
      event: 'capabilities',
      data: {
        backend: 'claude',
        protocolVersion: 1,
        image: false,
        audio: false,
        loadSession: false,
      },
    });
  });

  it('records unavailable negotiation separately from advertised unsupported capabilities', async () => {
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as never);
    try {
      await makeAcpReviewLLM({
        cwd: process.cwd(),
        createAgent: (opts) => reviewAgent(opts, CODEX_APP_SERVER_CAPS),
      })('review prompt');
    } finally {
      log.mockRestore();
    }
    expect(events).toContainEqual({
      category: 'acp-review',
      event: 'capabilities',
      data: {
        backend: 'codex-app-server',
        protocolVersion: 1,
        image: true,
        audio: false,
        loadSession: true,
      },
    });
  });

  it('continues the review when capability observation fails', async () => {
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      if (category === 'acp-review' && event === 'capabilities') throw new Error('sink unavailable');
    }) as never);
    try {
      await expect(makeAcpReviewLLM({
        cwd: process.cwd(),
        createAgent: (opts) => reviewAgent(opts, unsupportedCapabilities),
      })('review prompt')).resolves.toBe('');
    } finally {
      log.mockRestore();
    }
  });
});

// ─── P4b — ACP 전송층이 image ContentBlock 을 «실제로» 싣는다 (2026-08-07) ────
//
// ⛔ `#7486` 리뷰 must-fix: "ACP prompt 의 image ContentBlock 전송을 전혀 단정하지 않는다".
//   옳다 — 이 축은 「보냈나」가 전부이므로 그것을 안 물면 아무것도 안 문 것이다.
describe('ACP reviewer — 이미지 ContentBlock 전송(P4b)', () => {
  function capturingAgent(caps: ElanousCapabilities | undefined, sink: { blocks?: unknown[] }): AcpAgent {
    return {
      start: async () => { if (caps) { /* codex 계열은 광고를 getCapabilities 로만 낸다 */ } },
      getCapabilities: () => caps ?? null,
      newSession: async () => 'session-1',
      selectSessionModel: async () => null,
      prompt: async (_sid: string, blocks: unknown[]) => { sink.blocks = blocks; return { stopReason: 'end_turn' }; },
      stop: async () => {},
      cancel: async () => {},
    } as unknown as AcpAgent;
  }

  it('백엔드가 image 를 광고하면 별도 image 블록으로 싣는다', async () => {
    const sink: { blocks?: unknown[] } = {};
    await makeAcpReviewLLM({
      cwd: process.cwd(), backend: 'codex-app-server', timeoutMs: 5_000,
      createAgent: () => capturingAgent(CODEX_APP_SERVER_CAPS, sink),
    })('review prompt', [{ label: 'shot.png', mimeType: 'image/png', data: 'QUJD' }]);
    expect(sink.blocks).toHaveLength(2);
    expect((sink.blocks as Array<{ type: string }>)[0]!.type).toBe('text');
    expect((sink.blocks as Array<Record<string, unknown>>)[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'QUJD' });
  });

  it('⛔ 광고가 없으면 «안 보낸다» — 보내 봐야 거절이 훨씬 읽기 어려운 자리에서 난다', async () => {
    const sink: { blocks?: unknown[] } = {};
    await makeAcpReviewLLM({
      cwd: process.cwd(), backend: 'codex-app-server', timeoutMs: 5_000,
      createAgent: () => capturingAgent(undefined, sink),
    })('review prompt', [{ label: 'shot.png', mimeType: 'image/png', data: 'QUJD' }]);
    expect(sink.blocks).toHaveLength(1);
    expect((sink.blocks as Array<{ type: string }>)[0]!.type).toBe('text');
  });
});

// ─── P4b — 지연 로드 래퍼가 images 를 «떨어뜨리지 않는다» (#7486 범인) ────────
describe('makeLazyAcpReviewLLM — 인자 보존', () => {
  it('두 번째 인자(images)를 그대로 안쪽으로 넘긴다', async () => {
    let seen: unknown = 'unset';
    let loads = 0;
    const llm = makeLazyAcpReviewLLM({ cwd: '.', backend: 'codex-app-server' }, async () => {
      loads += 1;
      return () => async (_p: string, images?: readonly ReviewImage[]) => { seen = images; return 'ok'; };
    });
    await llm('p', [{ label: 'a.png', mimeType: 'image/png', data: 'QUJD' }]);
    expect(seen).toEqual([{ label: 'a.png', mimeType: 'image/png', data: 'QUJD' }]);
    // ⭐ 지연 로드는 «한 번»만 — 매 호출마다 import 하면 리뷰가 느려지고 심이 새로 생긴다.
    await llm('p2');
    expect(loads).toBe(1);
    expect(seen).toBeUndefined();
  });
});

// ─── 「여기를 보라」고 말한 자리에 답이 있다 (#7495) ──────────────────────────
describe('makeAcpReviewLLM — 백엔드 해석 실패 관측', () => {
  it('없는 백엔드 id 면 acp-review/error 에 «이름을 댄» 이유가 남고 던진다', async () => {
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((c: string, e: string, d?: Record<string, unknown>) => {
      events.push({ category: c, event: e, data: d });
    }) as unknown as typeof debug.log);
    try {
      await expect(makeAcpReviewLLM({ cwd: '.', backend: 'claude-code' })('p')).rejects.toThrow(/Unknown ACP backend/);
    } finally {
      log.mockRestore();
    }
    const failure = events.find((x) => x.category === 'acp-review' && x.event === 'error');
    // ⛔ 이 단언이 없으면 관측을 다시 try 밖으로 빼도 아무것도 안 깨진다(#7495 리뷰 must-fix).
    expect(failure).toBeDefined();
    expect(String(failure!.data?.message)).toContain('Unknown ACP backend "claude-code"');
    // ⭐ 「있는 값」도 같이 알려 주는지 문다 — METHOD v13 ⑴ 이 요구하는 절반이다.
    expect(String(failure!.data?.message)).toContain('codex-app-server');
    expect(failure!.data?.stage).toBe('resolve-backend');
    // ⭐ 계측 «필드»도 문다 — stage·message 만 보면 나머지가 사라져도 통과한다(#7495 should-fix).
    expect(failure!.data?.requestedBackend).toBe('claude-code');
    expect(failure!.data?.backend).toBe('claude-code');
  });
});

// ACP-REVIEW-VIA-TEAMCLAUDE (0.2.35 · 대표 10-21 «리뷰도 cct(teamclaude) 버전으로 acp claude»).
//   `--acp-backend claude` 리뷰는 ANTHROPIC_BASE_URL 을 스스로 넣지 않아 teamclaude(계정 회전)를 안 거쳤다.
//   두 갈래: teamclaude 가 base-url 을 주면 자식 env 에 들어가고, 없으면 종전 경로(맨 claude 로그인) 그대로.
describe('ACP claude review routes through teamclaude', () => {
  const BASE = 'http://localhost:3456';
  function captureRouteLog() {
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as never);
    return { events, log };
  }

  it('teamclaude base-url → the ACP child env carries ANTHROPIC_BASE_URL and claude-route says viaTeamclaude', async () => {
    const route = resolveTeamclaudeReviewRoute({ PATH: '/bin', ANTHROPIC_API_KEY: 'key' },
      () => ({ status: 0, stdout: `export ANTHROPIC_BASE_URL=${BASE}\nexport ANTHROPIC_API_KEY=proxy-secret\n` }));
    let created: AcpAgentOpts | undefined;
    const { events, log } = captureRouteLog();
    try {
      await makeAcpReviewLLM({
        cwd: process.cwd(), backend: 'claude',
        resolveClaudeRoute: () => route,
        createAgent: (opts) => { created = opts; return reviewAgent(opts); },
      })('review');
    } finally { log.mockRestore(); }
    expect(route.spawn).toBeDefined();
    expect(created?.env?.ANTHROPIC_BASE_URL).toBe(BASE);
    // The billing scrub still applies: no API key reaches the subscription child, and the proxy key is never read.
    expect(created?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(created?.backendSpec?.command).toBe(getAcpBackend('claude').command);
    expect(events).toContainEqual({ category: 'review.acp', event: 'claude-route',
      data: { viaTeamclaude: true, baseUrlSet: true, timeoutSec: 600, reason: 'teamclaude-base-url' } });
  });

  it('teamclaude absent → the prior path (no backendSpec, no env) and claude-route says not viaTeamclaude', async () => {
    let created: AcpAgentOpts | undefined;
    const { events, log } = captureRouteLog();
    try {
      await makeAcpReviewLLM({
        cwd: process.cwd(), backend: 'claude', timeoutMs: 120_000,
        resolveClaudeRoute: () => ({ reason: 'teamclaude-unavailable' }),
        createAgent: (opts) => { created = opts; return reviewAgent(opts); },
      })('review');
    } finally { log.mockRestore(); }
    expect(created).toBeDefined();
    expect(created?.backendSpec).toBeUndefined();
    expect(created?.env).toBeUndefined();
    expect(events).toContainEqual({ category: 'review.acp', event: 'claude-route',
      data: { viaTeamclaude: false, baseUrlSet: false, timeoutSec: 120, reason: 'teamclaude-unavailable' } });
  });

  it('a non-claude backend never probes teamclaude', async () => {
    let probed = false;
    await makeAcpReviewLLM({
      cwd: process.cwd(), backend: 'codex',
      resolveClaudeRoute: () => { probed = true; return { reason: 'teamclaude-unavailable' }; },
      createAgent: (opts) => reviewAgent(opts),
    })('review');
    expect(probed).toBe(false);
  });

  it('acp claude review default timeout is 600s; other backends stay 300s', () => {
    expect(defaultAcpReviewTimeoutSec('claude')).toBe(600);
    expect(defaultAcpReviewTimeoutSec('cc')).toBe(600);
    expect(defaultAcpReviewTimeoutSec('codex')).toBe(300);
    expect(defaultAcpReviewTimeoutSec('grok')).toBe(300);
  });

  it('the production resolver runs the real `teamclaude env --no-mitm` (fake-bin) and reads only the base-url line', async () => {
    await withFakeBins({ teamclaude: { stdout: `export ANTHROPIC_BASE_URL=${BASE}\nexport ANTHROPIC_API_KEY=proxy-secret\n` } }, async (fakeBins) => {
      const route = resolveTeamclaudeReviewRoute({ ...fakeBins.env, ANTHROPIC_API_KEY: 'key' });
      expect(route.reason).toBe('teamclaude-base-url');
      expect(route.spawn?.env.ANTHROPIC_BASE_URL).toBe(BASE);
      expect(route.spawn?.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(fakeBins.calls().map((c) => c.argv)).toEqual([['env', '--no-mitm']]);
    });
  });

  it('the production resolver falls back when teamclaude is missing or prints no base-url', async () => {
    await withFakeBins({ teamclaude: { exitCode: 1 } }, async (fakeBins) => {
      expect(resolveTeamclaudeReviewRoute(fakeBins.env)).toEqual({ reason: 'teamclaude-no-base-url', exit: 1 });
    });
    await withFakeBins({ teamclaude: { stdout: 'no url here\n' } }, async (fakeBins) => {
      expect(resolveTeamclaudeReviewRoute(fakeBins.env)).toEqual({ reason: 'teamclaude-no-base-url', exit: 0 });
    });
    const empty = mkdtempSync(join(tmpdir(), 'no-teamclaude-'));
    try {
      expect(resolveTeamclaudeReviewRoute({ PATH: empty }).reason).toBe('teamclaude-unavailable');
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});
