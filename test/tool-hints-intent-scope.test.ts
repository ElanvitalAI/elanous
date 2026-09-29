// Arc H — tool count discipline via intent-scope filter on the gate.
// See 내부 문서 `PLAN-harness-arc-h-tool-discipline`.
//
// Verifies:
//   • default (env off) is a no-op — exact count preserved
//   • opt-in (env=1) filters browse/viz/capture/ops unless intent matches
//   • 'coding' + 'always' are always visible under discipline
//   • Korean intent regex flips each scope
//   • signals.fingerprint invalidates the gate cache across env flips
//   • The live catalog (src/native-tool-catalog.ts) reduces to a tight
//     coding-only subset under discipline — this locks in the ~30 target

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';

import type { NativeToolCatalogEntry } from '../src/native-tool-catalog.js';
import { nativeToolCatalog } from '../src/native-tool-catalog.js';
import { evaluateGate, resetGateCache } from '../src/tool-hints/gate.js';
import { collectSignals } from '../src/tool-hints/signals.js';
import { resetProbes } from '../src/tool-hints/probe.js';
import type { ToolIntentScope } from '../src/tool-hints/types.js';

const ENV_FLAG = 'HARNESS_TOOL_DISCIPLINE_ENABLED';

const mini = (overrides: Partial<NativeToolCatalogEntry> = {}): NativeToolCatalogEntry => ({
  id: 'example',
  aliases: ['Example'],
  displayName: 'Example',
  description: '',
  promptSummary: '`Example` (test)',
  host: ['skill'],
  safety: ['read-only'],
  supportsParallel: true,
  defaultEnabled: true,
  ...overrides,
});

function scoped(id: string, scope: ToolIntentScope | undefined): NativeToolCatalogEntry {
  return mini({ id, intentScope: scope });
}

const bareSignals = () => collectSignals({ cwd: tmpdir() });

beforeEach(() => {
  resetGateCache();
  resetProbes();
  delete process.env[ENV_FLAG];
});

afterEach(() => {
  delete process.env[ENV_FLAG];
  resetGateCache();
});

// ─── default disabled — no-op ───────────────────────────────────

describe('intentScope — default disabled', () => {
  test('env unset: all tools visible regardless of scope', () => {
    const catalog = [
      scoped('a', 'coding'),
      scoped('b', 'browse'),
      scoped('c', 'capture'),
      scoped('d', 'ops-fleet'),
      scoped('g', 'ops-ui'),
      scoped('e', 'always'),
      scoped('f', undefined),
    ];
    const decision = evaluateGate(catalog, [], bareSignals());
    expect(decision.filtered.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  test('env=0 treated as unset', () => {
    process.env[ENV_FLAG] = '0';
    const catalog = [scoped('a', 'coding'), scoped('b', 'ops-fleet')];
    const decision = evaluateGate(catalog, [], bareSignals());
    expect(decision.filtered.sort()).toEqual(['a', 'b']);
  });

  test('env=true (not "1") treated as disabled — strict check', () => {
    process.env[ENV_FLAG] = 'true';
    const catalog = [scoped('a', 'coding'), scoped('b', 'ops-ui')];
    const decision = evaluateGate(catalog, [], bareSignals());
    expect(decision.filtered.sort()).toEqual(['a', 'b']);
  });
});

// ─── opt-in — coding-only default ──────────────────────────────

describe('intentScope — opt-in · coding default', () => {
  beforeEach(() => { process.env[ENV_FLAG] = '1'; });

  test('env=1 + no intent: only coding + always visible', () => {
    const catalog = [
      scoped('core', 'coding'),
      scoped('net', 'browse'),
      scoped('chart', 'viz'),
      scoped('snap', 'capture'),
      scoped('fleet', 'ops-fleet'),
      scoped('pane', 'ops-ui'),
      scoped('forever', 'always'),
      scoped('untagged', undefined),
    ];
    const decision = evaluateGate(catalog, [], collectSignals({ cwd: tmpdir() }));
    // 'always' + untagged (defaulted to 'always') + 'coding' remain.
    expect(decision.filtered.sort()).toEqual(['core', 'forever', 'untagged']);
  });

  test('browse intent adds browse scope', () => {
    const catalog = [scoped('core', 'coding'), scoped('net', 'browse'), scoped('fleet', 'ops-fleet')];
    const decision = evaluateGate(catalog, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: 'please open https://example.com in the browser',
    }));
    expect(decision.filtered.sort()).toEqual(['core', 'net']);
  });

  test('viz intent adds viz scope', () => {
    const catalog = [scoped('core', 'coding'), scoped('chart', 'viz'), scoped('net', 'browse')];
    const decision = evaluateGate(catalog, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: 'make a mermaid flowchart of the auth flow',
    }));
    expect(decision.filtered.sort()).toEqual(['chart', 'core']);
  });

  test('capture intent adds capture scope', () => {
    const catalog = [scoped('core', 'coding'), scoped('snap', 'capture'), scoped('net', 'browse')];
    const decision = evaluateGate(catalog, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: 'screenshot this pane for me',
    }));
    expect(decision.filtered.sort()).toEqual(['core', 'snap']);
  });

  test('ops-fleet intent adds ops-fleet scope only (not ops-ui)', () => {
    const catalog = [
      scoped('core', 'coding'),
      scoped('fleet', 'ops-fleet'),
      scoped('pane', 'ops-ui'),
      scoped('net', 'browse'),
    ];
    const decision = evaluateGate(catalog, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: 'send an iphone notification when done',
    }));
    expect(decision.filtered.sort()).toEqual(['core', 'fleet']);
  });

  test('ops-ui intent adds ops-ui scope only (not ops-fleet)', () => {
    const catalog = [
      scoped('core', 'coding'),
      scoped('fleet', 'ops-fleet'),
      scoped('pane', 'ops-ui'),
      scoped('net', 'browse'),
    ];
    const decision = evaluateGate(catalog, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: 'split this pane into two',
    }));
    expect(decision.filtered.sort()).toEqual(['core', 'pane']);
  });

  test('multi-intent unions all matched scopes', () => {
    const catalog = [
      scoped('core', 'coding'),
      scoped('net', 'browse'),
      scoped('snap', 'capture'),
      scoped('chart', 'viz'),
      scoped('fleet', 'ops-fleet'),
      scoped('pane', 'ops-ui'),
    ];
    const decision = evaluateGate(catalog, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: 'fetch https://example.com then screenshot it and render a mermaid diagram',
    }));
    expect(decision.filtered.sort()).toEqual(['chart', 'core', 'net', 'snap']);
  });
});

