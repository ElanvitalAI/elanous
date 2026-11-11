import { expect, test } from 'bun:test';
import { NEXT_TUI_INPUT_CONTEXT, buildNextTuiHelpLines, resolveNextTuiRoute } from '../core/registry.js';
import type { UnifiedUsageDeps } from '../../budget/unified-usage.js';
import type { UsageSnapshot } from '../../budget/types.js';
import { handleNextTuiRemainingSlash, runNextTuiRemainingBranchRoute } from './remaining.js';

test('/remaining dispatch reaches the shared usage report and renders account-specific remaining usage', async () => {
  const route = resolveNextTuiRoute('/remaining', NEXT_TUI_INPUT_CONTEXT);
  expect(route?.id).toBe('remaining');
  expect(resolveNextTuiRoute('/remaining all', NEXT_TUI_INPUT_CONTEXT)?.id).toBe('remaining');
  expect(buildNextTuiHelpLines().join('\n')).toContain('/remaining — 통합 사용량과 남은 할당량');

  // Fixture values are data, not source bounds; parse them as one JSON string like the usage contract fixtures.
  const snapshot = JSON.parse('{"provider":"codex","windows":[{"kind":"weekly","windowMinutes":10080,"limit":100,"used":63,"remainingPercent":37,"resetsAt":1900000000000}],"credits":{"balance":0,"hasCredits":false,"unlimited":false},"fetchedAt":1700000000000,"source":"cli-rpc"}') as UsageSnapshot;
  const deps: UnifiedUsageDeps = {
    listCodexAccounts: () => [{ name: 'team-sim', storeKey: 'codex-team' }],
    loadCodexHome: () => undefined,
    fetchCodex: async () => snapshot,
    listCodexResetCredits: async () => ({ ok: true, value: { credits: [], availableCount: 0, totalEarnedCount: 0 } }),
    fetchGrok: async () => ({ status: 'unauthorized' }),
    resolveGrokCredential: () => null,
    resolveClaudeToken: () => null,
    openRouterKey: () => undefined,
    zaiKey: () => undefined,
    now: () => 1_700_000_000_000,
  };
  const lines: string[] = [];
  await handleNextTuiRemainingSlash(['all'], { chatLines: lines, setChatScrollOffset: () => {}, muted: (v) => v, accent: (v) => v, text: (v) => v, error: (v) => v, warning: (v) => v, info: (v) => v }, undefined, deps);

  expect(lines.some((line) => line.includes('codex') && line.includes('37%'))).toBe(true);
});

test('/remaining displays a safe message when the shared usage report is unavailable', async () => {
  const lines: string[] = [];
  await runNextTuiRemainingBranchRoute('/remaining', { addLines: (...items) => lines.push(...items) }, async () => null);
  expect(lines).toEqual(['남은 사용량을 읽을 수 없습니다.']);
});
