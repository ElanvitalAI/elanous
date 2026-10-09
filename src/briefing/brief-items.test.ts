import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BriefItemsInputError, BriefItemsLedger, composeBriefMarkdown, normalizeClaim, type BriefItem } from './brief-items.js';
import { runRequirementFunnel } from '../intake-plane/requirement-funnel.js';
import type { DirectiveRow } from '../intake-plane/requirement-funnel.js';

const NOW = new Date('2026-10-05T00:00:00Z'); // 09:00 KST — after 08:30, before 22:00

function fixture(events: Array<{ event: string; data?: unknown }> = []) {
  const root = mkdtempSync(join(tmpdir(), 'brief-items-'));
  const store = new BriefItemsLedger({
    stateDir: root,
    now: () => NOW,
    log: (_category, event, data) => { events.push({ event, data }); },
  });
  return { root, store, events };
}

test('undeliverable same kind and route within an hour is one ledger item, then a fresh hour adds one', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-undeliverable-'));
  let now = new Date('2026-10-08T03:00:00Z');
  const store = new BriefItemsLedger({ stateDir: root, now: () => now, log: () => {} });
  const input = {
    text: '미전달: kind report · 데몬 not-found · 경로 bot unknown · 우주 test',
    domain: '운영' as const, priority: 'P1' as const, source: 'outbound.undeliverable',
    evidence: 'elanous logs --category outbound.send --event undeliverable',
    dedupeKey: 'report · bot unknown', dedupeWithinMs: 60 * 60_000,
  };
  try {
    const first = store.add(input);
    now = new Date('2026-10-08T03:59:59Z');
    expect(store.add({ ...input, text: '미전달: kind report · 데몬 rejected · 경로 bot unknown · 우주 prod' }).id).toBe(first.id);
    expect(new BriefItemsLedger({ stateDir: root, now: () => now, log: () => {} }).list()).toHaveLength(1);
    expect(store.compose('after-release')).toContain(input.text);
    now = new Date('2026-10-08T04:00:01Z');
    expect(store.add({ ...input, dedupeKey: 'report · path undeliverable' }).id).not.toBe(first.id);
    expect(store.add(input).id).not.toBe(first.id);
    expect(store.list()).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('undeliverable retry before send shares one item, but retry after send appears on the next page', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-undeliverable-sent-'));
  let now = new Date('2026-10-08T03:00:00Z');
  const store = new BriefItemsLedger({ stateDir: root, now: () => now, log: () => {} });
  const input = {
    text: '미전달: kind report · 데몬 not-found · 경로 no-report-channel · 우주 test',
    domain: '운영' as const, priority: 'P1' as const, source: 'outbound.undeliverable',
    evidence: 'elanous logs --category outbound.send --event undeliverable',
    dedupeKey: 'report · no-report-channel', dedupeWithinMs: 60 * 60_000,
  };
  try {
    const first = store.add(input);
    now = new Date('2026-10-08T03:01:00Z');
    expect(store.add(input).id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
    expect(store.composeWithIds('after-release').ids).toEqual([first.id]);
    store.markSent([first.id], 'after-release');
    expect(store.composeWithIds('after-release').ids).toEqual([]);
    now = new Date('2026-10-08T03:02:00Z');
    const second = store.add(input);
    expect(second.id).not.toBe(first.id);
    now = new Date('2026-10-08T03:03:00Z');
    expect(store.add(input).id).toBe(second.id);
    expect(store.list()).toHaveLength(2);
    now = new Date('2026-10-08T13:01:00Z'); // 22:01 KST — the next briefing slot has opened
    const next = store.composeWithIds('22:00');
    expect(next.ids).toEqual([second.id]);
    expect(next.markdown).toContain(input.text);
    store.markSent(next.ids, '22:00');
    expect(store.composeWithIds('22:00').ids).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ordinary claim duplicates remain suppressed after a delivered page', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-ordinary-delivered-'));
  let now = new Date('2026-10-08T03:00:00Z');
  const store = new BriefItemsLedger({ stateDir: root, now: () => now, log: () => {} });
  try {
    const first = store.add({ text: '작업 결과', domain: '운영', priority: 'P1', source: 'test' });
    now = new Date('2026-10-08T03:01:00Z');
    store.markSent([first.id], 'after-release');
    const second = store.add({ text: '작업 결과', domain: '운영', priority: 'P1', source: 'test' });
    now = new Date('2026-10-08T03:02:00Z');
    expect(store.list()).toHaveLength(2);
    expect(store.composeWithIds('after-release').ids).toEqual([]);
    expect(store.compose('after-release')).not.toContain('작업 결과');
    expect(second.sent_at).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('append-only items keep the claim verbatim under briefing/items.sqlite', () => {
  const events: Array<{ event: string }> = [];
  const { root, store } = fixture(events);
  try {
    expect(store.path).toBe(join(root, 'briefing', 'items.sqlite'));
    const text = '  흡수 큐가 멈췄다  ';
    const first = store.add({
      text, domain: '흡수', priority: 'P1', source: '흡수',
      evidence: 'https://example.test/1', deadline: '2026-10-06',
    });
    const second = store.add({ text: '코나투스 공회전', domain: '코나투스', priority: 'P2', source: '코나투스' });
    expect(existsSync(store.path)).toBe(true);
    expect(first).toEqual({
      id: 1, text, domain: '흡수', priority: 'P1', deadline: '2026-10-06',
      evidence: 'https://example.test/1', source: '흡수', created_at: '2026-10-05T00:00:00.000Z', sent_at: null,
    });
    expect(second.deadline).toBeNull();
    expect(second.evidence).toBeNull();
    expect(second.sent_at).toBeNull();
    expect(new BriefItemsLedger({ stateDir: root }).list()).toEqual([first, second]);
    const db = new Database(store.path);
    try {
      expect(() => db.query('UPDATE items SET text = ? WHERE id = ?').run('rewritten', first.id)).toThrow('brief items are immutable');
      expect(() => db.query('DELETE FROM items WHERE id = ?').run(first.id)).toThrow('brief items are immutable');
    } finally { db.close(); }
    expect(store.list()[0]?.text).toBe(text);
    expect(events.map(event => event.event)).toEqual(['added', 'added']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reactions append per sent item without rewriting items; weekly action rates count distinct acted items by domain', () => {
  const { root, store } = fixture();
  try {
    const first = store.add({ text: '움직임', domain: '판', priority: 'P0', source: 'test' });
    const second = store.add({ text: '열람만', domain: '판', priority: 'P1', source: 'test' });
    const third = store.add({ text: '무시', domain: '시장', priority: 'P1', source: 'test' });
    const unsent = store.add({ text: '미발송', domain: '시장', priority: 'P2', source: 'test' });
    expect(() => store.recordReaction(unsent.id, '버튼')).toThrow('item was not sent');
    store.markSent([first.id, second.id, third.id], '08:30');
    const before = store.list();
    for (const reaction of ['열람', '버튼', '답장', '정정'] as const) store.recordReaction(first.id, reaction);
    store.recordReaction(second.id, '열람');
    store.recordReaction(third.id, '무시');
    const reopened = new BriefItemsLedger({ stateDir: root, now: () => NOW, log: () => {} });
    expect(reopened.weeklyActions()).toEqual({
      acted: 1, total: 3, rate: 1 / 3,
      byKind: {
        운영: { acted: 0, total: 0, rate: 0 },
        판: { acted: 1, total: 2, rate: 0.5 },
        흡수: { acted: 0, total: 0, rate: 0 },
        시장: { acted: 0, total: 1, rate: 0 },
        행정: { acted: 0, total: 0, rate: 0 },
        코나투스: { acted: 0, total: 0, rate: 0 },
      },
    });
    expect(reopened.list()).toEqual(before);
    const db = new Database(store.path);
    try {
      expect(db.query('SELECT item_id, reaction FROM reactions ORDER BY id').all()).toEqual([
        { item_id: first.id, reaction: '열람' }, { item_id: first.id, reaction: '버튼' },
        { item_id: first.id, reaction: '답장' }, { item_id: first.id, reaction: '정정' },
        { item_id: second.id, reaction: '열람' }, { item_id: third.id, reaction: '무시' },
      ]);
    } finally { db.close(); }
    expect(() => store.recordReaction(0, '버튼')).toThrow('invalid item id');
    expect(() => store.recordReaction(999, '버튼')).toThrow('item was not sent');
    expect(() => store.recordReaction(first.id, 'unknown' as '버튼')).toThrow('invalid reaction');
    expect(reopened.weeklyActions().total).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('weekly actions use KST Monday boundary and exclude future sends and reactions outside this week', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-week-'));
  try {
    let current = new Date('2026-10-04T14:59:00Z'); // Sunday 23:59 KST
    const store = new BriefItemsLedger({ stateDir: root, now: () => current, log: () => {} });
    const old = store.add({ text: '지난주', domain: '운영', priority: 'P1', source: 'test' });
    store.markSent([old.id], '22:00');
    store.recordReaction(old.id, '버튼');
    current = new Date('2026-10-04T15:01:00Z'); // Monday 00:01 KST
    const fresh = store.add({ text: '이번주', domain: '시장', priority: 'P1', source: 'test' });
    store.markSent([fresh.id], '08:30');
    store.recordReaction(fresh.id, '답장');
    expect(store.weeklyActions()).toMatchObject({ acted: 1, total: 1, byKind: { 운영: { total: 0 }, 시장: { acted: 1, total: 1 } } });
    current = new Date('2026-10-04T14:59:30Z');
    expect(() => store.recordReaction(fresh.id, '버튼')).toThrow('item was not sent');
    expect(store.weeklyActions()).toMatchObject({ acted: 1, total: 1, byKind: { 운영: { acted: 1 }, 시장: { total: 0 } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('five items: P0 leads, the same claim once, three domain heads, post-slot items drop', () => {
  const events: Array<{ event: string; data?: unknown }> = [];
  const { root, store } = fixture(events);
  try {
    store.add({ text: '흡수 대기', domain: '흡수', priority: 'P1', source: '흡수', createdAt: '2026-10-04T23:00:00Z' });
    store.add({ text: '판 컷 확인', domain: '판', priority: 'P1', source: '자리', createdAt: '2026-10-04T23:10:00Z' });
    store.add({ text: '시장 급변', domain: '시장', priority: 'P2', source: '루프', createdAt: '2026-10-04T23:20:00Z' });
    store.add({ text: '  흡수   대기 ', domain: '운영', priority: 'P2', source: '루프', createdAt: '2026-10-04T23:25:00Z' });
    store.add({
      text: '오늘 결정', domain: '행정', priority: 'P0', source: '코나투스',
      deadline: '2026-10-06', evidence: 'https://example.test/p0', createdAt: '2026-10-04T23:28:00Z',
    });
    store.add({ text: '슬롯 이후', domain: '운영', priority: 'P0', source: '루프', createdAt: '2026-10-04T23:30:00Z' });
    const before = store.list();
    const markdown = store.compose('08:30');
    const lines = markdown.trimEnd().split('\n');
    expect(lines[0]).toBe('# 브리핑 — 08:30');
    const decisionHead = lines.indexOf('## 결정이 필요한 것');
    expect(decisionHead).toBeGreaterThan(0);
    expect(lines[decisionHead + 2]).toStartWith('- [P0] 오늘 결정');
    expect(markdown.split('흡수 대기').length - 1).toBe(1);
    expect(normalizeClaim('  흡수   대기 ') === normalizeClaim('흡수 대기')).toBe(true);
    expect(lines.filter(line => line.startsWith('## ') && line !== '## 결정이 필요한 것')).toEqual(['## 판', '## 흡수', '## 시장']);
    expect(markdown).not.toContain('슬롯 이후');
    expect(markdown).toContain('근거: https://example.test/p0');
    expect(store.list()).toEqual(before);
    expect(events.at(-1)).toMatchObject({ event: 'composed', data: { slot: '08:30' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('after-release keeps the morning and drops the evening; 22:00 keeps both and a deadline due today', () => {
  const { root, store } = fixture();
  try {
    store.add({ text: '아침 전', domain: '운영', priority: 'P1', source: '루프', createdAt: '2026-10-04T23:00:00Z' });
    store.add({ text: '낮', domain: '판', priority: 'P1', source: '자리', deadline: '2026-10-05', createdAt: '2026-10-04T23:40:00Z' });
    store.add({ text: '밤 이후', domain: '시장', priority: 'P2', source: '루프', createdAt: '2026-10-05T13:30:00Z' });
    const morning = store.compose('08:30');
    expect(morning).toContain('아침 전');
    expect(morning).not.toContain('낮');
    expect(morning).not.toContain('밤 이후');
    const after = store.compose('after-release');
    expect(after).toContain('아침 전');
    expect(after).toContain('낮');
    expect(after.indexOf('## 결정이 필요한 것')).toBeLessThan(after.indexOf('- [P1] 낮'));
    expect(after).not.toContain('밤 이후');
    expect(after).not.toContain('## 판');
    const night = store.compose('22:00');
    expect(night).toContain('아침 전');
    expect(night).toContain('낮');
    expect(night).not.toContain('밤 이후');
    expect(() => store.compose('not-a-slot')).toThrow('invalid slot');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sent items and items from other days stay out; originals are not rewritten', () => {
  const sent: BriefItem = {
    id: 1, text: '이미 보냄', domain: '운영', priority: 'P0', deadline: null, evidence: null,
    source: '루프', created_at: '2026-10-04T23:00:00Z', sent_at: '2026-10-05T00:00:00Z',
  };
  const kept: BriefItem = {
    id: 2, text: '아직', domain: '흡수', priority: 'P2', deadline: '2026-10-05T15:00:00Z', evidence: null,
    source: '흡수', created_at: '2026-10-04T22:00:00Z', sent_at: null, // deadline instant is 2026-10-06 00:00 KST, not today
  };
  const due: BriefItem = { ...kept, id: 3, text: '오늘 마감', deadline: '2026-10-05' };
  const markdown = composeBriefMarkdown([sent, kept, due], '08:30', NOW);
  expect(markdown).not.toContain('이미 보냄');
  expect(markdown).toContain('- [P2] 아직');
  expect(markdown).toContain('## 흡수');
  expect(markdown.indexOf('## 결정이 필요한 것')).toBeLessThan(markdown.indexOf('오늘 마감'));
  expect(markdown.indexOf('오늘 마감')).toBeLessThan(markdown.indexOf('## 흡수'));
  expect(kept.text).toBe('아직');
});

test('invalid item and slot inputs do not add rows', () => {
  const { root, store } = fixture();
  try {
    const input = { text: 'valid', domain: '운영' as const, priority: 'P0' as const, source: '루프' };
    expect(() => store.add({ ...input, text: '  ' })).toThrow(BriefItemsInputError);
    expect(() => store.add({ ...input, domain: 'ops' as '운영' })).toThrow('invalid domain');
    expect(() => store.add({ ...input, priority: 'high' as 'P0' })).toThrow('invalid priority');
    expect(() => store.add({ ...input, deadline: 'next week' })).toThrow('invalid deadline');
    expect(() => store.add({ ...input, evidence: '' })).toThrow('evidence is required');
    expect(() => store.compose('morning')).toThrow('invalid slot');
    expect(store.list()).toEqual([]);
    expect(store.list({ domain: '운영' })).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('08:30 compose reaches requirement funnel and shows P0 oldest directive; other slots preserve their items', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-funnel-'));
  const directive: DirectiveRow = { ts: '2026-10-04T23:00:00Z',
    track: 'OP', text: '대표 요구', source_file: 'directive.jsonl', line_no: 1 };
  let calls = 0;
  const ledger = new BriefItemsLedger({ stateDir: root, now: () => NOW, log: () => {}, requirementFunnel: now => {
    calls++;
    return runRequirementFunnel({ now, cells: [], sources: { directives: [directive] }, placement: {
      schedules: [], released: '0.2.17', merged24h: 0, checklist: version => ({ version, released: '0.2.17', dev: version, items: [], history: [] }),
    } });
  } });
  try {
    const morning = ledger.compose('08:30');
    expect(morning).toContain('들어온 요구 1(문별 지시 1');
    expect(morning).toContain('대표 지시 중 아직 칸 없는 것 — 최근 24시간 1: 대표 요구');
    expect(morning).toContain('[P0]');
    expect(calls).toBe(1);
    expect(ledger.list()).toEqual([]);
    expect(ledger.compose('22:00')).not.toContain('대표 지시 중 아직 칸 없는 것');
    expect(calls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('08:30 compose still renders ledger items when the requirement funnel throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-funnel-fail-'));
  const events: string[] = [];
  const ledger = new BriefItemsLedger({ stateDir: root, now: () => NOW, log: (_c, event) => { events.push(event); },
    requirementFunnel: () => { throw new Error('directive index unreadable'); } });
  try {
    ledger.add({ text: '원장 항목', domain: '운영', priority: 'P1', source: 'test', createdAt: '2026-10-04T20:00:00Z' });
    const morning = ledger.compose('08:30');
    expect(morning).toContain('원장 항목');
    expect(events).toContain('requirement-funnel-failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('ACP must-fix (harvest 10-06)', () => {
  test('a legacy items.sqlite (high/medium/low · no sent_at) is migrated and keeps its rows', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Database } = await import('bun:sqlite');
    const { BriefItemsLedger } = await import('./brief-items.js');
    const stateDir = mkdtempSync(join(tmpdir(), 'brief-legacy-'));
    mkdirSync(join(stateDir, 'briefing'), { recursive: true });
    const legacy = new Database(join(stateDir, 'briefing', 'items.sqlite'), { create: true });
    legacy.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, domain TEXT NOT NULL,
      priority TEXT NOT NULL CHECK(priority IN ('high', 'medium', 'low')), deadline TEXT, evidence TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL)`);
    legacy.query("INSERT INTO items (text, domain, priority, source, created_at) VALUES ('old claim', '운영', 'high', 'seat', '2026-10-05T00:00:00Z')").run();
    legacy.query("INSERT INTO items (text, domain, priority, source, created_at) VALUES ('fin claim', 'finance', 'low', 'conatus', '2026-10-05T00:01:00Z')").run();
    legacy.close();
    const ledger = new BriefItemsLedger({ stateDir, log: () => {} });
    expect(ledger.list().map((i) => [i.text, i.priority, i.source, i.sent_at])).toEqual([
      ['old claim', 'P0', 'seat', null], ['fin claim', 'P2', 'conatus · 옛 도메인 finance', null]]);
    expect(ledger.add({ text: 'new claim', domain: '판', priority: 'P1', source: 'seat', createdAt: '2026-10-05T01:00:00Z' }).priority).toBe('P1');
  });

  test('a duplicate claim keeps its most urgent copy; multi-line text is refused; mark-sent drops items from the next compose', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { BriefItemsLedger, BriefItemsInputError } = await import('./brief-items.js');
    const now = new Date('2026-10-05T23:40:00Z'); // 08:40 KST
    const ledger = new BriefItemsLedger({ stateDir: mkdtempSync(join(tmpdir(), 'brief-mf-')), now: () => now, log: () => {} });
    ledger.add({ text: 'Same claim', domain: '운영', priority: 'P2', source: 'a', createdAt: '2026-10-05T22:00:00Z' });
    ledger.add({ text: 'same  claim', domain: '운영', priority: 'P0', source: 'b', createdAt: '2026-10-05T22:10:00Z' });
    expect(() => ledger.add({ text: 'two\nlines', domain: '운영', priority: 'P1', source: 'c' })).toThrow(BriefItemsInputError);
    expect(() => ledger.add({ text: 'ok', domain: '운영', priority: 'P1', source: 'c\n## forged' })).toThrow(BriefItemsInputError);
    expect(() => ledger.add({ text: 'ok', domain: '운영', priority: 'P1', source: 'c', evidence: 'https://x\n- [P0] forged' })).toThrow(BriefItemsInputError);
    const first = ledger.compose('08:30');
    expect(first).toContain('## 결정이 필요한 것');
    expect(first).toContain('[P0] same  claim');
    expect(first).not.toContain('[P2] Same claim');
    expect(ledger.compose('08:30')).toContain('claim'); // compose is read-only
    ledger.markSent(ledger.list().map((i) => i.id), '08:30'); // a sender records what it sent
    expect(ledger.compose('08:30')).not.toContain('claim');
    // A due-today P2 copy beats an undated P1 copy of the same claim.
    ledger.add({ text: 'Due claim', domain: '판', priority: 'P1', source: 'a', createdAt: '2026-10-05T22:20:00Z' });
    ledger.add({ text: 'due claim', domain: '판', priority: 'P2', source: 'b', deadline: '2026-10-06', createdAt: '2026-10-05T22:30:00Z' });
    const due = ledger.compose('08:30');
    expect(due).toContain('[P2] due claim');
    expect(due).not.toContain('[P1] Due claim');
  });
});
