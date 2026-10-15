import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreTurnContext, GoalLoopResult } from '../../core-turn/index.js';
import { runGoalLoop } from '../../core-turn/index.js';
import { debug } from '../../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { findNativeTool } from '../../native-tool-catalog.js';
import {
  allowedEvidenceRoots,
  PERSISTENT_GROUNDING_MAX_ITERATIONS,
  PERSISTENT_GROUNDING_TOOL_NAMES,
  groundPersistently,
  normalizeRepositoryRelativePath,
  persistentGroundingTools,
} from './persistent-grounding.js';

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'elanous-grounding-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'candidate.ts'), 'export const candidate = true;\n');
  return root;
}

function worktreeWithRoots(roots: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'elanous-grounding-'));
  for (const dir of roots) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'candidate.ts'), 'export const candidate = true;\n');
  }
  return root;
}

async function complete(ctx: CoreTurnContext, evidence: string): Promise<GoalLoopResult> {
  ctx.callbacks?.onToolCall?.({ id: 'complete', name: 'update_goal', args: { status: 'complete', evidence } });
  return { stopReason: 'goal_complete', finalText: '', iterations: 1, goalComplete: true };
}

describe('persistent grounding', () => {
  test('카탈로그는 다섯 공용 읽기 도구만 광고하고 쓰기 도구를 거부한다', async () => {
    expect(PERSISTENT_GROUNDING_TOOL_NAMES).toEqual(['Grep', 'Glob', 'ListDir', 'AstGrep', 'Read']);
    expect(persistentGroundingTools({ hasAstGrep: () => true }).map((tool) => tool.name)).toEqual(['Grep', 'Glob', 'ListDir', 'AstGrep', 'Read']);
    for (const [id, displayName] of [['grep', 'Grep'], ['glob', 'Glob'], ['list_dir', 'ListDir'], ['ast_grep', 'AstGrep'], ['read', 'Read']] as const) {
      expect(findNativeTool(id)).toEqual(expect.objectContaining({ displayName, safety: expect.arrayContaining(['read-only']), promptSummary: expect.any(String) }));
    }
    const root = worktree();
    try {
      await groundPersistently('reject writer', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'reject', sessionId: ctx.sessionId, signal: ctx.signal };
          for (const name of ['Edit', 'Write', 'Bash', 'PtyShell']) {
            expect(await ctx.dispatchTool(name, {}, callCtx)).toEqual({ error: `persistent grounding refuses non-readonly tool: ${name}` });
          }
          return { finalText: '', iterations: 1, stopReason: 'max_iterations', goalComplete: false };
        },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('완료 증거 지시문은 실제 허용 루트 집합을 동적으로 모두 포함한다', async () => {
    const root = worktree();
    try {
      let instruction = '';
      await groundPersistently('inspect instruction', root, {
        runGoalLoop: async (ctx) => {
          instruction = String(ctx.messages[0]?.content);
          return { finalText: '', iterations: 1, stopReason: 'max_iterations', goalComplete: false };
        },
      });
      const roots = allowedEvidenceRoots();
      (roots as Set<string>).add('invented-root');
      expect(allowedEvidenceRoots().has('invented-root')).toBe(false);
      const includesAllAllowedRoots = (candidate: string) => Array.from(allowedEvidenceRoots()).every((root) => candidate.includes(`${root}/`));
      expect(includesAllAllowedRoots(instruction)).toBe(true);
      expect(includesAllAllowedRoots(`${instruction} invented-root/`)).toBe(true);
      const omittedRoot = Array.from(roots)[0]!;
      expect(includesAllAllowedRoots(instruction.replace(`${omittedRoot}/`, ''))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('공용 탐색→읽기→완료 경로가 실제로 호출되어 읽은 후보만 채택한다', async () => {
    const root = worktree();
    try {
      const result = await groundPersistently('find candidate', root, {
        hasAstGrep: () => false,
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'discover', sessionId: ctx.sessionId, signal: ctx.signal };
          expect((await ctx.dispatchTool('Grep', { pattern: 'candidate', output_mode: 'content' }, callCtx) as { output: string }).output).toContain('candidate.ts');
          expect((await ctx.dispatchTool('Glob', { pattern: 'src/*.ts' }, callCtx) as { output: string }).output).toContain('candidate.ts');
          expect((await ctx.dispatchTool('ListDir', { path: 'src' }, callCtx) as { output: string }).output).toContain('candidate.ts');
          expect((await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx) as { output: string }).output).toContain('candidate');
          return complete(ctx, 'src/candidate.ts: read verified');
        },
      });
      expect(result).toEqual({
        files: ['src/candidate.ts'],
        evidence: ['src/candidate.ts: read verified'],
        iterations: 1,
        stopReason: 'goal_complete',
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('완료 evidence의 읽은 경로 문장을 원문 그대로 보존하고, 장식된 경로 전용 줄은 이유나 후보로 만들지 않는다', async () => {
    const root = worktree();
    try {
      const result = await groundPersistently('preserve evidence', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'preserve-evidence', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
          return complete(ctx, 'src/candidate.ts: candidate is called by the goal author\n- src/candidate.ts\nsrc/candidate.ts,\n(src/candidate.ts)\nsrc/candidate.ts');
        },
      });
      expect(result).toEqual(expect.objectContaining({
        files: ['src/candidate.ts'],
        evidence: ['src/candidate.ts: candidate is called by the goal author'],
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('의미 있는 증거 문장이 없으면 경로 후보만 반환하지 않는다', async () => {
    const root = worktree();
    try {
      const result = await groundPersistently('reject path-only evidence', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'path-only-evidence', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
          return complete(ctx, '- src/candidate.ts\nsrc/candidate.ts,');
        },
      });
      expect(result).toEqual({ files: [], evidence: [], iterations: 1, stopReason: 'goal_complete' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('전체 경로 경계를 검증해 접두 우회와 비허용·미열람 경로가 섞인 evidence 문장을 거부한다', async () => {
    const root = worktree();
    try {
      const result = await groundPersistently('filter unread evidence', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'filter-unread-evidence', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
          return complete(ctx, [
            'src/candidate.ts: exact repository-relative boundary is verified',
            'src/candidate.ts: claims src/not-read.ts is relevant',
            'docs/src/candidate.ts: prefixed path must not impersonate the read file',
            'notsrc/candidate.ts: root-name suffix must not impersonate the read file',
            'src/candidate.ts: claims lib/not-read.ts is relevant',
          ].join('\n'));
        },
      });
      expect(result).toEqual(expect.objectContaining({
        files: ['src/candidate.ts'],
        evidence: ['src/candidate.ts: exact repository-relative boundary is verified'],
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('지원 루트 src/scripts/test/tests/packages/apps의 Read된 증거 문장을 모두 보존한다', async () => {
    const roots = ['src', 'scripts', 'test', 'tests', 'packages', 'apps'] as const;
    const root = worktreeWithRoots(roots);
    try {
      const result = await groundPersistently('preserve all code roots', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'preserve-roots', sessionId: ctx.sessionId, signal: ctx.signal };
          for (const dir of roots) {
            await ctx.dispatchTool('Read', { file_path: `${dir}/candidate.ts` }, callCtx);
          }
          return complete(ctx, roots.map((dir) => `${dir}/candidate.ts: verified relevant call path`).join('\n'));
        },
      });
      expect(result).toEqual(expect.objectContaining({
        files: roots.map((dir) => `${dir}/candidate.ts`),
        evidence: roots.map((dir) => `${dir}/candidate.ts: verified relevant call path`),
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('미Read 경로와 접두 위장 경로가 섞인 test/tests/packages 루트 증거를 거부한다', async () => {
    const root = worktreeWithRoots(['test']);
    try {
      const result = await groundPersistently('reject unread and impersonated roots', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'reject-impersonation', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'test/candidate.ts' }, callCtx);
          return complete(ctx, [
            'test/candidate.ts: exact repository-relative boundary is verified',
            'tests/candidate.ts: unread path in a code root must be rejected',
            'packages/candidate.ts: unread path in a code root must be rejected',
            'docs/test/candidate.ts: prefixed path must not impersonate the read file',
            'nottest/candidate.ts: root-name suffix must not impersonate the read file',
          ].join('\n'));
        },
      });
      expect(result).toEqual(expect.objectContaining({
        files: ['test/candidate.ts'],
        evidence: ['test/candidate.ts: exact repository-relative boundary is verified'],
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('승인된 evidence에서 반복 목록 표지만 벗기고 표지 없는 줄은 그대로 보존한다', async () => {
    const root = worktree();
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = true;\n');
    try {
      const result = await groundPersistently('strip evidence list markers', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'evidence-list-markers', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'src/a.ts' }, callCtx);
          return complete(ctx, [
            '2. src/a.ts',
            '- src/a.ts — x',
            '- 2. src/a.ts — y',
            '  src/a.ts:   unchanged text  ',
          ].join('\n'));
        },
      });
      expect(result).toEqual(expect.objectContaining({
        files: ['src/a.ts'],
        evidence: [
          'src/a.ts',
          'src/a.ts — x',
          'src/a.ts — y',
          '  src/a.ts:   unchanged text  ',
        ],
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('목록 표지 제거 전후 승인 수와 evidence 거절 분류가 동일하다', async () => {
    const root = worktree();
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => { logs.push({ category, event, data }); }) as typeof debug.log;
    try {
      const run = async (acceptedLine: string) => {
        logs.length = 0;
        const result = await groundPersistently('compare evidence list marker policy', root, {
          runGoalLoop: async (ctx) => {
            const callCtx = { callId: 'evidence-marker-equivalence', sessionId: ctx.sessionId, signal: ctx.signal };
            await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
            return complete(ctx, [
              acceptedLine,
              'no path evidence',
              'docs/outside.ts: outside-root evidence',
              'src/not-read.ts: unread evidence',
              'src/candidate.ts',
            ].join('\n'));
          },
        });
        const finished = logs.find((log) => log.category === 'grounding.persistent' && log.event === 'finished');
        return {
          result,
          evidenceCount: (finished?.data as { evidenceCount: number }).evidenceCount,
          rejection: (finished?.data as { evidenceRejection: unknown }).evidenceRejection,
        };
      };
      const marked = await run('- 2. src/candidate.ts — relevant');
      const unmarked = await run('src/candidate.ts — relevant');
      expect(marked.evidenceCount).toBe(unmarked.evidenceCount);
      expect(marked.result?.evidence).toHaveLength(unmarked.result?.evidence.length ?? 0);
      expect(marked.rejection).toEqual(unmarked.rejection);
      expect(marked.rejection).toEqual({
        noPath: 1,
        outsideRoot: 1,
        notRead: 2,
        noMeaningfulText: 1,
        samples: ['no path evidence', 'docs/outside.ts', 'src/not-read.ts'],
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('apps 증거는 Read된 경로만 승인하고 미Read 경로를 거부한다', async () => {
    const root = worktreeWithRoots(['apps/pwa/src']);
    try {
      const result = await groundPersistently('verify apps evidence boundary', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'apps-evidence-boundary', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'apps/pwa/src/candidate.ts' }, callCtx);
          return complete(ctx, [
            'apps/pwa/src/candidate.ts: Read-verified application code is relevant',
            'apps/mobile/src/not-read.ts: unread application path must be rejected',
          ].join('\n'));
        },
      });
      expect(result).toEqual(expect.objectContaining({
        files: ['apps/pwa/src/candidate.ts'],
        evidence: ['apps/pwa/src/candidate.ts: Read-verified application code is relevant'],
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('Kotlin·Swift와 기존 TypeScript 증거는 Read 후 승인하고 문서와 미Read Kotlin은 기존 거부·계측 계약을 지킨다', async () => {
    const root = worktreeWithRoots(['apps/android/x', 'apps/ios/x', 'src']);
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => { logs.push({ category, event, data }); }) as typeof debug.log;
    try {
      writeFileSync(join(root, 'apps', 'android', 'x', 'Foo.kt'), 'class Foo\n');
      writeFileSync(join(root, 'apps', 'ios', 'x', 'Bar.swift'), 'struct Bar {}\n');
      const result = await groundPersistently('verify Kotlin and Swift evidence extensions', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'language-extension-evidence', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'apps/android/x/Foo.kt' }, callCtx);
          await ctx.dispatchTool('Read', { file_path: 'apps/ios/x/Bar.swift' }, callCtx);
          await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
          return complete(ctx, [
            'apps/android/x/Foo.kt: Read-verified Kotlin implementation is relevant',
            'apps/ios/x/Bar.swift: Read-verified Swift implementation is relevant',
            'src/candidate.ts: Read-verified TypeScript implementation remains relevant',
            'docs/x.kt: outside-root Kotlin path must be rejected',
            'README.md: document evidence must be rejected',
            'apps/android/x/Unread.kt: unread Kotlin path must be rejected',
          ].join('\n'));
        },
      });
      expect(result).toEqual(expect.objectContaining({
        files: ['apps/android/x/Foo.kt', 'apps/ios/x/Bar.swift', 'src/candidate.ts'],
        evidence: [
          'apps/android/x/Foo.kt: Read-verified Kotlin implementation is relevant',
          'apps/ios/x/Bar.swift: Read-verified Swift implementation is relevant',
          'src/candidate.ts: Read-verified TypeScript implementation remains relevant',
        ],
      }));
      const finished = logs.find((log) => log.category === 'grounding.persistent' && log.event === 'finished');
      expect((finished?.data as { evidenceRejection?: unknown }).evidenceRejection).toEqual({
        noPath: 1, outsideRoot: 1, notRead: 2, noMeaningfulText: 0,
        samples: ['docs/x.kt', 'README.md: document evidence must be rejected', 'apps/android/x/Unread.kt'],
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Read된 shell script 증거는 승인하고 디렉터리 접두 없는 산문은 거부한다', async () => {
    const root = worktreeWithRoots(['scripts']);
    try {
      writeFileSync(join(root, 'scripts', 'coord-post.sh'), '#!/usr/bin/env bash\n');
      writeFileSync(join(root, 'scripts', 'rooted.bash'), '#!/usr/bin/env bash\n');
      const result = await groundPersistently('verify shell evidence extensions', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'shell-evidence', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'scripts/coord-post.sh' }, callCtx);
          await ctx.dispatchTool('Read', { file_path: 'scripts/rooted.bash' }, callCtx);
          return complete(ctx, [
            'scripts/coord-post.sh: Read-verified shell implementation is relevant',
            'scripts/rooted.bash: Read-verified Bash implementation is relevant',
            'run.sh is prose without a repository-relative directory prefix and must be rejected',
          ].join('\n'));
        },
      });
      expect(result).toEqual(expect.objectContaining({
        files: ['scripts/coord-post.sh', 'scripts/rooted.bash'],
        evidence: [
          'scripts/coord-post.sh: Read-verified shell implementation is relevant',
          'scripts/rooted.bash: Read-verified Bash implementation is relevant',
        ],
      }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('Read된 docs/apps 증거는 비허용 첫 세그먼트 때문에 거부한다', async () => {
    const root = worktreeWithRoots(['docs/apps/pwa/src']);
    try {
      const result = await groundPersistently('reject read prefixed apps evidence', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'reject-read-prefixed-apps', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'docs/apps/pwa/src/candidate.ts' }, callCtx);
          return complete(ctx, 'docs/apps/pwa/src/candidate.ts: Read-verified prefixed application path must be rejected');
        },
      });
      expect(result).toEqual({ files: [], evidence: [], iterations: 1, stopReason: 'goal_complete' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('Windows 상대 경로도 POSIX evidence와 정규화하여 읽은 후보를 승인한다', async () => {
    const root = worktree();
    const validReadResult = {
      output: 'candidate', linesRead: 1, totalLines: 1, totalBytes: 1, truncated: false, kind: 'text' as const,
    };
    try {
      const result = await groundPersistently('windows path', root, {
        dispatchTool: async () => validReadResult,
        relativePath: () => 'src\\candidate.ts',
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'windows-relative-path', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
          return complete(ctx, 'src/candidate.ts: read verified');
        },
      });
      expect(normalizeRepositoryRelativePath('src\\candidate.ts')).toBe('src/candidate.ts');
      expect(result).toEqual({
        files: ['src/candidate.ts'],
        evidence: ['src/candidate.ts: read verified'],
        iterations: 1,
        stopReason: 'goal_complete',
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('완료되지 않은 루프의 update_goal 증거나 finalText는 채택하지 않는다', async () => {
    const root = worktree();
    try {
      const result = await groundPersistently('incomplete', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'incomplete', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
          ctx.callbacks?.onToolCall?.({ id: 'blocked', name: 'update_goal', args: { status: 'blocked', evidence: 'src/candidate.ts' } });
          return { finalText: 'src/candidate.ts', iterations: 1, stopReason: 'max_iterations', goalComplete: false };
        },
      });
      expect(result).toEqual({ files: [], evidence: [], iterations: 1, stopReason: 'max_iterations' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('증거의 경로가 존재해도 Read하지 않았으면 후보로 승인하지 않는다', async () => {
    const root = worktree();
    try {
      const result = await groundPersistently('unread evidence', root, {
        runGoalLoop: async (ctx) => complete(ctx, 'src/candidate.ts: asserted only'),
      });
      expect(result).toEqual({ files: [], evidence: [], iterations: 2, stopReason: 'evidence_retry_rejected' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('근거 없이 완료한 재시도가 실패하면 실패 사유를 완료와 구분한다', async () => {
    const root = worktree();
    let attempts = 0;
    try {
      const result = await groundPersistently('unread evidence', root, {
        runGoalLoop: async (ctx) => {
          attempts += 1;
          if (attempts === 1) return complete(ctx, 'src/candidate.ts: guessed from Glob');
          throw new Error('retry unavailable');
        },
      });
      expect(attempts).toBe(2);
      expect(result).toEqual({ files: [], evidence: [], iterations: 1, stopReason: 'evidence_retry_failed' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const [retryStopReason, retryOutcome] of [
    ['auth_rejected', 'auth-rejected'], ['aborted', 'aborted'], ['error', 'failed'], ['soft_stop', 'aborted'],
  ] as const) {
    test(`반환형 ${retryStopReason} 재시도는 미완료로 바꾸지 않고 원래 종료 사유를 보존한다`, async () => {
      const root = worktree();
      const original = debug.log.bind(debug) as typeof debug.log;
      const finished: Record<string, unknown>[] = [];
      let attempts = 0;
      (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
        if (category === 'grounding.persistent' && event === 'finished' && data) finished.push(data);
      }) as typeof debug.log;
      try {
        const result = await groundPersistently('unread evidence', root, {
          runGoalLoop: async (ctx) => {
            attempts += 1;
            if (attempts === 1) return complete(ctx, 'src/candidate.ts: guessed from Glob');
            return { finalText: '', iterations: 1, stopReason: retryStopReason, goalComplete: false };
          },
        });
        expect(attempts).toBe(2);
        expect(result?.stopReason).toBe(retryStopReason);
        expect(finished.at(-1)).toMatchObject({ retryOutcome, retryStopReason, stopReason: retryStopReason, evidenceCount: 0 });
      } finally {
        (debug as { log: typeof debug.log }).log = original;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('미Read 경로 재시도는 정확한 Read 호출을 지시하고 완료 없이 끝난 상태와 실제 모델을 기록한다', async () => {
    const root = worktree();
    const original = debug.log.bind(debug) as typeof debug.log;
    const finished: Record<string, unknown>[] = [];
    let attempts = 0;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'grounding.persistent' && event === 'finished' && data) finished.push(data);
    }) as typeof debug.log;
    try {
      const result = await groundPersistently('inspect real candidate', root, {
        runGoalLoop: async (ctx) => {
          attempts += 1;
          ctx.callbacks?.onResolvedProvider?.('openrouter', attempts === 1 ? 'glm-first' : 'glm-retry');
          if (attempts === 1) return complete(ctx, 'src/candidate.ts: asserted from Glob only');
          const feedback = String(ctx.messages.at(-1)?.content);
          expect(feedback).toContain('Read({"file_path":"src/candidate.ts"})');
          expect(feedback).toContain('Glob, Grep, and ListDir');
          expect(feedback).toContain('Finish by calling update_goal');
          return { stopReason: 'end_turn', finalText: 'done', iterations: 1, goalComplete: false };
        },
      });
      expect(attempts).toBe(2);
      expect(result?.evidence).toEqual([]);
      expect(result?.stopReason).toBe('evidence_retry_incomplete');
      expect(finished.at(-1)).toMatchObject({ feedbackRetry: true, retryOutcome: 'incomplete',
        provider: 'openrouter', model: 'glm-retry', evidenceCount: 0, stopReason: 'evidence_retry_incomplete' });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('거부된 경로가 여러 개여도 재시도 피드백에 각각의 Read 호출을 적는다', async () => {
    const root = worktree();
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts', 'src/h.ts', 'src/i.ts'];
    let attempts = 0;
    try {
      await groundPersistently('inspect candidates', root, {
        runGoalLoop: async (ctx) => {
          attempts += 1;
          if (attempts === 1) return complete(ctx, paths.map((path) => `${path}: discovered by Glob`).join('\n'));
          const feedback = String(ctx.messages.at(-1)?.content);
          for (const path of paths) expect(feedback).toContain(`Read({"file_path":"${path}"})`);
          return { stopReason: 'end_turn', finalText: 'done', iterations: 1, goalComplete: false };
        },
      });
      expect(attempts).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('읽지 않은 import 경로를 되먹인 뒤 한 번의 재시도에서 Read로 검증해 채택한다', async () => {
    const root = worktreeWithRoots(['scripts', 'src/ux-sim']);
    writeFileSync(join(root, 'scripts', 'ux-sim.ts'), "import '../src/ux-sim/fault-cred-expiry.js';\n");
    writeFileSync(join(root, 'src', 'ux-sim', 'fault-cred-expiry.js'), 'export const fault = true;\n');
    let attempts = 0;
    try {
      const result = await groundPersistently('inspect UX fault path', root, {
        runGoalLoop: async (ctx, options) => {
          attempts += 1;
          const callCtx = { callId: `grounding-${attempts}`, sessionId: ctx.sessionId, signal: ctx.signal };
          if (attempts === 1) {
            await ctx.dispatchTool('Read', { file_path: 'scripts/ux-sim.ts' }, callCtx);
            return complete(ctx, 'src/ux-sim/fault-cred-expiry.js: handles the credential fault');
          }
          expect(options?.maxIterations).toBe(2);
          expect(ctx.messages.at(-1)?.content).toContain('src/ux-sim/fault-cred-expiry.js');
          expect(ctx.messages.at(-1)?.content).toContain('scripts/ux-sim.ts');
          await ctx.dispatchTool('Read', { file_path: 'src/ux-sim/fault-cred-expiry.js' }, callCtx);
          return complete(ctx, 'src/ux-sim/fault-cred-expiry.js: handles the credential fault');
        },
      });
      expect(attempts).toBe(2);
      expect(result).toEqual({ files: ['src/ux-sim/fault-cred-expiry.js'],
        evidence: ['src/ux-sim/fault-cred-expiry.js: handles the credential fault'], iterations: 2, stopReason: 'goal_complete' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('존재하지 않는 경로는 재시도에서 제거하고 실제 Read 경로만 채택한다', async () => {
    const root = worktreeWithRoots(['scripts']);
    let attempts = 0;
    try {
      const result = await groundPersistently('inspect available implementation', root, {
        runGoalLoop: async (ctx) => {
          attempts += 1;
          const callCtx = { callId: `grounding-${attempts}`, sessionId: ctx.sessionId, signal: ctx.signal };
          if (attempts === 1) {
            await ctx.dispatchTool('Read', { file_path: 'scripts/candidate.ts' }, callCtx);
            return complete(ctx, 'src/nonexistent.ts: guessed location');
          }
          expect(ctx.messages.at(-1)?.content).toContain('src/nonexistent.ts');
          return complete(ctx, 'scripts/candidate.ts: actual implementation entry');
        },
      });
      expect(result).toEqual({ files: ['scripts/candidate.ts'], evidence: ['scripts/candidate.ts: actual implementation entry'],
        iterations: 2, stopReason: 'goal_complete' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('재시도와 그 실패 로그가 모두 throw해도 첫 Read 근거를 보존한다', async () => {
    const root = worktree();
    const original = debug.log.bind(debug) as typeof debug.log;
    let attempts = 0;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string) => {
      if (category === 'grounding.persistent' && event === 'evidence-retry-failed') throw new Error('log unavailable');
    }) as typeof debug.log;
    try {
      const result = await groundPersistently('keep verified evidence', root, {
        runGoalLoop: async (ctx) => {
          attempts += 1;
          if (attempts === 2) throw new Error('retry unavailable');
          const callCtx = { callId: 'first', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
          return complete(ctx, 'src/candidate.ts: verified implementation\nsrc/unread.ts: guessed detail');
        },
      });
      expect(attempts).toBe(2);
      expect(result).toEqual({ files: ['src/candidate.ts'], evidence: ['src/candidate.ts: verified implementation'],
        iterations: 1, stopReason: 'evidence_retry_failed' });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [retryStopReason, expected] of [
    ['auth_rejected', 'auth_rejected'], ['aborted', 'aborted'], ['error', 'error'], ['soft_stop', 'soft_stop'],
  ] as const) {
    test(`혼합 첫 증거 뒤 재시도 ${retryStopReason}가 와도 완료로 위장하지 않는다`, async () => {
      const root = worktree();
      let attempts = 0;
      try {
        const result = await groundPersistently('mixed evidence', root, {
          runGoalLoop: async (ctx) => {
            attempts++;
            if (attempts > 1) return { finalText: '', iterations: 1, stopReason: retryStopReason, goalComplete: false };
            await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' },
              { callId: 'first', sessionId: ctx.sessionId, signal: ctx.signal });
            return complete(ctx, 'src/candidate.ts: verified implementation\nsrc/unread.ts: guessed path');
          },
        });
        expect(result).toEqual({ files: ['src/candidate.ts'],
          evidence: ['src/candidate.ts: verified implementation'], iterations: 2, stopReason: expected });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test('재시도에 다른 유효 경로와 같은 미Read 경로가 섞여도 첫 유효 근거를 잃지 않는다', async () => {
    const root = worktree();
    writeFileSync(join(root, 'src', 'second.ts'), 'export const second = true;\n');
    let attempts = 0;
    try {
      const result = await groundPersistently('preserve both verified paths', root, {
        runGoalLoop: async (ctx) => {
          attempts += 1;
          const callCtx = { callId: `mixed-${attempts}`, sessionId: ctx.sessionId, signal: ctx.signal };
          if (attempts === 1) {
            await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
            return complete(ctx, 'src/candidate.ts: first verified path\nsrc/unread.ts: still guessed');
          }
          await ctx.dispatchTool('Read', { file_path: 'src/second.ts' }, callCtx);
          return complete(ctx, 'src/second.ts: second verified path\nsrc/unread.ts: still guessed');
        },
      });
      expect(attempts).toBe(2);
      expect(result).toEqual({ files: ['src/candidate.ts', 'src/second.ts'],
        evidence: ['src/candidate.ts: first verified path', 'src/second.ts: second verified path'],
        iterations: 2, stopReason: 'goal_complete' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('실제 grounding 스트림의 요청 모델이 finished 관측 모델과 일치한다', async () => {
    const root = worktree();
    const configRoot = mkdtempSync(join(tmpdir(), 'elanous-grounding-config-'));
    writeFileSync(join(configRoot, 'config.json'), JSON.stringify({ llm: {
      provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', apiKey: 'test-key',
    } }));
    const originalLog = debug.log;
    const originalKey = process.env.OPENROUTER_API_KEY;
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const requests: Record<string, unknown>[] = [];
    const finished: Record<string, unknown>[] = [];
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch);
    try {
      delete process.env.XDG_CONFIG_HOME;
      process.env.OPENROUTER_API_KEY = 'test-key';
      setElanousConfigDir(configRoot);
      debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
        if (category === 'grounding.persistent' && event === 'finished') finished.push(data);
      }) as typeof debug.log;
      await groundPersistently('inspect src/candidate.ts', root, { maxIterations: 1, hasAstGrep: () => false });
      expect(requests.length).toBeGreaterThan(0);
      expect(finished).toHaveLength(1);
      expect(requests[0]?.model).toBe('z-ai/glm-5.3');
      expect(finished[0]).toMatchObject({ provider: 'openrouter', model: `openrouter/${requests[0]?.model}` });
    } finally {
      fetchMock.mockRestore();
      debug.log = originalLog;
      resetElanousConfigDir();
      if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
      rmSync(root, { recursive: true, force: true });
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  test('근거 루프는 자식 기본 모델 대신 planning 역할 모델을 모든 턴에 전달한다', async () => {
    const root = worktree();
    const models: Array<string | undefined> = [];
    let calls = 0;
    const original = debug.log;
    const finished: Record<string, unknown>[] = [];
    debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'grounding.persistent' && event === 'finished') finished.push(data);
    }) as typeof debug.log;
    try {
      await groundPersistently('inspect src/candidate.ts', root, {
        planningLlm: () => ({ model: 'gpt-6-sol', modelSource: 'config-role' }),
        runGoalLoop: async (ctx) => {
          models.push(ctx.modelOverride);
          calls++;
          if (calls === 1) return complete(ctx, 'src/candidate.ts: evidence before Read');
          const callCtx = { callId: 'planning-read', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
          return complete(ctx, 'src/candidate.ts: verified implementation candidate');
        },
      });
      expect(models).toEqual(['gpt-6-sol', 'gpt-6-sol']);
      expect(finished[0]).toMatchObject({ planningModel: 'gpt-6-sol', planningModelSource: 'config-role', evidenceCount: 1 });
    } finally {
      debug.log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('자식 모델 폴백은 grounding 완료 관측에 모델 출처와 사유를 남긴다', async () => {
    const root = worktree();
    const logs: Record<string, unknown>[] = [];
    const original = debug.log;
    debug.log = ((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'grounding.persistent' && event === 'finished') logs.push(data);
    }) as typeof debug.log;
    try {
      await groundPersistently('inspect src/candidate.ts', root, {
        planningLlm: () => ({ model: 'openrouter/z-ai/glm-5.3', modelSource: 'fallback-child', fallbackReason: 'quota-exhausted', requestedModel: 'gpt-6-sol', requestedSource: 'config-role' }),
        runGoalLoop: async (ctx) => {
          expect(ctx.modelOverride).toBe('openrouter/z-ai/glm-5.3');
          await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, { callId: 'fallback-read', sessionId: ctx.sessionId, signal: ctx.signal });
          return complete(ctx, 'src/candidate.ts: verified implementation candidate');
        },
      });
      expect(logs[0]).toMatchObject({ planningModel: 'openrouter/z-ai/glm-5.3', planningModelSource: 'fallback-child', planningFallbackReason: 'quota-exhausted', planningRequestedModel: 'gpt-6-sol', planningRequestedSource: 'config-role' });
    } finally {
      debug.log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('실제 goal loop는 재시도 Read 응답 뒤 다음 턴의 완료 증거를 채택한다', async () => {
    const root = worktreeWithRoots(['scripts', 'src']);
    let retryTurns = 0;
    const original = debug.log.bind(debug) as typeof debug.log;
    const finished: Record<string, unknown>[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'grounding.persistent' && event === 'finished' && data) finished.push(data);
    }) as typeof debug.log;
    try {
      const result = await groundPersistently('trace the real file', root, {
        runGoalLoop: (ctx, options) => runGoalLoop(ctx, { ...options, changedFiles: () => [],
          runTurn: async (turn) => {
            const callCtx = { callId: 'read', sessionId: turn.sessionId, signal: turn.signal };
            if (!turn.sessionId.endsWith('-evidence-retry')) {
              await turn.dispatchTool('Read', { file_path: 'scripts/candidate.ts' }, callCtx);
              const evidence = 'src/candidate.ts: guessed before Read';
              turn.callbacks?.onToolCall?.({ id: 'first-goal', name: 'update_goal', args: { status: 'complete', evidence } });
              turn.callbacks?.onTurnComplete?.([{ role: 'assistant', content: [{ type: 'tool_use', id: 'first-goal', name: 'update_goal', input: { status: 'complete', evidence } }] }]);
              return { stopReason: 'end_turn', finalText: '' };
            }
            retryTurns += 1;
            if (retryTurns === 1) {
              const read = await turn.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx) as { output: string };
              expect(read.output).toContain('candidate');
              turn.callbacks?.onTurnComplete?.([{ role: 'assistant', content: [{ type: 'tool_use', id: 'retry-read', name: 'Read', input: { file_path: 'src/candidate.ts' } }] }]);
              return { stopReason: 'end_turn', finalText: '' };
            }
            expect(turn.messages.at(-1)?.content).toContain('continue');
            const evidence = 'src/candidate.ts: verified after the prior Read response';
            turn.callbacks?.onToolCall?.({ id: 'retry-goal', name: 'update_goal', args: { status: 'complete', evidence } });
            turn.callbacks?.onTurnComplete?.([{ role: 'assistant', content: [{ type: 'tool_use', id: 'retry-goal', name: 'update_goal', input: { status: 'complete', evidence } }] }]);
            return { stopReason: 'end_turn', finalText: '' };
          },
        }),
      });
      expect(retryTurns).toBe(2);
      expect(result?.files).toEqual(['src/candidate.ts']);
      expect(result?.evidence).toEqual(['src/candidate.ts: verified after the prior Read response']);
      expect(finished.at(-1)).toMatchObject({ feedbackRetry: true, candidateCount: 1, evidenceCount: 1, stopReason: 'goal_complete' });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('명시적으로 유효한 ReadResult만 읽은 후보로 승인하고 비정상 반환 뒤에도 루프를 계속한다', async () => {
    const root = worktree();
    const validReadResult = {
      output: 'candidate', linesRead: 1, totalLines: 1, totalBytes: 1, truncated: false, kind: 'text' as const,
    };
    try {
      for (const value of [null, 'read output', { output: 'candidate' }, { error: 'read failed' }]) {
        let calls = 0;
        const result = await groundPersistently('invalid dispatcher result', root, {
          dispatchTool: async () => {
            calls += 1;
            return value;
          },
          runGoalLoop: async (ctx) => {
            const callCtx = { callId: 'invalid-result', sessionId: ctx.sessionId, signal: ctx.signal };
            expect(await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx)).toBe(value);
            expect(await ctx.dispatchTool('Grep', { path: '.', pattern: 'candidate' }, callCtx)).toBe(value);
            return complete(ctx, 'src/candidate.ts: asserted after invalid Read');
          },
        });
        expect(calls).toBe(4);
        expect(result).toEqual({ files: [], evidence: [], iterations: 2, stopReason: 'evidence_retry_rejected' });
      }
      const result = await groundPersistently('valid dispatcher result', root, {
        dispatchTool: async () => validReadResult,
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'valid-result', sessionId: ctx.sessionId, signal: ctx.signal };
          expect(await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx)).toEqual(validReadResult);
          return complete(ctx, 'src/candidate.ts: read verified');
        },
      });
      expect(result).toEqual({
        files: ['src/candidate.ts'],
        evidence: ['src/candidate.ts: read verified'],
        iterations: 1,
        stopReason: 'goal_complete',
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('주입 dispatcher도 read-only와 realpath worktree 격리를 우회할 수 없다', async () => {
    const root = worktree();
    const outside = mkdtempSync(join(tmpdir(), 'elanous-grounding-outside-'));
    const calls: string[] = [];
    try {
      symlinkSync(join(outside), join(root, 'escape'));
      await groundPersistently('boundary', root, {
        dispatchTool: async (name) => { calls.push(name); return { output: 'delegate' }; },
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'boundary', sessionId: ctx.sessionId, signal: ctx.signal };
          expect(await ctx.dispatchTool('Read', { file_path: 'escape/secret.ts' }, callCtx)).toEqual({ error: 'persistent grounding refuses path outside cwd: escape/secret.ts' });
          expect(await ctx.dispatchTool('Edit', { path: 'src/candidate.ts' }, callCtx)).toEqual({ error: 'persistent grounding refuses non-readonly tool: Edit' });
          return { finalText: '', iterations: 1, stopReason: 'max_iterations', goalComplete: false };
        },
      });
      expect(calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('ast-grep 바이너리가 없으면 그 도구만 숨기고 관측을 남긴다', async () => {
    expect(persistentGroundingTools({ hasAstGrep: () => false }).map((tool) => tool.name)).toEqual(['Grep', 'Glob', 'ListDir', 'Read']);
    const root = worktree();
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => { logs.push({ category, event, data }); }) as typeof debug.log;
    try {
      await groundPersistently('without ast-grep', root, { hasAstGrep: () => false, runGoalLoop: async () => ({ finalText: '', iterations: 1, stopReason: 'max_iterations', goalComplete: false }) });
      expect(logs.some((log) => log.category === 'grounding.persistent' && log.event === 'tool-unavailable' && (log.data as { tool?: string }).tool === 'AstGrep')).toBe(true);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('비용 상한을 1..상수 범위로 clamp하고 실제 값과 session ID를 관측한다', async () => {
    const root = worktree();
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => { logs.push({ category, event, data }); }) as typeof debug.log;
    try {
      for (const [requested, expected] of [[50, PERSISTENT_GROUNDING_MAX_ITERATIONS], [0, 1], [-1, 1]]) {
        let seenMax = 0;
        let seenSessionId = '';
        await groundPersistently('cap', root, {
          maxIterations: requested,
          runGoalLoop: async (ctx, options) => {
            seenMax = options?.maxIterations ?? 0;
            seenSessionId = ctx.sessionId;
            return { finalText: '', iterations: 1, stopReason: 'max_iterations', goalComplete: false };
          },
        });
        expect(seenMax).toBe(expected);
        expect(logs.at(-1)).toEqual(expect.objectContaining({
          category: 'grounding.persistent',
          event: 'finished',
          data: expect.objectContaining({ sessionId: seenSessionId, maxIterations: expected }),
        }));
      }
      expect(PERSISTENT_GROUNDING_MAX_ITERATIONS).toBe(4);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('실패 관측은 fallback이 아니라 failed이며 누적 도구·완료 라운드와 session ID를 유지한다', async () => {
    const root = worktree();
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => { logs.push({ category, event, data }); }) as typeof debug.log;
    let ambientSessionId = '';
    try {
      await groundPersistently('failure', root, {
        runGoalLoop: async (ctx) => {
          ambientSessionId = ctx.sessionId;
          ctx.callbacks?.onToolCall?.({ id: 'grep-1', name: 'Grep', args: {} });
          ctx.callbacks?.onToolCall?.({ id: 'read-1', name: 'Read', args: {} });
          ctx.callbacks?.onTurnComplete?.([]);
          ctx.callbacks?.onToolCall?.({ id: 'grep-2', name: 'Grep', args: {} });
          ctx.callbacks?.onTurnComplete?.([]);
          throw new Error('loop failed');
        },
      });
      const failed = logs.find((log) => log.category === 'grounding.persistent' && log.event === 'failed');
      expect(failed).toEqual(expect.objectContaining({
        category: 'grounding.persistent',
        event: 'failed',
        data: expect.objectContaining({
          sessionId: ambientSessionId,
          maxIterations: PERSISTENT_GROUNDING_MAX_ITERATIONS,
          iterations: 2,
          toolCalls: { Grep: 2, Read: 1 },
          reason: 'loop failed',
        }),
      }));
      expect((failed?.data as { durationMs?: unknown }).durationMs).toSatisfy((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
      expect(logs.some((log) => log.event === 'finished' || log.event === 'fallback')).toBe(false);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('finished 관측은 기존 필드를 보존하면서 독립 rejection 계수와 제한된 표본을 싣는다', async () => {
    const root = worktree();
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => { logs.push({ category, event, data }); }) as typeof debug.log;
    try {
      const longLine = `no path ${'x'.repeat(250)}`;
      const result = await groundPersistently('finished fields', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'rejections', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
          return complete(ctx, [
            'src/candidate.ts: accepted evidence remains unchanged',
            'no path evidence',
            'docs/outside.ts: outside root and unread evidence',
            'src/not-read.ts: unread evidence',
            '- src/candidate.ts',
            longLine,
          ].join('\n'));
        },
      });
      expect(result).toEqual(expect.objectContaining({
        files: ['src/candidate.ts'],
        evidence: ['src/candidate.ts: accepted evidence remains unchanged'],
      }));
      const finished = logs.find((log) => log.category === 'grounding.persistent' && log.event === 'finished');
      expect(Object.keys(finished?.data as object).sort()).toEqual([
        'candidateCount', 'candidates', 'durationMs', 'evidenceCount', 'evidenceRejection', 'feedbackRetry', 'firstEvidenceRejection',
        'iterations', 'maxIterations', 'model', 'outcome', 'planningFallbackReason', 'planningModel', 'planningModelSource', 'planningRequestedModel', 'planningRequestedSource', 'provider', 'retryOutcome', 'retryStopReason', 'sessionId', 'stopReason', 'toolCalls',
      ]);
      expect((finished?.data as { evidenceRejection?: unknown }).evidenceRejection).toEqual({
        noPath: 2,
        outsideRoot: 1,
        notRead: 2,
        noMeaningfulText: 1,
        samples: ['no path evidence', 'docs/outside.ts', 'src/not-read.ts'],
      });
      expect((finished?.data as { durationMs?: unknown }).durationMs).toSatisfy((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('finished rejection 표본은 세 항목과 각 200자 prefix로 제한한다', async () => {
    const root = worktree();
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => { logs.push({ category, event, data }); }) as typeof debug.log;
    try {
      const longLines = Array.from({ length: 4 }, (_, index) => `missing-${index}-${'x'.repeat(250)}`);
      await groundPersistently('bounded samples', root, {
        runGoalLoop: async (ctx) => complete(ctx, longLines.join('\n')),
      });
      const finished = logs.find((log) => log.category === 'grounding.persistent' && log.event === 'finished');
      const rejection = (finished?.data as { evidenceRejection: { samples: string[] } }).evidenceRejection;
      expect(rejection.samples).toEqual(longLines.slice(0, 3).map((line) => line.slice(0, 200)));
      expect(rejection.samples.every((sample) => sample.length === 200)).toBe(true);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('finished 관측은 완료 evidence가 전부 통과하거나 없을 때도 0 rejection을 낸다', async () => {
    const root = worktree();
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => { logs.push({ category, event, data }); }) as typeof debug.log;
    try {
      await groundPersistently('zero rejections', root, {
        runGoalLoop: async (ctx) => {
          const callCtx = { callId: 'zero-rejections', sessionId: ctx.sessionId, signal: ctx.signal };
          await ctx.dispatchTool('Read', { file_path: 'src/candidate.ts' }, callCtx);
          return complete(ctx, 'src/candidate.ts: accepted evidence');
        },
      });
      const finished = logs.find((log) => log.category === 'grounding.persistent' && log.event === 'finished');
      expect((finished?.data as { evidenceRejection?: unknown }).evidenceRejection).toEqual({
        noPath: 0, outsideRoot: 0, notRead: 0, noMeaningfulText: 0, samples: [],
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('루프가 관측 전 실패하면 failed가 완료 반복을 날조하지 않고 빈 도구 누적을 남긴다', async () => {
    const root = worktree();
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => { logs.push({ category, event, data }); }) as typeof debug.log;
    try {
      expect(await groundPersistently('early failure', root, {
        runGoalLoop: async () => { throw new Error('x'.repeat(201)); },
      })).toBeNull();
      const failed = logs.find((log) => log.category === 'grounding.persistent' && log.event === 'failed');
      expect(failed?.data).toEqual(expect.objectContaining({ toolCalls: {}, reason: 'x'.repeat(200) }));
      expect(failed?.data).not.toHaveProperty('iterations');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('실패 관측이 던져도 원래 실패는 null로 반환한다', async () => {
    const root = worktree();
    const original = debug.log.bind(debug) as typeof debug.log;
    (debug as { log: typeof debug.log }).log = (() => { throw new Error('telemetry failed'); }) as typeof debug.log;
    try {
      expect(await groundPersistently('telemetry failure', root, {
        hasAstGrep: () => true,
        runGoalLoop: async () => { throw new Error('loop failed'); },
      })).toBeNull();
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
