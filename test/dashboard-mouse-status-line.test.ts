import { describe, expect, test } from 'bun:test';
import { createMouseStatusLine } from '../src/dashboard/input/mouse-status-line.js';
import type { ActiveProviderInfo } from '../src/provider-summary.js';

const PROVIDER: ActiveProviderInfo = { provider: 'anthropic', model: 'Opus 4.7', auth: 'oauth', authDetail: 'test' };
function makeStatusLine() {
  return createMouseStatusLine({ termSize: () => ({ rows: 24, cols: 120 }) });
}

describe('mouse status-line leaf', () => {
  test('emits the same join-with-space line and reports both pill bounds', () => {
    const status = makeStatusLine();
    const line = status.build({
      swd: '/Users/test/project',
      providerInfo: PROVIDER,
      gitState: 'main',
    });
    expect(line).toContain('project');       // workingDir pill visible
    expect(line).toContain('Opus 4.7');      // model pill visible
    const pills = status.pills();
    expect(pills.map(p => p.name)).toEqual(['workingDir', 'model']);
    // Model pill is strictly to the right of workingDir pill.
    expect(pills[1]!.startCol >= pills[0]!.endCol + 1).toBe(true);
  });

  test('handles full GitSegmentState (dirty + ahead)', () => {
    const status = makeStatusLine();
    const line = status.build({
      swd: '/Users/test',
      providerInfo: PROVIDER,
      gitState: { branch: 'main', dirtyTotal: 3, ahead: 2, behind: 0 },
    });
    expect(line).toContain('main');
  });

  test('places running agents immediately after the model without adding a pill', () => {
    const status = makeStatusLine();
    const line = status.build({
      swd: '/tmp',
      providerInfo: PROVIDER,
      gitState: 'main',
      runningAgents: 2,
    });
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain.indexOf('Opus 4.7')).toBeLessThan(plain.indexOf('◇ 2 agents'));
    expect(status.pills().map((pill) => pill.name)).toEqual(['workingDir', 'model']);
  });

  test('omitted and zero running-agent counts produce the same hidden status line', () => {
    const status = makeStatusLine();
    const base = { swd: '/tmp', providerInfo: PROVIDER, gitState: 'main' };
    const omitted = status.build(base);
    const zero = status.build({ ...base, runningAgents: 0 });
    expect(zero).toBe(omitted);
    expect(zero).not.toContain('agent');
  });

  test('omits the session-time segment when elapsedSec is absent', () => {
    const status = makeStatusLine();
    const line = status.build({
      swd: '/tmp',
      providerInfo: PROVIDER,
      contextUsedTokens: 1000,
    });
    expect(line).not.toContain('⏱');
  });

  test('adds shellCount segment after elapsedSec', () => {
    const status = makeStatusLine();
    const line = status.build({
      swd: '/tmp',
      providerInfo: PROVIDER,
      elapsedSec: 12,
      shellCount: 3,
    });
    expect(line).toContain('3 shell');
    // Pills should still exist.
    expect(status.pills()).toHaveLength(2);
  });
});

