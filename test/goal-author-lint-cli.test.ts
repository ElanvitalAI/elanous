import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_REQUIRED_BLOCKS, REQUIRED_BLOCKS } from '../src/self-implement/goal-author.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const directories: string[] = [];
const canonicalGoal = (scopeBoundary = 'short', evidence = '- [proof] present'): string => `## PROBLEM
problem

## WHAT TO BUILD
build

## ACCEPTANCE CRITERIA
criteria

## REQUIRED EVIDENCE
${evidence}

## TRACED PATHS
paths

## SCOPE BOUNDARY
${scopeBoundary}

## 답하지 못하는 것
none

## 불변식
invariants

## 판정 신호
signals
`;

// ⛔ 기본은 `main` 이다 — 그래야 `launch-branch` WARN 이 «안 나고» 대부분의 시험이
//   자기가 재려는 소견만 본다. 그 WARN 을 «재려는» 시험만 branch 를 준다.
//   📏 2026-08-22: 그 WARN 을 기대하면서 main 에서 열어 「원리상 안 나는」 기대를 세운 시험이 하나 있었다.
function fixture(document: string, branch = 'main'): { root: string; goal: string } {
  const root = mkdtempSync(join(tmpdir(), 'goal-author-lint-'));
  directories.push(root);
  mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
  execFileSync('git', ['init', `--initial-branch=${branch}`, '--quiet'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '--quiet', '-m', 'fixture'], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  });
  const goal = join(root, 'GOAL-lint.txt');
  writeFileSync(goal, document);
  return { root, goal };
}

// ⛔ `cwd` 를 «인자»로 받는다 — CLI 는 `opts.cwd` 의 브랜치를 `git rev-parse` 로 읽어
//   `launch-branch` WARN 을 정한다(src/index.ts:2892). 그래서 `process.cwd()` 를 고정하면
//   ***이 시험의 결과가 「내가 지금 어느 브랜치에 있나」에 갈린다***.
//   📏 2026-08-28 실측: 비-main 브랜치 20p/0f ↔ ***main 19p/1f***. 착지 당시 나는 비-main 이라 못 봤다.
//   ✅ 픽스처가 이미 `--initial-branch` 로 브랜치를 세우므로, 그 트리를 cwd 로 주면 «내 트리와 무관»해진다.
function run(...args: string[]) {
  return runIn(process.cwd(), ...args);
}

