import { describe, test, expect, spyOn, afterEach, setDefaultTimeout } from 'bun:test';
import { setExecFileForTest, setTermGrepConcurrencyForTest, type ExecFileLike, isImplementationGoal, searchCodebase, searchRepositoryDocuments, groundMissionInSkills, groundMissionInMemory, groundMissionInCodebase, groundMissionInCapsules, extractExportedSymbols, refFactsFromDigest, expandHyphenatedSearchTerms, hasRepositorySpecificIdentifier, type SkillPickFn, isCorpusGrounded, isRepositoryImplementationCandidate, defaultSearchTerms, pickSkillsViaLlm } from './mission-codebase-gate.js';
import type { PersistentGroundingDeps } from '../skills/tools/persistent-grounding.js';
import type { SkillIndexEntry } from '../skills/index.js';
import { buildHarnessContextCapsule, type HarnessContextCapsule } from '../self-implement/context-capsule.js';
import { debug } from '../debug/log.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findClaudeModel } from '../anthropic/models.js';
import { findCodexModel } from '../codex/models.js';
import * as modelDefaults from '../llm/model-defaults.js';
import * as llm from '../llm.js';
import { BUILTIN_CATALOG } from '../intelligence-map/model-catalog.js';
import { GOAL_DEVICE_LOAD_SAMPLES, GOAL_DEVICE_SEAM_TERM, driveAbandonedTimeoutCwdSeam, driveTimeoutCwdSeam, goalDeviceExecFile } from '../ux-sim/goal-device.js';

// ⭐ debug.log 바꿔치기 복원 보장(TF #9714 연쇄 수리 · bun 1.4.2 실측) — 타임아웃으로 버려진 본문은
// pend 상태로 남아 «다음 테스트 도중»에 재개되고, 그 늦은 finally 가 다음 시험이 방금 설치한 override 를
// 덮어썐다(cwd seam corpus 657행 연쇄의 실제 메커니즘). afterEach 는 타임아웃 직후·다음 테스트 전에
// 반드시 돌므로 끝나지 않은 본문도 여기서 복원된다. 경계를 지날 때마다 epoch 를 올려, 시험 본문의
// 늦은 finally 가 «다음 시험 도중»에 재개돼도 어떤 상태에서도 복원을 못 하게 한다 — 소유자 일치(CAS)
// 하나만으로는 경계 통과를 모르므로 다음 시험의 override 를 덮는 경로가 남는다(연쇄의 명시된 원인).
const pristineDebugLog = debug.log;
const suiteEntryCwd = process.cwd();
// Grounding tests execute real repository searches. Under a loaded Pod host the
// 5s Bun default abandons a body mid-flight and its debug sink can spill into
// the following test. Give this file the same 30s budget as its slow cases.
setDefaultTimeout(30_000);
let debugLogEpoch = 0;
afterEach(() => {
  debugLogEpoch += 1;
  (debug as { log: typeof debug.log }).log = pristineDebugLog;
  // A timed-out async body can skip its own finally until the next test starts.
  // Restore cwd at the synchronous test boundary, including a deleted cwd.
  try {
    if (process.cwd() !== suiteEntryCwd) process.chdir(suiteEntryCwd);
  } catch {
    process.chdir(suiteEntryCwd);
  }
});

// 시험 본문의 debug.log 교체·복원 경계 — tooCommon 시험과 연쇄 증명 시험이 같은 경로를 쓴다(증명이 실제
// 수리 코드를 지난다). 복원은 CAS + epoch 일치 가드: 타임아웃으로 버려진 본문이 다음 시험 도중에
// 재개되면 afterEach 가 이미 epoch 를 올렸으므로 successor 의 override 를 덮지 않는다(연쇄 차단).
function swapDebugLog(
  sink: { category: string; event: string; data?: unknown }[],
  onLog?: (category: string, event: string) => void,
) {
  const epoch = debugLogEpoch;
  const swap = ((category: string, event: string, data?: unknown) => {
    sink.push({ category, event, data });
    onLog?.(category, event);
  }) as typeof debug.log;
  (debug as { log: typeof debug.log }).log = swap;
  return () => {
    if (debugLogEpoch === epoch && (debug as { log: typeof debug.log }).log === swap) {
      (debug as { log: typeof debug.log }).log = pristineDebugLog;
    }
  };
}

// 이 두 시험은 경계 복원을 직접 반증한다: afterEach 를 제거하면 둘째가 실패한다.
describe('debug.log 시험 경계 복원', () => {
  test('첫 시험이 자기 override 를 남긴다', () => {
    (debug as { log: typeof debug.log }).log = (() => undefined) as typeof debug.log;
    expect(debug.log).not.toBe(pristineDebugLog);
  });
  test('다음 시험은 원본 debug.log 로 시작한다', () => {
    expect(debug.log).toBe(pristineDebugLog);
  });
});

function fakeSkill(over: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    name: 'x', description: '', triggers: [], extractedTriggers: [], triggerSource: 'none',
    autoTrigger: false, composes: [], skillDir: '/skills/x', rootDir: '/skills', ...over,
  };
}

describe('defaultSearchTerms 관측 계약', () => {
  test('LLM 입력이 500자를 넘으면 실제 절단량과 제한된 ask를 관측한다', async () => {
    const logs: { category: string; event: string; data: unknown }[] = [];
    const goal = `${'a'.repeat(500)} tail-token`;
    const client: NonNullable<Parameters<typeof defaultSearchTerms>[1]> = {
      resolveDefaultProvider: () => undefined,
      streamLLM: async (messages, onChunk) => {
        expect(messages[0]?.content).toContain(`Goal: ${'a'.repeat(500)}\nKeywords:`);
        expect(messages[0]?.content).not.toContain('tail-token');
        onChunk('observed-term', 'observed-term');
        return 'observed-term';
      },
    };
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      expect(await defaultSearchTerms(goal, client)).toEqual(['observed-term']);
      expect(logs).toContainEqual({
        category: 'grounding.search',
        event: 'terms-input-truncated',
        data: { goalChars: goal.length, llmGoalChars: 500, truncatedChars: goal.length - 500 },
      });
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
    }
  });

  test('기본 LLM은 정적 초기화하지 않고 호출 시에만 동적으로 불러온다', () => {
    const source = readFileSync(new URL('./mission-codebase-gate.ts', import.meta.url), 'utf8');
    expect(source).toContain("const client = llmClient ?? await import('../llm.js');");
    expect(source).not.toContain("import * as llm from '../llm.js';");
  });

  test('LLM 실패는 전문 토큰 폴백과 그 경로를 관측한다', async () => {
    const logs: { category: string; event: string; data: unknown }[] = [];
    const goal = `${'한'.repeat(500)} full-goal-token`;
    const client: NonNullable<Parameters<typeof defaultSearchTerms>[1]> = {
      resolveDefaultProvider: () => undefined,
      streamLLM: async () => { throw new Error('test-llm-failure'); },
    };
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      expect(await defaultSearchTerms(goal, client)).toEqual(['full-goal-token']);
      expect(logs).toContainEqual({
        category: 'grounding.search',
        event: 'terms-llm-fallback',
        data: { fallbackSource: 'full-goal', fallbackTerms: 1, error: 'test-llm-failure' },
      });
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
    }
  });
});

