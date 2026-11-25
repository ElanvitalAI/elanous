// COACH-CONTEXT-AUTO-INJECT — sim world + synthetic events. Expectations are independent literals.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCoachAction, coachCursorPath, coachDelta, coachLedgerPath, readCoachActions, readCoachCursor, type CoachAction } from './coach-ledger.js';
import { boardOf, collectWorldFacts, readCoach, renderWorldBlock, worldBlockForSeatTurn, worldSeats, worldTime, writeWorldNow, type WorldFacts } from './op-world.js';

const KST = 540;
const NOW = new Date('2026-11-25T17:30:00.000Z'); // 11-26 02:30 KST
const tmp = () => mkdtempSync(join(tmpdir(), 'op-world-'));
const EMPTY: WorldFacts = { release: null, board: null, graph: null, org: null, rate: null, handsOpen: null, coach: null };
const act = (i: number, at: string): CoachAction => ({ id: `a${i}`, at, by: 'CLAUDE-OP', what: `action ${i}`, why: '', next: '', source: 'sim' });

describe('WORLD block render', () => {
  test('all facts missing → every line says unknown, never throws', () => {
    expect(renderWorldBlock(EMPTY, NOW, KST)).toBe([
      '## WORLD — computed from facts at 02:30 (not hand-written · re-read sources before acting)',
      '- Release: unknown',
      '- Board: unknown',
      '- Release graph: unknown',
      '- Last 1h: landed unknown/10 · green unknown/10 (target 10/10)',
      '- ✋ open: unknown',
      '- Org: unknown',
      '- Coach actions: unknown',
    ].join('\n'));
  });

  test('partial facts + stale (published) plan + OP holding cells', () => {
    const f: WorldFacts = {
      ...EMPTY,
      release: { version: '0.3.36', source: 'plan', cutAt: '2026-11-25T19:00:00.000Z', publishAt: '2026-11-25T21:00:00.000Z', published: true },
      board: boardOf([
        { status: 'green' }, { status: 'yellow', owner: 'OP' }, { status: 'yellow', owner: 'OP/x' }, { status: 'yellow', owner: 'TC' }, { status: 'red' },
      ], NOW).board,
      rate: { landed1h: 4, green1h: null },
      handsOpen: 2,
    };
    expect(renderWorldBlock(f, NOW, KST).split('\n').slice(1, 6)).toEqual([
      '- Release: 0.3.36 (from plan) · cut 04:00 · publish 06:00 · ⚠ STALE: already published — check the next plan',
      '- Board: 1 green / 3 yellow / 5 total · open owners: OP 2 · (none) 1 · TC 1',
      '  ⚠ OP holds 2 open cell(s) — hands cannot pull them; OP should hold 0 (release or hand them out)',
      '- Release graph: unknown',
      '- Last 1h: landed 4/10 ↓ · green unknown/10 (target 10/10)',
    ]);
  });

  test('stale plan by publish time passed (not yet published)', () => {
    const f: WorldFacts = { ...EMPTY, release: { version: '0.3.35', source: 'schedule', cutAt: '2026-11-24T19:00:00.000Z', publishAt: '2026-11-24T21:00:00.000Z', published: false } };
    expect(renderWorldBlock(f, NOW, KST).split('\n')[1]).toBe('- Release: 0.3.35 (from schedule) · cut 11-25 04:00 · publish 11-25 06:00 · ⚠ STALE: publish time passed — check the next plan');
  });

  test('clock rollover past midnight: yesterday rows carry the date', () => {
    const now = new Date('2026-11-25T15:05:00.000Z'); // 11-26 00:05 KST
    expect(worldTime('2026-11-25T14:58:00.000Z', now, KST)).toBe('11-25 23:58');
    expect(worldTime('2026-11-25T15:02:00.000Z', now, KST)).toBe('00:02');
    expect(worldTime(null, now, KST)).toBe('unknown');
    expect(worldTime('garbage', now, KST)).toBe('unknown');
  });

  test('huge coach delta is capped to 5 and summarised; block stays ≤ 40 lines', () => {
    const rows = Array.from({ length: 500 }, (_, i) => act(i, new Date(NOW.getTime() - (500 - i) * 1000).toISOString()));
    const d = coachDelta(rows, { lastId: 'a99', lastAt: null }, 5);
    expect(d.fresh).toBe(400);
    expect(d.shown.length).toBe(5);
    expect(d.freshOmitted).toBe(395);
    const text = renderWorldBlock({ ...EMPTY, coach: d }, NOW, KST);
    expect(text).toContain('- Coach actions (outside eln OP): 400 new since your last turn · latest 5 of 500 · 395 more new not shown (eln coach list)');
    expect(text).toContain('  NEW 02:29 CLAUDE-OP: action 499');
    expect(text.split('\n').length).toBeLessThanOrEqual(40);
  });

  test('cursor at the last row → 0 new, rows shown without NEW', () => {
    const rows = [act(1, '2026-11-25T17:00:00.000Z'), act(2, '2026-11-25T17:10:00.000Z')];
    const d = coachDelta(rows, { lastId: 'a2', lastAt: null });
    expect(d.fresh).toBe(0);
    expect(renderWorldBlock({ ...EMPTY, coach: d }, NOW, KST).split('\n').slice(-2)).toEqual(['  02:00 CLAUDE-OP: action 1', '  02:10 CLAUDE-OP: action 2']);
  });
});