function runIn(cwd: string, ...args: string[]) {
  return Bun.spawnSync({
    // ⛔ cwd 를 픽스처 트리로 옮기므로 진입점은 «절대 경로»여야 한다 — 상대 경로면 그 트리에 없어
    //   명령이 조용히 안 돌고 findings 가 0 이 된다(실측: 그렇게 해서 한 번 빨갰다).
    cmd: ['bun', join(process.cwd(), 'bin', 'elanous.mjs'), '--test', 'self', 'author', ...args],
    cwd,
    env: { ...process.env, ELANOUS_STATE_DIR: join(tmpdir(), `goal-author-lint-state-${crypto.randomUUID()}`) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function output(result: ReturnType<typeof run>): string {
  return new TextDecoder().decode(result.stdout);
}

function lintFindings(result: ReturnType<typeof run>): string[] {
  return output(result).trimEnd().split('\n').filter((line) => /^(ERROR|WARN) \[[^\]]+\] /.test(line));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('self author inspection probes', () => {
  test('grounds invariant probes before classifying path evidence while leaving boundary probes pure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-author-invariant-probe-'));
    directories.push(root);
    execFileSync('git', ['init', '--initial-branch=main', '--quiet'], { cwd: root });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'example.ts'), 'export const example = true;\n');
    // 존재하지 않는 repository path는 어떤 Read-verified persistent grounding evidence와도 매치될 수 없다.
    // 이전 CLI 경로는 facts를 검사기에 전달하지 않아 여기서 항상 "unknown"을 냈다.
    const invariant = run('--cwd', root, '--inspect-invariant', '불변식: src/definitely-missing-invariant-probe.ts remains unchanged.');
    const boundary = run('--inspect-boundary', '경계: src/example.ts만 고친다.');

    expect(invariant.exitCode).toBe(0);
    expect(JSON.parse(output(invariant))).toEqual(expect.objectContaining({
      marker: true,
      extracted: true,
      pathEvidence: 'unknown',
      unmatchedEvidencePaths: ['src/definitely-missing-invariant-probe.ts'],
    }));
    const existing = run('--cwd', root, '--inspect-invariant', '불변식: src/example.ts remains unchanged.');
    expect(existing.exitCode).toBe(0);
    expect(JSON.parse(output(existing))).toEqual(expect.objectContaining({
      pathEvidence: true,
      unmatchedEvidencePaths: [],
    }));
    const partiallyUnmatched = run('--cwd', root, '--inspect-invariant', '불변식: src/example.ts and src/missing.ts remain unchanged.');
    expect(partiallyUnmatched.exitCode).toBe(0);
    expect(JSON.parse(output(partiallyUnmatched))).toEqual(expect.objectContaining({
      pathEvidence: false,
      unmatchedEvidencePaths: ['src/missing.ts'],
    }));
    const dottedCall = run('--cwd', root, '--inspect-invariant', '불변식: src/example.ts does not use os.tmpdir().');
    expect(dottedCall.exitCode).toBe(0);
    expect(JSON.parse(output(dottedCall))).toEqual(expect.objectContaining({
      pathEvidence: false,
      unmatchedEvidencePaths: ['os.tmpdir'],
    }));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'goal-author-invariant-outside-'));
    directories.push(outsideRoot);
    const outside = join(outsideRoot, 'outside.ts');
    writeFileSync(outside, 'export const outside = true;\n');
    symlinkSync(outside, join(root, 'src', 'outside.ts'));
    const symlinkEscape = run('--cwd', root, '--inspect-invariant', '불변식: src/outside.ts remains unchanged.');
    expect(symlinkEscape.exitCode).toBe(0);
    expect(JSON.parse(output(symlinkEscape))).toEqual(expect.objectContaining({
      pathEvidence: 'unknown',
      unmatchedEvidencePaths: ['src/outside.ts'],
    }));
    expect(boundary.exitCode).toBe(0);
    expect(JSON.parse(output(boundary))).toEqual(expect.objectContaining({
      marker: true,
      extracted: true,
      pathEvidence: 'not-applicable',
    }));
  }, 20_000);

  test('inspects labeled target paths as one JSON line without authoring a goal', () => {
    const { root } = fixture(canonicalGoal());
    const before = readdirSync(join(root, 'docs', 'goals'));
    const result = run('--inspect-target-paths', '대상 경로: src/a.ts · path with space.ts · 설명');
    const lines = output(result).trimEnd().split('\n');

    expect(result.exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      paths: ['src/a.ts'],
      rejected: [
        { fragment: ' path with space.ts ', reason: 'has-whitespace' },
        { fragment: ' 설명', reason: 'not-path-like' },
      ],
      labelMissing: false,
    });
    expect(readdirSync(join(root, 'docs', 'goals'))).toEqual(before);
  });

  test('reports a missing target-path label as one JSON line without authoring a goal', () => {
    const { root } = fixture(canonicalGoal());
    const before = readdirSync(join(root, 'docs', 'goals'));
    const result = run('--inspect-target-paths', 'src/a.ts · path with space.ts');
    const lines = output(result).trimEnd().split('\n');

    expect(result.exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ paths: [], rejected: [], labelMissing: true });
    expect(readdirSync(join(root, 'docs', 'goals'))).toEqual(before);
  });

  test('rejects multiple inspection probes before authoring', () => {
    const result = run('--inspect-target-paths', '대상 경로: src/example.ts', '--inspect-boundary', '경계: src/example.ts만 고친다.');

    expect(result.exitCode).toBe(2);
    expect(`${output(result)}${new TextDecoder().decode(result.stderr)}`).toContain('inspection options cannot be combined with author arguments or each other');
  });

  test('preserves decision-signal inspection output', () => {
    // ㉡ 이 시험은 canonical goal lint가 아니라 decision-signal JSON 형식의 호환성을 지킨다.
    const result = run('--inspect-decision-signal', '판정 신호: condition = c; observation = o; expected result = e');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(output(result))).toEqual(expect.objectContaining({
      marker: true,
      extracted: true,
      condition: 'c',
      observation: 'o',
      expectedResult: 'e',
      expectedResultClassification: 'indeterminate',
    }));
  });

  test('reports marker and extracted decision-signal fields without authoring a goal', () => {
    // ㉡ 이 시험은 authoring 부작용 없이 marker와 extracted fields가 함께 보고되는지만 지킨다.
    const result = run('--inspect-decision-signal', '판정 신호: condition = c; observation = o; expected result = e');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(output(result))).toEqual(expect.objectContaining({
      marker: true,
      extracted: true,
      condition: 'c',
      observation: 'o',
      expectedResult: 'e',
      expectedResultClassification: 'indeterminate',
    }));
  });

  test('distinguishes a marker-only decision signal from an extracted signal', () => {
    const result = run('--inspect-decision-signal', '판정 신호 (설명): condition = c; observation = o; expected result = e');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(output(result))).toEqual(expect.objectContaining({
      marker: true,
      extracted: false,
    }));
  });

  test('rejects an explicit termination timeout rather than ignoring it', () => {
    const result = run('--inspect-decision-signal', '판정 신호:', '--termination-timeout', '1000');

    expect(result.exitCode).toBe(2);
    expect(`${output(result)}${new TextDecoder().decode(result.stderr)}`).toContain('inspection options cannot be combined with author arguments or each other');
  });

  test('accepts --cwd only for an invariant probe because it is the grounding root', () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-author-invariant-probe-'));
    directories.push(root);
    execFileSync('git', ['init', '--initial-branch=main', '--quiet'], { cwd: root });
    const invariant = run('--cwd', root, '--inspect-invariant', '불변식: src/missing.ts remains unchanged.');
    const decisionSignal = run('--cwd', root, '--inspect-decision-signal', '판정 신호:');

    expect(invariant.exitCode).toBe(0);
    expect(JSON.parse(output(invariant))).toEqual(expect.objectContaining({
      pathEvidence: 'unknown',
      unmatchedEvidencePaths: ['src/missing.ts'],
    }));
    expect(decisionSignal.exitCode).toBe(2);
    expect(`${output(decisionSignal)}${new TextDecoder().decode(decisionSignal.stderr)}`).toContain('inspection options cannot be combined with author arguments or each other');
  });
});

