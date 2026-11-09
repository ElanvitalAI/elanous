import { parseSeatTurnCapConfig, type SeatTurnCapConfig } from '../core-turn/seat-turn-cap.js';
import { clampNum, positiveIntOr, str } from './coercion.js';

// ── Chat presentation ───────────────────────────────────────────────
// Dashboard/system-prompt level presentation heuristics. Kept under
// user-config so every threshold is tunable and the prompt module can
// stay pure. P1 restores the missing `chat` wrapper from the pre-#600
// shape, then adds the first subtree: `chat.conciseness`.

export interface ChatConcisenessConfig {
  enabled: boolean;
  finalMessageMaxLines: number;
  preambleMaxWords: number;
  flatBullets: boolean;
}

export interface ChatToolOutputConfig {
  persistOnOverflow: boolean;
  retentionDays: number;
  previewLines: number;
}

export interface ChatAutoCompactConfig {
  enabled: boolean;
  triggerRatio: number;
  preserveLastN: number;
  /** ★ 핵심 앵커 보존(2026-07-21) — Layer 3 요약이 뭉개면 안 되는 **맨 앞 앵커**
   *  (페이즈 프롬프트/WM/premise = 첫 user 메시지) pin 개수. 리딩 system 메시지가
   *  앞서도 첫 user 메시지까지 자동 확장. 기본 1(첫 앵커 pin). 0=비활성(롤백 seam). */
  preserveFirstN: number;
  partial: boolean;
  workingBudgetTokens: number;
}

export interface ChatSystemPromptConfig {
  overridePath?: string;
  taskVariant: string;
  /** Optional builtin prompt-family override. When set, bypasses
   *  model-family inference and forces one of the builtin variants.
   *  Useful for A/B testing Codex vs GPT lane behavior without
   *  patching the registry. */
  forceBuiltinVariant?: 'gpt' | 'codex' | 'claude' | 'local';
}

export type ChatRenderingStreamingMode = 'byte' | 'line';

export interface ChatRenderingStreamingConfig {
  mode: ChatRenderingStreamingMode;
  catchUpThresholdLines: number;
  catchUpAgeMs: number;
}

/** Legacy exported type name; the compact boundary no longer has configurable fields. */
export interface ChatRenderingCompactBoundaryConfig {}

export interface ChatRenderingWrapConfig {
  urlAware: boolean;
}

export type ChatRenderingToolDisplayMode = 'legacy' | 'inline-to-block';

export interface ChatRenderingToolConfig {
  displayMode: ChatRenderingToolDisplayMode;
  blockMaxLines: number;
}

export type ChatRenderingDiffColorTier = 'auto' | 'truecolor' | '256' | 'ansi16';
export type ChatRenderingDiffHeaderStyle = 'legacy' | 'edited';
export type ChatRenderingDiffTurnBrowserMode = 'all' | 'files' | 'turns';

export interface ChatRenderingDiffConfig {
  colorTier: ChatRenderingDiffColorTier;
  headerStyle: ChatRenderingDiffHeaderStyle;
  turnBrowserHistory: number;
  turnBrowserMode: ChatRenderingDiffTurnBrowserMode;
}

export interface ChatRenderingHudConfig {
  gaugeWarnRatio: number;
  gaugeDangerRatio: number;
}

export interface ChatRenderingConfig {
  streaming: ChatRenderingStreamingConfig;
  wrap: ChatRenderingWrapConfig;
  tool: ChatRenderingToolConfig;
  diff: ChatRenderingDiffConfig;
  hud: ChatRenderingHudConfig;
}

/** PR2 (HANDOFF 2026-05-04 §5.2) — knobs for the 4-layer compact
 *  pipeline. `verifyProbe` opts into Wave 5's Gemini-style verify
 *  step before accepting a Layer 3 summary. `archive*` controls the
 *  per-session JSONL archive at ~/.elanous/compact-archive/. */
export interface ChatCompactConfig {
  verifyProbe: boolean;
  archiveEnabled: boolean;
  archiveRetentionDays: number;
  archiveRetentionMb: number;
}

