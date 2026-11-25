import { describe, expect, test } from 'bun:test';
import { buildUniversalPreamble } from '../src/prompt-library/universal-preamble.js';
import { buildGpt6CoordinatorAddendum } from '../src/prompt-library/gpt6-family-addendum.js';
import { effectiveReasoningLevel } from '../src/llm.js';

describe('seat operating contract', () => {
  for (const seatRole of ['coordinator', 'hand'] as const) {
    for (const modelFamily of ['gpt', 'other'] as const) {
      test(`${seatRole} ${modelFamily}`, () => {
        const messages = buildUniversalPreamble({ cwd: '/tmp', seatRole, modelFamily, enabledTools: ['Read'] });
        const contents = messages.map(m => String(m.content));
        expect(contents.filter(s => s.includes('## Seat operating contract (every elanous seat)'))).toHaveLength(1);
        expect(contents.join('\n')).toContain('Search merged and open PRs and the main-branch code by work-item ID, path, and keywords. If implementation already exists, verify, wire it up, and collect evidence instead of implementing it again.');
        expect(contents.join('\n')).toContain('Explore before you give up');
        expect(contents.join('\n')).toContain('When woken by mail, read the whole unread inbox in one call');
        expect(contents.join('\n')).toContain('Reversible, read-only, in-scope, or policy-covered actions need no human approval: do them, then record them.');
        expect(contents.join('\n')).toContain('Do not re-run the same status query in the same turn.');
        expect(contents.join('\n')).toContain('handle every actionable item in this turn, and bulk-ack the info-only ones.');
      });
    }
  }
  test('non-seat sessions do not receive seat contract', () => {
    const messages = buildUniversalPreamble({ cwd: '/tmp' });
    expect(messages.map(m => String(m.content)).join('\n')).not.toContain('## Seat operating contract (every elanous seat)');
  });
  test('coordinator gpt permission timing without autonomy block', () => {
    const text = buildGpt6CoordinatorAddendum().map(m => String(m.content)).join('\n');
    expect(text).toContain('## When to ask for permission (GPT-6 guidance)');
    expect(text).not.toContain('## Autonomy and persistence (GPT-6 guidance)');
    // SEAT-TURN-PERSIST — the coordinator keeps a role-adapted persistence block (codex gpt_5_2_prompt.md:111).
    expect(text).toContain('## Persistence (coordinator seat)');
    expect(text).toContain('take it in this turn instead of reporting it');
  });
  test('existing model default is high and explicit levels survive', () => {
    expect(effectiveReasoningLevel({}, 'openai-codex', 'gpt-6-terra')).toBe('high');
    expect(effectiveReasoningLevel({ reasoningLevel: 'medium' }, 'openai-codex', 'gpt-6-terra')).toBe('medium');
  });
});