describe('self author --print-template', () => {
  test('prints the canonical blocks in order with severity derived from the goal-author contract without authoring a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-author-template-'));
    directories.push(root);
    mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
    const before = readdirSync(join(root, 'docs', 'goals'));
    const result = run('--cwd', root, '--print-template');
    const lines = output(result).trimEnd().split('\n');

    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(REQUIRED_BLOCKS.map((block) => `${ERROR_REQUIRED_BLOCKS.has(block) ? 'ERROR' : 'WARN'} ${block}`));
    expect(lines).toHaveLength(REQUIRED_BLOCKS.length);
    expect(lines.filter((line) => line.startsWith('ERROR '))).toHaveLength(ERROR_REQUIRED_BLOCKS.size);
    expect(readdirSync(join(root, 'docs', 'goals'))).toEqual(before);
  });

  test('rejects author arguments instead of grounding or authoring a goal', () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-author-template-reject-'));
    directories.push(root);
    mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
    const before = readdirSync(join(root, 'docs', 'goals'));
    const result = run('--cwd', root, '--print-template', 'author this goal');

    expect(result.exitCode).toBe(2);
    expect(`${output(result)}${new TextDecoder().decode(result.stderr)}`).toContain('--print-template cannot be combined with author arguments');
    expect(readdirSync(join(root, 'docs', 'goals'))).toEqual(before);
  });

  test('rejects other read-only author actions', () => {
    const result = run('--print-template', '--inspect-boundary', '경계: no template file');

    expect(result.exitCode).toBe(2);
    expect(`${output(result)}${new TextDecoder().decode(result.stderr)}`).toContain('--print-template cannot be combined with author arguments');
  });
});

