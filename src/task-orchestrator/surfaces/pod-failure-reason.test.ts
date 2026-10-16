import { describe, expect, test } from 'bun:test';
import { classifyPodExit, extractPodFailureReason, nestedPodResult, podTerminalRow, POD_EXIT_CLASSES } from './pod-failure-reason.js';

describe('classifyPodExit', () => {
  test('exports the closed class set and preserves terminal metadata fields', () => {
    expect(POD_EXIT_CLASSES).toEqual([
      'oom-killed', 'deadline-exceeded', 'gh-login-failed', 'pod-secret', 'ask-reprompt',
      'child-unconverged', 'child-error', 'no-result-line', 'unknown',
    ]);
    expect(classifyPodExit({
      errorCode: 'pod-secret', containerReason: 'Error', containerExitCode: 2, jobReason: 'BackoffLimitExceeded', logs: '',
    })).toEqual({
      class: 'pod-secret', errorCode: 'pod-secret', containerReason: 'Error', exitCode: 2,
      jobReason: 'BackoffLimitExceeded', tail: [], noResultLine: true,
    });
  });

  test('applies the terminal metadata precedence', () => {
    expect(classifyPodExit({ jobReason: 'DeadlineExceeded', containerReason: 'OOMKilled', containerExitCode: 7, logs: '' }).class).toBe('deadline-exceeded');
    expect(classifyPodExit({ containerReason: 'OOMKilled', containerExitCode: 7, logs: '' }).class).toBe('oom-killed');
    expect(classifyPodExit({ containerExitCode: 7, logs: '' }).class).toBe('gh-login-failed');
    expect(classifyPodExit({ errorCode: 'pod-secret', jobReason: 'DeadlineExceeded', logs: '' }).class).toBe('pod-secret');
  });

  test('classifies failed child results and ask reprompt lines', () => {
    const row = JSON.stringify({ kind: 'self', ok: false, result: { stage: 'soft-stopped', ok: false } });
    expect(classifyPodExit({ jobReason: 'BackoffLimitExceeded', containerReason: 'Error', containerExitCode: 2, logs: row }).class)
      .toBe('child-unconverged');
    expect(classifyPodExit({ logs: '[ask] implementation_target is missing; please provide a target' }).class).toBe('ask-reprompt');
  });

  test('uses child-error only when no result line exists and otherwise closes unknown cases', () => {
    expect(classifyPodExit({ logs: 'Error: child failed' }).class).toBe('child-error');
    expect(classifyPodExit({ logs: JSON.stringify({ kind: 'self', ok: true, result: { stage: 'merged', ok: true } }) }).class).toBe('unknown');
    expect(classifyPodExit({ logs: '' }).class).toBe('no-result-line');
  });

  test('records missing result independently of the exit class, including a plain child error and metadata failure', () => {
    expect(classifyPodExit({ logs: 'Error: child failed' })).toMatchObject({ class: 'child-error', noResultLine: true });
    expect(classifyPodExit({ logs: '[ask] implementation_target is missing; please provide a target' }))
      .toMatchObject({ class: 'ask-reprompt', noResultLine: true });
    expect(classifyPodExit({ jobReason: 'DeadlineExceeded', logs: '' }))
      .toMatchObject({ class: 'deadline-exceeded', noResultLine: true });
    const row = JSON.stringify({ kind: 'self', ok: false, result: { stage: 'soft-stopped', ok: false } });
    expect(classifyPodExit({ jobReason: 'DeadlineExceeded', logs: row }))
      .toMatchObject({ class: 'deadline-exceeded' });
    expect(classifyPodExit({ jobReason: 'DeadlineExceeded', logs: row }).noResultLine).toBeUndefined();
    expect(classifyPodExit({ logs: '', result: { stage: 'soft-stopped', ok: false } }))
      .toMatchObject({ class: 'child-unconverged', noResultLine: true });
    expect(classifyPodExit({ logs: '', result: { stage: 'completed', ok: true } }))
      .toMatchObject({ class: 'no-result-line', noResultLine: true });
    expect(classifyPodExit({ logs: 'Error: child failed', result: { stage: 'completed', ok: true } }))
      .toMatchObject({ class: 'child-error', noResultLine: true });
  });

  test('excludes bookkeeping-only output from the bounded tail', () => {
    const result = classifyPodExit({ logs: [
      'ELANOUS_POD_STATUS /home/ubuntu/private/status',
      '[graph] collect fail (0.28s)',
      'at /home/ubuntu/private/worker.ts:42',
    ].join(String.fromCharCode(10)) });
    expect(result.class).toBe('no-result-line');
    expect(result.tail).toEqual([]);
    expect(result.tail.join('\\n')).not.toContain('/home/');
  });
});

