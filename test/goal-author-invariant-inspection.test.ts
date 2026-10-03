import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspectAskInvariantMarker } from '../src/self-implement/goal-author.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const facts = {
  grounded: true,
  context: '',
  files: ['src/example.ts'],
  persistentEvidence: ['src/example.ts:1 — Read-verified evidence.'],
  codeFacts: [],
  skillFacts: [],
  memoryFacts: [],
  documentFacts: [],
  documentMatches: [],
  searchTerms: [],
  genericSearchScope: false,
  refFacts: [],
  ptyFacts: [],
};

function inspectFromCli(root: string, ask: string): Record<string, unknown> {
  const output = execFileSync('bun', [join(process.cwd(), 'bin', 'elanous.mjs'), '--test', 'self', 'author', '--cwd', root, '--inspect-invariant', ask], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(output) as Record<string, unknown>;
}

describe('inspectAskInvariantMarker diagnostics', () => {
  test('names every previously conflated grounding outcome without changing legacy evidence values', () => {
    expect(inspectAskInvariantMarker('불변식: src/example.ts remains unchanged.')).toMatchObject({
      pathEvidence: 'unknown',
      unmatchedEvidencePaths: ['src/example.ts'],
      groundingInspection: 'not-attempted',
      invariantPathStatus: 'inspection-not-attempted',
    });
    expect(inspectAskInvariantMarker('불변식: token remains unchanged.', facts)).toMatchObject({
      pathEvidence: false,
      unmatchedEvidencePaths: [],
      groundingInspection: 'attempted',
      invariantPathStatus: 'no-invariant-paths-supplied',
    });
    expect(inspectAskInvariantMarker('불변식: src/example.ts remains unchanged.', facts)).toMatchObject({
      pathEvidence: true,
      unmatchedEvidencePaths: [],
      groundingInspection: 'attempted',
      invariantPathStatus: 'all-supplied-paths-matched',
    });
    expect(inspectAskInvariantMarker('불변식: src/missing.ts remains unchanged.', facts)).toMatchObject({
      pathEvidence: false,
      unmatchedEvidencePaths: ['src/missing.ts'],
      groundingInspection: 'attempted',
      invariantPathStatus: 'invariant-grounding-mismatch',
    });
    expect(inspectAskInvariantMarker('불변식 설명: src/example.ts remains unchanged.', facts)).toMatchObject({
      pathEvidence: false,
      unmatchedEvidencePaths: [],
      groundingInspection: 'attempted',
      invariantPathStatus: 'zero-invariants',
    });
  });

  test('preserves marker-absent evidence values and names partial path matches', () => {
    const partialFacts = {
      ...facts,
      persistentEvidence: ['src/matched.ts:1 — Read-verified evidence.'],
    };

    expect(inspectAskInvariantMarker('plain ask without an invariant marker.', facts)).toMatchObject({
      pathEvidence: false,
      unmatchedEvidencePaths: [],
    });
    expect(inspectAskInvariantMarker('plain ask without an invariant marker.')).toMatchObject({
      pathEvidence: 'unknown',
      unmatchedEvidencePaths: [],
    });
    // 🩸 회귀: facts 는 «있는데» persistentEvidence 가 «0» 인 경우. 여기서 옛 값은 'unknown' 이다.
    //    이 줄이 없던 판이 그 자리를 false 로 바꿨고(이른 반환), 위 두 단언은 그것을 «못 봤다» —
    //    하나는 증거가 «있는» facts 를, 다른 하나는 facts=null 을 쟀기 때문이다.
    expect(inspectAskInvariantMarker('plain ask without an invariant marker.', { ...facts, persistentEvidence: [] })).toMatchObject({
      pathEvidence: 'unknown',
      unmatchedEvidencePaths: [],
      groundingInspection: 'not-attempted',
      invariantPathStatus: 'zero-invariants',
    });
    expect(inspectAskInvariantMarker('불변식: src/matched.ts and src/missing.ts remain unchanged.', partialFacts)).toMatchObject({
      pathEvidence: false,
      unmatchedEvidencePaths: ['src/missing.ts'],
      invariantPathStatus: 'partial-supplied-paths-matched',
    });
  });

  test('serializes distinguishable diagnostics through src/index.ts self author inspection caller', () => {
    const root = process.cwd();
    // ⛔ 이 시험은 «실제 저장소 루트»에서 CLI 를 띄운다 — 그러면 「그 CLI 가 트리를 쓰나」가 질문이 된다.
    //    ⇒ 「안 쓴다」를 «주장»으로 두지 않고 이 시험이 «계약»으로 붙잡는다.
    //    🔑 이 저장소가 여러 번 잃은 자리다 — 도구가 사람 트리에 쓰면 다음 `git pull` 이 깨진다.
    //    ⛔⭐ 다만 «전 트리»를 대조하지 않는다 — 그러면 «병렬 시험»이 만든 변경에 이 시험이 빨강이 된다
    //       (내가 플레이크를 «넣는» 셈이다). ⇒ 저작 경로가 실제로 쓰는 자리 `docs/goals/` 로 «좁힌다».
    //    ⚠️ 이 자가 «못 보는» 것: 썼다가 «되돌리는» 쓰기 · `.gitignore` 된 경로 · docs/goals 밖의 쓰기.
    const goalDocs = () => readdirSync(join(root, 'docs', 'goals')).sort().join('\n');
    const goalDocsBefore = goalDocs();
    const noPaths = inspectFromCli(root, '불변식: token remains unchanged.');
    const matched = inspectFromCli(root, '불변식: src/self-implement/goal-author.ts remains unchanged.');
    const zeroInvariants = inspectFromCli(root, '불변식 설명: src/self-implement/goal-author.ts remains unchanged.');

    expect(noPaths).toMatchObject({ pathEvidence: 'unknown', unmatchedEvidencePaths: [], groundingInspection: 'not-attempted', invariantPathStatus: 'no-invariant-paths-supplied' });
    expect(matched).toMatchObject({ pathEvidence: true, unmatchedEvidencePaths: [], groundingInspection: 'attempted', invariantPathStatus: 'all-supplied-paths-matched' });
    expect(zeroInvariants).toMatchObject({ pathEvidence: false, unmatchedEvidencePaths: [], groundingInspection: 'attempted', invariantPathStatus: 'zero-invariants' });

    // ⛔ 반증: 이 CLI 경로가 골 문서를 «하나라도» 만들면 이 단언이 빨강이 된다.
    expect(goalDocs()).toBe(goalDocsBefore);
    expect(new Set([noPaths.invariantPathStatus, matched.invariantPathStatus, zeroInvariants.invariantPathStatus])).toHaveLength(3);
  }, 20_000);
});
