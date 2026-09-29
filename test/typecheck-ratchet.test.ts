import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFileTypecheck } from '../src/self-implement/seams.js';
import { regenerateTestTypecheckBaseline } from '../scripts/regenerate-test-typecheck-baseline.js';
import { TEST_TYPECHECK_BASELINE, TYPECHECK_COMPLETION_RULERS, TYPECHECK_GATE_CONFIG, TYPECHECK_PROJECT_CONFIG, assessTypecheckCompletionRuler, classifyFieldWiring, classifyTypecheckErrors, collectTypecheckCompletion, diffTypecheckDiagnostics, isBaselineExemptTestFile, judgeTypecheckCompletion, missingTypecheckGateConfig, parseTypecheckErrors, promotedConsumersFromDiff, readTestTypecheckBaseline, resolveTypecheckConfig } from '../src/typecheck-ratchet.js';

const diagnostic = (file: string, number: number) => ({ file, line: `${file}(${number},1): error TS2322: broken`, code: 'TS2322' });
const tscError = (file: string, number = 1) => `${file}(${number},1): error TS2322: broken\n`;
const completed = (out: string, status = out ? 1 : 0) => ({ out, status, signal: null, durationMs: 1 });

function withTemporaryBaseline(content: string, run: (cwd: string, baseline: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'typecheck-ratchet-'));
  const baseline = join(cwd, TEST_TYPECHECK_BASELINE);
  writeFileSync(join(cwd, TYPECHECK_GATE_CONFIG), '{}');
  // The PWA gate fails closed if the fixture has no workspace config.
  mkdirSync(join(cwd, 'apps/pwa'), { recursive: true });
  writeFileSync(join(cwd, 'apps/pwa/tsconfig.json'), '{}');
  writeFileSync(baseline, content);
  try {
    run(cwd, baseline);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('typecheck gate configuration', () => {
  it('reports a missing repository gate configuration by its configured name', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'missing-typecheck-gate-config-'));
    try {
      expect(missingTypecheckGateConfig(cwd)).toEqual({
        config: TYPECHECK_GATE_CONFIG,
        path: join(cwd, TYPECHECK_GATE_CONFIG),
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not report the gate configuration missing when the worktree provides it', () => {
    withTemporaryBaseline('', (cwd) => {
      writeFileSync(join(cwd, TYPECHECK_GATE_CONFIG), '{}');
      expect(missingTypecheckGateConfig(cwd)).toBeNull();
    });
  });

  it('picks tsconfig.gate.json when both configs exist, tsconfig.json when that is the only one, and null when neither exists', () => {
    const both = mkdtempSync(join(tmpdir(), 'resolve-typecheck-both-'));
    const projectOnly = mkdtempSync(join(tmpdir(), 'resolve-typecheck-project-'));
    const neither = mkdtempSync(join(tmpdir(), 'resolve-typecheck-neither-'));
    try {
      writeFileSync(join(both, TYPECHECK_GATE_CONFIG), '{}');
      writeFileSync(join(both, TYPECHECK_PROJECT_CONFIG), '{}');
      writeFileSync(join(projectOnly, TYPECHECK_PROJECT_CONFIG), '{}');
      expect(resolveTypecheckConfig(both)).toEqual({
        config: TYPECHECK_GATE_CONFIG,
        path: join(both, TYPECHECK_GATE_CONFIG),
      });
      expect(resolveTypecheckConfig(projectOnly)).toEqual({
        config: TYPECHECK_PROJECT_CONFIG,
        path: join(projectOnly, TYPECHECK_PROJECT_CONFIG),
      });
      expect(resolveTypecheckConfig(neither)).toBeNull();
    } finally {
      rmSync(both, { recursive: true, force: true });
      rmSync(projectOnly, { recursive: true, force: true });
      rmSync(neither, { recursive: true, force: true });
    }
  });
});

describe('typecheck completion rulers', () => {
  it('names all three completion-ruler configs while preserving the existing gate config', () => {
    expect(TYPECHECK_GATE_CONFIG).toBe('tsconfig.gate.json');
    expect(TYPECHECK_COMPLETION_RULERS).toEqual([
      { name: 'root TypeScript project', config: 'tsconfig.json' },
      { name: 'changed-file typecheck gate', config: 'tsconfig.gate.json' },
      { name: 'PWA workspace', config: 'apps/pwa/tsconfig.json' },
    ]);
  });
});

describe('typecheck completion judgment', () => {
  const [root, gate, pwa] = TYPECHECK_COMPLETION_RULERS;

  it('reports all-clean ordered rulers as clean', () => {
    const judgment = judgeTypecheckCompletion([
      assessTypecheckCompletionRuler(root, completed('')),
      assessTypecheckCompletionRuler(gate, completed('')),
      assessTypecheckCompletionRuler(pwa, completed('')),
    ]);
    expect(judgment).toMatchObject({ status: 'clean', clean: true });
    expect(judgment.rulers.map((result) => result.ruler.config)).toEqual(TYPECHECK_COMPLETION_RULERS.map((ruler) => ruler.config));
    expect(judgment.rulers.map((result) => result.status)).toEqual(['clean', 'clean', 'clean']);
  });

  it('preserves diagnostic detail and marks completed red runs separately from unavailable ones', () => {
    const unavailable = { out: '', status: null, signal: null, error: new Error('tsc unavailable'), durationMs: 2 };
    const judgment = judgeTypecheckCompletion([
      assessTypecheckCompletionRuler(root, completed('')),
      assessTypecheckCompletionRuler(gate, completed(`${tscError('src/one.ts')}${tscError('src/two.ts', 2)}`)),
      assessTypecheckCompletionRuler(pwa, unavailable),
    ]);
    expect(judgment).toMatchObject({ status: 'unavailable', clean: false });
    expect(judgment.rulers.map((result) => result.status)).toEqual(['clean', 'diagnostics', 'unavailable']);
    expect(judgment.rulers[1]!.assessment.diagnostics).toEqual([diagnostic('src/one.ts', 1), diagnostic('src/two.ts', 2)]);
    expect(judgment.rulers[2]!.assessment.failureLog).toContain('tsc unavailable');
  });

  it('reports one or many completed diagnostics as not clean without treating them as unavailable', () => {
    const judgment = judgeTypecheckCompletion([
      assessTypecheckCompletionRuler(root, completed(tscError('src/one.ts'))),
      assessTypecheckCompletionRuler(gate, completed(`${tscError('src/two.ts')}${tscError('src/three.ts')}`)),
      assessTypecheckCompletionRuler(pwa, completed('')),
    ]);
    expect(judgment).toMatchObject({ status: 'diagnostics', clean: false });
    expect(judgment.rulers.map((result) => result.status)).toEqual(['diagnostics', 'diagnostics', 'clean']);
  });

  it('treats missing, empty, or reordered declared rulers as unavailable rather than clean', () => {
    const cleanRoot = assessTypecheckCompletionRuler(root, completed(''));
    const cleanGate = assessTypecheckCompletionRuler(gate, completed(''));
    const cleanPwa = assessTypecheckCompletionRuler(pwa, completed(''));
    for (const rulers of [[], [cleanRoot, cleanGate], [cleanGate, cleanRoot, cleanPwa]]) {
      expect(judgeTypecheckCompletion(rulers)).toMatchObject({ status: 'unavailable', clean: false });
    }
  });

  it('treats a single unavailable ruler as not clean', () => {
    const judgment = judgeTypecheckCompletion([
      assessTypecheckCompletionRuler(root, completed('')),
      assessTypecheckCompletionRuler(gate, { out: '', status: null, signal: null, error: new Error('spawn failed'), durationMs: 1 }),
      assessTypecheckCompletionRuler(pwa, completed('')),
    ]);
    expect(judgment).toMatchObject({ status: 'unavailable', clean: false });
  });

  it('collects declared rulers in order, keeps failures isolated, and preserves every outcome', () => {
    const called: string[] = [];
    const judgment = collectTypecheckCompletion((config) => {
      called.push(config);
      if (config === TYPECHECK_GATE_CONFIG) throw new Error('gate runner unavailable');
      return config === 'apps/pwa/tsconfig.json'
        ? completed(tscError('apps/pwa/src/red.ts'))
        : completed('');
    });
    expect(called).toEqual(TYPECHECK_COMPLETION_RULERS.map((ruler) => ruler.config));
    expect(judgment).toMatchObject({ status: 'unavailable', clean: false });
    expect(judgment.rulers.map((result) => result.status)).toEqual(['clean', 'unavailable', 'diagnostics']);
    expect(judgment.rulers[1]!.assessment.failureLog).toContain('gate runner unavailable');
    expect(judgment.rulers[2]!.assessment.diagnostics).toEqual([diagnostic('apps/pwa/src/red.ts', 1)]);
  });
});

describe('parsed field wiring', () => {
  it('preserves the TypeScript diagnostic code without changing file or line', () => {
    expect(parseTypecheckErrors("src/example.ts(12,3): error TS2353: Object literal may only specify known properties, and 'recentStepCounts' does not exist.\n")).toEqual([
      {
        file: 'src/example.ts',
        line: "src/example.ts(12,3): error TS2353: Object literal may only specify known properties, and 'recentStepCounts' does not exist.",
        code: 'TS2353',
      },
    ]);
  });

  it('identifies test-only injections and a non-test read across both test-path conventions', () => {
    const result = classifyFieldWiring('recentStepCounts', [
      ...parseTypecheckErrors("test/goal-author-decompose.test.ts(4,1): error TS2353: Object literal may only specify known properties, and 'recentStepCounts' does not exist.\n"),
      ...parseTypecheckErrors("src/goal-author-decompose.test.ts(5,1): error TS2353: Object literal may only specify known properties, and 'recentStepCounts' does not exist.\n"),
      ...parseTypecheckErrors("src/goal-author-decompose.ts(6,1): error TS2339: Property 'recentStepCounts' does not exist on type 'Config'.\n"),
    ]);
    expect(result).toEqual({
      field: 'recentStepCounts',
      injectionSites: { test: 2, nonTest: 0 },
      readSites: { test: 0, nonTest: 1 },
      status: 'unwired',
    });
  });

  it('identifies a non-test injection with no non-test read as unread', () => {
    const result = classifyFieldWiring('recentStepCounts', parseTypecheckErrors(
      "src/goal-author-decompose.ts(4,1): error TS2353: Object literal may only specify known properties, and 'recentStepCounts' does not exist.\n",
    ));
    expect(result).toEqual({
      field: 'recentStepCounts',
      injectionSites: { test: 0, nonTest: 1 },
      readSites: { test: 0, nonTest: 0 },
      status: 'unread',
    });
  });

  it('recognizes non-test injection and read sites as wired', () => {
    const result = classifyFieldWiring('recentStepCounts', parseTypecheckErrors([
      "src/goal-author-decompose.ts(4,1): error TS2353: Object literal may only specify known properties, and 'recentStepCounts' does not exist.",
      "src/goal-author-decompose.ts(6,1): error TS2339: Property 'recentStepCounts' does not exist on type 'Config'.",
    ].join('\n')));
    expect(result).toEqual({
      field: 'recentStepCounts',
      injectionSites: { test: 0, nonTest: 1 },
      readSites: { test: 0, nonTest: 1 },
      status: 'wired',
    });
  });

  it('unions never-substitution TS2345 injections while preserving deletion-only reads', () => {
    const deletionErrors = parseTypecheckErrors(
      "src/goal-author-decompose.ts(6,1): error TS2339: Property 'recentStepCounts' does not exist on type 'Config'.\n",
    );
    const neverSubstitutionErrors = parseTypecheckErrors(
      "src/boot/daemon-tools/self-implement.ts(270,1): error TS2345: Argument of type '{ recentStepCounts: readonly number[]; }' is not assignable to parameter of type '{ recentStepCounts?: never; }'.\n",
    );
    expect(classifyFieldWiring('recentStepCounts', deletionErrors, neverSubstitutionErrors)).toEqual({
      field: 'recentStepCounts',
      injectionSites: { test: 0, nonTest: 1 },
      readSites: { test: 0, nonTest: 1 },
      status: 'wired',
    });
  });
});

describe('diagnostic multiset diff', () => {
  it('separates new, existing, and removed diagnostics by file identity while ignoring location changes', () => {
    const result = diffTypecheckDiagnostics(
      [diagnostic('src/current.ts', 10), diagnostic('src/new.ts', 1)],
      [diagnostic('src/current.ts', 1), diagnostic('src/removed.ts', 1)],
    );
    expect(result.existing).toEqual([diagnostic('src/current.ts', 10)]);
    expect(result.added).toEqual([diagnostic('src/new.ts', 1)]);
    expect(result.removed).toEqual([diagnostic('src/removed.ts', 1)]);
  });

  it('preserves duplicate diagnostic counts', () => {
    const one = diagnostic('src/debt.ts', 1);
    const result = diffTypecheckDiagnostics([one, one], [one]);
    expect(result.existing).toEqual([one]);
    expect(result.added).toEqual([one]);
    expect(result.removed).toEqual([]);
  });

  it('preserves message prefixes containing colon-space when matching diagnostics', () => {
    const inherited = {
      file: 'src/debt.ts',
      code: 'TS2322',
      line: 'src/debt.ts(1,1): error TS2322: inherited prefix: shared suffix',
    };
    const introduced = {
      file: 'src/debt.ts',
      code: 'TS2322',
      line: 'src/debt.ts(2,1): error TS2322: introduced prefix: shared suffix',
    };
    const result = diffTypecheckDiagnostics([inherited, introduced], [inherited]);
    expect(result.existing).toEqual([inherited]);
    expect(result.added).toEqual([introduced]);
    expect(result.removed).toEqual([]);
  });

  it('promotes only added diagnostics outside changed files within the included project', () => {
    const current = [
      diagnostic('src/inherited.ts', 8),
      diagnostic('src/changed.ts', 2),
      diagnostic('./src/new.ts', 4),
      diagnostic('src/new.ts', 5),
      diagnostic('apps/pwa/src/outside.tsx', 3),
    ];
    const diff = diffTypecheckDiagnostics(current, [diagnostic('src/inherited.ts', 1)]);
    const changed = new Set(['src/changed.ts']);
    const include = (file: string) => file.startsWith('src/');
    expect(promotedConsumersFromDiff(diff, changed, include)).toEqual(new Set(['src/new.ts']));
    expect(changed).toEqual(new Set(['src/changed.ts']));
    expect(diff.added).toEqual(current.slice(1));
    expect(promotedConsumersFromDiff(diff, changed, (file) => file.startsWith('apps/pwa/')))
      .toEqual(new Set(['apps/pwa/src/outside.tsx']));
    expect(promotedConsumersFromDiff(diff, changed, () => false)).toEqual(new Set());
  });

  it('does not promote a changed file when both diagnostic and changed paths start with ./', () => {
    const diff = diffTypecheckDiagnostics(
      [diagnostic('./src/new.ts', 1), diagnostic('./src/consumer.ts', 2)],
      [],
    );
    const changed = new Set(['./src/new.ts']);
    expect(promotedConsumersFromDiff(diff, changed, (file) => file.startsWith('src/')))
      .toEqual(new Set(['src/consumer.ts']));
    expect(changed).toEqual(new Set(['./src/new.ts']));
  });
});

describe('test typecheck ratchet', () => {
  it('exempts only the recorded count of existing diagnostics in a baseline test file', () => {
    const result = classifyTypecheckErrors(
      [diagnostic('test/debt.test.ts', 1), diagnostic('test/debt.test.ts', 2)],
      new Set(['test/debt.test.ts']),
      new Map([['test/debt.test.ts', 2]]),
    );
    expect(result.failing).toHaveLength(0);
    expect(result.exempted).toHaveLength(2);
  });

  it('fails a diagnostic that exceeds a baseline test file count', () => {
    const result = classifyTypecheckErrors(
      [diagnostic('test/debt.test.ts', 1), diagnostic('test/debt.test.ts', 2), diagnostic('test/debt.test.ts', 3)],
      new Set(['test/debt.test.ts']),
      new Map([['test/debt.test.ts', 2]]),
    );
    expect(result.exempted).toHaveLength(2);
    expect(result.failing).toEqual([diagnostic('test/debt.test.ts', 3)]);
  });

  it('keeps baseline-outside tests and source or script diagnostics touch-clean', () => {
    const testResult = classifyTypecheckErrors([diagnostic('test/new.test.ts', 1)], new Set(['test/new.test.ts']), new Map());
    const sourceResult = classifyTypecheckErrors([diagnostic('src/broken.ts', 1)], new Set(['src/broken.ts']), new Map([['src/broken.ts', 1]]));
    const scriptResult = classifyTypecheckErrors([diagnostic('scripts/broken.ts', 1)], new Set(['scripts/broken.ts']), new Map([['scripts/broken.ts', 1]]));
    expect(testResult.failing).toHaveLength(1);
    expect(sourceResult.failing).toHaveLength(1);
    expect(scriptResult.failing).toHaveLength(1);
  });

  it('parses only explicit counted baseline entries', () => {
    withTemporaryBaseline('test/two.test.ts\t2\n', (cwd) => {
      expect(readTestTypecheckBaseline(cwd)).toEqual(new Map([['test/two.test.ts', 2]]));
    });
  });

  it('rejects legacy path-only baseline entries rather than silently granting an exemption', () => {
    withTemporaryBaseline('test/legacy.test.ts\n', (cwd) => {
      expect(() => readTestTypecheckBaseline(cwd)).toThrow('invalid baseline entry');
    });
  });

  it('passes an actual gate run when a baseline test file has only its recorded existing diagnostic', () => {
    withTemporaryBaseline('test/existing.test.ts\t1\n', (cwd) => {
      const result = changedFileTypecheck(cwd, ['test/existing.test.ts'], () => completed(tscError('test/existing.test.ts')), { config: TYPECHECK_GATE_CONFIG, path: join(cwd, TYPECHECK_GATE_CONFIG) });
      expect(result.passed).toBeTrue();
      expect(result.errors).toBe(0);
      expect(result.exempted).toBe(1);
    });
  });

  it('fails an actual gate run when a baseline test file exceeds its recorded count', () => {
    withTemporaryBaseline('test/existing.test.ts\t1\n', (cwd) => {
      const result = changedFileTypecheck(cwd, ['test/existing.test.ts'], () => completed(`${tscError('test/existing.test.ts', 1)}${tscError('test/existing.test.ts', 2)}`));
      expect(result.passed).toBeFalse();
      expect(result.errors).toBe(1);
      expect(result.exempted).toBe(1);
    });
  });

  it('does not auto-add a new failing test to the baseline through the actual gate path', () => {
    withTemporaryBaseline('test/existing.test.ts\t1\n', (cwd, baseline) => {
      const before = readFileSync(baseline, 'utf8');
      const result = changedFileTypecheck(cwd, ['test/new.test.ts'], () => completed(tscError('test/new.test.ts')));
      expect(result.passed).toBeFalse();
      expect(result.errors).toBe(1);
      expect(result.exempted).toBe(0);
      expect(readFileSync(baseline, 'utf8')).toBe(before);
    });
  });

  it('fails closed on a changed PWA file when the workspace config is absent', () => {
    withTemporaryBaseline('', (cwd) => {
      rmSync(join(cwd, 'apps/pwa/tsconfig.json'));
      const calls: string[][] = [];
      const result = changedFileTypecheck(cwd, ['apps/pwa/src/product.ts'], (_cmd, args) => {
        calls.push(args);
        return completed('');
      });
      expect(result.passed).toBeFalse();
      expect(result.log).toContain('PWA 타입 검사 설정이 없어');
      expect(calls).toEqual([['tsc', '--noEmit', '-p', 'tsconfig.gate.json']]);
    });
  });

  it('runs the PWA workspace check and fails a changed PWA product diagnostic', () => {
    withTemporaryBaseline('', (cwd) => {
      const calls: string[][] = [];
      const result = changedFileTypecheck(cwd, ['apps/pwa/src/product.ts'], (_cmd, args) => {
        calls.push(args);
        return args.includes('apps/pwa/tsconfig.json')
          ? completed(tscError('apps/pwa/src/product.ts'))
          : completed('');
      });
      expect(calls).toEqual([
        ['tsc', '--noEmit', '-p', 'tsconfig.gate.json'],
        ['tsc', '--noEmit', '-p', 'apps/pwa/tsconfig.json'],
      ]);
      expect(result).toMatchObject({ passed: false, executed: true, errors: 1, exempted: 0 });
      expect(result.log).toContain('apps/pwa/src/product.ts(1,1): error TS2322: broken');
    });
  });

  it('permits a recorded PWA test diagnostic and combines its exemption with the root result', () => {
    withTemporaryBaseline('apps/pwa/src/existing.test.ts\t1\n', (cwd) => {
      const result = changedFileTypecheck(cwd, ['apps/pwa/src/existing.test.ts'], (_cmd, args) => completed(
        args.includes('apps/pwa/tsconfig.json') ? tscError('apps/pwa/src/existing.test.ts') : '',
      ));
      expect(result).toMatchObject({ passed: true, executed: true, errors: 0, exempted: 1 });
    });
  });

  it('does not launch a PWA check for a non-PWA change', () => {
    withTemporaryBaseline('', (cwd) => {
      const calls: string[][] = [];
      const result = changedFileTypecheck(cwd, ['src/product.ts'], (_cmd, args) => {
        calls.push(args);
        return completed('');
      });
      expect(calls).toEqual([['tsc', '--noEmit', '-p', 'tsconfig.gate.json']]);
      expect(result).toEqual({ passed: true, executed: true, checked: 1, errors: 0, exempted: 0, noInspectionReason: null, log: '' });
    });
  });

  it('fails closed and preserves the PWA execution failure log when its check cannot run', () => {
    withTemporaryBaseline('', (cwd) => {
      const result = changedFileTypecheck(cwd, ['apps/pwa/src/product.ts'], (_cmd, args) => (
        args.includes('apps/pwa/tsconfig.json')
          ? { out: '', status: null, signal: null, error: new Error('PWA tsc missing'), durationMs: 1 }
          : completed('')
      ));
      expect(result).toMatchObject({ passed: false, executed: false, errors: 0, exempted: 0 });
      expect(result.log).toContain('PWA tsc missing');
      expect(result.log).toContain('타입 검사 실행 실패');
    });
  });

  it('replaces the baseline with diagnostic counts only after a parseable tsc analysis', () => {
    withTemporaryBaseline('test/existing.test.ts\t1\n', (cwd, baseline) => {
      const files = regenerateTestTypecheckBaseline(cwd, () => ({ status: 2, output: `${tscError('test/debt.test.ts', 1)}${tscError('test/debt.test.ts', 2)}` }));
      expect(files).toEqual(['test/debt.test.ts']);
      expect(readFileSync(baseline, 'utf8')).toBe('test/debt.test.ts\t2\n');
    });
  });

  it('preserves the baseline when tsc fails without parseable diagnostics', () => {
    withTemporaryBaseline('test/existing.test.ts\t1\n', (cwd, baseline) => {
      const before = readFileSync(baseline, 'utf8');
      expect(() => regenerateTestTypecheckBaseline(cwd, () => ({ status: 1, output: 'tsc: configuration missing' }))).toThrow('baseline preserved');
      expect(readFileSync(baseline, 'utf8')).toBe(before);
    });
  });
});

// ── baseline 파서 거부 사유별 회귀 (리뷰 must-fix ②) ──────────────────────────
//
// ⚠️ **왜 사유별로 나누나**: 초판 뮤테이션은 legacy 경로-전용 행 **한 사례**만 검출했다.
//    수용 기준은 네 가지(경로 없음 · 빈 count · 비정수 count · 초과 필드)를 다 요구한다.
describe('readTestTypecheckBaseline — 거부 사유별', () => {
  function withBaseline<T>(content: string, run: (cwd: string) => T): T {
    const cwd = mkdtempSync(join(tmpdir(), 'ratchet-baseline-'));
    try {
      writeFileSync(join(cwd, TEST_TYPECHECK_BASELINE), content);
      return run(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it('정상 항목은 개수로 읽는다', () => {
    withBaseline('test/a.test.ts\t3\n', (cwd) => {
      expect(readTestTypecheckBaseline(cwd).get('test/a.test.ts')).toBe(3);
    });
  });

  it('⭐ 빈 count 는 거부한다 — Number("") 는 0 이라 조용히 통과할 수 있다', () => {
    withBaseline('test/a.test.ts\t\n', (cwd) => {
      expect(() => readTestTypecheckBaseline(cwd)).toThrow('invalid baseline entry');
    });
    withBaseline('test/a.test.ts\t   \n', (cwd) => {
      expect(() => readTestTypecheckBaseline(cwd)).toThrow('invalid baseline entry');
    });
  });

  it('경로가 없으면 거부한다', () => {
    withBaseline('\t3\n', (cwd) => {
      expect(() => readTestTypecheckBaseline(cwd)).toThrow('invalid baseline entry');
    });
  });

  it('비정수 count 는 거부한다', () => {
    for (const bad of ['x', '1.5', '-1', '1e3']) {
      withBaseline(`test/a.test.ts\t${bad}\n`, (cwd) => {
        expect(() => readTestTypecheckBaseline(cwd)).toThrow('invalid baseline entry');
      });
    }
  });

  it('필드가 초과하면 거부한다', () => {
    withBaseline('test/a.test.ts\t3\textra\n', (cwd) => {
      expect(() => readTestTypecheckBaseline(cwd)).toThrow('invalid baseline entry');
    });
  });

  it('빈 줄은 건너뛴다(파일 끝 개행 허용)', () => {
    withBaseline('test/a.test.ts\t1\n\n', (cwd) => {
      expect(readTestTypecheckBaseline(cwd).size).toBe(1);
    });
  });
});

// ⛔ 2026-08-14 — 게이트가 `apps/pwa` 를 보게 된 뒤(#8784) 그 폴더 테스트를 한 글자만 건드려도
//   남의 기존 오류로 막혔다. 기준선 예외가 `test/` 와 `apps/pwa/test/` 만 인정했기 때문인데,
//   실제 PWA 테스트는 `apps/pwa/src/**` 아래에 산다. 아래가 그 «세 갈래»를 못 박는다.
describe('isBaselineExemptTestFile — 어디까지 기준선 예외인가', () => {
  it('apps/pwa/src 아래 «테스트 파일»만 인정하고 제품 코드는 인정하지 않는다', () => {
    expect(isBaselineExemptTestFile('apps/pwa/src/lib/chat-runtime.test.ts')).toBe(true);
    expect(isBaselineExemptTestFile('apps/pwa/src/components/observatory/subject-list.test.ts')).toBe(true);
    // 제품 코드는 이름이 무엇이든 예외를 못 받는다 — 받으면 회귀가 조용히 통과한다.
    expect(isBaselineExemptTestFile('apps/pwa/src/lib/daemon-client.ts')).toBe(false);
    expect(isBaselineExemptTestFile('apps/pwa/src/components/terminal/TerminalPanel.tsx')).toBe(false);
  });

  it('종전에 인정하던 두 자리는 그대로 인정한다', () => {
    expect(isBaselineExemptTestFile('test/acp-capabilities.test.ts')).toBe(true);
    expect(isBaselineExemptTestFile('apps/pwa/test/whatever.test.ts')).toBe(true);
  });

  it('apps/pwa 밖의 제품 코드는 종전대로 인정하지 않는다', () => {
    expect(isBaselineExemptTestFile('src/typecheck-ratchet.ts')).toBe(false);
    expect(isBaselineExemptTestFile('scripts/ci-typecheck-changed.ts')).toBe(false);
  });
});
