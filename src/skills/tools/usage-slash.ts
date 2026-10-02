// Slash commands: /usage and /remaining — compact TUI view of the unified report.

import { collectUnifiedUsage, formatUsageCompact, type UnifiedUsageDeps } from '../../budget/unified-usage.js';
import { visibleWidth } from '../../tui.js';
import type { SlashExecuteRequest, SlashExecuteResult } from './dashboard-slash.js';

export interface UsageSlashResult extends SlashExecuteResult {
  ok: boolean;
  logLines: string[];
}

export async function executeUsageSlash(
  req: SlashExecuteRequest & { width?: number },
  deps: UnifiedUsageDeps = {},
): Promise<UsageSlashResult | null> {
  if (req.name !== 'usage' && req.name !== 'remaining') return null;
  const report = await collectUnifiedUsage(deps);
  const width = req.width ?? 120;
  const hint = ['자세히: elanous usage', 'elanous usage', 'elanous…', '…']
    .find((text) => visibleWidth(text) <= width) ?? '';
  return {
    ok: true,
    name: req.name,
    args: req.args,
    logLines: [...formatUsageCompact(report, { width, nowMs: Date.now() }), hint],
  };
}
