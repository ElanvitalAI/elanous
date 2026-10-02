import { describe, expect, it } from 'bun:test';
import { executeUsageSlash } from './usage-slash.js';
import type { UnifiedUsageDeps } from '../../budget/unified-usage.js';
import { visibleWidth } from '../../tui.js';

const deps: UnifiedUsageDeps = {
  listCodexAccounts: () => [{ name: 'account-name-that-exceeds-the-remaining-width-by-a-lot', storeKey: 'team' }],
  loadCodexHome: () => '/tmp/team',
  fetchCodex: async () => ({
    provider: 'codex',
    windows: [{ kind: 'weekly', windowMinutes: 10_080, limit: 100, used: 25, remainingPercent: 75, resetsAt: Date.now() + 3 * 3_600_000 }],
    credits: { balance: 12, hasCredits: true, unlimited: false },
    fetchedAt: 1,
    source: 'cli-rpc',
  }),
  resolveGrokCredential: () => null,
  openRouterKey: () => undefined,
};

describe('/remaining and /usage compact view', () => {
  it.each(['remaining', 'usage'])('%s: one row per account, width and CLI pointer', async (name) => {
    const result = await executeUsageSlash({ name, args: [], width: 65 }, deps);
    expect(result?.logLines).toHaveLength(2);
    expect(result?.logLines[0]).toContain('codex account-n…');
    expect(result?.logLines[0]).toContain('… · 남은 75% · 주간 3시간 뒤에 다시 참 · 크레딧 12');
    expect(result?.logLines[0]).not.toMatch(/USAGE_PERIOD_TYPE|T\d\d:\d\d:\d\d|Z/);
    expect(result?.logLines.every((line) => visibleWidth(line) <= 65)).toBe(true);
    expect(result?.logLines.at(-1)).toBe('자세히: elanous usage');
  });

  it.each(['remaining', 'usage'])('%s: 안내문 전체가 들어가는 최소 폭에서는 줄이 넘치지 않는다', async (name) => {
    const width = visibleWidth('자세히: elanous usage');
    const result = await executeUsageSlash({ name, args: [], width }, deps);
    expect(result?.logLines).toHaveLength(2);
    expect(result?.logLines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(result?.logLines.at(-1)).toBe('자세히: elanous usage');
  });

  it.each(['remaining', 'usage'])('%s: 10칸에서도 실제 출력의 모든 행이 폭 안에 든다', async (name) => {
    const result = await executeUsageSlash({ name, args: [], width: 10 }, deps);
    expect(result?.logLines).toHaveLength(2);
    expect(visibleWidth('자세히: elanous usage')).toBeGreaterThan(10);
    expect(result?.logLines.every((line) => visibleWidth(line) <= 10)).toBe(true);
    expect(result?.logLines.at(-1)).toBe('elanous…');
  });

  it('폭을 지정하지 않으면 120칸이고 모르는 잔량을 0으로 바꾸지 않는다', async () => {
    const result = await executeUsageSlash({ name: 'remaining', args: [] }, {
      ...deps,
      fetchCodex: async () => { throw new Error('credential-is-private'); },
    });
    expect(result?.logLines[0]).toContain('잔량 모름');
    expect(result?.logLines[0]).not.toContain('credential-is-private');
    expect(result?.logLines.at(-1)).toBe('자세히: elanous usage');
    expect(result?.logLines.every((line) => visibleWidth(line) <= 120)).toBe(true);
  });
});
