import { describe, expect, it } from 'bun:test';
import { debug } from '../debug/log.js';
import { setUserConfigOverlay } from '../user-config.js';
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
    expect(nestedDepthCodexArgs('codex', 1)).toEqual(['-c', `${CODEX_NESTED_DEPTH_CONFIG_KEY}="1"`]);
    expect(nestedDepthCodexArgs('codex', 2)).toEqual(['-c', `${CODEX_NESTED_DEPTH_CONFIG_KEY}="2"`]);
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

  it('depth cap denies at 2 even with allow, logs the configured cap, and can be lowered', () => {
    const seen: Array<{ category: string; event: string; data: unknown }> = [];
    const original = debug.log;
    debug.log = ((category: string, event: string, data?: unknown) => { seen.push({ category, event, data }); }) as typeof debug.log;
    try {
      const capped = gateNestedElanousLaunch({ backendName: 'codex', depth: 2, nestedLaunchRequested: true, allow: true });
      expect(capped).toMatchObject({ allowed: false, reason: 'depth-cap', depth: 2 });
      expect(seen).toContainEqual({ category: 'agent-mission.nested', event: 'depth-cap', data: { depth: 2, cap: 2 } });
      const lowered = gateNestedElanousLaunch({ backendName: 'codex', depth: 1, nestedLaunchRequested: true, allow: true, maxDepth: 1 });
      expect(lowered.reason).toBe('depth-cap');
      expect(seen).toContainEqual({ category: 'agent-mission.nested', event: 'depth-cap', data: { depth: 1, cap: 1 } });
      expect(gateNestedElanousLaunch({ backendName: 'codex', depth: 1, nestedLaunchRequested: true, allow: true, maxDepth: 3 }).reason).toBe('allow-ignored');
      setUserConfigOverlay((config) => ({ ...config, harness: { ...config.harness, nestedElanousMaxDepth: 1 } }));
      expect(gateNestedElanousLaunch({ backendName: 'codex', depth: 1, nestedLaunchRequested: true, allow: true }).reason).toBe('depth-cap');
      expect(seen).toContainEqual({ category: 'agent-mission.nested', event: 'depth-cap', data: { depth: 1, cap: 1 } });
    } finally { setUserConfigOverlay(null); debug.log = original; }
  });

  it('a backend that cannot carry depth stays depth-unknown at the cap but still logs depth-cap', () => {
    const seen: Array<{ category: string; event: string; data: unknown }> = [];
    const original = debug.log;
    debug.log = ((category: string, event: string, data?: unknown) => { seen.push({ category, event, data }); }) as typeof debug.log;
    try {
      const claude = gateNestedElanousLaunch({ backendName: 'claude', depth: 2, nestedLaunchRequested: true, allow: true });
      expect(claude).toMatchObject({ allowed: false, reason: 'depth-unknown', depth: 2 });
      expect(seen).toContainEqual({ category: 'agent-mission.nested', event: 'depth-cap', data: { depth: 2, cap: 2, backend: 'claude' } });
      seen.length = 0;
      expect(gateNestedElanousLaunch({ backendName: 'claude', depth: 1, nestedLaunchRequested: true, allow: true }).reason).toBe('depth-unknown');
      expect(seen.filter((row) => row.event === 'depth-cap')).toHaveLength(0);
    } finally { debug.log = original; }
  });

  it('an ordinary mission spawn at the cap does not log depth-cap', () => {
    const seen: Array<{ category: string; event: string; data: unknown }> = [];
    const original = debug.log;
    debug.log = ((category: string, event: string, data?: unknown) => { seen.push({ category, event, data }); }) as typeof debug.log;
    try {
      gateNestedElanousLaunch({ backendName: 'codex', depth: 3, nestedLaunchRequested: false });
      gateNestedElanousLaunch({ backendName: 'claude', depth: 3, nestedLaunchRequested: false });
      expect(seen.filter((row) => row.event === 'depth-cap')).toHaveLength(0);
    } finally { debug.log = original; }
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
