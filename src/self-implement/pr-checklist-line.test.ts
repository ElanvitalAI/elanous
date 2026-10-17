import { expect, test } from 'bun:test';
import { assembleBlockedDraftPrBody, prBody, prChecklistLine } from './orchestrator.js';

test('TA slot survives goal-author prose and appears as one exact PR body line', () => {
  const previous = process.env.ELANOUS_POD_SLOT_ID;
  process.env.ELANOUS_POD_SLOT_ID = 'TA-DRAFT-NO-LEFTOVER';
  try {
    const feature = '대상 경로: src/example.ts\n칸: OTHER-CARD';
    expect(prChecklistLine(feature)).toBe('칸: TA-DRAFT-NO-LEFTOVER');
    const regular = prBody(feature, 'implemented');
    expect(regular.split('\n').filter((line) => line.startsWith('칸:'))).toEqual(['칸: TA-DRAFT-NO-LEFTOVER']);
    expect(regular).toContain('> 칸: OTHER-CARD');
    const body = assembleBlockedDraftPrBody(feature, 'failed', {
      salvageStatusExpected: false, reason: 'child failed', rounds: 0, undeliveredSupervisorInputs: [],
    }).body;
    expect(body.split('\n').filter((line) => line.startsWith('칸:'))).toEqual(['칸: TA-DRAFT-NO-LEFTOVER']);
    expect(prChecklistLine('대상 경로: src/example.ts', undefined, '칸: invalid')).toBe('칸: 미상\n골 ID: 없음');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_POD_SLOT_ID;
    else process.env.ELANOUS_POD_SLOT_ID = previous;
  }
});

test('without a trusted slot, a goal token is observed without claiming a card', () => {
  const previous = process.env.ELANOUS_POD_SLOT_ID;
  delete process.env.ELANOUS_POD_SLOT_ID;
  try {
    expect(prChecklistLine('GOAL-17: implement this')).toBe('칸: 미상\n골 ID: GOAL-17');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_POD_SLOT_ID;
    else process.env.ELANOUS_POD_SLOT_ID = previous;
  }
});
