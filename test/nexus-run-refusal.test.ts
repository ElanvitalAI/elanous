import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideNexusRunRefusal, evaluateNexusRunRefusal, renderNexusRunRefusal } from '../src/instance/nexus-run-refusal.js';
import { readLeaderRefusal, type LeaderRefusalRecord } from '../src/instance/leader.js';

const homeRoot = '/tmp/operating/.elanous';
const selfTree = '/tmp/source';
const base = { selfTree, root: homeRoot, homeRoot, depth: 0, installedCopy: false };

describe('operating Nexus boundary without leader trees', () => {
  test('source tree on operating root is refused independent of legacy leader hints', () => {
    for (const leaderTree of [selfTree, '/other', null]) {
      expect(decideNexusRunRefusal({ ...base, leaderTree })).toMatchObject({ refuse: true, normalOperation: false });
    }
    const message = renderNexusRunRefusal(base, decideNexusRunRefusal(base));
    expect(message).toContain('전역 `elanous` 로');
    expect(message).not.toContain('leader claim');
  });

  test('installed build and explicitly selected operating root start; nested operating start is rejected', () => {
    for (const selected of [{ installedCopy: true }, { explicitRoot: homeRoot }]) {
      expect(decideNexusRunRefusal({ ...base, ...selected })).toMatchObject({ refuse: false, normalOperation: true });
      let cleared = 0;
      expect(evaluateNexusRunRefusal({ ...base, ...selected, log: () => {}, clear: () => { cleared++; } })).toBeNull();
      expect(cleared).toBe(1);
    }
    expect(decideNexusRunRefusal({ ...base, installedCopy: true, depth: 1 }).refuse).toBe(true);
  });

  test('isolated root starts at any depth and never clears operational refusal diagnostics', () => {
    const events: string[] = [];
    const isolated = { ...base, root: '/tmp/source/.elanous-test', depth: 3 };
    expect(decideNexusRunRefusal(isolated)).toMatchObject({ refuse: false, normalOperation: false });
    expect(evaluateNexusRunRefusal({ ...isolated, clear: () => events.push('clear'), log: (e) => events.push(e) })).toBeNull();
    expect(events).toEqual(['nexus-run-allowed-isolated']);
  });

  test('refusal is logged and recorded through injection; injected write failure is fail-soft', () => {
    const events: string[] = [];
    let record: LeaderRefusalRecord | null = null;
    const message = evaluateNexusRunRefusal({ ...base, now: () => 'T', log: (e) => events.push(e), write: (r) => { record = r; } });
    expect(message).toContain('전역 `elanous` 로');
    expect(events).toEqual(['nexus-run-refused']);
    expect(record).toMatchObject({ selfTree, root: homeRoot, leaderTree: '', depth: 0 });
    const failed = evaluateNexusRunRefusal({ ...base, log: (e) => events.push(e), write: () => { throw new Error('disk failure'); } });
    expect(failed).toBeNull();
    expect(events).toContain('nexus-run-gate-error');
  });

  test('refusal reader validates complete records from an injected path, never operating HOME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-refusal-'));
    try {
      const path = join(dir, 'refusal.json');
      const good = { refusedAt: 'T', selfTree, leaderTree: '', root: homeRoot, depth: 0, why: 'refused' };
      writeFileSync(path, JSON.stringify(good));
      expect(readLeaderRefusal(path)).toEqual(good);
      writeFileSync(path, JSON.stringify({ ...good, depth: -1 }));
      expect(readLeaderRefusal(path)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('actual nexus run CLI retains gate-before-test-branch and exit wiring', () => {
    const src = readFileSync('src/index.ts', 'utf-8');
    const anchor = src.indexOf("nexusCmd\n  .command('run'");
    expect(anchor).toBeGreaterThan(-1);
    const next = src.indexOf('\nnexusCmd', anchor + 20);
    const action = src.slice(anchor, next > 0 ? next : anchor + 40000).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(action).toMatch(/const\s+(\w+)\s*=\s*evaluateNexusRunRefusal\(\s*\)\s*;\s*if\s*\(\s*\1\s*\)\s*\{[^}]*process\.exit\(1\)/);
    expect(action.indexOf('evaluateNexusRunRefusal')).toBeLessThan(action.indexOf('if (opts.test)'));
  });
});
