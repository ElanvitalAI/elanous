import { expect, test } from 'bun:test';
import { RESEARCH_NO_PROCESS_NARRATION_RULE } from './research-policy.js';

// OP #113145: the synthesizer echoed the evidence trace's status lines as prose. The instruction must forbid narrating
// the collection process and per-source verification/date status, and point verification state to structured citation fields.
test('synthesis instruction forbids narrating collection and per-source verification/date status in the answer body', () => {
  const rule = RESEARCH_NO_PROCESS_NARRATION_RULE;
  expect(rule).toContain('Do not narrate the evidence-collection process');
  expect(rule).toContain('excerpts');
  expect(rule).toContain('verification or publication-date status');
  expect(rule).toContain('cite the sources');
  expect(rule).toContain('structured citation fields, not by prose');
});

// JUD #113291: the process-narration ban must not swallow the mandatory 미확인 label for claims without a source row.
test('the process-narration ban carries an explicit exception that keeps the 미확인 label (or omits the claim)', () => {
  const rule = RESEARCH_NO_PROCESS_NARRATION_RULE;
  expect(rule).toContain('Exception that always wins over the rule above');
  expect(rule).toContain('without a matching complete source row must keep its 미확인 label');
  expect(rule).toContain('or be left out of the answer');
  expect(rule.split('Exception that always wins')[0]).toContain('structured citation fields, not by prose');
});
