import type { LLMToolSpec } from '../src/llm/tool-spec.js';
// ── VW-term-infra Bundle B-1 · B1-3 — mirror-hints tests ──

import { describe, expect, test } from 'bun:test';

import {
  copyChordHint,
  getChordHint,
  withChordHint,
} from '../src/tool-runtime/mirror-hints.js';


function baseSpec(): LLMToolSpec {
  return {
    name: 'Demo',
    description: 'demo tool',
    parameters: { type: 'object', properties: {} },
  };
}

describe('withChordHint / getChordHint', () => {
  test('attach + read chord hint round-trips', () => {
    const spec = withChordHint(baseSpec(), '^B p');
    expect(getChordHint(spec)).toBe('^B p');
  });

  test('empty chord returns spec unchanged · getChordHint → undefined', () => {
    const plain = withChordHint(baseSpec(), '');
    expect(getChordHint(plain)).toBeUndefined();
  });

  test('original spec untouched · shallow-copy semantics', () => {
    const orig = baseSpec();
    const hinted = withChordHint(orig, 'Alt+N');
    expect(getChordHint(orig)).toBeUndefined();
    expect(getChordHint(hinted)).toBe('Alt+N');
  });

  test('copyChordHint propagates hint between specs · absent source keeps dst clean', () => {
    const srcWith = withChordHint(baseSpec(), '^B X');
    const dstA = { ...baseSpec(), name: 'A' };
    const copiedA = copyChordHint(srcWith, dstA);
    expect(getChordHint(copiedA)).toBe('^B X');

    const srcPlain = baseSpec();
    const dstB = { ...baseSpec(), name: 'B' };
    const copiedB = copyChordHint(srcPlain, dstB);
    expect(getChordHint(copiedB)).toBeUndefined();
  });
});
