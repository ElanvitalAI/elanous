// HARNESS-NEIGHBOR-SWEEP — 같은 callee 이웃 스윕(순수 선택 · 구조 엔진 · 상한 · 실패 무차단).
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { astGrepBinary } from '../skills/tools/ast-grep.js';
import {
  NEIGHBOR_SWEEP_DEADLINE_MS,
  NEIGHBOR_SWEEP_MAX_SITES,
  NeighborSweepTimeout,
  astGrepEngine,
  calleesInHunks,
  isSweepableCallee,
  parseNewSideHunks,
  renderNeighborSection,
  resolveNeighborSweepMode,
  runBounded,
  selectNeighborSites,
  sweepNeighbors,
  sweepWorktreeNeighbors,
  typescriptEngine,
  worktreeChangedHunks,
  type BoundedRunner,
  type StructuralCall,
  type StructuralEngine,
} from './neighbor-sweep.js';

const call = (file: string, line: number, callee: string, text = `${callee}()`): StructuralCall => ({ file, line, endLine: line, callee, text });

/** 두 파일 fixture — a.ts 의 3행이 «이번 수정»이고, 같은 callee `loadLedger` 가 a.ts·b.ts 에 더 있다. */
function twoFileFixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tc-hns-fixture-'));
  writeFileSync(join(dir, 'a.ts'), [
    "import { loadLedger, other } from './b';",
    'export function fixed() {',
    "  return loadLedger('a', { strict: true });",
    '}',
    'export function sibling() {',
    "  return loadLedger('b');",
    '}',
    "other.loadLedger('not-same-callee');",
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'b.ts'), [
    'export function loadLedger(name: string, _opts?: unknown) { return name; }',
    'export const other = { loadLedger };',
    "loadLedger(",
    "  'c',",
    ');',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'b.test.ts'), "loadLedger('ignored in tests');\n");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fixtureFiles = (): string[] => ['a.ts', 'b.ts', 'b.test.ts'];

