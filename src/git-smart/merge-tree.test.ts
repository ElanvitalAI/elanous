import { describe, expect, test } from 'bun:test';
import { mergeTree } from './merge-tree.js';

describe('mergeTree', () => {
  test('passes configuration and revisions to git without altering its result', () => {
    let received: string[] = [];
    const result = { status: 1, stdout: 'conflict', stderr: '' };
    const actual = mergeTree((args) => { received = args; return result; }, 'base', 'head', ['-c', 'merge.example.driver=true']);
    expect(received).toEqual(['-c', 'merge.example.driver=true', 'merge-tree', '--write-tree', '--name-only', '-z', 'base', 'head']);
    expect(actual).toBe(result);
  });

  test('supports tree-only callers without changing their output format', () => {
    let received: string[] = [];
    mergeTree(args => { received = args; }, 'base', 'head', [], []);
    expect(received).toEqual(['merge-tree', '--write-tree', 'base', 'head']);
  });
});
