import { test, expect, describe, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import { createTask, type Task } from '../types.js';
import {
  createSelfImplementAdapter,
  defaultSelfImplementSpawn,
  parseSelfImplementJson,
  resolveSpawnElanousBin,
  type SelfImplementJobSpawn,
  type SelfImplementJobDone,
  reportUnmappedDispositionFields,
} from './self-implement.js';

function makeTask(feature = 'add a helper', extra: Record<string, unknown> = {}): Task {
  return createTask({
    title: 'self-dev job',
    surface: { kind: 'self-implement', feature, ...extra },
    isolation: 'worktree',
  });
}

async function assertDefaultSpawnBin(cwd: string, expectedBin: string, expectedBinSource: string): Promise<void> {
  const shimDir = mkdtempSync(join(tmpdir(), 'self-implement-bun-shim-'));
  const capturePath = join(shimDir, 'spawn.txt');
  const bunShim = join(shimDir, 'bun');
  writeFileSync(bunShim, '#!/bin/sh\nprintf "%s\\n%s\\n%s\\n%s\\n" "$PWD" "$1" "$4" "$(cat "$5")" > "$ELANOUS_TEST_SPAWN_CAPTURE"\n');
  chmodSync(bunShim, 0o755);
  const launches: Array<{ bin: unknown; binSource: unknown }> = [];
  const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'self-dev.spawn' && event === 'launch') launches.push({ bin: data?.bin, binSource: data?.binSource });
  }) as typeof debug.log);
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const originalCapture = process.env.ELANOUS_TEST_SPAWN_CAPTURE;
  try {
    process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
    process.env.ELANOUS_TEST_SPAWN_CAPTURE = capturePath;
    process.chdir(cwd);
    const { done } = defaultSelfImplementSpawn()({ feature: 'verify bin root', spaceId: 'test-space' });
    await done;
    const [spawnCwd, entry, option, path] = readFileSync(capturePath, 'utf8').trim().split('\n');
    expect([spawnCwd, entry, option]).toEqual([realpathSync(cwd), expectedBin, '--feature-file']);
    expect(path).toBe('verify bin root');
    expect(launches).toEqual([{ bin: expectedBin, binSource: expectedBinSource }]);
  } finally {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCapture === undefined) delete process.env.ELANOUS_TEST_SPAWN_CAPTURE;
    else process.env.ELANOUS_TEST_SPAWN_CAPTURE = originalCapture;
    logSpy.mockRestore();
    rmSync(shimDir, { recursive: true, force: true });
  }
}

