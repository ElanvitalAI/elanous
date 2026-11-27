// OP-WORLD-LENS — sim world: a synthetic federation (board · git main · land-graph ledger · hand pool · msg store ·
// loop-agent homes) and the card must report exactly the numbers its sources hold. Expectations are independent literals.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChecklistItem } from '../release-loop/checklist.js';
import type { HandPoolEntry } from '../seat/hand-pool.js';
import {
  boardLens, collectWorldLens, deltaLine, journalCount1h, landLens, lastLedgerAt, ledgerHelperHealth, lensLinesForTurn, lensNumbers, parseLensPolicy, poolLens,
  previousVersion, readLensSeen, renderLensLines, triggerHelperHealth, writeLensCache, DEFAULT_LENS_POLICY, type LensFacts,
} from './world-lens.js';

const NOW = new Date('2026-11-27T04:00:00.000Z');
const noRefresh = () => undefined; // the turn path's background refresh would read the live federation
const tmp = () => mkdtempSync(join(tmpdir(), 'world-lens-'));
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const cell = (id: string, status: ChecklistItem['status'], owner: string, updatedMin: number, evidence = ''): ChecklistItem =>
  ({ id, title: id, status, owner, evidence, updatedAt: ago(updatedMin), updatedBy: 'sim' });
const hand = (seat: string, state: HandPoolEntry['state']): HandPoolEntry => ({ seat, home: 'TC', state, lent: false, closeCandidate: false });

describe('board lens — stale · obsolete · OP-held · implementer-carried', () => {
  const items = [
    cell('A', 'green', 'TC', 30), cell('B', 'done', 'OP', 3000),
    cell('C', 'yellow', 'OP', 10), cell('D', 'yellow', 'OP', 2000), // D stale (≥24h)
    cell('E', 'yellow', 'OP', 20, 'r1 · implementing: Claude OP PR #40460'),
    cell('F', 'yellow', 'TC', 5, 'obsolete: JUD-RELIEF-RESPEC #40451'), // open but marked → the cleanse missed it
    cell('G', 'done', 'JUD', 30, 'obsolete: JUD-RELIEF-RESPEC #40451'), // closed obsolete → not counted
    cell('H', 'red', 'OP/claude', 1500), // stale · carried (OP/claude subseat)
  ];
  test('counts', () => {
    const b = boardLens('0.3.38', items, NOW);
    expect([b.total, b.green, b.open, b.opHeld, b.opImplementing, b.stale, b.obsolete, b.green1h]).toEqual([8, 3, 5, 4, 2, 2, 1, 1]);
    expect(b.obsoleteIds).toEqual(['F']);
    expect(b.owners).toEqual([['OP', 4], ['TC', 1]]);
  });
  test('a title/body mentioning «obsolete» is not obsolete (only evidence decides)', () => {
    const x: ChecklistItem = { ...cell('X', 'yellow', 'TC', 5), title: 'drop obsolete code paths' };
    const b = boardLens('0.3.38', [x], NOW);
    expect(b.obsolete).toBe(0);
  });
  test('previous version', () => {
    expect(previousVersion('0.3.38')).toBe('0.3.37');
    expect(previousVersion('0.4.0')).toBe(null);
    expect(previousVersion('garbage')).toBe(null);
  });
});

