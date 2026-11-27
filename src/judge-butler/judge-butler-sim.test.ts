import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSim } from './sim.js';
import { judgeCell, security4Hits, simEvidenceLine, type PrFacts } from './done-when.js';
import { fileMemory } from './memory.js';

// Seeded fed sim of rail 73 · 00:44 (judge queue 50 · 10 landed cells with same-head receipts unsigned · TC HOLD freezes 16 hands ·
// OP unregistered HOLD freezes 5) — the butler's planner/executor as live, 24 ticks × 10 min.
describe('judge-butler sim — seeds 1–5 reproduce 00:44 and close it', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, async () => {
      const s = await runSim(seed);
      console.log(`[butler-sim] seed ${seed}: signed first tick ${s.signedFirstTick} · total ${s.signedTotal} in 4h = ${s.greensPerHour}/h · frozen ${s.frozenSeries.slice(0, 14).join('→')} (0 at tick ${s.frozenZeroAtTick}) · queue ${s.queueStart.count}→${s.queueEnd.count} · ready wait ${s.queueEnd.readyMedianWaitMin ?? 0}m · ✋ ${s.handsAnsweredWithinSla}/${s.handsRaised} in SLA, ${s.handsEscalated} → JUD · OP card ${s.opCards} · proposals ${s.proposals} · JUD hold escalations ${s.holdEscalations}`);
      expect(s.queueStart.count).toBe(62); // 50 of 00:44 ⊕ 12 BUTLER-SIGN-MERGED-PATCHID cells
      expect(s.queueStart.ready).toBe(29); // GREEN-DEFINITION-ONE: the 10 «no E4» cells ⊕ 9 receipt-equivalent cells are signable
      // BUTLER-SIGN-MERGED-PATCHID: merged-after-squash with an earlier-head receipt (patch-id equal) · head failure also red on
      // main · doc-only L0 receipt → signed on the first tick; a changed PR-own delta · a head-only failure → refused with the reason
      expect(s.equivalence).toEqual({ 'patch-id-reuse': { cells: 3, signed: 3 }, 'different-delta': { cells: 2, signed: 0 }, 'baseline-preexisting': { cells: 3, signed: 3 },
        'new-failure': { cells: 1, signed: 0 }, 'doc-only-l0': { cells: 3, signed: 3 } });
      expect(Object.keys(s.notSignedFirstTick).sort()).toEqual(['EQ-04', 'EQ-05', 'EQ-09']);
      expect(s.notSignedFirstTick['EQ-04']).toContain('PR-own delta differs (patch-id) — re-run pregate --light on');
      expect(s.notSignedFirstTick['EQ-09']).toContain('focused exit 0 (40 pass 2 fail · baseline new 1 (x > breaks on head))');
      expect(s.frozenSeries[0]).toBeGreaterThanOrEqual(16); // the 00:44 freeze is there at t0
      expect(s.signedFirstTick).toBeGreaterThanOrEqual(27);
      expect(s.fuE4).toBe(s.signedTotal + 1); // every green (incl. the one JUD vetoed afterwards) carries one «<cell>-E4» FU
      expect(s.violations).toEqual([]); // nothing signed without done-when
      expect(s.vetoed).not.toBeNull(); expect(s.resignsAfterVeto).toBe(0); // BUTLER-RESPECT-VETO: a revert after sign is never re-signed
      expect(s.securitySigned).toEqual([]); // security-4 never auto-signed
      expect(s.securityEscalated).toBe(4); // … each escalated to JUD once
      expect(s.frozenZeroAtTick).not.toBeNull();
      expect(s.frozenZeroAtTick!).toBeLessThanOrEqual(13); // ≤ 130 min (wildcard cap 2h + one tick)
      expect(s.frozenSeries.at(-1)).toBe(0);
      expect(s.handsAnsweredWithinSla + s.handsEscalated).toBe(s.handsRaised); // every judge ✋ answered or escalated, none left
      expect(s.queueEnd.readyMedianWaitMin ?? 0).toBeLessThanOrEqual(15);
      expect(s.greensPerHour).toBeGreaterThanOrEqual(10); // goal card KPI greens/h ≥ 10
      expect(s.opCards).toBe(1);
      expect(s.proposals).toBe(1);
    });
  }
});

