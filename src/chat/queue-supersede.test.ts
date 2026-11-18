import { describe, expect, test } from 'bun:test';
import { stripQueueModelContext, withInterruptedOnPurposeContext, withReplacementCandidateContext } from './interjection.js';
import { createNextTuiQueue } from '../tui/core/queue.js';
import {
  detectReplacementCandidate, extractSupersedeTargets, findCorrectionWord, REPLACEMENT_CANDIDATE_NOTE_PREFIX,
  replacementCandidateContextLine, replacementCandidateScreenLine, type ReplacementCandidate, type SupersedeQueueItem,
} from './queue-supersede.js';

const queued = (id: string, text: string, kind = 'user'): SupersedeQueueItem => ({ id, text, status: 'queued', kind });

function candidateOf(detection: ReturnType<typeof detectReplacementCandidate>): ReplacementCandidate {
  if (detection.kind !== 'candidate') throw new Error(`expected a candidate, got ${detection.reason}`);
  return detection;
}

describe('ELN-QUEUE-SUPERSEDE — target extraction and correction words', () => {
  test('targets: PR #N, ELN- cell ids and explicit file paths; slash commands are not paths', () => {
    expect(extractSupersedeTargets('PR #38026 의 src/tui/core/queue.ts 와 ELN-QUEUE-SUPERSEDE 칸')).toEqual([
      '#38026', 'ELN-QUEUE-SUPERSEDE', 'src/tui/core/queue.ts',
    ]);
    expect(extractSupersedeTargets('./src/chat/interjection.ts 고쳐')).toEqual(['src/chat/interjection.ts']);
    expect(extractSupersedeTargets('/help 보여줘')).toEqual([]);
    expect(extractSupersedeTargets('그거 다시 해')).toEqual([]);
  });

  test('correction words in Korean and English; none in a plain request', () => {
    expect(findCorrectionWord('#1 말고 #2 로 가')).toBe('말고');
    expect(findCorrectionWord('#1 은 보류해')).toBe('보류');
    expect(findCorrectionWord('use #2 instead')).toBe('instead');
    expect(findCorrectionWord('Cancel #1 please')).toBe('cancel');
    expect(findCorrectionWord('#1 착지해')).toBeNull();
    expect(findCorrectionWord('read the notice for #1')).toBeNull();
  });
});