describe('land lens — closed PRs drop out · waiting → actor · refusals by root', () => {
  const r = (pr: number, at: string, event: string, extra: Record<string, unknown> = {}) => ({ at, pr, head: 'h', mode: 'live', event, ...extra }) as never;
  const rows = [
    r(1, ago(600), 'decision', { action: 'refuse', cls: 'stale-head' }),
    r(1, ago(5), 'landed', { doneAt: ago(4) }), // landed today → not in the queue
    r(2, ago(60), 'decision', { action: 'refuse', cls: 'merge-conflict' }),
    r(3, ago(3000), 'decision', { action: 'refuse', cls: 'pregate-red' }), // closed PR → dropped
    r(4, ago(30), 'decision', { action: 'wait', cls: 'review-required' }),
    r(5, ago(30), 'refused', { cls: 'merge-conflict' }),
    r(6, ago(30), 'decision', { action: 'hold', cls: 'held' }),
    r(7, ago(30), 'decision', { action: 'wait', cls: 'no-receipt' }),
    r(8, ago(30), 'decision', { action: 'refuse', cls: 'stale-head', synthetic: true }), // synthetic → ignored
  ];
  test('open set known', () => {
    const l = landLens(rows, new Set([2, 4, 5, 6, 7, 8]), 7, NOW);
    expect([l.landed1h, l.landedToday, l.openPrs, l.droppedClosed]).toEqual([7, 1, 5, 1]);
    expect(l.refused).toEqual([['merge-conflict', 2]]);
    expect(l.refusedPrs).toEqual([['merge-conflict', [2, 5]]]);
    expect(l.waiting).toEqual([['held', 1], ['no-receipt', 1], ['review-required', 1]]);
  });
  test('open set unread → ledger view whole, openPrs unknown', () => {
    const l = landLens(rows, null, null, NOW);
    expect([l.openPrs, l.droppedClosed]).toEqual([null, 0]);
    expect(l.refused).toEqual([['merge-conflict', 2], ['pregate-red', 1]]);
  });
});

describe('pool lens — WIP-1 conflicts', () => {
  test('a hand with two active cells is a conflict; a stale second cell is not', () => {
    const pool = [hand('TC-H-CX-1', 'working'), hand('TC-H-CX-2', 'idle'), hand('TC-H-CX-3', 'no-pane')];
    const items = [cell('P', 'yellow', 'TC-H-CX-1', 10), cell('Q', 'yellow', 'TC-H-CX-1', 20), cell('R', 'yellow', 'TC-H-CX-2', 10),
      cell('S', 'yellow', 'TC-H-CX-2', 600), cell('T', 'green', 'TC-H-CX-2', 5), cell('U', 'yellow', 'TC', 5), cell('V', 'yellow', 'TC', 6)];
    const p = poolLens(pool, items, NOW, 180 * 60_000);
    expect([p.working, p.idle, p.noPane]).toEqual([1, 1, 1]);
    expect(p.wip1).toEqual([{ seat: 'TC-H-CX-1', cells: ['P', 'Q'] }]);
  });
});

describe('policy + journal', () => {
  test('yaml overrides, bad values fall back', () => {
    const p = parseLensPolicy('board:\n  stale_hours: 6\n  obsolete_markers: [gone]\nmail:\n  coordinators: [op, tc]\n  oldest_warn_min: -3\n');
    expect([p.staleHours, p.obsoleteMarkers, p.coordinators, p.oldestWarnMin, p.staleTickMin]).toEqual([6, ['gone'], ['OP', 'TC'], 60, 30]);
  });
  test('the shipped policy file parses and carries the cheat lines (≤8 · each names an eln command)', () => {
    const p = parseLensPolicy(require('node:fs').readFileSync(join(import.meta.dir, '..', '..', 'graphs', 'policies', 'op-world.yaml'), 'utf8'));
    expect(p.staleHours).toBe(24);
    expect(p.coordinators).toEqual(['OP', 'TC', 'UX', 'MK', 'JUD', 'REL', 'RES']);
    expect(p.cheat.length).toBe(6);
    for (const c of p.cheat) expect(c).toContain('eln ');
  });
  test('journal rows in the last hour (future rows and torn rows skipped)', () => {
    const text = [JSON.stringify({ at: ago(10) }), JSON.stringify({ at: ago(70) }), '{torn', JSON.stringify({ at: new Date(NOW.getTime() + 60_000).toISOString() }), JSON.stringify({ at: ago(59) })].join('\n');
    expect(journalCount1h(text, NOW)).toBe(2);
  });
});