describe('LLM usage 관측', () => {
  test('주입된 검색어 호출은 usage 이벤트마다 원값과 site를 기록하고 텍스트를 유지한다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const budget = spyOn(modelDefaults, 'budgetModel').mockReturnValue('usage-model');
    const client: NonNullable<Parameters<typeof defaultSearchTerms>[1]> = {
      resolveDefaultProvider: () => undefined,
      streamLLM: async (_messages, onChunk, opts) => {
        opts?.onUsage?.({ provider: 'anthropic', inputTokens: 11, outputTokens: 7, cacheReadInputTokens: 3 });
        opts?.onUsage?.({ outputTokens: 2, cacheCreationInputTokens: 5 });
        onChunk('usage-term', 'usage-term');
        return 'usage-term';
      },
    };
    try {
      expect(await defaultSearchTerms('usage observation goal', client)).toEqual(['usage-term']);
      const usageLogs = log.mock.calls.filter((call) => call[0] === 'llm.usage' && call[1] === 'llm-usage');
      expect(usageLogs.map((call) => call[2])).toEqual([
        {
          site: 'codebase-gate-injected', model: 'usage-model', provider: 'anthropic',
          inputTokens: 11, outputTokens: 7, cacheReadInputTokens: 3,
          cost: { kind: 'unknown', model: 'usage-model' },
        },
        {
          site: 'codebase-gate-injected', model: 'usage-model',
          outputTokens: 2, cacheCreationInputTokens: 5,
          cost: { kind: 'unknown', model: 'usage-model' },
        },
      ]);
    } finally { log.mockRestore(); budget.mockRestore(); }
  });

  test('동적 skill 호출은 onUsage를 실행하고 카탈로그 단가를 debug.log에 싣는다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const stream = spyOn(llm, 'streamLLM').mockImplementation(async (_messages, onChunk, opts) => {
      opts?.onUsage?.({ inputTokens: 1_000_000, outputTokens: 0 });
      onChunk('photo-intake-ocr', 'photo-intake-ocr');
      return 'photo-intake-ocr';
    });
    const model = spyOn(modelDefaults, 'budgetModel');
    const skills = [fakeSkill({ name: 'photo-intake-ocr' })];
    try {
      model.mockReturnValue('gpt-5.6-terra');
      expect(await pickSkillsViaLlm('reuse photo intake', skills, 1)).toEqual(['photo-intake-ocr']);
      model.mockReturnValue('gpt-5.6-luna');
      expect(BUILTIN_CATALOG.models.find((entry) => entry.id === 'gpt-5.6-luna')?.inputPerMtok).toBe(1);
      expect(await pickSkillsViaLlm('reuse photo intake', skills, 1)).toEqual(['photo-intake-ocr']);
      const usageLogs = log.mock.calls.filter((call) => call[0] === 'llm.usage' && call[1] === 'llm-usage');
      expect(usageLogs.map((call) => call[2])).toEqual([
        {
          site: 'codebase-gate-dynamic', model: 'gpt-5.6-terra',
          inputTokens: 1_000_000, outputTokens: 0,
          cost: { kind: 'known', model: 'gpt-5.6-terra', usd: findCodexModel('gpt-5.6-terra')!.pricingUsd!.inputPerM, source: 'catalog', cacheReadPricedAt: 'input-rate', cacheWritePricedAt: 'input-rate' },
        },
        {
          site: 'codebase-gate-dynamic', model: 'gpt-5.6-luna',
          inputTokens: 1_000_000, outputTokens: 0,
          cost: { kind: 'known', model: 'gpt-5.6-luna', usd: BUILTIN_CATALOG.models.find((model) => model.id === 'gpt-5.6-luna')!.inputPerMtok, source: 'catalog', cacheReadPricedAt: 'input-rate', cacheWritePricedAt: 'input-rate' },
        },
      ]);
    } finally {
      model.mockRestore();
      stream.mockRestore();
      log.mockRestore();
    }
  });

  test('동적 skill 호출도 usage 콜백과 구별 site를 전달한다', () => {
    const source = readFileSync(new URL('./mission-codebase-gate.ts', import.meta.url), 'utf8');
    expect(source).toContain("onUsage: (usage) => logLlmUsage('codebase-gate-dynamic', model, usage)");
    expect(source).toContain('...llmUsageCostFields(model, usage)');
  });

  test('catalog-priced models emit a known cost field on both onUsage paths, including cache tokens', async () => {
    const terra = findCodexModel('gpt-5.6-terra')!.pricingUsd!;
    const claude = findClaudeModel('claude-sonnet-4-6')!;
    const cacheRead = (claude.pricingUsd as { cacheReadPerM?: number }).cacheReadPerM;
    const cacheWrite = (claude.pricingUsd as { cacheWritePerM?: number }).cacheWritePerM;
    expect(cacheRead).toBeDefined();
    expect(cacheWrite).toBeDefined();

    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const budget = spyOn(modelDefaults, 'budgetModel').mockReturnValueOnce('gpt-5.6-terra').mockReturnValueOnce('claude-sonnet-4-6');
    const injected: NonNullable<Parameters<typeof defaultSearchTerms>[1]> = {
      resolveDefaultProvider: () => undefined,
      streamLLM: async (_messages, onChunk, opts) => {
        opts?.onUsage?.({ inputTokens: 1_000_000, outputTokens: 0 });
        onChunk('usage-term', 'usage-term');
        return 'usage-term';
      },
    };
    const stream = spyOn(llm, 'streamLLM').mockImplementation(async (_messages, onChunk, opts) => {
      opts?.onUsage?.({
        provider: 'anthropic',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      });
      onChunk('NONE', 'NONE');
      return 'NONE';
    });
    try {
      expect(await defaultSearchTerms('usage observation goal', injected)).toEqual(['usage-term']);
      expect(await pickSkillsViaLlm('usage observation goal', [fakeSkill({ name: 'diagram-master', description: 'draw' })], 3)).toEqual([]);
      const usageLogs = log.mock.calls.filter((call) => call[0] === 'llm.usage' && call[1] === 'llm-usage');
      expect(usageLogs.map((call) => call[2])).toEqual([
        {
          site: 'codebase-gate-injected', model: 'gpt-5.6-terra',
          inputTokens: 1_000_000, outputTokens: 0,
          cost: {
            kind: 'known', model: 'gpt-5.6-terra', usd: terra.inputPerM, source: 'catalog',
            cacheReadPricedAt: 'input-rate', cacheWritePricedAt: 'input-rate',
          },
        },
        {
          site: 'codebase-gate-dynamic', model: 'claude-sonnet-4-6',
          provider: 'anthropic', inputTokens: 0, outputTokens: 0,
          cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000,
          cost: {
            kind: 'known', model: 'claude-sonnet-4-6', usd: cacheRead! + cacheWrite!, source: 'catalog',
            cacheReadPricedAt: 'cache-read', cacheWritePricedAt: 'cache-write',
          },
        },
      ]);
    } finally { log.mockRestore(); budget.mockRestore(); stream.mockRestore(); }
  });

  test('usage logging failure is swallowed and does not change search terms', async () => {
    const log = spyOn(debug, 'log').mockImplementation(((category: string) => {
      if (category === 'llm.usage') throw new Error('usage log failed');
    }) as typeof debug.log);
    const client: NonNullable<Parameters<typeof defaultSearchTerms>[1]> = {
      resolveDefaultProvider: () => undefined,
      streamLLM: async (_messages, onChunk, opts) => {
        opts?.onUsage?.({ inputTokens: 1 });
        onChunk('usage-term', 'usage-term');
        return 'usage-term';
      },
    };
    try {
      expect(await defaultSearchTerms('usage observation goal', client)).toEqual(['usage-term']);
    } finally { log.mockRestore(); }
  });
});

describe('isImplementationGoal — 구현·변경·분석형 판정(순수 조회 제외)', () => {
  test('구현/변경/분석 동사 → true', () => {
    expect(isImplementationGoal('기억 생애주기 시스템을 구현해줘')).toBe(true);
    expect(isImplementationGoal('signal 게이팅 로직 리팩토링')).toBe(true);
    expect(isImplementationGoal('이 매매 루프 코드 분석해줘')).toBe(true);
    expect(isImplementationGoal('trade mandate 게이트 개선')).toBe(true);
    expect(isImplementationGoal('add caching to the scheduler')).toBe(true);
  });
  test('순수 단발 조회 → false', () => {
    expect(isImplementationGoal('삼성 주가 얼마야')).toBe(false);
    expect(isImplementationGoal('미션 목록 보여줘')).toBe(false);
    expect(isImplementationGoal('what is the status')).toBe(false);
  });
  test('짧은 애매 단문 → false(조회 경향)', () => {
    expect(isImplementationGoal('삼성 어때')).toBe(false);
  });
});

describe('repository-specific identifier detection', () => {
  test('marks general asks as an unknown search scope but recognizes repository names, paths, and identifiers', () => {
    const groundedIdentifiers = ['elanous', 'src/self-implement/goal-author.ts', 'groundMissionInCodebase'];
    expect(hasRepositorySpecificIdentifier('Improve long-running scope-boundary candidates.', groundedIdentifiers)).toBe(false);
    expect(hasRepositorySpecificIdentifier('Improve elanous self author boundaries.', groundedIdentifiers)).toBe(true);
    expect(hasRepositorySpecificIdentifier('Update src/self-implement/goal-author.ts.', groundedIdentifiers)).toBe(true);
    expect(hasRepositorySpecificIdentifier('Wire groundMissionInCodebase.', groundedIdentifiers)).toBe(true);
  });

  test('잡음 조각이 낱말 안쪽에 걸리지 않는다 — run/and 오탐', () => {
    const noise = ['run', 'and'];
    expect(hasRepositorySpecificIdentifier('Improve long-running scope-boundary candidates.', noise)).toBe(false);
    expect(hasRepositorySpecificIdentifier('candidates', noise)).toBe(false);
    expect(hasRepositorySpecificIdentifier('long-running', noise)).toBe(false);
  });

  test('하이픈 복합어는 여전히 식별자가 아니다 — 하이픈을 경계로 치면 안 된다', () => {
    expect(hasRepositorySpecificIdentifier('Plan research-and-development work.', ['and'])).toBe(false);
    expect(hasRepositorySpecificIdentifier('Fix the long-running job.', ['run'])).toBe(false);
  });

  test('보충 평면 문자 옆은 낱말 안쪽이다 — 서로게이트 반쪽을 경계로 읽지 않는다', () => {
    expect(hasRepositorySpecificIdentifier('\u{10400}run', ['run'])).toBe(false);
    expect(hasRepositorySpecificIdentifier('run\u{10400}', ['run'])).toBe(false);
    expect(hasRepositorySpecificIdentifier('\u{10400} run \u{10400}', ['run'])).toBe(true);
  });

  test('결합 문자 옆도 낱말 안쪽이다 — 낱말 문자와 토큰 규칙이 같은 집합이다', () => {
    expect(hasRepositorySpecificIdentifier('run\u0301ning', ['run'])).toBe(false);
    expect(hasRepositorySpecificIdentifier('\u0301run', ['run'])).toBe(false);
    expect(hasRepositorySpecificIdentifier('the run\u0301 job', ['run'])).toBe(false);
  });

  test('한글·비ASCII 낱말 안쪽도 걸리지 않는다', () => {
    expect(hasRepositorySpecificIdentifier('실행run중', ['run'])).toBe(false);
    expect(hasRepositorySpecificIdentifier('실행 run 중', ['run'])).toBe(true);
  });

  test('경로·구두점 옆의 진짜 식별자는 그대로 걸린다', () => {
    expect(hasRepositorySpecificIdentifier('Touch src/goal-author.ts today.', ['goal-author'])).toBe(true);
    expect(hasRepositorySpecificIdentifier('The run failed.', ['run'])).toBe(true);
    expect(hasRepositorySpecificIdentifier('a and b', ['and'])).toBe(true);
  });
});

