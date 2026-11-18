import { describe, expect, test } from 'bun:test';
import { checkPromptOutput, parsePromptOutputSpec, runStructuredPrompt, type PromptOutputSpec } from './prompt-output.js';

const spec = parsePromptOutputSpec({ fields: { verdict: ['pass', 'fail'], reason: 'string', score: 'number' }, outcome: 'verdict', retries: 2 }) as PromptOutputSpec; // 출처: #38776 시험 벡터(리터럴)

describe('GRAPH-LLM-JSON-OUTPUT prompt output spec', () => {
  test('parses fields, outcome and retries; defaults retries to 1', () => {
    expect(spec).toEqual({ fields: { verdict: ['pass', 'fail'], reason: 'string', score: 'number' }, outcome: 'verdict', retries: 2 }); // 출처: #38776 시험 벡터(리터럴)
    expect(parsePromptOutputSpec({ fields: { ok: 'boolean' } })).toEqual({ fields: { ok: 'boolean' }, retries: 1 }); // 출처: #38776 시험 벡터(리터럴)
  });

  test('refuses malformed specs with a literal reason', () => {
    const bad = [null, { fields: {} }, { fields: { Verdict: 'string' } }, { fields: { v: 'date' } }, { fields: { v: ['a', 'a'] } },
      { fields: { v: 'string' }, outcome: 'v' }, { fields: { v: ['a'] }, outcome: 'w' }, { fields: { v: ['a'] }, retries: 4 }, { fields: { v: ['a'] }, schema: {} }]; // 출처: #38776 시험 벡터(리터럴)
    expect(bad.map(parsePromptOutputSpec)).toEqual(['output must be a map', 'output.fields needs 1..12 fields',
      'output.fields name is not a lower_snake key: Verdict', 'output.fields.v must be string, number, boolean or a list of distinct strings',
      'output.fields.v must be string, number, boolean or a list of distinct strings', 'output.outcome must be an enum (list) field',
      'output.outcome must name a declared field', 'output.retries must be an integer 0..3', 'output allows only fields, outcome, retries']);
  });
});

describe('GRAPH-LLM-JSON-OUTPUT reply check', () => {
  test('takes the last JSON object out of prose or a fence and drops extra keys', () => {
    expect(checkPromptOutput('Sure.\n```json\n{"verdict":"pass","reason":"ok","score":0.9,"extra":1}\n```', spec))
      .toEqual({ ok: true, value: { verdict: 'pass', reason: 'ok', score: 0.9 } });
    expect(checkPromptOutput('{"verdict":"fail","reason":"r","score":1} trailing } brace', spec))
      .toEqual({ ok: true, value: { verdict: 'fail', reason: 'r', score: 1 } });
  });

  test('says exactly what is wrong', () => {
    expect([
      checkPromptOutput('no json here', spec),
      checkPromptOutput('{"verdict":"pass","score":1}', spec),
      checkPromptOutput('{"verdict":"maybe","reason":"r","score":1}', spec),
      checkPromptOutput('{"verdict":"pass","reason":"r","score":"high"}', spec),
      checkPromptOutput('{ {', spec),
    ]).toEqual([
      { ok: false, reason: 'no JSON object in the reply' },
      { ok: false, reason: 'missing field reason' },
      { ok: false, reason: 'field verdict must be one of pass|fail' },
      { ok: false, reason: 'field score must be number' },
      { ok: false, reason: 'no JSON object in the reply' },
    ]);
  });

  test('a leading brace and a very long reply terminate', () => {
    for (const reply of ['{', `${'{'.repeat(5000)}${'}'.repeat(5000)}`]) expect(checkPromptOutput(reply, spec)).toEqual({ ok: false, reason: 'no JSON object in the reply' });
  });
});

describe('GRAPH-LLM-JSON-OUTPUT retry loop', () => {
  test('a bad reply is retried with the reason; the outcome key is set from the enum field', async () => {
    const asked: string[] = [];
    const replies = ['I think it passes.', '{"verdict":"pass","reason":"tests green","score":1}'];
    const result = await runStructuredPrompt('Judge the run.', spec, async (text) => { asked.push(text); return replies.shift()!; });
    expect(result).toEqual({ ok: true, output: { verdict: 'pass', reason: 'tests green', score: 1, outcome: 'pass' }, attempts: 2 }); // 출처: #38776 시험 벡터(리터럴)
    expect(asked).toEqual([
      'Judge the run.\n\nReply with only one JSON object: { "verdict": "pass" | "fail", "reason": string, "score": number }.',
      'Judge the run.\n\nYour previous reply was not usable: no JSON object in the reply. Reply with only one JSON object: { "verdict": "pass" | "fail", "reason": string, "score": number }.',
    ]);
  });

  test('after retries + 1 misses the node fails with the last reason and no output', async () => {
    let calls = 0;
    const result = await runStructuredPrompt('Judge.', spec, async () => { calls++; return '{"verdict":"maybe","reason":"r","score":1}'; });
    expect([calls, result]).toEqual([3, { ok: false, output: null, attempts: 3, error: 'output schema not met after 3 attempts: field verdict must be one of pass|fail' }]); // 출처: #38776 시험 벡터(리터럴)
  });

  test('without an outcome field the output is just the declared fields', async () => {
    const plain = parsePromptOutputSpec({ fields: { summary: 'string' }, retries: 0 }) as PromptOutputSpec; // 출처: #38776 시험 벡터(리터럴)
    expect(await runStructuredPrompt('Sum.', plain, async () => '{"summary":"s"}')).toEqual({ ok: true, output: { summary: 's' }, attempts: 1 }); // 출처: #38776 시험 벡터(리터럴)
  });
});
