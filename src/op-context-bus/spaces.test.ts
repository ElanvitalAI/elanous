// CONTEXT-BUS-FEDERATION — seat → spaces · L0 space · reader probe · per-space rollup readers · key dedupe (literal expectations).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ORG, mergeOrg } from '../org/org-map.js';
import { busAck, busPost, readBus } from './bus.js';
import { busKnownSpace, busL0Space, busOwnSpace, busReaderSeen, busSpacesForSeat } from './spaces.js';
import { loadBusDigestPolicy, parseBusDigestPolicy, seatBusDigests } from './seat-turn.js';

const T0 = Date.parse('2026-11-28T09:00:00.000Z');
const DAY = 86_400_000; // 출처: #40640 graphs/loop-agents/guardian/agent.yaml bus_reader_window_h 24 — the caller passes the policy window
const tmp = () => mkdtempSync(join(tmpdir(), 'bus-spaces-'));

describe('busSpacesForSeat (DEFAULT_ORG)', () => {
  test('OP reads OP and HQ in full', () => {
    expect(busSpacesForSeat('OP', DEFAULT_ORG)).toEqual([{ space: 'OP', view: 'full' }, { space: 'HQ', view: 'full' }]);
  });
  test('a space leader reads its own space and HQ in full, OP addressed only', () => {
    for (const s of ['TC', 'UX', 'MK', 'JUD']) expect(busSpacesForSeat(s.toLowerCase(), DEFAULT_ORG)).toEqual([{ space: s, view: 'full' }, { space: 'HQ', view: 'full' }, { space: 'OP', view: 'addressed' }]);
  });
  test('a loop-agent kingdom and a hand never read HQ', () => {
    expect(busSpacesForSeat('RES', DEFAULT_ORG)).toEqual([{ space: 'RES', view: 'full' }, { space: 'OP', view: 'addressed' }]);
    expect(busSpacesForSeat('TC-1', DEFAULT_ORG)).toEqual([{ space: 'TC-1', view: 'full' }, { space: 'OP', view: 'addressed' }]);
  });
  test('the declaration decides: a new space leader reads HQ', () => {
    const org = mergeOrg({ seats: { OPS2: { role: 'leader' } }, spaces: { ops2: { leader: 'OPS2' } } }).org;
    expect(busSpacesForSeat('OPS2', org).map((s) => s.space)).toEqual(['OPS2', 'HQ', 'OP']);
  });
  test('CLAUDE-OP writes and reads OP', () => { expect(busOwnSpace('claude-op')).toBe('OP'); });
});

describe('busL0Space · busKnownSpace', () => {
  test('a conversational seat is its own space; RES/REL (stewards) climb to OP', () => {
    expect(busL0Space('OP', DEFAULT_ORG)).toBe('OP');
    expect(busL0Space('TC', DEFAULT_ORG)).toBe('TC');
    expect(busL0Space('RES', DEFAULT_ORG)).toBe('OP');
    expect(busL0Space('REL', DEFAULT_ORG)).toBe('OP');
    expect(busL0Space('CEO', DEFAULT_ORG)).toBe('OP');
  });
  test('typo spaces are unknown; HQ, seats and the writer\'s own space are known', () => {
    expect(busKnownSpace('HQ', DEFAULT_ORG)).toBe(true);
    expect(busKnownSpace('jud', DEFAULT_ORG)).toBe(true);
    expect(busKnownSpace('TCC', DEFAULT_ORG)).toBe(false);
    expect(busKnownSpace('TC-1', DEFAULT_ORG, 'TC-1')).toBe(true);
  });
});