describe('하이픈 검색어 확장', () => {
  test('원본을 보존하고 구성 토큰을 중복 없이 추가한다', () => {
    expect(expandHyphenatedSearchTerms(['self-author', 'pr-title', 'branch-name', 'author']))
      .toEqual(['self-author', 'self', 'author', 'pr-title', 'pr', 'title', 'branch-name', 'branch', 'name']);
  });

  test('하이픈 없는 term은 그대로 하나로 남는다', () => {
    expect(expandHyphenatedSearchTerms(['grounding'])).toEqual(['grounding']);
  });

  test('self-author의 구성 토큰 검색이 goal-author.ts를 찾는다', async () => {
    const files = await searchCodebase(expandHyphenatedSearchTerms(['self-author']), 80);
    expect(files).toContain('src/self-implement/goal-author.ts');
  }, 30_000);

  test('searchTerms seam을 주입해도 persistent loop를 끄지 않는다', async () => {
    const grounded = await groundMissionInCodebase('self author 계약', {
      searchTerms: async () => ['self-author'],
      persistent: {
        runGoalLoop: async (ctx) => {
          await ctx.dispatchTool('Read', { file_path: 'src/self-implement/goal-author.ts' }, { callId: 'read', sessionId: ctx.sessionId, signal: ctx.signal });
          ctx.callbacks?.onToolCall?.({ id: 'done', name: 'update_goal', args: { status: 'complete', evidence: 'src/self-implement/goal-author.ts: verified' } });
          return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
        },
      },
      skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
    });
    expect(grounded.files).toContain('src/self-implement/goal-author.ts');
    expect(grounded.persistentEvidence).toEqual(['src/self-implement/goal-author.ts: verified']);
    expect(grounded.persistentEvidenceItems).toEqual([
      { text: 'src/self-implement/goal-author.ts: verified', sourceKind: 'code' },
    ]);
  }, 30_000);

  test('주입한 서로 다른 terms가 persistent 코드 채널의 codeFiles 후보를 분기한다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'persistent-grounding-terms-'));
    const termFiles = {
      'alpha-seam': 'src/alpha-candidate.ts',
      'beta-seam': 'src/beta-candidate.ts',
    } as const;
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      for (const file of Object.values(termFiles)) writeFileSync(join(cwd, file), 'export const candidate = true;\n');
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['add', '.'], { cwd });
      const persistent: PersistentGroundingDeps = {
        runGoalLoop: async (ctx) => {
          const prompt = String(ctx.messages.at(-1)?.content);
          const [term, file] = Object.entries(termFiles).find(([candidate]) => prompt.includes(candidate)) ?? [];
          expect(term).toBeDefined();
          expect(file).toBeDefined();
          await ctx.dispatchTool('Read', { file_path: file! }, { callId: `read-${term}`, sessionId: ctx.sessionId, signal: ctx.signal });
          ctx.callbacks?.onToolCall?.({ id: 'done', name: 'update_goal', args: { status: 'complete', evidence: `${file}: verified for ${term}` } });
          return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
        },
      };
      const commonDeps = {
        cwd, persistent, skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
      };
      const alpha = await groundMissionInCodebase('same goal', { ...commonDeps, searchTerms: async () => ['alpha-seam'] });
      const beta = await groundMissionInCodebase('same goal', { ...commonDeps, searchTerms: async () => ['beta-seam'] });

      expect(alpha.files).toEqual([termFiles['alpha-seam']]);
      expect(beta.files).toEqual([termFiles['beta-seam']]);
      expect(alpha.files).not.toEqual(beta.files);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('grounding 집계기가 확장 term으로 저작기 후보를 찾고 관측한다', async () => {
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const grounded = await groundMissionInCodebase('self author 계약', {
        searchTerms: async () => ['self-author'],
        persistent: {
          runGoalLoop: async (ctx) => {
            await ctx.dispatchTool('Read', { file_path: 'src/self-implement/goal-author.ts' }, { callId: 'read', sessionId: ctx.sessionId, signal: ctx.signal });
            ctx.callbacks?.onToolCall?.({ id: 'done', name: 'update_goal', args: { status: 'complete', evidence: 'src/self-implement/goal-author.ts: verified' } });
            return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
          },
        },
        skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
      });
      expect(grounded.files).toContain('src/self-implement/goal-author.ts');
      expect(logs).toContainEqual({
        category: 'grounding.search', event: 'term-expanded', data: { inputTerms: 1, outputTerms: 3 },
      });
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
    }
  });
});

