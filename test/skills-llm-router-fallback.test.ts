// Pure unit tests for the regex → LLM cascade in
// `src/skills/llm-router.ts`. The cascade is the cost-ceiling
// chokepoint described in HANDOFF §4.2: regex hit (1 candidate) bypasses
// the LLM call entirely; 0 or ≥2 hits escalate.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  extractTriggersFromDescription,
  regexMatchCandidates,
  routeWithFallback,
  type RouteCandidate,
} from '../src/skills/llm-router.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS, streamLLMWithTools, type LLMProvider, type LLMStreamEvent, type LLMToolSpec } from '../src/llm.js';
import { debug } from '../src/debug/log.js';
import { setUserConfigOverlay } from '../src/user-config.js';
import {
  circuitState,
  recordProviderFailure,
  resetProviderCircuitForTest,
} from '../src/session-runtime/provider-circuit.js';

const SUMMARY: RouteCandidate = {
  name: 'my-summary',
  description: [
    'Use when: User wants a summary.',
    'Triggers: "summarize", "tl;dr", "요약".',
    'Does: Returns essential summary.',
    'NOT for: Multi-source comparison.',
  ].join('\n'),
};

const REVIEW: RouteCandidate = {
  name: 'my-review',
  description: [
    'Use when: User wants a code review.',
    'Triggers: "review", "check diff".',
    'Does: Diff -> AI review -> approval.',
    'NOT for: GitHub PR flows.',
  ].join('\n'),
};

const NO_CONV: RouteCandidate = {
  name: 'no-conv',
  description: 'A workflow that ignores the 4-line convention.',
};

describe('extractTriggersFromDescription', () => {
  it('parses double-quoted phrases on the Triggers line', () => {
    const triggers = extractTriggersFromDescription(SUMMARY.description);
    expect(triggers).toEqual(['summarize', 'tl;dr', '요약']);
  });

  it('parses single-quoted phrases too', () => {
    const desc = "Use when: x.\nTriggers: 'foo', 'bar'.\nDoes: y.\nNOT for: z.";
    expect(extractTriggersFromDescription(desc)).toEqual(['foo', 'bar']);
  });

  it('lowercases trigger phrases', () => {
    const desc = 'Use when: x.\nTriggers: "FooBar", "BAZ".\nDoes: y.\nNOT for: z.';
    expect(extractTriggersFromDescription(desc)).toEqual(['foobar', 'baz']);
  });

  it('returns empty when the convention is not followed', () => {
    expect(extractTriggersFromDescription(NO_CONV.description)).toEqual([]);
  });

  it('returns empty for the empty string', () => {
    expect(extractTriggersFromDescription('')).toEqual([]);
  });

  it('ignores bare words outside quotes (meta-language like "e.g.")', () => {
    const desc = 'Use when: x.\nTriggers: e.g., "actual", "real".\nDoes: y.\nNOT for: z.';
    expect(extractTriggersFromDescription(desc)).toEqual(['actual', 'real']);
  });

  it('handles a Triggers line at end-of-string with no following label', () => {
    const desc = 'Use when: x.\nTriggers: "alpha", "beta".';
    expect(extractTriggersFromDescription(desc)).toEqual(['alpha', 'beta']);
  });
});

