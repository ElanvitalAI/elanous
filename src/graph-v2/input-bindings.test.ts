import { expect, test } from 'bun:test';
import { bindGraphV2NodeInput, bindGraphV2StoreWriteInput } from './input-bindings.js';

test('Graph v2 capability input bindings resolve graph context, run input, and earlier node outputs', () => {
  expect(bindGraphV2NodeInput({
    memberId: '$context.memberId', suggestionId: '$input.suggestionId',
    title: '$lookup-suggestion.evidence.suggestion.ask', artifact: '$build.evidence.artifact', suggestion: { id: 'map-1' }, mapped: '$suggestion',
  }, { suggestionId: 's-1', context: { memberId: 'member-a' } }, {
    'lookup-suggestion': { evidence: { suggestion: { ask: 'Build this' } } },
    build: { evidence: { artifact: { id: 'artifact-1' } } },
  })).toEqual({ memberId: 'member-a', suggestionId: 's-1', title: 'Build this', artifact: { id: 'artifact-1' }, suggestion: { id: 'map-1' }, mapped: { id: 'map-1' } });
});

test('Graph v2 capability input binding fails closed when a declared reference is absent', () => {
  expect(() => bindGraphV2NodeInput({ memberId: '$context.memberId' }, {}, {})).toThrow('unbound graph input reference');
  expect(() => bindGraphV2NodeInput('$context', {}, {})).toThrow('unbound graph input reference');
  expect(() => bindGraphV2NodeInput('$input', undefined, {})).toThrow('unbound graph input reference');
  expect(() => bindGraphV2NodeInput('$input.optional', { optional: undefined }, {})).toThrow('unbound graph input reference');
  expect(() => bindGraphV2NodeInput('$prior', {}, { prior: undefined })).toThrow('unbound graph output reference');
  expect(() => bindGraphV2NodeInput('$prior.result', {}, { prior: { result: undefined } })).toThrow('unbound graph input reference');
  expect(() => bindGraphV2NodeInput({ title: '$missing.result.title' }, {}, {})).toThrow('unbound graph output reference');
});

test('optional graph input attachment binding preserves supplied values and omits an absent value', () => {
  const declared = { event: { cardId: '$input.suggestionId', attachments: '$input.attachments?' } };
  const attachments = [{ kind: 'pdf', url: 'https://nexus.test/design.pdf' }];
  expect(bindGraphV2NodeInput(declared, { suggestionId: 's-1', attachments }, {}))
    .toEqual({ event: { cardId: 's-1', attachments } });
  expect(bindGraphV2NodeInput(declared, { suggestionId: 's-1' }, {}))
    .toEqual({ event: { cardId: 's-1' } });
  const absent = bindGraphV2NodeInput({ missing: '$input.absent.nested?', explicit: undefined }, {}, {}) as Record<string, unknown>;
  expect(Object.hasOwn(absent, 'missing')).toBe(false);
  expect(Object.hasOwn(absent, 'explicit')).toBe(true);
  expect(absent.explicit).toBeUndefined();
  expect(() => bindGraphV2NodeInput('$input.__proto__?', {}, {}))
    .toThrow('unbound graph input reference');
  expect(() => bindGraphV2NodeInput('$input.missing.__proto__?', {}, {}))
    .toThrow('unbound graph input reference');
});

test('Graph v2 store writes seal the resolved owner payload and reject another owner', () => {
  const declared = { type: 'store', op: 'upsert', collection: 'suggestions', owner: '$context.memberId',
    key: '$suggestion.id', value: '$suggestion', ownerScoped: true,
    suggestion: { id: 'suggestion-1' }, mapIndex: 0 };
  const graphInput = { context: { memberId: 'member-a' } };
  const sealed = bindGraphV2StoreWriteInput(declared, graphInput, {});
  expect(sealed).toMatchObject({ owner: 'member-a', key: 'suggestion-1', value: { id: 'suggestion-1' },
    __validatedWrite: { owner: 'member-a', key: 'suggestion-1', value: { id: 'suggestion-1' } } });
  expect(sealed).not.toHaveProperty('suggestion');
  expect(() => bindGraphV2StoreWriteInput({ ...declared, owner: 'member-b' }, graphInput, {}))
    .toThrow('invalid owner-scoped graph store write');
  expect(bindGraphV2StoreWriteInput({ ...declared, __validatedWrite: { op: 'upsert', collection: 'suggestions',
    owner: 'member-a', key: 'suggestion-1', value: { id: 'another-suggestion' }, ownerScoped: true } }, graphInput, {}))
    .toMatchObject({ value: { id: 'suggestion-1' }, __validatedWrite: { value: { id: 'another-suggestion' } } });
});
