import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexFetcher } from './fetchers/codex.js';
import { createQuotaSignalDecisionReader, readQuotaSignalSnapshot } from './codex-reset-credit-state.js';

describe('Codex usage to window account signal', () => {
  test('a fake app-server response persists the limiting brand window for the measured home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-window-signal-'));
    const now = Date.now();
    const soon = now + 60_000;
    const later = now + 600_000;
    try {
      await createCodexFetcher({
        codexHome: '/synthetic/account-a', quotaSignalStorage: { root },
        fetchImpl: async () => ({ rateLimits: {
          primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: Math.ceil(soon / 1000) },
          secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: Math.ceil(later / 1000) },
        } }),
      }).fetch();
      expect(readQuotaSignalSnapshot(Date.now(), '/synthetic/account-a', { root })).toMatchObject({
        fresh: true, usedPercent: 80, resetsAtMs: Math.ceil(soon / 1000) * 1000,
      });
      expect(readQuotaSignalSnapshot(Date.now(), '/synthetic/account-b', { root })).toEqual({ fresh: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a legacy signal without reset time and an expired reset remain unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-window-legacy-'));
    try {
      await createCodexFetcher({
        codexHome: '/synthetic/account-a', quotaSignalStorage: { root },
        fetchImpl: async () => ({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300 } } }),
      }).fetch();
      expect(readQuotaSignalSnapshot(Date.now(), '/synthetic/account-a', { root }).resetsAtMs).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('an unknown reset never outranks a known reset at equal usage, and a corrupt read fails explicitly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-window-tie-'));
    const soon = Math.ceil((Date.now() + 60_000) / 1000) * 1000;
    try {
      await createCodexFetcher({
        codexHome: '/synthetic/account-a', quotaSignalStorage: { root },
        fetchImpl: async () => ({ rateLimits: {
          primary: { usedPercent: 50, windowDurationMins: 300 },
          secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: soon / 1000 },
        } }),
      }).fetch();
      expect(readQuotaSignalSnapshot(Date.now(), '/synthetic/account-a', { root }).resetsAtMs).toBe(soon);
      const signal = readdirSync(join(root, 'budget')).find((name) => name.startsWith('codex-quota-signal-'));
      expect(signal).toBeDefined();
      writeFileSync(join(root, 'budget', signal!), '{broken');
      expect(() => readQuotaSignalSnapshot(Date.now(), '/synthetic/account-a', { root })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('one decision shares a snapshot across two paths to the same normalized home', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-window-alias-'));
    try {
      const home = join(root, 'home');
      const alias = join(root, 'alias');
      mkdirSync(home);
      symlinkSync(home, alias);
      let reads = 0;
      const reader = createQuotaSignalDecisionReader(Date.now(), () => {
        reads += 1;
        return { fresh: true, usedPercent: reads * 10 };
      });
      expect(reader(home).usedPercent).toBe(10);
      expect(reader(alias).usedPercent).toBe(10);
      expect(reads).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
