// TUI-STATUS-3ROW v1 — expected strings are literals (rule 11: independent of the product's constants and helpers).
import { expect, test } from 'bun:test';
import { accountsRowLine, compactTokenCount, renderStatusRows } from './status-rows.js';

const seat = {
  autopilot: '🚗 AUTO · 0.3.35 개발 · 데모 D-1', seat: 'OP', model: 'openai-codex/gpt-6.1-terra', build: '261124_1811·dev',
  queued: 21, background: 17, state: '● Turn done', needsHuman: 1,
};
const running = { phase: { kind: 'working' as const }, elapsedMs: 936_200, inputTokens: 63_720, outputTokens: 2_013, queued: 2 };

test('wide and tall: two rows — seat on top, work below; idle has no progress row', () => {
  expect(renderStatusRows({ ...seat, width: 120, height: 30 })).toEqual({
    progress: null, accounts: null,
    rows: [
      '🚗 AUTO · OP · 0.3.35 개발 · 데모 D-1 · gpt-6.1-terra · build 261124_1811·dev',
      '● Turn done · Queue 21 · Bg 17 · ✋ 1',
    ],
  });
});

test('short screen: one row, attention and work before the seat facts', () => {
  expect(renderStatusRows({ ...seat, width: 60, height: 12 }).rows).toEqual(['● Turn done · Queue 21 · Bg 17 · ✋ 1 · 🚗 AUTO · OP']);
  expect(renderStatusRows({ ...seat, width: 40, height: 12 }).rows).toEqual(['● Turn done · Queue 21 · Bg 17 · ✋ 1']);
  expect(renderStatusRows({ ...seat, width: 120, height: 19 }).rows).toHaveLength(1);
  expect(renderStatusRows({ ...seat, width: 120, height: 20 }).rows).toHaveLength(2);
});

test('narrow tall screen: whole fields drop from the right by priority, never cut mid-field', () => {
  expect(renderStatusRows({ ...seat, width: 50, height: 30 }).rows).toEqual([
    '🚗 AUTO · OP · 0.3.35 개발 · gpt-6.1-terra',
    '● Turn done · Queue 21 · Bg 17 · ✋ 1',
  ]);
});

test('a running turn shows the progress row (elapsed · tokens in/out · queued); it shrinks before it is cut', () => {
  expect(renderStatusRows({ ...seat, state: '', width: 120, height: 30, turn: running })).toEqual({
    progress: '⠼ Working (15m 36s • esc to interrupt) · ↑63.7k ↓2.0k · 2 queued', accounts: null,
    rows: [
      '🚗 AUTO · OP · 0.3.35 개발 · 데모 D-1 · gpt-6.1-terra · build 261124_1811·dev',
      'Queue 21 · Bg 17 · ✋ 1',
    ],
  });
  expect(renderStatusRows({ ...seat, width: 40, height: 30, turn: running }).progress).toBe('⠼ Working (15m 36s • esc to interrupt)');
  expect(renderStatusRows({ ...seat, width: 120, height: 30, turn: { phase: { kind: 'thinking' }, elapsedMs: 7_000, estimatedOutputTokens: 1_234 } }).progress)
    .toBe('⠇ Thinking (7s • esc to interrupt) · ↓~1.2k');
  expect(renderStatusRows({ ...seat, width: 120, height: 30, turn: { phase: { kind: 'working' }, elapsedMs: 0 } }).progress)
    .toBe('⠋ Working (0s • esc to interrupt)');
});

test('the model appears once, without its provider prefix', () => {
  const { rows, progress } = renderStatusRows({ ...seat, width: 200, height: 30, turn: running });
  const all = [progress, ...rows].join('\n');
  expect(all.split('gpt-6.1-terra').length - 1).toBe(1);
  expect(all).not.toContain('openai-codex/');
});

test('fields without a data source are not drawn; attention leads; steering and paused autopilot', () => {
  expect(renderStatusRows({ queued: 0, background: 0, width: 80, height: 30 }).rows).toEqual(['Queue 0 · Bg 0']);
  expect(renderStatusRows({ ...seat, autopilot: '🚗 PAUSED · 사람 운전', steering: 1, queued: 3, needsHuman: 0, unread: 4,
    attention: ['↓ 3 new below', null, ''], width: 120, height: 30 }).rows).toEqual([
    '🚗 PAUSED · OP · 사람 운전 · gpt-6.1-terra · build 261124_1811·dev',
    '↓ 3 new below · ● Turn done · Steer 1 · Queue 2 · Bg 17 · ✉ 4',
  ]);
  expect(renderStatusRows({ ...seat, width: 8, height: 12, attention: ['✗ failed: provider timeout'] }).rows).toEqual(['✗ faile…']);
});

test('compact token counts', () => {
  expect([812, 2_013, 63_720, 999_949, 1_234_567].map(compactTokenCount)).toEqual(['812', '2.0k', '63.7k', '999.9k', '1.2M']);
});

