import { describe, expect, test } from 'bun:test';
import { decideNexusRunRefusal, evaluateNexusRunRefusal } from './nexus-run-refusal.js';

const homeRoot = '/tmp/home/.elanous';
const input = { selfTree: '/tmp/source', root: homeRoot, homeRoot, depth: 0, installedCopy: false };

describe('Nexus operating root authorization', () => {
  test('unstamped source execution is refused even if legacy leader metadata names this source', () => {
    for (const leaderTree of [input.selfTree, '/tmp/other', null]) {
      expect(decideNexusRunRefusal({ ...input, leaderTree }).refuse).toBe(true);
    }
    let recorded = '';
    const message = evaluateNexusRunRefusal({ ...input, explicitRoot: null, write: (r) => { recorded = r.why; }, log: () => {}, clear: () => {} });
    expect(recorded).toContain('명시 운영 루트 없는');
    expect(message).toContain('전역 `elanous` 로');
  });

  test('installed copy and explicitly selected operating root are admitted', () => {
    for (const selected of [{ installedCopy: true }, { explicitRoot: homeRoot }]) {
      const decision = decideNexusRunRefusal({ ...input, ...selected });
      expect(decision.refuse).toBe(false);
      expect(decision.normalOperation).toBe(true);
      let cleared = false;
      expect(evaluateNexusRunRefusal({ ...input, ...selected, clear: () => { cleared = true; }, log: () => {} })).toBeNull();
      expect(cleared).toBe(true);
    }
  });

  test('isolated root is allowed without clearing operational refusal; nested operational run remains refused', () => {
    expect(decideNexusRunRefusal({ ...input, root: '/tmp/source/.elanous-test' })).toMatchObject({ refuse: false, normalOperation: false });
    expect(decideNexusRunRefusal({ ...input, installedCopy: true, depth: 1 }).refuse).toBe(true);
  });
});
