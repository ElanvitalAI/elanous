// kit/canary — literal expectations (OPS-RULES 11: expected values are written out, never derived from the product's constants).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildOf, decide, emptyCanaryState, expandArgv, extractValue, isRegression, judgeReading, kpiOf, noteBuild, noteRollback, parseCanaryPack,
  readCanaryState, versionDirSha, writeCanaryState, type CanaryPolicy, type ProbeSpec, type Reading,
} from './index.js';

const REPO = resolve(import.meta.dir, '../../..');
const P: CanaryPolicy = { windowMin: 30, confirmReads: 2, confirmGapSec: 60, rollbacksPerShaMax: 1, verifyMin: 15, stepTimeoutSec: 120, suspectsMax: 12, falseRollbackWindowH: 168 };
const T = (min: number) => new Date(Date.parse('2026-11-28T14:00:00Z') + min * 60_000);
const ok = (v: number): Reading => ({ ok: true, value: v, detail: String(v), at: T(0).toISOString() });
const bad = (v: number): Reading => ({ ok: false, value: v, detail: `bad ${v}`, at: T(0).toISOString() });
const B = (sha: string, prev: string | null, ia: number | null) => ({ sha, previousSha: prev, previousDir: prev ? `versions/0.3.40-dev.0-${prev}` : null, installedAt: ia === null ? null : T(ia).toISOString() });

describe('the shipped pack graphs/policies/rail-canary.yaml', () => {
  test('parses clean · five probes in order · the doors are argv lists', () => {
    const r = parseCanaryPack(readFileSync(join(REPO, 'graphs', 'policies', 'rail-canary.yaml'), 'utf8'));
    expect(r.errors).toEqual([]);
    expect(r.pack!.probes.map(p => `${p.id}:${p.read.kind}`)).toEqual(['seat-panes:cmd', 'origin-slug:cmd', 'land-tick-age:file', 'op-gh-budget:sensor', 'fed-hands:file']);
    expect(r.pack!.probes.map(p => JSON.stringify(p.failIf))).toEqual(['{"dropPctOver":50}', '{"notMatch":"github\\\\.com[:/][^/\\\\s]+/[^/\\\\s]+"}', '{"over":25}', '{"over":95}', '{"under":1}']);
    expect(r.pack!.rollback).toEqual(['{eln}', 'self-update', '--rollback', '--json']);
    expect(r.pack!.undo).toEqual(['{eln}', 'self-update', '--rollback', '--json']);
    expect(r.pack!.restart.map(s => `${s.id}:${s.optional}:${s.argv.join(' ')}`)).toEqual(['els:false:launchctl kickstart -k gui/{uid}/dev.elanous.els', 'nexus:true:launchctl kickstart -k gui/{uid}/com.elanous.nexus']);
    expect(r.pack!.build).toEqual({ file: '{installRoot}/install.json', shaPath: 'commit', previousPath: 'previous', installedAtPath: 'installedAt' });
  });
  test('a pack without doors or with a bad probe is refused (never half-loaded)', () => {
    const r = parseCanaryPack('schema: 1\nbuild: { file: x }\nprobes:\n  - { id: Bad, read: { cmd: [] }, fail_if: {} }\nsuspects: { repo: r }\n');
    expect(r.pack).toBeNull();
    expect(r.errors).toEqual(['probes[0].id must match /^[a-z][a-z0-9-]{0,62}$/u', 'probes needs at least one probe', 'rollback.cmd must be the existing rollback door as an argv list', 'rollback.undo must be the argv that re-installs the new build (every executed act is reversible)']);
    const r2 = parseCanaryPack('schema: 1\nbuild: { file: x }\nprobes:\n  - { id: a, read: { cmd: [x] }, fail_if: { over: 1 } }\n  - { id: b, read: { sensor: nope }, fail_if: { under: 1 } }\nrollback: { cmd: [r], undo: [u] }\nsuspects: { repo: r }\n');
    expect(r2.errors).toEqual(['probes[0].read.timeout_sec is required (a hung probe must end)', 'probes[1].read.sensor nope is not one of gh-graphql-used-pct']);
  });
});