describe('bus storage per space', () => {
  test('busReaderSeen = an ack within the window', () => {
    const root = tmp();
    try {
      const r = busPost(root, { type: 'status', from: 'OP', body: 'x' }, { space: 'TC', now: T0 });
      expect(busReaderSeen(root, 'TC', ['TC', 'OP'], T0, DAY)).toBe(false);
      busAck(root, r.kind === 'posted' ? r.entry.id : '', 'TC', { space: 'TC', now: T0 });
      expect(busReaderSeen(root, 'TC', ['TC', 'OP'], T0 + 3_600_000, DAY)).toBe(true);
      expect(busReaderSeen(root, 'TC', ['OP'], T0 + 3_600_000, DAY)).toBe(false);
      expect(busReaderSeen(root, 'TC', ['TC', 'OP'], T0 + 25 * 3_600_000, DAY)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('a key posted twice is one row (duplicate)', () => {
    const root = tmp();
    try {
      const a = busPost(root, { type: 'status', from: 'GUARDIAN', body: 'digest', key: 'guardian-digest:1' }, { space: 'OP', now: T0 });
      const b = busPost(root, { type: 'status', from: 'GUARDIAN', body: 'digest again', key: 'guardian-digest:1' }, { space: 'OP', now: T0 + 1 });
      expect(a.kind).toBe('posted');
      expect(b.kind).toBe('duplicate');
      expect(readBus(root, 'OP').length).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('a non-OP space folds old status rows once its ackers have seen them', () => {
    const root = tmp();
    try {
      const day1 = Date.parse('2026-11-27T10:00:00.000Z');
      let last = '';
      for (let i = 0; i < 6; i++) { const r = busPost(root, { type: 'status', from: 'TC', body: `s${i}` }, { space: 'TC', now: day1 + i, maxLines: 1000 }); if (r.kind === 'posted') last = r.entry.id; }
      busAck(root, last, 'TC', { space: 'TC', now: day1 + 10 });
      busPost(root, { type: 'decision', from: 'TC', body: 'keep' }, { space: 'TC', now: T0, maxLines: 3 });
      const items = readBus(root, 'TC');
      expect(items.map((i) => i.type)).toEqual(['rollup', 'decision']);
      expect(items[0]!.body.startsWith('6 status/opinion rows on 2026-11-27:')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('seatBusDigests', () => {
  test('one block per space with content, own space first; each block acks its own space', () => {
    const root = tmp();
    try {
      busPost(root, { type: 'decision', from: 'UX', body: 'HQ: surface contract v2 first' }, { space: 'HQ', now: T0 });
      busPost(root, { type: 'handoff', from: 'CLAUDE-OP', body: 'TC: fix the landing line', owner: 'TC' }, { space: 'OP', now: T0 });
      busPost(root, { type: 'status', from: 'TC-1', body: 'TC space: hand note' }, { space: 'TC', now: T0 });
      const d = seatBusDigests(root, { seat: 'TC', now: T0, spaces: busSpacesForSeat('TC', DEFAULT_ORG) });
      expect(d.blocks.map((b) => b.space)).toEqual(['TC', 'HQ', 'OP']);
      const heads = (d.text ?? '').split('\n').filter((l) => l.startsWith('<op_context_bus'));
      expect(heads).toEqual(['<op_context_bus space="TC" seat="TC" new="1">', '<op_context_bus space="HQ" seat="TC" new="1">', '<op_context_bus space="OP" seat="TC" new="1">']);
      expect(d.text).toContain('decision UX: HQ: surface contract v2 first');
      expect(d.text).toContain('handoff CLAUDE-OP: TC: fix the landing line');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('digest bounds pack (graphs/policies/context-bus.yaml · YAML-FIRST)', () => {
  test('the shipped pack: own block 2400 · every further block 1600', () => {
    expect(loadBusDigestPolicy()).toEqual({ ownMaxChars: 2400, otherMaxChars: 1600 }); // 출처: #40640 graphs/policies/context-bus.yaml (pins the shipped YAML values)
  });
  test('a malformed pack throws — no silent default', () => {
    expect(() => parseBusDigestPolicy('version: 1\ndigest: { own_max_chars: 2400 }\n')).toThrow('digest.other_max_chars');
    expect(() => parseBusDigestPolicy('version: 2\ndigest: { own_max_chars: 2400, other_max_chars: 1600 }\n')).toThrow('version');
  });
});
