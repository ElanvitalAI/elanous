import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { grokQuotaFromUsageJson, readGrokQuotaForLaunch, grokWeeklyUsedPctFromUsageJson, readGrokWeeklyUsedPctForLaunch, buildDevCliSpec, defaultChildLlmModel } from './dev-cli.js';
import { debug } from '../debug/log.js';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLedgerPath } from '../self-implement/run-ledger.js';
import { childLlmSelectionEnv } from '../agent/run-context.js';
import { codexPolicyAllowsCredits, resolveCodexQuotaPolicy } from '../oauth/codex-quota-policy.js';
import { decideCodexRotation } from '../oauth/codex-account-rotation.js';
import { setUserConfigOverlay } from '../user-config.js';

const usage = (rows: unknown[]) => JSON.stringify({ rows, accountCounts: {} });

describe('grok quota at launch', () => {
  test('reads the live `elanous usage --json` grok credit row', () => {
    expect(grokQuotaFromUsageJson(usage([{ provider: 'grok', credits: { status: 'ok', usedPercent: 100 } }]))).toBe('exhausted');
    expect(grokQuotaFromUsageJson(usage([{ provider: 'grok', credits: { status: 'ok', usedPercent: 42 } }, { provider: 'grok', credits: { status: 'ok', usedPercent: 100 } }]))).toBe('usable');
    expect(grokQuotaFromUsageJson(usage([{ provider: 'codex', credits: { status: 'ok', usedPercent: 100 } }]))).toBe('unknown');
    expect(grokQuotaFromUsageJson('not json')).toBe('unknown');
  });

  test('uses the cache when it knows, and asks the live usage only when the cache is unknown', () => {
    let asked = 0;
    const run = () => { asked++; return usage([{ provider: 'grok', credits: { status: 'ok', usedPercent: 100 } }]); };
    expect(readGrokQuotaForLaunch({ readCached: () => 'usable', runUsage: run })).toBe('usable');
    expect(asked).toBe(0);
    expect(readGrokQuotaForLaunch({ readCached: () => 'unknown', runUsage: run })).toBe('exhausted');
    expect(asked).toBe(1);
    expect(readGrokQuotaForLaunch({ readCached: () => 'unknown', runUsage: () => null })).toBe('unknown');
  });
});