describe('순수 선택', () => {
  test('바뀐 줄과 겹치는 호출의 callee 만 · 나온 순서 · 중복 없이', () => {
    const hunks = [{ file: 'a.ts', startLine: 3, endLine: 4 }];
    const calls = [call('a.ts', 1, 'x'), call('a.ts', 3, 'foo'), call('a.ts', 4, 'bar'), call('a.ts', 4, 'foo')];
    expect(calleesInHunks(hunks, calls)).toEqual(['foo', 'bar']);
  });

  test('시험 파일의 호출은 callee 로 뽑지 않는다 — 상한을 시험 헬퍼가 차지하지 않는다', () => {
    const hunks = [{ file: 'a.test.ts', startLine: 1, endLine: 9 }, { file: 'a.ts', startLine: 3, endLine: 3 }];
    const calls = [call('a.test.ts', 1, 'describe'), call('a.test.ts', 2, 'spyOn'), call('a.ts', 3, 'loadLedger')];
    expect(calleesInHunks(hunks, calls)).toEqual(['loadLedger']);
  });

  test('`$` 가 든 callee 는 뺀다 — ast-grep 이 메타변수로 읽어 아무 호출에나 맞기 때문 · 엔진 밖에서 걸러 두 엔진이 같다', () => {
    expect(isSweepableCallee('$A')).toBe(false);
    expect(isSweepableCallee('$.ajax')).toBe(false);
    expect(isSweepableCallee('store.$FOO')).toBe(false);
    expect(isSweepableCallee('loadLedger')).toBe(true);
    const hunks = [{ file: 'a.ts', startLine: 1, endLine: 9 }];
    const calls = [call('a.ts', 1, '$A'), call('a.ts', 2, 'store.$FOO'), call('a.ts', 3, 'loadLedger')];
    expect(calleesInHunks(hunks, calls)).toEqual(['loadLedger']);
  });

  test('두 파일에 걸친 같은 callee 이웃을 고르고 바뀐 줄 자신은 뺀다 · 덜 흔한 callee 먼저', () => {
    const hunks = [{ file: 'a.ts', startLine: 3, endLine: 3 }];
    const sitesByCallee = new Map([
      ['common', { total: 3, sample: [call('a.ts', 3, 'common'), call('b.ts', 1, 'common'), call('b.ts', 2, 'common')] }],
      ['rare', { total: 2, sample: [call('a.ts', 3, 'rare'), call('b.ts', 9, 'rare')] }],
    ]);
    const picked = selectNeighborSites({ hunks, callees: ['common', 'rare'], sitesByCallee });
    expect(picked.sites.map((site) => `${site.file}:${site.line}:${site.callee}`)).toEqual(['b.ts:9:rare', 'b.ts:1:common', 'b.ts:2:common']);
    expect(picked.totalSites).toBe(3);
    expect(picked.truncated).toBe(false);
  });

  test('상한을 지킨다 — sites 는 NEIGHBOR_SWEEP_MAX_SITES 개 · 나머지는 truncated', () => {
    const extra = 5; // 출처: 상한을 넘는 아무 양수 — 값 자체는 판정과 무관
    const sample = Array.from({ length: NEIGHBOR_SWEEP_MAX_SITES + extra }, (_, index) => call('b.ts', index + 10, 'foo'));
    const picked = selectNeighborSites({
      hunks: [{ file: 'a.ts', startLine: 1, endLine: 1 }],
      callees: ['foo'],
      sitesByCallee: new Map([['foo', { total: sample.length, sample }]]),
    });
    expect(picked.sites).toHaveLength(NEIGHBOR_SWEEP_MAX_SITES);
    expect(picked.totalSites).toBe(NEIGHBOR_SWEEP_MAX_SITES + extra);
    expect(picked.truncated).toBe(true);
  });

  test('새 쪽 줄 범위 — 삭제만이면 그 자리 한 줄 · 지운 파일은 뺀다', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,2 +3,4 @@ fn',
      '@@ -20 +22 @@',
      '@@ -30,2 +31,0 @@',
      'diff --git a/src/gone.ts b/src/gone.ts',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
    ].join('\n');
    expect(parseNewSideHunks(patch)).toEqual([
      { file: 'src/a.ts', startLine: 3, endLine: 6 },
      { file: 'src/a.ts', startLine: 22, endLine: 22 },
      { file: 'src/a.ts', startLine: 31, endLine: 31 },
    ]);
  });

  test('모드 — 생략·무효는 shadow · on/off 만 명시(허용 등급 원천)', () => {
    // 칸 43 — neighbor_sweep 은 advanced 전용: 게이트를 통과하는 등급 원천으로 모드 원본을 잰다.
    const advanced = { currentTier: () => 'advanced' };
    expect(resolveNeighborSweepMode(undefined, advanced)).toBe('shadow');
    expect(resolveNeighborSweepMode('ON', advanced)).toBe('shadow');
    expect(resolveNeighborSweepMode('on', advanced)).toBe('on');
    expect(resolveNeighborSweepMode('off', advanced)).toBe('off');
    // 칸 43 — free 미달이면 on 요청도 계산 없이 off(fail-closed · 진입점 행렬은 full-wire 시험이 잰다).
    expect(resolveNeighborSweepMode('on', { currentTier: () => 'free' })).toBe('off');
  });

  test('주입 문면 — file:line 한 줄씩 · 이웃이 없으면 빈 문자열', () => {
    const base = { outcome: 'ok' as const, engine: 'typescript' as const, hunks: 1, callees: 1, totalSites: 1, truncated: false };
    const text = renderNeighborSection({ ...base, sites: [call('b.ts', 3, 'foo', 'foo(\n  1,\n)')] }, 'review-mustfix');
    expect(text).toContain('- b.ts:3 — foo( 1, )');
    expect(text).toContain('review-mustfix');
    expect(renderNeighborSection({ ...base, sites: [] }, 'review-mustfix')).toBe('');
  });
});

describe('구조 엔진 — 두 fixture 파일', () => {
  const expectFixtureNeighbors = async (engine: StructuralEngine): Promise<void> => {
    const { dir, cleanup } = twoFileFixture();
    try {
      const result = await sweepNeighbors({ hunks: [{ file: 'a.ts', startLine: 3, endLine: 3 }], cwd: dir, engine });
      expect(result.outcome).toBe('ok');
      expect(result.engine).toBe(engine.name);
      expect(result.callees).toBe(1);
      // 같은 callee(식별자 loadLedger)만 — 바뀐 3행 자신·멤버 호출 other.loadLedger·시험 파일은 빠진다.
      expect(result.sites.map((site) => `${site.file}:${site.line}`).sort()).toEqual(['a.ts:6', 'b.ts:3']);
      expect(result.sites.every((site) => site.callee === 'loadLedger')).toBe(true);
    } finally {
      cleanup();
    }
  };

  test('TypeScript 컴파일러 API 폴백이 두 파일의 같은 callee 호출을 찾는다', async () => {
    await expectFixtureNeighbors(typescriptEngine(fixtureFiles));
  });

  const bin = astGrepBinary();
  test.skipIf(!bin)('ast-grep 엔진도 같은 이웃을 찾는다(바이너리가 있는 호스트에서만)', async () => {
    await expectFixtureNeighbors(astGrepEngine(bin!));
  });
});