describe('regexMatchCandidates', () => {
  it('returns single match when only one candidate has a substring trigger', () => {
    const matched = regexMatchCandidates('please give me the tl;dr', [SUMMARY, REVIEW]);
    expect(matched.map((c) => c.name)).toEqual(['my-summary']);
  });

  it('returns multiple matches when several triggers fire', () => {
    const matched = regexMatchCandidates('tl;dr then review', [SUMMARY, REVIEW]);
    expect(matched.map((c) => c.name).sort()).toEqual(['my-review', 'my-summary']);
  });

  it('returns empty when no triggers match the input', () => {
    expect(regexMatchCandidates('paraphrase please', [SUMMARY, REVIEW])).toEqual([]);
  });

  it('returns empty for an empty user message', () => {
    expect(regexMatchCandidates('   ', [SUMMARY, REVIEW])).toEqual([]);
  });

  it('skips candidates that lack a Triggers line entirely', () => {
    expect(regexMatchCandidates('a workflow', [NO_CONV])).toEqual([]);
  });

  it('is case-insensitive on the user message side', () => {
    const matched = regexMatchCandidates('SUMMARIZE this', [SUMMARY]);
    expect(matched.map((c) => c.name)).toEqual(['my-summary']);
  });

  it('honors a custom extractor when supplied', () => {
    const matched = regexMatchCandidates(
      'a workflow now',
      [NO_CONV],
      () => ['workflow'],
    );
    expect(matched.map((c) => c.name)).toEqual(['no-conv']);
  });

  it('prefers candidate.triggers when set (skips description parsing)', () => {
    // Candidate has a description that doesn't follow the 4-line
    // convention, but the caller provided triggers explicitly —
    // mirrors how the skill router supplies SkillIndexEntry.triggers
    // from YAML frontmatter.
    const skillLike: RouteCandidate = {
      name: 'omni-digest',
      description: 'A free-form prose blurb without any Triggers: line.',
      triggers: ['summarize', 'tl;dr'],
    };
    const matched = regexMatchCandidates('please summarize', [skillLike]);
    expect(matched.map((c) => c.name)).toEqual(['omni-digest']);
  });

  it('lowercases candidate.triggers before matching', () => {
    const skillLike: RouteCandidate = {
      name: 'shouty',
      description: 'whatever',
      triggers: ['SUMMARIZE', 'TL;DR'],
    };
    const matched = regexMatchCandidates('summarize this', [skillLike]);
    expect(matched.map((c) => c.name)).toEqual(['shouty']);
  });

  it('candidate.triggers=[] (empty array) bypasses description parsing AND matches nothing', () => {
    // Author opted out of regex routing for this candidate by
    // providing an empty triggers list. The cascade should NOT fall
    // back to parsing the description — that would override the
    // author's intent.
    const skill: RouteCandidate = {
      name: 'no-auto',
      description: 'Use when: x.\nTriggers: "alpha".\nDoes: y.\nNOT for: z.',
      triggers: [],
    };
    expect(regexMatchCandidates('alpha please', [skill])).toEqual([]);
  });
});

describe('routeWithFallback — cascade', () => {
  it('regex single hit returns source=regex without calling LLM', async () => {
    let llmCalls = 0;
    const result = await routeWithFallback({
      userMessage: 'tl;dr please',
      candidates: [SUMMARY, REVIEW],
      llm: async () => {
        llmCalls += 1;
        return '/invoke-workflow my-review';
      },
      invokeCommand: '/invoke-workflow',
    });
    expect(result.name).toBe('my-summary');
    expect(result.source).toBe('regex');
    expect(result.reasoning).toContain('regex matched');
    expect(result.error).toBeUndefined();
    expect(llmCalls).toBe(0);
  });

  it('regex zero hits escalates to LLM (source=llm)', async () => {
    let llmCalls = 0;
    const result = await routeWithFallback({
      userMessage: 'paraphrase this for me',
      candidates: [SUMMARY, REVIEW],
      llm: async () => {
        llmCalls += 1;
        return '/invoke-workflow my-summary';
      },
      invokeCommand: '/invoke-workflow',
    });
    expect(result.name).toBe('my-summary');
    expect(result.source).toBe('llm');
    expect(llmCalls).toBe(1);
  });

  it('regex multiple hits escalates to LLM (ambiguity → LLM tiebreak)', async () => {
    let llmCalls = 0;
    const result = await routeWithFallback({
      userMessage: 'tl;dr then review',
      candidates: [SUMMARY, REVIEW],
      llm: async () => {
        llmCalls += 1;
        return '/invoke-workflow my-review';
      },
      invokeCommand: '/invoke-workflow',
    });
    expect(result.name).toBe('my-review');
    expect(result.source).toBe('llm');
    expect(llmCalls).toBe(1);
  });

  it('skipRegex=true forces LLM even when regex would have hit', async () => {
    let llmCalls = 0;
    const result = await routeWithFallback({
      userMessage: 'tl;dr please',
      candidates: [SUMMARY, REVIEW],
      llm: async () => {
        llmCalls += 1;
        return '/invoke-workflow my-summary';
      },
      skipRegex: true,
      invokeCommand: '/invoke-workflow',
    });
    expect(result.source).toBe('llm');
    expect(llmCalls).toBe(1);
  });

  it('empty candidates returns source=none without calling LLM', async () => {
    let llmCalls = 0;
    const result = await routeWithFallback({
      userMessage: 'anything',
      candidates: [],
      llm: async () => {
        llmCalls += 1;
        return '/invoke-workflow x';
      },
      invokeCommand: '/invoke-workflow',
    });
    expect(result.name).toBeNull();
    expect(result.source).toBe('none');
    expect(llmCalls).toBe(0);
  });

  it('LLM throws → source=llm + error captured', async () => {
    const result = await routeWithFallback({
      userMessage: 'paraphrase',
      candidates: [SUMMARY],
      llm: async () => {
        throw new Error('rate-limited');
      },
      invokeCommand: '/invoke-workflow',
    });
    expect(result.name).toBeNull();
    expect(result.source).toBe('llm');
    expect(result.error).toBe('rate-limited');
  });

  it('LLM picks unknown name → name=null + error', async () => {
    const result = await routeWithFallback({
      userMessage: 'paraphrase',
      candidates: [SUMMARY],
      llm: async () => '/invoke-workflow nonexistent',
      invokeCommand: '/invoke-workflow',
    });
    expect(result.name).toBeNull();
    expect(result.source).toBe('llm');
    expect(result.error).toContain('Unknown candidate');
  });

  it('forwards llmCallOpts to the LLM caller', async () => {
    let captured: { model?: string; provider?: string } = {};
    await routeWithFallback({
      userMessage: 'paraphrase',
      candidates: [SUMMARY],
      llm: async (_prompt, opts) => {
        captured = opts;
        return '/invoke-workflow my-summary';
      },
      llmCallOpts: { model: 'haiku', provider: 'anthropic' },
      invokeCommand: '/invoke-workflow',
    });
    expect(captured.model).toBe('haiku');
    expect(captured.provider).toBe('anthropic');
  });

  it('uses custom invokeCommand in the prompt + parser', async () => {
    let capturedPrompt = '';
    const result = await routeWithFallback({
      userMessage: 'paraphrase',
      candidates: [SUMMARY],
      llm: async (prompt) => {
        capturedPrompt = prompt;
        return '/invoke-skill my-summary';
      },
      invokeCommand: '/invoke-skill',
    });
    expect(capturedPrompt).toContain('/invoke-skill <candidate-name>');
    expect(result.name).toBe('my-summary');
    expect(result.source).toBe('llm');
  });

  it('passes context through to the prompt builder', async () => {
    let capturedPrompt = '';
    await routeWithFallback({
      userMessage: 'paraphrase',
      candidates: [SUMMARY],
      llm: async (prompt) => {
        capturedPrompt = prompt;
        return '/invoke-workflow my-summary';
      },
      context: { platformType: 'pwa', title: 'morning' },
      invokeCommand: '/invoke-workflow',
    });
    expect(capturedPrompt).toContain('## Context');
    expect(capturedPrompt).toContain('Platform: pwa');
    expect(capturedPrompt).toContain('Title: morning');
  });
});