describe('values', () => {
  const now = Date.parse('2026-11-28T14:30:00Z');
  test('count rows with a seat · sum of paths · age of a field · a missing path is null (never 0)', () => {
    const panes = { panes: [{ seat: 'OP' }, { seat: null }, { seat: 'HAND-1' }, {}, { seat: '' }] };
    expect(extractValue(panes, { path: 'panes', countPresent: 'seat', sum: null, ageOf: null }, now)).toBe(2);
    expect(extractValue(panes, { path: 'panes', countPresent: null, sum: null, ageOf: null }, now)).toBe(5);
    const fed = { totals: { hands: { idle: 0, holding: 8, working: 8, noPane: 52 } } };
    expect(extractValue(fed, { path: null, countPresent: null, sum: ['totals.hands.idle', 'totals.hands.holding', 'totals.hands.working'], ageOf: null }, now)).toBe(16);
    expect(extractValue(fed, { path: null, countPresent: null, sum: ['totals.hands.idle', 'totals.hands.gone'], ageOf: null }, now)).toBeNull();
    expect(extractValue({ at: '2026-11-28T14:18:00Z' }, { path: null, countPresent: null, sum: null, ageOf: 'at' }, now)).toBe(12);
    expect(extractValue({ at: 'never' }, { path: null, countPresent: null, sum: null, ageOf: 'at' }, now)).toBeNull();
    expect(extractValue({ x: { y: 'z' } }, { path: 'x.y', countPresent: null, sum: null, ageOf: null }, now)).toBeNull();
  });
  test('install.json → sha12 · previous sha from the version dir · {eln} spreads', () => {
    expect(versionDirSha('versions/0.3.39-dev.0-fd6a1b132335')).toBe('fd6a1b132335');
    expect(versionDirSha('versions/0.3.39-a186abf1df63-dirty')).toBe('a186abf1df63');
    expect(versionDirSha(null)).toBeNull();
    const rec = { commit: 'a186abf1df6304e4321d00043c58ecd667cc39c1', previous: 'versions/0.3.39-dev.0-fd6a1b132335', installedAt: '2026-11-28T14:41:09Z' };
    expect(buildOf(rec, { file: 'x', shaPath: 'commit', previousPath: 'previous', installedAtPath: 'installedAt' }))
      .toEqual({ sha: 'a186abf1df63', previousSha: 'fd6a1b132335', previousDir: 'versions/0.3.39-dev.0-fd6a1b132335', installedAt: '2026-11-28T14:41:09Z' });
    expect(buildOf({ commit: 'unknown' }, { file: 'x', shaPath: 'commit', previousPath: 'previous', installedAtPath: 'installedAt' })).toBeNull();
    expect(expandArgv(['{eln}', 'side', 'ls', 'gui/{uid}/x', '{stateRoot}/l/{date}.jsonl'], { stateRoot: '/s', installRoot: '/i', hqRepo: '/h', uid: '501', eln: ['bun', '/p/bin/elanous.mjs'] }, T(0)))
      .toEqual(['bun', '/p/bin/elanous.mjs', 'side', 'ls', 'gui/501/x', '/s/l/20261128.jsonl']);
  });
});

