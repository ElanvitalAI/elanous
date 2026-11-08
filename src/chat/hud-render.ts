import { basename } from 'node:path';
import { C } from '../tui.js';
import type { ActiveProviderInfo } from '../provider-summary.js';
import type { ChatRenderingHudConfig, ChatSystemPromptConfig } from '../user-config/chat.js';
import { resolveChatSystemPrompt } from '../prompt-library/registry.js';

const GAUGE_GLYPHS = ['▁', '▂', '▃', '▅', '▇', '█'] as const;

export type HudGaugeTone = 'normal' | 'warn' | 'danger';

export interface VariantBadgeInput {
  providerInfo: ActiveProviderInfo;
  systemPrompt: ChatSystemPromptConfig;
  width: number;
}

export function renderVariantBadge(input: VariantBadgeInput): string {
  const taskVariant = input.systemPrompt.taskVariant && input.systemPrompt.taskVariant !== 'default'
    ? ` · ${input.systemPrompt.taskVariant}`
    : '';
  if (input.systemPrompt.overridePath) {
    const label = input.systemPrompt.overridePath
      ? `↯ override · ${basename(input.systemPrompt.overridePath)}${taskVariant}`
      : `↯ override${taskVariant}`;
    return C.peach(label);
  }
  const resolved = resolveChatSystemPrompt({
    model: input.providerInfo.model,
    config: input.systemPrompt,
  });
  const provider = input.providerInfo.provider.replace(/^auto:/, '');
  const full = `↯ ${provider} · ${resolved.variant}${taskVariant}`;
  const compact = `↯ ${resolved.variant}${taskVariant}`;
  return C.info(input.width >= 72 ? full : compact);
}

export function resolveGaugeTone(
  ratio: number,
  cfg: Pick<ChatRenderingHudConfig, 'gaugeWarnRatio' | 'gaugeDangerRatio'>,
): HudGaugeTone {
  if (ratio >= cfg.gaugeDangerRatio) return 'danger';
  if (ratio >= cfg.gaugeWarnRatio) return 'warn';
  return 'normal';
}

export function renderTokenGauge(
  used: number,
  max: number,
  cfg: Pick<ChatRenderingHudConfig, 'gaugeWarnRatio' | 'gaugeDangerRatio'>,
): string {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.max(0, Math.min(1, used / safeMax));
  const idx = Math.min(GAUGE_GLYPHS.length - 1, Math.floor(ratio * (GAUGE_GLYPHS.length - 1) + 0.0001));
  const glyph = GAUGE_GLYPHS[idx]!;
  const pct = `${Math.round(ratio * 100)}%`;
  const body = `ctx ${glyph} ${pct}`;
  switch (resolveGaugeTone(ratio, cfg)) {
    case 'danger': return C.error(body);
    case 'warn': return C.warning(body);
    default: return C.muted(body);
  }
}