describe('searchCodebase', () => {
  test('빈 terms → []', async () => {
    expect(await searchCodebase([])).toEqual([]);
  });
  test('실제 코드 grounding — memory 키워드로 핵심 모듈 발견(distinct coverage 랭킹)', async () => {
    const files = await searchCodebase(['memory', 'decay', 'consolidate', 'archive', 'tier', 'recall'], 8);
    expect(files.some((f) => f.includes('surface-events') || f.includes('memory-'))).toBe(true);
    expect(files.every((f) => !f.includes('.test.'))).toBe(true);
  }, 30_000);
  test('고정 fixture 문서를 보존하되 구현 후보에서는 분리한다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'repository-document-fixture-'));
    const documentPath = join('docs', 'grounding-fixture.md');
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      mkdirSync(join(cwd, 'docs'), { recursive: true });
      writeFileSync(join(cwd, 'src', 'grounding-candidate.ts'), 'export const groundingCandidate = true;\n');
      writeFileSync(join(cwd, documentPath), 'grounding fixture evidence\n');
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['add', '.'], { cwd });

      const identifiers = ['grounding'];
      const codeFiles = await searchCodebase(identifiers, 80, cwd);
      const documentFacts = await searchRepositoryDocuments(identifiers, 80, cwd);

      expect(codeFiles).toEqual(['src/grounding-candidate.ts']);
      expect(documentFacts).toEqual([documentPath]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('집계기는 고정 fixture 문서를 참조로 보존하고 files에는 넣지 않으며 분리 관측을 남긴다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'grounding-document-fixture-'));
    const documentPath = join('docs', 'grounding-fixture.md');
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      mkdirSync(join(cwd, 'docs'), { recursive: true });
      writeFileSync(join(cwd, 'src', 'grounding-candidate.ts'), 'export const groundingCandidate = true;\n');
      writeFileSync(join(cwd, documentPath), 'grounding fixture evidence\n');
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['add', '.'], { cwd });

      const identifiers = ['grounding'];
      const grounded = await groundMissionInCodebase('grounding 분리', {
        cwd,
        searchTerms: async () => identifiers,
        persistent: {
          runGoalLoop: async (ctx) => {
            await ctx.dispatchTool('Read', { file_path: 'src/grounding-candidate.ts' }, { callId: 'read', sessionId: ctx.sessionId, signal: ctx.signal });
            ctx.callbacks?.onToolCall?.({ id: 'done', name: 'update_goal', args: { status: 'complete', evidence: 'src/grounding-candidate.ts: verified' } });
            return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
          },
        },
        skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
      });
      expect(grounded.documentFacts).toEqual([documentPath]);
      expect(grounded.files).toEqual(['src/grounding-candidate.ts']);
      expect(grounded.context).toContain('구현 후보 (고칠 파일·재사용 스킬');
      expect(grounded.context).toContain('저장소 문서 참조 (배경 컨텍스트만 — 구현 후보·수정 대상 아님):');
      expect(grounded.context.indexOf('구현 후보')).toBeLessThan(grounded.context.indexOf('저장소 문서 참조'));
      expect(logs.find((log) => log.category === 'grounding.search' && log.event === 'doc-split')?.data)
        .toEqual({ code: 1, docs: 1 });
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('경로에 유일한 파일명 term은 강하게 적용하고 희소성 보정값을 관측한다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mission-codebase-gate-'));
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      mkdirSync(join(cwd, 'src', 'session'), { recursive: true });
      writeFileSync(join(cwd, 'src', 'session', 'common-fanout.ts'), 'common\n');
      writeFileSync(join(cwd, 'src', 'implementation.ts'), 'specific\n');
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['add', '.'], { cwd });

      expect(await searchCodebase(['common', 'specific'], 2, cwd)).toEqual([
        'src/session/common-fanout.ts',
        'src/implementation.ts',
      ]);
      expect(logs).toContainEqual({
        category: 'grounding.search', event: 'name-signal',
        data: { term: 'common', file: 'src/session/common-fanout.ts', common: false, pathMatches: 1, weight: 25 },
      });
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('흔한 경로 조각은 감쇠되어 내용 일치 정답을 밀어내지 않는다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mission-codebase-gate-'));
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      mkdirSync(join(cwd, 'src', 'cli'), { recursive: true });
      mkdirSync(join(cwd, 'scripts'), { recursive: true });
      writeFileSync(join(cwd, 'scripts', 'placeholder.ts'), 'placeholder\n');
      for (let i = 0; i < 100; i += 1) writeFileSync(join(cwd, 'src', `index-${i}.ts`), 'index\n');
      writeFileSync(join(cwd, 'src', 'index.ts'), 'help\n'.repeat(20));
      writeFileSync(join(cwd, 'src', 'cli', 'logs-cli.ts'), 'index\nindex\nindex\nindex\nindex\nindex\nindex\nindex\nindex\nindex\n');
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['add', '.'], { cwd });

      expect(await searchCodebase(['index', 'help'], 2, cwd)).toEqual([
        'src/index.ts',
        'src/cli/logs-cli.ts',
      ]);
      expect(logs).toContainEqual({
        category: 'grounding.search', event: 'name-signal',
        data: { term: 'index', file: 'src/index.ts', common: false, pathMatches: 101, weight: 2 },
      });
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('tooCommon term은 후보와 파일명 히트에 남기고 coverage 가중에서만 제외', async () => {
    // 실제 저장소 대신 고정 fixture — 실제 저장소 searchCodebase 7회는 단독 2.66s(TF #9714 실측)로 bun
    // 기본 5s 한도의 절반을 쓰고 부하에서 넘쳤다. fixture 는 tooCommon 역치(commonCount > 200·src+docs+scripts
    // 파일 수)와 랭킹을 결정론으로 재현한다. 명시 30s 한도는 부하 변동에 대한 두번째 방어선이다.
    const cwd = mkdtempSync(join(tmpdir(), 'too-common-fixture-'));
    const logs: { category: string; event: string; data: unknown }[] = [];
    const restoreDebugLog = swapDebugLog(logs);
    try {
      mkdirSync(join(cwd, 'src', 'session'), { recursive: true });
      mkdirSync(join(cwd, 'src', 'gen'), { recursive: true });
      // 생성 파일은 파일명에 term 을 안 넣는다 — name-signal 이 대상 파일 하나에만 걸리게(pathMatches=1 → weight 25).
      writeFileSync(join(cwd, 'src', 'session', 'session-fanout.ts'), 'fanout\n'.repeat(20));
      for (let i = 0; i < 220; i += 1) writeFileSync(join(cwd, 'src', 'gen', `gen-${String(i).padStart(3, '0')}.ts`), 'fanout\n');
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['add', '.'], { cwd });

      for (let i = 0; i < 7; i += 1) {
        const files = await searchCodebase(['fanout'], 80, cwd);
        expect(files).toContain('src/session/session-fanout.ts');
        expect(files[0]).toBe('src/session/session-fanout.ts');
        expect(files.every((f) => !f.includes('.test.'))).toBe(true);
      }
      const event = logs.find((log) => log.category === 'grounding.search' && log.event === 'term-too-common');
      expect(event?.data).toEqual({ term: 'fanout', files: expect.any(Number), keptInCandidates: true });
      const nameSignals = logs.filter((log) => log.category === 'grounding.search' && log.event === 'name-signal' &&
        log.data && typeof log.data === 'object' &&
        (log.data as { term?: string; file?: string; common?: boolean }).term === 'fanout' &&
        (log.data as { term?: string; file?: string; common?: boolean }).file === 'src/session/session-fanout.ts' &&
        (log.data as { term?: string; file?: string; common?: boolean }).common === true);
      expect(nameSignals).toHaveLength(7);
    } finally {
      // 복원은 CAS + epoch 가드(swapDebugLog) — 타임아웃으로 버려진 본문이 다음 시험 도중 재개되면
      // afterEach 가 이미 epoch 를 올렸으므로 successor 의 override 를 덮지 않는다(연쇄 차단).
      restoreDebugLog();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test('버려진 tooCommon 본문의 늦은 finally가 cwd seam corpus 수집 도중 재개되어도 다음 시험은 corpus 로그를 실제로 받는다', async () => {
    // 타임아웃이 남기는 «버려진 본문»(교체를 설치한 채 pend → 경계 통과 → 다음 시험 도중 재개)을
    // 결정론으로 재현한다 — 실 bun 타임아웃을 쓰면 5s 지연 + 시험 실패 오염이 생긴다. 상태만 실측
    // 메커니즘과 동일하게: 같은 swapDebugLog 경계로 교체 설치 → gate 로 pend → afterEach 복원·epoch 상승 →
    // cwd seam 관측 중 release.
    const cwd = mkdtempSync(join(tmpdir(), 'root-seam-'));
    let releaseAbandoned: () => void = () => {};
    const abandonedGate = new Promise<void>((resolve) => { releaseAbandoned = resolve; });
    const abandonedLogs: { category: string; event: string; data: unknown }[] = [];
    const seq: string[] = [];
    let abandonedFinallyRan = false;
    const abandonedBody = (async () => {
      const restoreDebugLog = swapDebugLog(abandonedLogs);
      try {
        await abandonedGate; // 타임아웃이 남기는 pend 상태
      } finally {
        restoreDebugLog(); // 늦은 finally — 경계를 이미 지났다
        abandonedFinallyRan = true;
        seq.push('abandoned-finally');
      }
    })();
    // afterEach 경계 — 타임아웃 직후·다음 시험 전에 반드시 도는 복원 + epoch 상승.
    (debug as { log: typeof debug.log }).log = pristineDebugLog;
    debugLogEpoch += 1;
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src', 'root-seam.ts'), 'export const rootSeamNeedle = true; // root-seam\n');
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['add', '.'], { cwd });
      // 다음 시험: cwd seam — caller cwd 로 corpus 로그를 수집한다.
      const seamLogs: { category: string; event: string; data: unknown }[] = [];
      const restoreSeam = swapDebugLog(seamLogs, (category, event) => {
        if (category === 'mission.grounding' && event === 'corpus') seq.push('seam-corpus');
      });
      const seam = groundMissionInCodebase('root seam', {
        cwd, searchTerms: async () => ['root-seam'], persistent: false,
        skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
      });
      releaseAbandoned(); // 늦은 재개 — seam 의 corpus 수집(git 자식프로세스 await) 도중에 실행된다.
      const grounded = await seam;
      // 늦은 finally 는 seam 수집 «도중»(corpus 수신 이전)에 실행됐고, seam 은 corpus 로그를 실제로 받았다.
      expect(seq).toEqual(['abandoned-finally', 'seam-corpus']);
      expect(abandonedFinallyRan).toBe(true);
      expect(seamLogs.find((log) => log.category === 'mission.grounding' && log.event === 'corpus')?.data)
        .toMatchObject({ cwd, cwdSource: 'caller' });
      expect(grounded.files).toContain('src/root-seam.ts');
      restoreSeam();
    } finally {
      (debug as { log: typeof debug.log }).log = pristineDebugLog;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('groundMissionInSkills — skill 인덱스 grounding(P1)', () => {
  const index: SkillIndexEntry[] = [
    fakeSkill({ name: 'yt-vault', description: 'YouTube 지식 창고 — 지식 흡수(absorb), 채널 다이제스트', skillDir: '/skills/yt-vault' }),
    fakeSkill({ name: 'omni-digest', description: '통합 콘텐츠 요약 — YouTube·웹·GitHub 요약, obsidian 저장', skillDir: '/skills/omni-digest' }),
    fakeSkill({ name: 'kr-flow', description: '한국 시장 투자자 수급 — 외국인/기관 순매수', skillDir: '/skills/kr-flow' }),
  ];
  const idx = () => index;
  const nullPick: SkillPickFn = async () => null;

  test('★ fallback term coverage — "absorb·youtube" 키워드가 yt-vault SKILL.md 로 grounding', async () => {
    const r = await groundMissionInSkills(['absorb', 'youtube', 'obsidian'], '컨텐츠 흡수 기능', { skillIndex: idx, pickSkills: nullPick });
    expect(r.files).toContain('/skills/yt-vault/SKILL.md');
    expect(r.lines.some((l) => l.includes('[skill:yt-vault]'))).toBe(true);
    expect(r.facts.some((f) => f.startsWith('[skill:yt-vault]') && f.includes('흡수'))).toBe(true);
  });

  test('★ fallback 골이 skill 명 직접 언급 → 강신호(named)', async () => {
    const r = await groundMissionInSkills([], 'omni-digest 로 이 URL 정리해줘', { skillIndex: idx, pickSkills: nullPick });
    expect(r.files).toContain('/skills/omni-digest/SKILL.md');
  });

  test('fallback 무관 골 → 매칭 없음(오탐 방지)', async () => {
    const r = await groundMissionInSkills(['grpc', 'kafka'], '메시지 큐 재시도 로직 구현', { skillIndex: idx, pickSkills: nullPick });
    expect(r.files).toEqual([]);
  });

  test('빈 인덱스 → 빈 결과(fail-soft)', async () => {
    expect((await groundMissionInSkills(['absorb'], 'x', { skillIndex: () => [], pickSkills: nullPick })).files).toEqual([]);
  });

  test('fallback 단일 term 1개만 겹침 → 임계 미달(무관 skill 배제)', async () => {
    const r = await groundMissionInSkills(['수급'], '뭔가', { skillIndex: idx, pickSkills: nullPick });
    expect(r.files).toEqual([]);
  });

  test('★ luna 의미매칭 — pickSkills 결과를 closed set 으로', async () => {
    const pick: SkillPickFn = async () => ['yt-vault', 'nonexistent-skill'];
    const r = await groundMissionInSkills([], '유튜브 흡수', { skillIndex: idx, pickSkills: pick });
    expect(r.files).toEqual(['/skills/yt-vault/SKILL.md']);
    expect(r.facts.some((f) => f.startsWith('[skill:yt-vault]'))).toBe(true);
  });

  test('★ luna NONE → 빈 결과(fallback 안 탐)', async () => {
    const pick: SkillPickFn = async () => [];
    const r = await groundMissionInSkills(['absorb', 'youtube'], '컨텐츠 흡수', { skillIndex: idx, pickSkills: pick });
    expect(r.files).toEqual([]);
  });
});

describe('groundMissionInMemory — 기억·자기이력·문서벡터 grounding(P2)', () => {
  test('★ 선언기억 + 자기이력/문서 팩트를 합쳐 반환(prefix 보존)', async () => {
    const r = await groundMissionInMemory('세션 패브릭 회고', {
      recallMemory: () => ['[memory:project] 세션 패브릭 아크: 영속바인딩·포크·attach·resume 완주'],
      recallSelf: async () => ['[self:impl] runGoalLoop 증거게이트 배선', '[doc] HANDOFF-session-fabric 요약'],
    });
    expect(r.facts).toContain('[memory:project] 세션 패브릭 아크: 영속바인딩·포크·attach·resume 완주');
    expect(r.facts.some((f) => f.startsWith('[self:impl]'))).toBe(true);
    expect(r.facts.some((f) => f.startsWith('[doc]'))).toBe(true);
  });

  test('fail-soft — seam throw 해도 다른 축은 살고 전체는 안 죽음', async () => {
    const r = await groundMissionInMemory('x', {
      recallMemory: () => { throw new Error('store down'); },
      recallSelf: async () => ['[self:autonomy] 자율루프 실행'],
    });
    expect(r.facts).toEqual(['[self:autonomy] 자율루프 실행']);
  });

  test('둘 다 빈 결과 → 빈 facts', async () => {
    const r = await groundMissionInMemory('무관', { recallMemory: () => [], recallSelf: async () => [] });
    expect(r.facts).toEqual([]);
  });
});

describe('groundMissionInCodebase — cwd seam', () => {
  test('호출자가 준 cwd를 persistent·문서 검색·corpus 관측에 함께 고정한다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mission-codebase-root-'));
    const logs: { category: string; event: string; data: unknown }[] = [];
    const persistentReads: string[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      mkdirSync(join(cwd, 'docs'), { recursive: true });
      writeFileSync(join(cwd, 'src', 'root-seam.ts'), 'export const rootSeam = true;\n');
      writeFileSync(join(cwd, 'docs', 'root-seam.md'), 'needle-root-seam\n');
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['add', '.'], { cwd });
      const grounded = await groundMissionInCodebase('root seam', {
        cwd, searchTerms: async () => ['needle-root-seam'],
        persistent: {
          dispatchTool: async (name, args) => {
            if (name === 'Read') persistentReads.push(String((args as { file_path: string }).file_path));
            return { output: 'ok', linesRead: 1, totalLines: 1, totalBytes: 3, truncated: false, kind: 'text' as const };
          },
          runGoalLoop: async (ctx) => {
            await ctx.dispatchTool('Read', { file_path: 'src/root-seam.ts' }, { callId: 'read', sessionId: ctx.sessionId, signal: ctx.signal });
            ctx.callbacks?.onToolCall?.({ id: 'done', name: 'update_goal', args: { status: 'complete', evidence: 'src/root-seam.ts: verified' } });
            return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
          },
        },
        skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
      });
      expect(grounded.files).toContain('src/root-seam.ts');
      expect(grounded.documentFacts).toEqual(['docs/root-seam.md']);
      expect(persistentReads).toEqual([realpathSync(join(cwd, 'src', 'root-seam.ts'))]);
      expect(logs.find((log) => log.category === 'mission.grounding' && log.event === 'corpus')?.data)
        .toMatchObject({ cwd, cwdSource: 'caller' });
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('disabled 코드 채널의 빈 후보를 추적된 searchCodebase 결과로 채운다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mission-codebase-fallback-'));
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src', 'fallback-candidate.ts'), 'export const fallbackNeedle = true;\n');
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['add', '.'], { cwd });

      const grounded = await groundMissionInCodebase('fallback candidate', {
        cwd, persistent: false, searchTerms: async () => ['fallbackNeedle'],
        skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
      });

      expect(grounded.codeChannel).toBe('disabled');
      expect(grounded.files).toEqual(['src/fallback-candidate.ts']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('persistent 코드 후보가 있으면 searchCodebase 폴백으로 덮어쓰지 않는다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mission-codebase-persistent-priority-'));
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src', 'persistent-candidate.ts'), 'export const persistentCandidate = true;\n');
      writeFileSync(join(cwd, 'src', 'search-only-candidate.ts'), 'export const searchNeedle = true;\n');
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['add', '.'], { cwd });

      const grounded = await groundMissionInCodebase('persistent priority', {
        cwd, searchTerms: async () => ['searchNeedle'],
        persistent: {
          runGoalLoop: async (ctx) => {
            await ctx.dispatchTool('Read', { file_path: 'src/persistent-candidate.ts' }, { callId: 'read', sessionId: ctx.sessionId, signal: ctx.signal });
            ctx.callbacks?.onToolCall?.({ id: 'done', name: 'update_goal', args: { status: 'complete', evidence: 'src/persistent-candidate.ts: verified' } });
            return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
          },
        },
        skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
      });

      expect(grounded.codeChannel).toBe('ok');
      expect(grounded.files).toEqual(['src/persistent-candidate.ts']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('cwd를 생략하면 process cwd와 process 출처를 계속 쓰고 실제 검색 경로는 형태를 반환한다', async () => {
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const grounded = await groundMissionInCodebase('self author', {
        searchTerms: async () => ['goal-author'], persistent: false,
        skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
      });
      expect(Array.isArray(grounded.documentFacts)).toBe(true);
      expect(grounded.documentFacts.every((fact) => typeof fact === 'string')).toBe(true);
      expect(logs.find((log) => log.category === 'mission.grounding' && log.event === 'corpus')?.data)
        .toMatchObject({ cwd: process.cwd(), cwdSource: 'process' });
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
    }
  }, 30_000);

  test('corpus 관측은 persistent 부재·빈 완료 증거·미완 채널을 서로 다른 스칼라로 남긴다', async () => {
    const logs: { category: string; event: string; data: unknown }[] = [];
    const quietDeps = {
      searchTerms: async () => ['qxjvplmno'],
      skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
    };
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      await groundMissionInCodebase('no persistent channel', { ...quietDeps, persistent: false });
      await groundMissionInCodebase('completed empty evidence', {
        ...quietDeps,
        persistent: { runGoalLoop: async () => ({ finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true }) },
      });
      await groundMissionInCodebase('incomplete persistent channel', {
        ...quietDeps,
        persistent: { runGoalLoop: async () => ({ finalText: '', iterations: 1, stopReason: 'end_turn', goalComplete: false }) },
      });

      const corpus = logs.filter((log) => log.category === 'mission.grounding' && log.event === 'corpus');
      expect(corpus.map((log) => {
        const data = log.data as Record<string, unknown>;
        return {
          persistentEvidence: data.persistentEvidence,
          persistentStopReason: data.persistentStopReason,
          codeChannel: data.codeChannel,
        };
      })).toEqual([
        { persistentEvidence: null, persistentStopReason: null, codeChannel: 'disabled' },
        { persistentEvidence: 0, persistentStopReason: 'goal_complete', codeChannel: 'ok' },
        { persistentEvidence: 0, persistentStopReason: 'end_turn', codeChannel: 'incomplete' },
      ]);
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
    }
  }, 30_000);

  test('corpus 관측은 예외 경로에도 unavailable persistent 스칼라를 남긴다', async () => {
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      await groundMissionInCodebase('persistent setup error', {
        searchTerms: async () => { throw new Error('persistent-observation-error'); },
      });

      const data = logs.find((log) => log.category === 'mission.grounding' && log.event === 'corpus')?.data as Record<string, unknown>;
      expect(data).toMatchObject({
        grounded: false,
        reason: 'error',
        persistentEvidence: null,
        persistentStopReason: null,
        codeChannel: 'failed',
      });
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
    }
  });

  test('timing 관측은 지연 후 실패한 searchTerms·corpus의 실제 경과를 남기며 fail-soft를 유지한다', async () => {
    const logs: { category: string; event: string; data: unknown }[] = [];
    const delayMs = 20;
    const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const searchTermsFailure = await groundMissionInCodebase('delayed search terms failure', {
        searchTerms: async () => { await sleep(); throw new Error('delayed-search-terms-failure'); },
      });
      expect(searchTermsFailure.grounded).toBe(false);

      const corpusFailure = await groundMissionInCodebase('delayed corpus failure', {
        searchTerms: async () => ['qxjvplmno'],
        persistent: false,
        skillIndex: () => [fakeSkill({ name: 'delayed-skill', skillDir: '/tmp/delayed-skill', description: 'fixture' })],
        pickSkills: async () => { await sleep(); throw new Error('delayed-corpus-failure'); },
        recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
      });
      expect(corpusFailure.grounded).toBe(false);

      const timings = logs
        .filter((log) => log.category === 'mission.grounding' && log.event === 'timing')
        .map((log) => log.data as Record<string, unknown>);
      expect(timings).toHaveLength(2);
      for (const timing of timings) {
        for (const field of ['totalElapsedMs', 'searchTermsElapsedMs', 'persistentElapsedMs', 'corpusElapsedMs', 'renderingElapsedMs']) {
          expect(timing[field]).toEqual(expect.any(Number));
          expect(timing[field] as number).toBeGreaterThanOrEqual(0);
        }
      }
      expect(timings[0]!.searchTermsElapsedMs as number).toBeGreaterThanOrEqual(delayMs - 5);
      expect(timings[1]!.corpusElapsedMs as number).toBeGreaterThanOrEqual(delayMs - 5);
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
    }
  }, 30_000);
});

