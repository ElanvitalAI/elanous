import { expect, test } from 'bun:test';
import { ANSWER_COMPOSE, createAnswerComposeProvider, type AnswerComposeInput } from './answer-compose.js';

const input: AnswerComposeInput = { question: 'What changed?', sources: [
  { id: 's1', title: 'Notice', url: 'https://example.org/notice', snippet: 'Revision A applies.' },
  { id: 's2', title: 'FAQ', url: 'https://example.org/faq', snippet: 'The old process is retired.' },
] };
const citation = { sourceId: 's1', url: 'https://example.org/notice' };

function providerFor(answer: string, citations: readonly { sourceId: string; url: string }[] = [citation]) {
  return createAnswerComposeProvider({ compose: async () => ({ answer, citations }) });
}

test('answer.compose@1 returns plain-text answer and source-bound structured citations', async () => {
  expect(ANSWER_COMPOSE.id).toBe('answer.compose@1');
  let calls = 0;
  const provider = createAnswerComposeProvider({ compose: async received => {
    calls++;
    expect(received).toEqual(input);
    expect(received).not.toBe(input);
    expect(Object.isFrozen(received.sources)).toBe(true);
    expect(Object.isFrozen(received.sources[0])).toBe(true);
    return { answer: 'Revision A applies [1].', citations: [citation] };
  } });
  expect(await provider(input)).toEqual({ status: 'ok', answer: 'Revision A applies [1].', citations: [citation], sourceIds: ['s1'] });
  expect(calls).toBe(1);
});

test('bad source input fails before invoking the model', async () => {
  let calls = 0;
  const provider = createAnswerComposeProvider({ compose: async () => { calls++; throw new Error('should not run'); } });
  for (const bad of [
    { ...input, question: ' ' },
    { ...input, sources: [] },
    { ...input, sources: [input.sources[0], input.sources[0]] },
    { ...input, sources: [{ ...input.sources[0], url: 'javascript:alert(1)' }] },
    { ...input, sources: [{ ...input.sources[0], url: 'https://user:pass@example.org/' }] },
    { ...input, sources: [{ ...input.sources[0], url: 'https://example.org/' + 'a'.repeat(2_049) }] },
  ]) expect((await provider(bad)).status).toBe('invalid-input');
  expect(calls).toBe(0);
});

test('HTTP, query, terminal punctuation and UTF-8 URL bytes are checked only in citations[]', async () => {
  const prefix = 'https://example.org/';
  const atLimit = prefix + 'a'.repeat(2_048 - prefix.length);
  const multibyteAtLimit = prefix + 'a'.repeat(2_048 - prefix.length - Buffer.byteLength('é')) + 'é';
  for (const url of ['http://example.org/notice', 'https://example.org/notice?a=1&b=2',
    'https://example.org/notice?', 'https://example.org/a%20b', atLimit]) {
    const source = { ...input.sources[0]!, url };
    expect((await providerFor('Notice [1].', [{ sourceId: 's1', url }])({ ...input, sources: [source] })).status).toBe('ok');
  }
  expect(Buffer.byteLength(multibyteAtLimit)).toBe(2_048);
  expect((await providerFor('Notice [1].', [{ sourceId: 's1', url: multibyteAtLimit }])({ ...input, sources: [{ ...input.sources[0]!, url: multibyteAtLimit }] })).status).toBe('ok');
  expect((await providerFor('Notice [1].')({ ...input, sources: [{ ...input.sources[0]!, url: atLimit + 'a' }] })).status).toBe('invalid-input');
});

test('free-text URL, markup-like text, entities and backslashes stay inert prose', async () => {
  for (const prose of [
    'See https://evil.example/notice)unverified.',
    'See https://example.org/notice? and https://example.org/notice.',
    String.raw`R&D &copy; C:\notes\file`,
    '<a href="javascript:alert(1)">open</a>',
    '[1](javascript:alert(1)) and https&#58;//evil.example/',
    '[forged.id] [unfinished',
  ]) {
    const answer = `Claim [1]. ${prose}`;
    expect(await providerFor(answer)(input)).toEqual({ status: 'ok', answer, citations: [citation], sourceIds: ['s1'] });
  }
});

test('citation markers bind positions in citations[] to exact supplied source URLs', async () => {
  const both = [citation, { sourceId: 's2', url: 'https://example.org/faq' }];
  expect((await providerFor('First [1], second [2].', both)(input)).status).toBe('ok');
  for (const [answer, citations] of [
    ['Claim [1]', [{ sourceId: 's1', url: 'https://evil.example/' }]],
    ['Claim [1]', [{ sourceId: 's3', url: citation.url }]],
    ['Claim', [citation]],
    ['Claim [2]', [citation]],
    ['Claim [0]', [citation]],
    ['Claim [999999999999999999999999999999999]', [citation]],
    ['Claim [1]', []],
    ['First [1] only', both],
    ['First [1] and [2]', [citation, citation]],
  ] as const) expect((await providerFor(answer, citations)(input)).status).toBe('invalid-citations');
});

test('model failure is sanitized', async () => {
  const provider = createAnswerComposeProvider({ compose: async () => { throw new Error('secret in model failure'); } });
  expect(await provider(input)).toEqual({ status: 'model-unavailable' });
});

test('source binding is fixed before asynchronous compose', async () => {
  const mutable = { question: input.question, sources: [{ ...input.sources[0]! }] };
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let received: AnswerComposeInput | undefined;
  const provider = createAnswerComposeProvider({ compose: async checked => {
    received = checked;
    await waiting;
    return { answer: 'Revision A [1].', citations: [{ sourceId: 's1', url: checked.sources[0]!.url }] };
  } });
  const result = provider(mutable);
  mutable.sources[0]!.url = 'https://evil.example/changed';
  expect(received?.sources[0]?.url).toBe(citation.url);
  release();
  expect(await result).toEqual({ status: 'ok', answer: 'Revision A [1].', citations: [citation], sourceIds: ['s1'] });
});