function gitWorld(now: Date): string {
  const repo = tmp();
  const run = (args: string[], date?: string) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}), GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@x', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@x' } });
  run(['init', '-q', '-b', 'main']);
  const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  run(['commit', '-q', '--allow-empty', '-m', 'old (#10)'], at(120)); // outside the hour
  run(['commit', '-q', '--allow-empty', '-m', 'feat: a (#11)'], at(40));
  run(['commit', '-q', '--allow-empty', '-m', 'chore: no pr number'], at(30));
  run(['commit', '-q', '--allow-empty', '-m', 'fix: b (#12)'], at(20));
  run(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return join(repo, '.git');
}

describe('sim world — collectWorldLens numbers match the sources', () => {
  test('synthetic federation → card', async () => {
    const now = new Date(); // git windows are real time
    const inst = tmp();
    mkdirSync(join(inst, 'land-graph'), { recursive: true });
    const lr = (pr: number, event: string, extra: Record<string, unknown>) => JSON.stringify({ at: now.toISOString(), pr, head: 'h', mode: 'live', event, ...extra });
    writeFileSync(join(inst, 'land-graph', 'ledger.jsonl'), [lr(39275, 'decision', { action: 'refuse', cls: 'pregate-red' }), lr(40500, 'decision', { action: 'refuse', cls: 'stale-head' }),
      lr(40501, 'decision', { action: 'wait', cls: 'review-required' })].join('\n') + '\n');
    for (const [id, tickMin, rows] of [['judge-butler', 3, 4], ['silence-watch', 90, 1]] as const) {
      mkdirSync(join(inst, 'loop-agents', id), { recursive: true });
      writeFileSync(join(inst, 'loop-agents', id, 'state.json'), JSON.stringify({ lastTickAt: new Date(now.getTime() - tickMin * 60_000).toISOString() }));
      writeFileSync(join(inst, 'loop-agents', id, 'cases.jsonl'), Array.from({ length: rows }, () => JSON.stringify({ at: new Date(now.getTime() - 5 * 60_000).toISOString() })).join('\n') + '\n');
    }
    const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
    const c = (id: string, status: ChecklistItem['status'], owner: string, min: number, evidence = ''): ChecklistItem => ({ id, title: id, status, owner, evidence, updatedAt: at(min), updatedBy: 'sim' });
    const f = await collectWorldLens({
      now, instanceRoot: inst, gitDir: gitWorld(now), policy: DEFAULT_LENS_POLICY, openPrs: () => new Set([40500, 40501]),
      pool: async () => [hand('TC-H-CX-1', 'working'), hand('TC-H-CX-2', 'idle')],
      board: () => ({ version: '0.3.38', items: [c('A', 'yellow', 'OP', 5), c('B', 'yellow', 'OP', 3000), c('C', 'green', 'TC', 10), c('D', 'yellow', 'TC-H-CX-1', 5), c('E', 'yellow', 'TC-H-CX-1', 9)],
        prev: { version: '0.3.37', items: [c('Z1', 'yellow', 'OP', 9000), c('Z2', 'yellow', 'OP', 9000), c('Z3', 'green', 'OP', 9000)] } }),
      msgStorePath: join(inst, 'no-msg.db'), commitments: () => ({ open: 3, overdue: 2 }), world: () => '세계: live 1',
      loops: () => ({ total: 15, exceptions: [{ id: 'release-traffic', at: at(42) }], unnormalized: 1 }),
      agentLint: () => [{ id: 'autopsy', ok: true, errors: [] }, { id: 'silence-watch', ok: false, errors: ['wake.trigger needs exactly one of cron (5 fields) | condition'] }],
    });
    expect([f.board?.open, f.board?.opHeld, f.board?.stale, f.prevBoard?.open, f.prevBoard?.total]).toEqual([4, 2, 1, 2, 3]);
    expect([f.land?.landed1h, f.land?.openPrs, f.land?.droppedClosed]).toEqual([2, 2, 1]);
    expect(f.pool?.wip1).toEqual([{ seat: 'TC-H-CX-1', cells: ['D', 'E'] }]);
    expect(f.supervisors).toEqual([
      { id: 'judge-butler', lastTickAt: at(3), journal1h: 4 },
      { id: 'silence-watch', lastTickAt: at(90), journal1h: 1 },
    ]);
    expect(f.mail).toBe(null);
    expect(f.unmeasured.some(u => u.startsWith('mail('))).toBe(true);
    const lines = renderLensLines(f, now, null);
    expect(lines).toContain('- Hands: working 1 · idle 1 · no-pane 0 · WIP-1 conflicts 1 (TC-H-CX-1: D,E) [src: eln seat pool --json]');
    expect(lines.find(l => l.startsWith('- Leftovers'))).toBe('- Leftovers 0.3.37: 2 open / 3 (OP 2) — NOT the active board; move what still matters, leave the rest [src: eln release checklist status --version 0.3.37]');
    expect(lines.find(l => l.startsWith('- Supervisors'))).toBe('- Supervisors: 2 loop agents · agent.yaml 1/2 clean · journal 1h 5 rows · stale tick(>30m) 1 (silence-watch 1h30m) [src: eln loop agent list]');
    expect(lines.find(l => l.startsWith('- Loops'))).toBe('- Loops: ok 14/15 · exception: release-traffic 42m · 미정상화 사건 1 (target 0) [src: eln loop trigger list · eln loop agent run-doctor status]');
    // YAML-SUPERVISORS-RUNTIME: a refused agent.yaml is named in the OP world card
    expect(lines.find(l => l.startsWith('  ⚠ agent.yaml'))).toBe('  ⚠ agent.yaml REFUSED 1: silence-watch (wake.trigger needs exactly one of cron (5 fields) | condition) — fix the YAML (a refused agent.yaml runs its v2 fallback card · a goal.yaml drift needs eln loop agent gen) [src: eln loop agent lint]');
    expect(lines.find(l => l.startsWith('- Refusals'))).toBe('- Refusals by root: stale-head 1 (#40500) [src: eln land graph status]');
    expect(lines.find(l => l.startsWith('- Mail backlog'))).toBe('- Mail backlog: ? [src: eln msg count --to <seat>]');
    // every metric line names its source
    for (const l of lines.filter(x => x.startsWith('- ') && !x.startsWith('- Δ') && !x.startsWith('- unread'))) expect(l).toContain('[src: ');
  });
});

