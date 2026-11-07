import { describe, expect, it } from 'bun:test';
import { caseFor, sourcePathFor } from './test-census';

describe('test census source attribution', () => {
  it('rejects a classname that only matches the final nested suite segment', () => {
    const source = {
      title: 'case name',
      templateFragments: ['case name'],
      suite: ['Outer', 'Inner'],
      body: undefined,
      line: 1,
      assertions: [],
    };
    const row = {
      file: 'test/example.test.ts',
      classname: 'Inner',
      name: 'case name',
      suitePath: ['Outer', 'Inner'],
      line: 1,
      seconds: 0,
      attempts: [],
      result: 'passed',
    } as Parameters<typeof caseFor>[0];

    expect(caseFor(row, [source])).toBeUndefined();
  });

  it('keeps absolute JUnit paths inside the selected source root', () => {
    expect(sourcePathFor('/snapshot/repo/test/example.test.ts', '/snapshot/repo')).toBe('/snapshot/repo/test/example.test.ts');
    expect(sourcePathFor('/other/repo/test/example.test.ts', '/snapshot/repo')).toBeUndefined();
  });
});
