import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import type { NativeToolCatalogEntry, ProbeSpec } from '../src/native-tool-catalog.js';
import { debug } from '../src/debug/log.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';
import { evaluateGate, resetGateCache } from '../src/tool-hints/gate.js';
import { resetUserConfig } from '../src/user-config.js';
import { collectSignals, signalsSummary } from '../src/tool-hints/signals.js';
import { resetProbes, setProbeResultForTesting } from '../src/tool-hints/probe.js';
import type { Hint, HintScope } from '../src/tool-hints/types.js';

// ─── Fixtures ────────────────────────────────────────────────────

const mini = (overrides: Partial<NativeToolCatalogEntry> = {}): NativeToolCatalogEntry => ({
  id: 'example',
  kind: 'other',
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

function hint(overrides: Partial<Hint> & { tool: string; kind: Hint['kind']; scope: HintScope }): Hint {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2, 10),
    kind: overrides.kind,
    tool: overrides.tool,
    scope: overrides.scope,
    createdAt: overrides.createdAt ?? Date.now(),
    reason: overrides.reason,
    expiresAt: overrides.expiresAt,
    usesLeft: overrides.usesLeft,
    payload: overrides.payload,
    sourceSignal: overrides.sourceSignal,
  };
}

const bareSignals = () => collectSignals({ cwd: tmpdir() });

// ⛔⭐ **전역 debug 상태는 «캡처하고 되돌린다»**(2026-08-14 실측).
//   종전엔 `afterEach` 가 `debug.disable()` 로 «끄기만» 하고 원래 값을 복원하지 않았다.
//   ⇒ 이 파일 뒤에 도는 «다른 파일»이 debug 가 꺼진 채로 시작해, sink 계수를 세는 테스트가
//   조용히 깨졌다. 📏 재현: `bun test src/self-implement/orchestrator.test.ts test/tool-hints-gate.test.ts`
//   → orchestrator 쪽 3 fail. 각각 «단독»으로는 둘 다 통과한다.
//   ⚠️ 그래서 이 형태는 «파일 단위 게이트»가 원리상 못 잡는다 — 조합에서만 난다.
let priorMirrorEnabled = false;
let priorFileEnabled = false;

beforeEach(() => {
  resetGateCache();
  resetProbes();
  priorMirrorEnabled = debug.isMirrorEnabled();
  priorFileEnabled = debug.isFileEnabled();
  debug.setFileEnabled(false);
  debug.enable();
  debug.clear();
});

afterEach(() => {
  debug.clear();
  debug.setMirror(priorMirrorEnabled);
  debug.setFileEnabled(priorFileEnabled);
});

function gateEvents(): Array<{ data: Record<string, any> }> {
  return debug.events(100)
    .filter(({ category, event }) => category === 'capability.resolve' && event === 'tool-gate-evaluated')
    .map(({ data }) => ({ data: data as Record<string, any> }));
}

// ─── Signal collection ──────────────────────────────────────────

