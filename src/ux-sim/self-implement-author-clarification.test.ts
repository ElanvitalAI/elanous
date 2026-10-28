import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchSelfImplement, _setObserveOnlyConfigReaderForTesting } from '../boot/daemon-tools/self-implement.js';
import type { SelfImplementResult } from '../self-implement/orchestrator.js';
import { escalateGoalDocumentClarifications } from '../self-implement/goal-clarification-escalation.js';
import type { QuestionChannel } from '../hitl/question.js';

test('E4: unresolved SelfImplement goal is policy-answered before the real escalation boundary; no question popup and one tool line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-self-implement-clarification-'));
  const goalFile = join(root, 'GOAL-test.md');
  const injected = [
    '## WHAT TO BUILD',
    'Question: NOT-GROUNDED — Which implementation target?',
    'Answer: UNANSWERED — implementation_target',
    '',
    '- Clarification:',
    '  - id: implementation_target',
    '  - header: Target',
    '  - question: Which implementation target should be used?',
    '  - options:',
    '    - label: Focus the requested change',
    '      description: Use only scope stated by the request.',
    '  - includeOther: true',
    '  - answer: DEFERRED-UNTIL: Which implementation target should be used?',
    '',
  ].join('\n');
  let popupCount = 0;
  let escalationDispatchCount = 0;
  _setObserveOnlyConfigReaderForTesting(() => false);
  const questionChannel: QuestionChannel = {
    name: 'telegram',
    async ask() { popupCount += 1; return null; },
    cancel() {},
  };
  const resolver = async () => ({});
  const expected: SelfImplementResult = {
    runId: 'ux-sim-clarification-run', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: 'completed',
  };
  try {
    const result = await dispatchSelfImplement(
      { feature: 'ambiguous implementation target' },
      {
        cwd: root,
        signal: new AbortController().signal,
        entry: 'elanous-apparatus',
        surface: 'tui',
        surfaceQuestionChannels: [questionChannel],
        userText: '구현 대상이 충분히 분명하지 않은 요청',
      },
      async (options) => {
        const finalized = readFileSync(options.goalFile!, 'utf8');
        expect(finalized).toContain('provenance.assumption-source: policy-default');
        expect(finalized).not.toContain('Answer: UNANSWERED — implementation_target');
        const escalation = await escalateGoalDocumentClarifications({
          goalFile: options.goalFile!,
          testOrigin: true,
          selfAnswerPath: 'say-first',
          selfResolveClarification: resolver,
          dispatch: async () => {
            escalationDispatchCount += 1;
            throw new Error('human clarification popup must not be dispatched');
          },
        });
        expect(escalation).toMatchObject({ outcome: 'skipped', unanswered: 0 });
        return expected;
      },
      async () => {
        writeFileSync(goalFile, injected);
        return { path: goalFile };
      },
      undefined,
      undefined,
      resolver,
    );
    expect(result.kind).toBe('launched');
    expect(result.message.split(/\r?\n/)).toHaveLength(1);
    expect(popupCount).toBe(0);
    expect(escalationDispatchCount).toBe(0);
  } finally {
    _setObserveOnlyConfigReaderForTesting();
    rmSync(root, { recursive: true, force: true });
  }
});
