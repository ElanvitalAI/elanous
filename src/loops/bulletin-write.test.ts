// BULLETIN-NOW-STALE — the op-bulletin graph writes the facts itself, mails the coordinators, and opens ONE OP turn.
// Expectations are literals written here (rule 11): headings, paths, recipient names and prompt words are spelled out,
// never rebuilt from the product's own helpers.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { bulletinWrite, orgCoordinators, type BulletinFacts } from './bulletin-write.js';
import { DEFAULT_ORG } from '../org/org-map.js';
import type { DivertedEntry } from '../msg/diverted-mail.js';

const REPO = resolve(import.meta.dir, '../..');
const WINDOW = '2026-11-26T09:22:00.000Z';
// 대표 11-26: REL and RES are loop agents (no conversational inbox) — the four conversational coordinators.
const COORDINATORS = ['TC', 'MK', 'UX', 'JUD'];
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bulletin-write-')); mkdirSync(join(dir, 'seat', 'OPS'), { recursive: true }); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function ctx(stage: 'live' | 'shadow', window = WINDOW, reason?: string) {
  return {
    graphId: 'op-bulletin', runId: 'run-b',
    input: { stage, window, attempt: 1, shadowDir: join(dir, 'shadow'), vars: { stateRoot: join(dir, 'state'), seatState: join(dir, 'seat') }, ...(reason ? { reason } : {}) },
    nodeInput: { from: 'OP', file: '{seatState}/OPS/BULLETIN-NOW.md', log: '{seatState}/OPS/BULLETIN-LOG.md' },
  };
}
const facts = (landed: number | null, over: Partial<BulletinFacts> = {}) => async (): Promise<BulletinFacts> =>
  ({ phase: 'demo-freeze', landedTotal: landed, idleSeats: ['MK', 'UX'], handsUp: 4, ...over });
const fixed = () => new Date('2026-11-26T09:22:30.000Z');
const NOW_FILE = () => join(dir, 'seat', 'OPS', 'BULLETIN-NOW.md');

