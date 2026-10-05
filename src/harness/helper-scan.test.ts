import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyStoppedPr, scanStoppedPrs } from './helper-scan.js';

const review = (round: number, count: number) => ({ body: `<!-- elanous-pr-comment v1 role=reviewer round=${round} -->\nRound ${round}: reviewer requested ${count} must-fix change(s).` });
const body = (reason: string, classification: string, gate = '[test] PASS bun test src/harness/example.test.ts — 6 pass, 0 fail') => `# RFC document goal\n\n## 중단 사유\nverdict: 정지(${reason.startsWith('no-progress') ? 'no-progress' : 'needs-human'})\nreason: ${reason}\nrework rounds: 3\n\n## 중단 원인 분류\nclassification: ${classification}\nclassificationBasis: PR review and gate evidence\n\n## Gate\n${gate}\n\n## Note\nNo automatic repair.`;
// Field shape copied from a real stopped PR (#23830 · 2026-10-05): the RFC words never appear in production bodies.
const real = (basis: string, classification = 'implementation-deficit', gate = '[test] PASS bun test src/x.test.ts — 0 fail') => `## 중단 사유\n- verdict: UNCONVERGEABLE\n- reason: 호스트명 누락이 이전 라운드부터 반복됐다.\n- rework rounds: 4\n\n## 중단 원인 분류\n- 중단 원인: ${classification}\n- classification: ${classification}\n- classificationBasis: ${basis}\n- worktreeClean: false\n\n## Gate\n\`\`\`\n${gate}\n\`\`\``;

test('review-budget round 3 must-fix 2 proposes one helper child', () => {
  const result = classifyStoppedPr({ body: body('review-budget-follow-up-required', 'review-budget'), comments: [review(3, 2)] });
  expect(result.category).toBe('review-budget');
  expect(result.signals).toContain('Round 3: reviewer requested 2 must-fix change(s)');
  expect(result.firstAction).toContain('헬퍼 자식 spawn');
  expect(result.blockers).toEqual([]);
});

test('actual blocked-draft bullet fields and reviewer comment use the latest round', () => {
  const stopped = `## 중단 사유\n- verdict: needs-human\n- reason: review-budget-follow-up-required\n- rework rounds: 3\n\n## 중단 원인 분류\n- classification: implementation-deficit\n- classificationBasis: must-fix-reported\n\n## Gate\n\`\`\`\n[test] PASS bun test src/harness/example.test.ts — 6 pass\n\`\`\``;
  const result = classifyStoppedPr({ body: stopped, comments: [review(2, 2), review(3, 0)] });
  expect(result.category).toBe('review-budget');
  expect(result.firstAction).toContain('하지 않음');
  expect(result.signals).toContain('Round 3: reviewer requested 0 must-fix change(s)');
});

test('no-progress green docs and must-fix 0 do not hide public-export-leak', () => {
  const leak = '✗ public-export-leak — packages/elanous-public/index.ts';
  const result = classifyStoppedPr({ body: body('no-progress · KPACK-RFC docs/', 'no-progress', `[test] PASS bun test docs/rfc.test.ts — 6 pass, 0 fail\n${leak}`), comments: [review(2, 0)] });
  expect(result.category).toBe('no-progress');
  expect(result.blockers).toEqual([leak]);
  expect(result.firstAction).toBe('Gate 차단 먼저 (✗ public-export-leak 확인)');
  expect(result.firstAction).not.toContain('중간 착지');
});

test('green no-progress docs can propose partial landing when Gate is clear', () => {
  const result = classifyStoppedPr({ body: body('no-progress · KPACK-RFC docs/', 'no-progress', '[test] PASS bun test docs/rfc.test.ts — 6 pass, 0 fail'), comments: [review(2, 0)] });
  expect(result.blockers).toEqual([]);
  expect(result.firstAction).toContain('중간 착지 ⊕ 연결 골');
  expect(result.firstAction).toContain('잔여 0이면 연결 골 하지 않음');
});

