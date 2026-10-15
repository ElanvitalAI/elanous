import { describe, expect, test } from 'bun:test';
import {
  appendEvidenceLocationRequirement,
  EVIDENCE_LOCATION_REQUIREMENT,
  REQUIRED_BLOCKS,
} from '../src/self-implement/goal-author.js';
import {
  applyManualGoalEvidenceRequirement,
  runDevPipeline,
} from '../src/self-dev/dev-pipeline.js';
import { TEST_FAKE_LLM_ENV } from '../src/ux-sim/fake-llm.js';

describe('hand-authored --file goal evidence contract', () => {
  test('uses the author-owned shared requirement for a hand-authored goal without rewriting its source', () => {
    const source = '## WHAT TO BUILD\n\nBuild the requested behavior.';
    const authored = appendEvidenceLocationRequirement(source);
    const result = applyManualGoalEvidenceRequirement({ file: 'docs/goals/manual.txt' }, source);

    expect(authored).toBe(`${source}\n\n${EVIDENCE_LOCATION_REQUIREMENT}`);
    expect(result).toBe(authored);
    expect(source).toBe('## WHAT TO BUILD\n\nBuild the requested behavior.');
  });

  test('does not duplicate the shared requirement already present in an authored goal', () => {
    const source = `## ACCEPTANCE CRITERIA\n- ${EVIDENCE_LOCATION_REQUIREMENT}`;

    expect(applyManualGoalEvidenceRequirement({ file: 'docs/goals/authored.txt' }, source)).toBe(source);
  });

  test('leaves direct text input unchanged', () => {
    const text = 'Build the requested behavior.';

    expect(applyManualGoalEvidenceRequirement({ text }, text)).toBe(text);
  });

  // ⛔ 픽스처가 `## REQUIRED EVIDENCE` 를 갖는 것은 장식이 아니다 — 나중에 들어온 발사 전 게이트
  //   (preflightGoalFileEvidence)가 요구 증거 없는 --file 골을 fail-closed 로 막는다. 이제 같은
  //   파일 입구가 full goal-file lint도 타므로, 이 fixture는 canonical nine sections도 만족해야
  //   원래 검증하려던 "증거 위치 계약이 child까지 전달된다"를 계속 고립해서 잰다.
  test('passes the attached requirement to the self-implement boundary for --file input', async () => {
    // The goal boundary is the subject here; a keyless gate Pod still needs a
    // deterministic provider while the pipeline resolves its LLM before dispatch.
    const previousFake = process.env[TEST_FAKE_LLM_ENV];
    process.env[TEST_FAKE_LLM_ENV] = '1';
    const sectionContents: Record<(typeof REQUIRED_BLOCKS)[number], string> = {
      '## PROBLEM': 'manual goal evidence contract',
      '## WHAT TO BUILD': 'Build the requested behavior.',
      '## ACCEPTANCE CRITERIA': '- [build] focused test reaches the self-implement boundary.',
      '## REQUIRED EVIDENCE': '- [build] the focused test file and its summary line',
      '## TRACED PATHS': 'none',
      '## SCOPE BOUNDARY': 'This fixture only exercises manual evidence attachment.',
      '## 답하지 못하는 것': 'none',
      '## 불변식': 'The source text remains unmodified.',
      '## 판정 신호': 'The child receives the appended requirement.',
    };
    const source = REQUIRED_BLOCKS.map((heading) => `${heading}\n${sectionContents[heading]}`).join('\n\n');
    let feature = '';

    try {
      await runDevPipeline(
        {
          input: { file: 'docs/goals/manual.txt' },
          executor: { kind: 'self' },
          completion: 'worktree-only',
        },
        {
          readFile: (path) => {
            expect(path).toBe('docs/goals/manual.txt');
            return source;
          },
          runSelfImplement: async (options) => {
            feature = options.feature;
            return { ok: true } as never;
          },
        },
      );
    } finally {
      if (previousFake === undefined) delete process.env[TEST_FAKE_LLM_ENV];
      else process.env[TEST_FAKE_LLM_ENV] = previousFake;
    }
    expect(feature).toBe(`${source}\n\n${EVIDENCE_LOCATION_REQUIREMENT}`);
  });

  // 반증 입력 — 위 케이스가 게이트를 우회해서 통과한 것이 아님을 가른다.
  test('rejects a --file goal that declares no required evidence before reaching the boundary', async () => {
    let reached = false;

    await expect(runDevPipeline(
      {
        input: { file: 'docs/goals/manual.txt' },
        executor: { kind: 'self' },
        completion: 'worktree-only',
      },
      {
        readFile: () => '## WHAT TO BUILD\n\nBuild the requested behavior.',
        runSelfImplement: async () => { reached = true; return { ok: true } as never; },
      },
    )).rejects.toThrow('골 파일에 요구 증거가 없습니다');
    expect(reached).toBe(false);
  });
});