describe('extractPodFailureReason', () => {
  test('takes the last error line, not the last bookkeeping line or a preceding error', () => {
    const logs = [
      'starting',
      'Error: stale failure',
      'Error: dependency unavailable',
      'at worker.ts:42',
      'ELANOUS_MEM 42 100 1:bun',
      'ELANOUS_RUN_LEDGER run-1 1/1 encoded',
      'ELANOUS_POD_SALVAGE_NONE clean',
      '{"event":"unrelated"}',
    ].join('\n');
    expect(extractPodFailureReason({ logs })).toBe('Error: dependency unavailable');
  });

  test('reads the last line of the latest failed terminal JSON error, not its first line or transfer markers', () => {
    const logs = [
      JSON.stringify({ stage: 'earlier', ok: false, error: 'old error' }),
      JSON.stringify({ stage: 'error', ok: false, error: 'first error\r\nGraphQL: API rate limit already exceeded' }),
      'ELANOUS_USAGE_ROLLUP {"measured":false}',
    ].join('\n');
    expect(extractPodFailureReason({ logs })).toBe('GraphQL: API rate limit already exceeded');
  });

  test('does not treat numbered [ask] choice text as an error', () => {
    const choices = '[ask]       0) Retry after failure\n[ask] 1) Report an error to the user';
    expect(extractPodFailureReason({ logs: choices })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
    expect(extractPodFailureReason({ logs: `Error: dependency unavailable\n${choices}` })).toBe('Error: dependency unavailable');
    const terminal = JSON.stringify({ stage: 'error', ok: false, error: `Error: dependency unavailable\n${choices}` });
    expect(extractPodFailureReason({ logs: terminal })).toBe('Error: dependency unavailable');
    expect(extractPodFailureReason({ logs: '[ask] error: choice rendering failed' })).toBe('[ask] error: choice rendering failed');
  });

  test('PREFLIGHT-RESULT-LINE: a preflight-blocked result row reads its blockers, not the [ask] choice lines', () => {
    // The real Pod tail of AUTHOR-LITE2-POD (10-09): numbered [ask] choices, then the terminal row index.ts writes before exit(1).
    const row = { kind: 'self', ok: false, stage: 'preflight-blocked', blockers: [{ kind: 'no-target-paths', name: '(대상 경로 0)', detail: '골에 실제 저장소 경로가 없다' }] };
    const logs = ['[ask] 0) Retry after failure', '[ask] 1) One error-message line', JSON.stringify(row)].join('\n');
    expect(extractPodFailureReason({ logs })).toBe('(대상 경로 0) — 골에 실제 저장소 경로가 없다');
    expect(extractPodFailureReason({ logs, result: { stage: 'preflight-blocked' } })).toBe('(대상 경로 0) — 골에 실제 저장소 경로가 없다');
    // Contrast: without blockers the row stays «result without error» and falls through to the stage.
    const bare = JSON.stringify({ kind: 'self', ok: false, stage: 'preflight-blocked' });
    expect(extractPodFailureReason({ logs: bare, result: { stage: 'preflight-blocked' } })).toBe('수렴 못 함(단계 preflight-blocked)');
    // An explicit error still wins over blockers; a passing row never invents one.
    expect(extractPodFailureReason({ logs: JSON.stringify({ ...row, error: 'Error: explicit' }) })).toBe('Error: explicit');
    expect(extractPodFailureReason({ logs: JSON.stringify({ ...row, ok: true }) })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
    // Only the preflight-blocked stage promotes blockers; another stage keeps its old fallback.
    expect(extractPodFailureReason({ logs: JSON.stringify({ ...row, stage: 'review-blocked' }), result: { stage: 'review-blocked' } })).toBe('수렴 못 함(단계 review-blocked)');
  });

  test('does not mistake an ordinary cleanup line for a failure reason', () => {
    expect(extractPodFailureReason({ logs: 'starting\ncleanup complete' })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
  });

  test('uses the error message rather than a trailing JSON error stack frame', () => {
    const logs = JSON.stringify({ stage: 'error', ok: false, error: 'Error: dependency unavailable\nat worker.ts:42' });
    expect(extractPodFailureReason({ logs })).toBe('Error: dependency unavailable');
    const annotated = JSON.stringify({ stage: 'error', ok: false, error: 'Error: dependency unavailable\ncleanup complete\nat worker.ts:42' });
    expect(extractPodFailureReason({ logs: annotated })).toBe('Error: dependency unavailable');
    const trailing = JSON.stringify({ stage: 'error', ok: false, error: 'Error: dependency unavailable\ncleanup finished\nat worker.ts:42' });
    expect(extractPodFailureReason({ logs: trailing })).toBe('Error: dependency unavailable');
  });

  test('nested child result wins over later graph bookkeeping and reports classification', () => {
    const logs = [
      JSON.stringify({ ok: false, kind: 'self', result: { ok: false, stage: 'aborted', node: 'implement', outcome: 'abandoned', prNumber: 24407, abandonedClassification: { classification: 'report-deficit', classificationBasis: 'terminal-state-not-reviewed' } } }),
      '[graph] collect fail (0.28s)',
    ].join('\n');
    expect(extractPodFailureReason({ logs })).toBe('implement abandoned · report-deficit');
    expect(extractPodFailureReason({ logs: '[graph] collect fail (0.28s)' })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
  });

  test('nested rework verdict and nested success do not reuse earlier failures', () => {
    const failed = JSON.stringify({ kind: 'self', ok: false, result: { stage: 'aborted', ok: false, node: 'rework', outcome: 'abandoned', supervisorVerdict: 'UNCONVERGEABLE' } });
    expect(extractPodFailureReason({ logs: failed })).toBe('rework abandoned · UNCONVERGEABLE');
    const success = JSON.stringify({ kind: 'self', ok: true, result: { stage: 'merged', ok: true } });
    expect(extractPodFailureReason({ logs: `${failed}\n${success}\n[graph] collect fail (0.28s)` })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
  });

  test('a non-child JSON row shaped like a result cannot clear the child failure', () => {
    const failed = JSON.stringify({ ok: false, kind: 'self', result: { ok: false, stage: 'aborted', node: 'implement', outcome: 'abandoned' } });
    const graph = JSON.stringify({ kind: 'graph', result: { stage: 'merged', ok: true } });
    const noTopOk = JSON.stringify({ kind: 'self', result: { stage: 'merged', ok: true } });
    expect(extractPodFailureReason({ logs: `${failed}\n${graph}\n${noTopOk}` })).toBe('implement abandoned');
    const flatGraph = JSON.stringify({ kind: 'graph', stage: 'merged', ok: true });
    expect(extractPodFailureReason({ logs: `${failed}\n${flatGraph}` })).toBe('implement abandoned');
    const legacyFlat = JSON.stringify({ stage: 'merged', ok: true });
    expect(extractPodFailureReason({ logs: `${failed}\n${legacyFlat}` })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
  });

  test('a later successful child result prevents attributing an earlier error to the failed Job', () => {
    const logs = `${JSON.stringify({ stage: 'error', ok: false, error: 'earlier error' })}\n${JSON.stringify({ stage: 'merged', ok: true })}\n`;
    expect(extractPodFailureReason({ logs })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
  });

  test('OOMKilled and deadline status take precedence over a stale log error', () => {
    const logs = 'Error: old failure\n';
    expect(extractPodFailureReason({ logs, containerReason: 'OOMKilled' })).toBe('OOMKilled: 컨테이너 메모리 한도 초과');
    expect(extractPodFailureReason({ logs, containerReason: 'OOMKilled', jobReason: 'DeadlineExceeded', deadlineSeconds: 90 })).toBe('DeadlineExceeded: Job 수명 상한 90초 초과');
  });

  test('names why it could not read the reason when log retrieval fails, is empty or contains only markers', () => {
    expect(extractPodFailureReason({ logs: '', logTailReason: 'kubectl logs exited 1' })).toBe('사유 못 읽음: kubectl logs exited 1');
    expect(extractPodFailureReason({ logs: '  \n' })).toBe('사유 못 읽음: 자식 로그 비어 있음');
    expect(extractPodFailureReason({ logs: 'ELANOUS_MEM 42 100 1:bun\nELANOUS_POD_SALVAGE_NONE clean' })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
    expect(extractPodFailureReason({ logs: '', logTailReason: '   ' })).not.toBe('');
  });

  test('prefers the error line inside a terminal JSON error over a trailing non-error line', () => {
    const logs = `${JSON.stringify({ stage: 'error', ok: false, error: 'Error: dependency unavailable\ncleanup completed successfully\nat worker.ts:42' })}\n`;
    expect(extractPodFailureReason({ logs })).toBe('Error: dependency unavailable');
  });

  test('bounds and redacts a long filesystem-path error before it enters the outer result', () => {
    const logs = `Error: /home/ubuntu/private/file: ${'x'.repeat(400)}\n`;
    const reason = extractPodFailureReason({ logs });
    expect(reason).toStartWith('Error: ~/private/file: ');
    expect(reason).not.toContain('/home/ubuntu/');
    expect(reason.length).toBeLessThanOrEqual(240);
  });
});

test('POD-NORESULT: no readable log line but a parsed result stage → reports the stage and PR, not «unreadable»', () => {
  const logs = '{"kind":"progress","note":"x"}\nELANOUS_RUN_LEDGER chunk\nplain progress line\n';
  expect(extractPodFailureReason({ logs, jobReason: 'BackoffLimitExceeded', containerReason: 'Error', result: { stage: 'review-blocked', prUrl: 'https://github.com/o/r/pull/24496' } }))
    .toBe('수확 가능(review-blocked) · PR https://github.com/o/r/pull/24496');
  expect(extractPodFailureReason({ logs, result: { stage: 'review-blocked', prUrl: 'https://x/pull/7', prNumber: 7 } }))
    .toBe('수확 가능(review-blocked) · PR #7');
  expect(extractPodFailureReason({ logs, jobReason: 'BackoffLimitExceeded', result: { stage: 'aborted', prUrl: null } }))
    .toBe('수렴 못 함(단계 aborted)');
});

test('POD-NORESULT: a readable error line still wins over the result row, and no result keeps «unreadable»', () => {
  expect(extractPodFailureReason({ logs: 'Error: tests failed in foo.test.ts\n', result: { stage: 'review-blocked', prUrl: null } })).toBe('Error: tests failed in foo.test.ts');
  expect(extractPodFailureReason({ logs: 'plain progress line\n', result: null })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
  expect(extractPodFailureReason({ logs: 'plain progress line\n', result: { stage: '  ', prUrl: 'https://x' } })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
  expect(extractPodFailureReason({ logs: '', containerReason: 'OOMKilled', result: { stage: 'review-blocked' } })).toBe('OOMKilled: 컨테이너 메모리 한도 초과');
});

test('classifyPodExit — a non-terminal progress JSON line mentioning error is not a child error line; /home/ paths fold in tail', () => {
  const progressOnly = classifyPodExit({ logs: '{"kind":"progress","note":"retry after error"}\n' });
  expect(progressOnly.class).toBe('no-result-line');
  const childError = classifyPodExit({ logs: 'Error: child failed at /home/ubuntu/repo/x.ts\n' });
  expect(childError.class).toBe('child-error');
  expect(childError.tail.join('\n')).toContain('~/repo/x.ts');
  expect(childError.tail.join('\n')).not.toContain('/home/');
});

test('preflight-blocked stores goal-read vs traced-path as separate ledger fields, not one name/detail sentence', () => {
  const longPath = `src/${'deep/'.repeat(50)}missing-file.ts`;
  const goalRead = {
    kind: 'self', ok: false, stage: 'preflight-blocked',
    blockers: [{
      kind: 'goal-unreadable', name: '골 문서 판독 불가: goals/long.md',
      detail: '골 문서 판독 불가: read denied — 최종 골의 traced path 를 확인할 수 없어 발사를 멈춘다',
      reasonCode: 'goal-unreadable', checkName: 'goal-read', targetPath: '/untruncated/goals/long.md',
    }],
  };
  const traced = {
    kind: 'self', ok: false, stage: 'preflight-blocked',
    blockers: [{
      kind: 'missing-traced-path', name: `실재하지 않는 traced path: ${longPath}`,
      detail: `골의 TRACED PATHS 에 선언됐지만 /root 에 없고 유효한 신설: 목록에도 없다 — ${longPath}`,
      reasonCode: 'missing-traced-path', checkName: 'missing', targetPath: longPath,
    }],
  };

  const goalRow = podTerminalRow(goalRead);
  expect(goalRow).toMatchObject({
    stage: 'preflight-blocked', ok: false,
    reasonCode: 'goal-unreadable', checkName: 'goal-read', targetPath: '/untruncated/goals/long.md',
  });
  expect(goalRow?.error).toBe('goal-unreadable · goal-read');
  expect(goalRow?.error).not.toContain(' — ');
  expect(goalRow?.targetPath).toBe('/untruncated/goals/long.md');

  const withError = { ...goalRead, error: 'Error: explicit' };
  expect(podTerminalRow(withError)).toEqual({
    stage: 'preflight-blocked', ok: false, error: 'Error: explicit',
    reasonCode: 'goal-unreadable', checkName: 'goal-read', targetPath: '/untruncated/goals/long.md',
  });
  expect(extractPodFailureReason({ logs: JSON.stringify(withError) })).toBe('Error: explicit');
  expect(classifyPodExit({ logs: JSON.stringify(withError) })).toMatchObject({
    class: 'child-unconverged', reasonCode: 'goal-unreadable', checkName: 'goal-read', targetPath: '/untruncated/goals/long.md',
  });

  const tracedRow = podTerminalRow(traced);
  expect(tracedRow).toMatchObject({
    stage: 'preflight-blocked', ok: false,
    reasonCode: 'missing-traced-path', checkName: 'missing', targetPath: longPath,
  });
  expect(tracedRow?.error).toBe('missing-traced-path · missing');
  expect(tracedRow?.error).not.toContain(' — ');
  expect(tracedRow?.targetPath).toBe(longPath);
  expect(tracedRow?.targetPath?.length).toBeGreaterThan(240);

  const classifiedGoal = classifyPodExit({ logs: JSON.stringify(goalRead) });
  expect(classifiedGoal.class).toBe('child-unconverged');
  expect(classifiedGoal.reasonCode).toBe('goal-unreadable');
  expect(classifiedGoal.checkName).toBe('goal-read');
  expect(classifiedGoal.targetPath).toBe('/untruncated/goals/long.md');
  expect(classifiedGoal.noResultLine).toBeUndefined();

  const classifiedTraced = classifyPodExit({ logs: JSON.stringify(traced) });
  expect(classifiedTraced.class).toBe('child-unconverged');
  expect(classifiedTraced.reasonCode).toBe('missing-traced-path');
  expect(classifiedTraced.checkName).toBe('missing');
  expect(classifiedTraced.targetPath).toBe(longPath);
  expect(classifiedTraced.noResultLine).toBeUndefined();

  const missingResult = classifyPodExit({ logs: '' });
  expect(missingResult.class).toBe('no-result-line');
  expect(missingResult.noResultLine).toBe(true);
  expect(missingResult.reasonCode).toBeUndefined();
  expect(missingResult.checkName).toBeUndefined();
  expect(missingResult.targetPath).toBeUndefined();

  const otherStage = podTerminalRow({
    kind: 'self', ok: false, stage: 'review-blocked',
    blockers: [{ kind: 'goal-unreadable', name: '골 문서 판독 불가: x', detail: 'hidden', reasonCode: 'goal-unreadable', checkName: 'goal-read', targetPath: 'x' }],
  });
  expect(otherStage).toEqual({ stage: 'review-blocked', ok: false });
});

test('preflight-blocked keeps each traced-path check and its actual path as an independent ledger value', () => {
  const row = {
    kind: 'self', ok: false, stage: 'preflight-blocked', error: 'Error: explicit', blockers: [
      { kind: 'missing-traced-path', reasonCode: 'missing-traced-path', checkName: 'missing', targetPath: 'src/a.ts', name: 'missing a', detail: 'a' },
      { kind: 'missing-traced-path', reasonCode: 'missing-traced-path', checkName: 'not-file', targetPath: 'src/b', name: 'not file b', detail: 'b' },
    ],
  };
  const checks = [
    { reasonCode: 'missing-traced-path', checkName: 'missing', targetPath: 'src/a.ts' },
    { reasonCode: 'missing-traced-path', checkName: 'not-file', targetPath: 'src/b' },
  ];
  expect(podTerminalRow(row)).toEqual({ stage: 'preflight-blocked', ok: false, error: 'Error: explicit', preflightChecks: checks });
  expect(classifyPodExit({ logs: JSON.stringify(row) })).toMatchObject({ class: 'child-unconverged', preflightChecks: checks });
  expect(classifyPodExit({ logs: '', result: row })).toMatchObject({ class: 'child-unconverged', preflightChecks: checks, noResultLine: true });
  expect(podTerminalRow({ ...row, error: undefined })?.error).toBe('missing-traced-path · missing · missing-traced-path · not-file');
});

test('legacy preflight blockers without structured check fields keep name and detail even for structured kinds', () => {
  const row = { kind: 'self', ok: false, stage: 'preflight-blocked', blockers: [
    { kind: 'goal-unreadable', name: '골 판독 불가', detail: 'read denied' },
    { kind: 'missing-traced-path', name: 'traced path 누락', detail: 'src/old.ts' },
  ] };
  expect(podTerminalRow(row)).toEqual({ stage: 'preflight-blocked', ok: false, error: '골 판독 불가 — read denied · traced path 누락 — src/old.ts' });
  expect(extractPodFailureReason({ logs: JSON.stringify(row) })).toBe('골 판독 불가 — read denied · traced path 누락 — src/old.ts');
  expect(podTerminalRow({ ...row, blockers: [{ kind: 'goal-unreadable', name: '골 판독 불가', detail: 'read denied' }] })?.error)
    .toBe('골 판독 불가 — read denied');
});

test('a nested child-result preflight rejection keeps reason code, check name, and path on the ledger row', () => {
  // 실제 자식 결과의 «중첩» 형식 {kind, ok, result:{stage, …}} — harness ask --json 진입점이 남기는 거절 행이다(must-fix #1).
  const row = { kind: 'self', ok: false, result: { stage: 'preflight-blocked', ok: false, blockers: [
    { kind: 'missing-traced-path', name: '실재하지 않는 traced path: docs/x.md', detail: 'docs/x.md', reasonCode: 'missing-traced-path', checkName: 'missing', targetPath: 'docs/x.md' },
  ] } };
  expect(nestedPodResult(row)).toEqual({
    stage: 'preflight-blocked',
    ok: false,
    error: 'missing-traced-path · missing',
    reasonCode: 'missing-traced-path',
    checkName: 'missing',
    targetPath: 'docs/x.md',
  });
  expect(podTerminalRow(row)).toMatchObject({ stage: 'preflight-blocked', ok: false, reasonCode: 'missing-traced-path', checkName: 'missing', targetPath: 'docs/x.md' });
  expect(classifyPodExit({ logs: JSON.stringify(row) })).toMatchObject({ class: 'child-unconverged', reasonCode: 'missing-traced-path', checkName: 'missing', targetPath: 'docs/x.md' });

  const multi = { ...row, result: { ...row.result, blockers: [
    { kind: 'missing-traced-path', reasonCode: 'missing-traced-path', checkName: 'missing', targetPath: 'src/a.ts', name: 'a', detail: 'a' },
    { kind: 'missing-traced-path', reasonCode: 'missing-traced-path', checkName: 'not-file', targetPath: 'src/b', name: 'b', detail: 'b' },
  ] } };
  expect(classifyPodExit({ logs: JSON.stringify(multi) })).toMatchObject({ class: 'child-unconverged', preflightChecks: [
    { reasonCode: 'missing-traced-path', checkName: 'missing', targetPath: 'src/a.ts' },
    { reasonCode: 'missing-traced-path', checkName: 'not-file', targetPath: 'src/b' },
  ] });
});
