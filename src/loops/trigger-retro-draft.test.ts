// OP-RETRO-STRUCTURAL — the op-retro graph writes the measured half itself and opens ONE retro turn (not a wake).
// Expectations are literals written here (rule 11): section headings, ledger path and prompt words are spelled out,
// never rebuilt from the product's own helpers.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { retroDraft } from './trigger-nodes.js';
import { appendDiverted, pendingDiverted, type DivertedEntry } from '../msg/diverted-mail.js';
import { createSelfWakeCoachFeed } from '../tui/self-wake-coach-feed.js';

const REPO = resolve(import.meta.dir, '../..');
const WINDOW = '2026-11-25T10:16:00.000Z';
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'retro-draft-')); mkdirSync(join(dir, 'seat', 'OP', 'retro'), { recursive: true }); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function ctx(stage: 'live' | 'shadow', measuresList: unknown[] = [{ label: '착지 1h', cmd: ['echo', '9'] }]) {
  return {
    graphId: 'op-retro', runId: 'run-x',
    input: { stage, window: WINDOW, attempt: 1, shadowDir: join(dir, 'shadow'), vars: { stateRoot: join(dir, 'state'), seatState: join(dir, 'seat') } },
    nodeInput: { seat: 'OP', file: '{seatState}/OP/retro/ELN-OP-RETRO-20261125.md', measures: measuresList },
  };
}
const fixed = () => new Date('2026-11-25T10:16:30.000Z');