describe('groundMissionInCodebase — 로컬 ref grounding(F1)', () => {
  const quietDeps = {
    searchTerms: async () => [],
    persistent: false as const,
    skillIndex: () => [],
    recallMemory: () => [],
    recallSelf: async () => [],
  };

  test('refDigest seam의 local reference를 [ref:name] 팩트로 생산하고 repo files와 분리', async () => {
    const r = await groundMissionInCodebase('lazycodex 하니스 분석', {
      ...quietDeps,
      refDigest: () => '참조 소스 로컬 canonical:\n- /tmp/source/ref/lazycodex',
    });
    expect(r.grounded).toBe(true);
    expect(r.refFacts).toEqual(['[ref:lazycodex] /tmp/source/ref/lazycodex']);
    expect(r.files).toEqual([]);
  });

  test('refDigest 실패은 fail-soft로 빈 refFacts이며 다른 grounding을 막지 않음', async () => {
    const r = await groundMissionInCodebase('fixture', {
      ...quietDeps,
      refDigest: () => { throw new Error('reference root unavailable'); },
    });
    expect(r.grounded).toBe(false);
    expect(r.refFacts).toEqual([]);
  });
});

describe('extractExportedSymbols — 코드 export 심볼 추출(L4)', () => {
  test('★ 실 파일의 export 함수/타입 심볼 추출(self)', () => {
    const syms = extractExportedSymbols('src/autopilot/mission-codebase-gate.ts', 100);
    expect(syms).toContain('searchCodebase');
    expect(syms).toContain('groundMissionInCodebase');
    expect(syms).toContain('extractExportedSymbols');
    expect(syms).toContain('CodebaseGrounding');
  });
  test('없는 파일 → [](fail-soft)', () => {
    expect(extractExportedSymbols('src/does-not-exist-xyz.ts')).toEqual([]);
  });
  test('max 상한 존중', () => {
    expect(extractExportedSymbols('src/autopilot/mission-codebase-gate.ts', 2).length).toBeLessThanOrEqual(2);
  });
});