describe('self author --lint', () => {
  test('reports error and warning findings without authoring a file', () => {
    // ㉠ complete canonical goal에서 evidence-section ERROR와 launch-branch WARN만 독립적으로 지킨다.
    // `launch-branch` WARN 을 «재는» 시험이므로 비-main 브랜치로 연다(main 이면 그 WARN 이 원리상 안 난다).
    const { root, goal } = fixture(canonicalGoal('short', '- missing-tag'), 'work');
    const before = readdirSync(join(root, 'docs', 'goals'));
    // ⭐ 픽스처 트리를 cwd 로 준다 — 그래야 `launch-branch` 가 «그 트리의 work 브랜치»를 본다.
    const result = runIn(root, '--lint', goal);

    const findings = lintFindings(result);

    expect(result.exitCode).toBe(1);
    expect(findings).toHaveLength(2);
    expect(findings).toEqual([
      expect.stringContaining('ERROR [evidence-section] ## REQUIRED EVIDENCE must contain at least one - [tag] description entry'),
      expect.stringContaining('WARN [launch-branch] current branch is'),
    ]);
    expect(readdirSync(join(root, 'docs', 'goals'))).toEqual(before);
  });

  test('prints plan signals after existing findings without changing lint exit codes', () => {
    const { goal } = fixture(`${canonicalGoal()}\n- Checkable requested criterion: retain telemetry registry\n- Checkable preservation criterion: no telemetry registry writes\n- UNVERIFIABLE: pending evidence\n`);
    const result = run('--lint', goal);
    const lines = output(result).trimEnd().split('\n');

    expect(result.exitCode).toBe(0);
    expect(lines.at(-1)).toBe(JSON.stringify({
      goalId: null,
      persistentEvidenceTargetPathCount: null,
      persistentEvidenceOutsideTargetPathCount: null,
      tracedPathMissing: 0,
      tracedPathOutside: 0,
      unansweredClarification: 0,
      unverifiable: 1,
      unverifiableInvariantCandidates: 0,
      normalizedMarkerSuccess: 0,
      normalizedMarkerFailure: 0,
      requestedCriteria: 1,
      contradiction: 1,
      unverifiableLines: ['- UNVERIFIABLE: pending evidence'],
      contradictionLines: ['- Checkable preservation criterion: no telemetry registry writes'],
    }));
    expect(lines.slice(0, -1)).not.toContainEqual(expect.stringContaining('"tracedPathMissing"'));
  });

  test('reports unanswered clarification IDs with questions and options without changing the zero exit code', () => {
    const { goal } = fixture(`${canonicalGoal()}\n- Clarification:\n  - id: deployment-owner\n  - header: Clarification\n  - question: Who owns deployment?\n  - options:\n    - label: Platform\n      description: Operates the deployment.\n  - answer: DEFERRED-UNTIL: Who owns deployment?\n\n- Clarification:\n  - id: rollout-window\n  - header: Clarification\n  - question: When is rollout?\n  - answer: DEFERRED-UNTIL When is rollout?\n`);
    const result = run('--lint', goal);

    expect(result.exitCode).toBe(0);
    expect(output(result)).toContain('WARN [unanswered-clarification] 2 unanswered clarifications: deployment-owner { question="Who owns deployment?"; questionTruncated=false; options="Platform: Operates the deployment."; optionsTruncated=false }, rollout-window { question="When is rollout?"; questionTruncated=false; options=none; optionsTruncated=false }');
  });

  test('marks truncated unanswered clarification questions and options', () => {
    const question = 'q'.repeat(241);
    const description = 'd'.repeat(361);
    const { goal } = fixture(`${canonicalGoal()}\n- Clarification:\n  - id: oversized\n  - header: Clarification\n  - question: ${question}\n  - options:\n    - label: Option\n      description: ${description}\n  - answer: DEFERRED-UNTIL: pending\n`);
    const result = run('--lint', goal);

    expect(result.exitCode).toBe(0);
    expect(output(result)).toContain(`oversized { question="${'q'.repeat(240)}…"; questionTruncated=true; options="Option: ${'d'.repeat(352)}…"; optionsTruncated=true }`);
  });

  test('reports distinct boundary-size warnings for unselected candidates and human decisions', () => {
    const candidates = fixture(canonicalGoal(`- Scope-boundary candidates selected by document relevance:\n${'x'.repeat(1801)}\n- If adopted, state each boundary as an intentional goal decision with its reason; do not create a must-fix solely from that boundary.`));
    const decision = fixture(canonicalGoal(`${'x'.repeat(1801)}\n\`\` damage`));
    const candidateResult = run('--lint', candidates.goal);
    const decisionResult = run('--lint', decision.goal);

    expect(candidateResult.exitCode).toBe(0);
    expect(output(candidateResult)).toContain('WARN [boundary-size] ## SCOPE BOUNDARY contains unselected scope-boundary candidates; select decisions before evaluating boundary size');
    expect(output(candidateResult)).not.toContain('## SCOPE BOUNDARY exceeds 1800 characters');
    expect(decisionResult.exitCode).toBe(0);
    expect(output(decisionResult)).toContain('WARN [boundary-size] ## SCOPE BOUNDARY exceeds 1800 characters');
    expect(output(decisionResult)).toContain('WARN [shell-damage] goal file contains empty inline code');
    expect(output(decisionResult)).not.toContain('[evidence-section]');
    expect(output(decisionResult)).not.toContain('[canonical-structure]');
  });

  test('rejects missing, symlink-escaping, and invalid traced lines before launch', () => {
    const document = canonicalGoal().replace(
      '## TRACED PATHS\npaths',
      '## TRACED PATHS\n- src/present.ts:3 — valid\n* src/missing.ts — absent\n+ src/present.ts:4 — too late\n1. src/present.ts:0 — invalid\n2) src/empty.ts:1 — empty\n- README.md:1 — root file\n* src/outside.ts:1 — escaping link\n+ ../escape.ts — parent traversal\n1. /etc/hosts — absolute path',
    );
    const { root, goal } = fixture(document);
    const outside = join(root, '..', `goal-author-outside-${crypto.randomUUID()}.ts`);
    directories.push(outside);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'present.ts'), 'one\ntwo\nthree');
    writeFileSync(join(root, 'src', 'empty.ts'), '');
    writeFileSync(join(root, 'README.md'), 'root');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(root, 'src', 'outside.ts'));
    const result = run('--cwd', root, '--lint', goal);

    expect(result.exitCode).toBe(1);
    expect(output(result)).toContain('ERROR [traced-path] traced path does not exist: src/missing.ts');
    expect(output(result)).toContain('ERROR [traced-path] traced path line 4 is out of range: src/present.ts');
    expect(output(result)).toContain('ERROR [traced-path] traced path line 0 is out of range: src/present.ts');
    expect(output(result)).toContain('ERROR [traced-path] traced path line 1 is out of range: src/empty.ts');
    expect(output(result)).toContain('ERROR [traced-path] traced path is outside repository: src/outside.ts');
    // 저장소 탈출은 reader 를 부르기도 전에 거부된다 — 심링크 · 부모 순회 · 절대경로 셋 다(리뷰 should-fix).
    expect(output(result)).toContain('ERROR [traced-path] traced path is outside repository: ../escape.ts');
    expect(output(result)).toContain('ERROR [traced-path] traced path is outside repository: /etc/hosts');
    for (const reference of ['src/present.ts:3', 'README.md:1']) {
      expect(output(result)).not.toContain(`ERROR [traced-path] traced path line ${reference.split(':')[1]} is out of range: ${reference.split(':')[0]}`);
      expect(output(result)).not.toContain(`ERROR [traced-path] traced path does not exist: ${reference.split(':')[0]}`);
    }
  });

  test('rejects missing, empty, or out-of-order canonical sections', () => {
    const missing = fixture(canonicalGoal().replace('## PROBLEM\nproblem\n\n', ''));
    const empty = fixture(canonicalGoal('short', ''));
    const reversed = fixture(canonicalGoal().replace('## ACCEPTANCE CRITERIA\ncriteria\n\n## REQUIRED EVIDENCE\n', '## REQUIRED EVIDENCE\n- [proof] present\n\n## ACCEPTANCE CRITERIA\ncriteria\n\n## REQUIRED EVIDENCE\n'));

    expect(output(run('--lint', missing.goal))).toContain('ERROR [canonical-structure] missing required section: ## PROBLEM');
    expect(output(run('--lint', empty.goal))).toContain('ERROR [evidence-section]');
    expect(output(run('--lint', reversed.goal))).toContain('ERROR [canonical-structure] required sections must appear in canonical order:');
  });

  test('rejects lint combined with author input before writing', () => {
    const { root, goal } = fixture(canonicalGoal());
    const result = run('--lint', goal, 'author this instead');

    expect(result.exitCode).toBe(2);
    expect(`${output(result)}${new TextDecoder().decode(result.stderr)}`).toContain('--lint cannot be combined with author arguments');
    expect(readdirSync(join(root, 'docs', 'goals'))).toEqual([]);
  });
});
