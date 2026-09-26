import { describe, expect, it } from 'bun:test';
import { graphAuthorityFields, resolveGraphAuthority } from '../src/self-implement/graph-authority.js';
import { loadGraphTemplatesFrom, defaultGraphsDir } from '../src/self-implement/graph-templates.js';

describe('2026-09-26 graph authority observation', () => {
  const template = loadGraphTemplatesFrom(defaultGraphsDir()).templates['self-implement']!;

  it('keeps both observation fields fixed even for formerly disabling inputs', () => {
    for (const input of [{}, { flag: false }, { config: false }, { flag: false, config: true }]) {
      const fields = graphAuthorityFields(resolveGraphAuthority(input), template);
      expect(fields).toMatchObject({
        graphAuthoritative: true,
        graphAuthoritativeSource: 'default',
        activeGraphId: 'self-implement',
      });
    }
  });
});