describe('refFactsFromDigest — F2 참조 이유 보존(2026-07-22)', () => {
  test('- /path 아래 참조 이유 줄을 fact 에 부착', () => {
    const digest = [
      '참조 소스 로컬 canonical (…):',
      '- /Users/example/source/ref/dnd-kit',
      '  카테고리: DnD',
      '  경로: `dnd-kit/`',
      '  참조 이유: 드래그앤드롭 라이브러리 참조',
    ].join('\n');
    const facts = refFactsFromDigest(digest);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toBe('[ref:dnd-kit] /Users/example/source/ref/dnd-kit — 드래그앤드롭 라이브러리 참조');
  });

  test('메타 없는 - /path 는 경로만(무회귀)', () => {
    const facts = refFactsFromDigest('- /Users/example/source/ref/textual');
    expect(facts).toEqual(['[ref:textual] /Users/example/source/ref/textual']);
  });

  test('중복 repo 이름 1회만', () => {
    const digest = '- /a/dnd-kit\n- /b/dnd-kit';
    expect(refFactsFromDigest(digest)).toHaveLength(1);
  });

  test('이유는 직후 repo 에만 1회 부착(다음 repo 로 안 샘)', () => {
    const digest = [
      '- /ref/a',
      '  참조 이유: A 이유',
      '- /ref/b',
    ].join('\n');
    const facts = refFactsFromDigest(digest);
    expect(facts[0]).toContain('A 이유');
    expect(facts[1]).toBe('[ref:b] /ref/b');
  });
});

describe('groundMissionInCapsules — F2 검색-코퍼스(상류 capsule → grounding)', () => {
  function cap(over: Partial<HarnessContextCapsule>): { id: string; capsule: HarnessContextCapsule } {
    return {
      id: (over.objective ?? 'j').slice(0, 6),
      capsule: buildHarnessContextCapsule({
        objective: 'obj', target: 'self', inScope: [], outOfScope: [], successCriteria: [],
        evidenceRequired: [], riskBoundaries: [], groundingRefs: [], createdAt: '2026-07-25T00:00:00.000Z', ...over,
      }),
    };
  }

  test('관련도 필터 — 관련 capsule 포함·무관 제외(오염 방지)', async () => {
    const caps = [
      cap({ objective: 'URL 라우터 파이프라인 구현', successCriteria: ['라우팅 통과'] }),
      cap({ objective: '전혀 무관한 김치 레시피 정리', successCriteria: [] }),
    ];
    const { facts } = await groundMissionInCapsules('URL 라우터 배선', { listCapsules: () => caps });
    expect(facts.some((f) => f.includes('URL 라우터 파이프라인'))).toBe(true);
    expect(facts.some((f) => f.includes('김치'))).toBe(false);
  });

  test('최근성 정렬 + limit — 동점은 createdAt desc·상위 N', async () => {
    const caps = [
      cap({ objective: 'auth 로그인 토큰', createdAt: '2026-07-25T01:00:00.000Z' }),
      cap({ objective: 'auth 로그인 세션', createdAt: '2026-07-25T03:00:00.000Z' }),
      cap({ objective: 'auth 로그인 리프레시', createdAt: '2026-07-25T02:00:00.000Z' }),
    ];
    const { facts } = await groundMissionInCapsules('auth 로그인', { listCapsules: () => caps }, 2);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toContain('세션');
  });

  test('capsule 없음/전부 무관 → 빈 팩트(fail-soft)', async () => {
    expect((await groundMissionInCapsules('X', { listCapsules: () => [] })).facts).toEqual([]);
    expect((await groundMissionInCapsules('완전무관골', { listCapsules: () => [cap({ objective: 'zzz yyy' })] })).facts).toEqual([]);
  });

  test('MF2 — 무관 신규 다수 뒤에서도 오래된 관련 capsule 발견(관련도 선-필터·recency 선-truncate 금지)', async () => {
    const caps = [
      cap({ objective: 'auth 로그인 세션 리프레시', createdAt: '2020-01-01T00:00:00.000Z' }),
      ...Array.from({ length: 60 }, (_, i) => cap({ objective: `무관작업${i} zzz yyy`, createdAt: '2026-07-25T12:00:00.000Z' })),
    ];
    const { facts } = await groundMissionInCapsules('auth 로그인', { listCapsules: () => caps });
    expect(facts.some((f) => f.includes('auth 로그인 세션'))).toBe(true);
  });
});