describe('두 엔진이 같은 callee 집합을 받는다', () => {
  // 식별자 · this · 속성 접근 사슬만. foo().bar · a[0].b · a!.b · super.x · import() · 태그 템플릿은 둘 다 뺀다.
  const SOURCE = [
    'foo(1);',
    'a.b(2);',
    'a?.b(3);',
    'foo().bar(4);',
    'a[0].b(5);',
    'a!.b(6);',
    'gen<string>(7);',
    'x.y',
    '  .z(8);',
    'class K { #p() {} m() { this.n(9); this.#p(); super.toString(); } }',
    'o.b?.(10);',
    'tag`x`;',
    "import('./m');",
    'new Q(11);',
    '',
  ].join('\n');
  const EXPECTED = ['1:foo', '2:a.b', '3:a?.b', '4:foo', '7:gen', '8:x.y.z', '10:this.n', '10:this.#p', '11:o.b'];

  const callsOf = async (engine: StructuralEngine): Promise<string[]> => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-hns-parity-'));
    try {
      writeFileSync(join(dir, 's.ts'), SOURCE);
      const calls = await engine.callsIn(['s.ts'], dir, Date.now() + NEIGHBOR_SWEEP_DEADLINE_MS);
      return calls.map((found) => `${found.line}:${found.callee}`).sort();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const sitesOf = async (engine: StructuralEngine): Promise<string[]> => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-hns-parity-'));
    try {
      writeFileSync(join(dir, 's.ts'), SOURCE);
      const map = await engine.sitesOf(['x.y.z', 'a?.b', 'gen', 'o.b', 'this.#p'], dir, Date.now() + NEIGHBOR_SWEEP_DEADLINE_MS, NEIGHBOR_SWEEP_MAX_SITES);
      return [...map.entries()].flatMap(([callee, found]) => found.sample.map((site) => `${site.line}:${callee}:${found.total}`)).sort();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('TypeScript 엔진의 callee 집합', async () => {
    expect(await callsOf(typescriptEngine(() => ['s.ts']))).toEqual([...EXPECTED].sort());
    expect(await sitesOf(typescriptEngine(() => ['s.ts']))).toEqual(['10:this.#p:1', '11:o.b:1', '3:a?.b:1', '7:gen:1', '8:x.y.z:1']);
  });

  const parityBin = astGrepBinary();
  test.skipIf(!parityBin)('ast-grep 엔진이 같은 입력에서 같은 callee 집합·같은 이웃을 낸다', async () => {
    expect(await callsOf(astGrepEngine(parityBin!))).toEqual(await callsOf(typescriptEngine(() => ['s.ts'])));
    expect(await sitesOf(astGrepEngine(parityBin!))).toEqual(await sitesOf(typescriptEngine(() => ['s.ts'])));
  });
});

describe('실패는 라운드를 막지 않고 outcome 으로 돌아온다', () => {
  const hunks = [{ file: 'a.ts', startLine: 3, endLine: 3 }];

  test('도구 없음 → tool-missing', async () => {
    const result = await sweepNeighbors({ hunks, cwd: '/nonexistent', engine: null });
    expect(result).toMatchObject({ outcome: 'tool-missing', engine: 'none', sites: [] });
  });

  test('시한 초과 → timeout(던지지 않는다)', async () => {
    const { dir, cleanup } = twoFileFixture();
    try {
      const result = await sweepNeighbors({ hunks, cwd: dir, engine: typescriptEngine(fixtureFiles), now: () => 0, deadlineMs: -1 });
      expect(result).toMatchObject({ outcome: 'timeout', engine: 'typescript', sites: [], reason: 'NeighborSweepTimeout' });
    } finally {
      cleanup();
    }
  });

  test('엔진 예외 → error · 이유는 오류 이름만', async () => {
    const broken: StructuralEngine = {
      name: 'ast-grep',
      async callsIn() { return [call('a.ts', 3, 'foo')]; },
      async sitesOf() { throw new TypeError('secret path /home/x in message'); },
    };
    const result = await sweepNeighbors({ hunks, cwd: '/x', engine: broken });
    expect(result).toMatchObject({ outcome: 'error', reason: 'TypeError', sites: [] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('NeighborSweepTimeout 를 던지는 엔진도 timeout 으로 접힌다', async () => {
    const slow: StructuralEngine = {
      name: 'ast-grep',
      async callsIn() { throw new NeighborSweepTimeout(); },
      async sitesOf() { return new Map(); },
    };
    expect((await sweepNeighbors({ hunks, cwd: '/x', engine: slow })).outcome).toBe('timeout');
  });
});

describe('비동기 · 하나의 시한', () => {
  test('runBounded 는 시한이 오면 자식을 죽이고 timedOut 으로 돌려준다(던지지 않는다)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-hns-run-'));
    try {
      // 출처: R-TST40 — 끝나지 않는 자식에 시한 타이머가 이기는지만 본다. 값의 크기는 판정과 무관하다.
      const deadlineAt = Date.now() + 50;
      const result = await runBounded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, deadlineAt });
      expect(result).toMatchObject({ timedOut: true, code: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('시한은 스윕 시작에 한 번 정하고 탐지·git 모든 호출이 같은 시한을 받는다', async () => {
    const seen: Array<{ command: string; deadlineAt: number }> = [];
    const fake: BoundedRunner = async (command, _args, opts) => {
      seen.push({ command, deadlineAt: opts.deadlineAt });
      return { code: 1, stdout: '', timedOut: false };
    };
    const result = await sweepWorktreeNeighbors('/x', { deadlineMs: NEIGHBOR_SWEEP_DEADLINE_MS, allowFallback: true }, { run: fake, now: () => 1_000 });
    expect(result.outcome).toBe('empty');
    expect(seen.map((entry) => entry.command)).toContain('ast-grep');
    expect(seen.map((entry) => entry.command)).toContain('git');
    expect(new Set(seen.map((entry) => entry.deadlineAt))).toEqual(new Set([1_000 + NEIGHBOR_SWEEP_DEADLINE_MS]));
  });

  test('shadow 는 ast-grep 이 없으면 git 도 부르지 않고 tool-missing 으로 끝낸다', async () => {
    const commands: string[] = [];
    const fake: BoundedRunner = async (command) => { commands.push(command); return { code: null, stdout: '', timedOut: false, error: 'ENOENT' }; };
    const result = await sweepWorktreeNeighbors('/x', { deadlineMs: NEIGHBOR_SWEEP_DEADLINE_MS, allowFallback: false }, { run: fake });
    expect(result).toMatchObject({ outcome: 'tool-missing', reason: 'no-ast-grep-shadow' });
    expect(commands).not.toContain('git');
  });

  test('탐지가 시한을 넘기면 timeout', async () => {
    const fake: BoundedRunner = async () => ({ code: null, stdout: '', timedOut: true });
    expect((await sweepWorktreeNeighbors('/x', { deadlineMs: NEIGHBOR_SWEEP_DEADLINE_MS, allowFallback: true }, { run: fake })).outcome).toBe('timeout');
  });
});

describe('작업 트리 diff — 사용자 git 설정에 흔들리지 않는다', () => {
  const git = (cwd: string, args: string[]): void => {
    const proc = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    if (proc.status !== 0) throw new Error(`git ${args[0]} failed: ${proc.stderr}`);
  };

  test('diff.noprefix · 이름 바꾸기에서도 새 쪽 덩어리를 잃지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-hns-git-'));
    try {
      git(dir, ['init', '-q', '-b', 'main']);
      git(dir, ['config', 'user.email', 't@t']);
      git(dir, ['config', 'user.name', 't']);
      git(dir, ['config', 'diff.noprefix', 'true']);
      git(dir, ['config', 'diff.mnemonicPrefix', 'true']);
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
      writeFileSync(join(dir, 'old.ts'), 'export function f() {\n  return 1;\n}\n');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', 'seed']);
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\nexport const b = 3;\n');
      git(dir, ['mv', 'old.ts', 'renamed.ts']);
      writeFileSync(join(dir, 'renamed.ts'), 'export function f() {\n  return 2;\n}\n');
      const hunks = await worktreeChangedHunks(dir, Date.now() + NEIGHBOR_SWEEP_DEADLINE_MS);
      expect(hunks).toContainEqual({ file: 'a.ts', startLine: 2, endLine: 2 });
      expect(hunks.some((hunk) => hunk.file === 'renamed.ts')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
