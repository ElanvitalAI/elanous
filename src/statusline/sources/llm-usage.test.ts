// TUI-STATUS-3ROW row 3 — the LLM usage cache: snapshot fold, atomic write, failure touch, single-flight refresh and the
// cross-process lock. Expected values are literals (rule 11). Temp dirs only; no network, no child process.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedUsageReport } from '../../budget/types';
import {
  acquireLlmUsageLock, createLlmUsageSource, llmUsageCachePath, llmUsageSnapshotFromReport, markLlmUsageRefreshFailed,
  parseLlmUsageSnapshot, writeLlmUsageSnapshot,
} from './llm-usage';

const NOW = Date.parse('2026-11-24T22:50:00Z');
const dirs: string[] = [];
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'llm-usage-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ok = (usedPercent: number | null, periodType: string, extra: Record<string, unknown> = {}) => ({
  status: 'ok' as const, usedPercent, periodType, periodStart: null, periodEnd: null, monthlyLimit: null, used: null,
  onDemandCap: null, onDemandUsed: null, prepaidBalance: null, balance: null, hasCredits: null, unlimited: null, ...extra,
});
const row = (provider: 'codex' | 'openrouter' | 'claude' | 'grok' | 'zai', accountName: string, credits: unknown, subscription: unknown = { status: 'unavailable', reason: 'query-does-not-supply' }) => ({
  provider, accountName, accountCount: 1, soleAccount: true, credits, subscription, resetCredits: { status: 'not-applicable' },
}) as UnifiedUsageReport['rows'][number];

test('the collector report folds into the compact snapshot (no notes, no credentials)', () => {
  const report = { accountCounts: { codex: 2, grok: 1, openrouter: 1 }, rows: [
    row('codex', 'default', { status: 'error', detail: 'codex account authentication required' }),
    row('codex', 'team', ok(76, 'weekly', { balance: 14092.79 }), { status: 'available', remainingPercent: 24, windowKind: 'weekly', resetsAt: NOW + (3 * 24 + 8) * 3_600_000 + 60_000 }),
    row('grok', 'default', ok(null, 'USAGE_PERIOD_TYPE_WEEKLY')),
    row('openrouter', 'default', ok(92.5, 'prepaid-usd', { balance: 977.5 })),
    row('claude', 'default', { status: 'unauthorized' }),
  ] } as unknown as UnifiedUsageReport;
  expect(llmUsageSnapshotFromReport(report, NOW)).toEqual({ ts: NOW, accounts: [
    { provider: 'codex', account: 'default', usedPercent: null, status: 'error' },
    { provider: 'codex', account: 'team', usedPercent: 76, resetsIn: '3d 8h', status: 'ok' },
    { provider: 'grok', account: 'default', usedPercent: null, status: 'unknown' },
    { provider: 'openrouter', account: 'default', usedPercent: 92.5, left: '$977.5', leftUsd: 977.5, status: 'ok' },
    { provider: 'claude', account: 'default', usedPercent: null, status: 'error' },
  ] });
});

test('the cache lives under the state root; writes are whole files; garbage is not a snapshot', () => {
  const root = tempDir();
  const path = llmUsageCachePath(root);
  expect(path).toBe(join(root, 'status', 'llm-usage.json'));
  writeLlmUsageSnapshot(path, { ts: NOW, accounts: [{ provider: 'codex', account: 'team', usedPercent: 76, status: 'ok' }] });
  expect(parseLlmUsageSnapshot(readFileSync(path, 'utf8'))).toEqual({ ts: NOW, accounts: [{ provider: 'codex', account: 'team', usedPercent: 76, status: 'ok' }] });
  expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  expect(parseLlmUsageSnapshot('{"ts":')).toBeNull();
  expect(parseLlmUsageSnapshot('{"accounts":[]}')).toBeNull();
  expect(parseLlmUsageSnapshot('{"ts":1,"accounts":[{"provider":"nope","account":"x","status":"ok"}]}')).toEqual({ ts: 1, accounts: [] });
});