describe('Δ since your last turn', () => {
  const base: LensFacts = { at: NOW.toISOString(), board: boardLens('0.3.38', [cell('A', 'yellow', 'OP', 5)], NOW), prevBoard: null, land: null, pool: null,
    mail: [{ seat: 'TC', unacked: 36, oldestAt: ago(1560) }], hands: [], commitments: null, holds: null, supervisors: null, world: null, unmeasured: [] };
  test('first card · no change · changes', () => {
    expect(deltaLine(null, base, NOW)).toBe('- Δ since your last turn: first card (no previous numbers)');
    expect(deltaLine({ at: ago(30), numbers: lensNumbers(base) }, base, NOW)).toBe('- Δ since your last turn (30m ago): no change');
    const next: LensFacts = { ...base, mail: [{ seat: 'TC', unacked: 40, oldestAt: ago(1560) }], board: boardLens('0.3.38', [], NOW) };
    expect(deltaLine({ at: ago(45), numbers: lensNumbers(base) }, next, NOW)).toBe('- Δ since your last turn (45m ago): open cells -1 · OP-held -1 · mail TC +4');
  });
  test('turn path: cached card, advance writes the seen numbers, stale cache is labelled', () => {
    const inst = tmp();
    expect(lensLinesForTurn(inst, 'OP', NOW, true, { ...DEFAULT_LENS_POLICY, cacheMaxAgeMin: 100_000_000 }, noRefresh)[0]).toContain('not computed yet');
    writeLensCache(inst, base);
    const first = lensLinesForTurn(inst, 'OP', NOW, true, { ...DEFAULT_LENS_POLICY, cacheMaxAgeMin: 100_000_000 }, noRefresh);
    expect(first.at(-1)).toBe('- Δ since your last turn: first card (no previous numbers)');
    expect(readLensSeen(inst, 'OP')?.numbers['mail TC']).toBe(36);
    const old = lensLinesForTurn(inst, 'OP', new Date(NOW.getTime() + 20 * 60_000), false, { ...DEFAULT_LENS_POLICY, cacheMaxAgeMin: 10 }, noRefresh);
    expect(old[0]).toContain('⚠ computed 20m ago (refreshing)');
  });
});