describe('coach ledger', () => {
  test('append → read → cursor advance → next turn sees only the new row', () => {
    const root = tmp(); const path = coachLedgerPath(root);
    appendCoachAction(path, { what: 'landed #1', why: 'green', next: 'board', now: new Date('2026-11-25T17:00:00.000Z') });
    expect(readCoach(root, 'OP', true)?.fresh).toBe(1);
    expect(readCoach(root, 'OP', true)?.fresh).toBe(0);
    appendCoachAction(path, { what: 'config set llm.model', now: new Date('2026-11-25T17:01:00.000Z') });
    expect(readCoach(root, 'OP', true)?.fresh).toBe(1);
    expect(readCoachCursor(coachCursorPath(root, 'OP')).lastAt).toBe('2026-11-25T17:01:00.000Z');
    expect(() => appendCoachAction(path, { what: '   ' })).toThrow('--what is required');
  });

  test('torn and foreign lines are skipped', () => {
    const root = tmp(); const path = coachLedgerPath(root);
    appendCoachAction(path, { what: 'ok' });
    require('node:fs').appendFileSync(path, '{"id":"x"\nnot json\n{"foo":1}\n');
    expect(readCoachActions(path).map(r => r.what)).toEqual(['ok']);
  });

  test('concurrent writers (8 processes × 25 rows) lose and tear nothing', async () => {
    const root = tmp(); const path = coachLedgerPath(root);
    const mod = join(import.meta.dir, 'coach-ledger.ts');
    const script = `const { appendCoachAction } = await import(${JSON.stringify(mod)}); for (let i = 0; i < 25; i++) appendCoachAction(${JSON.stringify(path)}, { what: 'w' + process.argv[2] + '-' + i + ' ' + 'x'.repeat(300) });`;
    const procs = Array.from({ length: 8 }, (_, k) => Bun.spawn([process.execPath, '-e', script, String(k)], { stdout: 'ignore', stderr: 'inherit' }));
    await Promise.all(procs.map(p => p.exited));
    const rows = readCoachActions(path);
    expect(rows.length).toBe(200);
    expect(new Set(rows.map(r => r.id)).size).toBe(200);
    expect(readFileSync(path, 'utf8').trim().split('\n').length).toBe(200);
  }, 30_000);
});