describe('grok weekly launch rebalancing', () => {
  afterEach(() => setUserConfigOverlay(null));

  test('weekly period only; malformed and non-weekly percentages are unknown', () => {
    const weekly = (pct: unknown, periodType: string = 'USAGE_PERIOD_TYPE_WEEKLY') => usage([{ provider: 'grok', credits: { status: 'ok', periodType, usedPercent: pct } }]);
    expect(grokWeeklyUsedPctFromUsageJson(weekly(85))).toBe(85);
    expect(grokWeeklyUsedPctFromUsageJson(weekly(85, 'USAGE_PERIOD_TYPE_MONTHLY'))).toBeUndefined();
    expect(grokWeeklyUsedPctFromUsageJson(weekly(null))).toBeUndefined();
    expect(grokWeeklyUsedPctFromUsageJson('bad json')).toBeUndefined();
    expect(readGrokWeeklyUsedPctForLaunch(() => weekly(50))).toBe(50);
    expect(readGrokWeeklyUsedPctForLaunch(() => null)).toBeUndefined();
  });

  test('85% / cap 80 rebalances the dispatched child to codex and writes exactly one run-ledger event', () => {
    mkdirSync(join(process.cwd(), '.elanous-test'), { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), '.elanous-test', 'grok-launch-'));
    const lines: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event) => { events.push(event); });
    const runId = 'run-grok-cap-test';
    try {
      const spec = buildDevCliSpec({ text: 'goal' }, { kind: 'self' }, { childLlmProvider: 'grok', childLlmModel: 'grok-4.7' }, undefined, 'cli-dev-ask', () => 'usable', () => 85, runId,
        (entry) => { const ledger = join(dir, 'run-ledger'); mkdirSync(ledger, { recursive: true }); appendFileSync(runLedgerPath(entry.runId, ledger), JSON.stringify(entry) + '\n'); });
      expect(spec.self?.childLlm).toEqual({ provider: 'openai-codex', model: defaultChildLlmModel('openai-codex'), source: 'flag', codexQuotaPolicy: 'credits' });
      const childEnv = childLlmSelectionEnv(spec.self?.childLlm);
      expect(childEnv.ELANOUS_CODEX_QUOTA_POLICY).toBe('credits');
      const previousPolicy = process.env.ELANOUS_CODEX_QUOTA_POLICY;
      try {
        process.env.ELANOUS_CODEX_QUOTA_POLICY = childEnv.ELANOUS_CODEX_QUOTA_POLICY;
        // A spent subscription quota still permits prepaid credits in the launched child.
        expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'fallback' }).policy).toBe('credits');
        const creditsAllowed = codexPolicyAllowsCredits(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'fallback' }).policy);
        expect(creditsAllowed).toBe(true);
        const spent = { current: { name: 'default', storeKey: 'openai-codex', home: '/h/default', source: 'default' as const },
          explicit: false, enabled: true, currentReached: true, currentUsedPercent: 100,
          currentCreditBalance: 0, currentHasCredits: false, resetCreditAvailability: 'unavailable' as const,
          candidates: [{ name: 'team', storeKey: 'k-team', home: '/h/team', reached: true, usedPercent: 100, creditBalance: 30, hasCredits: true }] };
        expect(decideCodexRotation({ ...spent, creditsAllowed }).to?.name).toBe('team');
        expect(decideCodexRotation({ ...spent, creditsAllowed: false }).reason).toBe('no-candidate');
        expect(decideCodexRotation({ ...spent, candidates: [], creditsAllowed }).reason).toBe('credits-allowed');
      } finally {
        if (previousPolicy === undefined) delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
        else process.env.ELANOUS_CODEX_QUOTA_POLICY = previousPolicy;
      }
      expect(lines.filter((line) => line.includes('grok → openai-codex'))).toHaveLength(1);
      const rows = readFileSync(runLedgerPath(runId, join(dir, 'run-ledger')), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(rows.filter((row) => row.event === 'launch-provider-rebalanced')).toEqual([
        expect.objectContaining({ runId, data: expect.objectContaining({ requestedProvider: 'grok', selectedProvider: 'openai-codex', weeklyUsedPct: 85, capPct: 80, reason: expect.stringContaining('85%') }) }),
      ]);
      expect(events.filter((event) => event === 'launch-provider-rebalanced')).toHaveLength(1);
    } finally {
      log.mockRestore(); write.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('50% preserves grok; unknown preserves grok and records unmeasured, without inventing 0%', () => {
    const ledger: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const rows: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => { rows.push({ event, data: data as Record<string, unknown> }); });
    const lines: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    try {
      const run = (used: number | undefined) => buildDevCliSpec({ text: 'goal' }, { kind: 'self' }, { childLlmProvider: 'grok' }, undefined, 'cli-dev-ask', () => 'usable', () => used, 'run-weekly-measure', (entry) => { ledger.push(entry); });
      expect(run(50).self?.childLlm?.provider).toBe('grok');
      expect(childLlmSelectionEnv(run(50).self?.childLlm).ELANOUS_CODEX_QUOTA_POLICY).toBeUndefined();
      expect(rows.filter((row) => row.event === 'launch-provider-rebalanced')).toHaveLength(0);
      expect(ledger).toHaveLength(0);
      expect(run(undefined).self?.childLlm?.provider).toBe('grok');
      expect(ledger).toEqual([expect.objectContaining({ event: 'launch-provider-weekly-unmeasured', data: expect.objectContaining({ weeklyUsedPct: null, reason: '측정 불가' }) })]);
      expect(rows.filter((row) => row.event === 'launch-provider-rebalanced')).toHaveLength(0);
      expect(rows.filter((row) => row.event === 'launch-provider-weekly-unmeasured')).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ requestedProvider: 'grok', selectedProvider: 'grok', weeklyUsedPct: null, reason: '측정 불가' }) }),
      ]);
      expect(lines.join('')).toContain('측정 불가');
    } finally { log.mockRestore(); write.mockRestore(); }
  });

  test('configured cap is applied rather than the default; non-grok child skips the weekly read', () => {
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, grokWeeklyCapPct: 60 } }));
    expect(buildDevCliSpec({ text: 'goal' }, { kind: 'self' }, { childLlmProvider: 'grok' }, undefined, 'cli-dev-ask', () => 'usable', () => 60).self?.childLlm?.provider).toBe('openai-codex');
    expect(buildDevCliSpec({ text: 'goal' }, { kind: 'self' }, { childLlmProvider: 'openai-codex' }, undefined, 'cli-dev-ask', () => { throw new Error('must not read quota'); }, () => { throw new Error('must not read weekly'); }).self?.childLlm?.provider).toBe('openai-codex');
  });
});

describe('parent LLM quota warning', () => {
  test('warns only when the parent provider is grok and grok is exhausted, reading quota only for grok', async () => {
    const { warnParentLlmQuota } = await import('./dev-cli.js');
    const lines: string[] = [];
    let reads = 0;
    const read = (v: 'usable' | 'exhausted' | 'unknown') => () => { reads++; return v; };
    expect(warnParentLlmQuota('grok', read('exhausted'), (l) => lines.push(l))).toBe(true);
    expect(lines.join('')).toContain('부모 LLM(리뷰·판정) = config llm.provider grok');
    expect(warnParentLlmQuota('grok', read('unknown'), (l) => lines.push(l))).toBe(false);
    expect(warnParentLlmQuota('grok', read('usable'), (l) => lines.push(l))).toBe(false);
    reads = 0;
    expect(warnParentLlmQuota('openai-codex', read('exhausted'), (l) => lines.push(l))).toBe(false);
    expect(reads).toBe(0);
    expect(lines).toHaveLength(1);
  });
});