const SKILL_FIXTURE: SkillIndexEntry = fakeSkill({
  name: 'elanous-logs', skillDir: '/tmp/.claude/skills/elanous-logs', description: '로그 조회',
});

describe('isRepositoryImplementationCandidate — 스킬 문서 판별은 대소문자를 가리지 않는다', () => {
  test('SKILL.md · SKILL.MD · skill.md · Skill.Md 전부 구현 후보가 아니다', () => {
    for (const p of ['/x/.claude/skills/a/SKILL.md', '/x/.claude/skills/a/SKILL.MD',
                     '/x/.claude/skills/a/skill.md', '/x/.claude/skills/a/Skill.Md']) {
      expect(isRepositoryImplementationCandidate(p)).toBe(false);
    }
  });

  test('스킬 디렉터리 밖의 md 는 여전히 구현 후보다 (과잉 제외 금지)', () => {
    expect(isRepositoryImplementationCandidate('src/notskill.md')).toBe(true);
    expect(isRepositoryImplementationCandidate('docs/skill.md')).toBe(true);
  });

  test('디렉터리 대소문자는 가린다 — .CLAUDE/SKILLS 는 정책 밖이다', () => {
    expect(isRepositoryImplementationCandidate('/x/.CLAUDE/skills/a/SKILL.md')).toBe(true);
    expect(isRepositoryImplementationCandidate('/x/.claude/SKILLS/a/SKILL.md')).toBe(true);
    expect(isRepositoryImplementationCandidate('/x/.claude/skills/a/SKILL.md')).toBe(false);
  });
});

describe('groundMissionInCodebase — 스킬 계약만 있는 코퍼스도 grounded 다', () => {
  test('⭐ 코드 후보 0 · 스킬 팩트 1 이면 grounded=true 이고 skillFacts 가 보존된다', async () => {
    const grounded = await groundMissionInCodebase('스킬 능력만 가리키는 골', {
      searchTerms: async () => ['qxjvplmno'],
      persistent: false,
      skillIndex: () => [SKILL_FIXTURE],
      pickSkills: async () => [SKILL_FIXTURE.name],
      recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
    });
    expect(grounded.files).toEqual([]);
    expect(grounded.refFacts).toEqual([]);
    expect(grounded.skillFacts.length).toBeGreaterThan(0);
    expect(grounded.grounded).toBe(true);
  });

  test('⭐ 스킬 팩트만 있어도 grounded 다 (그 채널을 빼면 깨진다)', () => {
    const empty = { files: [], documentFacts: [], skillFacts: [], memoryFacts: [], refFacts: [], ptyFacts: [] };
    expect(isCorpusGrounded(empty)).toBe(false);
    expect(isCorpusGrounded({ ...empty, skillFacts: ['[skill:x] y'] })).toBe(true);
  });

  test('여섯 채널 각각이 단독으로 grounded 를 만든다', () => {
    const empty = { files: [], documentFacts: [], skillFacts: [], memoryFacts: [], refFacts: [], ptyFacts: [] };
    for (const key of ['files', 'documentFacts', 'skillFacts', 'memoryFacts', 'refFacts', 'ptyFacts'] as const) {
      expect(isCorpusGrounded({ ...empty, [key]: ['x'] })).toBe(true);
    }
  });
});

describe('groundMissionInCodebase — 실행 시간 관측', () => {
  test('전체와 실제 비동기 구간별 비음수 밀리초를 mission.grounding timing으로 남긴다', async () => {
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      await groundMissionInCodebase('timing observation fixture', {
        searchTerms: async () => [],
        persistent: false,
        skillIndex: () => [],
        recallMemory: () => [],
        recallSelf: async () => [],
        refDigest: () => '- /tmp/source/ref/timing-fixture',
      });

      const timing = logs.find((log) => log.category === 'mission.grounding' && log.event === 'timing')?.data as Record<string, unknown> | undefined;
      expect(timing).toBeDefined();
      for (const key of ['totalElapsedMs', 'searchTermsElapsedMs', 'persistentElapsedMs', 'corpusElapsedMs', 'renderingElapsedMs']) {
        expect(typeof timing?.[key]).toBe('number');
        expect(Number.isFinite(timing?.[key])).toBe(true);
        expect(timing?.[key] as number).toBeGreaterThanOrEqual(0);
      }
    } finally {
      // afterEach owns restoration, even when a timed-out body resumes late.
    }
  });
});

describe('searchCodebase — term grep 동시 실행 상한', () => {
  const TERMS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
  const TRACKED = ['src/core.ts', 'src/alpha-router.ts', 'scripts/alpha-task.ts', 'docs/alpha.md'];
  const PRIMARY_ROWS: Record<string, string[]> = {
    alpha: ['src/core.ts:4', 'src/alpha-router.ts:2'],
    beta: ['src/core.ts:3'],
    gamma: ['src/core.ts:2', 'src/alpha-router.ts:1'],
    delta: ['src/core.ts:1'],
    epsilon: ['src/core.ts:2'],
    zeta: ['src/core.ts:1'],
    eta: ['src/core.ts:1'],
    theta: ['src/core.ts:1'],
  };
  const COMMON_ROWS: Record<string, string[]> = {
    ...PRIMARY_ROWS,
    alpha: [...PRIMARY_ROWS.alpha!, 'scripts/alpha-task.ts:2', 'docs/alpha.md:3'],
  };

  afterEach(() => {
    setExecFileForTest(null);
    setTermGrepConcurrencyForTest(null);
  });

  /** primary 경로 목록(src·scripts) 호출인가 — 공통 경로 호출은 docs 를 포함한다. */
  function primaryShape(args: readonly string[]): boolean {
    return !args.includes('docs');
  }

  /** 가짜 execFile — 실제 git 을 띄우지 않고 term 별 git grep 동시 실행 수·호출 인자를 잰다. */
  function fakeExecFile(delayMs: number) {
    const state = { active: 0, maxActive: 0, greps: [] as string[][] };
    const impl: ExecFileLike = async (_file, args) => {
      if (args[0] === 'ls-files') return { stdout: `${TRACKED.join('\n')}\n` };
      state.greps.push([...args]);
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const term = args[args.indexOf('-e') + 1] ?? '';
        const rows = primaryShape(args) ? PRIMARY_ROWS[term] ?? [] : COMMON_ROWS[term] ?? [];
        return { stdout: rows.join('\n') };
      } finally {
        state.active -= 1;
      }
    };
    return { impl, state };
  }

  test('키워드 8개(중복 1개) → git grep 동시 실행 최대 3 · 중복 키워드는 1회만 실행', async () => {
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    const { impl, state } = fakeExecFile(5);
    setExecFileForTest(impl);

    const terms = [...TERMS.slice(0, 7), 'alpha'];
    const files = await searchCodebase(terms, 12, '/tmp/term-grep-pool-fixture');

    expect(files[0]).toBe('src/core.ts');
    expect(state.maxActive).toBeLessThanOrEqual(3);
    expect(state.maxActive).toBeGreaterThan(1);
    expect(state.greps.filter((args) => args.includes('alpha') && primaryShape(args))).toHaveLength(1);
    expect(state.greps.filter((args) => args.includes('alpha') && !primaryShape(args))).toHaveLength(1);

    const batch = logs.find((log) => log.category === 'grounding.search' && log.event === 'term-grep-batch')?.data as Record<string, unknown> | undefined;
    expect(batch).toBeDefined();
    expect(batch?.terms).toBe(7);
    expect(batch?.concurrency).toBe(3);
    expect(typeof batch?.ms).toBe('number');
  });

  test('상한 3 과 상한 없음의 결과 파일·순위는 바이트 동일하다', async () => {
    const capped = fakeExecFile(3);
    setExecFileForTest(capped.impl);
    const withCap = await searchCodebase(TERMS, 12, '/tmp/term-grep-pool-fixture');

    const uncapped = fakeExecFile(3);
    setExecFileForTest(uncapped.impl);
    setTermGrepConcurrencyForTest(Number.POSITIVE_INFINITY);
    const withoutCap = await searchCodebase(TERMS, 12, '/tmp/term-grep-pool-fixture');

    expect(withoutCap).toEqual(withCap);
    expect(withCap.slice(0, 2)).toEqual(['src/core.ts', 'src/alpha-router.ts']);
    expect(capped.state.maxActive).toBeLessThanOrEqual(3);
    expect(uncapped.state.maxActive).toBe(8);
  });
});