describe('retro-draft node', () => {
  test('live: appends the measured draft once and queues exactly one retro turn', () => {
    const queued: DivertedEntry[] = [];
    const ran: string[][] = [];
    const out = retroDraft(ctx('live', [
      { label: '착지 1h', cmd: ['probe', '{seatState}/x'] },
      { label: '우편 1h', cmd: ['probe-fail'] },
    ]), {
      now: fixed,
      run: (cmd) => { ran.push(cmd); return cmd[0] === 'probe' ? { status: 0, stdout: '11\n', stderr: '' } : { status: 3, stdout: '', stderr: 'jq: boom\n' }; },
      enqueueTurn: (e) => queued.push(e),
    });
    expect(out).toMatchObject({ outcome: 'ok', drafted: true, shadow: false });
    expect(ran[0]).toEqual(['probe', join(dir, 'seat', 'x')]);
    const text = readFileSync(join(dir, 'seat', 'OP', 'retro', 'ELN-OP-RETRO-20261125.md'), 'utf8');
    expect(text).toContain('<!-- op-retro window=2026-11-25T10:16:00.000Z -->');
    expect(text).toContain('- 착지 1h: 11');
    expect(text).toContain('- 우편 1h: (측정 실패 · exit 3 · jq: boom)');
    expect(text).toContain('- 원인 가설: ');
    expect(text).toContain('- 다음 손잡이: ');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ seat: 'OP', from: 'graph:op-retro', kind: 'retro' });
    expect(queued[0]!.body).toContain('원인 가설');
    expect(queued[0]!.body).toContain('다음 손잡이');
    // second attempt in the same window: no duplicate section, no second turn
    const again = retroDraft(ctx('live'), { now: fixed, run: () => ({ status: 0, stdout: '1', stderr: '' }), enqueueTurn: (e) => queued.push(e) });
    expect(again).toMatchObject({ outcome: 'ok', drafted: false });
    expect(readFileSync(join(dir, 'seat', 'OP', 'retro', 'ELN-OP-RETRO-20261125.md'), 'utf8').split('op-retro window=').length).toBe(2);
    expect(queued).toHaveLength(1);
  });

  test('shadow: writes the draft (goal file updated) but only a receipt of the turn', () => {
    const queued: DivertedEntry[] = [];
    const out = retroDraft(ctx('shadow'), { now: fixed, run: () => ({ status: 0, stdout: '9', stderr: '' }), enqueueTurn: (e) => queued.push(e) });
    expect(out).toMatchObject({ outcome: 'ok', drafted: true, shadow: true });
    expect(queued).toHaveLength(0);
    const receipt = JSON.parse(readFileSync(join(dir, 'shadow', '2026-11-25T10_16_00.000Z.json'), 'utf8')) as { wouldOpenTurn: { kind: string } };
    expect(receipt.wouldOpenTurn.kind).toBe('retro');
    expect(existsSync(join(dir, 'seat', 'OP', 'retro', 'ELN-OP-RETRO-20261125.md'))).toBe(true);
  });

  test('a failed enqueue is a node failure (the trigger retries), the draft stays', () => {
    const out = retroDraft(ctx('live'), { now: fixed, run: () => ({ status: 0, stdout: '9', stderr: '' }), enqueueTurn: () => { throw new Error('disk full'); } });
    expect(out).toMatchObject({ outcome: 'fail', drafted: true });
    expect(String(out.error)).toContain('disk full');
  });

  test('op-pulse carries the retro node (op-retro absorbed 11-26): after the pulse step, hourly, with the four measures', () => {
    const graph = parseYaml(readFileSync(join(REPO, 'graphs/triggers/op-pulse.yaml'), 'utf8')) as { entry_node: string; nodes: { node_id: string; recipe?: string; input?: { every?: string; measures?: { label: string }[] } }[];
      edges: { from: string; map: Record<string, string> }[] };
    expect(graph.entry_node).toBe('measure');
    const node = graph.nodes.find((n) => n.node_id === 'retro')!;
    expect(node.recipe).toBe('cmd:trigger-retro-draft');
    expect(node.input!.every).toBe('hour');
    expect(node.input!.measures!.map((m) => m.label)).toEqual(['6능력·바탕(op-eval)', '착지 1h(main first-parent)', '초록(현재 판 칸)', '우편 1h(OP 받음·보냄)']);
    const edge = (from: string) => graph.edges.find((e) => e.from === from)!.map;
    expect(edge('measure')).toEqual({ turn: 'turn', green: 'retro', fail: 'failed', error: 'failed' });
    expect(edge('turn')).toEqual({ ok: 'retro', fail: 'failed', error: 'failed' });
    // a retro failure never fails the pulse (the pulse goal is its own ledger line)
    expect(edge('retro')).toEqual({ ok: 'done', fail: 'done', error: 'done' });
    const recipes = parseYaml(readFileSync(join(REPO, 'graphs/triggers/recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
    expect(recipes['trigger-retro-draft']!.command).toContain('trigger-nodes.ts" retro-draft');
  });

  for (const seed of [1, 2, 3]) {
    test(`SIM seed ${seed}: every: hour — pulses at 15-min cadence draft one retro per clock hour, one retro turn each`, () => {
      const queued: DivertedEntry[] = [];
      // KST 19:0x → 20:5x, pulses every 15 min starting at a seed-shifted minute; windows are the pulse fire minutes
      const startMs = Date.parse('2026-11-26T10:00:00.000Z') + seed * 4 * 60_000;
      for (let i = 0; i < 8; i++) {
        const at = new Date(startMs + i * 15 * 60_000);
        const c = { graphId: 'op-pulse', runId: `p${i}`,
          input: { stage: 'live' as const, window: at.toISOString(), attempt: 1, shadowDir: join(dir, 'shadow'), vars: { stateRoot: join(dir, 'state'), seatState: join(dir, 'seat') } },
          nodeInput: { seat: 'OP', every: 'hour', file: '{seatState}/OP/retro/ELN-OP-RETRO-hourly.md', measures: [{ label: '착지 1h', cmd: ['echo', '9'] }] } };
        retroDraft(c, { now: () => new Date(at.getTime() + 20_000), run: () => ({ status: 0, stdout: `${i}`, stderr: '' }), enqueueTurn: (e) => queued.push(e) });
      }
      const text = readFileSync(join(dir, 'seat', 'OP', 'retro', 'ELN-OP-RETRO-hourly.md'), 'utf8');
      const hours = [...text.matchAll(/<!-- op-retro hour=([^ ]+) -->/g)].map((m) => m[1]);
      // 8 pulses × 15 min starting 19:04–19:12 KST span two clock hours (19 and 20) → exactly two drafts and two turns.
      // (the hour key follows the host clock zone; two distinct keys whatever the zone)
      expect(hours).toHaveLength(2);
      expect(new Set(hours).size).toBe(2);
      expect(queued).toHaveLength(2);
      expect(text).not.toContain('op-retro window=');
    });
  }
});

describe('TUI feed opens the retro turn through the internal-turn door, never the wake scheduler', () => {
  const entry = (at: string): DivertedEntry => ({ seat: 'OP', from: 'graph:op-retro', kind: 'retro', body: 'RETRO-PROMPT', at });

  test('refused while busy → kept; opened when idle → taken; the wake scheduler is never used', () => {
    const root = join(dir, 'diverted');
    appendDiverted('retro-turn', entry('2026-11-25T10:16:30.000Z'), root);
    let now = Date.parse('2026-11-25T10:17:00.000Z');
    let idle = false;
    const opened: string[] = [];
    const armed: string[] = [];
    const feed = createSelfWakeCoachFeed({ seat: 'OP', root, now: () => now, log: () => {}, enqueuePassive: () => {},
      schedule: (reason) => { armed.push(reason); return true; },
      openRetroTurn: (prompt) => { if (!idle) return false; opened.push(prompt); return true; } });
    expect(feed.tick()).toEqual({ wakes: 0, coach: 0, folded: 0, retro: 0 });
    expect(pendingDiverted('retro-turn', 'OP', root)).toHaveLength(1);
    idle = true; now += 30_000;
    expect(feed.tick()).toEqual({ wakes: 0, coach: 0, folded: 0, retro: 1 });
    expect(opened).toEqual(['RETRO-PROMPT']);
    expect(armed).toEqual([]);
    expect(pendingDiverted('retro-turn', 'OP', root)).toHaveLength(0);
  });

  test('two queued retro turns open one per tick; one older than 90 min is dropped with a line', () => {
    const root = join(dir, 'diverted');
    appendDiverted('retro-turn', entry('2026-11-25T08:00:00.000Z'), root);
    appendDiverted('retro-turn', entry('2026-11-25T10:16:00.000Z'), root);
    appendDiverted('retro-turn', entry('2026-11-25T10:17:00.000Z'), root);
    const passive: string[] = [];
    const opened: string[] = [];
    const feed = createSelfWakeCoachFeed({ seat: 'OP', root, now: () => Date.parse('2026-11-25T10:18:00.000Z'), log: () => {},
      enqueuePassive: (l) => passive.push(l), schedule: () => true, openRetroTurn: (p) => { opened.push(p); return true; } });
    expect(feed.tick().retro).toBe(1);
    expect(opened).toHaveLength(1);
    expect(passive.join('\n')).toContain('dropped 1 graph retro turns');
    expect(pendingDiverted('retro-turn', 'OP', root)).toHaveLength(1);
    expect(feed.tick().retro).toBe(1);
    expect(pendingDiverted('retro-turn', 'OP', root)).toHaveLength(0);
  });

  test('a TUI without the retro door leaves the ledger untouched', () => {
    const root = join(dir, 'diverted');
    appendDiverted('retro-turn', entry('2026-11-25T10:16:00.000Z'), root);
    const feed = createSelfWakeCoachFeed({ seat: 'OP', root, now: () => Date.parse('2026-11-25T10:17:00.000Z'), log: () => {}, enqueuePassive: () => {}, schedule: () => true });
    expect(feed.tick().retro).toBe(0);
    expect(pendingDiverted('retro-turn', 'OP', root)).toHaveLength(1);
    writeFileSync(join(dir, 'unused'), '');
  });
});
