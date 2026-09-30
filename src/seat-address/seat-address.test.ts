import { describe, expect, test } from 'bun:test';
import { parseSeatAddress, resolveSeat } from './seat-address.js';

describe('parseSeatAddress', () => {
  test('parses a single seat at the start of a line without resolving it', () => {
    expect(parseSeatAddress('@cmo 이번 주 블로그 초안 만들어')).toEqual({
      seats: ['cmo'], body: '이번 주 블로그 초안 만들어',
    });
    expect(parseSeatAddress('@cfo 확인해')).toEqual({ seats: ['cfo'], body: '확인해' });
  });

  test('parses comma-separated seats with the first seat first', () => {
    expect(parseSeatAddress('@cmo,cto 공동 검토')).toEqual({
      seats: ['cmo', 'cto'], body: '공동 검토',
    });
  });

  test('accepts an address on a later line but not mid-line or after indentation', () => {
    expect(parseSeatAddress('배경\n@MK 작업')).toEqual({ seats: ['MK'], body: '배경\n작업' });
    expect(parseSeatAddress('메일은 user@cmo.example\n본문의 @cto 는 주소가 아님')).toBeNull();
    expect(parseSeatAddress('  @cmo 작업')).toBeNull();
    expect(parseSeatAddress('배경\r\n@cto 작업')).toEqual({ seats: ['cto'], body: '배경\r\n작업' });
  });

  test('requires a complete address token and leaves absent addresses alone', () => {
    expect(parseSeatAddress('@cmo.example 작업')).toBeNull();
    expect(parseSeatAddress('@cmo, 작업')).toBeNull();
    expect(parseSeatAddress('@cto')).toEqual({ seats: ['cto'], body: '' });
    expect(parseSeatAddress('@cto\r\n작업')).toEqual({ seats: ['cto'], body: '작업' });
    expect(parseSeatAddress('@cto 작업')).toEqual({ seats: ['cto'], body: '작업' });
    expect(parseSeatAddress('@cto\r작업')).toBeNull();
    expect(parseSeatAddress('@cto\n')).toEqual({ seats: ['cto'], body: '' });
    expect(parseSeatAddress('일반 대화')).toBeNull();
  });

  test('preserves trailing whitespace and newlines in the untouched body', () => {
    expect(parseSeatAddress('@cmo 작업  \n\n')).toEqual({ seats: ['cmo'], body: '작업  \n\n' });
    expect(parseSeatAddress('배경  \n@cto   작업 \r\n')).toEqual({ seats: ['cto'], body: '배경  \n작업 \r\n' });
    expect(parseSeatAddress('@cto\n\n작업 \n')).toEqual({ seats: ['cto'], body: '\n작업 \n' });
    expect(parseSeatAddress('@cto 작업\n@cmo 기타')).toEqual({ seats: ['cto'], body: '작업\n@cmo 기타' });
  });
});

describe('resolveSeat', () => {
  test('uses the case-insensitive registry title, id, and alias', () => {
    expect(resolveSeat('cMo')).toMatchObject({ id: 'MK', title: 'CMO', alias: 'T' });
    expect(resolveSeat('mK')).toMatchObject({ id: 'MK', title: 'CMO', alias: 'T' });
    expect(resolveSeat('t')).toMatchObject({ id: 'MK', title: 'CMO', alias: 'T' });
    expect(resolveSeat('@cTo')).toMatchObject({ id: 'TC', title: 'CTO', alias: 'O' });
    expect(resolveSeat('cxo')).toMatchObject({ id: 'UX', title: 'CXO' });
  });

  test('returns unknown instead of guessing from owned words or absent titles', () => {
    expect(resolveSeat('cfo')).toBeUndefined();
    expect(resolveSeat('마케팅')).toBeUndefined();
    expect(resolveSeat('')).toBeUndefined();
    expect(resolveSeat('E')).toBeUndefined();
  });

  test('prefers title over id over alias regardless of registry row order', () => {
    const entries = [
      { id: 'A', alias: 'target' },
      { id: 'target', alias: 'other' },
      { id: 'C', title: 'TARGET' },
    ];
    expect(resolveSeat('target', entries)).toEqual(entries[2]);
    expect(resolveSeat('target', entries.slice(0, 2))).toEqual(entries[1]);
    expect(resolveSeat('other', entries)).toEqual(entries[1]);
    expect(resolveSeat('a', entries)).toEqual(entries[0]);
  });
});
