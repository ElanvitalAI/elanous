import { describe, expect, test } from 'bun:test';
import {
  executeGoalAuthorReviewerPrecheck,
  parseGoalAuthorReviewerPrecheck,
  resolveGoalAuthorReviewerPrecheckEnabled,
  runGoalAuthorReviewerPrecheck,
} from './goal-author.js';
import { getUserConfig, reloadUserConfig, resetUserConfig } from '../user-config.js';
import type { LLMMessage } from '../llm.js';
import { writeAuthoredGoal } from './goal-author.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { runGoalAuthorCli } from './goal-author-cli.js';
import { dispatchSelfImplement } from '../boot/daemon-tools/self-implement.js';
import {
  _setSelfImplementCliCommandForTesting,
  _setSelfImplementGoalAuthorForTesting,
  selfImplementRuntime,
} from './self-implement-runtime.js';

const goalDocument = (criterion = 'The result has a measurable criterion.') => [
  'Reviewable goal',
  '- GoalId: 1234567890abcdef',
  '- RootIntent: preserve measurable authoring',
  '- GoalType: implement',
  '',
  '## PROBLEM', '- The current goal needs clearer acceptance.',
  '',
  '## WHAT TO BUILD', '- Make the goal measurable.',
  'Original ask (verbatim, unmodified):', '```text', '대상 경로: src/self-implement/goal-author.ts', 'The result has a measurable criterion and an observable source.', '```',
  '',
  '## ACCEPTANCE CRITERIA', `- ${criterion}`,
  '',
  '## REQUIRED EVIDENCE', '- [requested] focused test output',
  '',
  '## TRACED PATHS', '- src/self-implement/goal-author.ts — author entrypoint',
  '',
  '## SCOPE BOUNDARY', '- 대상 경로: src/self-implement/goal-author.ts',
  '',
  '## 답하지 못하는 것', '- No unresolved questions.',
  '',
  '## 불변식', '- The original ask remains verbatim.',
  '',
  '## 판정 신호', '- Condition: the authoring result is reviewed', '- Observation: revised acceptance is present', '- Expected result: the criterion is measurable.',
].join('\n');
const revisedCriterionDocument = () => goalDocument().replace(
  '- The result has a measurable criterion.',
  '- The result has a measurable criterion.\n- The result has a measurable criterion and an observable source.',
);
const criterionEdit = () => ({
  fix: 'The result has a measurable criterion and an observable source.',
  originalText: '- The result has a measurable criterion.',
  revisedText: '- The result has a measurable criterion.\n- The result has a measurable criterion and an observable source.',
});
const good = (revisedDocument: string) => JSON.stringify({ suggestions: ['tighten boundary'], fixes: ['The result has a measurable criterion and an observable source.'], fixEvidence: [criterionEdit()], remainingNeedsHuman: ['confirm rollout owner'], revisedDocument });
const precheckResult = (revisedDocument: string, fixEvidence = [criterionEdit()]) => ({
  suggestions: ['tighten boundary'], fixes: ['The result has a measurable criterion and an observable source.'], fixEvidence, remainingNeedsHuman: ['confirm rollout owner'],
  revisedDocument, appliedFixes: [], unappliedItems: [],
});

