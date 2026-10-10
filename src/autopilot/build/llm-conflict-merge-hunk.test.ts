// MERGE-CONFLICT-AUTO — 상한을 넘는 큰 파일 충돌을 hunk 단위로 풀고 원 파일에 꿰맨다(실 LLM·gh 없음 · stream seam).
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { setUserConfigOverlay } from '../../user-config.js';
import {
  DEFAULT_MERGE_CONFLICT_INPUT_MAX_CHARS, MergeConflictInputTooLarge, defaultGitMergeSeam, defaultLlmResolve,
  conflictHunkResolvePrompt, findConflictHunks, hasConflictMarkers, mergeConflictAutoEnabled, mergeMainWithLlmResolve, resolveConflictByHunks,
} from './llm-conflict-merge.js';

type Stream = typeof import('../../llm.js')['streamLLM'];

/** A filler large enough that the whole-file prompt exceeds the default cap. */
function filler(prefix: string, lines: number): string {
  return Array.from({ length: lines }, (_, i) => `export const ${prefix}${i} = ${i}; // ${'x'.repeat(40)}`).join('\n');
}

describe('MERGE-CONFLICT-AUTO — hunk parser and stitcher', () => {
  const conflicted = ['a', 'b', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> main', 'c', '<<<<<<< HEAD', 'o2', '||||||| base', 'b2', '=======', 't2', '>>>>>>> main', 'd', ''].join('\n');

  test('finds every block; unbalanced markers are not stitchable', () => {
    expect(findConflictHunks(conflicted)).toEqual([{ start: 2, end: 6 }, { start: 8, end: 14 }]);
    expect(findConflictHunks('<<<<<<< HEAD\nx\n')).toBeNull();
    expect(findConflictHunks('x\n>>>>>>> main\n')).toBeNull();
    // a block without its `=======` separator, a doubled separator, or a base section after the separator is not stitchable
    expect(findConflictHunks('<<<<<<< HEAD\nours\n>>>>>>> main\n')).toBeNull();
    expect(findConflictHunks('<<<<<<< HEAD\no\n=======\nt\n=======\n>>>>>>> main\n')).toBeNull();
    expect(findConflictHunks('<<<<<<< HEAD\no\n=======\n||||||| base\nt\n>>>>>>> main\n')).toBeNull();
    // `=======` outside a block (Markdown underline) is not a marker
    expect(findConflictHunks('Title\n=======\n')).toEqual([]);
  });

  test('replaces only the blocks — lines outside conflicts stay byte-identical', async () => {
    const prompts: string[] = [];
    const out = await resolveConflictByHunks('f.ts', conflicted, 'main', 10_000, async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? '```ts\nmerged1\n```' : 'merged2a\nmerged2b\n';
    }, 1);
    expect(out).toBe(['a', 'b', 'merged1', 'c', 'merged2a', 'merged2b', 'd', ''].join('\n'));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('충돌 블록 1/2');
    // context never crosses into the neighbouring block
    expect(prompts[1]).not.toContain('>>>>>>> main\nc\n<<<<<<<');
  });

  test('no trailing newline at end of file stays that way', async () => {
    const noEol = '<<<<<<< HEAD\no\n=======\nt\n>>>>>>> main\nlast';
    expect(await resolveConflictByHunks('f.ts', noEol, 'main', 10_000, async () => 'merged\n')).toBe('merged\nlast');
  });

  test('an empty resolution keeps the bytes around the block (EOF and mid-file)', async () => {
    const eof = 'prefix\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main';
    expect(await resolveConflictByHunks('f.ts', eof, 'main', 10_000, async () => '')).toBe('prefix\n');
    const mid = 'a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\nb\n';
    expect(await resolveConflictByHunks('f.ts', mid, 'main', 10_000, async () => '')).toBe('a\nb\n');
  });

  test('CRLF markers are recognised and CRLF answers stitch without extra lines (mid and EOF)', async () => {
    const crlf = 'a\r\n<<<<<<< HEAD\r\no\r\n=======\r\nt\r\n>>>>>>> main\r\nb\r\n<<<<<<< HEAD\r\no2\r\n=======\r\nt2\r\n>>>>>>> main\r\n';
    expect(findConflictHunks(crlf)).toEqual([{ start: 1, end: 5 }, { start: 7, end: 11 }]);
    let n = 0;
    const out = await resolveConflictByHunks('f.ts', crlf, 'main', 10_000, async () => (++n === 1 ? 'm1\r\nm1b\r\n' : 'm2\n'));
    expect(out).toBe('a\r\nm1\r\nm1b\r\nb\r\nm2\r\n');
  });

  test('a malformed block (no separator) on an oversized file → the old too-large exit, no LLM call', async () => {
    let calls = 0;
    const stream = (async () => { calls++; return 'x'; }) as unknown as Stream;
    const malformed = `${filler('h', 1500)}\n<<<<<<< HEAD\nours\n>>>>>>> main\n`;
    await expect(defaultLlmResolve('f.ts', malformed, 'main', { mode: 'off', stream, mergeConflictAuto: true })).rejects.toBeInstanceOf(MergeConflictInputTooLarge);
    expect(calls).toBe(0);
  });

  test('resolver intent (ours·theirs·sibling PR) rides the hunk prompt; dropped only when it alone breaks the cap', async () => {
    const block = '<<<<<<< HEAD\no\n=======\nt\n>>>>>>> main\n';
    const intent = { ours: 'effort knob', theirs: ['feat: openrouter body (#25964)'], siblings: [{ number: 25964, title: 'openrouter body', body: 'Keep the reasoning field.', goal: null, goalPath: null, source: 'gh' as const }] };
    const prompts: string[] = [];
    await resolveConflictByHunks('f.ts', block, 'main', 10_000, async (p) => { prompts.push(p); return 'm'; }, 5, intent);
    expect(prompts[0]).toContain('ours 의 의도: effort knob');
    expect(prompts[0]).toContain('#25964 openrouter body');
    expect(prompts[0]).toContain('Keep the reasoning field.');
    const plainLen = conflictHunkResolvePrompt('f.ts', '', block.trimEnd(), '', 'main', 0, 1).length;
    await resolveConflictByHunks('f.ts', block, 'main', plainLen + 5, async (p) => { prompts.push(p); return 'm'; }, 5, intent);
    expect(prompts[1]).not.toContain('ours 의 의도');
  });

  test('long context shrinks until the block fits — only a block that alone breaks the cap hands off', async () => {
    const ctxLine = 'c'.repeat(200);
    const text = [...Array(40).fill(ctxLine), '<<<<<<< HEAD', 'o', '=======', 't', '>>>>>>> main', ...Array(40).fill(ctxLine), ''].join('\n');
    const blockOnly = conflictHunkResolvePrompt('f.ts', '', '<<<<<<< HEAD\no\n=======\nt\n>>>>>>> main', '', 'main', 0, 1).length;
    const prompts: string[] = [];
    const out = await resolveConflictByHunks('f.ts', text, 'main', blockOnly + 1000, async (p) => { prompts.push(p); return 'm'; });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.length).toBeLessThanOrEqual(blockOnly + 1000);
    expect(out).toBe([...Array(40).fill(ctxLine), 'm', ...Array(40).fill(ctxLine), ''].join('\n'));
  });

  test('a later block over the cap → no LLM call at all (all prompts sized first)', async () => {
    const text = `<<<<<<< HEAD\no\n=======\nt\n>>>>>>> main\nmid\n<<<<<<< HEAD\n${'o'.repeat(3000)}\n=======\nt\n>>>>>>> main\n`;
    let calls = 0;
    await expect(resolveConflictByHunks('f.ts', text, 'main', 2500, async () => { calls++; return 'm'; })).rejects.toBeInstanceOf(MergeConflictInputTooLarge);
    expect(calls).toBe(0);
  });

  test('a 150,000-line resolution stitches line by line (no spread into push)', async () => {
    const big = Array.from({ length: 150_000 }, (_, i) => `l${i}`).join('\n');
    const out = await resolveConflictByHunks('f.ts', 'a\n<<<<<<< HEAD\no\n=======\nt\n>>>>>>> main\nb\n', 'main', 10_000, async () => big);
    expect(out).toBe(`a\n${big}\nb\n`);
  });

  test('intent survives by shrinking context first; dropped only when even zero context cannot carry it', async () => {
    const ctxLine = 'c'.repeat(200);
    const text = [...Array(40).fill(ctxLine), '<<<<<<< HEAD', 'o', '=======', 't', '>>>>>>> main', ...Array(40).fill(ctxLine), ''].join('\n');
    const block = '<<<<<<< HEAD\no\n=======\nt\n>>>>>>> main';
    // a long intent: plain fits at a few lines of context, the intent only at zero context
    const intent = { ours: `effort knob ${'x'.repeat(1500)}`, theirs: ['feat: openrouter body (#25964)'], siblings: [{ number: 25964, title: 'openrouter body', body: 'Keep the reasoning field.', goal: null, goalPath: null, source: 'gh' as const }] };
    const intentOnly = conflictHunkResolvePrompt('f.ts', '', block, '', 'main', 0, 1, intent).length;
    const prompts: string[] = [];
    // room for the intent with zero context, but not for 40 lines of context with or without intent
    await resolveConflictByHunks('f.ts', text, 'main', intentOnly + 100, async (p) => { prompts.push(p); return 'm'; }, 40, intent);
    for (const kept of ['ours 의 의도: effort knob', 'theirs 에 먼저 착지한 변경: feat: openrouter body (#25964)', '#25964 openrouter body', 'Keep the reasoning field.']) {
      expect(prompts[0]).toContain(kept);
    }
    expect(prompts[0]!.length).toBeLessThanOrEqual(intentOnly + 100);
    // no room for the intent even with zero context → plain block prompt
    const plainOnly = conflictHunkResolvePrompt('f.ts', '', block, '', 'main', 0, 1).length;
    await resolveConflictByHunks('f.ts', text, 'main', plainOnly + 5, async (p) => { prompts.push(p); return 'm'; }, 40, intent);
    for (const dropped of ['ours 의 의도', 'theirs 에 먼저 착지한 변경', '#25964', 'Keep the reasoning field.']) {
      expect(prompts[1]).not.toContain(dropped);
    }
  });

  test('a single block over the cap → MergeConflictInputTooLarge (the old human hand-off)', async () => {
    const huge = `<<<<<<< HEAD\n${'o'.repeat(2000)}\n=======\nt\n>>>>>>> main\n`;
    await expect(resolveConflictByHunks('f.ts', huge, 'main', 500, async () => 'x')).rejects.toBeInstanceOf(MergeConflictInputTooLarge);
  });

  test('knob tools.selfImplement.mergeConflictAuto defaults on; only explicit false turns it off', () => {
    expect(mergeConflictAutoEnabled(undefined)).toBe(true);
    expect(mergeConflictAutoEnabled({})).toBe(true);
    expect(mergeConflictAutoEnabled({ tools: { selfImplement: {} } })).toBe(true);
    expect(mergeConflictAutoEnabled({ tools: { selfImplement: { mergeConflictAuto: false } } })).toBe(false);
  });
});

