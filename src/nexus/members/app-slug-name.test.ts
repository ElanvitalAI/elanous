import { expect, test } from 'bun:test';
import { APP_SLUG_MAX, APP_SLUG_MIN, RESERVED_APP_SLUGS, checkAppSlugName } from './app-slug-name.js';

test('a plain lowercase name is accepted, and case and surrounding space are normalised', () => {
  expect(checkAppSlugName('ticketing')).toEqual({ ok: true, slug: 'ticketing' });
  expect(checkAppSlugName('  Ticketing ')).toEqual({ ok: true, slug: 'ticketing' });
  expect(checkAppSlugName('my-note-app2')).toEqual({ ok: true, slug: 'my-note-app2' });
  expect(checkAppSlugName('z'.repeat(APP_SLUG_MAX))).toMatchObject({ ok: true });
  // 24 hex characters are the legacy hash space, so the longest all-`a` name is refused for that reason, not for its length.
  expect(checkAppSlugName('a'.repeat(APP_SLUG_MAX))).toEqual({ ok: false, reason: 'legacy-space' });
  expect(checkAppSlugName('a'.repeat(APP_SLUG_MIN))).toMatchObject({ ok: true });
});

test('format: length, characters, hyphen placement and double hyphens are all refused', () => {
  for (const bad of ['', 'ab', 'a'.repeat(APP_SLUG_MAX + 1), '-abc', 'abc-', 'ab--cd', 'tick_eting', 'tick eting', 'tick.eting',
    '티켓', 'tickét', 'abc/def', 'abc?x', 'a@b.c', '<script>', 'x'.repeat(200)]) {
    expect(checkAppSlugName(bad), bad).toEqual({ ok: false, reason: 'invalid-format' });
  }
  for (const notAString of [undefined, null, 42, {}, [], true]) expect(checkAppSlugName(notAString)).toEqual({ ok: false, reason: 'invalid-format' });
});

test('every reserved word is refused, however it is written', () => {
  expect(RESERVED_APP_SLUGS.size).toBeGreaterThan(APP_SLUG_MIN);
  for (const word of RESERVED_APP_SLUGS) {
    if (word.length < APP_SLUG_MIN) continue; // shorter than a name can be: refused by format already
    expect(checkAppSlugName(word), word).toEqual({ ok: false, reason: 'reserved' });
    expect(checkAppSlugName(` ${word.toUpperCase()} `), word).toEqual({ ok: false, reason: 'reserved' });
  }
});

test('a name cannot pose as a simulation or PR preview address, and the legacy hash space stays closed', () => {
  for (const posing of ['ticketing-sim', 'abc-sim', 'ticketing-pr12', 'x1y-pr7']) {
    expect(checkAppSlugName(posing), posing).toEqual({ ok: false, reason: 'reserved' });
  }
  // «-simulator» or «sim-city» are ordinary names: only the exact suffix is reserved.
  expect(checkAppSlugName('sim-city')).toMatchObject({ ok: true });
  expect(checkAppSlugName('ticketing-simple')).toMatchObject({ ok: true });
  expect(checkAppSlugName('0123456789abcdef01234567')).toEqual({ ok: false, reason: 'legacy-space' });
  expect(checkAppSlugName('0123456789ABCDEF01234567')).toEqual({ ok: false, reason: 'legacy-space' });
  // 24 characters that are NOT all hex are fine.
  expect(checkAppSlugName('0123456789abcdef0123456g')).toMatchObject({ ok: true });
});
