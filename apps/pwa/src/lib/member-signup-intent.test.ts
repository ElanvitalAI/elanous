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