describe('bulletin-write node', () => {
  test('live: rewrites BULLETIN-NOW (old one → log), mails the four coordinators kind bulletin, queues one OP turn', async () => {
    writeFileSync(NOW_FILE(), 'OLD BULLETIN 07:09\n');
    const posts: string[][] = [];
    const turns: DivertedEntry[] = [];
    const out = await bulletinWrite(ctx('live', WINDOW, 'condition: landed=10 idle=MK,UX hands=4'), {
      now: fixed, facts: facts(31000), recipients: () => COORDINATORS,
      post: (args) => { posts.push(args); return { status: 0, stdout: 'ok', stderr: '' }; },
      enqueueTurn: (e) => turns.push(e),
    });
    expect(out).toMatchObject({ outcome: 'ok', wrote: true, shadow: false, turn: 'queued' });
    const text = readFileSync(NOW_FILE(), 'utf8');
    expect(text).toContain('<!-- op-bulletin window=2026-11-26T09:22:00.000Z -->');
    expect(text).toContain('- 국면: demo-freeze');
    expect(text).toContain('- 착지: main 총 31000 (직전 공보 기준 없음)');
    expect(text).toContain('- 유휴 자리: MK, UX (2)');
    expect(text).toContain('- ✋ OP 미읽음: 4');
    expect(text).toContain('- 이번 공보 계기: condition: landed=10 idle=MK,UX hands=4');
    expect(text).toContain('- 병목 판단: ');
    expect(text).toContain('- 다음 지시: ');
    expect(readFileSync(join(dir, 'seat', 'OPS', 'BULLETIN-LOG.md'), 'utf8')).toContain('OLD BULLETIN 07:09');
    expect(posts.map((a) => a[a.indexOf('--to') + 1])).toEqual(['TC', 'MK', 'UX', 'JUD']);
    for (const a of posts) {
      expect(a.slice(0, 2)).toEqual(['msg', 'post']);
      expect(a[a.indexOf('--from') + 1]).toBe('OP');
      expect(a[a.indexOf('--kind') + 1]).toBe('bulletin');
      expect(a[a.indexOf('--body') + 1]).toContain('- 유휴 자리: MK, UX (2)');
    }
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ seat: 'OP', from: 'graph:op-bulletin', kind: 'bulletin' });
    expect(turns[0]!.body).toContain('병목 판단');
    expect(turns[0]!.body).toContain('다음 지시');
  });

  test('the next window reports landed since the previous bulletin', async () => {
    const deps = { now: fixed, recipients: () => ['TC'], post: () => ({ status: 0, stdout: '', stderr: '' }), enqueueTurn: () => {} };
    await bulletinWrite(ctx('live'), { ...deps, facts: facts(100) });
    await bulletinWrite(ctx('live', '2026-11-26T09:52:00.000Z'), { ...deps, facts: facts(107) });
    expect(readFileSync(NOW_FILE(), 'utf8')).toContain('- 착지: +7 (직전 공보 2026-11-26T09:22:00.000Z 이후 · main 총 107)');
    expect(readFileSync(join(dir, 'seat', 'OPS', 'BULLETIN-LOG.md'), 'utf8')).toContain('op-bulletin window=2026-11-26T09:22:00.000Z');
  });

  test('a failed probe is written as «측정 실패», the bulletin still exists', async () => {
    await bulletinWrite(ctx('live'), { now: fixed, facts: facts(null, { phase: null, idleSeats: null, handsUp: null }), recipients: () => [],
      post: () => ({ status: 0, stdout: '', stderr: '' }), enqueueTurn: () => {} });
    const text = readFileSync(NOW_FILE(), 'utf8');
    expect(text).toContain('- 국면: (측정 실패 · op-pulse 상태)');
    expect(text).toContain('- 착지: (측정 실패 · main 커밋 수)');
    expect(text).toContain('- 유휴 자리: (측정 실패 · els ls)');
    expect(text).toContain('- ✋ OP 미읽음: (측정 실패 · 우편 원장)');
  });

  // OP-OBSERVE-LANDED (11-27 22:39 live): «착지: +0 (… main 총 0)» while 8 PRs had landed — 0 was a broken read.
  test('a main total of 0 is «측정 실패», never «main 총 0», and is not stored as the next baseline', async () => {
    const deps = { now: fixed, recipients: () => ['TC'], post: () => ({ status: 0, stdout: '', stderr: '' }), enqueueTurn: () => {} };
    await bulletinWrite(ctx('live'), { ...deps, facts: facts(0) });
    const text = readFileSync(NOW_FILE(), 'utf8');
    expect(text).toContain('- 착지: (측정 실패 · main 커밋 수)');
    expect(text).not.toContain('main 총 0');
    expect(existsSync(join(dir, 'state', 'loops', 'op-bulletin-state.json'))).toBe(false);
  });

  test('a poisoned baseline (stored 0 by the old bug) is no baseline — the next real total is not «+40000»', async () => {
    mkdirSync(join(dir, 'state', 'loops'), { recursive: true });
    writeFileSync(join(dir, 'state', 'loops', 'op-bulletin-state.json'), '{"window":"2026-11-26T08:52:00.000Z","landedTotal":0}\n');
    const deps = { now: fixed, recipients: () => ['TC'], post: () => ({ status: 0, stdout: '', stderr: '' }), enqueueTurn: () => {} };
    await bulletinWrite(ctx('live'), { ...deps, facts: facts(40123) });
    expect(readFileSync(NOW_FILE(), 'utf8')).toContain('- 착지: main 총 40123 (직전 공보 기준 없음)');
    expect(readFileSync(join(dir, 'state', 'loops', 'op-bulletin-state.json'), 'utf8')).toContain('"landedTotal":40123');
  });

  test('retry in the same window: no rewrite, re-sends only the failed recipient, no second turn', async () => {
    const posts: string[] = [];
    const turns: DivertedEntry[] = [];
    let jdDown = true;
    const deps = { now: fixed, facts: facts(5), recipients: () => ['TC', 'JUD', 'UX'], enqueueTurn: (e: DivertedEntry) => turns.push(e),
      post: (a: string[]) => { const to = a[a.indexOf('--to') + 1]!; posts.push(to); return to === 'JUD' && jdDown ? { status: 1, stdout: '', stderr: 'db locked' } : { status: 0, stdout: '', stderr: '' }; } };
    const first = await bulletinWrite(ctx('live'), deps);
    expect(first).toMatchObject({ outcome: 'fail', wrote: true, failed: ['JUD'] });
    expect(String(first.error)).toContain('msg post failed for JUD');
    const before = readFileSync(NOW_FILE(), 'utf8');
    jdDown = false;
    const second = await bulletinWrite(ctx('live'), deps);
    expect(second).toMatchObject({ outcome: 'ok', wrote: false, sent: ['JUD'] });
    expect(readFileSync(NOW_FILE(), 'utf8')).toBe(before);
    expect(posts).toEqual(['TC', 'JUD', 'UX', 'JUD']);
    expect(turns).toHaveLength(1);
  });

  test('a failed turn enqueue is a node failure; the retry queues the turn without re-mailing', async () => {
    const posts: string[] = [];
    let broken = true;
    const turns: DivertedEntry[] = [];
    const deps = { now: fixed, facts: facts(5), recipients: () => ['TC'],
      post: (a: string[]) => { posts.push(a[a.indexOf('--to') + 1]!); return { status: 0, stdout: '', stderr: '' }; },
      enqueueTurn: (e: DivertedEntry) => { if (broken) throw new Error('disk full'); turns.push(e); } };
    const first = await bulletinWrite(ctx('live'), deps);
    expect(first).toMatchObject({ outcome: 'fail' });
    expect(String(first.error)).toContain('turn enqueue failed: disk full');
    broken = false;
    expect(await bulletinWrite(ctx('live'), deps)).toMatchObject({ outcome: 'ok' });
    expect(posts).toEqual(['TC']);
    expect(turns).toHaveLength(1);
  });

  test('shadow: writes the file (goal holds) but only a receipt of the mails and the turn', async () => {
    const posts: string[][] = [];
    const out = await bulletinWrite(ctx('shadow'), { now: fixed, facts: facts(9), recipients: () => COORDINATORS, post: (a) => { posts.push(a); return { status: 0, stdout: '', stderr: '' }; }, enqueueTurn: () => { throw new Error('no'); } });
    expect(out).toMatchObject({ outcome: 'ok', shadow: true });
    expect(posts).toHaveLength(0);
    expect(existsSync(NOW_FILE())).toBe(true);
    const receipt = JSON.parse(readFileSync(join(dir, 'shadow', '2026-11-26T09_22_00.000Z.json'), 'utf8')) as { wouldPost: { from: string; to: string[]; kind: string }; wouldOpenTurn: { kind: string } };
    expect(receipt.wouldPost).toEqual({ from: 'OP', to: ['TC', 'MK', 'UX', 'JUD'], kind: 'bulletin' });
    expect(receipt.wouldOpenTurn.kind).toBe('bulletin');
  });

  test('coordinators = conversational space leaders under HQ (loop-agent stewards REL · RES skipped)', () => {
    expect(orgCoordinators(DEFAULT_ORG)).toEqual(['TC', 'MK', 'UX', 'JUD']);
    // a seat that becomes a loop agent drops out; one that stops being one comes back — derived, not listed
    const seats = { ...DEFAULT_ORG.seats, MK: { role: 'steward' as const }, REL: { role: 'leader' as const } };
    expect(orgCoordinators({ ...DEFAULT_ORG, seats })).toEqual(['TC', 'UX', 'JUD', 'REL']);
  });

  test('the op-bulletin graph enters at the write node; the recipe runs trigger-nodes bulletin-write', () => {
    const graph = parseYaml(readFileSync(join(REPO, 'graphs/triggers/op-bulletin.yaml'), 'utf8')) as { entry_node: string; loop: { goal: { kind: string; path: string } }; nodes: { node_id: string; recipe?: string }[] };
    expect(graph.entry_node).toBe('write');
    expect(graph.nodes.find((n) => n.node_id === 'write')!.recipe).toBe('cmd:trigger-bulletin-write');
    expect(graph.nodes.some((n) => n.recipe === 'cmd:trigger-wake')).toBe(false);
    expect(graph.loop.goal).toEqual({ kind: 'file-mtime', path: '{seatState}/OPS/BULLETIN-NOW.md' });
    const recipes = parseYaml(readFileSync(join(REPO, 'graphs/triggers/recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
    expect(recipes['trigger-bulletin-write']!.command).toContain('trigger-nodes.ts" bulletin-write');
  });
});
