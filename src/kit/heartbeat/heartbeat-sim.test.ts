// WATCHER-HEARTBEAT sim — the three silent failures of 11-25 replayed as beats (expected values are literals).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTriggerDecl } from '../../loops/trigger-registry.js';
import { runWatchCheck } from '../../cli/watch-cli.js';
import { alertStep, appendBeat, judgeWatchers, makeBeat, readBeats, watchersBoardLine, type Beat } from './index.js';

const T0 = Date.parse('2026-11-25T11:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const beat = (name: string, min: number, extra: Partial<Beat> = {}): Beat => ({ name, at: at(min).toISOString(), saw: 1, everyMin: 5, ...extra });
const msgHead = (head: number) => (source: string) => (source === 'msg' ? head : null);

describe('judgeWatchers', () => {
  test('DEAD: no beat for more than 2x cadence', () => {
    const v = judgeWatchers([beat('op-watchdog', 0)], at(11), msgHead(165990));
    expect(v[0]!.status).toBe('DEAD');
    expect(v[0]!.reason).toBe('no beat for 11m (cadence 5m)');
  });
  test('not DEAD at exactly 2x cadence', () => {
    expect(judgeWatchers([beat('op-watchdog', 0)], at(10))[0]!.status).toBe('OK');
  });
  test('BLIND: start id ahead of the source (166000 while ids are 1659xx)', () => {
    const beats = [0, 1, 2].map(m => beat('claude-op-urgent', m, { saw: 0, last: '166000', source: 'msg', everyMin: 1 }));
    const v = judgeWatchers(beats, at(2.5), msgHead(165987));
    expect(v[0]!.status).toBe('BLIND');
    expect(v[0]!.reason).toBe('cursor 166000 is ahead of source msg head 165987');
  });
  test('BLIND: saw 0 for 3 windows while the source moved past the cursor', () => {
    const beats = [0, 5, 10].map(m => beat('seat-inbox', m, { saw: 0, last: '165900', source: 'msg' }));
    expect(judgeWatchers(beats, at(11), msgHead(165950))[0]!.status).toBe('BLIND');
  });
  test('quiet source is not BLIND: saw 0 and source head equals the cursor', () => {
    const beats = [0, 5, 10].map(m => beat('seat-inbox', m, { saw: 0, last: '165950', source: 'msg' }));
    expect(judgeWatchers(beats, at(11), msgHead(165950))[0]!.status).toBe('OK');
  });
  test('BROKEN: three errored beats in a row', () => {
    const beats = [0, 5, 10].map(m => beat('op-watchdog-retro', m, { err: 'msg post exit 1: unknown recipient' }));
    const v = judgeWatchers(beats, at(11));
    expect(v[0]!.status).toBe('BROKEN');
    expect(v[0]!.lastError).toBe('msg post exit 1: unknown recipient');
  });
  test('one error then recovery is OK', () => {
    const beats = [beat('w', 0, { err: 'x' }), beat('w', 5, { err: 'x' }), beat('w', 10)];
    expect(judgeWatchers(beats, at(11))[0]!.status).toBe('OK');
  });
});

describe('alerts and board', () => {
  test('card once per status change, repeat after 60 min', () => {
    const dead = judgeWatchers([beat('guardian-patrol', 0)], at(30));
    const first = alertStep({}, dead, at(30));
    expect(first.card).toBe('[감시자 감시 · watch-the-watchers] 1건\n· DEAD guardian-patrol — no beat for 30m (cadence 5m)\n(eln watch status 로 전체 확인)');
    expect(alertStep(first.next, dead, at(35)).card).toBe(null);
    expect(alertStep(first.next, dead, at(91)).card).not.toBe(null);
  });
  test('board line names the bad watchers', () => {
    const v = judgeWatchers([beat('a', 0), beat('b', 29)], at(30));
    expect(watchersBoardLine(v)).toBe('👁 Watchers — 1 ok · 1 bad: DEAD a 30m');
    expect(watchersBoardLine([])).toBe(null);
  });
});

describe('sim: check pass over a ledger with dead, blind, broken watchers', () => {
  test('one card, failed post retries and beats BROKEN-able error for the checker itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-sim-'));
    const ledger = join(dir, 'beats.jsonl'); const state = join(dir, 'alerts.json');
    appendBeat(makeBeat({ name: 'op-watchdog', saw: 2 }, at(0)), ledger);
    for (const m of [26, 27, 28]) appendBeat(makeBeat({ name: 'claude-op-urgent', saw: 0, last: '166000', source: 'msg', everyMin: 1 }, at(m)), ledger);
    for (const m of [20, 25, 28]) appendBeat(makeBeat({ name: 'res-patrol', saw: 0, err: 'ENOENT /tmp/patrol' }, at(m)), ledger);
    const posts: string[][] = [];
    const deps = { ledger, alertState: state, now: () => at(29), sourceHead: msgHead(165990), post: (a: string[]) => { posts.push(a); return { status: 1, stderr: 'boom' }; } };
    const failed = runWatchCheck(deps);
    expect(failed.verdicts.map(v => `${v.status} ${v.name}`)).toEqual(['BLIND claude-op-urgent', 'DEAD op-watchdog', 'BROKEN res-patrol']);
    expect(failed.error).toBe('msg post exit 1: boom');
    expect(existsSync(state)).toBe(false);
    expect(posts[0]!.slice(0, 6)).toEqual(['msg', 'post', '--from', 'OP', '--to', 'CLAUDE-OP']);
    const self = readBeats(ledger).filter(b => b.name === 'watchers-check');
    expect(self[0]!.err).toBe('msg post exit 1: boom');
    const ok = runWatchCheck({ ...deps, post: (a: string[]) => { posts.push(a); return { status: 0, stderr: '' }; } });
    expect(ok.posted).toBe(true);
    expect(JSON.parse(readFileSync(state, 'utf8'))['res-patrol'].status).toBe('BROKEN');
    expect(runWatchCheck(deps).card).toBe(null);
    expect(posts.length).toBe(2);
  });
  test('malformed ledger lines are skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-sim-'));
    const ledger = join(dir, 'beats.jsonl');
    writeFileSync(ledger, 'not json\n{"name":"x","at":"2026-11-25T11:00:00.000Z","saw":0,"everyMin":5}\n');
    expect(readBeats(ledger).length).toBe(1);
  });
  test('watchers-check graph declares a 5-min cron trigger', () => {
    const decl = readTriggerDecl('graphs/triggers/watchers-check.yaml', join(import.meta.dir, '..', '..', '..'));
    expect(decl.cron).toBe('*/5 * * * *');
    expect(decl.owner).toBe('OP');
  });
  test('invalid name refused', () => {
    expect(() => makeBeat({ name: '../x', saw: 0 }, at(0))).toThrow('invalid watcher name');
  });
});
