import { expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log';
import { nextMdWarning, runPrLand, type PrLandDeps } from './pr-cli';

const warning = '⚠ next-md: 사용자에게 보이는 변경인데 release/next.md 에 줄이 없습니다 — 공개 노트에서 빠집니다. 「- <kind> — <영어 한 문장>. Documentation: … Target: next.」 한 줄을 더하십시오.';

function check(body: string, files: string[]): string[] {
  const lines: string[] = [];
  nextMdWarning(body, files, { log: (line) => lines.push(line) });
  return lines;
}

const note = (kind: string) => `## 릴리스 노트\n- 한 줄: ${kind} — A user-facing change.\n- 종류: ${kind}\n- 문서: 없음(설명)\n- 대상: next\n`;

test('feat, fix and security release notes without next.md warn exactly once', () => {
  for (const kind of ['feat', 'fix', 'security']) {
    expect(check(note(kind), ['src/core.ts'])).toEqual([warning]);
  }
});

test('internal release note never warns even for user-facing paths', () => {
  expect(check(note('internal'), ['apps/pwa/src/x.tsx'])).toEqual([]);
  expect(check('## 릴리스 노트\n- 종류: internal\n', ['src/cli/x.ts'])).toEqual([]);
});

test('a declared user-facing kind warns even if the remaining note fields are incomplete', () => {
  expect(check('## 릴리스 노트\n- 종류: fix\n', ['src/core.ts'])).toEqual([warning]);
});

test('missing release note warns for a user-facing path, not an unrelated path', () => {
  expect(check('Other PR body', ['apps/pwa/src/x.tsx'])).toEqual([warning]);
  expect(check('Other PR body', ['src/cli/x.ts'])).toEqual([warning]);
  expect(check('Other PR body', ['src/dashboard/x.ts'])).toEqual([warning]);
  expect(check('Other PR body', ['scripts/x.ts'])).toEqual([]);
});

test('a release-note heading inside a fenced example does not hide a missing note', () => {
  expect(check('```md\n## 릴리스 노트\n- 종류: internal\n```', ['apps/pwa/src/x.tsx'])).toEqual([warning]);
});

test('changing release/next.md suppresses the warning', () => {
  expect(check(note('feat'), ['src/cli/x.ts', 'release/next.md'])).toEqual([]);
  expect(check('', ['apps/pwa/src/x.tsx', 'release/next.md'])).toEqual([]);
});

test('next-md step records a warning-only reason', () => {
  const logged = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    check(note('feat'), ['src/core.ts']);
    expect(logged).toHaveBeenCalledWith('pr.land', 'step', { step: 'next-md', ok: true, warnOnly: true, reason: 'release-note:feat' });
  } finally {
    logged.mockRestore();
  }
});

test('pr land emits the next-md warning but still merges with exit code 0', async () => {
  const lines: string[] = [];
  let merges = 0;
  const deps: PrLandDeps = {
    currentBranch: () => 'feat/notes',
    resolveBase: () => 'origin/main',
    run: (command, args) => {
      if (command === 'git' && args[0] === 'remote') return { ok: true, out: args[1] === 'get-url' ? 'https://github.com/example/repo.git' : 'origin' };
      if (command === 'git' && args[0] === 'rev-parse') return { ok: true, out: '/tmp/notes-test' };
      if (command === 'git' && args[0] === 'diff' && args[1] === '--name-only') return { ok: true, out: 'src/cli/x.ts\n' };
      return { ok: true, out: '' };
    },
    listUnfinishedRuns: () => [],
    queryRunningRuns: () => { throw new Error('observation unavailable'); },
    runTypecheckGate: () => true,
    runIsolationGate: () => true,
    runMockModuleRestoreGate: () => true,
    runModelHardcodeGate: () => true,
    runDaemonPortGate: () => true,
    runPublicLeakGate: () => 0,
    runExportLeakCheck: () => ({ measured: true, hits: [] }),
    runTestInterferenceGate: async () => 0,
    runAndroidGate: () => true,
    runPwaGate: () => true,
    runIosGate: () => true,
    listOpenPrs: () => [],
    out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    manager: {
      findPrForBranchOutcome: () => ({ status: 'NOT_FOUND' }),
      upsertPr: () => ({ ok: true, url: 'https://github.com/example/repo/pull/1', reused: false }),
      mergePrOutcome: () => { merges++; return { ok: true, kind: 'merged' }; },
    } as unknown as PrLandDeps['manager'],
  };
  expect(await runPrLand({ body: note('feat') }, deps)).toBe(0);
  expect(lines.filter((line) => line.startsWith('⚠ next-md:'))).toEqual([warning]);
  expect(merges).toBe(1);
});