describe('done-when — evidence only, never security-4', () => {
  const h = 'a'.repeat(40);
  const cell = (evidence: string) => ({ id: 'C-1', status: 'yellow', evidence });
  const e4 = 'E4 test 층 — runId r1 · event: checklist.evidence.run · 2026-11-27T00:00:00Z · host minim5 · 칸 C-1 · 명령: bun test x · rc 0 (evidence run · synthetic/test)';
  const facts = (over: Partial<PrFacts> = {}) => new Map([[40324, { pr: 40324, merged: true, landedHead: h, files: ['src/x.ts'], securityFindings: [],
    receipt: { head: h, dir: `PREGATE-GREEN/40324-${h.slice(0, 12)}-minim5`, focusedFiles: 1, focused: { pass: 5, fail: 0 } }, ...over } satisfies PrFacts]]);

  test('sign needs all three; each missing piece is named with the exact step', () => {
    expect(judgeCell(cell(`#40324\n${e4}`), facts()).kind).toBe('sign');
    expect(judgeCell(cell(`#40324\n${e4}`), facts({ receipt: null }))).toMatchObject({ kind: 'missing', missing: [expect.stringContaining('same-head receipt')] });
    expect(judgeCell(cell(`#40324\n${e4}`), facts({ receipt: { head: 'b'.repeat(40), dir: 'd', focusedFiles: 1, focused: { pass: 1, fail: 0 } } })).why).toContain('≠ landed');
    expect(judgeCell(cell(`#40324\n${e4}`), facts({ receipt: { head: h, dir: 'd', focusedFiles: 1, focused: { pass: 3, fail: 1 } } })).why).toContain('focused exit 0');
    expect(judgeCell(cell(`#40324\n${e4}`), facts({ receipt: { head: h, dir: 'd', focusedFiles: 1, focused: { exit: 0 } } })).kind).toBe('sign');
    // GREEN-DEFINITION-ONE: E4 is not required — same-head receipt + focused exit 0 is green; a missing/failed E4 only marks e4 null (→ FU)
    expect(judgeCell(cell('#40324'), facts())).toMatchObject({ kind: 'sign', e4: null, why: expect.stringContaining('E4 없음 → FU') });
    expect(judgeCell(cell(`#40324\n${e4.replace('rc 0', 'rc 1')}`), facts())).toMatchObject({ kind: 'sign', e4: null });
    expect(judgeCell(cell(`#40324\n${e4.replace('칸 C-1', '칸 C-10')}`), facts())).toMatchObject({ kind: 'sign', e4: null });
    expect(judgeCell(cell(`#40324\n${e4}`), facts())).toMatchObject({ kind: 'sign', e4: 'r1' });
    expect(judgeCell(cell(`#40325\n${e4}`), facts()).why).toBe('no merged PR among #40325');
  });

  test('BUTLER-SEC4-SCOPE: tests · fixtures · docs never make a PR security-4; a non-test code file still does', () => {
    const rail76 = ['src/tui/onboarding-pty.test.ts', 'src/repl/onboarding-pty.test.ts', 'src/onboarding/onboarding-pty.test.ts', 'src/tui/entry-compact-chrome-pty.test.ts',
      'src/tui/task-pin-rows-pty.test.ts', 'src/agent/agent-spawn-guard.test.ts', 'src/loops/x.sim.test.ts', 'src/els/server-auth.test.ts', 'src/pty-shell/fixtures/spawn-script.sh', 'docs/manual/MANUAL-pty.md'];
    expect(security4Hits(rail76)).toEqual([]);
    expect(security4Hits([...rail76, 'src/agent/agent-spawn-guard.ts'])).toEqual(['remote-exec:src/agent/agent-spawn-guard.ts']);
    expect(security4Hits(['src/els/server-auth.ts', 'src/els/server-auth.test.ts'])).toEqual(['auth:src/els/server-auth.ts']);
    expect(judgeCell(cell(`#40324\n${e4}`), facts({ files: ['src/tui/onboarding-pty.test.ts', 'src/tui/onboarding.ts'] })).kind).toBe('sign');
  });

  test('security-4 path or Terra security finding → security (JUD/Terra), even with full evidence', () => {
    expect(judgeCell(cell(`#40324\n${e4}`), facts({ files: ['src/oauth/refresh.ts'] }))).toMatchObject({ kind: 'security', hits: ['auth:src/oauth/refresh.ts'] });
    expect(judgeCell(cell(`#40324\n${e4}`), facts({ securityFindings: ['secret:token in log'] })).kind).toBe('security');
    expect(judgeCell(cell(`#40324\n${e4}`), facts({ files: null })).why).toContain('files unknown');
    expect(security4Hits(['src/land-graph/land-graph.ts', 'docs/x.md', 'scripts/deploy-pages.sh', 'src/judge-butler/body.ts'])).toEqual(['remote-exec:scripts/deploy-pages.sh']);
    // LAND-PATH-SEC4-SPLIT: only the authority boundary of the land path — merge call site · land/veto permission · land/waiver scripts
    expect(security4Hits(['src/land-graph/land-graph.ts', 'src/land-graph/throughput.ts', 'src/land-guard/stale-base-revert.ts', 'seat-state/OP/patches/land-fix.patch'])).toEqual([]);
    // SEC4-PATHS-RELAX: the big land-graph CLI is no longer security-4 — the merge credentials live in the land scripts
    expect(security4Hits(['src/cli/land-graph-cli.ts', 'src/org/land-authority.ts', 'src/org/org-map.ts', 'seat-state/OP/tools/op-direct-land-v2.sh']))
      .toEqual(['auth:src/org/land-authority.ts', 'auth:src/org/org-map.ts', 'auth:seat-state/OP/tools/op-direct-land-v2.sh']);
    expect(simEvidenceLine(cell(`x\n${e4}`))).toBe(e4);
  });
});

describe('memory — level / kill switch', () => {
  test('default live; only JUD/OP/CLAUDE-OP/CEO may demote; the change is a case', () => {
    const m = fileMemory(mkdtempSync(join(tmpdir(), 'butler-mem-')));
    expect(m.level().level).toBe('live');
    expect(() => m.setLevel('L1', 'POOL-2', 'x')).toThrow('only JUD/OP/CLAUDE-OP/CEO');
    m.setLevel('off', 'jud', 'kill switch drill');
    expect(m.level()).toMatchObject({ level: 'off', by: 'JUD' });
    expect(m.cases().at(-1)).toMatchObject({ kind: 'level', subject: 'off', decidedBy: 'JUD' });
  });
});