// SURVIVAL-PROVIDER-CIRCUIT (S2): 턴을 넘어 공급자 건강을 기억하는 회로가
// streamLLMWithTools 의 첫 공급자 해석을 갈아끼우는지 — L2 무대(스크립트 공급자).
describe('SURVIVAL-PROVIDER-CIRCUIT: streamLLMWithTools initial provider wiring', () => {
  const originalProviders = { ...PROVIDERS };
  const savedEnv: Record<string, string | undefined> = {};
  let tmpHome: string | null = null;

  function scriptedProvider(
    name: string,
    script: (opts?: { model?: string; tools?: LLMToolSpec[] }) => AsyncGenerator<LLMStreamEvent, void, unknown>,
  ): LLMProvider {
    return {
      name,
      defaultModel: `${name}-model`,
      available: () => true,
      streamChat: (_messages, opts) => script(opts),
      async *chat(_messages, opts) {
        for await (const event of script(opts)) {
          if (event.type === 'text') yield event.delta;
        }
      },
    };
  }

  const tool: LLMToolSpec = {
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  };

  beforeEach(() => {
    resetProviderCircuitForTest();
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'CODEX_HOME',
      'XAI_API_KEY',
      'GROK_API_KEY',
      'GROK_CODE_XAI_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'LOCAL_LLM_URL',
    ]) {
      savedEnv[key] = process.env[key];
    }
    tmpHome = mkdtempSync(join(tmpdir(), 'provider-circuit-'));
    process.env.HOME = tmpHome;
    process.env.XDG_CONFIG_HOME = tmpHome;
    process.env.CODEX_HOME = join(tmpHome, 'codex-home');
    for (const key of [
      'XAI_API_KEY',
      'GROK_API_KEY',
      'GROK_CODE_XAI_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'LOCAL_LLM_URL',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    Object.assign(PROVIDERS, originalProviders);
    setUserConfigOverlay(null);
    resetProviderCircuitForTest();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tmpHome) {
      rmSync(tmpHome, { recursive: true, force: true });
      tmpHome = null;
    }
  });

  it('opens the turn on the next chained provider when the resolved first provider circuit is open', async () => {
    const calls: string[] = [];
    const log = spyOn(debug, 'log');
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    const blocked = scriptedProvider('grok', async function* () {
      calls.push('grok');
      throw new Error('grok socket hang up');
    });
    const opened = scriptedProvider('anthropic', async function* () {
      calls.push('anthropic');
      yield { type: 'tool_call', id: 'circuit-call', name: 'echo', args: { value: 'ok' } };
    });
    PROVIDERS.grok = blocked;
    PROVIDERS.anthropic = opened;
    PROVIDERS.gemini = scriptedProvider('gemini', async function* () {});
    PROVIDERS.local = scriptedProvider('local', async function* () {});

    // 1순위(grok)가 전환 사유로 연속 2회 실패 — 회로 open.
    recordProviderFailure('grok', 'rate-limit', Date.now());
    recordProviderFailure('grok', 'rate-limit', Date.now());

    const dispatched: string[] = [];
    await streamLLMWithTools(
      [{ role: 'user', content: 'use echo' }],
      { onText: () => {}, dispatchTool: async (name) => { dispatched.push(name); return 'ok'; } },
      { provider: undefined, tools: [tool], maxTurns: 1 },
    );

    // 고장 난 1순위를 다시 열지 않고 체인의 다음 칸에서 턴이 열렸다.
    expect(calls[0]).toBe('anthropic');
    expect(calls).not.toContain('grok');
    expect(dispatched).toEqual(['echo']);
    expect(log).toHaveBeenCalledWith('tui.survival', 'turn-opened-on-fallback', { blocked: 'grok', opened: 'anthropic' });
    log.mockRestore();
  });

  it('opens the circuit after two real tool-stream failures across turns', async () => {
    const calls: string[] = [];
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = scriptedProvider('grok', async function* () {
      calls.push('grok');
      throw Object.assign(new Error('rate limit reached'), { status: 429 });
    });
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () {
      calls.push('anthropic');
      yield { type: 'text', delta: 'recovered' };
    });
    PROVIDERS.gemini = scriptedProvider('gemini', async function* () {});
    PROVIDERS.local = scriptedProvider('local', async function* () {});

    for (let turn = 0; turn < 2; turn++) {
      await streamLLMWithTools(
        [{ role: 'user', content: 'hello' }],
        { onText: () => {}, dispatchTool: async () => 'ok' },
        { tools: [tool], maxTurns: 1 },
      );
    }
    expect(circuitState('grok', Date.now())).toBe('open');
    await streamLLMWithTools(
      [{ role: 'user', content: 'hello again' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      { tools: [tool], maxTurns: 1 },
    );
    expect(calls).toEqual(['grok', 'anthropic', 'grok', 'anthropic', 'anthropic']);
  });

  it('honors skipped providers while choosing the initial fallback', async () => {
    const calls: string[] = [];
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    PROVIDERS.grok = scriptedProvider('grok', async function* () { calls.push('grok'); });
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () { calls.push('anthropic'); });
    PROVIDERS.gemini = scriptedProvider('gemini', async function* () {
      calls.push('gemini');
      yield { type: 'text', delta: 'available' };
    });
    PROVIDERS.local = scriptedProvider('local', async function* () {});
    recordProviderFailure('grok', 'rate-limit', Date.now());
    recordProviderFailure('grok', 'rate-limit', Date.now());

    await streamLLMWithTools(
      [{ role: 'user', content: 'hello' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      { tools: [tool], maxTurns: 1, skipProviders: ['anthropic'] },
    );
    expect(calls).toEqual(['gemini']);
  });

  it('respects an explicit opts.provider even while the first provider circuit is open', async () => {
    const calls: string[] = [];
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto' } }));
    const explicit = scriptedProvider('grok', async function* () {
      calls.push('grok');
      yield { type: 'text', delta: 'explicit wins' };
    });
    PROVIDERS.grok = explicit;
    PROVIDERS.anthropic = scriptedProvider('anthropic', async function* () { calls.push('anthropic'); });
    PROVIDERS.gemini = scriptedProvider('gemini', async function* () {});
    PROVIDERS.local = scriptedProvider('local', async function* () {});

    // 회로가 열려 있어도 명시·고정 공급자는 사람 의도가 이긴다.
    recordProviderFailure('grok', 'rate-limit', Date.now());
    recordProviderFailure('grok', 'rate-limit', Date.now());

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'hello' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      { provider: explicit, tools: [tool], maxTurns: 1 },
    );

    expect(calls[0]).toBe('grok');
    expect(result).toContain('explicit wins');
  });
});
