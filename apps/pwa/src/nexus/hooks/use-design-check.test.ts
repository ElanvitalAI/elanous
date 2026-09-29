// ── B4 — the panel's projection is where the third state is born ──
//
// The daemon sends three lists; the panel shows three states. The interesting
// one is `available` — a rulebook elanous ships that the DESIGN.md has NOT
// declared. The CLI cannot show it (it prints only declared + unavailable),
// so this projection is the surface's own contribution, not a re-render.
//
// These tests are pure: no react-query, no DOM. The panel is then a paint of
// whatever this returns, which keeps the interesting logic testable.

import { describe, expect, test } from 'bun:test';
import { projectRulebookRows, describeBlocked, groupDirections, describePickFailure, describeCreateFailure, previewSystemSet } from './use-design-check';
import { NexusApiError, type DesignDirectionView } from '../client';

describe('projectRulebookRows', () => {
  test('splits shipped-but-undeclared out as its own state', () => {
    const rows = projectRulebookRows({
      declaredRulebooks: ['color'],
      unavailableRulebooks: [],
      availableRulebooks: ['color', 'typography'],
    });
    expect(rows).toEqual([
      { name: 'color', status: 'declared' },
      { name: 'typography', status: 'available' },
    ]);
  });

  test('a declared name that is also shipped reads as declared, not available', () => {
    // Both lists contain it. If `available` won, every healthy rulebook would
    // render as "not declared" — the panel would be exactly wrong.
    const rows = projectRulebookRows({
      declaredRulebooks: ['color'],
      unavailableRulebooks: [],
      availableRulebooks: ['color'],
    });
    expect(rows).toEqual([{ name: 'color', status: 'declared' }]);
  });

  test('missing rulebooks sort FIRST, ahead of alphabetical order', () => {
    // `zeta` is missing and sorts last alphabetically. Severity has to beat
    // the name, or the one row a human opened the panel for gets buried.
    const rows = projectRulebookRows({
      declaredRulebooks: ['alpha', 'zeta'],
      unavailableRulebooks: ['zeta'],
      availableRulebooks: ['alpha', 'beta'],
    });
    expect(rows.map((r) => `${r.status}:${r.name}`)).toEqual([
      'missing:zeta',
      'declared:alpha',
      'available:beta',
    ]);
  });

  test('names are de-duplicated across the three lists', () => {
    const rows = projectRulebookRows({
      declaredRulebooks: ['color', 'color'],
      unavailableRulebooks: [],
      availableRulebooks: ['color'],
    });
    expect(rows).toHaveLength(1);
  });

  test('empty everywhere yields no rows rather than throwing', () => {
    expect(projectRulebookRows({
      declaredRulebooks: [], unavailableRulebooks: [], availableRulebooks: [],
    })).toEqual([]);
  });
});

describe('describeBlocked', () => {
  test('no-repository does NOT mention a missing file', () => {
    const message = describeBlocked('no-repository', null);
    // The failure mode this guards: telling an operator whose daemon simply
    // runs outside a checkout to go look for a DESIGN.md that was never
    // supposed to exist.
    expect(message).toContain('not running inside a git checkout');
    expect(message).not.toContain('DESIGN.md:');
  });

  test('the two read failures each name their own path', () => {
    expect(describeBlocked('craft-directory', '/elanous/docs/design/craft'))
      .toContain('/elanous/docs/design/craft');
    expect(describeBlocked('design-document', '/work/project/DESIGN.md'))
      .toContain('/work/project/DESIGN.md');
  });

  test('the two read failures produce DIFFERENT sentences', () => {
    // They arrive with the same exitCode; if the copy were shared the panel
    // would hand the reader back the ambiguity the endpoint just removed.
    expect(describeBlocked('craft-directory', '/a'))
      .not.toBe(describeBlocked('design-document', '/a'));
  });

  test('an unknown reason still names itself instead of going generic', () => {
    expect(describeBlocked('some-future-reason', null)).toContain('some-future-reason');
  });
});

// RFC design loop §B — card grouping and pick-failure copy.

describe('groupDirections', () => {
  const d = (id: string, source?: DesignDirectionView['source']): DesignDirectionView => ({
    id, mood: '', isDark: false, isPastel: false, swatch: { text: '#000', accent: '#000', muted: '#000' }, source,
  });
  test('design systems first, everything else is a theme, daemon order kept', () => {
    const g = groupDirections([d('nord'), d('paper', 'design-system'), d('mine', 'document'), d('minimal', 'design-system')]);
    expect(g.systems.map((x) => x.id)).toEqual(['paper', 'minimal']);
    expect(g.themes.map((x) => x.id)).toEqual(['nord', 'mine']);
  });
});

describe('previewSystemSet', () => {
  test('collects system ids and treats a missing list as empty', () => {
    expect([...previewSystemSet([{ system: 'paper' }, { system: 'minimal' }])].sort()).toEqual(['minimal', 'paper']);
    expect(previewSystemSet(undefined).size).toBe(0);
  });
});

describe('describePickFailure', () => {
  test('names the daemon reason', () => {
    expect(describePickFailure(new NexusApiError(400, '/v1/design-direction', { ok: false, reason: 'unknown-direction' })))
      .toContain('does not know');
    expect(describePickFailure(new NexusApiError(409, '/v1/design-direction', { ok: false, reason: 'no-repository' })))
      .toContain('harness.defaultRepo');
  });
  test('401 without a reason says owner only', () => {
    expect(describePickFailure(new NexusApiError(401, '/v1/design-direction', null))).toContain('owner');
  });
});

describe('describeCreateFailure', () => {
  test('names bad-url, id-taken, extract-failed, and a busy 429', () => {
    expect(describeCreateFailure(new NexusApiError(400, '/v1/design-system', { ok: false, reason: 'bad-url' })))
      .toContain('http');
    expect(describeCreateFailure(new NexusApiError(409, '/v1/design-system', { ok: false, reason: 'id-taken' })))
      .toContain('already taken');
    expect(describeCreateFailure(new NexusApiError(502, '/v1/design-system', { ok: false, reason: 'extract-failed' })))
      .toContain('could not be measured');
    expect(describeCreateFailure(new NexusApiError(429, '/v1/design-system', { ok: false, reason: 'busy' })))
      .toContain('wait');
  });
  test('401 without a reason says owner only', () => {
    expect(describeCreateFailure(new NexusApiError(401, '/v1/design-system', null))).toContain('owner');
  });
});
