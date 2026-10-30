import { describe, expect, test } from 'bun:test';
import {
  buildSessionRuntimeToolSpecs,
  dispatchSessionRuntimeTool,
  resolveDynamicSessionNativeToolSpecs,
  type SessionRuntimeDispatchDeps,
} from './index.js';
import { applyDeferredTools } from './tier-flip.js';
import { getSessionCwd } from '../session/working-dir.js';
import type { FeedbackEnvelope } from '../feedback/envelope.js';
import { addWebSearchProvider, _resetWebSearchProvidersForTests } from '../web-search/index.js';
import type { WebSearchProvider } from '../web-search/provider.js';

const names = ['SelfImplement', 'RunDevHarness'] as const;

function searchProvider(id: string): WebSearchProvider {
  return {
    id, displayName: id, available: () => true,
    search: async () => ({ providerName: id, durationMs: 1, hits: [{ url: `https://${id}.example`, title: id, snippet: id }] }),
  };
}

function depsFor(calls: string[]): SessionRuntimeDispatchDeps {
  return {
    userText: 'Implement this through the development harness.',
    getToolRuntime: name => {
      calls.push(`runtime-lookup:${name}`);
      return undefined;
    },
    dispatchToolRuntime: async name => {
      throw new Error(`runtime fallback reached: ${name}`);
    },
    dispatchPluginTool: async name => {
      throw new Error(`plugin fallback reached: ${name}`);
    },
    dispatchAutonomousTool: async (name, args, ctx) => {
      calls.push(`autonomous:${name}`);
      expect(ctx.cwd).toBe(getSessionCwd());
      expect(ctx.userText).toBe('Implement this through the development harness.');
      return { name, args, dispatched: 'autonomous' };
    },
  };
}