describe('live collector over a sim world', () => {
  test('empty roots → facts null/unknown, block renders without throwing', () => {
    const hq = tmp(); const inst = tmp();
    const f = collectWorldFacts({ now: NOW, hqRoot: hq, instanceRoot: inst, ledgerRoot: join(inst, 'none'), repoRoot: join(inst, 'no-repo') });
    expect(f.graph).toBe(null);
    expect(f.coach?.total).toBe(0);
    expect(renderWorldBlock(f, NOW, KST)).toContain('- Coach actions: none recorded');
  });

  test('graph last tick is read (hardStop + mode)', () => {
    const inst = tmp();
    require('node:fs').mkdirSync(join(inst, 'release-graph'), { recursive: true });
    require('node:fs').writeFileSync(join(inst, 'release-graph', 'last-tick.json'), JSON.stringify({ runs: [{ version: '9.9.9', mode: 'live', done: false, hardStop: { reason: 'gate red' } }] }));
    const f = collectWorldFacts({ now: NOW, hqRoot: tmp(), instanceRoot: inst, ledgerRoot: join(inst, 'none'), repoRoot: join(inst, 'no-repo') });
    // Without a resolvable release version the graph run cannot be matched → unknown, not a wrong run.
    if (f.release === null) expect(f.graph).toBe(null);
  });

  test('seat opt-in: default OP only · env widens · none disables', () => {
    expect([...worldSeats({})]).toEqual(['OP']);
    expect([...worldSeats({ ELANOUS_WORLD_SEATS: 'op, tc' })]).toEqual(['OP', 'TC']);
    expect([...worldSeats({ ELANOUS_WORLD_SEATS: 'none' })]).toEqual([]);
    expect(worldBlockForSeatTurn('TC', { env: {}, instanceRoot: tmp(), hqRoot: tmp() })).toBe('');
  });

  test('WORLD-NOW.md is generated with a do-not-edit header', () => {
    const p = join(tmp(), 'OP', 'WORLD-NOW.md');
    writeWorldNow(p, '## WORLD — x', NOW);
    expect(readFileSync(p, 'utf8')).toBe('<!-- generated by `eln op world --write` at 2026-11-25T17:30:00.000Z — do not edit by hand; record coach actions with `eln coach act` -->\n## WORLD — x\n');
  });
});

describe('synthetic event seeds', () => {
  const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const seed of [1, 2, 3, 7]) {
    test(`seed ${seed}: random facts/events → ≤40 lines, header first, OP flag iff OP holds`, () => {
      const r = rng(seed);
      const owners = ['OP', 'TC', 'UX', 'MK', 'JUD', ''];
      const statuses = ['green', 'yellow', 'red', 'done'];
      const items = Array.from({ length: Math.floor(r() * 120) }, () => ({ status: statuses[Math.floor(r() * 4)]!, owner: owners[Math.floor(r() * 6)]!, updatedAt: new Date(NOW.getTime() - r() * 7_200_000).toISOString() }));
      const { board } = boardOf(items, NOW);
      const rows = Array.from({ length: Math.floor(r() * 60) }, (_, i) => act(i, new Date(NOW.getTime() - r() * 172_800_000).toISOString())).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const pick = <T>(v: T): T | null => (r() < 0.3 ? null : v);
      const f: WorldFacts = {
        release: pick({ version: '0.3.36', source: 'plan', cutAt: '2026-11-25T19:00:00.000Z', publishAt: '2026-11-25T21:00:00.000Z', published: r() < 0.2 }),
        board: pick(board), graph: pick({ mode: 'live', hardStop: r() < 0.5 ? 'x'.repeat(300) : null, done: false }),
        org: pick({ source: 'federation.yaml roles', lines: Array.from({ length: 10 }, (_, i) => `line ${i} ${'y'.repeat(400)}`) }),
        rate: pick({ landed1h: Math.floor(r() * 20), green1h: null }), handsOpen: pick(Math.floor(r() * 9)),
        coach: pick(coachDelta(rows, { lastId: rows[Math.floor(r() * Math.max(1, rows.length))]?.id ?? null, lastAt: null })),
      };
      const text = renderWorldBlock(f, NOW, KST);
      const lines = text.split('\n');
      expect(lines.length).toBeLessThanOrEqual(40);
      expect(lines[0]!.startsWith('## WORLD')).toBe(true);
      const opHeld = f.board ? items.filter(i => i.owner === 'OP' && i.status !== 'green' && i.status !== 'done').length : 0;
      expect(text.includes('⚠ OP holds')).toBe(opHeld > 0);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(400);
    });
  }
});