describe('OP-HELPERS-STABILIZE — «조력자 건강» line (helpers from the policy)', () => {
  const spec = (over: Record<string, unknown>) => ({ id: 'x', maxAgeMin: 60, ...over }); // 출처: #40561 — policy literals under test (graphs/policies/op-world.yaml helpers)
  test('policy rows: id ⊕ exactly one of trigger | ledger; the rest is dropped', () => {
    const p = parseLensPolicy([
      'helpers:',
      '  - { id: op-pulse, trigger: op-pulse, max_age_min: 130 }',
      '  - { id: fed-turns, ledger: fed-state/facts.jsonl, match: { type: turn, seat: OP }, max_age_min: 180 }',
      '  - { id: both, trigger: a, ledger: b }',
      '  - { trigger: no-id }',
      '  - { id: neither }',
      '  - { id: no-age, ledger: loops/x.jsonl }',
    ].join('\n'));
    expect(p.helpers).toEqual([
      { id: 'op-pulse', trigger: 'op-pulse', maxAgeMin: 130 }, // 출처: #40561 — policy literals under test (graphs/policies/op-world.yaml helpers)
      { id: 'fed-turns', ledger: 'fed-state/facts.jsonl', match: { type: 'turn', seat: 'OP' }, maxAgeMin: 180 }, // 출처: #40561 — policy literals under test (graphs/policies/op-world.yaml helpers)
      { id: 'no-age', ledger: 'loops/x.jsonl', maxAgeMin: 120 }, // 출처: #40561 — policy literals under test (graphs/policies/op-world.yaml helpers)
    ]);
    expect(parseLensPolicy('version: 1').helpers).toEqual([]);
  });
  test('trigger helper: never · exception · stale · in flight after a done fire', () => {
    const f = (min: number, status: string, error: string | null = null) => ({ window: ago(min), status, dispatchedAt: ago(min), error });
    expect(triggerHelperHealth(spec({ trigger: 't' }), [], NOW)).toEqual({ id: 'x', ok: false, why: 'never fired' });
    expect(triggerHelperHealth(spec({ trigger: 't' }), [f(5, 'running'), f(30, 'exception', 'graph   read failed')], NOW))
      .toEqual({ id: 'x', ok: false, why: 'exception 03:30Z graph read failed' });
    expect(triggerHelperHealth(spec({ trigger: 't' }), [f(61, 'done')], NOW)).toEqual({ id: 'x', ok: false, why: 'stale 1h01m' });
    expect(triggerHelperHealth(spec({ trigger: 't' }), [f(4, 'dispatched'), f(64, 'done')], NOW)).toEqual({ id: 'x', ok: true, why: 'dispatched 4m ago' });
  });
  test('ledger helper: newest (matching) row · torn tail · missing', () => {
    const text = [JSON.stringify({ ts: ago(300), type: 'turn', seat: 'OP' }), JSON.stringify({ ts: ago(2), type: 'mail', seat: 'OP' }), JSON.stringify({ at: ago(1) }), '{torn'].join('\n');
    expect(lastLedgerAt(text)).toBe(ago(1));
    expect(lastLedgerAt(text, { type: 'turn', seat: 'OP' })).toBe(ago(300));
    expect(lastLedgerAt(text, { type: 'turn', seat: 'TC' })).toBe(null);
    expect(ledgerHelperHealth(spec({ ledger: 'l' }), ago(10), NOW)).toEqual({ id: 'x', ok: true, why: '10m ago' });
    expect(ledgerHelperHealth(spec({ ledger: 'l' }), ago(300), NOW)).toEqual({ id: 'x', ok: false, why: 'stale 5h00m' });
    expect(ledgerHelperHealth(spec({ ledger: 'l', match: { type: 'turn' } }), null, NOW)).toEqual({ id: 'x', ok: false, why: 'no matching row' });
    expect(ledgerHelperHealth(spec({ ledger: 'l' }), null, NOW)).toEqual({ id: 'x', ok: false, why: 'no ledger' });
  });
  test('collect → card line: ok n/m · failing names (trigger seam ⊕ ledgers under the instance root)', async () => {
    const inst = tmp();
    mkdirSync(join(inst, 'loops'), { recursive: true }); mkdirSync(join(inst, 'fed-state'), { recursive: true });
    writeFileSync(join(inst, 'loops', 'throughput-controller.jsonl'), `${JSON.stringify({ at: ago(20), verdict: 'ready-drought' })}\n`);
    writeFileSync(join(inst, 'fed-state', 'facts.jsonl'), `${JSON.stringify({ ts: ago(1), type: 'mail', seat: 'OP' })}\n`); // no OP turn row
    const policy = { ...DEFAULT_LENS_POLICY, helpers: [
      { id: 'op-pulse', trigger: 'op-pulse', maxAgeMin: 130 }, { id: 'op-bulletin', trigger: 'op-bulletin', maxAgeMin: 60 }, // 출처: #40561 — policy literals under test (graphs/policies/op-world.yaml helpers)
      { id: 'throughput', ledger: 'loops/throughput-controller.jsonl', maxAgeMin: 130 }, { id: 'next-action', ledger: 'loops/op-next-action.jsonl', maxAgeMin: 130 }, // 출처: #40561 — policy literals under test (graphs/policies/op-world.yaml helpers)
      { id: 'fed-turns', ledger: 'fed-state/facts.jsonl', match: { type: 'turn', seat: 'OP' }, maxAgeMin: 180 }, // 출처: #40561 — policy literals under test (graphs/policies/op-world.yaml helpers)
    ] };
    const fires = (id: string) => id === 'op-pulse' ? [{ window: ago(10), status: 'done', dispatchedAt: ago(9), error: null }] : [];
    const f = await collectWorldLens({ now: NOW, instanceRoot: inst, gitDir: join(inst, 'no-git'), policy, openPrs: () => new Set(), pool: async () => [],
      board: () => ({ version: '0.3.38', items: [] }), msgStorePath: join(inst, 'no-msg.db'), commitments: () => ({ open: 0, overdue: 0 }), world: () => 'w', agentLint: () => [], fires });
    expect(f.helpers).toEqual([
      { id: 'op-pulse', ok: true, why: 'done 9m ago' }, { id: 'op-bulletin', ok: false, why: 'never fired' },
      { id: 'throughput', ok: true, why: '20m ago' }, { id: 'next-action', ok: false, why: 'no ledger' },
      { id: 'fed-turns', ok: false, why: 'no matching row' },
    ]);
    const line = renderLensLines(f, NOW, null, policy).find(l => l.startsWith('- 조력자 건강'));
    expect(line).toBe('- 조력자 건강 (OP helpers): ok 2/5 · failing op-bulletin (never fired) · next-action (no ledger) · fed-turns (no matching row) [src: eln loop trigger fires <id> · graphs/policies/op-world.yaml helpers]');
    expect(lensNumbers(f)['helpers failing']).toBe(3);
    // no helpers in the policy → no line at all
    const none = await collectWorldLens({ now: NOW, instanceRoot: inst, gitDir: join(inst, 'no-git'), policy: DEFAULT_LENS_POLICY, openPrs: () => new Set(), pool: async () => [],
      board: () => ({ version: '0.3.38', items: [] }), msgStorePath: join(inst, 'no-msg.db'), commitments: () => ({ open: 0, overdue: 0 }), world: () => 'w', agentLint: () => [] });
    expect(renderLensLines(none, NOW, null).some(l => l.includes('조력자 건강'))).toBe(false);
  });
});