describe('self-implement surface adapter (S1 · parallel self-dev)', () => {
  test('exit 0 → completed', async () => {
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:x',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: 'done' }),
    });
    const adapter = createSelfImplementAdapter({ spawn });
    const res = await adapter(makeTask(), {});
    const exec = await res.promise;
    expect(exec.status).toBe('completed');
    expect(exec.surfaceAddress).toBe('self-impl:x');
    expect(exec.output).toBe('done');
  });

  test('non-zero exit promotes a structured child diagnostic while preserving exit code', async () => {
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:y',
      done: Promise.resolve<SelfImplementJobDone>({
        exitCode: 1,
        output: '{"stage":"error","ok":false,"error":"child diagnostic"}',
        disposition: { stage: 'error', ok: false, error: 'child diagnostic' },
      }),
    });
    const adapter = createSelfImplementAdapter({ spawn });
    const exec = await (await adapter(makeTask(), {})).promise;
    expect(exec.status).toBe('failed');
    expect(exec.error).toEqual({
      code: 'SELF_IMPL_FAILED',
      message: 'child diagnostic (self implement exited with code 1)',
    });
  });

  test('non-zero exit distinguishes empty child output from unparseable output', async () => {
    const emptySpawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:empty',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 1, output: '' }),
    });
    const unparseableSpawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:unparseable',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 1, output: 'plain child output' }),
    });

    const empty = await (await createSelfImplementAdapter({ spawn: emptySpawn })(makeTask(), {})).promise;
    const unparseable = await (await createSelfImplementAdapter({ spawn: unparseableSpawn })(makeTask(), {})).promise;
    expect(empty.error?.message).toBe('self implement exited with code 1 (child produced no output)');
    expect(unparseable.error?.message).toBe('self implement exited with code 1 (child output did not contain a parseable terminal JSON diagnostic)');
  });

  test('long child output labels its UTF-8 tail as an upper bound without splitting Unicode', async () => {
    // 4,098 bytes: the 4,096-byte boundary starts inside the first `한`, so
    // preserving valid UTF-8 skips its remaining bytes and yields a shorter tail.
    const output = `x${'한'.repeat(1_363)}😀끝z`;
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:long-output',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 1, output }),
    });
    const exec = await (await createSelfImplementAdapter({ spawn })(makeTask(), {})).promise;
    const marker = '[output truncated to at most 4096 UTF-8 bytes]\n';
    const tail = exec.output!.slice(marker.length);
    expect(exec.output).toStartWith(marker);
    expect(Buffer.byteLength(tail, 'utf8')).toBe(4_094);
    expect(tail).toEndWith('😀끝z');
    expect(tail).not.toContain('\uFFFD');
  });

  test('explicit child error remains higher priority than a parsed diagnostic', async () => {
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:explicit-error',
      done: Promise.resolve<SelfImplementJobDone>({
        exitCode: 1,
        output: '{"stage":"error","ok":false,"error":"parsed diagnostic"}',
        error: { code: 'SELF_IMPL_SPAWN_FAILED', message: 'explicit error' },
        disposition: { stage: 'error', ok: false, error: 'parsed diagnostic' },
      }),
    });
    const exec = await (await createSelfImplementAdapter({ spawn })(makeTask(), {})).promise;
    expect(exec.error).toEqual({ code: 'SELF_IMPL_SPAWN_FAILED', message: 'explicit error' });
  });

  test('spawn throws synchronously → failed (SPAWN_FAILED)', async () => {
    const spawn: SelfImplementJobSpawn = () => { throw new Error('no bun'); };
    const adapter = createSelfImplementAdapter({ spawn });
    const exec = await (await adapter(makeTask(), {})).promise;
    expect(exec.status).toBe('failed');
    expect(exec.error?.code).toBe('SELF_IMPL_SPAWN_FAILED');
    expect(exec.error?.message).toContain('no bun');
  });

  test('aborted signal wins over exit code → cancelled', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const spawn: SelfImplementJobSpawn = () => ({
      address: 'self-impl:z',
      done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: 'ok' }),
    });
    const adapter = createSelfImplementAdapter({ spawn });
    const exec = await (await adapter(makeTask(), { signal: ctrl.signal })).promise;
    expect(exec.status).toBe('cancelled');
    expect(exec.error?.code).toBe('ABORTED');
  });

  test('surface fields (base/autoMerge/draft) + distinct space id flow to spawn', async () => {
    let seen: Parameters<SelfImplementJobSpawn>[0] | null = null;
    const spawn: SelfImplementJobSpawn = (input) => {
      seen = input;
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve<SelfImplementJobDone>({ exitCode: 0, output: '' }) };
    };
    const adapter = createSelfImplementAdapter({ spawn });
    const task = makeTask('build X', { base: 'origin/main', autoMerge: true, draft: false });
    await (await adapter(task, {})).promise;
    expect(seen!.feature).toBe('build X');
    expect(seen!.base).toBe('origin/main');
    expect(seen!.autoMerge).toBe(true);
    expect(seen!.draft).toBe(false);
    // space id is derived from the task id → distinct per job.
    expect(seen!.spaceId).toContain(task.id.replace('task:', ''));
  });

  test('a task surface forwards its after goal ID or PR number to the Pod spawn input', async () => {
    const seen: Array<string | number | undefined> = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      seen.push(input.after);
      return { address: 'self-impl:after', done: Promise.resolve({ exitCode: 0, output: '' }) };
    };
    const adapter = createSelfImplementAdapter({ spawn });
    for (const after of ['goal-before', 123]) {
      await (await adapter(makeTask('dependent', { after }), {})).promise;
    }
    await (await adapter(makeTask('independent'), {})).promise;
    expect(seen).toEqual(['goal-before', 123, undefined]);
  });

  test('production spawn falls back to this elanous bin outside a git repository', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'self-implement-bin-fallback-'));
    try {
      const expectedBin = resolve(import.meta.dir, '../../../bin/elanous.mjs');
      expect(existsSync(expectedBin)).toBe(true);
      await assertDefaultSpawnBin(cwd, expectedBin, 'source-tree-fallback');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('production spawn falls back from an external git repository with a directory entrypoint', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'self-implement-bin-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd });
      writeFileSync(join(cwd, 'README.md'), '# external product\n');
      mkdirSync(join(cwd, 'bin'));
      mkdirSync(join(cwd, 'bin', 'elanous.mjs'));
      const expectedBin = resolve(import.meta.dir, '../../../bin/elanous.mjs');
      await assertDefaultSpawnBin(cwd, expectedBin, 'source-tree-fallback');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('production spawn keeps this elanous repository bin', async () => {
    const elanousRoot = resolve(import.meta.dir, '../../..');
    await assertDefaultSpawnBin(elanousRoot, join(elanousRoot, 'bin', 'elanous.mjs'), 'cwd-repository');
  });

  test('resolveSpawnElanousBin uses only regular repository entrypoints and reports missing candidates', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'self-implement-selector-'));
    const missingSourceRoot = mkdtempSync(join(tmpdir(), 'self-implement-missing-source-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd });
      mkdirSync(join(cwd, 'bin'));
      mkdirSync(join(cwd, 'bin', 'elanous.mjs'));
      expect(resolveSpawnElanousBin(cwd)).toEqual({
        bin: resolve(import.meta.dir, '../../../bin/elanous.mjs'),
        source: 'source-tree-fallback',
      });
      rmSync(join(cwd, 'bin'), { recursive: true, force: true });
      expect(() => resolveSpawnElanousBin(cwd, missingSourceRoot)).toThrow(/tried .*bin\/elanous\.mjs/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(missingSourceRoot, { recursive: true, force: true });
    }
  });

  test('parseSelfImplementJson — extracts disposition from --json tail', () => {
    const stdout = 'some progress line\n{"ok":true,"stage":"merged","branch":"b","prUrl":"https://x/1","prNumber":1,"merged":true}';
    const d = parseSelfImplementJson(stdout);
    expect(d).toMatchObject({ ok: true, stage: 'merged', prUrl: 'https://x/1', prNumber: 1, merged: true });
  });

  test('parseSelfImplementJson — preserves the child run id in both identity fields only when nonblank', () => {
    const d = parseSelfImplementJson('{"stage":"merged","ok":true,"runId":"run-child-1"}');
    expect(d).toMatchObject({ runId: 'run-child-1', childRunId: 'run-child-1' });
    for (const runId of ['', '   ', 123, null]) {
      const invalid = parseSelfImplementJson(JSON.stringify({ stage: 'merged', ok: true, runId }));
      expect(invalid).not.toHaveProperty('runId');
      expect(invalid).not.toHaveProperty('childRunId');
    }
  });

  test('parseSelfImplementJson — retains a non-empty terminal error diagnostic', () => {
    const d = parseSelfImplementJson('{"stage":"error","ok":false,"error":"unable to derive isolated child universe"}');
    expect(d).toMatchObject({ stage: 'error', ok: false, error: 'unable to derive isolated child universe' });
    expect(parseSelfImplementJson('{"stage":"error","ok":false,"error":"  "}')).not.toHaveProperty('error');
  });

  test('parseSelfImplementJson — preserves valid provider failure evidence and omits invalid evidence', () => {
    const providerErrors = { count: 5, provider: 'grok', category: 'quota' };
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'timed-out', providerErrors }))?.providerErrors).toEqual({ ...providerErrors, category: 'quota' });
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'timed-out', providerErrors: { ...providerErrors, category: 'invalid' } }))).not.toHaveProperty('providerErrors');
    expect(parseSelfImplementJson('{"stage":"timed-out"}')).not.toHaveProperty('providerErrors');
  });

  test('parseSelfImplementJson — null when no JSON line', () => {
    expect(parseSelfImplementJson('just progress\nno json here')).toBeNull();
  });

  test('parseSelfImplementJson — picks the last JSON object (ignores earlier noise)', () => {
    const d = parseSelfImplementJson('{"stage":"early"}\nmid\n{"ok":false,"stage":"gate-failed"}');
    expect(d).toMatchObject({ ok: false, stage: 'gate-failed' });
  });

  test('wrong surface kind → throws (guard)', async () => {
    const adapter = createSelfImplementAdapter({ spawn: () => ({ address: 'x', done: Promise.resolve({ exitCode: 0, output: '' }) }) });
    const bad = createTask({ title: 't', surface: { kind: 'llm-direct', prompt: 'hi' } });
    let msg = '';
    try { await adapter(bad, {}); } catch (e) { msg = String((e as Error).message); }
    expect(msg).toContain('wrong kind');
  });
});