export interface ChatConfig {
  factQuestion: { maxToolTurns: number };
  /** TUI-SEAT-TURN-CAP — 자리 TUI goal loop 한정 core 턴 상한 덮어쓰기(기본값 = core-turn/seat-turn-cap.ts). 설정했을 때만 있다. */
  seatTurnCap?: Partial<SeatTurnCapConfig>;
  /** Short questions may receive a tool-free first reply. Default true. */
  fastPath: boolean;
  conciseness: ChatConcisenessConfig;
  toolOutput: ChatToolOutputConfig;
  autoCompact: ChatAutoCompactConfig;
  compact: ChatCompactConfig;
  autoCopyQaToClipboard: boolean;
  systemPrompt: ChatSystemPromptConfig;
  rendering: ChatRenderingConfig;
  /** Wave 8 (2026-05-04) — tool deny list. Names matching here are
   *  filtered out of every model's tool catalog before the LLM call.
   *  Useful for security / budget control (e.g. block `WebFetch` in
   *  air-gapped environments, or `mcp__github` to disable a whole
   *  MCP server). Matching: exact tool name OR `mcp__<server>` prefix
   *  (matches all tools from that MCP server). Empty array = no
   *  filtering. ref/claude-code-fork `filterToolsByDenyRules` pattern
   *  (`src/tools.ts:262-269`). */
  toolDeny: string[];
}

const CHAT_CONCISENESS_DEFAULTS: ChatConcisenessConfig = {
  enabled: true,
  finalMessageMaxLines: 10,
  preambleMaxWords: 12,
  flatBullets: true,
};

export const CHAT_DEFAULTS: ChatConfig = {
  factQuestion: { maxToolTurns: 6 },
  fastPath: true,
  conciseness: { ...CHAT_CONCISENESS_DEFAULTS },
  toolOutput: {
    persistOnOverflow: true,
    retentionDays: 7,
    previewLines: 8,
  },
  autoCompact: {
    enabled: true,
    triggerRatio: 0.85,
    preserveLastN: 4,
    preserveFirstN: 1,
    partial: true,
    workingBudgetTokens: 256_000,
  },
  compact: {
    verifyProbe: false,
    archiveEnabled: true,
    archiveRetentionDays: 30,
    archiveRetentionMb: 100,
  },
  autoCopyQaToClipboard: false,
  systemPrompt: {
    overridePath: undefined,
    taskVariant: 'default',
    forceBuiltinVariant: undefined,
  },
  toolDeny: [],
  rendering: {
    streaming: {
      mode: 'byte',
      catchUpThresholdLines: 50,
      catchUpAgeMs: 200,
    },
    wrap: {
      urlAware: false,
    },
    tool: {
      displayMode: 'inline-to-block',
      blockMaxLines: 8,
    },
    diff: {
      colorTier: 'auto',
      headerStyle: 'legacy',
      turnBrowserHistory: 8,
      turnBrowserMode: 'all',
    },
    hud: {
      gaugeWarnRatio: 0.7,
      gaugeDangerRatio: 0.85,
    },
  },
};