test('Gate failure suppresses the proposed repair even for review-budget with must-fix 2', () => {
  const failed = '[test] FAIL bun test src/harness/example.test.ts — 1 fail';
  const result = classifyStoppedPr({ body: body('review-budget-follow-up-required', 'review-budget', failed), comments: [review(3, 2)] });
  expect(result.category).toBe('review-budget');
  expect(result.blockers).toEqual([failed]);
  expect(result.firstAction).toBe('Gate 차단 먼저');
  expect(result.firstAction).not.toContain('헬퍼 자식 spawn');
});

test('PWA gate error without host evidence stays unknown even with a child-independent label', () => {
  const failed = '[test] FAIL bun test apps/pwa/src/lib/route-maturity.test.ts — 0 fail | 1 error';
  for (const label of ['unknown', '자식 무관 환경 결손']) {
    const result = classifyStoppedPr({ body: body('needs-human', label, failed), comments: [] });
    expect(result.category).toBe('unknown');
    expect(result.blockers).toEqual([failed]);
    expect(result.firstAction).toBe('Gate 차단 먼저');
    expect(result.firstAction).not.toContain('그래프 인스턴스 성형');
  }
});

test('confirmed missing host dependency with a matching passing retest proposes graph shaping after Gate', () => {
  const path = 'apps/pwa/src/lib/route-maturity.test.ts';
  const failed = `[test] FAIL bun test ${path} — 0 fail | 1 error`;
  const stopped = body('needs-human', '자식 무관 환경 결손', failed).replace(
    'classificationBasis: PR review and gate evidence',
    `classificationBasis: PR review and gate evidence; host=mbp; cause=missing node_modules; retest=PASS bun test ${path}`,
  );
  const result = classifyStoppedPr({ body: stopped, comments: [] });
  expect(result.category).toBe('environment-gap');
  expect(result.signals).toContain(`PR review and gate evidence; host=mbp; cause=missing node_modules; retest=PASS bun test ${path}`);
  expect(result.blockers).toEqual([failed]);
  expect(result.firstAction).toBe('Gate 차단 먼저 (그래프 인스턴스 성형으로 호스트 실패 시험 재측)');
});

test('a PWA code regression error is not a confirmed host failure', () => {
  const path = 'apps/pwa/src/lib/route-maturity.test.ts';
  const failed = `[test] FAIL bun test ${path} — 1 error`;
  const stopped = body('needs-human', '자식 무관 환경 결손', failed).replace(
    'classificationBasis: PR review and gate evidence',
    `classificationBasis: PR review and gate evidence; host=mbp; cause=TypeError in changed route code; retest=FAIL bun test ${path}`,
  );
  const result = classifyStoppedPr({ body: stopped, comments: [] });
  expect(result.category).toBe('unknown');
  expect(result.firstAction).toBe('Gate 차단 먼저');
});

test('body without stop sections or stop text stays unknown', () => {
  const result = classifyStoppedPr({ body: '# A regular pull request\nNo stop report.', comments: [] });
  expect(result.category).toBe('unknown');
  expect(result.signals).toEqual([]);
  expect(result.blockers).toEqual([]);
  expect(result.firstAction).toContain('하지 않음');
});

test('review-budget must-fix 0 does not propose repair child', () => {
  const result = classifyStoppedPr({ body: body('review-budget', 'review-budget'), comments: [review(3, 0)] });
  expect(result.category).toBe('review-budget');
  expect(result.firstAction).toContain('하지 않음');
  expect(result.firstAction).not.toContain('헬퍼 자식 spawn');
});

