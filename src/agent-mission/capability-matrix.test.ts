import { describe, expect, it } from 'bun:test';
import { buildCapabilityMatrix, pickBackend } from './capability-matrix.js';
import type { CapabilityEntry } from './capability-types.js';

// Entries reflect parsed `codex mcp list`, `claude mcp list`, and Grok's unlisted managed connectors.
const codex: readonly CapabilityEntry[] = Object.freeze([
  Object.freeze({ backend: 'codex', service: 'github', state: 'ready', detail: 'github https://mcp.github.com enabled' }),
  Object.freeze({ backend: 'codex', service: 'linear', state: 'unavailable', detail: 'linear disabled' }),
]);
const claude: readonly CapabilityEntry[] = Object.freeze([
  Object.freeze({ backend: 'claude', service: 'GitHub', state: 'ready', detail: 'github: Connected' }),
  Object.freeze({ backend: 'claude', service: 'Linear', state: 'ready', detail: 'linear: Connected' }),
]);
const grok: readonly CapabilityEntry[] = Object.freeze([
  Object.freeze({ backend: 'grok', service: 'github', state: 'unknown', detail: 'managed connector cannot be listed' }),
]);

const readers = () => {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      codex: () => { calls.push('codex'); return codex; },
      claude: () => { calls.push('claude'); return claude; },
      grok: () => { calls.push('grok'); return grok; },
    },
  };
};

describe('buildCapabilityMatrix', () => {
  it('combines all three read-only observations without altering state, detail, or source arrays', () => {
    const { deps, calls } = readers();
    const matrix = buildCapabilityMatrix(deps);
    expect(calls).toEqual(['codex', 'claude', 'grok']);
    expect(matrix).toEqual([...codex, ...claude, ...grok]);
    expect(matrix).not.toBe(codex);
    expect(codex).toHaveLength(2);
    expect(claude).toHaveLength(2);
    expect(grok).toHaveLength(1);
    expect(matrix[4]).toBe(grok[0]);
  });

  it('keeps unknown when other readers report no matching service', () => {
    const matrix = buildCapabilityMatrix({
      codex: () => [], claude: () => [], grok: () => grok,
    });
    expect(matrix).toEqual([...grok]);
    expect(pickBackend(matrix, 'github')).toBeNull();
  });
});

describe('pickBackend', () => {
  it('uses fixed codex → claude → grok priority rather than observation order', () => {
    const matrix = buildCapabilityMatrix(readers().deps);
    expect(pickBackend([...matrix].reverse(), '  GITHUB  ')).toBe('codex');
    expect(pickBackend(matrix, 'LINEAR')).toBe('claude');
    expect(pickBackend([...grok, { backend: 'grok', service: 'notion', state: 'ready' }], 'notion')).toBe('grok');
  });

  it('does not select unknown, unavailable, or a different service', () => {
    const matrix: CapabilityEntry[] = [
      { backend: 'codex', service: ' GitHub  Actions ', state: 'unknown' },
      { backend: 'claude', service: 'github_actions', state: 'unavailable' },
      { backend: 'grok', service: 'github', state: 'ready' },
    ];
    expect(pickBackend(matrix, 'GITHUB-actions')).toBeNull();
    expect(pickBackend(matrix, 'github')).toBe('grok');
    expect(pickBackend(matrix, '  ')).toBeNull();
  });

  it('is read-only and leaves original entries unchanged while choosing', () => {
    const { deps } = readers();
    const matrix = Object.freeze(buildCapabilityMatrix(deps));
    expect(pickBackend(matrix, 'linear')).toBe('claude');
    expect(matrix).toEqual([...codex, ...claude, ...grok]);
  });
});