// ─── Korean intent regex ───────────────────────────────────────

describe('intentScope — Korean intent', () => {
  beforeEach(() => { process.env[ENV_FLAG] = '1'; });

  test('유튜브 → browse', () => {
    const catalog = [scoped('core', 'coding'), scoped('net', 'browse')];
    const decision = evaluateGate(catalog, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: '유튜브 자막 뽑아줘',
    }));
    expect(decision.filtered).toContain('net');
  });

  test('다이어그램 → viz', () => {
    const catalog = [scoped('core', 'coding'), scoped('chart', 'viz')];
    const decision = evaluateGate(catalog, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: '다이어그램 하나 그려줘',
    }));
    expect(decision.filtered).toContain('chart');
  });

  test('스크린샷 → capture', () => {
    const catalog = [scoped('core', 'coding'), scoped('snap', 'capture')];
    const decision = evaluateGate(catalog, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: '지금 화면 스크린샷 해줘',
    }));
    expect(decision.filtered).toContain('snap');
  });

  test('아이폰 → ops-fleet', () => {
    const catalog = [scoped('core', 'coding'), scoped('fleet', 'ops-fleet'), scoped('pane', 'ops-ui')];
    const decision = evaluateGate(catalog, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: '끝나면 아이폰으로 알려줘',
    }));
    expect(decision.filtered).toContain('fleet');
    expect(decision.filtered).not.toContain('pane');
  });

  test('대시보드 → ops-ui', () => {
    const catalog = [scoped('core', 'coding'), scoped('fleet', 'ops-fleet'), scoped('pane', 'ops-ui')];
    const decision = evaluateGate(catalog, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: '대시보드 위젯 켜줘',
    }));
    expect(decision.filtered).toContain('pane');
    expect(decision.filtered).not.toContain('fleet');
  });
});

// ─── fingerprint + cache invalidation ──────────────────────────

describe('intentScope — cache invalidation', () => {
  test('flipping env between calls yields different filtered sets', () => {
    const catalog = [scoped('core', 'coding'), scoped('fleet', 'ops-fleet')];

    delete process.env[ENV_FLAG];
    const off = evaluateGate(catalog, [], collectSignals({ cwd: tmpdir() }));
    expect(off.filtered.sort()).toEqual(['core', 'fleet']);

    process.env[ENV_FLAG] = '1';
    const on = evaluateGate(catalog, [], collectSignals({ cwd: tmpdir() }));
    expect(on.filtered.sort()).toEqual(['core']);
  });

  test('intent text change invalidates via fingerprint', () => {
    process.env[ENV_FLAG] = '1';
    const catalog = [scoped('core', 'coding'), scoped('net', 'browse')];

    const neutral = evaluateGate(catalog, [], collectSignals({ cwd: tmpdir(), recentUserText: 'fix the typo in readme' }));
    expect(neutral.filtered.sort()).toEqual(['core']);

    const browsed = evaluateGate(catalog, [], collectSignals({ cwd: tmpdir(), recentUserText: 'browser open https://example.com' }));
    expect(browsed.filtered.sort()).toEqual(['core', 'net']);
  });
});