describe('AUTHOR-REVIEWER-PRECHECK-WIRE', () => {
  test('off is the default shared config and skips without a provider call', async () => {
    const config = getUserConfig();
    const off = { ...config, tools: { ...config.tools, selfImplement: { ...config.tools.selfImplement, goalAuthorReviewerPrecheck: false } } };
    expect(resolveGoalAuthorReviewerPrecheckEnabled(off)).toBe(false);
    let calls = 0;
    const events: string[] = [];
    const result = await executeGoalAuthorReviewerPrecheck(false, 'goal', 'run-1', async () => {
      calls += 1;
      return parseGoalAuthorReviewerPrecheck(good(goalDocument()));
    }, (event) => events.push(event));
    expect(result).toEqual({ status: 'skipped' });
    expect(calls).toBe(0);
    expect(events).toEqual(['precheck-skipped']);
  });

  test('file writer honors the shared off switch and applies only a validated pre-write revision', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'author-reviewer-precheck-wire-'));
    const oldStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = join(cwd, 'state');
    let calls = 0;
    const writerDeps = {
      ground: async () => { throw new Error('lite authoring must not ground'); },
      enhance: async (original: string) => ({ original, checklist: [], verbatimPreserved: true }),
      authorGrade: { grade: 'lite' as const, source: 'flag' as const },
      slugFn: async () => 'reviewer-precheck-fixture',
    };
    try {
      const off = await writeAuthoredGoal('대상 경로: src/example.ts\n판정선: 결과에 관측 가능한 증거가 있다.', cwd, {
        ...writerDeps,
        reviewerPrecheckEnabled: false,
        reviewerPrecheck: async () => { calls += 1; return precheckResult(goalDocument()); },
      }, { now: () => new Date('2026-10-29T00:00:00Z') });
      expect(calls).toBe(0);
      expect(off.authored.reviewerPrecheck).toBeUndefined();
      const askExcerpt = '판정선: 결과에 관측 가능한 증거가 있다.';
      expect(off.authored.document.split(`\n- [requested] ${askExcerpt}`).length - 1).toBe(0);
      const on = await writeAuthoredGoal('대상 경로: src/example.ts\n판정선: 결과에 관측 가능한 증거가 있다.', cwd, {
        ...writerDeps,
        goalTitle: 'Second reviewable goal',
        reviewerPrecheckEnabled: true,
        reviewerPrecheck: async (document) => {
          calls += 1;
          return {
            suggestions: ['tighten boundary'], fixes: ['판정선: 결과에 관측 가능한 증거가 있다.'],
            fixEvidence: [{ fix: '판정선: 결과에 관측 가능한 증거가 있다.', originalText: '- [requested] Verify the decision signal and the verbatim ask.', revisedText: '- [requested] Verify the decision signal and the verbatim ask.\n- [requested] 판정선: 결과에 관측 가능한 증거가 있다.' }],
            remainingNeedsHuman: ['confirm rollout owner'],
            revisedDocument: document.replace('- [requested] Verify the decision signal and the verbatim ask.', '- [requested] Verify the decision signal and the verbatim ask.\n- [requested] 판정선: 결과에 관측 가능한 증거가 있다.'),
            appliedFixes: [], unappliedItems: [],
          };
        },
      }, { now: () => new Date('2026-10-29T00:01:00Z') });
      expect(calls).toBe(1);
      expect(on.authored.reviewerPrecheck?.appliedFixes).toEqual(['판정선: 결과에 관측 가능한 증거가 있다.']);
      expect(on.authored.document.split(`\n- [requested] ${askExcerpt}`).length - 1).toBe(1);
      expect((await Bun.file(on.path).text()).split(`\n- [requested] ${askExcerpt}`).length - 1).toBe(1);
    } finally {
      if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('opt-in makes one pinned Terra-medium request and preserves all result arrays', async () => {
    let calls = 0;
    let sent: LLMMessage[] = [];
    let options: Parameters<typeof import('../llm.js').streamLLM>[2] | undefined;
    const stream: typeof import('../llm.js').streamLLM = async (messages, _onChunk, opts = {}) => {
      calls += 1;
      sent = messages;
      options = opts;
      opts.onResolvedProvider?.(opts.provider!.name, opts.model!);
      return good(revisedCriterionDocument());
    };
    const result = await runGoalAuthorReviewerPrecheck(goalDocument(), { stream });
    expect(calls).toBe(1);
    expect(options).toMatchObject({ model: 'gpt-6.1-terra', reasoningEffort: 'medium', usageRole: 'review', usagePhase: 'author-reviewer-precheck' });
    expect(options?.provider?.name).toBe('openai-codex');
    expect(String(sent[0]?.content)).toContain('Reviewable goal');
    const applied = await executeGoalAuthorReviewerPrecheck(true, goalDocument(), 'run-apply', async () => result);
    expect(applied).toMatchObject({ status: 'completed', result: { appliedFixes: ['The result has a measurable criterion and an observable source.'], unappliedItems: [] } });
    expect(applied.result?.revisedDocument).toContain('measurable criterion and an observable source');
  });

  test('provider errors and malformed JSON fail soft with observable result', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const observe = (event: string, data: Record<string, unknown>) => events.push({ event, data });
    const failed = await executeGoalAuthorReviewerPrecheck(true, 'goal', 'run-2', async () => { throw new Error('provider unavailable'); }, observe);
    const malformed = await executeGoalAuthorReviewerPrecheck(true, goalDocument(), 'run-3', async () => parseGoalAuthorReviewerPrecheck('{bad json'), observe);
    expect(failed.status).toBe('failed-soft');
    expect(malformed.status).toBe('failed-soft');
    expect(events.map((entry) => entry.event)).toEqual(['failed-soft', 'failed-soft']);
    expect(events[0]?.data).toMatchObject({ authorRunId: 'run-2', correctedItems: 0 });
  });

  test('invalid revised structure keeps the original and routes unapplied fixes to needs-human', async () => {
    const original = goalDocument();
    const result = await executeGoalAuthorReviewerPrecheck(true, original, 'run-invalid-revision', async () => ({
      ...precheckResult('changed required headings'),
    }));
    expect(result.status).toBe('rejected-soft');
    expect(result.result?.revisedDocument).toBe(original);
    expect(result.result?.appliedFixes).toEqual([]);
    expect(result.result?.unappliedItems).toEqual(['The result has a measurable criterion and an observable source.']);
    expect(result.result?.remainingNeedsHuman).toEqual(['confirm rollout owner', 'The result has a measurable criterion and an observable source.']);
  });

  test('a revision without declared fixes cannot silently change the document', async () => {
    const original = goalDocument();
    const result = await executeGoalAuthorReviewerPrecheck(true, original, 'run-unreported-edit', async () => ({
      ...precheckResult(original.replace('The current goal needs clearer acceptance.', 'Add a new unrelated requirement.')),
      fixes: [], fixEvidence: [],
    }));
    expect(result.status).toBe('rejected-soft');
    expect(result.result?.revisedDocument).toBe(original);
  });

  test('fix evidence cannot delete original acceptance criteria or add text outside the original ask', async () => {
    const original = goalDocument();
    const criterion = '- The result has a measurable criterion.';
    const deleted = original.replace(criterion, '');
    const deletedResult = await executeGoalAuthorReviewerPrecheck(true, original, 'run-delete-criterion', async () =>
      precheckResult(deleted, [{ fix: 'remove acceptance criterion', originalText: criterion, revisedText: '' }]));
    const outOfScope = original.replace(criterion, `${criterion}\n- Publish company data to social media.`);
    const outOfScopeResult = await executeGoalAuthorReviewerPrecheck(true, original, 'run-out-of-scope-edit', async () =>
      precheckResult(outOfScope, [{ fix: 'add social media publication', originalText: criterion, revisedText: `${criterion}\n- Publish company data to social media.` }]));
    const partialCriterion = '- The result has a measurable criterion';
    const rewordedCriterion = original.replace(criterion, '- The result has a measurable and an observable source criterion.');
    const partialCriterionResult = await executeGoalAuthorReviewerPrecheck(true, original, 'run-partial-criterion-edit', async () =>
      precheckResult(rewordedCriterion, [{ fix: 'add observable source', originalText: partialCriterion, revisedText: '- The result has a measurable and an observable source' }]));
    const sameLineDocument = original.replace(criterion, `${criterion} and an observable source`);
    const sameLineResult = await executeGoalAuthorReviewerPrecheck(true, original, 'run-same-line-criterion-edit', async () =>
      precheckResult(sameLineDocument, [{ fix: 'add observable source', originalText: criterion, revisedText: `${criterion} and an observable source` }]));
    const headingDocument = original.replace('## ACCEPTANCE CRITERIA', '## ACCEPTANCE CRITERIA\n- The result has another criterion.');
    const headingAnchorResult = await executeGoalAuthorReviewerPrecheck(true, original, 'run-heading-anchor-edit', async () =>
      precheckResult(headingDocument, [{ fix: 'add another criterion', originalText: '## ACCEPTANCE CRITERIA', revisedText: '## ACCEPTANCE CRITERIA\n- The result has another criterion.' }]));
    expect(deletedResult.status).toBe('rejected-soft');
    expect(deletedResult.result?.revisedDocument).toBe(original);
    expect(outOfScopeResult.status).toBe('rejected-soft');
    expect(outOfScopeResult.result?.revisedDocument).toBe(original);
    expect(partialCriterionResult.status).toBe('rejected-soft');
    expect(partialCriterionResult.result?.revisedDocument).toBe(original);
    expect(sameLineResult.status).toBe('rejected-soft');
    expect(sameLineResult.result?.revisedDocument).toBe(original);
    expect(headingAnchorResult.status).toBe('rejected-soft');
    expect(headingAnchorResult.result?.revisedDocument).toBe(original);
  });

  test('applied fix descriptions must equal the exact sentence appended to the criterion', async () => {
    const original = goalDocument();
    const revised = revisedCriterionDocument();
    const result = await executeGoalAuthorReviewerPrecheck(true, original, 'run-fix-description-mismatch', async () => ({
      ...precheckResult(revised),
      fixes: ['add an observable source'],
      fixEvidence: [{
        fix: 'add an observable source',
        originalText: '- The result has a measurable criterion.',
        revisedText: '- The result has a measurable criterion.\n- The result has a measurable criterion and an observable source.',
      }],
    }));
    expect(result.status).toBe('rejected-soft');
    expect(result.result?.revisedDocument).toBe(original);
    expect(result.result?.appliedFixes).toEqual([]);
    expect(result.result?.unappliedItems).toEqual(['add an observable source']);
  });

  test('a partial phrase cannot invert an original negation or condition', async () => {
    const criterion = '- The result has a measurable criterion.';
    for (const [ask, partial, runId] of [
      ['Do not delete files.', 'delete files.', 'run-negation-fragment'],
      ['Only if approved, publish externally.', 'publish externally.', 'run-condition-fragment'],
    ] as const) {
      const original = goalDocument().replace(
        'The result has a measurable criterion and an observable source.',
        ask,
      );
      const addedBullet = `\n- ${partial}`;
      const revised = original.replace(criterion, `${criterion}${addedBullet}`);
      const edit = { fix: 'copy request into acceptance criteria', originalText: criterion, revisedText: `${criterion}${addedBullet}` };
      const result = await executeGoalAuthorReviewerPrecheck(true, original, runId, async () =>
        precheckResult(revised, [edit]));
      expect(result.status).toBe('rejected-soft');
      expect(result.result?.revisedDocument).toBe(original);
      expect(result.result?.appliedFixes).toEqual([]);
    }
  });

  test('real config omitted/false/true reaches CLI, daemon, and task-agent runtime plus the disk file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'author-reviewer-precheck-entrypoints-'));
    const oldStateDir = process.env.ELANOUS_STATE_DIR;
    const oldConfigDir = getElanousConfigDirOverride();
    process.env.ELANOUS_STATE_DIR = join(cwd, 'state');
    const configDir = join(cwd, 'config');
    mkdirSync(configDir, { recursive: true });
    setElanousConfigDir(configDir);
    const configPath = join(configDir, 'config.json');
    let writeIndex = 0;
    const writes: Array<Awaited<ReturnType<typeof writeAuthoredGoal>>> = [];
    const reviewerCalls: string[] = [];
    const author = async (ask: string, _requestedCwd: string, deps: Partial<import('./goal-author.js').GoalAuthorDeps> = {}) => {
      const result = await writeAuthoredGoal(ask, cwd, {
        ground: async () => ({ grounded: false, context: '', files: [], persistentEvidence: [], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] }),
        enhance: async (original) => ({ original, checklist: [], verbatimPreserved: true }),
        authorGrade: { grade: 'lite', source: 'flag' },
        slugFn: async () => `entry-${writeIndex++}`,
        ...deps,
        reviewerPrecheck: async (document) => {
          reviewerCalls.push(document);
          const originalText = '- [requested] Verify the decision signal and the verbatim ask.';
          const revisedText = `${originalText}\n- [requested] 판정선: 기록 문서에 Wiring evidence marker가 있다.`;
          const revisedDocument = document.replace(originalText, revisedText);
          return {
            suggestions: [], fixes: ['판정선: 기록 문서에 Wiring evidence marker가 있다.'], fixEvidence: [{
              fix: '판정선: 기록 문서에 Wiring evidence marker가 있다.', originalText, revisedText,
            }],
            remainingNeedsHuman: [], revisedDocument, appliedFixes: [], unappliedItems: [],
          };
        },
      });
      writes.push(result);
      return result;
    };
    const verifyStates = async (runEntry: (tag: string) => Promise<void>, name: string) => {
      for (const state of ['omitted', 'false', 'true'] as const) {
        const rawConfig = { tools: { selfImplement: state === 'omitted' ? {} : { goalAuthorReviewerPrecheck: state === 'true' } } };
        writeFileSync(configPath, JSON.stringify(rawConfig));
        const loaded = reloadUserConfig(configPath);
        const enabled = state === 'true';
        expect(loaded.tools.selfImplement.goalAuthorReviewerPrecheck).toBe(enabled);
        const before = writes.length;
        const callsBefore = reviewerCalls.length;
        await runEntry(`${name}-${state}`);
        expect(reviewerCalls.length).toBe(callsBefore + (enabled ? 1 : 0));
        const authored = writes[before]?.authored;
        const disk = await Bun.file(writes[before]!.path).text();
        expect(authored?.reviewerPrecheck?.appliedFixes ?? []).toEqual(enabled ? ['판정선: 기록 문서에 Wiring evidence marker가 있다.'] : []);
        expect(authored?.document.split('\n- [requested] 판정선: 기록 문서에 Wiring evidence marker가 있다.').length - 1).toBe(enabled ? 1 : 0);
        expect(disk.split('\n- [requested] 판정선: 기록 문서에 Wiring evidence marker가 있다.').length - 1).toBe(enabled ? 1 : 0);
      }
    };

    try {
      await verifyStates(async (tag) => {
        await runGoalAuthorCli([`대상 경로: src/${tag}.ts\n판정선: 기록 문서에 Wiring evidence marker가 있다.`], { cwd, authorGrade: { grade: 'lite', source: 'flag' } }, { recordAsk: () => true, write: author });
      }, 'cli');
      await verifyStates(async (tag) => {
        const ask = `대상 경로: src/${tag}.ts\n판정선: 기록 문서에 Wiring evidence marker가 있다.`;
        await dispatchSelfImplement(
          { feature: ask }, { cwd, signal: new AbortController().signal, entry: 'elanous-apparatus', userText: ask },
          async () => ({ runId: `run-${tag}`, ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed' }),
          author,
        );
      }, 'daemon');
      _setSelfImplementGoalAuthorForTesting(author);
      _setSelfImplementCliCommandForTesting(async () => ({ ok: true, kind: 'observed' } as never));
      await verifyStates(async (tag) => {
        await selfImplementRuntime.run({ feature: `대상 경로: src/${tag}.ts\n판정선: 기록 문서에 Wiring evidence marker가 있다.` }, { surface: 'chat', sessionId: `session-${tag}`, signal: new AbortController().signal } as never);
      }, 'task-agent-runtime');
    } finally {
      _setSelfImplementGoalAuthorForTesting(null);
      _setSelfImplementCliCommandForTesting(null);
      resetUserConfig();
      resetElanousConfigDir();
      if (oldConfigDir !== undefined) setElanousConfigDir(oldConfigDir);
      if (oldStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldStateDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('GoalType changes are rejected before writing', async () => {
    const original = goalDocument();
    const changedType = revisedCriterionDocument().replace('- GoalType: implement', '- GoalType: research');
    const result = await executeGoalAuthorReviewerPrecheck(true, original, 'run-changed-goal-type', async () =>
      precheckResult(changedType, [criterionEdit()]));
    expect(result.status).toBe('rejected-soft');
    expect(result.result?.revisedDocument).toBe(original);
    expect(result.result?.appliedFixes).toEqual([]);
    expect(result.result?.unappliedItems).toEqual(['The result has a measurable criterion and an observable source.']);
  });

  test('missing, unchanged, or partial per-fix evidence rejects the entire revision', async () => {
    const original = goalDocument();
    const revised = revisedCriterionDocument();
    const incomplete = { ...precheckResult(revised), fixes: ['The result has a measurable criterion and an observable source.', 'add an observable source'], fixEvidence: [criterionEdit()] };
    let index = 0;
    for (const candidate of [
      precheckResult(revised, []),
      precheckResult(revised, [{ fix: 'The result has a measurable criterion and an observable source.', originalText: 'not in original', revisedText: 'not in revision' }]),
      incomplete,
      {
        ...precheckResult(revised),
        fixes: ['The result has a measurable criterion and an observable source.', 'claim another fix'],
        fixEvidence: [criterionEdit(), { fix: 'claim another fix', originalText: '- [requested] focused test output', revisedText: '- [requested] focused test output' }],
      },
    ]) {
      const observed: Array<Record<string, unknown>> = [];
      const result = await executeGoalAuthorReviewerPrecheck(true, original, `run-bad-evidence-${index++}`, async () =>
        candidate, (_event, data) => observed.push(data));
      expect(result.status).toBe('rejected-soft');
      expect(observed[0]?.fixEvidence).toEqual(candidate.fixEvidence);
      expect(result.result?.revisedDocument).toBe(original);
      expect(result.result?.appliedFixes).toEqual([]);
      expect(result.result?.unappliedItems).toEqual(candidate.fixes);
    }
  });

  test('completed results report corrected item count without dropping suggestions or needs-human', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await executeGoalAuthorReviewerPrecheck(true, goalDocument(), 'run-4', async () => precheckResult(revisedCriterionDocument()),
      (event, data) => events.push({ event, data }));
    expect(result.status).toBe('completed');
    expect(result.result?.suggestions).toEqual(['tighten boundary']);
    expect(result.result?.remainingNeedsHuman).toEqual(['confirm rollout owner']);
    expect(events[0]?.data).toMatchObject({ model: 'gpt-6.1-terra', appliedFixCount: 1, appliedFixes: ['The result has a measurable criterion and an observable source.'], fixEvidence: [criterionEdit()], fixesResult: ['The result has a measurable criterion and an observable source.'] });
  });
});