// TUI-STATUS-3ROW row 3 — LLM accounts ⊕ host load from caches (대표 11-24 22:4x).
const NOW = Date.parse('2026-11-24T22:50:00Z');
const snapshot = {
  ts: NOW - 60_000,
  accounts: [
    { provider: 'codex' as const, account: 'default', usedPercent: null, status: 'error' as const },
    { provider: 'codex' as const, account: 'team', usedPercent: 76, resetsIn: '3d 8h', status: 'ok' as const },
    { provider: 'codex' as const, account: 'third', usedPercent: 57, status: 'ok' as const },
    { provider: 'claude' as const, account: 'default', usedPercent: null, status: 'error' as const },
    { provider: 'grok' as const, account: 'default', usedPercent: null, status: 'unknown' as const },
    { provider: 'openrouter' as const, account: 'default', usedPercent: 92.5, left: '$977.5', leftUsd: 977.5, status: 'ok' as const },
    { provider: 'zai' as const, account: 'plan-5h', usedPercent: 0, status: 'ok' as const },
    { provider: 'zai' as const, account: 'plan-week', usedPercent: 100, status: 'ok' as const },
    { provider: 'zai' as const, account: 'extra-usage', usedPercent: null, status: 'unknown' as const },
  ],
};
const hosts = [{ text: 'mshq 12' }, { text: 'node-b 25⚠' }, { text: 'minim5 4' }];

test('row 3 wide: codex accounts · OR balance · GLM windows · errors ✗ · no-data providers omitted · host load', () => {
  expect(accountsRowLine({ snapshot, hosts, nowMs: NOW }, 200)).toBe(
    'codex team 76% · third 57% · default ✗ │ OR $977 left │ glm 5h 0% · week 100% ⚠ │ claude ✗ │ mshq 12 · node-b 25⚠ · minim5 4');
  expect(renderStatusRows({ ...seat, width: 200, height: 24, accounts: { snapshot, hosts, nowMs: NOW } }).accounts).toBe(
    'codex team 76% · third 57% · default ✗ │ OR $977 left │ glm 5h 0% · week 100% ⚠ │ claude ✗ │ mshq 12 · node-b 25⚠ · minim5 4');
});

test('row 3 narrow: host field first, then provider fields from the right, then accounts — never cut', () => {
  expect(accountsRowLine({ snapshot, hosts, nowMs: NOW }, 100)).toBe(
    'codex team 76% · third 57% · default ✗ │ OR $977 left │ glm 5h 0% · week 100% ⚠ │ claude ✗');
  expect(accountsRowLine({ snapshot, hosts, nowMs: NOW }, 60)).toBe('codex team 76% · third 57% · default ✗ │ OR $977 left');
  expect(accountsRowLine({ snapshot, hosts, nowMs: NOW }, 30)).toBe('codex team 76% · third 57%');
  expect(accountsRowLine({ snapshot, hosts, nowMs: NOW }, 10)).toBeNull();
});

test('row 3 stale: numbers older than 10 minutes say so; no cache = hosts only; nothing = no row', () => {
  expect(accountsRowLine({ snapshot: { ...snapshot, ts: NOW - 11 * 60_000 }, nowMs: NOW }, 80)).toBe(
    'codex team 76% · third 57% · default ✗ │ OR $977 left (stale)');
  expect(accountsRowLine({ snapshot: { ...snapshot, ts: NOW - 9 * 60_000 }, nowMs: NOW }, 80)).toBe(
    'codex team 76% · third 57% · default ✗ │ OR $977 left │ glm 5h 0% · week 100% ⚠');
  expect(accountsRowLine({ snapshot: null, hosts, nowMs: NOW }, 80)).toBe('mshq 12 · node-b 25⚠ · minim5 4');
  expect(accountsRowLine({ snapshot: { ts: NOW, accounts: [], error: 'usage collector timeout (60s)' }, nowMs: NOW }, 80)).toBeNull();
});

test('row 3 thresholds: used ≥ 80% and balance < $50 get ⚠; a single account has no name', () => {
  expect(accountsRowLine({ nowMs: NOW, snapshot: { ts: NOW, accounts: [
    { provider: 'codex', account: 'team', usedPercent: 79.4, status: 'ok' },
    { provider: 'codex', account: 'third', usedPercent: 80, status: 'ok' },
    { provider: 'openrouter', account: 'default', usedPercent: 99, leftUsd: 49.9, left: '$49.9', status: 'ok' },
    { provider: 'claude', account: 'default', usedPercent: 42, status: 'ok' },
  ] } }, 120)).toBe('codex team 79% · third 80% ⚠ │ OR $49 left ⚠ │ claude 42%');
});

test('row 3 only from 24 rows', () => {
  const accounts = { snapshot, hosts, nowMs: NOW };
  expect(renderStatusRows({ ...seat, width: 200, height: 23, accounts }).accounts).toBeNull();
  expect(renderStatusRows({ ...seat, width: 200, height: 12, accounts }).accounts).toBeNull();
  expect(renderStatusRows({ ...seat, width: 200, height: 24, accounts }).rows).toHaveLength(2);
});