// ─── live catalog integration ──────────────────────────────────

describe('intentScope — live catalog under discipline', () => {
  test('no-op baseline: env off does not narrow beyond probe/tier filters', () => {
    // Capture the pre-existing gate result with discipline off, then
    // confirm turning discipline on strictly reduces from that baseline.
    delete process.env[ENV_FLAG];
    const skill = nativeToolCatalog.filter(t => t.defaultEnabled && (t.host.includes('skill') || t.host.includes('all')));
    const off = evaluateGate(skill, [], collectSignals({ cwd: tmpdir() }));
    resetGateCache();
    process.env[ENV_FLAG] = '1';
    const on = evaluateGate(skill, [], collectSignals({ cwd: tmpdir() }));
    expect(on.filtered.length).toBeLessThan(off.filtered.length);
    // Every on-tool must also have been in the off-set (additive-only filter).
    const offSet = new Set(off.filtered);
    for (const id of on.filtered) expect(offSet.has(id)).toBe(true);
  });

  test('coding-default turn: filtered set is a tight subset (~30-45)', () => {
    process.env[ENV_FLAG] = '1';
    const skill = nativeToolCatalog.filter(t => t.defaultEnabled && (t.host.includes('skill') || t.host.includes('all')));
    const decision = evaluateGate(skill, [], collectSignals({ cwd: tmpdir() }));
    // Target: coding-scope tools only. Give a band so future tool adds don't
    // trigger churn, but fail loudly if we regress past ~50.
    expect(decision.filtered.length).toBeGreaterThan(20);
    expect(decision.filtered.length).toBeLessThan(50);
    // Every retained tool must be scoped 'coding' or 'always' (or untagged).
    const retained = new Set(decision.filtered);
    for (const tool of skill) {
      if (!retained.has(tool.id)) continue;
      const scope = tool.intentScope ?? 'always';
      expect(['coding', 'always']).toContain(scope);
    }
  });

  test('coding-default turn: common essentials present', () => {
    process.env[ENV_FLAG] = '1';
    const skill = nativeToolCatalog.filter(t => t.defaultEnabled && (t.host.includes('skill') || t.host.includes('all')));
    const decision = evaluateGate(skill, [], collectSignals({ cwd: tmpdir() }));
    const essentials = ['bash', 'read', 'edit', 'write', 'grep', 'glob', 'list_dir', 'ast_grep', 'web_fetch', 'web_search', 'agent'];
    for (const id of essentials) expect(decision.filtered).toContain(id);
  });

  test('browse intent restores browser_* and omni_search', () => {
    process.env[ENV_FLAG] = '1';
    const skill = nativeToolCatalog.filter(t => t.defaultEnabled && (t.host.includes('skill') || t.host.includes('all')));
    const decision = evaluateGate(skill, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: 'browser open https://news.ycombinator.com',
    }));
    expect(decision.filtered).toContain('browser_open');
    expect(decision.filtered).toContain('browser_navigate');
    expect(decision.filtered).toContain('omni_search');
  });

  test('ops-fleet intent restores iphone_* and acp_session_*', () => {
    process.env[ENV_FLAG] = '1';
    const skill = nativeToolCatalog.filter(t => t.defaultEnabled && (t.host.includes('skill') || t.host.includes('all')));
    const decision = evaluateGate(skill, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: '끝나면 아이폰으로 알려줘',
    }));
    expect(decision.filtered).toContain('iphone_notify');
    expect(decision.filtered).toContain('elanous_hold');
    // Fleet intent alone must not pull dashboard-surface tools.
    expect(decision.filtered).not.toContain('dashboard_widget_toggle');
  });

  // #21723: the live catalog no longer registers window_create; PTY control remains an ops-ui tool.
  test('ops-ui intent restores dashboard and PTY controls but not iphone_*', () => {
    process.env[ENV_FLAG] = '1';
    const skill = nativeToolCatalog.filter(t => t.defaultEnabled && (t.host.includes('skill') || t.host.includes('all')));
    const decision = evaluateGate(skill, [], collectSignals({
      cwd: tmpdir(),
      recentUserText: '창 하나 더 만들어서 대시보드 위젯 켜줘',
    }));
    expect(decision.filtered).toContain('pty_control');
    expect(decision.filtered).toContain('dashboard_widget_toggle');
    expect(decision.filtered).not.toContain('iphone_notify');
    expect(decision.filtered).not.toContain('elanous_hold');
  });

  test('every tool in the catalog carries an intentScope tag', () => {
    const missing = nativeToolCatalog.filter(t => t.intentScope === undefined);
    expect(missing.map(t => t.id)).toEqual([]);
  });
});