describe('one probe judgment', () => {
  const drop: ProbeSpec = { id: 'seat-panes', what: '', read: { kind: 'sensor', sensor: 'x', args: {} }, failIf: { dropPctOver: 50 }, errorIsFail: true };
  const origin: ProbeSpec = { id: 'origin-slug', what: '', read: { kind: 'sensor', sensor: 'x', args: {} }, failIf: { notMatch: 'github\\.com[:/][^/\\s]+/[^/\\s]+' }, errorIsFail: false };
  const at = '2026-11-28T14:00:00.000Z';
  test('drop vs the previous build · no previous reading = ok (cannot drop) · error by error_is_fail', () => {
    expect(judgeReading(drop, { value: 0 }, ok(24), at)).toEqual({ ok: false, value: 0, detail: '24→0 (−100% > 50%)', at });
    expect(judgeReading(drop, { value: 13 }, ok(24), at)).toEqual({ ok: true, value: 13, detail: '24→13', at });
    expect(judgeReading(drop, { value: 0 }, undefined, at)).toEqual({ ok: true, value: 0, detail: '0', at });
    expect(judgeReading(drop, { value: null, error: 'els: exit 1' }, ok(24), at)).toEqual({ ok: false, value: null, detail: 'els: exit 1', at });
    expect(judgeReading(origin, { value: null, error: 'git: exit 128' }, ok(1), at)).toEqual({ ok: null, value: null, detail: 'git: exit 128', at });
  });
  test('origin text: a GitHub slug passes · a mirror path fails', () => {
    expect(judgeReading(origin, { value: 1, text: 'git@github.com:ElanvitalAI/elanous.git\n' }, undefined, at).ok).toBe(true);
    expect(judgeReading(origin, { value: 1, text: 'https://github.com/ElanvitalAI/elanous\n' }, undefined, at).ok).toBe(true);
    expect(judgeReading(origin, { value: 1, text: '/Users/x/hq/mirror/elanous-agent.git\n' }, undefined, at))
      .toEqual({ ok: false, value: 0, detail: '«/Users/x/hq/mirror/elanous-agent.git» ≠ /github\\.com[:/][^/\\s]+/[^/\\s]+/', at });
  });
  test('a regression needs a pass on the previous build', () => {
    expect(isRegression(bad(0), ok(24))).toBe(true);
    expect(isRegression(bad(0), bad(0))).toBe(false);
    expect(isRegression(bad(0), undefined)).toBe(false);
    expect(isRegression({ ok: null, value: null, detail: '', at }, ok(24))).toBe(false);
  });
});