test('collector error: old numbers stay (their ts ages them), only the file time moves; no file → an empty snapshot with the error', () => {
  const root = tempDir();
  const path = llmUsageCachePath(root);
  writeLlmUsageSnapshot(path, { ts: NOW - 3_600_000, accounts: [{ provider: 'codex', account: 'team', usedPercent: 76, status: 'ok' }] });
  const before = readFileSync(path, 'utf8');
  markLlmUsageRefreshFailed(path, 'usage collector timeout (60s)', NOW);
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(Math.round(statSync(path).mtimeMs / 1000)).toBe(Math.round(NOW / 1000));
  const fresh = llmUsageCachePath(tempDir());
  markLlmUsageRefreshFailed(fresh, 'usage collector timeout (60s)', NOW);
  expect(parseLlmUsageSnapshot(readFileSync(fresh, 'utf8'))).toEqual({ ts: NOW, accounts: [], error: 'usage collector timeout (60s)' });
});

test('cache missing → one refresh; fresh file → none; file older than 5 minutes → one more; the lock is released', async () => {
  const path = llmUsageCachePath(tempDir());
  let refreshes = 0;
  let changes = 0;
  const source = createLlmUsageSource({ path, onChange: () => { changes += 1; }, runRefresh: async () => {
    refreshes += 1;
    writeLlmUsageSnapshot(path, { ts: Date.now(), accounts: [{ provider: 'codex', account: 'team', usedPercent: 70 + refreshes, status: 'ok' }] });
  } });
  expect(source.current()).toBeNull();
  await source.check();
  expect(refreshes).toBe(1);
  expect(source.current()?.accounts[0]?.usedPercent).toBe(71);
  expect(changes).toBe(1);
  expect(existsSync(`${path}.lock`)).toBe(false);
  await source.check();
  expect(refreshes).toBe(1);
  const old = new Date(Date.now() - 301_000);
  utimesSync(path, old, old);
  await source.check();
  expect(refreshes).toBe(2);
  expect(source.current()?.accounts[0]?.usedPercent).toBe(72);
  source.stop();
});

test('concurrent refresh: one child per process (single flight) and none while another process holds the lock', async () => {
  const path = llmUsageCachePath(tempDir());
  let refreshes = 0;
  let release: (() => void) | undefined;
  const source = createLlmUsageSource({ path, onChange: () => {}, runRefresh: () => { refreshes += 1; return new Promise<void>((resolve) => { release = resolve; }); } });
  const first = source.check();
  await source.check();
  expect(refreshes).toBe(1);
  release?.();
  await first;
  // The child wrote nothing: the try is marked (an empty snapshot with the reason), so the next one waits the TTL.
  expect(parseLlmUsageSnapshot(readFileSync(path, 'utf8'))?.error).toBe('refresh wrote nothing');
  expect(source.current()?.accounts).toEqual([]);
  await source.check();
  expect(refreshes).toBe(1);
  const aged = new Date(Date.now() - 301_000);
  utimesSync(path, aged, aged);
  // Another seat's TUI holds a fresh lock: this one waits.
  mkdirSync(`${path}.lock`, { recursive: true });
  const other = createLlmUsageSource({ path, onChange: () => {}, runRefresh: async () => { refreshes += 1; } });
  await other.check();
  expect(refreshes).toBe(1);
  // A lock left by a dead refresher (> 300 s) is cleared, and the next check refreshes.
  const old = new Date(Date.now() - 301_000);
  utimesSync(`${path}.lock`, old, old);
  await other.check();
  expect(existsSync(`${path}.lock`)).toBe(false);
  expect(refreshes).toBe(1);
  await other.check();
  expect(refreshes).toBe(2);
});

test('the lock helper: taken once, refused while held', () => {
  const lock = `${llmUsageCachePath(tempDir())}.lock`;
  expect(acquireLlmUsageLock(lock, Date.now())).toBe(true);
  expect(acquireLlmUsageLock(lock, Date.now())).toBe(false);
  expect(existsSync(lock)).toBe(true);
});