// ⛔⭐⭐⭐ `A1`·`A2`(2026-08-19 · 대표 *"R3 가 서브 프로세스여도 잘 도는 안"*)
//   🚨 이 계약이 깨지면 트리아지가 「도구 한계」와 「자식이 못 함」을 «같은 칸»으로 본다.
//     그리고 그 실패는 «조용하다» — 2026-08-19 까지 아무도 몰랐다.
describe('parseSelfImplementJson — 판정 3종이 «전선을 건넌다» (A1)', () => {
  const line = (o: Record<string, unknown>) => `noise\n${JSON.stringify(o)}\n`;

  test('⭐ mergeReason · stopReason · completionDisposition 을 «전부» 옮긴다', () => {
    const d = parseSelfImplementJson(line({
      stage: 'pr-opened', ok: true,
      mergeReason: 'review-diff-truncated',
      stopReason: 'max-rounds',
      completionDisposition: 'unconverged',
    }))!;
    expect(d.mergeReason).toBe('review-diff-truncated');
    expect(d.stopReason).toBe('max-rounds');
    expect(d.completionDisposition).toBe('unconverged');
  });

  test('failureClassification 을 전선에 싣고 completionDisposition 은 독립으로 보존한다', () => {
    const d = parseSelfImplementJson(line({
      stage: 'review-blocked', ok: false,
      completionDisposition: 'completed-without-changes',
      failureClassification: 'goal-unconvergeable-candidate',
    }))!;
    expect(d.failureClassification).toBe('goal-unconvergeable-candidate');
    expect(d.completionDisposition).toBe('completed-without-changes');
  });

  test('자식 JSON 의 abandonedClassification.classification 도 failureClassification 으로 보존한다', () => {
    const d = parseSelfImplementJson(line({
      stage: 'review-blocked', ok: false,
      completionDisposition: 'completed-without-changes',
      abandonedClassification: { classification: 'goal-unconvergeable-candidate' },
    }))!;
    expect(d.failureClassification).toBe('goal-unconvergeable-candidate');
    expect(d.completionDisposition).toBe('completed-without-changes');
  });

  test('어휘 밖 분류 문자열은 failureClassification 칸을 만들지 않는다', () => {
    const d = parseSelfImplementJson(line({
      stage: 'review-blocked', ok: false,
      failureClassification: 'not-a-classification',
      completionDisposition: 'completed-without-changes',
    }))!;
    expect(d.failureClassification).toBeUndefined();
    expect(d.completionDisposition).toBe('completed-without-changes');
  });

  test('⛔ 빈 문자열은 «없는 것»이다 — 빈 값으로 판정하지 않는다', () => {
    const d = parseSelfImplementJson(line({ stage: 'merged', ok: true, mergeReason: '   ' }))!;
    expect(d.mergeReason).toBeUndefined();
  });

  test('종전 칸들은 그대로다 (회귀)', () => {
    const d = parseSelfImplementJson(line({
      stage: 'merged', ok: true, branch: 'b', prNumber: 7, merged: true,
    }))!;
    expect(d.stage).toBe('merged');
    expect(d.prNumber).toBe(7);
    expect(d.merged).toBe(true);
  });
});