test('only stopped self-impl PRs are read; fake gh sees no write commands', async () => {
  const calls: string[][] = [];
  const stopped = body('no-progress · KPACK-RFC docs/', 'no-progress', '[test] PASS bun test docs/rfc.test.ts — 6 pass, 0 fail\n✗ public-export-leak');
  const runGh = (args: readonly string[]): string => {
    calls.push([...args]);
    if (args[1] === 'list') return JSON.stringify([
      { number: 23753, headRefName: 'self-impl/kpack-rfc', isDraft: true, body: stopped },
      { number: 13, headRefName: 'feature/stopped', isDraft: false, body: stopped },
      { number: 14, headRefName: 'self-impl/active', isDraft: false, body: '# active' },
    ]);
    if (args[1] === 'view' && args[2] === '23753') return JSON.stringify({ comments: [review(2, 0)] });
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const result = await scanStoppedPrs({ runGh });
  expect(result).toHaveLength(1);
  expect(result[0]?.pr).toBe(23753);
  expect(result[0]?.blockers).toEqual(['✗ public-export-leak']);
  expect(calls).toEqual([
    ['pr', 'list', '--state', 'open', '--limit', '100000', '--json', 'number,headRefName,isDraft,body'],
    ['pr', 'view', '23753', '--json', 'comments'],
  ]);
  expect(calls.some((args) => args.some((arg) => /^(comment|edit|merge)$/.test(arg)))).toBe(false);
});

test('memo not reflected proposes a memo only for a live same-slot target', () => {
  const result = classifyStoppedPr({ body: body('needs-human', '메모 미반영'), comments: [] });
  expect(result.category).toBe('memo-not-reflected');
  expect(result.firstAction).toContain('안내 메모');
  expect(result.firstAction).toContain('대상 불명이면 하지 않음');
});

test('review oscillation preserves existing test design and does not spawn without must-fix', () => {
  const stopped = body('review-budget', '리뷰 진동·설계 역행');
  expect(classifyStoppedPr({ body: stopped, comments: [review(3, 2)] })).toMatchObject({
    category: 'review-oscillation', firstAction: expect.stringContaining('기존 시험 설계 보존'),
  });
  expect(classifyStoppedPr({ body: stopped, comments: [review(3, 0)] }).firstAction).toContain('하지 않음');
});

test('environment classification requires an error-bearing FAIL, child-independent label or PWA path, and matching host retest', () => {
  const path = 'src/harness/check.test.ts';
  const failed = `[test] FAIL bun test ${path} — 2 errors`;
  const withEvidence = (label: string, gate: string, retestPath = path) => body('needs-human', label, gate).replace(
    'classificationBasis: PR review and gate evidence',
    `classificationBasis: PR review and gate evidence; host=mbp; cause=missing dependency; retest=PASS bun test ${retestPath}`,
  );
  expect(classifyStoppedPr({ body: withEvidence('자식 무관 환경 결손', failed), comments: [] }).category).toBe('environment-gap');
  expect(classifyStoppedPr({ body: withEvidence('unknown', failed), comments: [] }).category).toBe('unknown');
  expect(classifyStoppedPr({ body: body('needs-human', '자식 무관 환경 결손', failed), comments: [] }).category).toBe('unknown');
  expect(classifyStoppedPr({ body: withEvidence('자식 무관 환경 결손', failed, 'src/harness/other.test.ts'), comments: [] }).category).toBe('unknown');
  expect(classifyStoppedPr({ body: withEvidence('자식 무관 환경 결손', '[test] FAIL bun test src/harness/check.test.ts.backup.test.ts — 2 errors', 'src/harness/check.test.ts'), comments: [] }).category).toBe('unknown');
  expect(classifyStoppedPr({ body: withEvidence('자식 무관 환경 결손', '[test] PASS bun test src/harness/check.test.ts — 6 pass'), comments: [] }).category).toBe('unknown');
  expect(classifyStoppedPr({ body: withEvidence('자식 무관 환경 결손', '[test] FAIL bun test src/harness/check.test.ts — 2 failures'), comments: [] }).category).toBe('unknown');
});

test('generic needs-human with an unrelated review is unknown, not review-budget', () => {
  expect(classifyStoppedPr({ body: body('needs-human', 'unknown'), comments: [review(3, 1)] }).category).toBe('unknown');
});

test('non-PWA failed test alone does not invent an environment cause', () => {
  const result = classifyStoppedPr({ body: body('needs-human', 'unknown', '[test] FAIL bun test src/harness/example.test.ts — 1 error'), comments: [] });
  expect(result.category).toBe('unknown');
  expect(result.blockers).toHaveLength(1);
  expect(result.firstAction).toStartWith('Gate 차단 먼저');
});

test('real supervisor stop bodies map their existing classificationBasis', () => {
  const mustFix = classifyStoppedPr({ body: real('must-fix-reported'), comments: [review(3, 2)] });
  expect(mustFix.category).toBe('review-budget');
  expect(mustFix.firstAction).toContain('헬퍼 자식 spawn');
  const noChange = classifyStoppedPr({ body: real('no-must-fix-without-clean-worktree-or-completed-without-changes'), comments: [] });
  expect(noChange.category).toBe('no-progress');
});

test('real goal-unconvergeable candidate with must-fix 1 calls for goal revision rather than another child', () => {
  const goal = classifyStoppedPr({ body: real('supervisor-unconvergeable-goal-candidate', 'goal-unconvergeable-candidate'), comments: [review(3, 1)] });
  expect(goal.category).toBe('goal-revision');
  expect(goal.signals).toContain('classification=goal-unconvergeable-candidate → goal-revision');
  expect(goal.signals).toContain('supervisor-unconvergeable-goal-candidate');
  expect(goal.firstAction).toBe('골 개정 — 골 문면(판정 신호·경계)을 고쳐 재발사; 구현 자식 붙이지 않음');
  expect(goal.firstAction).not.toContain('헬퍼 자식 spawn');
  const basisOnly = classifyStoppedPr({ body: real('supervisor-unconvergeable-goal-candidate'), comments: [] });
  expect(basisOnly.category).toBe('goal-revision');
  expect(basisOnly.signals).toContain('classificationBasis=supervisor-unconvergeable-goal-candidate → goal-revision');
  const labelOnly = classifyStoppedPr({ body: real('unmeasured', 'goal-unconvergeable-candidate'), comments: [] });
  expect(labelOnly.category).toBe('goal-revision');
});

test('real report-deficit calls for evidence re-measurement rather than code repair', () => {
  const result = classifyStoppedPr({ body: real('no-must-fix-clean-worktree-with-cited-evidence-unmeasured', 'report-deficit'), comments: [] });
  expect(result.category).toBe('report-deficit');
  expect(result.signals).toContain('classification=report-deficit → report-deficit');
  expect(result.signals).toContain('no-must-fix-clean-worktree-with-cited-evidence-unmeasured');
  expect(result.firstAction).toBe('증거 재측 — 인용된 판정 명령을 호스트에서 다시 돌려 결과를 PR 에 남김; 코드 수정 아님');
});

test('real goal-revision Gate blocker takes first action ahead of goal revision', () => {
  const blocker = '✗ typecheck — missing definition';
  const result = classifyStoppedPr({ body: real('supervisor-unconvergeable-goal-candidate', 'goal-unconvergeable-candidate', `${blocker}\n[test] PASS bun test src/x.test.ts — 0 fail`), comments: [review(3, 1)] });
  expect(result.category).toBe('goal-revision');
  expect(result.blockers).toEqual([blocker]);
  expect(result.firstAction).toBe('Gate 차단 먼저');
});

test('real contract-conflict and artifact-deficit remain unknown', () => {
  for (const label of ['contract-conflict', 'artifact-deficit']) {
    const result = classifyStoppedPr({ body: real('unmeasured', label), comments: [] });
    expect(result.category).toBe('unknown');
    expect(result.firstAction).toBe('하지 않음 — 정지 원인 근거 부족');
  }
});

test('quoted stop heading or stop wording without a stop verdict is not scanned', async () => {
  const calls: string[][] = [];
  const quoted = '## 요청\n멈춘 하니스 PR 본문은 정해진 절을 가진다 — `## 중단 사유`(`verdict` · `reason`) · 슈퍼바이저 정지 문면 `정지(needs-human)`·`정지(no-progress)`.';
  const template = '## 중단 사유\n(작성 전)\n\n## Gate\n[test] PASS bun test src/x.test.ts — 1 pass';
  const result = await scanStoppedPrs({ runGh: (args) => {
    calls.push([...args]);
    if (args[1] === 'list') return JSON.stringify([
      { number: 23819, headRefName: 'self-impl/quoted', isDraft: false, body: quoted },
      { number: 23711, headRefName: 'self-impl/template', isDraft: true, body: template },
      { number: 23712, headRefName: 'self-impl/wording', isDraft: true, body: '슈퍼바이저 정지(no-progress) · 2라운드 제자리' },
    ]);
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  } });
  expect(result).toEqual([]);
  expect(calls).toEqual([['pr', 'list', '--state', 'open', '--limit', '100000', '--json', 'number,headRefName,isDraft,body']]);
});

test('a code error in the Gate keeps the cause unknown even with a conflicting host-retest basis', () => {
  const path = 'apps/pwa/src/lib/route-maturity.test.ts';
  const failed = `[test] FAIL bun test ${path} — 1 error ⏎ TypeError: undefined is not an object (evaluating 'route.maturity')`;
  const stopped = body('needs-human', '자식 무관 환경 결손', failed).replace(
    'classificationBasis: PR review and gate evidence',
    `classificationBasis: PR review and gate evidence; host=mbp; cause=missing dependency; retest=PASS bun test ${path}`,
  );
  const result = classifyStoppedPr({ body: stopped, comments: [] });
  expect(result.category).toBe('unknown');
  expect(result.firstAction).toBe('Gate 차단 먼저');
});

test('CLI text and --json read a fake gh without writing to any PR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helper-scan-gh-'));
  const calls = join(dir, 'calls');
  const fakeGh = join(dir, 'gh');
  const stopped = body('no-progress · KPACK-RFC docs/', 'no-progress', '[test] PASS bun test docs/rfc.test.ts — 6 pass, 0 fail\n✗ public-export-leak');
  const lateLeak = body('no-progress · KPACK-RFC docs/', 'no-progress', `${Array.from({ length: 6 }, (_, i) => `✗ blocker-${i}`).join('\n')}\n✗ public-export-leak — packages/elanous-public/index.ts`);
  const prs = JSON.stringify([
    { number: 23753, headRefName: 'self-impl/kpack-rfc', isDraft: true, body: stopped },
    { number: 23754, headRefName: 'self-impl/late-leak', isDraft: true, body: lateLeak },
  ]);
  const comments = JSON.stringify({ comments: [review(2, 0)] });
  writeFileSync(fakeGh, `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.HELPER_SCAN_GH_CALLS!, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.argv[2] === 'pr' && process.argv[3] === 'list') console.log(${JSON.stringify(prs)});\nelse if (process.argv[2] === 'pr' && process.argv[3] === 'view') console.log(${JSON.stringify(comments)});\nelse process.exit(1);\n`);
  chmodSync(fakeGh, 0o755);
  try {
    for (const args of [[], ['--json']]) {
      const run = spawnSync('bun', ['src/harness/helper-scan.ts', ...args], {
        encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, HELPER_SCAN_GH_CALLS: calls },
      });
      expect(run.status).toBe(0);
      if (args.length) {
        expect(JSON.parse(run.stdout)).toMatchObject([
          { pr: 23753, category: 'no-progress', blockers: ['✗ public-export-leak'] },
          { pr: 23754, category: 'no-progress', blockerCount: 7, hasPublicExportLeak: true },
        ]);
      } else {
        expect(run.stdout.trim().split('\n')).toEqual([
          '#23753 no-progress · Gate 차단 1(✗ public-export-leak) → Gate 차단 먼저 (✗ public-export-leak 확인)',
          '#23754 no-progress · Gate 차단 7(✗ public-export-leak (6번째 이후)) → Gate 차단 먼저 (✗ public-export-leak 확인)',
        ]);
      }
    }
    expect(readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      ['pr', 'list', '--state', 'open', '--limit', '100000', '--json', 'number,headRefName,isDraft,body'],
      ['pr', 'view', '23753', '--json', 'comments'],
      ['pr', 'view', '23754', '--json', 'comments'],
      ['pr', 'list', '--state', 'open', '--limit', '100000', '--json', 'number,headRefName,isDraft,body'],
      ['pr', 'view', '23753', '--json', 'comments'],
      ['pr', 'view', '23754', '--json', 'comments'],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default --json neither writes the repair ledger nor makes repair-only gh lookups; explicit shadow path does both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helper-scan-json-'));
  const root = join(dir, 'state');
  const ledger = join(root, 'helper', 'repairs.jsonl');
  const calls = join(dir, 'calls');
  const fakeGh = join(dir, 'gh');
  const stopped = `## 요청\nOriginal request\n\n## 중단 사유\n- verdict: needs-human\n- reason: review-budget\n\n## 중단 원인 분류\n- classification: implementation-deficit\n- classificationBasis: must-fix-reported\n\n## 마지막 리뷰 must-fix\n- Fix the regression`;
  const prs = JSON.stringify([{ number: 23753, headRefName: 'self-impl/repair', isDraft: true, body: stopped }]);
  const comments = JSON.stringify({ comments: [review(3, 1)] });
  writeFileSync(fakeGh, `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.HELPER_SCAN_GH_CALLS!, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.argv[2] === 'pr' && process.argv[3] === 'list') console.log(${JSON.stringify(prs)});\nelse if (process.argv[2] === 'pr' && process.argv[3] === 'view' && process.argv.includes('comments')) console.log(${JSON.stringify(comments)});\nelse if (process.argv[2] === 'pr' && process.argv[3] === 'view' && process.argv.includes('body')) console.log(${JSON.stringify(JSON.stringify({ body: stopped }))});\nelse process.exit(1);\n`);
  chmodSync(fakeGh, 0o755);
  const run = (args: string[]) => spawnSync('bun', ['src/harness/helper-scan.ts', ...args], {
    encoding: 'utf8', cwd: process.cwd(),
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, ELANOUS_STATE_DIR: root, HELPER_SCAN_GH_CALLS: calls },
  });
  const scanCalls = [
    ['pr', 'list', '--state', 'open', '--limit', '100000', '--json', 'number,headRefName,isDraft,body'],
    ['pr', 'view', '23753', '--json', 'comments'],
  ];
  const readCalls = () => readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  try {
    const json = run(['--json']);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject([{ pr: 23753, category: 'review-budget' }]);
    expect({ calls: readCalls(), ledgerExists: existsSync(ledger) }).toEqual({ calls: scanCalls, ledgerExists: false });

    writeFileSync(calls, '');
    const explicit = run(['--record-shadows']);
    expect(explicit.status).toBe(0);
    expect(readCalls()).toEqual([...scanCalls, ['pr', 'view', '23753', '--json', 'body']]);
    expect(JSON.parse(readFileSync(ledger, 'utf8').trim())).toMatchObject({ pr: 23753, mode: 'shadow' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate blockers retain the full count and a leak beyond the five verbatim lines', () => {
  const lines = Array.from({ length: 6 }, (_, i) => `✗ blocker-${i}`);
  const leak = '✗ public-export-leak — packages/elanous-public/index.ts';
  const result = classifyStoppedPr({ body: body('no-progress', 'no-progress', `[test] FAIL one — 1 error\n${lines.join('\n')}\n${leak}`) + '\n✗ outside Gate', comments: [] });
  expect(result.blockers).toEqual(['[test] FAIL one — 1 error', ...lines.slice(0, 4)]);
  expect(result.blockerCount).toBe(8);
  expect(result.hasPublicExportLeak).toBe(true);
  expect(result.signals).toContain(leak);
  expect(result.firstAction).toStartWith('Gate 차단 먼저 (✗ public-export-leak 확인)');
});

test('a stopped PR past the default thirty is still scanned without gh writes', async () => {
  const calls: string[][] = [];
  const prs = Array.from({ length: 31 }, (_, i) => ({
    number: i + 1, headRefName: i === 30 ? 'self-impl/stopped' : `feature/${i}`,
    isDraft: true, body: body('review-budget', 'review-budget'),
  }));
  const rows = await scanStoppedPrs({ runGh: (args) => {
    calls.push([...args]);
    if (args[1] === 'list') return JSON.stringify(prs.slice(0, Number(args[args.indexOf('--limit') + 1])));
    if (args[1] === 'view' && args[2] === '31') return JSON.stringify({ comments: [review(3, 2)] });
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  } });
  expect(rows).toMatchObject([{ pr: 31, category: 'review-budget' }]);
  expect(calls).toEqual([
    ['pr', 'list', '--state', 'open', '--limit', '100000', '--json', 'number,headRefName,isDraft,body'],
    ['pr', 'view', '31', '--json', 'comments'],
  ]);
  expect(calls.some((args) => args.some((arg) => /^(comment|edit|merge)$/.test(arg)))).toBe(false);
});