describe('signals — filesystem fingerprint', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = joinPath(tmpdir(), `mh-signals-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('hasPython detects pyproject.toml', () => {
    writeFileSync(joinPath(tmp, 'pyproject.toml'), '[tool.black]\n', 'utf-8');
    const s = collectSignals({ cwd: tmp });
    expect(s.hasPython).toBe(true);
  });

  test('hasPython false for empty dir', () => {
    const s = collectSignals({ cwd: tmp });
    expect(s.hasPython).toBe(false);
  });

  test('hasNodeProject detects package.json', () => {
    writeFileSync(joinPath(tmp, 'package.json'), '{}', 'utf-8');
    const s = collectSignals({ cwd: tmp });
    expect(s.hasNodeProject).toBe(true);
  });

  test('hasGitRemote requires a remote section in .git/config', () => {
    mkdirSync(joinPath(tmp, '.git'), { recursive: true });
    writeFileSync(joinPath(tmp, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf-8');
    expect(collectSignals({ cwd: tmp }).hasGitRemote).toBe(false);
    writeFileSync(joinPath(tmp, '.git', 'config'), '[remote "origin"]\n\turl = x\n', 'utf-8');
    expect(collectSignals({ cwd: tmp }).hasGitRemote).toBe(true);
  });
});

describe('signals — Firecrawl key resolution', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(joinPath(tmpdir(), 'tool-hints-firecrawl-'));
    setElanousConfigDir(configDir);
    delete process.env.FIRECRAWL_API_KEY;
    resetUserConfig();
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    resetElanousConfigDir();
    delete process.env.FIRECRAWL_API_KEY;
    resetUserConfig();
  });

  test('config-only key enables Firecrawl and appears in the summary', () => {
    writeFileSync(
      joinPath(configDir, 'config.json'),
      JSON.stringify({ registry: { discovery: { firecrawl: { apiKey: 'config-only-key' } } } }),
      'utf-8',
    );
    resetUserConfig();

    const signals = collectSignals({ cwd: tmpdir() });
    expect(signals.paidCliFirecrawl).toBe(true);
    expect(signalsSummary(signals)).toContain('firecrawl-key');
  });

  test('env-only key enables Firecrawl', () => {
    process.env.FIRECRAWL_API_KEY = 'env-only-key';

    expect(collectSignals({ cwd: tmpdir() }).paidCliFirecrawl).toBe(true);
  });

  test('neither config nor env key leaves Firecrawl disabled', () => {
    expect(collectSignals({ cwd: tmpdir() }).paidCliFirecrawl).toBe(false);
  });
});

describe('signals — intent matching', () => {
  test('recognizes English research intent', () => {
    expect(collectSignals({ recentUserText: 'please research the latest on ...' }).intentResearch).toBe(true);
    expect(collectSignals({ recentUserText: 'fix this typo' }).intentResearch).toBe(false);
  });

  test('recognizes Korean research intent', () => {
    expect(collectSignals({ recentUserText: '최신 기사 찾아줘' }).intentResearch).toBe(true);
  });

  test('recognizes an explicitly requested Linear issue action as ops-fleet intent', () => {
    const signals = collectSignals({ recentUserText: '먼저 Linear 이슈를 생성하고, 그다음 시장을 여러 소스로 리서치해줘' });
    expect(signals.intentOpsFleet).toBe(true);
    expect(signals.intentLinearIssue).toBe(true);
  });

  test('recognizes diagram intent (en + ko)', () => {
    expect(collectSignals({ recentUserText: 'draw a sequence diagram' }).intentDiagram).toBe(true);
    expect(collectSignals({ recentUserText: '다이어그램 만들어줘' }).intentDiagram).toBe(true);
    expect(collectSignals({ recentUserText: 'nothing interesting here' }).intentDiagram).toBe(false);
  });

  test('recentNetworkError scans last tool results', () => {
    const results = [
      { tool: 'web_fetch', text: 'fetch failed: ENOTFOUND example.com' },
      { tool: 'bash', text: 'ok' },
    ];
    expect(collectSignals({ recentToolResults: results }).recentNetworkError).toBe(true);
  });

  test('recentNetworkError ignores application-level 4xx codes', () => {
    const results = [{ tool: 'web_fetch', text: 'HTTP 404 not found' }];
    expect(collectSignals({ recentToolResults: results }).recentNetworkError).toBe(false);
  });
});

describe('signals — fingerprint stability', () => {
  test('same input → same fingerprint', () => {
    const a = collectSignals({ recentUserText: 'research stuff', cwd: tmpdir() });
    const b = collectSignals({ recentUserText: 'research stuff', cwd: tmpdir() });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test('different intent → different fingerprint', () => {
    const a = collectSignals({ recentUserText: 'fix bug', cwd: tmpdir() });
    const b = collectSignals({ recentUserText: 'research stuff', cwd: tmpdir() });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  test('signalsSummary produces human-readable string', () => {
    const s = collectSignals({ recentUserText: 'research diagrams' });
    const summary = signalsSummary(s);
    expect(summary).toContain('intent:research');
    expect(summary).toContain('intent:diagram');
  });
});

// ─── Gate evaluator ─────────────────────────────────────────────

describe('gate — defaultEnabled baseline', () => {
  test('seeds with every defaultEnabled tool', () => {
    const catalog = [
      mini({ id: 'a' }),
      mini({ id: 'b' }),
      mini({ id: 'c', defaultEnabled: false }),
    ];
    const decision = evaluateGate(catalog, [], bareSignals());
    expect(decision.filtered.sort()).toEqual(['a', 'b']);
  });
});

describe('gate — probe filter', () => {
  test('hide removes the tool when probe fails', () => {
    const probe: ProbeSpec = { kind: 'env', env: 'TEST_GATE_MISSING', onFail: 'hide' };
    delete process.env.TEST_GATE_MISSING;
    const catalog = [mini({ id: 'paid', probe })];
    const decision = evaluateGate(catalog, [], bareSignals());
    expect(decision.filtered).not.toContain('paid');
  });

  test('env probe succeeds when var set', () => {
    process.env.TEST_GATE_OK = '1';
    const probe: ProbeSpec = { kind: 'env', env: 'TEST_GATE_OK' };
    const catalog = [mini({ id: 'paid', probe })];
    const decision = evaluateGate(catalog, [], bareSignals());
    expect(decision.filtered).toContain('paid');
    delete process.env.TEST_GATE_OK;
  });

  test('warn mode keeps the tool enabled', () => {
    const probe: ProbeSpec = { kind: 'env', env: 'TEST_GATE_WARN', onFail: 'warn' };
    delete process.env.TEST_GATE_WARN;
    const catalog = [mini({ id: 'warned', probe })];
    const decision = evaluateGate(catalog, [], bareSignals());
    expect(decision.filtered).toContain('warned');
  });

  test('async probe result injected via test seam is respected', () => {
    const customFn = async () => false;
    const probe: ProbeSpec = { kind: 'custom', custom: customFn };
    setProbeResultForTesting(probe, { ok: false });
    const catalog = [mini({ id: 'async', probe })];
    const decision = evaluateGate(catalog, [], bareSignals());
    expect(decision.filtered).not.toContain('async');
  });
});

describe('gate — minTier filter', () => {
  test('T1-only tool hidden on T2 model', () => {
    const catalog = [mini({ id: 'expensive', minTier: 'T1' })];
    const decision = evaluateGate(catalog, [], { ...bareSignals(), modelTier: 'T2' });
    expect(decision.filtered).not.toContain('expensive');
  });

  test('T1-only tool visible on T1 model', () => {
    const catalog = [mini({ id: 'expensive', minTier: 'T1' })];
    const decision = evaluateGate(catalog, [], { ...bareSignals(), modelTier: 'T1' });
    expect(decision.filtered).toContain('expensive');
  });

  test('T3 model sees only T3-compatible tools', () => {
    const catalog = [
      mini({ id: 'any' }),
      mini({ id: 'mid', minTier: 'T2' }),
      mini({ id: 'top', minTier: 'T1' }),
    ];
    const decision = evaluateGate(catalog, [], { ...bareSignals(), modelTier: 'T3' });
    expect(decision.filtered).toContain('any');
    expect(decision.filtered).not.toContain('mid');
    expect(decision.filtered).not.toContain('top');
  });
});

describe('gate — hint kinds', () => {
  test('enable hint adds a disabled tool', () => {
    const catalog = [mini({ id: 'off', defaultEnabled: false })];
    const hints = [hint({ kind: 'enable', tool: 'off', scope: 'turn' })];
    const decision = evaluateGate(catalog, hints, bareSignals());
    expect(decision.filtered).toContain('off');
  });

  test('disable hint removes an enabled tool', () => {
    const catalog = [mini({ id: 'on' })];
    const hints = [hint({ kind: 'disable', tool: 'on', scope: 'turn' })];
    const decision = evaluateGate(catalog, hints, bareSignals());
    expect(decision.filtered).not.toContain('on');
  });

  test('prefer hint raises boost; avoid hint lowers', () => {
    const catalog = [mini({ id: 'p' }), mini({ id: 'a' })];
    const hints = [
      hint({ kind: 'prefer', tool: 'p', scope: 'turn' }),
      hint({ kind: 'avoid', tool: 'a', scope: 'turn' }),
    ];
    const decision = evaluateGate(catalog, hints, bareSignals());
    expect(decision.boost.p).toBeGreaterThan(0);
    expect(decision.boost.a).toBeLessThan(0);
    // Higher-boost tool comes first in stable order.
    expect(decision.filtered.indexOf('p')).toBeLessThan(decision.filtered.indexOf('a'));
  });

  test('param-default stashes args keyed by tool', () => {
    const catalog = [mini({ id: 'cfg' })];
    const hints = [hint({
      kind: 'param-default', tool: 'cfg', scope: 'session',
      payload: { args: { timeout_ms: 5000 } },
    })];
    const decision = evaluateGate(catalog, hints, bareSignals());
    expect(decision.paramDefaults.cfg).toEqual({ timeout_ms: 5000 });
  });

  test('hint referring to alias resolves to canonical id', () => {
    const catalog = [mini({ id: 'canonical', aliases: ['DisplayAlias'] })];
    const hints = [hint({ kind: 'disable', tool: 'DisplayAlias', scope: 'turn' })];
    const decision = evaluateGate(catalog, hints, bareSignals());
    expect(decision.filtered).not.toContain('canonical');
  });

  test('wildcard * disable removes every tool', () => {
    const catalog = [mini({ id: 'a' }), mini({ id: 'b' })];
    const hints = [hint({ kind: 'disable', tool: '*', scope: 'turn' })];
    const decision = evaluateGate(catalog, hints, bareSignals());
    expect(decision.filtered).toEqual([]);
  });

  test('unknown tool id is a no-op, not an error', () => {
    const catalog = [mini({ id: 'a' })];
    const hints = [hint({ kind: 'disable', tool: 'typo-tool', scope: 'turn' })];
    const decision = evaluateGate(catalog, hints, bareSignals());
    expect(decision.filtered).toContain('a');
  });
});

describe('gate — signal-driven boosts', () => {
  test('intentResearch boosts web_search when present', () => {
    const catalog = [mini({ id: 'web_search' }), mini({ id: 'other' })];
    const signals = { ...bareSignals(), intentResearch: true };
    const decision = evaluateGate(catalog, [], signals);
    expect((decision.boost.web_search ?? 0) > 0).toBe(true);
  });

  test('intentDiagram boosts mermaid_render', () => {
    const catalog = [mini({ id: 'mermaid_render' })];
    const signals = { ...bareSignals(), intentDiagram: true };
    const decision = evaluateGate(catalog, [], signals);
    expect(decision.boost.mermaid_render).toBeGreaterThan(0);
  });

  test('recentNetworkError nudges api_call when enabled', () => {
    const catalog = [mini({ id: 'api_call' })];
    const signals = { ...bareSignals(), recentNetworkError: true };
    const decision = evaluateGate(catalog, [], signals);
    expect(decision.boost.api_call).toBeGreaterThan(0);
  });
});

describe('gate — model-family cap', () => {
  test('codex model caps output at top 8 tools', () => {
    const catalog = Array.from({ length: 12 }, (_, i) => mini({ id: `t${i}` }));
    const signals = { ...bareSignals(), modelFamily: 'codex' as const };
    const decision = evaluateGate(catalog, [], signals);
    expect(decision.filtered.length).toBe(8);
  });

  test('explicit Linear issue action reserves the native tool inside the codex cap', () => {
    const catalog = [
      ...Array.from({ length: 12 }, (_, i) => mini({ id: `t${i}` })),
      mini({ id: 'elanous_linear_issue' }),
    ];
    const signals = { ...bareSignals(), modelFamily: 'codex' as const, intentLinearIssue: true };
    const decision = evaluateGate(catalog, [], signals);
    expect(decision.filtered).toHaveLength(8);
    expect(decision.filtered).toContain('elanous_linear_issue');
  });

  test('claude model does not cap', () => {
    const catalog = Array.from({ length: 12 }, (_, i) => mini({ id: `t${i}` }));
    const signals = { ...bareSignals(), modelFamily: 'claude' as const };
    const decision = evaluateGate(catalog, [], signals);
    expect(decision.filtered.length).toBe(12);
  });
});

describe('gate — observability', () => {
  test('records active tool names and exclusion reasons with reducing and unexecuted stages', () => {
    const catalog = [
      mini({ id: 'kept', displayName: 'kept' }),
      mini({ id: 'tiered', displayName: 'tiered', minTier: 'T1' }),
      mini({ id: 'already-off', displayName: 'already-off', defaultEnabled: false }),
    ];
    evaluateGate(catalog, [], { ...bareSignals(), modelTier: 'T2', modelFamily: 'claude' });

    const events = gateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ catalogCount: 3, filteredCount: 1, removedCount: 2, cacheHit: false });
    expect(events[0].data.activeTools).toEqual(['kept']);
    expect(events[0].data.excludedTools).toEqual([
      { name: 'tiered', reason: 'min-tier:T1' },
      { name: 'already-off', reason: 'default-disabled' },
    ]);
    expect(events[0].data.stages.minTier).toEqual({ executed: true, before: 2, after: 1, removed: 1 });
    expect(events[0].data.stages.probe).toEqual({ executed: true, before: 2, after: 2, removed: 0 });
    expect(events[0].data.stages.intentScope).toEqual({ executed: false, before: null, after: null, removed: null });
    expect(events[0].data.stages.modelFamilyCap).toEqual({ executed: false, before: null, after: null, removed: null });
  });

  test('records active names for a no-op model-family cap without changing stage accounting', () => {
    const catalog = Array.from({ length: 8 }, (_, i) => mini({ id: `tool-${i}` }));
    evaluateGate(catalog, [], { ...bareSignals(), modelFamily: 'codex' });

    const [event] = gateEvents();
    expect(event.data.stages.modelFamilyCap).toEqual({ executed: true, before: 8, after: 8, removed: 0 });
    expect(event.data).not.toHaveProperty('tools');
    expect(event.data.activeTools).toHaveLength(8);
    expect(event.data.excludedTools).toEqual([]);
  });

  test('records exactly one summary for a cache hit without re-running stages', () => {
    const catalog = [mini({ id: 'a' }), mini({ id: 'b' })];
    const signals = bareSignals();
    evaluateGate(catalog, [], signals);
    evaluateGate(catalog, [], signals);

    const events = gateEvents();
    expect(events).toHaveLength(2);
    expect(events[1].data).toMatchObject({ cacheHit: true, catalogCount: 2, filteredCount: 2 });
    expect(events[1].data.stages.defaultEnabled).toEqual({ executed: false, before: null, after: null, removed: null });
  });
});

describe('gate — caching', () => {
  test('repeated call with same inputs returns same object reference', () => {
    const catalog = [mini({ id: 'a' })];
    const signals = bareSignals();
    const d1 = evaluateGate(catalog, [], signals);
    const d2 = evaluateGate(catalog, [], signals);
    expect(d1).toBe(d2);
  });

  test('resetGateCache forces recomputation', () => {
    const catalog = [mini({ id: 'a' })];
    const signals = bareSignals();
    const d1 = evaluateGate(catalog, [], signals);
    resetGateCache();
    const d2 = evaluateGate(catalog, [], signals);
    expect(d1).not.toBe(d2);
    expect(d1.filtered).toEqual(d2.filtered);  // same content though
  });
});

describe('gate — hintReasons surface', () => {
  test('reasons from all applied hints appear in decision.hintReasons', () => {
    const catalog = [mini({ id: 'a' })];
    const hints = [
      hint({ kind: 'prefer', tool: 'a', scope: 'turn', reason: 'user asked' }),
      hint({ kind: 'enable', tool: 'a', scope: 'session', reason: 'seasonally useful' }),
    ];
    const decision = evaluateGate(catalog, hints, bareSignals());
    expect(decision.hintReasons).toEqual(['user asked', 'seasonally useful']);
  });
});