describe('MERGE-CONFLICT-AUTO — synthetic repo: main changed the same line first', () => {
  const roots: string[] = [];
  afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

  function repo(fillerLines: number): string {
    const root = mkdtempSync(join(tmpdir(), 'merge-conflict-auto-'));
    roots.push(root);
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    git('init', '-q'); git('checkout', '-qb', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    mkdirSync(join(root, 'src'));
    const head = filler('head', fillerLines);
    const tail = filler('tail', fillerLines);
    const file = (line: string) => `${head}\nexport const body = ${line};\n${tail}\n`;
    writeFileSync(join(root, 'src/llm.ts'), file("'base'"));
    git('add', '.'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    writeFileSync(join(root, 'src/llm.ts'), file("'effort'"));
    git('commit', '-qam', 'feat: effort');
    git('checkout', '-q', 'main');
    writeFileSync(join(root, 'src/llm.ts'), file("'openrouter'"));
    git('commit', '-qam', 'feat: openrouter body (#25964)');
    git('checkout', '-q', 'feature');
    return root;
  }

  test('large file over the cap → resolved by hunk, no markers, outside lines unchanged, observed', async () => {
    const root = repo(800);
    const prompts: string[] = [];
    const stream = (async (messages: Array<{ content: string }>) => {
      prompts.push(messages[0]!.content);
      return "export const body = 'openrouter+effort';";
    }) as unknown as Stream;
    const log = spyOn(debug, 'log');
    try {
      const outcome = await mergeMainWithLlmResolve(root, 'main', (f, c) => defaultLlmResolve(f, c, 'main', { mode: 'off', stream, mergeConflictAuto: true }), defaultGitMergeSeam());
      expect(outcome.status).toBe('llm-resolved'); // orchestrator then runs the existing post-sync regate + canAuto
      expect(outcome.resolvedFiles).toEqual(['src/llm.ts']);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.length).toBeLessThan(DEFAULT_MERGE_CONFLICT_INPUT_MAX_CHARS);
      const merged = readFileSync(join(root, 'src/llm.ts'), 'utf8');
      expect(merged.length).toBeGreaterThan(DEFAULT_MERGE_CONFLICT_INPUT_MAX_CHARS);
      expect(hasConflictMarkers(merged)).toBe(false);
      expect(merged).toContain("export const body = 'openrouter+effort';\nexport const tail0 = 0;");
      // bytes outside the conflict are exactly the original prefix and suffix
      expect(merged).toBe(`${filler('head', 800)}\nexport const body = 'openrouter+effort';\n${filler('tail', 800)}\n`);
      expect(log.mock.calls).toContainEqual(['self-dev.merge', 'merge-conflict-resolve', expect.objectContaining({ attempt: 'hunk', result: 'stitched', files: ['src/llm.ts'], hunks: 1 })]);
      expect(log.mock.calls).toContainEqual(['self-dev.merge', 'merge-conflict-resolve', expect.objectContaining({ attempt: 'merge', result: 'resolved', files: ['src/llm.ts'] })]);
    } finally { log.mockRestore(); }
  });

  test('commit failure after a hunk resolution → error outcome, merge aborted, final verdict observed as unresolved', async () => {
    const root = repo(800);
    const stream = (async () => "export const body = 'x';") as unknown as Stream;
    const git = { ...defaultGitMergeSeam(), commit: () => ({ ok: false, errorDetail: 'hook refused' }) };
    const log = spyOn(debug, 'log');
    try {
      const outcome = await mergeMainWithLlmResolve(root, 'main', (f, c) => defaultLlmResolve(f, c, 'main', { mode: 'off', stream, mergeConflictAuto: true }), git);
      expect(outcome).toMatchObject({ status: 'error', errorStep: 'commit' });
      expect(log.mock.calls).toContainEqual(['self-dev.merge', 'merge-conflict-resolve', expect.objectContaining({ attempt: 'merge', result: 'unresolved', reason: 'commit-failed', files: ['src/llm.ts'] })]);
      expect(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout).toBe('');
    } finally { log.mockRestore(); }
  });

  test('a 1,000,000-line hunk answer (past the spread limit) still resolves end to end', async () => {
    const root = repo(800);
    const answer = Array.from({ length: 1_000_000 }, (_, i) => `// r${i}`).join('\n');
    const stream = (async () => answer) as unknown as Stream;
    const outcome = await mergeMainWithLlmResolve(root, 'main', (f, c) => defaultLlmResolve(f, c, 'main', { mode: 'off', stream, mergeConflictAuto: true }), defaultGitMergeSeam());
    expect(outcome).toMatchObject({ status: 'llm-resolved', resolvedFiles: ['src/llm.ts'] });
    // the committed file holds every one of the million resolved lines, between the untouched prefix and suffix
    const committed = spawnSync('git', ['show', 'HEAD:src/llm.ts'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout;
    expect(committed).toBe(`${filler('head', 800)}\n${answer}\n${filler('tail', 800)}\n`);
  }, 60_000);

  test('knob off → the old outcome: conflict-input-too-large, no LLM call', async () => {
    const root = repo(800);
    let calls = 0;
    const stream = (async () => { calls++; return 'x'; }) as unknown as Stream;
    const outcome = await mergeMainWithLlmResolve(root, 'main', (f, c) => defaultLlmResolve(f, c, 'main', { mode: 'off', stream, mergeConflictAuto: false }), defaultGitMergeSeam());
    expect(outcome).toMatchObject({ status: 'conflict-unresolved', reason: 'conflict-input-too-large', failedFile: 'src/llm.ts' });
    expect(calls).toBe(0);
  });

  test('knob off read from config (tools.selfImplement.mergeConflictAuto: false) → old outcome, no LLM call', async () => {
    const root = repo(800);
    let calls = 0;
    const stream = (async () => { calls++; return 'x'; }) as unknown as Stream;
    setUserConfigOverlay((cfg) => ({ ...cfg, raw: { ...cfg.raw, tools: { selfImplement: { mergeConflictAuto: false } } } }));
    try {
      const outcome = await mergeMainWithLlmResolve(root, 'main', (f, c) => defaultLlmResolve(f, c, 'main', { mode: 'off', stream }), defaultGitMergeSeam());
      expect(outcome).toMatchObject({ status: 'conflict-unresolved', reason: 'conflict-input-too-large', failedFile: 'src/llm.ts' });
      expect(calls).toBe(0);
    } finally { setUserConfigOverlay(null); }
  });

  test('unresolvable: the hunk answer still holds markers → the old conflict-unresolved (HITL), base kept', async () => {
    const root = repo(800);
    const stream = (async () => '<<<<<<< HEAD\nstill\n=======\nboth\n>>>>>>> main') as unknown as Stream;
    const outcome = await mergeMainWithLlmResolve(root, 'main', (f, c) => defaultLlmResolve(f, c, 'main', { mode: 'off', stream, mergeConflictAuto: true }), defaultGitMergeSeam());
    expect(outcome).toMatchObject({ status: 'conflict-unresolved', reason: 'conflict-markers-remain', failedFile: 'src/llm.ts' });
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout).toBe(''); // merge aborted
  });

  test('intent alone breaks the cap but the plain whole file fits → the plain whole-file prompt, not hunks', async () => {
    const prompts: string[] = [];
    const stream = (async (messages: Array<{ content: string }>) => { prompts.push(messages[0]!.content); return 'resolved'; }) as unknown as Stream;
    const conflicted = '<<<<<<< HEAD\no\n=======\nt\n>>>>>>> main\n';
    const plainLen = (await import('./llm-conflict-merge.js')).conflictResolvePrompt('f.ts', conflicted, 'main').length;
    setUserConfigOverlay((cfg) => ({ ...cfg, raw: { ...cfg.raw, selfImplement: { mergeConflictInputMaxChars: plainLen + 10 } } }));
    const git = (() => ({ status: 0, stdout: `${'feat: a long subject line '.repeat(8)}\n` })) as never;
    try {
      await defaultLlmResolve('f.ts', conflicted, 'main', { mode: 'on', stream, mergeConflictAuto: true, git, siblingIntent: 'off', worktreePath: '/nonexistent' });
    } finally { setUserConfigOverlay(null); }
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('완결된 파일 전체');
    expect(prompts[0]).not.toContain('충돌 블록 1/1');
    expect(prompts[0]).not.toContain('ours 의 의도');
  });

  test('knob off ⊕ mergeIntent on ⊕ intent-only overflow → the old too-large exit, no LLM call', async () => {
    let calls = 0;
    const stream = (async () => { calls++; return 'resolved'; }) as unknown as Stream;
    const conflicted = '<<<<<<< HEAD\no\n=======\nt\n>>>>>>> main\n';
    const plainLen = (await import('./llm-conflict-merge.js')).conflictResolvePrompt('f.ts', conflicted, 'main').length;
    setUserConfigOverlay((cfg) => ({ ...cfg, raw: { ...cfg.raw, selfImplement: { mergeConflictInputMaxChars: plainLen + 10 } } }));
    const git = (() => ({ status: 0, stdout: `${'feat: a long subject line '.repeat(8)}\n` })) as never;
    try {
      await expect(defaultLlmResolve('f.ts', conflicted, 'main', { mode: 'on', stream, mergeConflictAuto: false, git, siblingIntent: 'off', worktreePath: '/nonexistent' })).rejects.toBeInstanceOf(MergeConflictInputTooLarge);
    } finally { setUserConfigOverlay(null); }
    expect(calls).toBe(0);
  });

  test('small file under the cap → the whole-file prompt, unchanged path', async () => {
    const root = repo(3);
    const prompts: string[] = [];
    const stream = (async (messages: Array<{ content: string }>) => {
      prompts.push(messages[0]!.content);
      return readFileSync(join(root, 'src/llm.ts'), 'utf8').replace(/<<<<<<< [^\n]*\n[^\n]*\n=======\n([^\n]*)\n>>>>>>> [^\n]*\n/, '$1\n');
    }) as unknown as Stream;
    const outcome = await mergeMainWithLlmResolve(root, 'main', (f, c) => defaultLlmResolve(f, c, 'main', { mode: 'off', stream, mergeConflictAuto: true }), defaultGitMergeSeam());
    expect(outcome.status).toBe('llm-resolved');
    expect(prompts[0]).toContain('완결된 파일 전체');
    expect(prompts[0]).not.toContain('충돌 블록 1/1');
  });
});
