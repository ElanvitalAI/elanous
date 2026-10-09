import { describe, it, expect, spyOn } from 'bun:test';
import { DEFAULT_REVIEW_BACKEND, isReadOnlyReviewTool, makeAcpReviewLLM, makeLazyAcpReviewLLM } from './acp-reviewer.js';
import { debug } from '../debug/log.js';
import { AcpAgent, type AcpAgentOpts } from '../acp/client.js';
import { AcpAgentManager } from '../acp/agent-manager.js';
import { CODEX_APP_SERVER_CAPS } from '../acp/codex-app-server-agent.js';
import type { ReviewImage } from './pr-reviewer.js';
import type { ElanousCapabilities } from '../acp/capabilities.js';
import { subscriptionReviewerSpawn } from '../self-dev/review-provider-fallback.js';

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
    });
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
      expect(child?.spec.command).toBe('teamclaude');
      expect(child?.spec.args).toEqual(['run', '--auto-fallback', '--', '--dangerously-skip-permissions']);
      expect(child?.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(child?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      start.mockRestore(); newSession.mockRestore(); prompt.mockRestore(); stop.mockRestore(); manager.mockRestore();
    }
  });
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
      const review = makeAcpReviewLLM({ cwd: process.cwd(), backend: 'claude' });
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
      await expect(makeAcpReviewLLM({ cwd: process.cwd(), backend: 'claude' })('review prompt'))
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
