import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreTurnContext, GoalLoopResult } from '../../core-turn/index.js';
import { debug } from '../../debug/log.js';
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
      expect(result).toEqual({ files: [], evidence: [], iterations: 1, stopReason: 'goal_complete' });
    } finally { rmSync(root, { recursive: true, force: true }); }
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
        expect(calls).toBe(2);
        expect(result).toEqual({ files: [], evidence: [], iterations: 1, stopReason: 'goal_complete' });
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
        'candidateCount', 'candidates', 'durationMs', 'evidenceCount', 'evidenceRejection', 'iterations', 'maxIterations', 'outcome', 'sessionId', 'stopReason', 'toolCalls',
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