describe('session-runtime autonomous tool dispatch', () => {
  test('deep research availability matches its research-only dispatch provider set', () => {
    _resetWebSearchProvidersForTests(false);
    addWebSearchProvider(searchProvider('tavily'));
    addWebSearchProvider(searchProvider('ddg'));
    try {
      const withoutResearchPair = resolveDynamicSessionNativeToolSpecs({ userText: 'Research HBM4 vendors and compare sources.' });
      expect(withoutResearchPair.map(spec => spec.name)).not.toContain('OmniSearch');
      addWebSearchProvider(searchProvider('firecrawl'));
      addWebSearchProvider(searchProvider('grok-api'));
      const withResearchPair = resolveDynamicSessionNativeToolSpecs({ userText: 'Research HBM4 vendors and compare sources.' });
      expect(withResearchPair.map(spec => spec.name)).toContain('OmniSearch');
    } finally {
      _resetWebSearchProvidersForTests();
    }
  });

  test('OmniSearch surface dispatch uses the research-only provider route', async () => {
    _resetWebSearchProvidersForTests(false);
    const calls: string[] = [];
    for (const id of ['grok', 'grok-api', 'firecrawl', 'tavily', 'ddg']) {
      const source = searchProvider(id);
      addWebSearchProvider({ ...source, search: async query => {
        calls.push(id);
        return source.search(query);
      } });
    }
    try {
      const result = await dispatchSessionRuntimeTool('OmniSearch', { query: 'HBM4' }, depsFor([])) as {
        metadata: { perEngine: Record<string, unknown> };
      };
      expect(calls.sort()).toEqual(['firecrawl', 'grok']);
      expect(Object.keys(result.metadata.perEngine).sort()).toEqual(['firecrawl', 'grok']);
    } finally {
      _resetWebSearchProvidersForTests();
    }
  });

  for (const name of names) {
    test(`${name} dispatches through the autonomous helper before runtime or plugin fallbacks`, async () => {
      const calls: string[] = [];
      const result = await dispatchSessionRuntimeTool(name, { objective: 'wire the advertised tool' }, depsFor(calls));

      expect(result).toEqual({ name, args: { objective: 'wire the advertised tool' }, dispatched: 'autonomous' });
      expect(calls).toEqual([`autonomous:${name}`]);
    });
  }

  test('forwards autonomous feedback envelopes only when the parent supplied a carrier', async () => {
    const calls: string[] = [];
    const received: FeedbackEnvelope[] = [];
    const envelope = {
      envelopeVersion: 1,
      sessionId: 'parent-session',
      blockId: 'parent-session:autotool:run',
      kind: 'tool.progress',
      phase: 'start',
      emittedAt: Date.now(),
      seq: 0,
      asciiFallback: ['🔨 SelfImplement 시작'],
      payload: { stream: 'generic', lines: ['🔨 SelfImplement 시작'] },
    } as const satisfies FeedbackEnvelope;
    const deps = depsFor(calls);
    deps.emitFeedback = feedback => received.push(feedback);
    deps.dispatchAutonomousTool = async (_name, _args, ctx) => {
      expect(ctx.emitFeedback).toBeDefined();
      ctx.emitFeedback?.(envelope);
      return { dispatched: 'autonomous' };
    };

    await dispatchSessionRuntimeTool('SelfImplement', {}, deps);
    expect(received).toEqual([envelope]);

    const withoutCarrier = depsFor(calls);
    withoutCarrier.dispatchAutonomousTool = async (_name, _args, ctx) => {
      expect(ctx.emitFeedback).toBeUndefined();
      return { dispatched: 'autonomous' };
    };
    await dispatchSessionRuntimeTool('SelfImplement', {}, withoutCarrier);
  });

  // ⛔ 「안 넘김」과 「말했는데 어휘가 없음」은 «다른 값»이다(무인 리뷰 R3 must-fix ①·②).
  //   truthiness 로 접으면 `''` 가 사라져 소비처(harnessMentionState)가 'absent' 로 오독한다.
  test.each([
    ['', 'not-matched 를 뜻하는 빈 문자열은 «통과»한다'],
    ['하니스로 구현해줘', '보통 문자열도 그대로 통과한다'],
  ])('userText=%p 를 자율툴 ctx 로 그대로 넘긴다 — %s', async (userText) => {
    const calls: string[] = [];
    const deps = depsFor(calls);
    deps.userText = userText;
    let seen: unknown = Symbol('unset');
    deps.dispatchAutonomousTool = async (_name, _args, ctx) => {
      seen = ctx.userText;
      return { dispatched: 'autonomous' };
    };
    await dispatchSessionRuntimeTool('SelfImplement', {}, deps);
    expect(seen).toBe(userText);
  });

  test('userText 가 undefined 면 «키 자체»가 안 실린다 — absent 와 not-matched 를 가른다', async () => {
    const calls: string[] = [];
    const deps = depsFor(calls);
    delete (deps as { userText?: string }).userText;
    let hadKey: boolean | undefined;
    deps.dispatchAutonomousTool = async (_name, _args, ctx) => {
      hadKey = Object.prototype.hasOwnProperty.call(ctx, 'userText');
      return { dispatched: 'autonomous' };
    };
    await dispatchSessionRuntimeTool('SelfImplement', {}, deps);
    expect(hadKey).toBe(false);
  });

  test('carrier 를 줬는데 자식이 «아무 것도 안 내면» 성공은 그대로다 — 0건은 결함이 아니다', async () => {
    const calls: string[] = [];
    const received: FeedbackEnvelope[] = [];
    const deps = depsFor(calls);
    deps.emitFeedback = feedback => received.push(feedback);
    deps.dispatchAutonomousTool = async (_name, _args, ctx) => {
      expect(ctx.emitFeedback).toBeDefined();
      return { dispatched: 'autonomous' };
    };

    const result = await dispatchSessionRuntimeTool('SelfImplement', {}, deps);
    expect(received).toEqual([]);
    expect(result).toEqual({ dispatched: 'autonomous' });
  });

  test('the essential catalog excludes retired SelfOrchestrate and RunDevHarness from deferred name slots', () => {
    const split = (userText: string) => applyDeferredTools(
      [],
      buildSessionRuntimeToolSpecs({
        userText,
        hostTools: [],
        runtimeTools: [],
        optionalTools: [],
      }),
      { userText },
    );
    const simple = split('현재 작업 상태를 조회해줘');
    const complex = split('조사하고 구현하고 정기 점검 명세를 만들어줘');

    expect([...complex.tools.map(spec => spec.name), ...complex.stats.deferredNames]).not.toContain('SelfOrchestrate');
    expect(simple.tools.map(spec => spec.name)).not.toContain('SelfOrchestrate');
    expect(simple.stats.deferredNames).not.toContain('SelfOrchestrate'); // src/self-dev/entrance-registry.ts: nl-self-orchestrate has status: 'retired'.
    expect(complex.tools.map(spec => spec.name)).toContain('SelfImplement');
    expect(simple.tools.map(spec => spec.name)).not.toContain('RunDevHarness');
    expect(simple.stats.deferredNames).not.toContain('RunDevHarness'); // src/self-dev/entrance-registry.ts: nl-run-dev-harness has status: 'retired'.
  });
});
