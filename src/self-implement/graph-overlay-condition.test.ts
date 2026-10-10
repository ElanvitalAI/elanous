import { describe, expect, test } from 'bun:test';
import { evaluateOverlayCondition, parseOverlayCondition } from './graph-overlay-condition.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';
import { appendRunLedgerEntry, loadRunLedger, type RunLedgerEntry } from './run-ledger.js';
import { GRAPH_SPECS } from './graph-templates.js';
import type { GraphOverlaySpec } from './graph-overlay-yaml.js';
import { RUN_STOP_CLASSES } from './run-stop.js';

describe('RFC §5 4단계 — applies_when 을 «코드»가 판정한다', () => {
  test('수 비교 — 참·거짓이 갈린다', () => {
    expect(evaluateOverlayCondition('heal_attempts >= 2', { heal_attempts: 2 })).toEqual({ kind: 'applies' });
    expect(evaluateOverlayCondition('heal_attempts >= 2', { heal_attempts: 1 })).toEqual({ kind: 'does-not-apply' });
  });

  test('낱말 비교 — == 와 != 만 읽는다', () => {
    expect(evaluateOverlayCondition('goal_type == research', { goal_type: 'research' })).toEqual({ kind: 'applies' });
    expect(evaluateOverlayCondition('goal_type != research', { goal_type: 'implement' })).toEqual({ kind: 'applies' });
  });

  test('🔑 ⛔ 「그 키가 «없다»」는 「거짓」과 «다른 값»이다 — 계측 결손을 정상으로 접지 않는다', () => {
    expect(evaluateOverlayCondition('heal_attempts >= 2', {}))
      .toEqual({ kind: 'key-absent', key: 'heal_attempts' });
    // 값이 «수가 아니면» 비교 불가다 — 거짓으로 접으면 「비교했는데 안 맞았다」로 읽힌다.
    expect(evaluateOverlayCondition('heal_attempts >= 2', { heal_attempts: 'many' }))
      .toEqual({ kind: 'key-absent', key: 'heal_attempts' });
  });

  test('🔑 ⛔ «못 읽는» 조건은 조용히 참이 되지 않는다 — 얹지 않고 그 사실을 말한다', () => {
    expect(evaluateOverlayCondition('heal_attempts && rm -rf /', { heal_attempts: 9 }).kind).toBe('unparseable');
    // ⛔ 문자열에 대소 비교를 쓰면 «사전순»으로 몰래 답하지 않는다.
    expect(evaluateOverlayCondition('goal_type > research', { goal_type: 'x' }).kind).toBe('unparseable');
  });

  test('⛔ 표현식 엔진이 «아니다» — 문법은 「키 연산자 값」 하나뿐이다', () => {
    for (const bad of ['a >= 1 && b >= 2', '(a >= 1)', 'a.b >= 1', 'a >= 1;', '!a']) {
      expect({ source: bad, ok: parseOverlayCondition(bad).ok }).toEqual({ source: bad, ok: false });
    }
  });

  test('STOP-RECORD class and measured review repeats select only their own branches', () => {
    const state = { stop_class: 'review-repeat', review_repeat: 2, attempts: 3 };
    for (const cls of RUN_STOP_CLASSES) {
      expect(evaluateOverlayCondition(`stop_class == ${cls}`, { stop_class: cls })).toEqual({ kind: 'applies' });
      expect(evaluateOverlayCondition(`stop_class != ${cls}`, { stop_class: cls })).toEqual({ kind: 'does-not-apply' });
    }
    expect(evaluateOverlayCondition('stop_class == review-repeat', state)).toEqual({ kind: 'applies' });
    expect(evaluateOverlayCondition('stop_class == main-sync', state)).toEqual({ kind: 'does-not-apply' });
    expect(evaluateOverlayCondition('review_repeat >= 2', state)).toEqual({ kind: 'applies' });
    expect(evaluateOverlayCondition('review_repeat > 2', state)).toEqual({ kind: 'does-not-apply' });
    expect(evaluateOverlayCondition('stop_class == review-repeat', { attempts: 0 })).toEqual({ kind: 'key-absent', key: 'stop_class' });
    expect(evaluateOverlayCondition('review_repeat >= 0', { attempts: 0 })).toEqual({ kind: 'key-absent', key: 'review_repeat' });
  });

  test('other stop branch vocabulary is measurable only when supplied; unknown is not false or zero', () => {
    const conditions = ['sibling_overlap == true', 'author_grade == full', 'main_sync_conflict == true'];
    const state = { sibling_overlap: true, author_grade: 'full', main_sync_conflict: true };
    for (const condition of conditions) {
      expect(evaluateOverlayCondition(condition, state)).toEqual({ kind: 'applies' });
      expect(evaluateOverlayCondition(condition, {})).toEqual({ kind: 'key-absent', key: condition.split(' ')[0] });
    }
    expect(evaluateOverlayCondition('main_sync_conflict == true', { main_sync_conflict: false })).toEqual({ kind: 'does-not-apply' });
    expect(evaluateOverlayCondition('goal_type == true', { goal_type: 'true' })).toEqual({ kind: 'applies' });
    expect(evaluateOverlayCondition('author_grade == lite', { author_grade: 'lite' })).toEqual({ kind: 'applies' });
    expect(evaluateOverlayCondition('author_grade == full', { author_grade: undefined })).toEqual({ kind: 'key-absent', key: 'author_grade' });
    expect(evaluateOverlayCondition('sibling_overlap == true', { sibling_overlap: null })).toEqual({ kind: 'key-absent', key: 'sibling_overlap' });
    expect(evaluateOverlayCondition('sibling_overlap == true', { sibling_overlap: 'true' })).toEqual({ kind: 'key-absent', key: 'sibling_overlap' });
    for (const [condition, value] of [['sibling_overlap == TRUE', 'TRUE'], ['main_sync_conflict == yes', 'yes'], ['sibling_overlap == 1', 1], ['main_sync_conflict != false', 'no']] as const) {
      const key = condition.split(' ')[0]!;
      expect(evaluateOverlayCondition(condition, { [key]: value })).toEqual({ kind: 'key-absent', key });
    }
    expect(evaluateOverlayCondition('main_sync_conflict == true', { main_sync_conflict: 'true' })).toEqual({ kind: 'key-absent', key: 'main_sync_conflict' });
  });

  test('조건이 «없는» 오버레이는 항상 후보다', () => {
    expect(evaluateOverlayCondition(undefined, {})).toEqual({ kind: 'applies' });
  });
});