// ⛔ #29343 r3 리뷰 FAIL 지적 소유 — «타임아웃으로 버려진 본문이 옮긴 cwd» 가 다음 런의 seam 을 오염시킨다.
// 무대 = src/ux-sim/goal-device(부하≥50 표본 주입 · 타임아웃 시뮬레이션 · cwd seam 관측). 판정은 생산 진입
// (groundMissionInCodebase)을 그대로 지나는 값으로만 한다 — 소스 문자열을 보지 않는다.
describe('MISSION-CODEBASE-GATE-FLAKY-FU — cwd seam 소유권', () => {
  test('MISSION-CODEBASE-GATE-FLAKY-FU: 타임아웃 뒤 cwd-seam 복원', async () => {
    const logs: { category: string; event: string; data?: unknown }[] = [];
    const restoreDebugLog = swapDebugLog(logs);
    const entryCwd = process.cwd();
    try {
      const observed = await driveTimeoutCwdSeam({ loadSamples: GOAL_DEVICE_LOAD_SAMPLES, timeoutMs: 20 });

      // 무대가 실제로 돌았다 — 부하 표본이 켜졌고, 타임아웃 의존성이 마감을 넘겼다.
      expect(observed.timedOutDependencyRan).toBe(true);
      expect(observed.loadSamples).toBe(50);
      expect(observed.peakLoadSamples).toBeGreaterThanOrEqual(50);
      expect(observed.loadSlices).toBeGreaterThan(0);
      // «시작만 한» 표본이 아니라 생산 런이 진행 중인 구간에 실제로 일한 표본이 50 이다.
      expect(observed.loadSamplesWorkedDuringWindow).toBeGreaterThanOrEqual(50);

      // ① 타임아웃(throw) 경로에서도 런이 자기 cwd 를 되돌린다 — 이 칸의 판정선.
      expect(observed.afterTimeoutCwd).toBe(entryCwd);
      expect(observed.restored).toBe(true);

      // ② 다음 런의 seam 은 오염된 임시 트리가 아니라 시작 자리를 읽는다.
      expect(observed.successorCwd).toBe(entryCwd);
      expect(observed.successorFiles).toContain('src/goal-seam.ts');

      // ③ 원장 형식은 그대로다 — 타임아웃 런은 기존 스칼라(reason=error·codeChannel=failed),
      //    다음 런은 caller 가 아닌 process 출처로 시작 자리를 관측한다.
      const corpus = logs.filter((log) => log.category === 'mission.grounding' && log.event === 'corpus');
      expect(corpus).toHaveLength(2);
      expect(corpus[0]!.data).toMatchObject({ grounded: false, reason: 'error', codeChannel: 'failed' });
      expect(corpus[1]!.data).toMatchObject({ grounded: true, cwd: entryCwd, cwdSource: 'process' });
    } finally {
      restoreDebugLog();
      if (process.cwd() !== entryCwd) process.chdir(entryCwd);
    }
  }, 30_000);

  test('MISSION-CODEBASE-GATE-FLAKY-FU: 마감 뒤 재개된 본문이 옮긴 cwd 를 겹친 다음 런이 seam 으로 읽지 않는다', async () => {
    const entryCwd = process.cwd();
    try {
      const observed = await driveAbandonedTimeoutCwdSeam({ loadSamples: GOAL_DEVICE_LOAD_SAMPLES, timeoutMs: 10 });

      // 무대가 성립했다 — 호출자가 먼저 버렸고, 그 뒤 재개된 본문이 실제로 cwd 를 옮겼다.
      expect(observed.abandonedAtDeadline).toBe(true);
      expect(observed.lateMutationRan).toBe(true);
      expect(observed.cwdWhileAbandonedPending).not.toBe(entryCwd);
      expect(observed.peakLoadSamples).toBeGreaterThanOrEqual(50);
      expect(observed.loadSlices).toBeGreaterThan(0);
      expect(observed.loadSamplesWorkedDuringWindow).toBeGreaterThanOrEqual(50);

      // ① 겹친 다음 런의 seam(생산 검색이 git 에 넘긴 cwd)은 오염된 임시 트리가 아니라 시작 자리다.
      expect(observed.successorSeamRoots.length).toBeGreaterThan(0);
      expect(new Set(observed.successorSeamRoots)).toEqual(new Set([entryCwd]));
      expect(observed.successorFiles).toContain('src/goal-seam.ts');
      // ② 복원 보장의 «경계» — 버려진 본문이 끝나지 않은 동안 전역 cwd 는 옮겨진 채다(남의 본문 밑을 흔들지 않는다).
      //    그 사이 보장되는 것은 ① 의 seam 뿐이다.
      expect(observed.cwdAfterSuccessor).not.toBe(entryCwd);
      // ③ 버려진 런까지 끝나는 순간 마지막 holder 가 시작 자리로 되돌린다.
      expect(observed.afterAllSettledCwd).toBe(entryCwd);
      expect(observed.restored).toBe(true);
    } finally {
      if (process.cwd() !== entryCwd) process.chdir(entryCwd);
    }
  }, 30_000);

  test('MISSION-CODEBASE-GATE-FLAKY-FU: 지워진 process cwd 에서도 caller cwd 를 받은 런은 예외 없이 진행한다', async () => {
    const logs: { category: string; event: string; data?: unknown }[] = [];
    const restoreDebugLog = swapDebugLog(logs);
    const entryCwd = process.cwd();
    const gone = mkdtempSync(join(tmpdir(), 'mcg-cwd-gone-'));
    // caller root 는 빈 임시 트리 — 문서 채널의 실물 git 이 저장소 전체를 훑지 않게 한다(코드 채널은 장치 git 대역).
    const callerRoot = mkdtempSync(join(tmpdir(), 'mcg-cwd-caller-'));
    setExecFileForTest(goalDeviceExecFile());
    try {
      process.chdir(gone);
      rmSync(gone, { recursive: true, force: true });
      const result = await groundMissionInCodebase('deleted cwd caller root fixture', {
        cwd: callerRoot,
        searchTerms: async () => [GOAL_DEVICE_SEAM_TERM],
        persistent: false,
        skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
      });
      expect(result.files).toContain('src/goal-seam.ts');
      const corpus = logs.filter((log) => log.category === 'mission.grounding' && log.event === 'corpus');
      expect(corpus.at(-1)!.data).toMatchObject({ cwd: callerRoot, cwdSource: 'caller' });
      // 시작 자리를 못 읽은 런은 소유하지 않으므로 되돌리려 들지도, 실패를 남기지도 않는다.
      expect(logs.some((log) => log.event === 'cwd-restore-failed')).toBe(false);
    } finally {
      setExecFileForTest(null);
      restoreDebugLog();
      process.chdir(entryCwd);
      rmSync(gone, { recursive: true, force: true });
      rmSync(callerRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test('MISSION-CODEBASE-GATE-FLAKY-FU: 되돌리기 실패는 결과를 바꾸지 않되 cwd-restore-failed 로 관측된다', async () => {
    const logs: { category: string; event: string; data?: unknown }[] = [];
    const restoreDebugLog = swapDebugLog(logs);
    const entryCwd = process.cwd();
    const doomed = mkdtempSync(join(tmpdir(), 'mcg-cwd-doomed-'));
    const away = mkdtempSync(join(tmpdir(), 'mcg-cwd-away-'));
    try {
      process.chdir(doomed);
      const doomedRoot = process.cwd();
      const result = await groundMissionInCodebase('cwd restore failure fixture', {
        searchTerms: async () => {
          process.chdir(away);
          rmSync(doomed, { recursive: true, force: true });
          throw new Error('fixture: root removed');
        },
        persistent: false,
        skillIndex: () => [], pickSkills: async () => [], recallMemory: () => [], recallSelf: async () => [], refDigest: () => '',
      });
      expect(result.grounded).toBe(false);
      const failed = logs.filter((log) => log.category === 'mission.grounding' && log.event === 'cwd-restore-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.data).toMatchObject({ root: doomedRoot });
      // 관측(timing)은 복원 실패 뒤에도 빠지지 않는다.
      expect(logs.some((log) => log.category === 'mission.grounding' && log.event === 'timing')).toBe(true);
    } finally {
      restoreDebugLog();
      process.chdir(entryCwd);
      rmSync(doomed, { recursive: true, force: true });
      rmSync(away, { recursive: true, force: true });
    }
  }, 30_000);
});
