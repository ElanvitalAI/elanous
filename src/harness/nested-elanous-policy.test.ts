import { describe, expect, it } from 'bun:test';
import { debug } from '../debug/log.js';
import {
  CODEX_NESTED_DEPTH_CONFIG_KEY,
  configAllowsNestedElanous,
  decideNestedElanousLaunch,
  gateNestedElanousLaunch,
  nestedDepthCodexArgs,
  readNestedElanousDepth,
} from './nested-elanous-policy.js';
describe('nested elanous policy', () => {
  it('codex argv carries the child depth marker', () => {
    expect(nestedDepthCodexArgs('codex', 1)).toEqual(['-c', `${CODEX_NESTED_DEPTH_CONFIG_KEY}=1`]);
    expect(nestedDepthCodexArgs('codex', 2)).toEqual(['-c', `${CODEX_NESTED_DEPTH_CONFIG_KEY}=2`]);
  });

  it('a requested nested launch on a backend that cannot carry the marker is refused', () => {
    for (const backendName of ['claude', 'gemini', 'grok', 'aside']) {
      const decision = gateNestedElanousLaunch({
        backendName,
        depth: 0,
        nestedLaunchRequested: true,
        allow: true,
        configAllow: true,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('depth-unknown');
      expect(nestedDepthCodexArgs(backendName, 1)).toEqual([]);
    }
  });

  it('unset depth is 0 and an ordinary spawn is not refused for a missing marker', () => {
    expect(readNestedElanousDepth({})).toBe(0);
    for (const backendName of ['claude', 'gemini', 'grok', 'aside', 'codex']) {
      const decision = gateNestedElanousLaunch({ backendName, depth: readNestedElanousDepth({}), nestedLaunchRequested: false });
      expect(decision.reason).not.toBe('depth-unknown');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('depth-0');
    }
  });

  it('depth 0 allow permits the launch', () => {
    const decision = gateNestedElanousLaunch({ backendName: 'codex', depth: 0, nestedLaunchRequested: true, allow: true });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('depth-0-allow');
  });

  it('depth 0 without allow stays refused', () => {
    const decision = gateNestedElanousLaunch({ backendName: 'codex', depth: 0, nestedLaunchRequested: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('depth-0');
  });

  it('depth >= 1 allow is ignored and the launch stays refused', () => {
    const seen: Array<{ category: string; event: string; data: unknown }> = [];
    const original = debug.log;
    debug.log = ((category: string, event: string, data?: unknown) => {
      seen.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const decision = decideNestedElanousLaunch({ depth: 1, allow: true });
      expect(decision.allowed).toBe(false);
      expect(decision.allowIgnored).toBe(true);
      expect(decision.reason).toBe('allow-ignored');
      expect(seen).toContainEqual({ category: 'agent-mission.nested', event: 'allow-ignored', data: { depth: 1 } });
      const gated = gateNestedElanousLaunch({
        backendName: 'codex',
        depth: 1,
        nestedLaunchRequested: true,
        allow: true,
        configAllow: true,
      });
      expect(gated.allowed).toBe(false);
      expect(gated.reason).toBe('allow-ignored');
    } finally {
      debug.log = original;
    }
  });

  it('config allow counts only at depth 0', () => {
    expect(configAllowsNestedElanous({ harness: { nestedElanous: 'allow' } }, 0)).toBe(true);
    expect(configAllowsNestedElanous({ harness: { nestedElanous: 'allow' } }, 1)).toBe(false);
    expect(configAllowsNestedElanous({ harness: { nestedElanous: 'refuse' } }, 0)).toBe(false);
    expect(configAllowsNestedElanous(undefined, 0)).toBe(false);
    const fromConfig = gateNestedElanousLaunch({
      backendName: 'codex',
      depth: 0,
      nestedLaunchRequested: true,
      configAllow: configAllowsNestedElanous({ harness: { nestedElanous: 'allow' } }, 0),
    });
    expect(fromConfig.allowed).toBe(true);
  });

  it('depth is read from the marker and is 0 when absent', () => {
    expect(readNestedElanousDepth({ ELANOUS_NESTED_DEPTH: '2' })).toBe(2);
    expect(readNestedElanousDepth({ ELANOUS_NESTED_DEPTH: '1' })).toBe(1);
    expect(readNestedElanousDepth({})).toBe(0);
    expect(readNestedElanousDepth({ ELANOUS_NESTED_DEPTH: 'nope' })).toBe(0);
  });
});