/** Normalize the chat axis from the raw user config without involving unrelated sections. */
export function parseChatConfig(raw: unknown): ChatConfig {
  const chat = (raw ?? {}) as Record<string, unknown>;
  const chatFactQuestion = (chat.factQuestion && typeof chat.factQuestion === 'object' && !Array.isArray(chat.factQuestion))
    ? chat.factQuestion as Record<string, unknown> : {};
  const chatConciseness = (chat.conciseness ?? {}) as Record<string, unknown>;
  const chatToolOutput = (chat.toolOutput ?? {}) as Record<string, unknown>;
  const chatAutoCompact = (chat.autoCompact ?? {}) as Record<string, unknown>;
  const chatCompact = (chat.compact ?? {}) as Record<string, unknown>;
  const chatSystemPrompt = (chat.systemPrompt ?? {}) as Record<string, unknown>;
  return {
      factQuestion: {
        maxToolTurns: typeof chatFactQuestion.maxToolTurns === 'number'
          && Number.isSafeInteger(chatFactQuestion.maxToolTurns) && chatFactQuestion.maxToolTurns > 0
          ? chatFactQuestion.maxToolTurns : CHAT_DEFAULTS.factQuestion.maxToolTurns,
      },
      ...((): { seatTurnCap?: Partial<SeatTurnCapConfig> } => { const c = parseSeatTurnCapConfig(chat.seatTurnCap); return c ? { seatTurnCap: c } : {}; })(),
      fastPath: chat.fastPath === false || chat.fastPath === 'false' ? false : CHAT_DEFAULTS.fastPath,
      conciseness: {
        enabled: chatConciseness.enabled === false ? false : CHAT_CONCISENESS_DEFAULTS.enabled,
        finalMessageMaxLines: clampNum(
          chatConciseness.finalMessageMaxLines,
          CHAT_CONCISENESS_DEFAULTS.finalMessageMaxLines,
          1,
          100,
        ),
        preambleMaxWords: clampNum(
          chatConciseness.preambleMaxWords,
          CHAT_CONCISENESS_DEFAULTS.preambleMaxWords,
          1,
          50,
        ),
        flatBullets: chatConciseness.flatBullets === false ? false : CHAT_CONCISENESS_DEFAULTS.flatBullets,
      },
      toolOutput: {
        persistOnOverflow: chatToolOutput.persistOnOverflow === false ? false : CHAT_DEFAULTS.toolOutput.persistOnOverflow,
        retentionDays: clampNum(
          chatToolOutput.retentionDays,
          CHAT_DEFAULTS.toolOutput.retentionDays,
          1,
          365,
        ),
        previewLines: clampNum(
          chatToolOutput.previewLines,
          CHAT_DEFAULTS.toolOutput.previewLines,
          1,
          500,
        ),
      },
      autoCompact: {
        enabled: chatAutoCompact.enabled === false ? false : CHAT_DEFAULTS.autoCompact.enabled,
        triggerRatio: clampNum(
          chatAutoCompact.triggerRatio,
          CHAT_DEFAULTS.autoCompact.triggerRatio,
          0.5,
          0.99,
        ),
        preserveLastN: clampNum(
          chatAutoCompact.preserveLastN,
          CHAT_DEFAULTS.autoCompact.preserveLastN,
          0,
          100,
        ),
        preserveFirstN: clampNum(
          chatAutoCompact.preserveFirstN,
          CHAT_DEFAULTS.autoCompact.preserveFirstN,
          0,
          100,
        ),
        partial: chatAutoCompact.partial === false ? false : CHAT_DEFAULTS.autoCompact.partial,
        workingBudgetTokens: positiveIntOr(
          chatAutoCompact.workingBudgetTokens,
          CHAT_DEFAULTS.autoCompact.workingBudgetTokens,
        ),
      },
      compact: {
        verifyProbe: chatCompact.verifyProbe === true,
        archiveEnabled: chatCompact.archiveEnabled === false ? false : CHAT_DEFAULTS.compact.archiveEnabled,
        archiveRetentionDays: clampNum(
          chatCompact.archiveRetentionDays,
          CHAT_DEFAULTS.compact.archiveRetentionDays,
          0,
          365,
        ),
        archiveRetentionMb: clampNum(
          chatCompact.archiveRetentionMb,
          CHAT_DEFAULTS.compact.archiveRetentionMb,
          0,
          10_000,
        ),
      },
      autoCopyQaToClipboard:
        chat.autoCopyQaToClipboard === true
          ? true
          : CHAT_DEFAULTS.autoCopyQaToClipboard,
      // Wave 8 — toolDeny: accept readonly string[] from raw config,
      // filter to non-empty strings, dedupe. No clamp on length —
      // the catalog has ~150 tools, blocking ~10 is reasonable.
      toolDeny: (() => {
        const raw = (chat as { toolDeny?: unknown }).toolDeny;
        if (!Array.isArray(raw)) return [];
        const cleaned: string[] = [];
        const seen = new Set<string>();
        for (const item of raw) {
          if (typeof item !== 'string') continue;
          const trimmed = item.trim();
          if (trimmed.length === 0) continue;
          if (seen.has(trimmed)) continue;
          seen.add(trimmed);
          cleaned.push(trimmed);
        }
        return cleaned;
      })(),
      systemPrompt: {
        overridePath: str(chatSystemPrompt.overridePath),
        taskVariant: str(chatSystemPrompt.taskVariant) ?? CHAT_DEFAULTS.systemPrompt.taskVariant,
        forceBuiltinVariant: (() => {
          const raw = str(chatSystemPrompt.forceBuiltinVariant)?.toLowerCase();
          return raw === 'gpt' || raw === 'codex' || raw === 'claude' || raw === 'local'
            ? raw
            : CHAT_DEFAULTS.systemPrompt.forceBuiltinVariant;
        })(),
      },
      rendering: structuredClone(CHAT_DEFAULTS.rendering),
    };
}