describe('reportUnmappedDispositionFields — 파서가 «버린 칸»을 말한다 (A2)', () => {
  test('⭐ 인식 못 한 키를 «이름으로» 낸다 — 이것이 다음 결손을 «값»으로 만든다', () => {
    const unmapped = reportUnmappedDispositionFields(
      { stage: 'merged', ok: true, futureJudgment: 'x', anotherOne: 1 },
      { stage: 'merged', ok: true },
    );
    expect([...unmapped].sort()).toEqual(['anotherOne', 'futureJudgment']);
  });

  test('전부 인식했으면 빈 목록 — 소음을 만들지 않는다', () => {
    expect(reportUnmappedDispositionFields({ stage: 'm' }, { stage: 'm' })).toEqual([]);
  });

  test('⛔ undefined 값은 «버린 것»이 아니다', () => {
    expect(reportUnmappedDispositionFields({ stage: 'm', gone: undefined }, { stage: 'm' })).toEqual([]);
  });
});

describe('reviewGateFields — E4 벤치 칸', () => {
  test('gate.passed · 리뷰 판정 · must-fix 수를 옮기고, 리뷰를 «안 한» 판(reviewed=false)은 리뷰 칸을 싣지 않는다', async () => {
    const { reviewGateFields } = await import('./self-implement.js');
    expect(reviewGateFields({ gate: { passed: true }, review: { verdict: 'warn', mustFix: ['a', 'b'], reviewed: true } }))
      .toEqual({ gatePassed: true, reviewVerdict: 'warn', reviewMustFixCount: 2 });
    expect(reviewGateFields({ gate: { passed: false }, review: { verdict: 'pass', mustFix: [], reviewed: false } }))
      .toEqual({ gatePassed: false });
    expect(reviewGateFields({ gate: 'x', review: [] })).toEqual({});
  });
});