test('runtime branch is applied by runSelfImplement, while unknown STOP-RECORD and review count stay absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'overlay-stop-vocab-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    const entries: RunLedgerEntry[] = [];
    const spec = GRAPH_SPECS['self-implement']!;
    const index = spec.nodes.findIndex(node => node.nodeId === 'implement');
    const gateIndex = spec.nodes.findIndex(node => node.nodeId === 'gate');
    const overlays: GraphOverlaySpec[] = [
      { overlayId: 'stop-unclassified', target: 'self-implement', stage: 'runtime', appliesWhen: 'stop_class == unclassified', patch: [{ op: 'replace', path: `/nodes/${index}/maxVisits`, value: 11 }] },
      { overlayId: 'review-repeat', target: 'self-implement', stage: 'runtime', appliesWhen: 'review_repeat >= 2', patch: [{ op: 'replace', path: `/nodes/${gateIndex}/maxVisits`, value: 12 }] },
      { overlayId: 'review-too-many', target: 'self-implement', stage: 'runtime', appliesWhen: 'review_repeat >= 3', patch: [{ op: 'replace', path: `/nodes/${index}/maxVisits`, value: 14 }] },
      { overlayId: 'attempt', target: 'self-implement', stage: 'runtime', appliesWhen: 'attempts >= 0', patch: [{ op: 'replace', path: `/nodes/${index}/maxVisits`, value: 13 }] },
    ];
    const result = await runSelfImplement({
      feature: 'runtime overlay branch fixture', goalId: 'aabbccddaabbccdd', memory: false, completion: 'worktree-only', graphOverlays: overlays,
      seams: seams({ writeRunLedger: entry => { entries.push(entry); appendRunLedgerEntry(entry); } }),
    });
    expect(result.ok).toBe(true);
    const runtime = entries.find(entry => entry.event === 'graph-overlay-decision' && entry.data.stage === 'runtime');
    expect(runtime).toBeDefined();
    expect(runtime!.data.applied).toContain('attempt');
    expect(runtime!.data.selections).toEqual(expect.arrayContaining([
      expect.objectContaining({ overlayId: 'stop-unclassified', verdict: 'key-absent' }),
      expect.objectContaining({ overlayId: 'review-repeat', verdict: 'key-absent' }),
    ]));
    expect(runtime!.data.state).toEqual({ attempts: 0, goal_id: 'aabbccddaabbccdd' });

    const unknownRunId = 'run-22222222-2222-4222-8222-222222222222';
    appendRunLedgerEntry({ runId: unknownRunId, event: 'stop', data: {
      class: 'not-a-stop-class', cause: 'unclassified source', evidenceRef: 'fixture', nextMove: 'inspect',
    } });
    const unknownEntries: RunLedgerEntry[] = [];
    await runSelfImplement({
      runId: unknownRunId, feature: 'unknown STOP-RECORD branch fixture', memory: false, completion: 'worktree-only', graphOverlays: overlays,
      seams: seams({ writeRunLedger: entry => { unknownEntries.push(entry); appendRunLedgerEntry(entry); } }),
    });
    const unknown = unknownEntries.find(entry => entry.event === 'graph-overlay-decision' && entry.data.stage === 'runtime');
    expect(unknown!.data.selections).toEqual(expect.arrayContaining([expect.objectContaining({ overlayId: 'stop-unclassified', verdict: 'key-absent' })]));
    expect(unknown!.data.state).toEqual({ attempts: 0 });
    expect(unknown!.data.stateExtraKeys).toBeUndefined();

    const knownRunId = 'run-11111111-1111-4111-8111-111111111111';
    const stopped = await runSelfImplement({
      runId: knownRunId, feature: 'run-generated stop', memory: false, completion: 'worktree-only', graphOverlays: overlays,
      seams: seams({ implement: async () => ({ ok: false, summary: 'child stopped' }),
        writeRunLedger: appendRunLedgerEntry }),
    });
    expect(stopped.stage).toBe('aborted');
    expect((loadRunLedger(knownRunId) ?? []).some(entry => entry.event === 'stop' && entry.data.class === 'unclassified')).toBe(true);
    const knownEntries: RunLedgerEntry[] = [];
    const knownResult = await runSelfImplement({
      runId: knownRunId, feature: 'known STOP-RECORD branch fixture', memory: false, completion: 'worktree-only', graphOverlays: overlays,
      seams: seams({ writeRunLedger: entry => { knownEntries.push(entry); appendRunLedgerEntry(entry); } }),
    });
    expect(knownResult.ok).toBe(true);
    const known = knownEntries.find(entry => entry.event === 'graph-overlay-decision' && entry.data.stage === 'runtime');
    expect(known!.data.applied).toContain('stop-unclassified');
    expect(known!.data.appliedPatches).toEqual(expect.arrayContaining([expect.objectContaining({ overlayId: 'stop-unclassified', field: 'maxVisits', after: 11 })]));
    expect((loadRunLedger(knownRunId) ?? []).filter(entry => entry.event === 'graph-overlay-decision' && entry.data.stage === 'runtime' && Array.isArray(entry.data.applied) && entry.data.applied.includes('stop-unclassified')).length).toBeGreaterThanOrEqual(1);
    expect(known!.data.state).toEqual({ attempts: 0 });
    expect(known!.data.stateExtraKeys).toContain('stop_class');
    expect(known!.data.selections).toEqual(expect.arrayContaining([expect.objectContaining({ overlayId: 'review-repeat', verdict: 'key-absent' })]));

    const repeatEntries: RunLedgerEntry[] = [];
    let reviewCalls = 0;
    await runSelfImplement({
      feature: 'review repeat branch fixture', memory: false, completion: 'worktree-only', graphOverlays: overlays,
      maxReworkRounds: 3,
      seams: seams({ gateResults: [true, true, true, true], reviewDiff: async () => ({ verdict: 'fail', mustFix: [`fix review ${++reviewCalls}`], shouldFix: [], summary: 'must fix', reviewed: true, diffTruncated: false }),
        writeRunLedger: entry => { repeatEntries.push(entry); appendRunLedgerEntry(entry); } }),
    });
    const reviewDecisions = repeatEntries.filter(entry => entry.event === 'graph-overlay-decision' && entry.data.stage === 'runtime');
    expect(reviewDecisions.map(entry => [entry.data.round, Array.isArray(entry.data.stateExtraKeys) && entry.data.stateExtraKeys.includes('review_repeat')])).toEqual([
      [0, false], [1, true], [2, true], [3, true],
    ]);
    expect(reviewDecisions[1]!.data.selections).toEqual(expect.arrayContaining([expect.objectContaining({ overlayId: 'review-repeat', verdict: 'does-not-apply' })]));
    expect(reviewDecisions[2]!.data.selections).toEqual(expect.arrayContaining([expect.objectContaining({ overlayId: 'review-repeat', verdict: 'does-not-apply' })]));
    expect(reviewDecisions[1]!.data.selections).toEqual(expect.arrayContaining([expect.objectContaining({ overlayId: 'review-too-many', verdict: 'does-not-apply' })]));
    const repeated = reviewDecisions.find(entry => entry.data.round === 3);
    expect(repeated).toBeDefined();
    expect(repeated!.data.applied).toContain('review-repeat');
    expect(repeated!.data.appliedPatches).toEqual(expect.arrayContaining([expect.objectContaining({ overlayId: 'review-repeat', field: 'maxVisits', after: 12 })]));
    expect((loadRunLedger(repeated!.runId) ?? []).filter(entry => entry.event === 'graph-overlay-decision' && entry.data.stage === 'runtime' && Array.isArray(entry.data.applied) && entry.data.applied.includes('review-repeat')).length).toBeGreaterThanOrEqual(1);
    expect(repeated!.data.stateExtraKeys).toContain('review_repeat');
    expect(repeated!.data.state).toEqual({ attempts: 3 });
    expect(repeated!.data.selections).toEqual(expect.arrayContaining([expect.objectContaining({ overlayId: 'review-too-many', verdict: 'does-not-apply' })]));
    expect(reviewCalls).toBe(4);
    const reviewedIds = repeatEntries.filter(entry => entry.event === 'reviewed').map(entry => entry.data.findingIds as string[]);
    expect(reviewedIds.length).toBe(4);
    expect(reviewedIds.every((ids, index) => index === 0 || ids.every(id => !reviewedIds[index - 1]!.includes(id)))).toBe(true);
    expect(repeated!.data.selections).toEqual(expect.arrayContaining([expect.objectContaining({ overlayId: 'review-repeat', verdict: 'applies' })]));
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
