import { expect, test } from 'bun:test';
import { contextNow, type ContextNowDeps } from './context-now.js';
import { renderTelegramNow, renderTuiNow, seatsNowLine } from './context-now-surfaces.js';
import { defaultTelegramCommands, parseTelegramSlash } from '../telegram-commands.js';
import { buildDashboardSlashRegistry, type DashboardSlashContext } from '../dashboard/slash-runtime/dashboard-handlers.js';

const at = '2026-10-03T04:00:00.000Z';
const deps: ContextNowDeps = {
  now: () => new Date(at), version: () => '0.2.0',
  checklist: version => ({ version, released: '', dev: version, history: [], items: version === '0.2.0' ? [
    { id: 'K6', title: 'Context door', status: 'red', updatedAt: at, updatedBy: 'TC' },
    { id: 'K7', title: 'Unrelated work', status: 'yellow', updatedAt: at, updatedBy: 'TC' },
  ] : [] }),
  decisions: () => [{ id: 'D1', title: 'Release review', status: 'open', raisedBy: { agent: 'TC' },
    category: 'scope', scqa: { s: 'SECRET CONVERSATION', c: 'x' }, options: [], recommendation: { skipped: true, reason: 'x' }, history: [] }],
  seatEntries: () => [{ entry: { seat: 'TC', at, status: 'shadow', item: { source: 'checklist', id: 'K6', title: 'Context door', text: 'SECRET CONVERSATION' } }, source: 'elanous://seat-loop/TC/1#1' }],
  events: () => [
    { id: 'a', at, kind: '보고', summary: 'K6 ready', text: 'SECRET CONVERSATION', refs: { seat: 'TC', recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: 'https://example.org/context' } },
    { id: 'b', at, kind: '보고', summary: 'Other work', text: 'SECRET CONVERSATION', refs: { seat: 'TC', recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: null } },
    { id: 'c', at, kind: 'guide-changed', summary: 'K6 guide updated', text: 'SECRET CONVERSATION', refs: { seat: 'TC', recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: 'https://example.org/guide' } },
  ],
};

async function surfaceReplies(text: string) {
  const commands = defaultTelegramCommands(deps);
  const parsed = parseTelegramSlash(text, commands);
  expect(parsed.kind).toBe('match');
  if (parsed.kind !== 'match') throw new Error('Telegram /now not registered');
  const telegram = await parsed.cmd.handler(parsed.args, {} as never, {} as never);
  const lines: string[] = [];
  const ctx = { pushChatLine: (line: string) => { lines.push(line); } } as unknown as DashboardSlashContext;
  const tui = await buildDashboardSlashRegistry(deps).dispatch('now', parsed.args, ctx);
  expect(tui.kind).toBe('continue');
  return { telegram: String(telegram), tui: lines, answer: contextNow({ topic: parsed.args.join(' ') }, deps) };
}

test('Telegram /now and TUI /now display the same sourced fake-ledger facts with different layouts', async () => {
  const { telegram, tui, answer } = await surfaceReplies('/now');
  expect(answer.facts.map(f => f.kind)).toEqual(['version', 'cell', 'cell', 'decision', 'seat']);
  expect(telegram).toBe(renderTelegramNow(answer));
  expect(tui).toEqual(renderTuiNow(answer));
  expect(telegram.split('\n')).toHaveLength(5);
  expect(tui[1]).toBe('| 종류 | 사실 | 출처 |');
  for (const fact of answer.facts) {
    const label = fact.kind === 'version' ? fact.version : fact.title;
    if (label) {
      expect(telegram).toContain(label);
      expect(tui.join('\n')).toContain(label);
    }
    expect(telegram).toContain(fact.source);
    expect(tui.join('\n')).toContain(fact.source);
  }
  for (const event of answer.events) {
    expect(telegram).toContain(event.summary);
    expect(tui.join('\n')).toContain(event.summary);
    expect(telegram).toContain(event.source);
    expect(tui.join('\n')).toContain(event.source);
  }
  expect(telegram).toContain('https://example.org/context');
  expect(tui.join('\n')).toContain('https://example.org/context');
  for (const guide of answer.guide) {
    expect(telegram).toContain(guide);
    expect(tui.join('\n')).toContain(guide);
  }
  expect(telegram + tui.join('\n')).not.toContain('SECRET CONVERSATION');
});

test('Telegram /now keeps five lines when ledger titles, event summaries and guidance span lines', () => {
  const answer = contextNow({}, deps);
  answer.facts = answer.facts.map(f => f.kind === 'cell' && f.id === 'K6'
    ? { ...f, title: 'Context\n door', source: 'elanous://release/0.2.0/\r\nchecklist#K6' }
    : f);
  answer.events = [{ at, kind: '보고', summary: 'K6\nready', source: 'https://example.org/\ncontext' }];
  answer.guide = ['Follow\r\n up — https://example.org/guide'];
  const telegram = renderTelegramNow(answer);
  expect(telegram.split('\n')).toHaveLength(5);
  expect(telegram).toContain('K6 Context door (red) — elanous://release/0.2.0/ checklist#K6');
  expect(telegram).toContain('K6 ready — https://example.org/ context');
  expect(telegram).toContain('Follow up — https://example.org/guide');
});

test('seatsNowLine selects latest seat per role, orders roles and falls back to status', () => {
  const now = Date.parse('2026-10-03T04:00:00.000Z');
  const answer = contextNow({}, deps);
  answer.facts = [
    { kind: 'seat', seat: 'UX', at: new Date(now - 30_000).toISOString(), status: 'shadow', id: null, title: null, source: 'fake://UX' },
    { kind: 'seat', seat: 'TC', at: new Date(now - 10 * 60_000).toISOString(), status: 'old', id: null, title: 'Old work', source: 'fake://TC/old' },
    { kind: 'seat', seat: 'TC', at: new Date(now - 3 * 60_000).toISOString(), status: 'now', id: null, title: 'Twenty characters in a long title', source: 'fake://TC/new' },
  ];
  expect(seatsNowLine(answer, now)).toBe('지금 자리들: CTO Twenty characters in · 3분 전 | CXO shadow · 방금');
  answer.facts.push({ kind: 'seat', seat: 'OP', at: new Date(now - 2 * 3_600_000).toISOString(), status: 'on', id: null, title: 'Operations', source: 'fake://OP' });
  answer.facts.push({ kind: 'seat', seat: 'MK', at: new Date(now - 30 * 3_600_000).toISOString(), status: 'on', id: null, title: 'Marketing', source: 'fake://MK' });
  expect(seatsNowLine(answer, now)).toBe('지금 자리들: COO Operations · 2시간 전 | CMO Marketing · 하루 넘음 | CTO Twenty characters in · 3분 전 | CXO shadow · 방금');
});

test('seatsNowLine returns null with no seat facts', () => {
  const answer = contextNow({}, { ...deps, seatEntries: () => [] });
  expect(seatsNowLine(answer, Date.parse(at))).toBeNull();
});

test('topic filtering agrees across Telegram and TUI and never exposes private bodies', async () => {
  const { telegram, tui, answer } = await surfaceReplies('/now Context door');
  expect(answer.topic).toBe('Context door');
  expect(answer.facts.map(f => f.kind)).toEqual(['cell', 'seat']);
  expect(telegram).toBe(renderTelegramNow(answer));
  expect(tui).toEqual(renderTuiNow(answer));
  for (const output of [telegram, tui.join('\n')]) {
    expect(output).toContain('K6');
    expect(output).not.toContain('K7');
    expect(output).not.toContain('SECRET CONVERSATION');
  }
});
