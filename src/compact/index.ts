// /compact barrel — Phase WF6 + Wave 2 (no-LLM pipeline).

export {
  compactConversation,
  compactConversationPartial,
  getCompactSystemPrompt,
  buildCompactTranscript,
  stripCompactScratchpad,
  type CompactOptions,
  type CompactPartialOptions,
  type CompactResult,
} from './summarize.js';

export {
  appendCompactToMemory,
} from './artifacts.js';

export {
  shouldAutoCompact,
  type AutoCompactDecision,
} from './auto.js';

// ── Wave 2 (2026-05-04) · no-LLM Layer 1+2 pipeline ─────────────────
// Layer 1: tool-output budget (Gemini-style file pointer trim).
// Layer 2: microcompact (Claude-style time-based clear).
// Coexists with the WF6 LLM summarize path above — Layer 3 / 4
// (Waves 4 / 5) will plug in over the same orchestrator.

export {
  DEFAULT_COMPACT_POLICY,
  type CompactPolicy,
  type CompactPipelineResult,
  type CompactArchiveEntry,
} from './types.js';
export {
  applyToolOutputBudget,
  type ToolOutputBudgetOpts,
  type ToolOutputBudgetResult,
} from './tool-output-budget.js';
export {
  applyMicrocompact,
  type MicrocompactOpts,
  type MicrocompactResult,
} from './microcompact.js';
export {
  truncateProportional,
  type TruncateProportionalOpts,
} from './truncate-proportional.js';
export {
  runCompactPipeline,
  isHumanUserMessage,
  USER_BUDGET_TRANSFER_MARKER,
  type RunCompactOpts,
} from './pipeline.js';
export {
  appendArchiveEntry,
  archivePath,
  cleanupArchiveDir,
  formatInspectOutput,
  formatSessionList,
  getDefaultArchiveDir,
  inspectArchive,
  listArchiveSessions,
  resetArchiveRetentionForTest,
  scheduleArchiveRetentionOnce,
  type ArchiveSessionSummary,
  type InspectArchiveResult,
} from './archive.js';
export {
  buildCompactSlashCommand,
  runCompactSlash,
  type CompactSlashCommandDescriptor,
  type CompactSlashRunArgs,
  type CompactSlashRunResult,
} from './compact-slash.js';
export {
  getDefaultCompactProvider,
  resolveSummarizerModel,
  type CompactProvider,
  type CompactSummarizeArgs,
  type CompactSummarizeResult,
  COMPACT_UNKNOWN_MODEL_CONTEXT_WINDOW,
} from './provider.js';
export {
  recordAutoCompactSuccess,
  recordAutoCompactFailure,
  isAutoCompactBreakerTripped,
  getAutoCompactBreakerReason,
  resetAutoCompactBreaker,
  setVerifyProbeEnabled,
  isVerifyProbeEnabled,
  resetAutoCompactStateForTest,
} from './auto-state.js';
export {
  runVerifyProbe,
  type VerifyProbeArgs,
  type VerifyProbeResult,
} from './verify-probe.js';
