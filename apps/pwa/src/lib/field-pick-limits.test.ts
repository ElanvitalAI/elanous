import { describe, expect, test } from 'bun:test';
import * as server from '../../../../src/field/field-media';
import { FIELD_MAX_FILE_BYTES, FIELD_MAX_FILES, FIELD_MAX_REQUEST_BYTES, applyFieldPickLimits } from './field-pick-limits';

const MB = 1024 * 1024;
const file = (name: string, mb: number) => ({ name, size: mb * MB }) as File;

describe('PAR-EV10b field pick limits', () => {
  test('match the daemon limits (the PWA cannot import that node module — this test keeps them equal)', () => {
    expect(FIELD_MAX_FILE_BYTES).toBe(server.FIELD_MAX_FILE_BYTES);
    expect(FIELD_MAX_REQUEST_BYTES).toBe(server.FIELD_MAX_REQUEST_BYTES);
    expect(FIELD_MAX_FILES).toBe(20);
  });
  test('within limits: everything kept, no note', () => {
    expect(applyFieldPickLimits([file('a', 1), file('b', 2)])).toEqual({ kept: [file('a', 1), file('b', 2)], note: null });
  });
  test('over 100MB, over 20 files and over 250MB total are left out with one reason line', () => {
    const big = applyFieldPickLimits([file('huge', 101), file('ok', 1)]);
    expect(big.kept.map((f) => f.name)).toEqual(['ok']);
    expect(big.note).toBe('1개는 빠집니다 — 1개는 한 개가 100MB 를 넘습니다');
    const many = applyFieldPickLimits(Array.from({ length: 22 }, (_, i) => file(`f${i}`, 1)));
    expect(many.kept).toHaveLength(20);
    expect(many.note).toBe('2개는 빠집니다 — 2개는 한 번에 20개를 넘습니다');
    const total = applyFieldPickLimits([file('a', 90), file('b', 90), file('c', 90), file('d', 10)]);
    expect(total.kept.map((f) => f.name)).toEqual(['a', 'b', 'd']);
    expect(total.note).toBe('1개는 빠집니다 — 1개는 합계 250MB 를 넘습니다');
  });
});
