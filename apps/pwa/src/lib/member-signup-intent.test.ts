import { expect, test } from 'bun:test';
import { memberSignupBody, memberSignupIntentFromSearch } from './member-signup-intent';

test('invite and event codes pass together to the member signup body without internal IDs', () => {
  const intent = memberSignupIntentFromSearch('?referralCode=Aa_12-Z&code=kcb1114&memberId=forged');
  expect(memberSignupBody(intent)).toEqual({
    consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, referralCode: 'Aa_12-Z', eventCode: 'KCB1114',
  });
  expect(() => memberSignupIntentFromSearch('?referralCode=a&referralCode=b')).toThrow();
  expect(() => memberSignupIntentFromSearch('?referralCode=')).toThrow();
  expect(() => memberSignupIntentFromSearch('?referralCode=%3Cscript%3E')).toThrow();
});

test('public member ID link enters signup as referrerMemberId while legacy codes remain separate', () => {
  const intent = memberSignupIntentFromSearch('?ref=ElanvitalAI&code=KCB1114');
  expect(memberSignupBody(intent)).toEqual({ consents: { privacy: 'privacy-v1', terms: 'terms-v1' },
    referrerMemberId: 'ElanvitalAI', eventCode: 'KCB1114' });
  expect(() => memberSignupIntentFromSearch('?ref=ElanvitalAI&referralCode=legacy')).toThrow();
  expect(() => memberSignupIntentFromSearch('?ref=ElanvitalAI&ref=other')).toThrow();
  expect(() => memberSignupIntentFromSearch('?ref=%2Fv1%2Fmembers')).toThrow();
  expect(() => memberSignupIntentFromSearch('?ref=Joosung80')).toThrow();
  expect(() => memberSignupIntentFromSearch('?ref=user-80')).toThrow();
  expect(memberSignupBody(memberSignupIntentFromSearch('?ref=em_ExampleID'))).toEqual({
    consents: { privacy: 'privacy-v1', terms: 'terms-v1' }, legacyPublicId: 'em_ExampleID',
  });
});

test('KCB event code aliases share the canonical signup and first-run intent', () => {
  for (const alias of ['KCB_1114', 'kcb-1114', 'K C B 1 1 1 4']) {
    const intent = memberSignupIntentFromSearch(`?code=${encodeURIComponent(alias)}`);
    expect(intent.eventCode).toBe('KCB1114');
    expect(memberSignupBody(intent).eventCode).toBe('KCB1114');
  }
  expect(memberSignupIntentFromSearch('?code=EVENT-2026').eventCode).toBe('EVENT-2026');
  expect(memberSignupIntentFromSearch('?code=KCB_1115').eventCode).toBe('KCB_1115');
  expect(memberSignupIntentFromSearch('?code=KCB-1114-X').eventCode).toBe('KCB-1114-X');
  expect(memberSignupIntentFromSearch('?referralCode=KCB_1114').referralCode).toBe('KCB_1114');
  expect(memberSignupIntentFromSearch('?code=kcb-1114&referralCode=KCB_1114')).toEqual({
    eventCode: 'KCB1114', referralCode: 'KCB_1114',
  });
});

test('invite code picks the first non-empty value across code= and eventCode= (UX #116886 · JUD #116120)', () => {
  // mixed: a usable code= wins over eventCode=; the notice line and the POST share the one intent value.
  expect(memberSignupIntentFromSearch('?code=AB12&eventCode=KCB1114')).toEqual({ eventCode: 'AB12' });
  // an empty or whitespace-only code= falls through to eventCode= — no «행사 코드가 비어 있습니다» dead end.
  expect(memberSignupIntentFromSearch('?code=&eventCode=KCB1114')).toEqual({ eventCode: 'KCB1114' });
  expect(memberSignupIntentFromSearch('?code=%20&eventCode=kcb-1114')).toEqual({ eventCode: 'KCB1114' });
  // an eventCode=-only link applies exactly like a code= link; both-empty still fails closed.
  expect(memberSignupIntentFromSearch('?eventCode=KCB1114')).toEqual({ eventCode: 'KCB1114' });
  expect(() => memberSignupIntentFromSearch('?code=&eventCode=')).toThrow('행사 코드가 비어 있습니다.');
  // JSON metacharacters never reach a POST body: the intent layer rejects them outright.
  expect(() => memberSignupIntentFromSearch('?code=z%22%2C%22evil%22%3A1')).toThrow('행사 코드가 올바르지 않습니다.');
});
