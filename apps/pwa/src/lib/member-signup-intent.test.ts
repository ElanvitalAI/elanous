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
