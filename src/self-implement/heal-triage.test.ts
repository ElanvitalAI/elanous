import { expect, test } from 'bun:test';
import { fillMissingGateFacts, markDeletedUnverified, mergeHealSignatures, triageFailure } from './heal-triage.js';

test('환경 주장은 verify-evidence 전까지만 environment-claimed', () => {
  const signature = { environmentClaim: '할당량 소진', failedTests: 0 };
  expect(triageFailure(signature).outcome).toBe('environment-claimed');
  expect(triageFailure(signature, { visited: ['verify-evidence'] }).outcome).not.toBe('environment-claimed');
});

test('실패 시험 0 · 미검증이 문서뿐이면 untestable', () => {
  const result = triageFailure({ failedTests: 0, unverified: ['docs/a.md'] });
  expect(result.outcome).toBe('untestable');
  expect(result.evidence.length).toBeGreaterThan(0);
});

test('시험 불가 확장자와 지운 파일만 untestable', () => {
  expect(triageFailure({ failedTests: 0, unverified: ['a.json', 'b.yaml', 'c.yml', 'd.txt', '-gone.ts'] }).outcome).toBe('untestable');
});

test('importer 미실행 시험이 있으면 harness-fixable', () => {
  expect(triageFailure({ failedTests: 0, importerUnrunTests: 1, unverified: ['src/a.ts'] }).outcome).toBe('harness-fixable');
});

test('도입 실패 또는 이름이 짚이는 소스는 child-fixable', () => {
  expect(triageFailure({ failedTests: 1, introduced: 2 }).outcome).toBe('child-fixable');
  expect(triageFailure({ failedTests: 1, namedSource: 'src/a.ts' }).outcome).toBe('child-fixable');
});

test('이미 표시된 경로는 그대로 두고 unknown 은 표시하지 않는다', () => {
  const paths = ['-gone.ts', 'src/cli/daemon-attach.ts', 'kept.ts'];
  const marked = markDeletedUnverified(paths, (path) => (path === 'kept.ts' ? true : 'unknown'));
  expect(marked).toEqual(['-gone.ts', 'src/cli/daemon-attach.ts', 'kept.ts']);
  expect(markDeletedUnverified(['src/cli/daemon-attach.ts'], () => false)).toEqual(['-src/cli/daemon-attach.ts']);
});

test('게이트 사실이 없으면 칸을 더하지 않는다', () => {
  const filled = fillMissingGateFacts({ failedTests: 0 }, [{ data: { note: 'no-gate' } }]);
  expect(filled.added).toEqual([]);
  expect(filled.signature).toEqual({ failedTests: 0 });
});

test('나중 오버레이가 이기고 기여한 칸마다 출처 한 줄', () => {
  const merged = mergeHealSignatures(
    { failedTests: 0, introduced: 0 },
    [
      { source: 'collect', signature: { unverified: ['-src/cli/daemon-attach.ts'] } },
      { source: 'observe-deeper', signature: { timedOut: 1, introduced: 4 } },
    ],
  );
  expect(merged.signature).toMatchObject({ failedTests: 0, introduced: 4, timedOut: 1, unverified: ['-src/cli/daemon-attach.ts'] });
  expect(merged.evidence).toEqual(['unverified ← collect', 'introduced ← observe-deeper', 'timedOut ← observe-deeper']);
});

test('원장 errorText 는 빈 칸에만 채우고 서명 병합에도 남는다', () => {
  const entries = [{ data: { errorText: 'old' } }, { data: { errorText: 'TypeError: x is not a function' } }];
  const filled = fillMissingGateFacts({ failedTests: 1 }, entries);
  expect(filled.added).toEqual(['errorText']);
  expect(filled.signature.errorText).toBe('TypeError: x is not a function');
  expect(fillMissingGateFacts({ errorText: 'supplied' }, entries).signature.errorText).toBe('supplied');
  expect(mergeHealSignatures({ failedTests: 1 }, [{ source: 'observe-deeper', signature: filled.signature }]).signature.errorText).toBe('TypeError: x is not a function');
});

test('L2 이후 인용이 있으면 재작업, 없거나 빈 목록이면 종전 소진', () => {
  const visited = { visited: ['observe-deeper', 'ground-external'] };
  const citation = { title: 'Docs', url: 'https://example.test/docs', snippet: 'Fix' };
  expect(triageFailure({ failedTests: 1, citations: [citation] }, visited)).toMatchObject({
    outcome: 'rework-with-citations', evidence: expect.arrayContaining([citation.url]),
  });
  expect(triageFailure({ failedTests: 1, citations: [] }, visited).outcome).toBe('exhausted');
  expect(triageFailure({ failedTests: 1 }, visited).outcome).toBe('exhausted');
});

test('모호하면 방문 수로 해상도를 올린다', () => {
  const vague = { failedTests: 3, unverified: ['src/a.ts'] };
  expect(triageFailure(vague).outcome).toBe('needs-deeper-observation');
  expect(triageFailure(vague, { visited: ['observe-deeper'] }).outcome).toBe('needs-grounding');
  expect(triageFailure(vague, { visited: ['observe-deeper', 'ground-external'] }).outcome).toBe('exhausted');
});