describe('ELN-QUEUE-SUPERSEDE — detector (pure)', () => {
  test('same PR + correction word → a candidate on the one waiting item that names it', () => {
    const detection = detectReplacementCandidate(queued('q2', '#38026 말고 #38030 으로 올려'), [queued('q1', '#38026 착지해')]);
    expect(detection).toEqual({ kind: 'candidate', id: 'q2', candidateFor: 'q1', targets: ['#38026'], correctionWord: '말고' });
  });

  test('different targets → nothing', () => {
    expect(detectReplacementCandidate(queued('q2', '#2 말고 다른 걸로'), [queued('q1', '#1 착지해')]))
      .toEqual({ kind: 'none', reason: 'no-overlap' });
  });

  test('same target but no correction word → nothing', () => {
    expect(detectReplacementCandidate(queued('q2', '#1 리뷰도 봐줘'), [queued('q1', '#1 착지해')]))
      .toEqual({ kind: 'none', reason: 'no-correction-word' });
  });

  test('ambiguous (two waiting items share the target) → nothing; never guesses', () => {
    expect(detectReplacementCandidate(queued('q3', 'ELN-X-Y 는 보류'), [queued('q1', 'ELN-X-Y 시작'), queued('q2', 'ELN-X-Y 시험 추가')]))
      .toEqual({ kind: 'none', reason: 'ambiguous' });
  });

  test('delivered, cancelled, superseded items and notices are never candidates', () => {
    const correction = queued('q9', 'src/a/b.ts 고쳐서 다시 — 앞 지시 취소');
    for (const status of ['delivered', 'cancelled', 'superseded']) {
      expect(detectReplacementCandidate(correction, [{ id: 'q1', text: 'src/a/b.ts 작성', status, kind: 'user' }]))
        .toEqual({ kind: 'none', reason: 'no-overlap' });
    }
    expect(detectReplacementCandidate(correction, [queued('q1', 'src/a/b.ts 작성 끝남', 'notice')]))
      .toEqual({ kind: 'none', reason: 'no-overlap' });
    expect(detectReplacementCandidate(queued('q9', '#1 취소', 'notice'), [queued('q1', '#1 착지해')]))
      .toEqual({ kind: 'none', reason: 'not-user' });
  });

  test('one screen line and one model-context line; the person\'s words come back unchanged', () => {
    const oldText = '#38026 착지해\n그리고 OP 우편';
    const candidate = candidateOf(detectReplacementCandidate(queued('q2', '#38026 보류해'), [queued('q1', oldText)]));
    const screen = replacementCandidateScreenLine(candidate, oldText);
    const context = replacementCandidateContextLine(candidate, oldText) ?? '';
    expect(screen.includes('\n')).toBe(false);
    expect(context.includes('\n')).toBe(false);
    expect(screen).toContain('자동 취소 없음');
    expect(context.startsWith(REPLACEMENT_CANDIDATE_NOTE_PREFIX)).toBe(true);
    expect(context).toContain('q1');
    expect(context).toContain('자동 취소되지 않았습니다');
    const sent = withReplacementCandidateContext('#38026 보류해', context);
    expect(sent.split('\n').filter((line) => line.startsWith(REPLACEMENT_CANDIDATE_NOTE_PREFIX))).toEqual([context]);
    expect(stripQueueModelContext(sent)).toBe('#38026 보류해');
    // Both queue context lines together (Esc then a candidate) still strip back to the person's words.
    expect(stripQueueModelContext(withInterruptedOnPurposeContext(sent))).toBe('#38026 보류해');
    expect(stripQueueModelContext('[대체 후보 아님] 평범한 문장')).toBe('[대체 후보 아님] 평범한 문장');
  });
});

test('#38029 r1 MF: the context line follows the old item\'s status — queued, already delivered, or gone', () => {
  const oldText = '#38026 착지해';
  const candidate = candidateOf(detectReplacementCandidate(queued('q2', '#38026 말고 보류해'), [queued('q1', oldText)]));
  const queuedLine = replacementCandidateContextLine(candidate, oldText, 'queued') ?? '';
  expect(queuedLine).toContain('대기 중이던');
  const deliveredLine = replacementCandidateContextLine(candidate, oldText, 'delivered') ?? '';
  expect(deliveredLine.startsWith(REPLACEMENT_CANDIDATE_NOTE_PREFIX)).toBe(true);
  expect(deliveredLine).toContain('이미 전달·실행된');
  expect(deliveredLine).toContain('앞 지시는 이미 실행됨');
  expect(deliveredLine).not.toContain('대기 중이던');
  expect(deliveredLine).not.toContain('자동 취소되지 않았습니다');
  expect(replacementCandidateContextLine(candidate, oldText, 'cancelled')).toBeNull();
  expect(replacementCandidateContextLine(candidate, oldText, 'superseded')).toBeNull();
});

test('#38029 r1 MF: idle dispatch order — when the correction is dequeued the old item is already delivered', () => {
  const queue = createNextTuiQueue();
  const first = queue.enqueue('ELN-DIFF-RENDER #37992 착지해');
  const correction = queue.enqueue('#37992 말고 #37995 로 가');
  const candidate = queue.replacementCandidate(correction.id);
  expect(candidate?.candidateFor).toBe(first.id);
  // Same delivery → seq order: the old instruction leaves (and runs) first.
  const out1 = queue.dequeue();
  expect(out1.kind === 'submit' && out1.id).toBe(first.id);
  const out2 = queue.dequeue();
  expect(out2.kind === 'submit' && out2.id).toBe(correction.id);
  const old = queue.get(first.id);
  expect(old?.status).toBe('delivered');
  const line = replacementCandidateContextLine(candidate!, old!.text, old!.status) ?? '';
  expect(line).toContain('이미 전달·실행된');
  expect(line).not.toContain('대기 중이던');
});