describe('the swap state machine', () => {
  test('first sight = baseline · a swap opens the window · regression → rollback to the watched build · landed → verify fixed', () => {
    const s = emptyCanaryState();
    expect(noteBuild(s, B('aaaaaaaaaaaa', 'zzzzzzzzzzzz', -60), T(-10))).toBe('first');
    expect(decide(s, B('aaaaaaaaaaaa', 'zzzzzzzzzzzz', -60), ['seat-panes'], {}, P, T(-10))).toEqual({ kind: 'none', why: 'no swap to watch (first)' });
    expect(noteBuild(s, B('bbbbbbbbbbbb', 'aaaaaaaaaaaa', 0), T(1))).toBe('swap');
    expect([s.sha, s.prevSha, s.swapAt, s.origin]).toEqual(['bbbbbbbbbbbb', 'aaaaaaaaaaaa', '2026-11-28T14:00:00.000Z', 'swap']);
    expect(decide(s, B('bbbbbbbbbbbb', 'aaaaaaaaaaaa', 0), [], {}, P, T(1))).toEqual({ kind: 'none', why: 'no regression' });
    const d = decide(s, B('bbbbbbbbbbbb', 'aaaaaaaaaaaa', 0), ['seat-panes', 'fed-hands'], {}, P, T(6));
    expect(d).toEqual({ kind: 'rollback', from: 'bbbbbbbbbbbb', to: 'aaaaaaaaaaaa', probes: ['seat-panes', 'fed-hands'] });
    expect(kpiOf(s, P, T(8))).toEqual({ canary_fail_to_rollback_minutes: 2, false_rollbacks: 0 });
    const row = noteRollback(s, d as Extract<typeof d, { kind: 'rollback' }>, T(8));
    expect(row).toEqual({ from: 'bbbbbbbbbbbb', to: 'aaaaaaaaaaaa', at: '2026-11-28T14:08:00.000Z', failSince: '2026-11-28T14:06:00.000Z', probes: ['seat-panes', 'fed-hands'], minutes: 2, verdict: 'pending' });
    expect(noteBuild(s, B('aaaaaaaaaaaa', 'bbbbbbbbbbbb', 8), T(9))).toBe('same');
    expect(decide(s, B('aaaaaaaaaaaa', 'bbbbbbbbbbbb', 8), [], { 'seat-panes': ok(24), 'fed-hands': ok(16) }, P, T(13))).toEqual({ kind: 'none', why: 'rollback verified — seat-panes, fed-hands back on aaaaaaaaaaaa' });
    expect(s.rollbacks.map(r => r.verdict)).toEqual(['fixed']);
    expect(kpiOf(s, P, T(13))).toEqual({ canary_fail_to_rollback_minutes: 0, false_rollbacks: 0 });
  });
  test('the same sha re-installed and regressing again → limit (no second rollback) · an unwatched previous → no-target', () => {
    const s = emptyCanaryState();
    noteBuild(s, B('aaaaaaaaaaaa', null, -60), T(-10)); noteBuild(s, B('cccccccccccc', 'aaaaaaaaaaaa', 0), T(1));
    const d = decide(s, B('cccccccccccc', 'aaaaaaaaaaaa', 0), ['seat-panes'], {}, P, T(6));
    noteRollback(s, d as Extract<typeof d, { kind: 'rollback' }>, T(6));
    noteBuild(s, B('cccccccccccc', 'aaaaaaaaaaaa', 120), T(121));
    expect(decide(s, B('cccccccccccc', 'aaaaaaaaaaaa', 120), ['seat-panes'], {}, P, T(126))).toEqual({ kind: 'limit', sha: 'cccccccccccc', probes: ['seat-panes'], why: 'cccccccccccc was rolled back 1× already — not again' });
    const u = emptyCanaryState();
    noteBuild(u, B('aaaaaaaaaaaa', null, -60), T(-10)); noteBuild(u, B('dddddddddddd', 'eeeeeeeeeeee', 0), T(1));
    expect(decide(u, B('dddddddddddd', 'eeeeeeeeeeee', 0), ['origin-slug'], {}, P, T(6)))
      .toEqual({ kind: 'no-target', sha: 'dddddddddddd', probes: ['origin-slug'], why: 'install.json previous (versions/0.3.40-dev.0-eeeeeeeeeeee) is not the build watched healthy (aaaaaaaaaaaa)' });
  });
  test('outside the window = baseline only · a rollback that did not fix → false rollback after verify_min', () => {
    const s = emptyCanaryState();
    noteBuild(s, B('aaaaaaaaaaaa', null, -60), T(-10)); noteBuild(s, B('bbbbbbbbbbbb', 'aaaaaaaaaaaa', 0), T(1));
    expect(decide(s, B('bbbbbbbbbbbb', 'aaaaaaaaaaaa', 0), ['seat-panes'], {}, P, T(31))).toEqual({ kind: 'none', why: 'outside the watch window — baseline only' });
    const f = emptyCanaryState();
    noteBuild(f, B('aaaaaaaaaaaa', null, -60), T(-10)); noteBuild(f, B('bbbbbbbbbbbb', 'aaaaaaaaaaaa', 0), T(1));
    const d = decide(f, B('bbbbbbbbbbbb', 'aaaaaaaaaaaa', 0), ['op-gh-budget'], {}, P, T(6));
    noteRollback(f, d as Extract<typeof d, { kind: 'rollback' }>, T(6));
    expect(decide(f, B('aaaaaaaaaaaa', 'bbbbbbbbbbbb', 6), [], { 'op-gh-budget': bad(99) }, P, T(11))).toEqual({ kind: 'none', why: 'verifying rollback (op-gh-budget still failing)' });
    const v = decide(f, B('aaaaaaaaaaaa', 'bbbbbbbbbbbb', 6), [], { 'op-gh-budget': bad(99) }, P, T(21));
    expect(v.kind).toBe('false-rollback');
    expect(kpiOf(f, P, T(21))).toEqual({ canary_fail_to_rollback_minutes: 0, false_rollbacks: 1 });
  });
  test('state file round-trip keeps the KPI line', () => {
    const home = mkdtempSync(join(tmpdir(), 'canary-state-'));
    const s = emptyCanaryState(); noteBuild(s, B('aaaaaaaaaaaa', null, 0), T(0)); s.readings.aaaaaaaaaaaa = { 'seat-panes': ok(24) };
    writeCanaryState(home, s, { canary_fail_to_rollback_minutes: 0, false_rollbacks: 0 });
    expect(readCanaryState(home).readings).toEqual({ aaaaaaaaaaaa: { 'seat-panes': { ok: true, value: 24, detail: '24', at: '2026-11-28T14:00:00.000Z' } } });
    expect((JSON.parse(readFileSync(join(home, 'canary.json'), 'utf8')) as { kpi: unknown }).kpi).toEqual({ canary_fail_to_rollback_minutes: 0, false_rollbacks: 0 });
  });
});
