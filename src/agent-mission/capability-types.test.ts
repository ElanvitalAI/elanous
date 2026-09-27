import { describe, expect, it } from 'bun:test';
import { normalizeServiceName, type CapabilityEntry, type CapabilityState } from './capability-types.js';

type AssignEntry<T extends CapabilityEntry> = T;
// @ts-expect-error An unsupported state cannot be assigned to a capability entry.
type InvalidStateAssignment = AssignEntry<{ backend: 'codex'; service: 'github'; state: 'pending' }>;
// @ts-expect-error An unsupported backend cannot be assigned to a capability entry.
type InvalidBackendAssignment = AssignEntry<{ backend: 'other'; service: 'github'; state: 'ready' }>;

describe('capability contract', () => {
  it('uses ready only for a confirmed usable service; preserves unknown as a distinct state', () => {
    const observations: CapabilityEntry[] = [
      { backend: 'codex', service: 'github', state: 'ready' },
      { backend: 'claude', service: 'github', state: 'unavailable' },
      { backend: 'grok', service: 'github', state: 'unknown', detail: 'managed connector cannot be listed' },
    ];
    const states: CapabilityState[] = observations.map(({ state }) => state);
    expect(states).toEqual(['ready', 'unavailable', 'unknown']);
    expect(observations.filter(({ state }) => state === 'ready').map(({ backend }) => backend)).toEqual(['codex']);
  });

  it('normalizes equivalent CLI service names into one comparison key', () => {
    expect([' GitHub  Actions ', 'github_actions', 'GITHUB-actions', 'ＧｉｔＨｕｂ　Ａｃｔｉｏｎｓ']
      .map(normalizeServiceName)).toEqual(Array(4).fill('github-actions'));
    expect(normalizeServiceName('  Linear  ')).toBe('linear');
  });

  it('does not silently conflate distinct service names', () => {
    expect(normalizeServiceName('github')).not.toBe(normalizeServiceName('github-enterprise'));
  });
});
