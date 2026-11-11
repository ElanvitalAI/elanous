// ── User config ──
//
// Reads the ACTIVE instance config for user-tunable behaviour that lives
// outside environment variables and outside individual SKILL.md frontmatter.
//
// ⛔ The path is NOT fixed — it is the resolved config dir (`elanous where`).
//    📏 2026-09-22 실측: `~/.config/elanous/config.json` 은 «없다»(그 자리는 legacy)이고
//       실물은 `~/.elanous/config.json` 이다. 옛 경로는 legacy-elanous-config-migrate.ts 가 «정당하게» 쓴다.
//    ⚠️ 그래서 여기에 경로를 «박지 않는다» — 박으면 또 늙는다(이 줄이 그렇게 늙었다).
//
// Sections:
//   - skillRouter — Phase 2 router gating (kept for back-compat).
//   - llm         — provider choice, API key, model, base URL.
//   - skills      — list of skill root dirs + active preset name.
//   - obsidian    — vault path.
//   - telegram    — bot token, allowlist, home channel.
//   - onboarding  — first-run marker so the wizard only fires once.
//
// Design principles:
//   - Absent file → default object.
//   - Malformed JSON → default object.
//   - Unknown keys are preserved in `raw` for forward-compat.
//   - Typed getters coerce to defaults when types are wrong.
//   - Cache is process-wide and opt-in reload.
//
// saveUserConfig() atomically writes the config (tmp → rename) so a
// crashed wizard cannot corrupt an existing file. Mode 0600 when the
// telegram bot token is present.

import type {
  SkillRouterConfig, LLMProviderName, LLMConfig, SkillSetName, UserConfig, SkillSource,
  DefaultSkillDirsOptions, SkillsConfig, ObsidianConfig, TelegramReportChannel, TelegramTestChannel, TelegramChannel,
  TelegramConfig, DiscordTestChannel, DiscordConfig, OnboardingConfig, BudgetGateMaxUsedPercent, NativeStructureToolConfig,
  ToolsConfig, DebugConfig, LogsConfig, ShellConfig, ErrorReportsConfig, DashboardPromptBankConfig,
  VwKnownName, VwEntryConfig, VwConfig, AcpConfig, PlanConfig, GoalsConfig,
  RegistryConfig, TasteConfig, OpenDesignConfig, DesignConfig, WebSearchConfig, SessionFabricConfig,
  ApnsUserConfig, NotificationsConfig, McpTransport, McpServerSpec, McpConfig, AsideConfig,
  AsideRemoteTargetConfig, BackgroundReasoningLlmConfig, BackgroundReasoningConfig, RunDevHarnessToolConfig, SelfOrchestrateToolConfig, DeferredToolsMode,
  SelfImplementChildInstanceMode, SelfImplementClarificationEscalationConfig, ChildLlmPreferenceConfig, ChildLlmPreferenceMode, ChildLlmChainEntry, HarnessBudgetGateConfig,
  BudgetGateOnShortfall, LspConfig, VoiceSttProviderId, VoiceTtsProviderId, VoiceVadMode, VoiceDiscordChannelListenFilter,
  VoiceTelegramDispatchMode, IntakeAmbientCaptureMode, FinanceConfig, SubscriptionReviewerSpec, ReviewerMixSpec, ModelRole,
  RoleLlmResolution, RoleLlmSpec, RoleLlmConfig, SetLaunchRoleLlmOptions, RoleLlmResolveOptions, RoleLlmSource,
  AgentModelRole, ModelResolution, ModelResolutionSource, EventsConfig, EventRoute, EventSeat,
  GateRemoteConfig, ProjectConfig, RoleModelConfig, RoleModelTierConfig, AutoReviewConfig, RetiredConfigKey,
  SeatLoopConfig, HqFenceRole, HqConfig, VoiceTelegramReplyMode, LspLanguageConfig, AcpHopCapConfig,
  RotationEntry, ReasoningLevel, MaxTurnsBudget, MissionRoutingConfig, LlmRoutePolicyConfig, AutoRouteConfig,
} from "./user-config/types.js";
export type {
  SkillRouterConfig, LLMProviderName, ReasoningLevel, LLMConfig, AutoRouteConfig, MissionRoutingConfig,
  LlmRoutePolicyConfig, RotationEntry, SkillSetName, SkillSourceKind, SkillSource, SkillsConfig,
  DefaultSkillDirsOptions, ObsidianConfig, TelegramReportChannel, TelegramTestChannel, TelegramChannel, TelegramConfig,
  DiscordTestChannel, DiscordConfig, OnboardingConfig, DeferredToolsMode, DeferredToolsConfig, AgentSpawnConfig,
  SelfImplementAutoStopConfig, SelfImplementAutoAssistConfig, SelfImplementScreenStallTerminationConfig, SelfImplementReworkBudgetConfig, SelfImplementDecompositionShadowConfig, SelfImplementClarificationEscalationConfig,
  SelfImplementChildInstanceMode, ChildLlmPreferenceMode, ChildLlmChainEntry, ChildLlmPreferenceConfig, BudgetGateOnShortfall, BudgetGateMaxUsedPercent,
  HarnessBudgetGateConfig, SelfImplementToolConfig, RunDevHarnessToolConfig, SelfOrchestrateToolConfig, NativeStructureToolConfig, ToolsConfig,
  DebugConfig, LogsConfig, ShellConfig, ErrorReportsConfig, DashboardConfig, DashboardPromptBankConfig,
  VwKnownName, VwEntryConfig, VwConfig, AcpHopCapConfig, AcpConfig, PlanConfig,
  GoalsConfig, RegistryDiscoveryCronConfig, RegistryDiscoveryFirecrawlConfig, RegistryDiscoveryConfig, RegistryConfig, SessionFabricConfig,
  TasteConfig, WebSearchConfig, OpenDesignConfig, DesignConfig, ApnsUserConfig, NotificationsConfig,
  McpTransport, McpStdioServerSpec, McpHttpServerSpec, McpServerSpec, McpConfig, AsideRemoteTargetConfig,
  AsideConfig, BackgroundReasoningLlmConfig, BackgroundReasoningConfig, LspLanguageConfig, LspConfig, VoiceSttProviderId,
  VoiceTtsProviderId, VoiceVadMode, VoiceSttMode, VoiceSttConfig, VoiceTtsConfig, VoiceVadConfig,
  VoiceChatConfig, VoiceTelegramReplyMode, VoiceTelegramDispatchMode, VoiceDiscordChannelListenFilter, IntakeAmbientCaptureMode, VoiceTelegramConfig,
  VoiceDiscordConfig, VoicePwaConfig, VoiceConfig, IntakeSurfaceConfig, IntakeConfig, FinanceConfig,
  AutoReviewConfig, ModelRole, AgentModelRole, RoleModelConfig, RoleModelTierConfig, RoleLlmSpec,
  SubscriptionReviewerSpec, ReviewerMixSpec, RoleLlmConfig, ModelResolutionSource, RoleLlmSource, RoleLlmResolution,
  ModelResolution, SetLaunchRoleLlmOptions, RoleLlmResolveOptions, StewardLoopMode, SeatLoopMode, PersonaLoopConfig,
  SeatLoopConfig, EventSeat, EventRoute, EventsConfig, HqFenceRole, HqConfig,
  GateRemoteConfig, ProjectConfig, UserConfig, RetiredConfigKey, MaxTurnsBudget,
} from "./user-config/types.js";

import { isRuntimeLlmModelCompatibleWithProvider } from './llm/runtime-model-family.js';
import { isRecord } from './primitives/guards.js';
export { inferRuntimeLlmModelFamily, isRuntimeLlmModelCompatibleWithProvider } from './llm/runtime-model-family.js';
export type { RuntimeLlmModelFamily } from './llm/runtime-model-family.js';
import { DRAFT_ON_STOP_MODES, parseDraftOnStopMode, type DraftOnStopMode } from './self-implement/draft-on-stop-mode.js';
import { isCodexQuotaPolicy } from './oauth/codex-quota-policy.js';
import { defaultObsidianVault } from './obsidian/default-vault.js';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync,
  statSync, accessSync, constants as fsConstants,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, dirname } from 'node:path';
import {
  REMOTE_HOME,
  GROK_MODEL,
  OPENAI_MODEL,
  ANTHROPIC_MODEL,
  LOCAL_LLM_MODEL,
  GEMINI_MODEL,
  KIMI_MODEL,
  QWEN_MODEL,
  GLM_MODEL,
} from './config.js';
import type { SkillTier } from './skills/skill-tier.js';
import { sharedAgentSkillRoots } from './skills/shared-agent-skill-roots.js';
import {
  isModelTier,
  isModelTierProfile,
  type BudgetUserConfig,
  type ModelTier,
  type ModelTierUserConfig,
  type SmartDefaultsUserConfig,
} from './model-tier/types.js';
import { lookupLlmTierSpec } from './model-tier/llm-tier-map.js';
import { BEDROCK_DEFAULT_MODEL } from './llm/bedrock.js';
import { userConfigPath as nexusUserConfigPath } from './nexus/config/paths.js';
import { getElanousConfigDirOverride } from './elanous-config-dir.js';
import { getTestStateRoot } from './nexus/paths.js';
import { type StreamingMode, isStreamingMode } from './session/streaming/stream-compositor.js';
import type { DevRequestRoutingConfig } from './skills/dev-request-router.js';
import type { UrlRoutingConfig } from './skills/url-router.js';
import { migrateLegacyXdgUserConfig } from './storage/legacy-elanous-config-migrate.js';
import { withFileLockSync } from './storage/file-lock.js';
import { debug } from './debug/log.js';
import { setConfigTimeZoneSource } from './time/time-zone.js';
import { parseGeminiServerTools } from './user-config/gemini-server-tools.js';
import { clampNum, numArray, positiveIntOr, str, strArray, stringRecord } from './user-config/coercion.js';
import {
  CLAUDE_PACKAGE_MISSING,
  INSTALLED_PLUGINS_FILENAME,
  KNOWN_MARKETPLACES_FILENAME,
  defaultClaudePluginsRoot,
  readClaudePackageLedger,
} from './plugins/adapters/claude-package.js';
// ⭐ provider↔credential SSOT — provider 를 바꾸는 자리가 키도 함께 해석해야 401 이 안 난다(escalate 근본수리).
import { resolveProviderCredential, observeCredentialResolution } from './llm/provider-credentials.js';
import {
  parseGroundingSources,
  type GroundingConfig,
} from './grounding/sources.js';
import { parseSeatTurnCapConfig, type SeatTurnCapConfig } from './core-turn/seat-turn-cap.js';
import { sparseUserConfig } from './user-config/sparse-config.js';
import { DEFAULT_BASH_APPROVAL, parseBashApprovalMode } from './user-config/shell.js';
import { MAX_TURNS_BUDGET_KEYS } from './user-config/types.js';
import {
  configureUserConfigReader, getUserConfig, resetUserConfig,
  rememberSavedUserConfig,
} from './user-config/read.js';
export {
  buildTestSafeDaemonConfig, getUserConfig, reloadUserConfig, resetUserConfig,
  runWithUserConfigSnapshot, setUserConfigOverlay,
} from './user-config/read.js';
import { readUserConfigObject } from './user-config/read.js';
import { serializeUserConfig } from './user-config/write.js';

configureUserConfigReader({
  defaultPath: () => defaultPath(),
  build: (path) => buildUserConfig(path),
  readMtime: (path) => readMtimeMsOrNull(path),
  resetClaudePackageSkillDirs: () => __resetClaudePackageSkillDirsCacheForTests(),
});

const SR_DEFAULTS: SkillRouterConfig = {
  autoRoute: false,
  autoRouteCountdownMs: 1500,
  llmFallback: false,
  keywordScoreThreshold: 2,
  llmConfidenceThreshold: 0.75,
  fullMenuTier: 'T1',
  fullMenuConfidenceThreshold: 0.85,
  // 2.0 requires either two explicit triggers OR one explicit + two
  // extracted — a lone auto-extracted keyword (0.6) surfaces as a
  // Tab-confirm hint but never fires silently. Tightened from 1.0 in
  // session 21 after observing frequent false-positive auto-routes
  // from short Korean trigger keywords ("요약", "정리") shared across
  // many skills' descriptions.
  autoRouteMinScore: 2.0,
  autoRouteRequireAutoTrigger: true,
  harnessExecAllowlist: [],
};

/** Stored config retains its established provider normalization contract. */
// ⛔ 2026-09-23 — 손으로 적은 목록이라 새 provider 를 «조용히» 거른다: `openrouter` 를 배선(#19900)했는데
//   여기 없어서 config 로 고르면 정규화가 `auto` 로 떨궜다(「직렬화 드롭」). 자 = `test/llm-provider-name-lists.test.ts`.
export const CONFIG_LLM_PROVIDER_NAMES: readonly LLMProviderName[] = [
  'auto', 'grok', 'openai', 'anthropic', 'local', 'openai-codex', 'gemini', 'openrouter', 'opengateway', 'bedrock', 'hq-proxy',
];

/** `ELANOUS_LLM_PROVIDER` additionally permits every declared runtime provider. */
export const RUNTIME_LLM_PROVIDER_NAMES: readonly LLMProviderName[] = [
  'auto', 'grok', 'openai', 'anthropic', 'local', 'openai-codex', 'gemini', 'kimi', 'qwen', 'glm', 'openrouter', 'opengateway', 'bedrock', 'hq-proxy',
];

const LLM_DEFAULTS: LLMConfig = { provider: 'auto', grokWeeklyCapPct: 80 };

export function skillSetDir(name: SkillSetName): string | null {
  switch (name) {
    case 'claudecode': return join(REMOTE_HOME, '.claude', 'skills');
    case 'opencode':   return join(REMOTE_HOME, '.config', 'opencode', 'skills');
    case 'codex':      return join(REMOTE_HOME, '.codex', 'skills');
    case 'hermes':     return join(REMOTE_HOME, '.hermes', 'skills');
    case 'openclaw':   return join(REMOTE_HOME, '.openclaw', 'workspace', 'skills');
    default:           return null;
  }
}

export const SKILL_SET_NAMES: SkillSetName[] = [
  'claudecode', 'opencode', 'codex', 'hermes', 'openclaw', 'custom',
];

/** Resolve the `skills/` directory shipped with this installed package. */
export function bundledSkillsDir(packageRoot: string = dirname(import.meta.dir)): string {
  return join(packageRoot, 'skills');
}

function packageOptIn(cfg?: UserConfig): boolean {
  try { return (cfg ?? getUserConfig()).skills.includeClaudePackageSkills === true; } catch { return false; }
}

/** Stable id for a connected root: the agent it belongs to, else the folder (plugin) name. */
export function skillSourceId(path: string): string {
  if (/[/\\]\.codex[/\\]skills\/?$/.test(path)) return 'codex';
  if (/[/\\]\.claude[/\\]skills\/?$/.test(path)) return 'claude';
  const parts = path.split(/[/\\]/).filter(Boolean);
  const last = parts[parts.length - 1] === 'skills' ? parts[parts.length - 2] : parts[parts.length - 1];
  return `plugin:${last ?? 'skills'}`;
}

/** Parse persisted `skills.sources` ⊕ the dev-only `skills.connected` key into connected sources (deduped by path). */
export function parsePersistedSkillSources(rawSources: unknown, legacyConnected: unknown): SkillSource[] | undefined {
  const out: SkillSource[] = [];
  const seen = new Set<string>();
  const push = (source: SkillSource) => { if (!seen.has(source.path)) { seen.add(source.path); out.push(source); } };
  if (Array.isArray(rawSources)) {
    for (const row of rawSources) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (typeof r.path !== 'string' || !r.path.trim()) continue;
      const path = r.path.trim();
      push({ id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : skillSourceId(path), path, kind: 'connected', enabled: r.enabled !== false });
    }
  }
  if (Array.isArray(legacyConnected)) {
    for (const path of legacyConnected) if (typeof path === 'string' && path.trim()) push({ id: skillSourceId(path.trim()), path: path.trim(), kind: 'connected', enabled: true });
  }
  return out.length ? out : undefined;
}

/**
 * ★ EN5 — the ONE function every reader uses (loader · setup checklist · connect · onboarding).
 * Order is the historical order, so an old config resolves to exactly the old directory list:
 * preset (activeSet/dirs) → shared ~/.agents/skills (only when it exists) → connected → Claude package roots (opt-in).
 * Packaged `skills/` is appended by defaultSkillDirs, not listed here.
 */
export function resolveSkillSources(cfg?: UserConfig, opts?: DefaultSkillDirsOptions): SkillSource[] {
  const claudecode = skillSetDir('claudecode')!; // = ~/.claude/skills (LOCAL_SKILLS_DIR)
  const preset = (paths: string[], id: string): SkillSource[] => paths.map((path, i) => ({ id: paths.length > 1 ? `${id}:${i + 1}` : id, path, kind: 'preset', enabled: true }));
  let sources: SkillSource[] = preset([claudecode], 'claudecode');
  try {
    const sk = (cfg ?? getUserConfig()).skills;
    if (sk.activeSet !== 'custom') {
      const d = skillSetDir(sk.activeSet);
      if (d) sources = preset([d], sk.activeSet);
      else if (sk.dirs.length > 0) sources = preset([...sk.dirs], 'custom');
    } else if (sk.dirs.length > 0) {
      sources = preset([...sk.dirs], 'custom');
    }
    const has = (path: string) => sources.some((source) => source.path === path);
    const shared = sharedAgentSkillRoots({ home: opts?.sharedAgentHome ?? REMOTE_HOME });
    try { debug.log('skills.roots', 'shared-agent', { found: shared.length }); }
    catch { /* discovery remains fail-soft when observation is unavailable */ }
    for (const path of shared) if (!has(path)) sources.push({ id: 'agents', path, kind: 'shared', enabled: true });
    for (const source of sk.sources ?? []) if (!has(source.path)) sources.push({ ...source, kind: 'connected' });
    if (sk.includeClaudePackageSkills === true) {
      for (const path of appendClaudePackageSkillDirs([], opts?.pluginsRoot)) {
        if (!has(path)) sources.push({ id: `package:${skillSourceId(path).replace(/^plugin:/, '')}`, path, kind: 'package', enabled: true });
      }
    }
  } catch { /* fail-soft — config 없거나 파싱 실패 시 기본 경로 */ }
  return sources;
}

export function defaultSkillDirs(
  cfg?: UserConfig,
  opts?: DefaultSkillDirsOptions,
): string[] {
  const sources = resolveSkillSources(cfg, opts);
  const paths = sources.filter((source) => source.enabled).map((source) => source.path);
  // Historical: the package opt-in path also collapsed duplicate user dirs; the plain path kept them (index dedupes later).
  const base = sources.some((source) => source.kind === 'package') || packageOptIn(cfg) ? uniqueSkillDirsPreserveOrder(paths) : paths;
  return appendBundledSkillsDir(base, opts?.bundledSkillsRoot);
}

let claudePackageSkillDirsLedgerReads = 0;

/** 캐시를 걷었으므로 no-op 이다. 시험이 부르던 이름이라 계약을 유지한다. */
export function __resetClaudePackageSkillDirsCacheForTests(): void {
  /* no cache to reset — 원장을 매 호출 다시 읽는다 */
}

export function __claudePackageSkillDirsLedgerReadCountForTests(): number {
  return claudePackageSkillDirsLedgerReads;
}


/** Existence+access check for a Claude package `skills/` dir. Named so a false
 *  "always true" mutation makes the nonexistent-path test fail. Re-run on
 *  every opt-in call so a cached ledger mtime cannot keep a deleted dir or
 *  omit a dir that appeared / became readable after the first read. */
function isExistingClaudePackageSkillDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    accessSync(dir, fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniqueSkillDirsPreserveOrder(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

function collectClaudePackageSkillDirCandidates(pluginsRoot: string): string[] {
  claudePackageSkillDirsLedgerReads += 1;
  try {
    const ledger = readClaudePackageLedger({ pluginsRoot });
    if (ledger.status !== 'ok') return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const pkg of ledger.packages) {
      if (!pkg.installPath || pkg.installPath === CLAUDE_PACKAGE_MISSING) continue;
      const skillsDir = join(pkg.installPath, 'skills');
      if (seen.has(skillsDir)) continue;
      seen.add(skillsDir);
      out.push(skillsDir);
    }
    return out;
  } catch {
    return [];
  }
}

/** ⛔ 캐시하지 않는다 — 원장을 «매 호출» 다시 읽는다.
 *
 *  📏 앞선 판은 `(경로, mtime)` 을 키로 캐시했고 리뷰가 그것을 막았다(2026-09-03 must-fix):
 *    ⓐ 성공 뒤 원장이 «읽기 불가»가 되어도 mtime 이 그대로면 캐시된 경로를 계속 더한다
 *       ⇒ 「원장을 못 읽으면 기존 목록 그대로」라는 이 착지의 수용 기준을 «위반»한다
 *    ⓑ 같은 mtime 으로 내용만 바뀐 재작성도 못 본다
 *  ⇒ 원장은 «파일 둘»이고 JSON 이 작다. 매번 읽는 비용보다 「낡은 답을 준다」가 비싸다.
 *  ⚠️ 이 함수는 opt-in(설정을 켠) 경로에서만 불린다 — 기본 경로는 여기 오지 않는다. */
function readClaudePackageSkillDirCandidates(pluginsRoot?: string): string[] {
  return collectClaudePackageSkillDirCandidates(pluginsRoot ?? defaultClaudePluginsRoot());
}

function appendClaudePackageSkillDirs(base: string[], pluginsRoot?: string): string[] {
  const extra = readClaudePackageSkillDirCandidates(pluginsRoot)
    .filter(isExistingClaudePackageSkillDir);
  return uniqueSkillDirsPreserveOrder([...base, ...extra]);
}

function appendBundledSkillsDir(base: string[], packageRoot?: string): string[] {
  const bundled = bundledSkillsDir(packageRoot);
  if (!isExistingClaudePackageSkillDir(bundled) || base.includes(bundled)) return base;
  return [...base, bundled];
}

/** Defaults for URL→skill auto-routing. enabled=true so the two main
 *  interactive channels (TUI + Telegram) route URLs out of the box;
 *  guard keywords keep code-reference / argumentative uses on the LLM
 *  path (R5/R8). Tunable via user config. */
export function urlRoutingDefaults(): UrlRoutingConfig {
  return {
    enabled: true,
    twoStage: true,
    defaultTargets: ['obsidian'],
    guardKeywords: [
      // code / build intents — URL is a reference, not a digest target
      '참고', '참조', '구현', '고쳐', '수정', '디버그', '리팩', '기반으로',
      '이 코드', '이거 보고', '보고 구현', '보고 만들',
      'implement', 'clone', 'fix', 'debug', 'refactor', 'based on',
      // argumentative / comparative analysis — not a plain digest
      '반박', '비교', '평가해', '검증해',
      // explicit save intent — the URL is data to save, not a digest target
      '저장', '스크랩', 'save', 'bookmark',
    ],
    absorbKeywords: ['absorb', '흡수', '지식화', 'vault', '지식창고'],
    map: { youtube: 'youtube-master', x: 'omni-digest', github: 'omni-digest', web: 'omni-digest' },
    absorbSkill: 'yt-vault',
  };
}

function parseUrlRouting(raw: unknown): UrlRoutingConfig {
  const d = urlRoutingDefaults();
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const m = (r.map && typeof r.map === 'object') ? r.map as Record<string, unknown> : {};
  const skillName = (v: unknown, fb: string) => (typeof v === 'string' && v.trim() ? v.trim() : fb);
  return {
    enabled: r.enabled === false ? false : true,     // default true
    twoStage: r.twoStage === false ? false : true,   // default true
    defaultTargets: strArray(r.defaultTargets, d.defaultTargets),
    guardKeywords: strArray(r.guardKeywords, d.guardKeywords),
    absorbKeywords: strArray(r.absorbKeywords, d.absorbKeywords),
    map: {
      youtube: skillName(m.youtube, d.map.youtube),
      x: skillName(m.x, d.map.x),
      github: skillName(m.github, d.map.github),
      web: skillName(m.web, d.map.web),
    },
    absorbSkill: skillName(r.absorbSkill, d.absorbSkill),
  };
}

export function devRequestRoutingDefaults(): DevRequestRoutingConfig {
  return {
    enabled: true,
    verbs: ['구현해줘', '고쳐줘', '만들어줘', '추가해줘', '수정해줘', '손봐줘', '붙여줄래', '잡아줘', '펴줘', '봉합해줘'],
    guardKeywords: ['어떻게', '왜 이래', '설명해줘', '알려줘', '읽어서', '어디서 쓰이는지', '회상해줘'],
  };
}

function parseDevRequestRouting(raw: unknown): DevRequestRoutingConfig {
  const d = devRequestRoutingDefaults();
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  return {
    enabled: r.enabled === false ? false : true,
    verbs: strArray(r.verbs, d.verbs),
    guardKeywords: strArray(r.guardKeywords, d.guardKeywords),
  };
}

function skillsDefaults(): SkillsConfig {
  // Sprint 10a (2026-04-28) — claudecode promoted to default per user
  // feedback. Priority order in the wizard picker:
  // claudecode → codex → openclaw → hermes → opencode.
  const d = skillSetDir('claudecode');
  return {
    activeSet: 'claudecode',
    dirs: d ? [d] : [],
    giftEndpoint: 'https://elanous.ai',
    allow: [],
    deny: [],
    urlRouting: urlRoutingDefaults(),
    devRequestRouting: devRequestRoutingDefaults(),
  };
}

function obsidianDefaults(): ObsidianConfig {
  return { vault: defaultObsidianVault({ env: process.env, home: REMOTE_HOME }) };
}

/** Parse a stored `telegram.reportChannel` into a typed value, or
 *  undefined when absent/malformed. A finite `chatId` is required; a
 *  non-empty string `botToken` is optional. Malformed input drops to
 *  undefined (feature off) rather than throwing — consistent with the
 *  rest of the strict parser's fail-soft posture. */
function normalizeReportChannel(raw: unknown): TelegramReportChannel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rc = raw as Record<string, unknown>;
  const chatId = typeof rc.chatId === 'number' ? rc.chatId : undefined;
  if (chatId === undefined || !Number.isFinite(chatId)) return undefined;
  const botToken = typeof rc.botToken === 'string' && rc.botToken.trim()
    ? rc.botToken.trim()
    : undefined;
  return botToken ? { chatId, botToken } : { chatId };
}

/** Parse `telegram.testChannel`. Requires a non-empty `botToken`; drops to
 *  undefined otherwise (feature off) — fail-soft, like normalizeReportChannel. */
function normalizeTestChannel(raw: unknown): TelegramTestChannel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const tc = raw as Record<string, unknown>;
  const botToken = typeof tc.botToken === 'string' && tc.botToken.trim()
    ? tc.botToken.trim()
    : undefined;
  if (!botToken) return undefined;
  const allowedUsers = Array.isArray(tc.allowedUsers)
    ? tc.allowedUsers.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : undefined;
  const botUsername = typeof tc.botUsername === 'string' && tc.botUsername.trim()
    ? tc.botUsername.trim()
    : undefined;
  return {
    botToken,
    ...(allowedUsers && allowedUsers.length ? { allowedUsers } : {}),
    ...(botUsername ? { botUsername } : {}),
  };
}

/** 저장된 telegram.channels[] 파싱. 각 항목은 botToken+chatId 필수. fail-soft. */
function normalizeKindRoles(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0));
  return Object.keys(out).length ? out : undefined;
}

function normalizeTelegramChannels(raw: unknown): TelegramChannel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TelegramChannel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const botToken = typeof c.botToken === 'string' && c.botToken.trim() ? c.botToken.trim() : undefined;
    const chatId = typeof c.chatId === 'number' && Number.isFinite(c.chatId) ? c.chatId : undefined;
    if (!botToken || chatId === undefined) continue;
    const botUsername = typeof c.botUsername === 'string' && c.botUsername.trim()
      ? c.botUsername.trim().replace(/^@/, '')
      : undefined;
    out.push({
      name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : `ch-${out.length}`,
      botToken,
      chatId,
      interactive: c.interactive !== false, // 기본 true
      roles: Array.isArray(c.roles) ? c.roles.filter((r): r is string => typeof r === 'string') : [],
      ...(botUsername ? { botUsername } : {}),
    });
  }
  return out.length ? out : undefined;
}

const TELEGRAM_DEFAULTS: TelegramConfig = { enabled: false, allowedUsers: [] };

/** Parse `discord.testChannel`. Requires a non-empty `channelId`;
 *  drops to undefined otherwise (feature off) — fail-soft, mirrors
 *  telegram's normalizeTestChannel. */
function normalizeDiscordTestChannel(raw: unknown): DiscordTestChannel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const tc = raw as Record<string, unknown>;
  const channelId = typeof tc.channelId === 'string' && tc.channelId.trim()
    ? tc.channelId.trim()
    : typeof tc.channelId === 'number' ? String(tc.channelId) : undefined;
  if (!channelId) return undefined;
  const allowedUsers = Array.isArray(tc.allowedUsers)
    ? (tc.allowedUsers as unknown[]).map(v => String(v)).filter(Boolean)
    : undefined;
  const botToken = typeof tc.botToken === 'string' && tc.botToken.trim() ? tc.botToken.trim() : undefined;
  return {
    channelId,
    ...(allowedUsers && allowedUsers.length ? { allowedUsers } : {}),
    ...(botToken ? { botToken } : {}),
  };
}

const DISCORD_DEFAULTS: DiscordConfig = { enabled: false, allowedUsers: [] };

const ONBOARDING_VERSION = 1;

const ONBOARDING_DEFAULTS: OnboardingConfig = { completed: false, version: 0 };

/**
 * 대표 2026-09-26 상한. codex 계정은 95% 이상이면 그 계정을 안 쓰고,
 * grok 은 주간 최대 50% 중 🅢 가드 48% 에서 멈춘다.
 * 🅞 흡수 크론의 «codex ≥80%» 는 이 판정의 상한이 아니다.
 */
export const DEFAULT_BUDGET_GATE_MAX_USED_PERCENT: BudgetGateMaxUsedPercent = {
  'openai-codex': 95,
  grok: 48,
};
/** 발사 관문이 grok 주간 사용률에 실제로 적용하는 상한. `elanous usage` 와 같은 수를 이 값 미만으로만 통과시킨다. */
export const LAUNCH_GROK_USED_PERCENT_CAP = 80;

/**
 * Provider-scoped gate for native structure.
 *
 * Comparison is exact string equality (no case-fold, no alias map,
 * no trim). This file already treats `llm.provider` as an exact token
 * (`RUNTIME_LLM_PROVIDER_NAMES.includes`). This goal does not own the
 * spelling/normalization contract, so inventing one here would silently
 * disagree with callers that pass the stored provider name as-is.
 *
 * Disabled always wins. A missing list keeps the historical "all
 * providers" meaning. Consumers are not wired here — this predicate
 * is the means they will call from a later goal.
 */
export function isNativeStructureEnabledForProvider(
  nativeStructure: NativeStructureToolConfig,
  provider: string,
): boolean {
  if (nativeStructure.enabled !== true) return false;
  const list = nativeStructure.providers;
  if (list === undefined) return true;
  return list.includes(provider);
}

const TOOLS_DEFAULTS: ToolsConfig = {
  deferred: { mode: 'always' },
  agentSpawn: { hopCap: 5 },
  runDevHarness: {},
  selfOrchestrate: {},
  nativeStructure: { enabled: false },
  // 대표 결정(2026-07-26): 오토 선호 — 기본 ON.
  selfImplement: { worktreeRoot: join(homedir(), '.elanous', 'worktrees'), childInstanceMode: 'isolated', prApprovalDelivery: 'terminal' as const, observeOnly: false, goalRecordInDoc: true, goalAuthorReviewerPrecheck: false, fabricDecompose: false, fabricDecomposeAutoPathThreshold: 5, autoOpenPr: true, supervisor: { reasonRepair: false }, autoStop: { enabled: true, minRung: 2 }, autoAssist: { enabled: true, minRung: 2 }, screenStallTermination: { enabled: true, minRung: 2 }, reworkBudget: { shadowStop: false, maxRounds: 3 }, decompositionShadow: { enabled: false }, clarificationEscalation: { enabled: false } },
};

const DEBUG_DEFAULTS: DebugConfig = { file: true, level: 'trail', exposeFullLlmTools: true, renderLogs: false };

const LOGS_DEFAULTS: LogsConfig = { retention: { maxAgeDays: 7, maxDbMb: 500, minRetainHours: 24 } };

const SHELL_DEFAULTS: ShellConfig = {
  allowDashboardPty: false,
  allowDashboardBash: false,
  bashApproval: DEFAULT_BASH_APPROVAL,
  allowDashboardTerminalInject: false,
  allowDashboardApiCall: false,
  allowDashboardRunShell: false,
};

export function parseErrorReportsConfig(raw: unknown): ErrorReportsConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: ErrorReportsConfig = {};
  if (r.enabled === false || r.enabled === 'false') out.enabled = false;
  else if (r.enabled === true || r.enabled === 'true') out.enabled = true;
  if (r.noticeShown === true) out.noticeShown = true;
  if (r.identity === true || r.identity === 'true') out.identity = true;
  if (typeof r.email === 'string' && r.email.trim()) out.email = r.email.trim();
  if (typeof r.telegramUser === 'string' && r.telegramUser.trim()) out.telegramUser = r.telegramUser.trim();
  return Object.keys(out).length ? out : undefined;
}

import { parseChatConfig, CHAT_DEFAULTS } from './user-config/chat.js';
export * from './user-config/chat.js';

const DASHBOARD_PROMPT_BANK_DEFAULTS: DashboardPromptBankConfig = {
  enabled: false,
  dashboardTurns: false,
  skillRuns: false,
  budgetTokens: 1200,
  limit: 8,
  record: true,
};

const VW_KNOWN_NAMES: VwKnownName[] = ['acp', 'sim', 'iul'];
const VW_ORDER_DEFAULT: VwKnownName[] = ['acp', 'sim', 'iul'];
const VW_ENTRY_DEFAULTS: Record<VwKnownName, VwEntryConfig> = {
  acp: { resident: true, foregroundOnStartup: false },
  sim: { resident: false, foregroundOnStartup: false },
  iul: { resident: false, foregroundOnStartup: false },
};

const VW_DEFAULTS: VwConfig = {
  windowNames: {},
  paneNames: {},
  entries: {
    acp: { ...VW_ENTRY_DEFAULTS.acp },
    sim: { ...VW_ENTRY_DEFAULTS.sim },
    iul: { ...VW_ENTRY_DEFAULTS.iul },
  },
  simResident: false,
  iulResident: false,
  iulForegroundOnStartup: false,
  order: [...VW_ORDER_DEFAULT],
};

const ACP_DEFAULTS: AcpConfig = { hopCap: {}, toolApproval: { timeoutMs: 60_000 } };

function acpApprovalTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
    ? value : undefined;
}

function acpApprovalTimeoutEnv(): number | undefined {
  const raw = process.env.ELANOUS_ACP_TOOL_APPROVAL_TIMEOUT_MS;
  return raw !== undefined && /^\d+$/.test(raw) ? acpApprovalTimeoutMs(Number(raw)) : undefined;
}

const PLAN_DEFAULTS: PlanConfig = { autoWorktree: false };

const GOALS_DEFAULTS: GoalsConfig = {
  maxTurns: 20,
  wallClockMaxMs: 30 * 60_000,
  tokenBudget: 200_000,
  judgeModel: '',
  judgeRetries: 1,
  resumeOnPlanModeExit: false,
  modeDefault: 'judge',
};

const REGISTRY_DEFAULTS: RegistryConfig = {
  discovery: {
    cron: {},
    firecrawl: {},
  },
};

// ── modelTier / budget / smartDefaults (M1-1 · 2026-05-12) ───────────
//
// Three sparse sub-trees for the friction-free model selection UX. Each
// parser returns `undefined` when nothing concrete was set so the
// UserConfig stays sparse — resolvers in `src/model-tier/` fall through
// to the zero-config defaults (Balanced tier, no cap, auto-suggest on).

function spreadIfDefined<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
function parseTasteConfig(raw: unknown): TasteConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const r = raw;
  const out: TasteConfig = {};
  if (typeof r.captureEnabled === 'boolean') out.captureEnabled = r.captureEnabled;
  if (typeof r.model === 'string' && r.model.trim()) out.model = r.model.trim();
  if (typeof r.proposeEnabled === 'boolean') out.proposeEnabled = r.proposeEnabled;
  if (typeof r.proposeThreshold === 'number' && Number.isFinite(r.proposeThreshold)) out.proposeThreshold = r.proposeThreshold;
  if (typeof r.proposeCooldownDays === 'number' && Number.isFinite(r.proposeCooldownDays)) out.proposeCooldownDays = r.proposeCooldownDays;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseOpenDesignConfig(raw: unknown): OpenDesignConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const r = raw;
  const out: OpenDesignConfig = {};
  if (typeof r.url === 'string' && r.url.trim()) out.url = r.url.trim();
  if (typeof r.tokenFile === 'string' && r.tokenFile.trim()) out.tokenFile = r.tokenFile.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseDiagnosticsConfig(raw: unknown): UserConfig['diagnostics'] {
  if (!isRecord(raw)) return undefined;
  const value = raw.uploadUrl;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return undefined;
    return { uploadUrl: url.href };
  } catch { return undefined; }
}

function parseDesignConfig(raw: unknown): DesignConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const r = raw;
  const openDesign = parseOpenDesignConfig(r.openDesign);
  return openDesign ? { openDesign } : undefined;
}
function parseWebSearchConfig(raw: unknown): WebSearchConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const r = raw;
  const out: WebSearchConfig = {};
  if (isRecord(r.tavily)) {
    const t = r.tavily;
    if (typeof t.enabled === 'boolean') out.tavily = { enabled: t.enabled };
  }
  for (const key of ['grokApi', 'firecrawl'] as const) {
    const section = r[key];
    if (isRecord(section)) {
      const enabled = section.enabled;
      if (typeof enabled === 'boolean') out[key] = { enabled };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** tavily 를 **상시 경로**에 쓸 것인가. ⛔ 미설정이면 **false**(부재 = 끔).
 *  ⭐ 한 자리에서만 판정한다 — 소비처가 각자 `?.enabled` 를 읽으면 기본값 해석이 갈린다. */
export function isTavilySearchEnabled(cfg: Pick<UserConfig, 'webSearch'> = getUserConfig()): boolean {
  return cfg.webSearch?.tavily?.enabled === true;
}

/** An API key being present does not authorize metered web search. */
export function isPaidWebSearchEnabled(provider: 'grokApi' | 'firecrawl', cfg: Pick<UserConfig, 'webSearch'> = getUserConfig()): boolean {
  return cfg.webSearch?.[provider]?.enabled === true;
}

function parseSessionFabricConfig(raw: unknown): SessionFabricConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const r = raw;
  const out: SessionFabricConfig = {};
  if (typeof r.shadowFanout === 'boolean') out.shadowFanout = r.shadowFanout;
  if (isRecord(r.primary)) {
    const p = r.primary;
    const primary: { telegram?: boolean; discord?: boolean; pwaMsg?: boolean } = {};
    if (typeof p.telegram === 'boolean') primary.telegram = p.telegram;
    if (typeof p.discord === 'boolean') primary.discord = p.discord;
    if (typeof p.pwaMsg === 'boolean') primary.pwaMsg = p.pwaMsg;
    if (Object.keys(primary).length > 0) out.primary = primary;
  }
  if (isRecord(r.streaming)) {
    const p = r.streaming;
    const streaming: { telegram?: boolean; discord?: boolean; acp?: boolean } = {};
    if (typeof p.telegram === 'boolean') streaming.telegram = p.telegram;
    if (typeof p.discord === 'boolean') streaming.discord = p.discord;
    if (typeof p.acp === 'boolean') streaming.acp = p.acp;
    if (Object.keys(streaming).length > 0) out.streaming = streaming;
  }
  for (const surf of ['telegram', 'discord'] as const) {
    const raw = r[surf];
    if (isRecord(raw)) {
      const s = raw;
      const surfCfg: { streamingMode?: StreamingMode; editGapMs?: number; typing?: boolean; fairQueue?: boolean; rotate?: boolean } = {};
      if (isStreamingMode(s.streamingMode)) surfCfg.streamingMode = s.streamingMode;
      if (typeof s.editGapMs === 'number' && Number.isFinite(s.editGapMs) && s.editGapMs > 0) surfCfg.editGapMs = s.editGapMs;
      // 텔레그램 전용 강화 노브(§5.2·§10-2). discord 에 오면 무시(파서는 관대·sink 가 미사용).
      if (surf === 'telegram') {
        if (typeof s.typing === 'boolean') surfCfg.typing = s.typing;
        if (typeof s.fairQueue === 'boolean') surfCfg.fairQueue = s.fairQueue;
        if (typeof s.rotate === 'boolean') surfCfg.rotate = s.rotate;
      }
      if (Object.keys(surfCfg).length > 0) out[surf] = surfCfg;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseNextFluentConfig(raw: unknown): UserConfig['nextFluent'] {
  if (!isRecord(raw)) return undefined;
  const r = raw;
  const out: NonNullable<UserConfig['nextFluent']> = {};
  if (typeof r.personas === 'boolean') out.personas = r.personas;
  if (isRecord(r.models)) {
    out.models = Object.fromEntries(
      Object.entries(r.models).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseModelTierFieldOrUndefined(v: unknown): ModelTier | undefined {
  return isModelTier(v) ? v : undefined;
}

function parseModelTierConfig(raw: unknown): ModelTierUserConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  // Compatibility is read-only: the normalized config and subsequent writes use profile.
  let profile = isModelTierProfile(r.profile) ? r.profile : undefined;
  if (r.profile === undefined && r.persona !== undefined) {
    debug.log('config', 'deprecated-key', { from: 'modelTier.persona', to: 'modelTier.profile' });
    if (isModelTierProfile(r.persona)) profile = r.persona;
  }
  const preset = typeof r.preset === 'string' && r.preset.trim().length > 0
    ? r.preset.trim()
    : undefined;
  const voiceRaw = r.voice && typeof r.voice === 'object' && !Array.isArray(r.voice)
    ? r.voice as Record<string, unknown>
    : undefined;
  const voiceStt = voiceRaw ? parseModelTierFieldOrUndefined(voiceRaw.stt) : undefined;
  const voiceTts = voiceRaw ? parseModelTierFieldOrUndefined(voiceRaw.tts) : undefined;
  // M2-2b — per-context voice identity sub-tree. Each context is a
  // non-empty string voice id; invalid keys drop silently so the
  // sparse-parse pattern stays consistent with siblings.
  const ttsVoiceRaw = voiceRaw && voiceRaw.ttsVoice && typeof voiceRaw.ttsVoice === 'object' && !Array.isArray(voiceRaw.ttsVoice)
    ? voiceRaw.ttsVoice as Record<string, unknown>
    : undefined;
  const ttsVoice: Record<string, string> = {};
  if (ttsVoiceRaw) {
    for (const ctx of ['default', 'chat', 'digest', 'alert', 'discord']) {
      const v = ttsVoiceRaw[ctx];
      if (typeof v === 'string' && v.trim().length > 0) ttsVoice[ctx] = v.trim();
    }
  }
  const voiceTtsVoice = Object.keys(ttsVoice).length > 0 ? ttsVoice : undefined;
  const voice = voiceStt !== undefined || voiceTts !== undefined || voiceTtsVoice !== undefined
    ? {
        ...spreadIfDefined('stt', voiceStt),
        ...spreadIfDefined('tts', voiceTts),
        ...spreadIfDefined('ttsVoice', voiceTtsVoice),
      }
    : undefined;
  const llm = parseModelTierFieldOrUndefined(r.llm);
  const embedding = parseModelTierFieldOrUndefined(r.embedding);
  const vision = parseModelTierFieldOrUndefined(r.vision);
  const out: ModelTierUserConfig = {
    ...spreadIfDefined('profile', profile),
    ...spreadIfDefined('preset', preset),
    ...spreadIfDefined('voice', voice),
    ...spreadIfDefined('llm', llm),
    ...spreadIfDefined('embedding', embedding),
    ...spreadIfDefined('vision', vision),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseFiniteNonNegativeUsd(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function parseBudgetConfig(raw: unknown): BudgetUserConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const monthlyUsdCap = parseFiniteNonNegativeUsd(r.monthlyUsdCap);
  const dailyUsdCap = parseFiniteNonNegativeUsd(r.dailyUsdCap);
  const fallbackTier = parseModelTierFieldOrUndefined(r.fallbackTier);
  const notifyAtPct = typeof r.notifyAtPct === 'number'
    && Number.isFinite(r.notifyAtPct)
    && r.notifyAtPct >= 0
    && r.notifyAtPct <= 100
    ? r.notifyAtPct
    : undefined;
  const out: BudgetUserConfig = {
    ...spreadIfDefined('monthlyUsdCap', monthlyUsdCap),
    ...spreadIfDefined('dailyUsdCap', dailyUsdCap),
    ...spreadIfDefined('fallbackTier', fallbackTier),
    ...spreadIfDefined('notifyAtPct', notifyAtPct),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseApnsConfig(raw: unknown): ApnsUserConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const keyId    = typeof r.keyId    === 'string' && r.keyId.trim().length    > 0 ? r.keyId.trim()    : undefined;
  const teamId   = typeof r.teamId   === 'string' && r.teamId.trim().length   > 0 ? r.teamId.trim()   : undefined;
  const bundleId = typeof r.bundleId === 'string' && r.bundleId.trim().length > 0 ? r.bundleId.trim() : undefined;
  const keyPath  = typeof r.keyPath  === 'string' && r.keyPath.trim().length  > 0 ? r.keyPath.trim()  : undefined;
  if (!keyId || !teamId || !bundleId || !keyPath) return undefined;
  const environment: 'production' | 'sandbox' | undefined =
    r.environment === 'sandbox' ? 'sandbox'
    : r.environment === 'production' ? 'production'
    : undefined;
  return {
    keyId, teamId, bundleId, keyPath,
    ...spreadIfDefined('environment', environment),
  };
}

function parseNotificationsConfig(raw: unknown): NotificationsConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const apns = parseApnsConfig(r.apns);
  if (!apns) return undefined;
  return { apns };
}

function parseMcpCommand(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const command: string[] = [];
  for (const part of raw) {
    if (typeof part !== 'string' || part.length === 0) return undefined;
    command.push(part);
  }
  if (command.length === 0) return undefined;
  return command;
}

function normalizeMcpTransport(raw: unknown): McpTransport | undefined {
  if (typeof raw !== 'string') return undefined;
  const kind = raw.trim();
  if (kind === 'stdio') return 'stdio';
  if (kind === 'http' || kind === 'streamable-http') return 'http';
  return undefined;
}

/** User-visible diagnostic for the one silent-drop contract this landing breaks. */
export function formatMcpUrlWithoutTransportDiagnostic(id: string): string {
  return `[user-config] mcp server "${id}" has a url but no transport; set transport to "http"`;
}

function warnMcpUrlWithoutTransport(id: string): void {
  const message = formatMcpUrlWithoutTransportDiagnostic(id);
  try { console.warn(message); } catch { /* parse must never throw */ }
  try {
    debug.log('user-config.mcp', 'url-without-transport', { id, hint: 'http' });
  } catch { /* parse must never throw */ }
}

/** ⛔⭐ **권한 필드다 — 「모르는 값은 허가하지 않는다」로 읽는다.**
 *
 *  배열이 아니면 `undefined`(= 아무것도 허가 안 함) · 배열이면 «비지 않은 문자열»만 남긴다.
 *  ⇒ 오타·잘못된 타입이 «허가를 늘리는» 방향으로는 절대 못 간다(항목 단위 fail-closed).
 *  ⛔ 서버 전체를 버리지는 않는다 — 오타 하나로 서버가 조용히 사라지면 더 나쁘다.
 *
 *  📌 이 함수가 «없어서» 회귀가 났다: 필드는 `McpServerSpec` 에 있는데 파서가 안 읽어
 *  config 에 적은 `authorizedTools` 가 조용히 버려졌고, `registerMcpClients` 가 항상 빈
 *  배열을 돌아 ***모든 MCP 프록시 툴이 영구히 거부***됐다(사후 리뷰가 잡음). */
function parseMcpHandshakeTimeoutMs(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const timeoutMs = Math.floor(raw);
  return timeoutMs >= 1 && timeoutMs <= 2_147_483_647 ? timeoutMs : undefined;
}

function parseMcpAuthorizedTools(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name.length === 0) continue;
    if (!out.includes(name)) out.push(name);   // 중복은 접는다 — 결정론
  }
  return out;
}

function parseMcpServerSpec(raw: unknown): McpServerSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id.trim().length > 0 ? r.id.trim() : undefined;
  if (!id) return undefined;
  const enabled: boolean | undefined =
    typeof r.enabled === 'boolean' ? r.enabled : undefined;
  // ⛔ 권한 필드 — 네 반환 경로 «전부»에 실어야 한다(하나만 빠져도 그 조합에서 허가가 죽는다).
  const authorizedTools = parseMcpAuthorizedTools(r.authorizedTools);
  const handshakeTimeoutMs = parseMcpHandshakeTimeoutMs(r.handshakeTimeoutMs);
  // Presence ≠ validity. `null` / `42` / `''` / `'   '` are explicit
  // malformed transports (silent drop), not "transport omitted".
  const transportPresent = Object.hasOwn(r, 'transport');
  const transport = normalizeMcpTransport(r.transport);
  const url = typeof r.url === 'string' && r.url.length > 0 ? r.url : undefined;
  const oauthIssuer = typeof r.oauthIssuer === 'string' && r.oauthIssuer.trim().length > 0
    ? r.oauthIssuer.trim()
    : undefined;
  const oauthTokenEndpoint = typeof r.oauthTokenEndpoint === 'string' && r.oauthTokenEndpoint.trim().length > 0
    ? r.oauthTokenEndpoint.trim()
    : undefined;
  const bearerTokenEnv = typeof r.bearerTokenEnv === 'string' && r.bearerTokenEnv.trim().length > 0
    ? r.bearerTokenEnv.trim()
    : undefined;
  const command = parseMcpCommand(r.command);

  // 1. Field combination validity — before transport inference.
  // `{ id, command, url }` is mixed malformed whether or not transport is
  // written: legacy `command` already means stdio, so this is not the
  // URL-only copy-paste trap. Silent drop, never warn.
  if (r.command !== undefined && r.url !== undefined) return undefined;
  if (transport === 'http' && r.command !== undefined) return undefined;
  if (transport === 'stdio' && r.url !== undefined) return undefined;

  // 2. Explicit transport value validation.
  if (transportPresent && transport === undefined) return undefined;

  // 3. Legacy stdio inference: omitted transport + command → child process.
  if (!transportPresent && command) {
    return {
      id,
      transport: 'stdio',
      command,
      ...spreadIfDefined('enabled', enabled),
      ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
      ...spreadIfDefined('authorizedTools', authorizedTools),
    };
  }

  // 4. URL-only trap: omitted transport + url (and no command — mixed
  // already returned). Intentional break of silent-drop: name the entry
  // and tell the user to set `http`.
  if (!transportPresent && url) {
    warnMcpUrlWithoutTransport(id);
    return undefined;
  }

  if (transport === 'http') {
    if (!url) return undefined;
    return {
      id,
      transport: 'http',
      url,
      ...spreadIfDefined('oauthIssuer', oauthIssuer),
      ...spreadIfDefined('oauthTokenEndpoint', oauthTokenEndpoint),
      ...spreadIfDefined('bearerTokenEnv', bearerTokenEnv),
      ...spreadIfDefined('enabled', enabled),
      ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
      ...spreadIfDefined('authorizedTools', authorizedTools),
    };
  }

  // Explicit `stdio` requires command.
  if (!command) return undefined;
  return {
    id,
    transport: 'stdio',
    command,
    ...spreadIfDefined('enabled', enabled),
    ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
    ...spreadIfDefined('authorizedTools', authorizedTools),
  };
}

function parseMcpConfig(raw: unknown): McpConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const enabled = r.enabled === false ? false : undefined; // strict false flips off
  const handshakeTimeoutMs = parseMcpHandshakeTimeoutMs(r.handshakeTimeoutMs);
  const widgetServerId = typeof r.widgetServerId === 'string' && r.widgetServerId.trim().length > 0
    ? r.widgetServerId.trim()
    : undefined;
  const servers: McpServerSpec[] = [];
  if (Array.isArray(r.servers)) {
    for (const entry of r.servers) {
      const spec = parseMcpServerSpec(entry);
      if (spec) servers.push(spec);
    }
  }
  // Keep a named widget binding even when the server list is empty or
  // absent so boot can log unknown-widget-server-id and fall back.
  // The master switch alone is still enough to retain `{ enabled: false }`.
  if (servers.length === 0 && enabled === undefined && handshakeTimeoutMs === undefined && widgetServerId === undefined) return undefined;
  return {
    servers,
    ...(enabled === false ? { enabled: false } : {}),
    ...spreadIfDefined('handshakeTimeoutMs', handshakeTimeoutMs),
    ...spreadIfDefined('widgetServerId', widgetServerId),
  };
}

function parseAsideConfig(raw: unknown): AsideConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('aside must be an object');
  const r = raw as Record<string, unknown>;
  if (r.strictRedactMode !== undefined && typeof r.strictRedactMode !== 'boolean') {
    throw new Error('aside.strictRedactMode must be boolean');
  }
  const targets: AsideRemoteTargetConfig[] = [];
  const ids = new Set<string>();
  if (r.targets !== undefined && !Array.isArray(r.targets)) throw new Error('aside.targets must be an array');
  if (Array.isArray(r.targets)) for (const [index, rawTarget] of r.targets.entries()) {
    if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) throw new Error(`aside.targets[${index}] must be an object`);
    const target = rawTarget as Record<string, unknown>;
    if (typeof target.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(target.id) || ids.has(target.id)) throw new Error(`aside.targets[${index}].id is invalid or duplicated`);
    if (typeof target.host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(target.host)) throw new Error(`aside.targets[${index}].host is invalid`);
    if (!Array.isArray(target.command) || target.command.length === 0 || target.command.some(v => typeof v !== 'string' || !v || /[\r\n\0]/.test(v))) throw new Error(`aside.targets[${index}].command is invalid`);
    const capabilities = Array.isArray(target.capabilities)
      ? [...new Set(target.capabilities.filter((v): v is AsideRemoteTargetConfig['capabilities'][number] => v === 'browser' || v === 'repl' || v === 'selection'))]
      : [];
    if (capabilities.length === 0 || (target.enabled !== undefined && typeof target.enabled !== 'boolean')) throw new Error(`aside.targets[${index}] capabilities or enabled value is invalid`);
    ids.add(target.id);
    targets.push({ id: target.id, host: target.host, command: [...target.command] as string[], capabilities, ...(typeof target.enabled === 'boolean' ? { enabled: target.enabled } : {}) });
  }
  if (r.defaultTargetId !== undefined && (typeof r.defaultTargetId !== 'string' || !ids.has(r.defaultTargetId))) throw new Error('aside.defaultTargetId must reference a registered target');
  const defaultTargetId = typeof r.defaultTargetId === 'string' ? r.defaultTargetId : undefined;
  const contextDefaults: Record<string, string> = {};
  if (r.contextDefaults !== undefined && (!r.contextDefaults || typeof r.contextDefaults !== 'object' || Array.isArray(r.contextDefaults))) throw new Error('aside.contextDefaults must be an object');
  if (r.contextDefaults && typeof r.contextDefaults === 'object') {
    for (const [context, id] of Object.entries(r.contextDefaults)) {
      if (!context.trim() || typeof id !== 'string' || !ids.has(id)) throw new Error(`aside.contextDefaults.${context} must reference a registered target`);
      contextDefaults[context] = id;
    }
  }
  const strictRedactMode = r.strictRedactMode === true ? true : undefined;
  if (targets.length === 0 && !defaultTargetId && Object.keys(contextDefaults).length === 0 && strictRedactMode === undefined) return undefined;
  return {
    targets,
    ...(defaultTargetId ? { defaultTargetId } : {}),
    ...(Object.keys(contextDefaults).length ? { contextDefaults } : {}),
    ...(strictRedactMode ? { strictRedactMode } : {}),
  };
}

function parseBackgroundReasoningLlmConfig(raw: unknown): BackgroundReasoningLlmConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const endpoint = typeof r.endpoint === 'string' && r.endpoint.trim().length > 0 ? r.endpoint.trim() : undefined;
  if (!endpoint) return undefined;
  const entityModel = typeof r.entityModel === 'string' && r.entityModel.trim().length > 0 ? r.entityModel.trim() : undefined;
  const embeddingModel = typeof r.embeddingModel === 'string' && r.embeddingModel.trim().length > 0 ? r.embeddingModel.trim() : undefined;
  const apiKey = typeof r.apiKey === 'string' && r.apiKey.trim().length > 0 ? r.apiKey.trim() : undefined;
  return {
    endpoint,
    ...spreadIfDefined('entityModel', entityModel),
    ...spreadIfDefined('embeddingModel', embeddingModel),
    ...spreadIfDefined('apiKey', apiKey),
  };
}

function parseBackgroundReasoningConfig(raw: unknown): BackgroundReasoningConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const llm = parseBackgroundReasoningLlmConfig(r.llm);
  if (!llm) return undefined;
  return { llm };
}

function parseSmartDefaultsConfig(raw: unknown): SmartDefaultsUserConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const autoSuggest = typeof r.autoSuggest === 'boolean' ? r.autoSuggest : undefined;
  const suppressPatternHints = typeof r.suppressPatternHints === 'boolean'
    ? r.suppressPatternHints
    : undefined;
  const out: SmartDefaultsUserConfig = {
    ...spreadIfDefined('autoSuggest', autoSuggest),
    ...spreadIfDefined('suppressPatternHints', suppressPatternHints),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse `tools.nativeStructure.providers`.
 *
 * Absent / undefined → no list (legacy "all providers when enabled").
 * A well-formed string array (including empty) is kept as written.
 * Any other shape is invalid: fall back to "no list" and let the
 * caller emit the existing `[user-config] … 기본값 …` stderr note.
 */
function parseNativeStructureProviders(raw: unknown): {
  providers: readonly string[] | undefined;
  invalid: boolean;
} {
  if (raw === undefined) return { providers: undefined, invalid: false };
  if (!Array.isArray(raw)) return { providers: undefined, invalid: true };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { providers: undefined, invalid: true };
    out.push(item);
  }
  return { providers: out, invalid: false };
}

function parseToolsConfig(raw: unknown): ToolsConfig {
  // Fallback to defaults on any malformed input — we never want to
  // crash a session on a typo in tools.deferred.mode.
  const empty: ToolsConfig = {
    deferred: { ...TOOLS_DEFAULTS.deferred },
    agentSpawn: { ...TOOLS_DEFAULTS.agentSpawn },
    runDevHarness: { ...TOOLS_DEFAULTS.runDevHarness },
    selfOrchestrate: { ...TOOLS_DEFAULTS.selfOrchestrate },
    nativeStructure: { ...TOOLS_DEFAULTS.nativeStructure },
    selfImplement: { ...TOOLS_DEFAULTS.selfImplement },
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const root = raw as Record<string, unknown>;
  const runDevHarnessRaw = (root.runDevHarness && typeof root.runDevHarness === 'object' && !Array.isArray(root.runDevHarness))
    ? root.runDevHarness as Record<string, unknown>
    : {};
  const runDevHarness: RunDevHarnessToolConfig = typeof runDevHarnessRaw.modelSurface === 'boolean'
    ? { modelSurface: runDevHarnessRaw.modelSurface }
    : {};
  const selfOrchestrateRaw = (root.selfOrchestrate && typeof root.selfOrchestrate === 'object' && !Array.isArray(root.selfOrchestrate))
    ? root.selfOrchestrate as Record<string, unknown>
    : {};
  const selfOrchestrate: SelfOrchestrateToolConfig = typeof selfOrchestrateRaw.modelSurface === 'boolean'
    ? { modelSurface: selfOrchestrateRaw.modelSurface }
    : {};
  const nativeStructureRaw = (root.nativeStructure && typeof root.nativeStructure === 'object' && !Array.isArray(root.nativeStructure))
    ? root.nativeStructure as Record<string, unknown>
    : {};
  const nativeStructureProvidersRaw = nativeStructureRaw.providers;
  const nativeStructureProvidersParsed = parseNativeStructureProviders(nativeStructureProvidersRaw);
  if (nativeStructureProvidersParsed.invalid) {
    try {
      process.stderr.write(
        `[user-config] tools.nativeStructure.providers 는 문자열 배열이어야 합니다(${JSON.stringify(nativeStructureProvidersRaw)}) — 기본값(목록 없음)으로 진행합니다.\n`,
      );
    } catch { /* swallow — stderr 가 닫힌 경우 */ }
  }
  const nativeStructure: NativeStructureToolConfig = {
    enabled: typeof nativeStructureRaw.enabled === 'boolean'
      ? nativeStructureRaw.enabled
      : TOOLS_DEFAULTS.nativeStructure.enabled,
    ...(nativeStructureProvidersParsed.providers === undefined
      ? {}
      : { providers: nativeStructureProvidersParsed.providers }),
  };
  const deferred = (root.deferred && typeof root.deferred === 'object' && !Array.isArray(root.deferred))
    ? root.deferred as Record<string, unknown>
    : {};
  const rawMode = deferred.mode;
  const mode: DeferredToolsMode = rawMode === 'off' ? 'off' : 'always';
  // Wave 5 E3: agentSpawn.hopCap
  const agentSpawnRaw = (root.agentSpawn && typeof root.agentSpawn === 'object' && !Array.isArray(root.agentSpawn))
    ? root.agentSpawn as Record<string, unknown>
    : {};
  const hopCapRaw = agentSpawnRaw.hopCap;
  const hopCap = typeof hopCapRaw === 'number' && Number.isFinite(hopCapRaw) && hopCapRaw >= 0
    ? Math.floor(hopCapRaw)
    : TOOLS_DEFAULTS.agentSpawn.hopCap;
  // ⭐ selfImplement.autoOpenPr — 기본 ON(대표 결정). **명시적 false 만** 끈다:
  //   오타/누락/비-boolean 은 기본값(true)으로 수렴한다(다른 노브와 동형 fail-soft).
  const selfImplRaw = (root.selfImplement && typeof root.selfImplement === 'object' && !Array.isArray(root.selfImplement))
    ? root.selfImplement as Record<string, unknown>
    : {};
  const supervisorRaw = selfImplRaw.supervisor && typeof selfImplRaw.supervisor === 'object' && !Array.isArray(selfImplRaw.supervisor)
    ? selfImplRaw.supervisor as Record<string, unknown>
    : {};
  const supervisor = { reasonRepair: supervisorRaw.reasonRepair === true };
  const observeOnly = typeof selfImplRaw.observeOnly === 'boolean'
    ? selfImplRaw.observeOnly
    : TOOLS_DEFAULTS.selfImplement.observeOnly;
  const goalRecordInDoc = typeof selfImplRaw.goalRecordInDoc === 'boolean'
    ? selfImplRaw.goalRecordInDoc
    : TOOLS_DEFAULTS.selfImplement.goalRecordInDoc;
  const goalAuthorPersistentGrounding = typeof selfImplRaw.goalAuthorPersistentGrounding === 'boolean'
    ? selfImplRaw.goalAuthorPersistentGrounding
    : undefined;
  const goalAuthorReviewerPrecheck = selfImplRaw.goalAuthorReviewerPrecheck === true;
  const fabricDecompose = selfImplRaw.fabricDecompose === true;
  const fabricDecomposeAutoPathThresholdRaw = selfImplRaw.fabricDecomposeAutoPathThreshold;
  const fabricDecomposeAutoPathThreshold = fabricDecomposeAutoPathThresholdRaw === null
    ? null
    : typeof fabricDecomposeAutoPathThresholdRaw === 'number'
      && Number.isFinite(fabricDecomposeAutoPathThresholdRaw)
      && Number.isInteger(fabricDecomposeAutoPathThresholdRaw)
      && fabricDecomposeAutoPathThresholdRaw >= 1
      ? fabricDecomposeAutoPathThresholdRaw
      : TOOLS_DEFAULTS.selfImplement.fabricDecomposeAutoPathThreshold;
  const worktreeRootRaw = selfImplRaw.worktreeRoot;
  const expandedWorktreeRoot = typeof worktreeRootRaw === 'string' && worktreeRootRaw.trim()
    ? worktreeRootRaw.trim().replace(/^~(?=\/|$)/, homedir())
    : undefined;
  const worktreeRoot = expandedWorktreeRoot && isAbsolute(expandedWorktreeRoot)
    ? expandedWorktreeRoot
    : TOOLS_DEFAULTS.selfImplement.worktreeRoot;
  const childInstanceMode: SelfImplementChildInstanceMode = selfImplRaw.childInstanceMode === 'inherit'
    ? 'inherit'
    : 'isolated';
  const autoOpenPrRaw = selfImplRaw.autoOpenPr;
  const autoStopRaw = (selfImplRaw.autoStop && typeof selfImplRaw.autoStop === 'object' && !Array.isArray(selfImplRaw.autoStop))
    ? selfImplRaw.autoStop as Record<string, unknown>
    : {};
  const autoStop = {
    // 설정 졸업 1-a(2026-09-24): 기본 켬 · `enabled` 는 폐기 키(`RETIRED_CONFIG_KEYS`) — 파일 값을 읽지 않는다.
    enabled: TOOLS_DEFAULTS.selfImplement.autoStop.enabled,
    minRung: typeof autoStopRaw.minRung === 'number' && Number.isFinite(autoStopRaw.minRung)
      ? Math.max(0, Math.floor(autoStopRaw.minRung))
      : TOOLS_DEFAULTS.selfImplement.autoStop.minRung,
  };
  const autoAssistRaw = (selfImplRaw.autoAssist && typeof selfImplRaw.autoAssist === 'object' && !Array.isArray(selfImplRaw.autoAssist))
    ? selfImplRaw.autoAssist as Record<string, unknown>
    : {};
  const autoAssist = {
    // 설정 졸업 1-a(2026-09-24): 기본 켬 · `enabled` 는 폐기 키(`RETIRED_CONFIG_KEYS`) — 파일 값을 읽지 않는다.
    enabled: TOOLS_DEFAULTS.selfImplement.autoAssist.enabled,
    minRung: typeof autoAssistRaw.minRung === 'number' && Number.isFinite(autoAssistRaw.minRung)
      ? Math.max(0, Math.floor(autoAssistRaw.minRung))
      : TOOLS_DEFAULTS.selfImplement.autoAssist.minRung,
  };
  const screenStallTerminationRaw = (selfImplRaw.screenStallTermination && typeof selfImplRaw.screenStallTermination === 'object' && !Array.isArray(selfImplRaw.screenStallTermination))
    ? selfImplRaw.screenStallTermination as Record<string, unknown>
    : {};
  const screenStallTermination = {
    // 설정 졸업 1-a(2026-09-24): 기본 켬 · `enabled` 는 폐기 키(`RETIRED_CONFIG_KEYS`) — 파일 값을 읽지 않는다.
    enabled: TOOLS_DEFAULTS.selfImplement.screenStallTermination.enabled,
    minRung: typeof screenStallTerminationRaw.minRung === 'number' && Number.isFinite(screenStallTerminationRaw.minRung)
      ? Math.max(0, Math.floor(screenStallTerminationRaw.minRung))
      : TOOLS_DEFAULTS.selfImplement.screenStallTermination.minRung,
  };
  const reworkBudgetRaw = (selfImplRaw.reworkBudget && typeof selfImplRaw.reworkBudget === 'object' && !Array.isArray(selfImplRaw.reworkBudget))
    ? selfImplRaw.reworkBudget as Record<string, unknown>
    : {};
  const reworkBudgetMaxRoundsRaw = reworkBudgetRaw.maxRounds;
  const reworkBudgetMaxRounds = typeof reworkBudgetMaxRoundsRaw === 'number'
    && Number.isFinite(reworkBudgetMaxRoundsRaw)
    && Number.isInteger(reworkBudgetMaxRoundsRaw)
    && reworkBudgetMaxRoundsRaw >= 1
    ? reworkBudgetMaxRoundsRaw
    : TOOLS_DEFAULTS.selfImplement.reworkBudget.maxRounds;
  if (reworkBudgetMaxRoundsRaw !== undefined && reworkBudgetMaxRoundsRaw !== reworkBudgetMaxRounds) {
    try {
      process.stderr.write(
        `[user-config] tools.selfImplement.reworkBudget.maxRounds 는 1 이상의 유한한 정수여야 합니다(${JSON.stringify(reworkBudgetMaxRoundsRaw)}) — 기본값 ${TOOLS_DEFAULTS.selfImplement.reworkBudget.maxRounds} 로 진행합니다.\n`,
      );
    } catch { /* swallow — stderr 가 닫힌 경우 */ }
  }
  const reworkBudget = {
    shadowStop: typeof reworkBudgetRaw.shadowStop === 'boolean'
      ? reworkBudgetRaw.shadowStop
      : TOOLS_DEFAULTS.selfImplement.reworkBudget.shadowStop,
    maxRounds: reworkBudgetMaxRounds,
  };
  // 폐기 키(`RETIRED_CONFIG_KEYS`) — 설정 파일 값은 읽지 않는다(읽는 곳이 없다 · 2026-09-24 설정 졸업 0-a).
  //   타입 칸은 기존 시험 픽스처가 넣으므로 남기고, 값은 늘 기본이다.
  const decompositionShadow = { enabled: TOOLS_DEFAULTS.selfImplement.decompositionShadow.enabled };
  const clarificationEscalationRaw = (selfImplRaw.clarificationEscalation && typeof selfImplRaw.clarificationEscalation === 'object' && !Array.isArray(selfImplRaw.clarificationEscalation))
    ? selfImplRaw.clarificationEscalation as Record<string, unknown>
    : {};
  // ⛔ 정수화 «뒤에» 양수를 본다 — 0 < v < 1 이 Math.floor 로 0 이 되어 「즉시 만료」가 된다(리뷰 지적).
  const clarificationTimeoutRaw = clarificationEscalationRaw.timeoutMs;
  const clarificationTimeoutMs = typeof clarificationTimeoutRaw === 'number'
    && Number.isFinite(clarificationTimeoutRaw)
    && Math.floor(clarificationTimeoutRaw) >= 1
    // ⛔ setTimeout 은 32-bit 상한(2^31-1)을 넘는 지연을 «즉시 만료»로 축소한다 —
    //    「아주 길게 기다리라」가 「기다리지 마라」가 된다(무인 리뷰 R6).
    && Math.floor(clarificationTimeoutRaw) <= 2_147_483_647
    ? Math.floor(clarificationTimeoutRaw)
    : undefined;
  const clarificationEscalation: SelfImplementClarificationEscalationConfig = {
    enabled: clarificationEscalationRaw.enabled === true,
    ...(clarificationTimeoutMs === undefined ? {} : { timeoutMs: clarificationTimeoutMs }),
  };
  const childLlm = parseChildLlmPreference(selfImplRaw.childLlm);
  const runTtlHoursRaw = selfImplRaw.runTtlHours;
  const runTtlHours = typeof runTtlHoursRaw === 'number' && Number.isFinite(runTtlHoursRaw) && runTtlHoursRaw > 0 ? runTtlHoursRaw : undefined;
  // Kept raw: the sweep validates and warns, so an out-of-range value is visible rather than silently dropped.
  const draftSweepCloseCap = selfImplRaw.draftSweepCloseCap;
  const runTtlRaw = selfImplRaw.runTtl && typeof selfImplRaw.runTtl === 'object' && !Array.isArray(selfImplRaw.runTtl)
    ? selfImplRaw.runTtl as Record<string, unknown> : undefined;
  const runTtl = runTtlRaw ? {
    mode: runTtlRaw.mode === 'live' ? 'live' as const : 'shadow' as const,
    ...(typeof runTtlRaw.cap === 'number' && Number.isSafeInteger(runTtlRaw.cap) && runTtlRaw.cap >= 0 ? { cap: runTtlRaw.cap } : {}),
  } : undefined;
  const autohealRaw = selfImplRaw.autoheal && typeof selfImplRaw.autoheal === 'object' && !Array.isArray(selfImplRaw.autoheal)
    ? selfImplRaw.autoheal as Record<string, unknown> : undefined;
  // ⛔ 모르는 값은 좁은 쪽(shadow) — 오타가 live 를 켜면 안 된다.
  const autoheal = autohealRaw ? { mode: autohealRaw.mode === 'live' ? 'live' as const : 'shadow' as const } : undefined;
  const escalateChildRaw = selfImplRaw.escalateChild;
  const escalateChild = escalateChildRaw && typeof escalateChildRaw === 'object' && !Array.isArray(escalateChildRaw)
    ? Object.fromEntries(Object.entries(escalateChildRaw).filter(([from, to]) => from.trim() && typeof to === 'string' && to.trim())
      .map(([from, to]) => [from.trim(), (to as string).trim()])) as Record<string, string>
    : undefined;
  // ⭐ 관측(리뷰 should-fix) — 오타/비-boolean 은 기본값(ON)으로 수렴하는데, 그게 조용하면
  //   "껐다고 믿었는데 자동 개설되는" 운영 사고가 된다. 값이 **있는데 boolean 이 아닐 때만**
  //   경고한다(부재는 정상). 로거 대신 stderr — 이 파일의 기존 경고와 동형(부트 시점·의존 0).
  if (autoOpenPrRaw !== undefined && typeof autoOpenPrRaw !== 'boolean') {
    try {
      process.stderr.write(
        `[user-config] tools.selfImplement.autoOpenPr 가 boolean 이 아닙니다(${JSON.stringify(autoOpenPrRaw)}) — 기본값 ${TOOLS_DEFAULTS.selfImplement.autoOpenPr} 로 진행합니다. 끄려면 false 를 명시하세요.\n`,
      );
    } catch { /* swallow — stderr 가 닫힌 경우 */ }
  }
  // ⛔ 알 수 없는 값은 **좁은 쪽**(terminal)으로 떨어뜨린다 — 오타가 팬아웃을 켜면 안 된다.
  const prApprovalDelivery: 'terminal' | 'all' =
    (selfImplRaw as { prApprovalDelivery?: unknown }).prApprovalDelivery === 'all' ? 'all' : 'terminal';
  const autoOpenPr = autoOpenPrRaw === false
    ? false
    : TOOLS_DEFAULTS.selfImplement.autoOpenPr;
  const draftOnStopParsed = parseDraftOnStopMode((selfImplRaw as { draftOnStop?: unknown }).draftOnStop);
  if (draftOnStopParsed.invalid) {
    try {
      process.stderr.write(`[user-config] tools.selfImplement.draftOnStop 값이 알 수 없습니다(${JSON.stringify((selfImplRaw as { draftOnStop?: unknown }).draftOnStop)}) — 'always' 로 진행합니다. 허용값: ${DRAFT_ON_STOP_MODES.join(' | ')}\n`);
    } catch { /* swallow */ }
  }
  const draftOnStop = draftOnStopParsed.mode;
  const salvageRetentionRaw = (selfImplRaw as { salvageRetention?: unknown }).salvageRetention;
  const salvageRetentionModeRaw = salvageRetentionRaw && typeof salvageRetentionRaw === 'object' ? (salvageRetentionRaw as { mode?: unknown }).mode : undefined;
  if (salvageRetentionModeRaw !== undefined && salvageRetentionModeRaw !== 'shadow' && salvageRetentionModeRaw !== 'live') {
    try { process.stderr.write(`[user-config] tools.selfImplement.salvageRetention.mode 값이 알 수 없습니다(${JSON.stringify(salvageRetentionModeRaw)}) — 'shadow' 로 진행합니다. 허용값: shadow | live\n`); } catch { /* swallow */ }
  }
  const salvageRetention = { mode: salvageRetentionModeRaw === 'live' ? 'live' as const : 'shadow' as const };
  return {
    deferred: { mode },
    agentSpawn: { hopCap },
    runDevHarness,
    selfOrchestrate,
    nativeStructure,
    selfImplement: { worktreeRoot, childInstanceMode, prApprovalDelivery, observeOnly, goalRecordInDoc, goalAuthorPersistentGrounding, goalAuthorReviewerPrecheck, fabricDecompose, fabricDecomposeAutoPathThreshold, autoOpenPr, supervisor, draftOnStop, salvageRetention, autoStop, autoAssist, screenStallTermination, reworkBudget, decompositionShadow, clarificationEscalation, ...(childLlm ? { childLlm } : {}), ...(escalateChild && Object.keys(escalateChild).length ? { escalateChild } : {}), ...(selfImplRaw.podChildDefault !== undefined ? { podChildDefault: selfImplRaw.podChildDefault } : {}), ...(runTtlHours !== undefined ? { runTtlHours } : {}), ...(draftSweepCloseCap !== undefined ? { draftSweepCloseCap } : {}), ...(runTtl ? { runTtl } : {}), ...(autoheal ? { autoheal } : {}) },
  };
}

const CHILD_LLM_MODES = ['pinned', 'auto'] as const;

/** 잘못된 값은 경고와 함께 버린다 — 설정 한 줄이 발사를 막지 않는다. 없으면 undefined(해석기가 기본).
 *  비객체·비문자열 provider/model 도 경고 후 버리고 기본으로 진행한다. 발사를 막지 않는다. */
export function parseChildLlmPreference(raw: unknown): ChildLlmPreferenceConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('tools.selfImplement.childLlm', `객체가 아니다(${JSON.stringify(raw)}) — 버리고 기본으로 진행`);
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  const out: ChildLlmPreferenceConfig = {};
  let droppedInvalidProvider = false;
  if (v.provider !== undefined) {
    if (typeof v.provider === 'string') out.provider = v.provider;
    else {
      droppedInvalidProvider = true;
      warnUserConfigDrop('tools.selfImplement.childLlm.provider', `문자열이 아니다(${JSON.stringify(v.provider)}) — 버림`);
    }
  }
  if (v.model !== undefined) {
    if (typeof v.model === 'string') out.model = v.model;
    else warnUserConfigDrop('tools.selfImplement.childLlm.model', `문자열이 아니다(${JSON.stringify(v.model)}) — 버림`);
  }
  if (v.mode !== undefined) {
    if ((CHILD_LLM_MODES as readonly string[]).includes(v.mode as string)) out.mode = v.mode as ChildLlmPreferenceMode;
    else warnUserConfigDrop('tools.selfImplement.childLlm.mode', `pinned|auto 가 아니다(${JSON.stringify(v.mode)}) — 기본으로 진행`);
  }
  if (v.chain !== undefined) {
    if (!Array.isArray(v.chain)) {
      warnUserConfigDrop('tools.selfImplement.childLlm.chain', `배열이 아니다(${JSON.stringify(v.chain)}) — 버림`);
    } else {
      const chain: ChildLlmChainEntry[] = [];
      for (const [index, item] of v.chain.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          warnUserConfigDrop('tools.selfImplement.childLlm.chain', `[${index}] 객체가 아니다(${JSON.stringify(item)}) — 건너뜀`);
          continue;
        }
        const entry = item as Record<string, unknown>;
        if (typeof entry.provider !== 'string' || !entry.provider.trim()) {
          warnUserConfigDrop('tools.selfImplement.childLlm.chain', `[${index}].provider 가 빈 문자열이 아니다(${JSON.stringify(entry.provider)}) — 건너뜀`);
          continue;
        }
        if (entry.model !== undefined && typeof entry.model !== 'string') {
          warnUserConfigDrop('tools.selfImplement.childLlm.chain', `[${index}].model 이 문자열이 아니다(${JSON.stringify(entry.model)}) — 건너뜀`);
          continue;
        }
        chain.push({
          provider: entry.provider,
          ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
        });
      }
      out.chain = chain;
    }
  }
  // mode 추론은 여기 하지 않는다. provider 가 없으면 auto — model 만 남은 설정도 같다.
  // 기존 model-only 거절 문면은 발사 경계가 따로 보존한다.
  // 잘못된 provider 를 버린 뒤에 model 만 남으면 그 거절이 발사를 막는다.
  // 그 한 줄은 경고로 끝내고 기본으로 진행한다.
  if (droppedInvalidProvider && out.model !== undefined && out.provider === undefined && out.mode === undefined && out.chain === undefined) {
    delete out.model;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const BUDGET_GATE_ON_SHORTFALL = ['decompose', 'wait-reset', 'next-provider', 'proceed'] as const;
export const DEFAULT_BUDGET_GATE: HarnessBudgetGateConfig = {
  minHeadroomPercent: 15,
  onShortfall: 'next-provider',
  maxUsedPercent: { ...DEFAULT_BUDGET_GATE_MAX_USED_PERCENT },
};

function percentInRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** 칸마다 0~100. 범위 밖·비수치는 경고 후 그 칸의 기본. 객체가 아니면 기본 전체. */
export function parseBudgetGateMaxUsedPercent(raw: unknown): BudgetGateMaxUsedPercent {
  const fallback = { ...DEFAULT_BUDGET_GATE_MAX_USED_PERCENT };
  if (raw === undefined) return fallback;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('harness.budgetGate.maxUsedPercent', `객체가 아니다(${JSON.stringify(raw)}) — 기본 ${JSON.stringify(fallback)} 로 진행`);
    return fallback;
  }
  const out: { [provider: string]: number } = { ...fallback };
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!provider.trim()) continue;
    if (percentInRange(value)) out[provider] = value;
    else {
      const kept = fallback[provider];
      warnUserConfigDrop(
        `harness.budgetGate.maxUsedPercent.${provider}`,
        `0~100 이 아니다(${JSON.stringify(value)}) — ${kept === undefined ? '버림' : `기본 ${kept} 로 진행`}`,
      );
    }
  }
  return out;
}

/** 범위 밖·모르는 값은 경고와 함께 기본. 섹션이 없어도 기본을 돌려준다. */
export function parseHarnessBudgetGate(raw: unknown): HarnessBudgetGateConfig {
  const fallback = {
    minHeadroomPercent: DEFAULT_BUDGET_GATE.minHeadroomPercent,
    onShortfall: DEFAULT_BUDGET_GATE.onShortfall,
    maxUsedPercent: { ...DEFAULT_BUDGET_GATE_MAX_USED_PERCENT },
  };
  if (raw === undefined) return fallback;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('harness.budgetGate', `객체가 아니다(${JSON.stringify(raw)}) — 기본 ${fallback.minHeadroomPercent}/${fallback.onShortfall} 로 진행`);
    return fallback;
  }
  const v = raw as Record<string, unknown>;
  let minHeadroomPercent = fallback.minHeadroomPercent;
  if (v.minHeadroomPercent !== undefined) {
    const n = v.minHeadroomPercent;
    if (percentInRange(n)) minHeadroomPercent = n;
    else warnUserConfigDrop('harness.budgetGate.minHeadroomPercent', `0~100 이 아니다(${JSON.stringify(n)}) — 기본 ${fallback.minHeadroomPercent} 로 진행`);
  }
  let onShortfall = fallback.onShortfall;
  if (v.onShortfall !== undefined) {
    if ((BUDGET_GATE_ON_SHORTFALL as readonly string[]).includes(v.onShortfall as string)) onShortfall = v.onShortfall as BudgetGateOnShortfall;
    else warnUserConfigDrop('harness.budgetGate.onShortfall', `허용값이 아니다(${JSON.stringify(v.onShortfall)}) — 기본 ${fallback.onShortfall} 로 진행`);
  }
  const maxUsedPercent = parseBudgetGateMaxUsedPercent(v.maxUsedPercent);
  return { minHeadroomPercent, onShortfall, maxUsedPercent };
}

function parseRegistryConfig(raw: unknown): RegistryConfig {
  const empty: RegistryConfig = { discovery: { cron: {}, firecrawl: {} } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const root = raw as Record<string, unknown>;
  const discovery = (root.discovery && typeof root.discovery === 'object' && !Array.isArray(root.discovery))
    ? root.discovery as Record<string, unknown>
    : {};
  const cron = (discovery.cron && typeof discovery.cron === 'object' && !Array.isArray(discovery.cron))
    ? discovery.cron as Record<string, unknown>
    : {};
  const firecrawl = (discovery.firecrawl && typeof discovery.firecrawl === 'object' && !Array.isArray(discovery.firecrawl))
    ? discovery.firecrawl as Record<string, unknown>
    : {};
  const intervalMs = typeof cron.intervalMs === 'number' && Number.isFinite(cron.intervalMs) && cron.intervalMs > 0
    ? cron.intervalMs
    : undefined;
  const apiKey = typeof firecrawl.apiKey === 'string' && firecrawl.apiKey.trim().length > 0
    ? firecrawl.apiKey.trim()
    : undefined;
  return {
    discovery: {
      cron: {
        ...(intervalMs !== undefined ? { intervalMs } : {}),
      },
      firecrawl: {
        ...(apiKey !== undefined ? { apiKey } : {}),
      },
    },
  };
}

const LSP_DEFAULTS: LspConfig = {
  enabled: true,
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['py'],
  },
  rust: {
    command: 'rust-analyzer',
    // rust-analyzer defaults to stdio when no transport flag is given;
    // no args needed in the common case. Users can override.
    args: [],
    extensions: ['rs'],
  },
  idleTimeoutMs: 10 * 60 * 1000,
  workspaceSymbolLanguage: 'typescript',
};

/** Hardcoded fallbacks used when neither user config nor env supplies
 *  a value. Resolvers in `voice/*` keep these in sync — exported here
 *  so docs / tests can reference one canonical source. */
export const VOICE_HARDCODED_DEFAULTS = {
  sttProvider: 'openai-realtime-stt' as VoiceSttProviderId,
  ttsProvider: 'openai-tts' as VoiceTtsProviderId,
  ttsAuto: false,
  vadMode: 'server' as VoiceVadMode,
  vadThreshold: 0.012,
  vadSilenceMs: 800,
  vadMinSpeechMs: 200,
  chatMultiTurn: false,
  ttsDrainCooldownMs: 300,
  discordVoiceChannelEnabled: false,
  discordVoiceChannelListenFilter: 'caller' as VoiceDiscordChannelListenFilter,
  discordVoiceChannelLeaveOnEmpty: true,
} as const;

function normalizeVoiceSttProvider(v: unknown): VoiceSttProviderId {
  if (v === 'gemini-live-stt' || v === 'whisper-cpp-local'
    || v === 'elevenlabs-scribe-realtime') return v;
  return 'openai-realtime-stt';
}
function normalizeVoiceTtsProvider(v: unknown): VoiceTtsProviderId {
  if (v === 'elevenlabs-tts' || v === 'edge-tts' || v === 'macos-say') return v;
  return 'openai-tts';
}
function normalizeVoiceVadMode(v: unknown): VoiceVadMode {
  if (v === 'local' || v === 'manual') return v;
  return 'server';
}
function normalizeVoiceTelegramDispatch(v: unknown): VoiceTelegramDispatchMode | undefined {
  if (v === 'auto-reply' || v === 'tui-bridge') return v;
  return undefined;
}
function normalizeVoiceDiscordChannelListenFilter(
  v: unknown,
): VoiceDiscordChannelListenFilter | undefined {
  if (v === 'caller' || v === 'all') return v;
  return undefined;
}
function normalizeIntakeAmbientCaptureMode(v: unknown): IntakeAmbientCaptureMode | undefined {
  if (v === 'off' || v === 'suggest' || v === 'capture') return v;
  return undefined;
}

const FINANCE_DEFAULTS: FinanceConfig = {
  enabled: false,
  autoLoop: { enabled: false, maxPerScan: 2 },
  dig: { autoGoal: { enabled: false, maxPerDay: 2, maxTurns: 6, independentChecker: false } },
  kg: { extract: { enabled: false }, anomalyDig: { enabled: false } },
  replay: { autoGoal: { enabled: false, maxTurns: 3, tokenCap: 80_000, windowStartHour: 6, windowEndHour: 7 } },
  conatusNativePort: false,
  liveOrders: false,
  relaxedGates: false,
};

export function parseSubscriptionReviewerSpec(raw: unknown): SubscriptionReviewerSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (v.provider !== 'claude-acp' || (v.executor !== undefined && v.executor !== 'cct' && v.executor !== 'cc')
    || Object.keys(v).some(k => k !== 'provider' && k !== 'executor')) return undefined;
  return { provider: 'claude-acp', ...(v.executor ? { executor: v.executor as 'cct' | 'cc' } : {}) };
}

export function parseReviewerMixSpec(raw: unknown): ReviewerMixSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'sol' && key !== 'claude' && key !== 'glm')) return undefined;
  const weights = [value.sol, value.claude, value.glm];
  if (weights.some(weight => !Number.isSafeInteger(weight) || (weight as number) < 0) ||
      weights.every(weight => weight === 0) ||
      !Number.isSafeInteger(weights.reduce<number>((sum, weight) => sum + (weight as number), 0))) return undefined;
  return { sol: value.sol as number, claude: value.claude as number, glm: value.glm as number };
}

// ⛔ 역할 기본값은 «모델 이름»이 아니라 «필요 성능(tier)»이다 (대표 2026-08-18).
//    이름으로 박아 두면 llm.provider 를 바꿔도 따라오지 않는다 — 티어면 활성 provider 의
//    사다리가 채운다. 무거운 저작(planning)만 best 이고 나머지는 그 아래로 충분하다.
/** ⭐ export 인 이유 — **문서가 이 값을 「재게」 하기 위해서다**(AGENTS.md §페이즈별 LLM ⑹ⓐ).
 *  ⛔ 진입 문서에 역할별 기본 티어·env 이름을 «적으면» 그 표가 늙는다. 그래서 적지 않고 여기서 읽는다. */
export const ROLE_MODEL_DEFAULTS: Record<ModelRole, { environment: string; tier: ModelTier }> = {
  implement: { environment: 'ELANOUS_SELF_IMPLEMENT_MODEL', tier: 'better' },
  // ⭐⭐ 2026-09-23 (대표 승인) — ***`loaded` → `best`.*** 「천장」이 상시 레인이 돼 있었다.
  //
  // 🩸 무엇이 어긋나 있었나 — ***바로 위 주석이 이 값을 반박한다***:
  //    *"무거운 저작(planning)만 best 이고 나머지는 그 아래로 충분하다"* (대표 2026-08-18)
  //    그런데 review 만 `loaded` 로 ***best 보다 한 칸 «위»***에 있었다.
  //
  // 📏 실측 2026-09-23 (codex 과금 인시던트 중에 드러났다):
  //    ⑴ `loaded` 를 «자동으로» 부르는 페이즈는 ***이것 하나***였다(여섯 중 하나 · 전수 확인).
  //    ⑵ 21시간 창에서 `gpt-6-astra` ***1,925건 = codex 요청의 19%***
  //       (⚠️ 조회가 상한 40,000행에 닿아 이 수는 «하한»이다).
  //    ⑶ astra 는 sol 대비 ***input·output 각 5배***($10/$50 ↔ $2/$10).
  //    ⑷ 🔑 그런데 ***5배를 내면서 추론은 «덜» 했다*** — review=astra·medium ↔ planning=sol·high.
  //       「더 깊게 보라」가 목적이었다면 그 목적을 배반하는 값이었다.
  //
  // ✅ 바꾼 뒤: review = `best` = (codex 기준) gpt-6-sol·***high*** — 공식 문서상 Reasoning 등급이
  //    astra 와 «같은 Highest» 이고 effort 는 오히려 «올라간다». 비용은 1/5.
  // ⛔ 사람이 «명시로» 고르는 길은 «안» 막는다 — `--tier max` · `/model astra` 는 그대로다
  //    (`llm-tier-map` 의 별칭 max/deep/maxi → loaded 는 손대지 않았다).
  // 🔲 ***안 쟀다*** — 「리뷰 품질이 떨어지나」. 떨어지면 되돌릴 자리는 이 한 줄이다.
  review: { environment: 'ELANOUS_PR_REVIEW_MODEL', tier: 'best' },
  research: { environment: 'ELANOUS_MEMORY_JUDGE_MODEL', tier: 'better' },
  planning: { environment: 'ELANOUS_SKILL_PLAN_MODEL', tier: 'best' },
  audit: { environment: 'ELANOUS_MEMORY_JUDGE_MODEL', tier: 'better' },
  classify: { environment: 'ELANOUS_ACTION_CLASSIFIER_MODEL', tier: 'budget' },
  'graph-grow': { environment: 'ELANOUS_GRAPH_GROW_MODEL', tier: 'better' },
  // 이 티어는 provider 만 명시했을 때 쓰인다. 에이전트 기동은
  // resolveConfiguredAgentRoleLlm 이 명시 설정을 먼저 요구한다.
  coordinator: { environment: 'ELANOUS_COORDINATOR_MODEL', tier: 'balanced' },
  guardian: { environment: 'ELANOUS_GUARDIAN_MODEL', tier: 'balanced' },
};

/** Resolve `auto` through the same runtime provider selector that dispatches LLM calls.
 * The deferred require preserves the existing user-config ↔ llm module boundary.
 *
 * ⭐ export 인 이유(2026-08-18): `tools.nativeStructure.providers` 를 판정하려면 소비처가
 *   ***「지금 어느 provider 인가」***를 알아야 한다. `config.llm.provider` 를 그대로 읽으면
 *   `'auto'` 를 그 문자열대로 비교해 «영영 안 맞는다» — 그것이 이 함수가 푸는 문제다.
 *   ⛔ 소비처가 이 로직을 다시 쓰면 두 자리가 갈린다. 한 자리만 둔다. */
export function resolveActiveProvider(config: UserConfig): LLMProviderName {
  if (config.llm.provider !== 'auto') return config.llm.provider;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { decideProviderForConfig, getProvider } = require('./llm.js') as {
    decideProviderForConfig: (config: UserConfig) => { provider: LLMProviderName | `auto:${string}` };
    getProvider: () => { name: string };
  };
  // ⭐ 2026-09-24 — 런타임이 실제로 보내는 곳과 같은 결정을 쓴다(종전 `getProvider()` 는 auto 에서 codex 를 건너뛰었다).
  const decided = decideProviderForConfig(config).provider;
  if (typeof decided === 'string' && decided.startsWith('auto:')) return decided.slice('auto:'.length) as LLMProviderName;
  return getProvider().name as LLMProviderName;
}

/** 기존 사다리 ③~⑥ — 문면·순서·의미를 그대로 둔다(무회귀가 1차 제약).
 *  ⛔ provider 를 «인자로만» 받는다 — 여기서 전역을 다시 읽으면 「한 번 정하고 인자로 내린다」가 끊긴다. */
function resolveRoleLlmBaseline(role: ModelRole, config: UserConfig, provider: LLMProviderName): RoleLlmResolution {
  const configured = config.roleModels?.[role]?.trim();
  if (configured) return { model: configured, provider, source: 'config' };
  const tier = config.roleModelTiers?.[role];
  if (tier) return { model: lookupLlmTierSpec(provider, tier).model, provider, tier, source: 'tier' };
  const { environment, tier: defaultTier } = ROLE_MODEL_DEFAULTS[role];
  const fromEnvironment = process.env[environment]?.trim();
  if (fromEnvironment) return { model: fromEnvironment, provider, source: 'environment' };
  return { model: lookupLlmTierSpec(provider, defaultTier).model, provider, tier: defaultTier, source: 'default' };
}

/** provider «만» 갈렸을 때 — 모델 «이름»을 박는 층(roleModels·env)은 건너뛴다.
 *  ⛔ 이름은 provider 에 매인 값이라 다른 provider 로 그 이름을 부르면 「없는 모델」이 된다
 *  (110차 grok-4-1-fast 사건과 같은 축: 요청한 식별자와 응답이 갈린다). 티어는 provider 를 따라온다. */
function resolveRoleTierOnly(role: ModelRole, config: UserConfig, provider: LLMProviderName): RoleLlmResolution {
  const configuredTier = config.roleModelTiers?.[role];
  const tier = configuredTier ?? ROLE_MODEL_DEFAULTS[role].tier;
  return { model: lookupLlmTierSpec(provider, tier).model, provider, tier, source: configuredTier ? 'tier' : 'default' };
}

/** 해석 결과를 관측에 싣는다 — ⛔ 값 옆에 «출처»를 둔다.
 *  발사 인자(overrides)가 주어졌거나 config.roleLlm 이 그 역할을 갖고 있을 때만 찍는다:
 *  그 축이 «판에 있을 때»는 맞았든 틀렸든 남고, 아무도 안 쓰면 소음이 없다.
 *  ⚠️ deferred require — user-config ↔ debug 모듈 경계를 보존한다(resolveActiveProvider 와 동형). */
function observeRoleLlm(role: ModelRole, resolution: RoleLlmResolution, requested: RoleLlmSpec | undefined): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { debug } = require('./debug/log.js') as typeof import('./debug/log.js');
    debug.log('harness.role-llm', 'resolve', {
      role,
      model: resolution.model,
      provider: resolution.provider,
      ...(resolution.tier ? { tier: resolution.tier } : {}),
      source: resolution.source,
      ...(requested ? { requestedProvider: requested.provider ?? null, requestedTier: requested.tier ?? null } : {}),
    });
  } catch { /* 관측 실패가 해석을 막지 않는다 — fail-open */ }
}

/** 발사 시점에 «한 번» 정해지는 override — 프로세스 진입점(CLI 액션)이 세우고 아래는 인자로 읽는다.
 *  ⛔ 이것은 「환경변수를 흉내낸 전역」이 아니다: ①진입점에서 «한 번만» 세울 수 있고
 *  ②다른 값으로 다시 세우면 «거부»하며 ③해석 결과에 source='flag' 로 «출처가 남는다».
 *  RFC-role-scoped-llm-selection-2026-08-18 §2a — 조용히 덮이는 전역이 이 축의 실패 모드다. */
let launchRoleLlmOverrides: RoleLlmConfig | undefined;

export function setLaunchRoleLlmOverrides(overrides: RoleLlmConfig, opts: SetLaunchRoleLlmOptions = {}): void {
  const previous = launchRoleLlmOverrides;
  const next = JSON.stringify(overrides);
  if (previous !== undefined && JSON.stringify(previous) !== next && !opts.allowReplace) {
    // ⛔ 발사 경로에서 «두 번 다르게» 정해지면 그것은 사고다 — 조용히 덮지 않고 멈춘다.
    //   ⭐ throw «전에» 관측을 남긴다 — 예외만 던지면 「무엇이 무엇으로 덮이려 했나」가 로그에 안 남는다.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { debug } = require('./debug/log.js') as typeof import('./debug/log.js');
      debug.log('harness.role-llm', 'overrides-rejected', {
        origin: opts.origin ?? 'unknown', previous, attempted: overrides,
      });
    } catch { /* fail-open */ }
    throw new Error(
      `역할별 LLM 은 발사 시점에 한 번만 정한다 — 이미 ${JSON.stringify(previous)} 로 정해졌고 ${next} 로 다시 정하려 했다`,
    );
  }
  launchRoleLlmOverrides = overrides;
  if (previous !== undefined && JSON.stringify(previous) !== next) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { debug } = require('./debug/log.js') as typeof import('./debug/log.js');
      debug.log('harness.role-llm', 'overrides-replaced', {
        origin: opts.origin ?? 'unknown', previous: previous ?? null, next: overrides,
      });
    } catch { /* fail-open */ }
  }
}

export function getLaunchRoleLlmOverrides(): RoleLlmConfig | undefined {
  return launchRoleLlmOverrides;
}

/** 테스트 전용 — 프로세스 수명 안에서 발사 override 를 지운다. */
export function clearLaunchRoleLlmOverrides(): void {
  launchRoleLlmOverrides = undefined;
}

/** ★ 역할별 LLM 해석 SSOT — RFC-role-scoped-llm-selection-2026-08-18 §4c.
 *  사다리: ① overrides(flag) → ①b env 고정 `ELANOUS_ROLE_LLM_<ROLE>`(POD-ROLE-LLM) → ② config.roleLlm → ③~⑥ 기존(resolveRoleLlmBaseline).
 *  ⛔ 아무 override 도 없으면 ③~⑥ 만 타므로 산출이 종전과 «같다»(§4f 불변식 · NL 진입 무변경). */
export function resolveRoleLlm(role: ModelRole, opts: RoleLlmResolveOptions = {}): RoleLlmResolution {
  const config = opts.config ?? getUserConfig();
  // 전역 provider 는 필요할 때만 푼다 — 역할이 provider 를 명시했으면 전역 provider 가 없어도 해석된다.
  let activeProvider: LLMProviderName | undefined;
  const globalProvider = (): LLMProviderName => (activeProvider ??= resolveActiveProvider(config));
  // 명시 인자가 있으면 그것이 진실 — 없을 때만 발사 시점에 정해진 값을 읽는다(둘 다 source='flag').
  const flagSpec = (opts.overrides ?? launchRoleLlmOverrides)?.[role];
  const envSpec = roleLlmEnvPin(role, opts.env ?? process.env);
  const layers: ReadonlyArray<readonly [RoleLlmSpec | undefined, RoleLlmSource]> = [
    [flagSpec, 'flag'],
    [envSpec, 'environment'],
    [config.roleLlm?.[role], 'config-role'],
  ];
  for (const [spec, source] of layers) {
    if (!spec) continue;
    const provider = spec.provider ?? globalProvider();
    const pinned = spec.model?.trim();
    let resolution: RoleLlmResolution | undefined;
    if (pinned) resolution = { model: pinned, provider, ...(spec.tier ? { tier: spec.tier } : {}), source };
    else if (spec.tier) resolution = { model: lookupLlmTierSpec(provider, spec.tier).model, provider, tier: spec.tier, source };
    else if (spec.provider) resolution = { ...resolveRoleTierOnly(role, config, provider), source };
    if (resolution) { observeRoleLlm(role, resolution, spec); return resolution; }
    // 세 칸이 «다 비었으면» 아래 층으로 흘린다 — 빈 칸은 선언이 아니다.
  }
  const baseline = resolveRoleLlmBaseline(role, config, globalProvider());
  if (opts.overrides || launchRoleLlmOverrides || envSpec || config.roleLlm?.[role]) observeRoleLlm(role, baseline, flagSpec);
  return baseline;
}

/** 조율자·수호자는 사용자 선택이 없으면 기동하지 않는다.
 *  일반 역할의 기본 모델 사다리와 구분해, 발사 인자·env pin·roleLlm 설정 중
 *  실제 모델 선택(provider/tier/model)이 있을 때만 해석한다. effort 단독은 선택이 아니다. */
export function resolveConfiguredAgentRoleLlm(
  role: AgentModelRole,
  opts: RoleLlmResolveOptions = {},
): RoleLlmResolution | undefined {
  const config = opts.config ?? getUserConfig();
  const hasSelection = (spec: RoleLlmSpec | undefined): boolean =>
    Boolean(spec?.provider || spec?.tier || spec?.model?.trim());
  const configured = [
    (opts.overrides ?? launchRoleLlmOverrides)?.[role],
    roleLlmEnvPin(role, opts.env ?? process.env),
    config.roleLlm?.[role],
  ].some(hasSelection);
  return configured ? resolveRoleLlm(role, { ...opts, config }) : undefined;
}

/** POD-ROLE-LLM — 역할 고정을 «프로세스 env» 로 받는 칸. `ELANOUS_ROLE_LLM_<ROLE>` = RoleLlmSpec JSON
 *  (예 `{"provider":"openai-codex","tier":"best","model":"gpt-6-sol"}`).
 *  ⭐ 왜 env 인가: `--role-llm` 은 부모 프로세스 메모리 값이고 Pod 안엔 운영 config 가 없다 —
 *    Pod Job 이 실을 수 있는 «비밀 아닌» 길은 armEnv 하나뿐이다(self-implement-pod.ts).
 *  ⛔ 못 읽는 값은 삼키지 않고 관측을 남긴 뒤 «무시»한다(아래 층으로 흘린다 · 고정 실패가 런을 죽이지 않는다). */
export function roleLlmEnvName(role: ModelRole): string {
  return `ELANOUS_ROLE_LLM_${role.toUpperCase().replace(/-/g, '_')}`;
}

function roleLlmEnvPin(role: ModelRole, env: NodeJS.ProcessEnv): RoleLlmSpec | undefined {
  const name = roleLlmEnvName(role);
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  const entry = parseRoleLlmEntry(parsed);
  if (entry.ok) return entry.spec;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { debug } = require('./debug/log.js') as typeof import('./debug/log.js');
    debug.log('harness.role-llm', 'env-pin-rejected', { role, env: name, reason: parsed === undefined ? 'not-json' : 'invalid-spec' });   // ⛔ 값 원문은 싣지 않는다
  } catch { /* fail-open */ }
  return undefined;
}

/** Resolves a model role without forcing a sparse user setting when it is empty.
 *  ⭐ 이제 resolveRoleLlm 위의 «얇은 래퍼»다 — 그래야 기존 소비자 «전부»가 새 사다리를 자동으로 탄다
 *  (옆에 새 함수를 두면 「형태만 있고 실행 경로엔 없다」가 된다). */
export function resolveRoleModel(role: ModelRole, config: UserConfig = getUserConfig()): ModelResolution {
  const resolved = resolveRoleLlm(role, { config });
  const source: ModelResolutionSource =
    resolved.source === 'flag' || resolved.source === 'config-role' ? 'config' : resolved.source;
  return { model: resolved.model, source };
}


import { ORCHESTRATOR_DEFAULTS, parseOrchestratorLoopConfig } from './user-config/orchestrator.js';
export * from './user-config/orchestrator.js';

export function parseEventsConfig(input: unknown): EventsConfig {
  const events = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const routes: EventRoute[] = [];
  const linearAssignees: Record<string, EventSeat> = Object.create(null);
  if (events.linearAssignees && typeof events.linearAssignees === 'object' && !Array.isArray(events.linearAssignees)) {
    for (const [id, seat] of Object.entries(events.linearAssignees)) {
      if (id.trim() && (seat === 'OP' || seat === 'TC' || seat === 'MK' || seat === 'UX')) linearAssignees[id] = seat;
    }
  }
  if (Array.isArray(events.routes)) for (const value of events.routes) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const route = value as Record<string, unknown>;
    if ((route.source === 'linear' || route.source === 'asana' || route.source === 'github') && typeof route.kind === 'string' && route.kind.trim()
      && (route.seat === 'OP' || route.seat === 'TC' || route.seat === 'MK' || route.seat === 'UX') && route.loop === 'seat')
      routes.push({ source: route.source, kind: route.kind, seat: route.seat, loop: route.loop });
  }
  return { mode: events.mode === 'on' ? 'on' : 'shadow', routes, linearAssignees };
}

export function parseGateRemoteConfig(raw: unknown): GateRemoteConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: GateRemoteConfig = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  for (const key of ['host', 'mirror'] as const) if (typeof r[key] === 'string' && (r[key] as string).trim()) out[key] = (r[key] as string).trim();
  for (const key of ['loadThreshold', 'slotWaitSeconds'] as const) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  if (typeof r.hostCap === 'number' && Number.isSafeInteger(r.hostCap) && r.hostCap > 0 && r.hostCap <= 2) out.hostCap = r.hostCap;
  if (r.hostCaps && typeof r.hostCaps === 'object' && !Array.isArray(r.hostCaps)) {
    const caps = Object.fromEntries(Object.entries(r.hostCaps).filter(([host, cap]) =>
      /^(?:[\w.-]+@)?[\w.-]+$/.test(host) && !host.startsWith('-') &&
      typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= 1 && cap <= 8)) as Record<string, number>;
    if (Object.keys(caps).length) out.hostCaps = caps;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Validate one project's `rubric.axes` — throws the config error text (key duplicate · non-numeric weight). */
export function parseProjectRubricAxes(id: string, axes: unknown): Array<{ key: string; weight: number }> {
  if (!Array.isArray(axes)) throw new Error(`[user-config] projects.${id}.rubric.axes 는 배열이어야 합니다`);
  const seen = new Set<string>();
  const parsed: Array<{ key: string; weight: number }> = [];
  for (const [index, axis] of axes.entries()) {
    const field = `projects.${id}.rubric.axes[${index}]`;
    if (!axis || typeof axis !== 'object' || Array.isArray(axis)) throw new Error(`[user-config] ${field} 는 {key,weight} 객체여야 합니다`);
    const { key, weight } = axis as Record<string, unknown>;
    if (typeof key !== 'string' || !key.trim()) throw new Error(`[user-config] ${field}.key 는 빈 문자열일 수 없습니다`);
    if (seen.has(key)) throw new Error(`[user-config] projects.${id}.rubric.axes 키 중복: ${key}`);
    if (typeof weight !== 'number' || !Number.isFinite(weight)) throw new Error(`[user-config] ${field}.weight 는 유한한 숫자여야 합니다: ${String(weight)}`);
    seen.add(key);
    parsed.push({ key, weight });
  }
  return parsed;
}

/**
 * Project rubric axes (P3b CORE-GENERIC). Loading never throws — one bad project entry must not
 * stop every command — so an invalid entry keeps its error text and `resolveRubricAxes` raises it.
 */
function parseProjectsConfig(raw: unknown): Record<string, ProjectConfig> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const projects: Record<string, ProjectConfig> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (id === '__proto__' || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rubric = (entry as Record<string, unknown>).rubric;
    if (!rubric || typeof rubric !== 'object' || Array.isArray(rubric)) continue;
    const axes = (rubric as Record<string, unknown>).axes;
    if (axes === undefined) continue;
    try {
      projects[id] = { rubric: { axes: parseProjectRubricAxes(id, axes) } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`${error} — 이 프로젝트의 루브릭 축 해석은 오류로 멈춘다`);
      projects[id] = { rubric: { error } };
    }
  }
  return Object.keys(projects).length ? projects : undefined;
}

function parseRoleModelConfig(raw: unknown): RoleModelConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const values = raw as Record<string, unknown>;
  const parsed = Object.fromEntries(
    (['implement', 'review', 'research', 'planning', 'audit', 'classify'] as const)
      .flatMap((role) => typeof values[role] === 'string' && values[role].trim()
        ? [[role, values[role].trim()]]
        : []),
  ) as RoleModelConfig;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseRoleModelTierConfig(raw: unknown): RoleModelTierConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const values = raw as Record<string, unknown>;
  const parsed = Object.fromEntries(
    (['implement', 'review', 'research', 'planning', 'audit', 'classify'] as const)
      .flatMap((role) => isModelTier(values[role]) ? [[role, values[role]]] : []),
  ) as RoleModelTierConfig;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/** 역할별 LLM 파서 — ⛔ 「조용히 무시」를 만들지 않는 것이 이 함수의 계약이다.
 *  잘못된 provider/tier 는 «버리되» 무엇을 버렸는지 호출자가 알 수 있게 이유를 낸다
 *  (CLI 는 그 이유로 거부하고, config 로딩은 나머지를 살린다). */
export function parseRoleLlmEntry(raw: unknown): { ok: true; spec: RoleLlmSpec } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'object 가 아니다' };
  const v = raw as Record<string, unknown>;
  const spec: RoleLlmSpec = {};
  if (v.provider !== undefined) {
    if (typeof v.provider !== 'string' || !RUNTIME_LLM_PROVIDER_NAMES.includes(v.provider as LLMProviderName)) {
      return { ok: false, reason: `provider 가 알려진 값이 아니다: ${String(v.provider)} (허용: ${RUNTIME_LLM_PROVIDER_NAMES.join('|')})` };
    }
    spec.provider = v.provider as LLMProviderName;
  }
  if (v.tier !== undefined) {
    if (!isModelTier(v.tier)) return { ok: false, reason: `tier 가 알려진 값이 아니다: ${String(v.tier)}` };
    spec.tier = v.tier;
  }
  if (v.model !== undefined) {
    if (typeof v.model !== 'string' || !v.model.trim()) return { ok: false, reason: 'model 이 빈 문자열이다' };
    spec.model = v.model.trim();
  }
  if (Object.keys(spec).length === 0) return { ok: false, reason: 'provider·tier·model 중 하나는 있어야 한다' };
  return { ok: true, spec };
}

export const MODEL_ROLES: readonly ModelRole[] = ['implement', 'review', 'research', 'planning', 'audit', 'classify', 'graph-grow', 'coordinator', 'guardian'];

export function isModelRole(v: unknown): v is ModelRole {
  return typeof v === 'string' && (MODEL_ROLES as readonly string[]).includes(v);
}

const AUTO_REVIEW_MODES = ['off', 'opt-in', 'auto'] as const;

function positiveFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** One stderr line for a dropped config value — same path as other sections
 *  (nativeStructure providers, llm model-provider mismatch). Never throws. */
function warnUserConfigDrop(section: string, detail: string): void {
  try {
    process.stderr.write(`[user-config] ${section} ${detail}\n`);
  } catch { /* swallow — stderr 가 닫힌 경우 */ }
}

/** Copy `autoReview` into AutoReviewConfig. Absent section stays undefined
 *  (reader default 'opt-in' is not applied here). Invalid mode is dropped,
 *  not coerced. Depth numbers are positive finite only. */
function parseAutoReviewConfig(raw: unknown): AutoReviewConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('autoReview', `섹션이 객체가 아니다(${JSON.stringify(raw)}) — 버림`);
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  const out: AutoReviewConfig = {};
  if (v.mode !== undefined) {
    if ((AUTO_REVIEW_MODES as readonly string[]).includes(v.mode as string)) {
      out.mode = v.mode as AutoReviewConfig['mode'];
    } else {
      warnUserConfigDrop('autoReview.mode', `허용값이 아니다(${JSON.stringify(v.mode)}) — 버림(기본으로 접지 않음)`);
    }
  }
  if (v.depth !== undefined) {
    if (!v.depth || typeof v.depth !== 'object' || Array.isArray(v.depth)) {
      warnUserConfigDrop('autoReview.depth', `객체가 아니다(${JSON.stringify(v.depth)}) — 버림`);
    } else {
      const d = v.depth as Record<string, unknown>;
      const depth: NonNullable<AutoReviewConfig['depth']> = {};
      if (d.maxLightFiles !== undefined) {
        const n = positiveFiniteNumber(d.maxLightFiles);
        if (n === undefined) warnUserConfigDrop('autoReview.depth.maxLightFiles', `양의 유한수가 아니다(${JSON.stringify(d.maxLightFiles)}) — 버림`);
        else depth.maxLightFiles = n;
      }
      if (d.maxLightLines !== undefined) {
        const n = positiveFiniteNumber(d.maxLightLines);
        if (n === undefined) warnUserConfigDrop('autoReview.depth.maxLightLines', `양의 유한수가 아니다(${JSON.stringify(d.maxLightLines)}) — 버림`);
        else depth.maxLightLines = n;
      }
      if (d.corePaths !== undefined) {
        if (!Array.isArray(d.corePaths) || d.corePaths.some((x) => typeof x !== 'string')) {
          warnUserConfigDrop('autoReview.depth.corePaths', `문자열 배열이 아니다(${JSON.stringify(d.corePaths)}) — 버림`);
        } else {
          depth.corePaths = d.corePaths;
        }
      }
      if (d.planDocPatterns !== undefined) {
        if (!Array.isArray(d.planDocPatterns) || d.planDocPatterns.some((x) => typeof x !== 'string')) {
          warnUserConfigDrop('autoReview.depth.planDocPatterns', `문자열 배열이 아니다(${JSON.stringify(d.planDocPatterns)}) — 버림`);
        } else {
          depth.planDocPatterns = d.planDocPatterns;
        }
      }
      if (Object.keys(depth).length > 0) out.depth = depth;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** HARNESS-PARENT-ON-MSB1 — `taskAgent.parentHost` (기본 없음 = 끔). 객체 또는 검증된 객체 목록. */
function parseTaskAgentParentHost(raw: unknown): NonNullable<UserConfig['taskAgent']>['parentHost'] {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const hosts = raw.map((entry) => parseParentHostEntry(entry)).filter((entry): entry is NonNullable<ReturnType<typeof parseParentHostEntry>> => entry !== undefined);
    return hosts.length ? hosts : undefined;
  }
  const host = parseParentHostEntry(raw);
  if (!host) warnUserConfigDrop('taskAgent.parentHost', '객체가 아니다 — 버림(로컬 발사)');
  return host;
}

function parseParentHostEntry(raw: unknown): { host?: string; cwd?: string; elanous?: string; configDir?: string; podPool?: string; approvalCapacity?: number } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: NonNullable<ReturnType<typeof parseParentHostEntry>> = {};
  for (const key of ['host', 'cwd', 'elanous', 'configDir', 'podPool'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  const capacity = (raw as Record<string, unknown>).approvalCapacity;
  if (Number.isSafeInteger(capacity) && (capacity as number) > 0) out.approvalCapacity = capacity as number;
  else if (capacity !== undefined) return undefined;
  return out;
}

/** Keeps `taskAgent.liveMoves` as raw strings — the allow-list (and the unknown-entry warning) lives in the task agent. */
function parseTaskAgentConfig(raw: unknown): UserConfig['taskAgent'] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('taskAgent', '섹션이 객체가 아니다 — 버림');
    return undefined;
  }
  const parentHost = parseTaskAgentParentHost((raw as Record<string, unknown>).parentHost);
  // TA-REJUDGE-PERIODIC — 음이 아닌 유한수만 산다(0 = 끔). 그 밖은 경고하고 버린다(= 끔 · 기본 부하 상한).
  const rejudge: { rejudgeEveryMinutes?: number; rejudgeMaxLoad?: number; repairMaxPerTick?: number; rejudgeMaxAgeHours?: number } = {};
  for (const key of ['rejudgeEveryMinutes', 'rejudgeMaxLoad'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) rejudge[key] = value;
    else warnUserConfigDrop(`taskAgent.${key}`, `음이 아닌 수가 아니다(${JSON.stringify(value)}) — 버림`);
  }
  const repairMaxPerTick = (raw as Record<string, unknown>).repairMaxPerTick;
  if (repairMaxPerTick !== undefined) {
    if (Number.isSafeInteger(repairMaxPerTick) && (repairMaxPerTick as number) >= 0) rejudge.repairMaxPerTick = repairMaxPerTick as number;
    else warnUserConfigDrop('taskAgent.repairMaxPerTick', `음이 아닌 정수가 아니다(${JSON.stringify(repairMaxPerTick)}) — 기본 3`);
  }
  const rejudgeMaxAgeHours = (raw as Record<string, unknown>).rejudgeMaxAgeHours;
  if (rejudgeMaxAgeHours !== undefined) {
    if (typeof rejudgeMaxAgeHours === 'number' && Number.isFinite(rejudgeMaxAgeHours) && rejudgeMaxAgeHours > 0)
      rejudge.rejudgeMaxAgeHours = rejudgeMaxAgeHours;
    else warnUserConfigDrop('taskAgent.rejudgeMaxAgeHours', `양의 유한수가 아니다(${JSON.stringify(rejudgeMaxAgeHours)}) — 기본 72`);
  }
  const queueRaw = (raw as Record<string, unknown>).landQueue;
  let landQueue: { command: string; remote: string } | undefined;
  if (queueRaw !== undefined) {
    if (queueRaw && typeof queueRaw === 'object' && !Array.isArray(queueRaw)
      && typeof (queueRaw as Record<string, unknown>).command === 'string'
      && isAbsolute((queueRaw as Record<string, string>).command)
      && typeof (queueRaw as Record<string, unknown>).remote === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test((queueRaw as Record<string, string>).remote)) {
      landQueue = { command: (queueRaw as Record<string, string>).command, remote: (queueRaw as Record<string, string>).remote };
    } else {
      warnUserConfigDrop('taskAgent.landQueue', '절대 command 경로와 유효한 remote 호스트가 필요 — 착지 fail-closed');
      landQueue = { command: '', remote: '' };
    }
  }
  const extras = { ...rejudge, ...(parentHost ? { parentHost } : {}), ...(landQueue ? { landQueue } : {}) };
  const liveMoves = (raw as Record<string, unknown>).liveMoves;
  if (liveMoves === undefined) return Object.keys(extras).length ? extras : undefined;
  // 설정이 «있으면» 환경 변수로 내려가지 않는다 — 배열이 아니면 빈 목록(fail-closed), 문자열 밖 항목은 글자로 바꿔 넘겨
  // 실행부가 «모르는 항목»으로 경고하고 버리게 한다(유효한 항목은 산다).
  if (!Array.isArray(liveMoves)) {
    warnUserConfigDrop('taskAgent.liveMoves', '배열이 아니다 — 빈 목록(실행 0)');
    return { liveMoves: [], ...extras };
  }
  return { liveMoves: liveMoves.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry) ?? String(entry)), ...extras };
}

function parseGuardianConfig(raw: unknown): UserConfig['guardian'] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('guardian', '섹션이 객체가 아니다 — 버림');
    return undefined;
  }
  const { mode, orphanGc, trainWorkerPolicy } = raw as Record<string, unknown>;
  const out: NonNullable<UserConfig['guardian']> = {};
  if (mode === 'shadow' || mode === 'live') out.mode = mode;
  else if (mode !== undefined) warnUserConfigDrop('guardian.mode', 'shadow 또는 live 가 아니다 — 버림');
  if (orphanGc === 'off' || orphanGc === 'shadow' || orphanGc === 'on') out.orphanGc = orphanGc;
  else if (orphanGc !== undefined) warnUserConfigDrop('guardian.orphanGc', `off|shadow|on 이 아니다(${JSON.stringify(orphanGc)}) — 버리고 shadow 로 진행`);
  if (trainWorkerPolicy !== undefined) {
    const policy = trainWorkerPolicy as Record<string, unknown>;
    if (policy && typeof policy === 'object' && !Array.isArray(policy)
      && Number.isSafeInteger(policy.minWorkers) && Number(policy.minWorkers) >= 0
      && Number.isSafeInteger(policy.maxWorkers) && Number(policy.maxWorkers) >= Number(policy.minWorkers)
      && Number.isFinite(policy.scaleDownCpuPercent) && Number(policy.scaleDownCpuPercent) >= 0 && Number(policy.scaleDownCpuPercent) <= 100
      && Number.isFinite(policy.scaleUpCpuPercent) && Number(policy.scaleUpCpuPercent) >= 0 && Number(policy.scaleUpCpuPercent) <= 100
      && Number(policy.scaleUpCpuPercent) < Number(policy.scaleDownCpuPercent)
      && Number.isSafeInteger(policy.gateReserveWorkers) && Number(policy.gateReserveWorkers) >= 0) {
      out.trainWorkerPolicy = {
        minWorkers: Number(policy.minWorkers), maxWorkers: Number(policy.maxWorkers),
        scaleDownCpuPercent: Number(policy.scaleDownCpuPercent), scaleUpCpuPercent: Number(policy.scaleUpCpuPercent),
        gateReserveWorkers: Number(policy.gateReserveWorkers),
      };
    } else warnUserConfigDrop('guardian.trainWorkerPolicy', 'worker policy fields are invalid — ignored');
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse optional ops fields independently; invalid settings cannot silently select a cron cwd. */
function parseOpsConfig(raw: unknown): UserConfig['ops'] | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnUserConfigDrop('ops', `섹션이 객체가 아니다(${JSON.stringify(raw)}) — 버림`);
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  const parsed: NonNullable<UserConfig['ops']> = {};
  if (v.selfHeal !== undefined) {
    if (!v.selfHeal || typeof v.selfHeal !== 'object' || Array.isArray(v.selfHeal)) {
      warnUserConfigDrop('ops.selfHeal', `객체가 아니다(${JSON.stringify(v.selfHeal)}) — 버림`);
    } else {
      const armed = (v.selfHeal as Record<string, unknown>).armed;
      if (armed !== undefined) {
        if (typeof armed === 'boolean') parsed.selfHeal = { armed };
        else warnUserConfigDrop('ops.selfHeal.armed', `불리언이 아니다(${JSON.stringify(armed)}) — 버림`);
      }
    }
  }
  if (v.cronRepoRoot !== undefined) {
    if (typeof v.cronRepoRoot === 'string' && v.cronRepoRoot.trim()) parsed.cronRepoRoot = v.cronRepoRoot.trim();
    else warnUserConfigDrop('ops.cronRepoRoot', `비어 있거나 문자열이 아니다(${JSON.stringify(v.cronRepoRoot)}) — 버림`);
  }
  return Object.keys(parsed).length ? parsed : undefined;
}

function parseAutopilotConfig(raw: unknown): UserConfig['autopilot'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const values = raw as Record<string, unknown>;
  const parsed: NonNullable<UserConfig['autopilot']> = {};
  const courier = values.trackCourier;
  if (courier && typeof courier === 'object' && !Array.isArray(courier)) {
    const v = courier as Record<string, unknown>;
    parsed.trackCourier = {
      enabled: v.enabled === true,
      ...(typeof v.channelPr === 'number' && Number.isSafeInteger(v.channelPr) && v.channelPr > 0 ? { channelPr: v.channelPr } : {}),
      handoffMinutes: typeof v.handoffMinutes === 'number' && Number.isFinite(v.handoffMinutes) && v.handoffMinutes > 0 ? v.handoffMinutes : 60,
    };
  }
  const agent = values.trackAgent;
  if (agent && typeof agent === 'object' && !Array.isArray(agent)) {
    const v = agent as Record<string, unknown>;
    parsed.trackAgent = {
      enabled: v.enabled === true,
      maxConcurrent: typeof v.maxConcurrent === 'number' && Number.isSafeInteger(v.maxConcurrent) && v.maxConcurrent > 0
        ? Math.min(v.maxConcurrent, 2) : 2,
      shadow: v.shadow === true,
      shadowMaxDecisionsPerDay: typeof v.shadowMaxDecisionsPerDay === 'number'
        && Number.isSafeInteger(v.shadowMaxDecisionsPerDay) && v.shadowMaxDecisionsPerDay >= 0
        ? v.shadowMaxDecisionsPerDay : 20,
    };
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseRoleLlmConfig(raw: unknown): RoleLlmConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const values = raw as Record<string, unknown>;
  const parsed: RoleLlmConfig = {};
  const dropped: Array<{ role: ModelRole; reason: string }> = [];
  for (const role of MODEL_ROLES) {
    if (values[role] === undefined) continue;
    const rawEntry = values[role];
    if (rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry)) {
      const { effort, ...modelFields } = rawEntry as Record<string, unknown>;
      const entry = effort !== undefined && Object.keys(modelFields).length === 0 ? undefined : parseRoleLlmEntry(modelFields);
      if (entry && !entry.ok) { dropped.push({ role, reason: entry.reason }); continue; }
      const spec: RoleLlmSpec = entry?.ok ? entry.spec : {};
      if (effort !== undefined) {
        if (effort === 'low' || effort === 'medium' || effort === 'high') spec.effort = effort;
        else warnUserConfigDrop(`roleLlm.${role}.effort`, `low|medium|high 가 아니다(${JSON.stringify(effort)}) — 버림`);
      }
      if ((role === 'coordinator' || role === 'guardian') && !spec.provider && !spec.tier && !spec.model) {
        dropped.push({ role, reason: 'provider·tier·model 중 하나는 있어야 한다 (effort 단독은 기동 설정이 아니다)' });
        continue;
      }
      if (Object.keys(spec).length > 0) parsed[role] = spec;
    } else {
      const entry = parseRoleLlmEntry(rawEntry);
      if (!entry.ok) dropped.push({ role, reason: entry.reason });
    }
  }
  if (values.reviewer !== undefined) {
    parsed.reviewer = parseSubscriptionReviewerSpec(values.reviewer);
    if (!parsed.reviewer) warnUserConfigDrop('roleLlm.reviewer', 'claude-acp reviewer 설정이 유효하지 않아 무시');
  }
  if (values.reviewerMix !== undefined) {
    parsed.reviewerMix = parseReviewerMixSpec(values.reviewerMix);
    if (!parsed.reviewerMix) warnUserConfigDrop('roleLlm.reviewerMix', '리뷰 비율 설정이 유효하지 않아 무시');
  }
  // ⛔ config 로딩은 «나머지를 살리려고» 잘못된 칸을 버리는데, 그 사실이 어디에도 안 남으면
  //   사용자는 「왜 내 설정이 안 먹지」를 영영 못 푼다(CLI 는 이름을 대며 거부하는데 여기만 조용했다).
  //   ⇒ 버린 것을 «이름과 이유»로 남긴다. 로딩 자체는 계속한다.
  if (dropped.length > 0) {
    for (const { role, reason } of dropped) {
      if (role === 'coordinator' || role === 'guardian') {
        warnUserConfigDrop(`roleLlm.${role}`, `${reason} — 버림; 명시 모델 없이는 에이전트 기동 거부`);
      }
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { debug } = require('./debug/log.js') as typeof import('./debug/log.js');
      debug.log('harness.role-llm', 'config-entry-dropped', { dropped, droppedCount: dropped.length });
    } catch { /* fail-open */ }
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function defaultConfig(): UserConfig {
  return {
    tui: { sidetab: 'collapsed' },
    cli: { helpRole: 'owner' },
    coo: { linearProject: '외부 행정·큰 일 (COO)' },
    decisions: { linearProjection: { enabled: false }, requireCrossCheck: false,
      crossCheckNeighbor: { OP: 'TC', TC: 'OP', MK: 'OP', UX: 'OP' }, crossCheckWaitMinutes: 120 },
    loops: { owners: {}, defaultOwner: 'OP', orchestrator: parseOrchestratorLoopConfig(undefined), steward: { mode: 'shadow' }, seat: { mode: 'shadow', questions: 'shadow', seats: ['MK'], podPool: 'pool-node-b@node-b:8' }, persona: { enabled: false } },
    skillRouter: { ...SR_DEFAULTS },
    llm: { ...LLM_DEFAULTS },
    skills: skillsDefaults(),
    obsidian: obsidianDefaults(),
    telegram: { ...TELEGRAM_DEFAULTS, allowedUsers: [] },
    discord: { ...DISCORD_DEFAULTS, allowedUsers: [] },
    finance: { ...FINANCE_DEFAULTS },
    onboarding: { ...ONBOARDING_DEFAULTS },
    debug: { ...DEBUG_DEFAULTS },
    logs: { retention: { ...LOGS_DEFAULTS.retention } },
    shell: { ...SHELL_DEFAULTS },
    chat: parseChatConfig(undefined),
    voice: { stt: {}, tts: {}, vad: {}, chat: {}, discord: {}, telegram: {}, pwa: {} },
    intake: { eventMax: 10, telegram: {}, discord: {} },
    dashboard: {
      promptBank: { ...DASHBOARD_PROMPT_BANK_DEFAULTS },
      foldMode: 'task-unit',
      enableVirtualWindowSwitchKeys: false,
    },
    vw: {
      windowNames: {},
      paneNames: {},
      entries: {
        acp: { ...VW_ENTRY_DEFAULTS.acp },
        sim: { ...VW_ENTRY_DEFAULTS.sim },
        iul: { ...VW_ENTRY_DEFAULTS.iul },
      },
      simResident: false,
      iulResident: false,
      iulForegroundOnStartup: false,
      order: [...VW_ORDER_DEFAULT],
    },
    acp: { hopCap: { ...ACP_DEFAULTS.hopCap }, toolApproval: { timeoutMs: acpApprovalTimeoutEnv() ?? ACP_DEFAULTS.toolApproval.timeoutMs } },
    lsp: cloneLspDefaults(),
    plan: { ...PLAN_DEFAULTS },
    goals: { ...GOALS_DEFAULTS },
    registry: {
      discovery: {
        cron: { ...REGISTRY_DEFAULTS.discovery.cron },
        firecrawl: { ...REGISTRY_DEFAULTS.discovery.firecrawl },
      },
    },
    tools: {
      deferred: { ...TOOLS_DEFAULTS.deferred },
      agentSpawn: { ...TOOLS_DEFAULTS.agentSpawn },
      runDevHarness: { ...TOOLS_DEFAULTS.runDevHarness },
    selfOrchestrate: { ...TOOLS_DEFAULTS.selfOrchestrate },
      nativeStructure: { ...TOOLS_DEFAULTS.nativeStructure },
      selfImplement: { ...TOOLS_DEFAULTS.selfImplement },
    },
    harness: { revertGuard: { depth: 50 }, nestedElanousMaxDepth: 2, budgetGate: { ...DEFAULT_BUDGET_GATE }, exposeGate: 'warn', difficultyPlacement: false, followUp: 'shadow' },
    grounding: { sources: [] },
    raw: {},
  };
}

// Phase 4 (PLAN-config-unification-elanous-root-2026-05-10):
//   Cache invalidation across modules / processes that share the unified
//   `~/.elanous/config.json`. NEXUS daemon's `patchUserConfig` (Path B
//   writer) atomically renames the file behind us; without an mtime
//   check the in-memory cache here would keep serving stale state.
function readMtimeMsOrNull(path: string): number | null {
  try { return statSync(path).mtimeMs; }
  catch { return null; }
}

// Phase 1 (PLAN-config-unification-elanous-root-2026-05-10):
//   XDG_CONFIG_HOME explicit  → legacy XDG path (test isolation + Phase 6 deprecation)
//   else                      → NEXUS canonical helper (~/.elanous/config.json · honors ELANOUS_DAEMON_DIR)
//
// Phase 3 (same PLAN): on first call from a non-XDG environment, migrate
// any legacy ~/.config/elanous/config.json into ~/.elanous/config.json (top-
// level merge · idempotent · legacy → .bak). Subsequent calls short-
// circuit via the once-per-process flag inside the migrate helper.
//
// Phase 6 (same PLAN): emit a one-time stderr warning when the user is
// still relying on XDG_CONFIG_HOME so Linux-fleet / CI users discover
// the new canonical path before a future release drops the back-compat.
let xdgDeprecationWarned = false;
export function __resetXdgDeprecationWarningForTests(): void {
  xdgDeprecationWarned = false;
}
function isInsideBunTest(): boolean {
  return process.argv.some((a) => a.endsWith('.test.ts') || a.endsWith('.test.js'));
}

function emitXdgDeprecationWarningOnce(xdgPath: string): void {
  if (xdgDeprecationWarned) return;
  xdgDeprecationWarned = true;
  if (process.env.ELANOUS_SUPPRESS_XDG_WARNING === '1') return;
  // Test runtimes are silent by default to keep suite output clean. The
  // dedicated assertion test passes ELANOUS_TEST_FORCE_XDG_WARNING=1 to
  // bypass this gate.
  if (isInsideBunTest() && process.env.ELANOUS_TEST_FORCE_XDG_WARNING !== '1') return;
  process.stderr.write(
    `[elanous config] XDG_CONFIG_HOME is set; reading ${xdgPath} (legacy).\n`
    + `  Canonical path is now ~/.elanous/config.json (since 2026-05-10).\n`
    + `  Unset XDG_CONFIG_HOME to migrate · ELANOUS_SUPPRESS_XDG_WARNING=1 to silence.\n`,
  );
}

export function userConfigPath(): string {
  // An explicit CLI override or an isolated root selected by --test or a
  // parent stamp must not be shadowed by legacy XDG from a parent shell.
  // All state roots, including bun test's isolation root, outrank legacy XDG.
  // XDG-only callers have no selected state root (covered by a spawned CLI).
  if (getElanousConfigDirOverride() !== undefined || process.env.ELANOUS_STATE_DIR?.trim() || getTestStateRoot() !== undefined) {
    return nexusUserConfigPath();
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    const xdgPath = join(xdg, 'elanous', 'config.json');
    emitXdgDeprecationWarningOnce(xdgPath);
    return xdgPath;
  }
  migrateLegacyXdgUserConfig();
  return nexusUserConfigPath();
}

function defaultPath(): string { return userConfigPath(); }

/** Sibling path to the primary config: `~/.elanous/llm-fallback.json`.
 *  User-curated · daemon writes NEVER touch this file (read-only contract).
 *  When the primary config's `llm` section is missing or effectively empty
 *  (provider absent / 'auto' / 'none'), `buildUserConfig` merges from this
 *  fallback so the setup gate (`checkLlm`) stays satisfied even when
 *  `~/.elanous/config.json` gets sparse-wiped by a misbehaving writer.
 *
 *  Suggested permissions: `chmod 0444` to prevent accidental in-place edits. */
export function llmFallbackPath(): string {
  return userConfigPath().replace(/config\.json$/, 'llm-fallback.json');
}

/** Read the read-only LLM fallback file. Returns the parsed `llm` blob
 *  or null when the file is missing / unreadable / not an object.
 *
 *  The fallback file's top level IS the `llm` shape (provider · baseUrl ·
 *  apiKey · model · rotation · …). It is NOT a full UserConfig — only the
 *  `llm` section.  Mirrors `jq '.llm' ~/.elanous/config.json > llm-fallback.json`. */
export function readLlmFallback(): Record<string, unknown> | null {
  const path = llmFallbackPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch { /* swallow */ }
  return null;
}

/** Heuristic: is the primary config's `llm` section effectively empty?
 *  True when `provider` is missing / 'auto' / 'none' — these all fail the
 *  setup gate, so fallback merge is appropriate. */
function isLlmSectionEmpty(llm: Record<string, unknown>): boolean {
  const provider = typeof llm.provider === 'string' ? llm.provider : '';
  return !provider || provider === 'auto' || provider === 'none';
}

let didLogFallbackOnce = false;

/** Log one stderr line the first time fallback is consumed during the
 *  process lifetime. Helps the user notice "primary config got wiped /
 *  daemon is using fallback now" without spamming repeated emits. */
function logFallbackUsedOnce(): void {
  if (didLogFallbackOnce) return;
  didLogFallbackOnce = true;
  try {
    process.stderr.write(
      '[user-config] primary llm section missing/empty — loaded from llm-fallback.json (read-only substrate).\n',
    );
  } catch { /* swallow — stderr 가 닫힌 경우 */ }
}

/** Resolve the process-scoped provider override before credential parsing.
 * `ELANOUS_LLM_PROVIDER` intentionally wins over config so one invocation and
 * inherited child processes can select a provider without mutating user config. */
function runtimeLlmProviderOverride(): LLMProviderName | undefined {
  const requested = process.env.ELANOUS_LLM_PROVIDER?.trim();
  if (!requested) return undefined;
  if (!(RUNTIME_LLM_PROVIDER_NAMES as readonly string[]).includes(requested)) {
    throw new Error(`Invalid ELANOUS_LLM_PROVIDER "${requested}". Allowed providers: ${RUNTIME_LLM_PROVIDER_NAMES.join(', ')}`);
  }
  return requested as LLMProviderName;
}

function observeRuntimeLlmModelProviderMismatch(provider: LLMProviderName, model: string): void {
  debug.log('user-config.llm', 'model-provider-mismatch', { provider, model });
  try {
    process.stderr.write(
      `[user-config] llm model-provider mismatch: provider=${provider} model=${model}\n`,
    );
  } catch { /* swallow — stderr 가 닫힌 경우 */ }
}

function defaultModelForProvider(provider: LLMProviderName): string | undefined {
  switch (provider) {
    case 'grok': return GROK_MODEL;
    case 'openai': return OPENAI_MODEL;
    // ⛔ 2026-09-25 — 구독(codex) 경로를 API 상수(`OPENAI_MODEL`=gpt-4o-mini)로 접지 않는다.
    //   실측: Pod 에 `ELANOUS_LLM_PROVIDER=openai-codex` 만 주자 `Codex API 400: The 'gpt-4o-mini' model is
    //   not supported when using Codex with a ChatGPT account.` 로 첫 호출에서 죽었다. ⇒ CODEX 사다리에서 파생.
    case 'openai-codex': return lookupLlmTierSpec('openai-codex', 'balanced').model;
    case 'hq-proxy': return lookupLlmTierSpec('openai-codex', 'balanced').model;
    case 'anthropic': return ANTHROPIC_MODEL;
    case 'local': return LOCAL_LLM_MODEL;
    case 'gemini': return GEMINI_MODEL;
    case 'kimi': return KIMI_MODEL;
    case 'qwen': return QWEN_MODEL;
    case 'glm': return GLM_MODEL;
    case 'bedrock': return BEDROCK_DEFAULT_MODEL;
    case 'auto': return undefined;
  }
}

function resolveRuntimeLlmModel(
  baseProvider: LLMProviderName,
  selectedProvider: LLMProviderName,
  configuredModel: string | undefined,
  escalationProvider: string | undefined,
): string | undefined {
  if (escalationProvider) return process.env.ELANOUS_ESCALATE_MODEL?.trim() || configuredModel;
  const explicitModel = process.env.ELANOUS_LLM_MODEL?.trim();
  if (explicitModel) {
    // Model env still wins. A foreign family is named before the request,
    // not rewritten — same-provider overrides stay silent.
    if (!isRuntimeLlmModelCompatibleWithProvider(selectedProvider, explicitModel)) {
      observeRuntimeLlmModelProviderMismatch(selectedProvider, explicitModel);
    }
    return explicitModel;
  }
  return selectedProvider !== baseProvider
    ? defaultModelForProvider(selectedProvider) ?? configuredModel
    : configuredModel;
}

/** ⛔⭐⭐ 「없음·깨짐·비-객체」 세 경우는 **종전대로 `defaultConfig()` 를 그대로 돌려준다**.
 *  ⚠️ 초판은 그 셋을 「빈 raw(`{}`)로 파싱」 경로로 바꿨는데, `defaultConfig()` 와 `{}` 파싱은
 *  **같은 값이 아니다** — 실측: `skills.activeSet` 이 `claudecode` → `opencode` 로 회귀했고
 *  그 회귀가 «기존 테스트 기대값을 고치는» 것으로 덮였다(무인 리뷰 must-fix · 2026-08-14).
 *  ⇒ per-run 오버라이드는 그 셋에도 «얹기»만 한다. 계약을 바꾸지 않는다. */
function defaultConfigWithRuntimeProvider(): UserConfig {
  const cfg = defaultConfig();
  // ⚠️ 무효값 거부는 이 경로에서도 살아 있어야 한다 — config 가 없을 때 오타가 조용히 무시되면
  //   사람이 grok 으로 돌고 있다고 «믿으면서» 기본 provider 로 돈다.
  const override = runtimeLlmProviderOverride();
  // ⛔⭐ 두 env 의 우선순위는 **모든 경로에서 같아야 한다**(무인 리뷰 must-fix 2R).
  //   파싱 경로가 `escalate → runtime → config` 인데 이 경로만 `runtime` 우선이면,
  //   같은 환경에서 config 파일이 «있느냐 없느냐»로 provider 가 갈린다.
  const escalationProvider = process.env.ELANOUS_ESCALATE_PROVIDER?.trim();
  if (!override && !escalationProvider) {
    cfg.llm = {
      ...cfg.llm,
      model: resolveRuntimeLlmModel(cfg.llm.provider ?? 'auto', cfg.llm.provider ?? 'auto', str(cfg.llm.model), undefined),
    };
    return cfg;
  }
  const selected = escalationProvider ? normalizeProvider(escalationProvider) : override!;
  // ⭐ provider 를 바꾸는 자리는 **키도 함께** 해석한다 — 그러지 않으면 새 기기에서
  //   `ELANOUS_LLM_PROVIDER=grok` 이 provider 만 바꾸고 자격이 없어 401 로 죽는다(파싱 경로와 같은 규율).
  const baseProvider = cfg.llm.provider ?? 'auto';
  const cred = resolveProviderCredential({ provider: selected, rotation: cfg.llm.rotation, baseApiKey: cfg.llm.apiKey, baseProvider });
  observeCredentialResolution(selected, cred, 'escalate');
  cfg.llm = {
    ...cfg.llm,
    provider: selected,
    ...(cred.apiKey ? { apiKey: cred.apiKey } : {}),
    ...(cred.baseUrl ? { baseUrl: cred.baseUrl } : {}),
    model: resolveRuntimeLlmModel(baseProvider, selected, str(cfg.llm.model), escalationProvider || undefined),
  };
  debug.log('user-config.llm', 'provider-resolved', {
    provider: selected,
    source: escalationProvider ? 'escalate-env' : 'env',
  });
  return cfg;
}

export const RETIRED_CONFIG_KEYS: readonly RetiredConfigKey[] = [
  { path: 'tools.selfImplement.decompositionShadow', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-24 설정 졸업)' },
  { path: 'tools.selfImplement.autoStop.enabled', reason: '기본 켬으로 졸업 — 지워도 된다 · 조율은 minRung (2026-09-24)' },
  { path: 'tools.selfImplement.autoAssist.enabled', reason: '기본 켬으로 졸업 — 지워도 된다 · 조율은 minRung (2026-09-24)' },
  { path: 'tools.selfImplement.screenStallTermination.enabled', reason: '기본 켬으로 졸업 — 지워도 된다 · 조율은 minRung (2026-09-24)' },
  // 설정 졸업 단계 2(2026-09-26): 로더가 싣기만 하고 읽는 곳이 없던 넷 — 저장소 전수 rg(시험 제외) 결과 user-config.ts 밖 소비자 0.
  { path: 'chat.rendering.hud.variantBadge', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2)' },
  { path: 'chat.rendering.hud.tokenGauge', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2)' },
  { path: 'chat.rendering.tool.inlineOneLine', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2)' },
  { path: 'vw.acpResident', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2 · vw.acp.resident 도 소비자 없음)' },
  { path: 'discord.sprint21', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2 · 런타임 sprint21-runtime 은 호출처 0·휴면)' },
  { path: 'tools.selfImplement.prEvidenceArtifactEnforce', reason: '차단 스위치 졸업 — PR 근거 관문은 막지 않고 관측만 한다(2026-09-26 설정 졸업 · 한 번도 기본으로 안 켜졌다)' },
  { path: 'voice.discord.dispatch', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2 · 값을 쓰던 디스코드 음성 어댑터는 호출처 0)' },
  { path: 'voice.discord.replyMode', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2 · 값을 쓰던 디스코드 음성 어댑터는 호출처 0)' },
  { path: 'voice.pwa.dispatch', reason: '읽는 곳이 없다 — 지워도 된다 (2026-09-26 설정 졸업 2 · voice-pwa-dispatch 는 호출처 0)' },
  { path: 'voice.stt.mode', reason: '타입에 없는 키 — 읽는 곳이 없다 (2026-09-26 설정 졸업 2)' },
  { path: 'voice.stt.language', reason: '타입에 없는 키 — 읽는 곳이 없다 (2026-09-26 설정 졸업 2)' },
  // 설정 졸업 1-d(2026-09-26): 3층(트리 파생)은 늘 켠다 — 리더 미지정이면 운영으로 떨어지므로 새 설치의 동작은 같다.
  { path: 'instance.treeDerivedTest', reason: '늘 켬으로 졸업 — 지워도 된다 (2026-09-26 설정 졸업 1-d)' },
  { path: 'tools.selfImplement.selfResolveClarifications', reason: '늘 켬으로 졸업 — 지워도 된다 (2026-09-26 설정 졸업 1-c · self author 도 harness 와 같이 되묻기를 자동 답변)' },
  { path: 'chat.rendering.compactBoundary.enabled', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.wrap.preserveOsc8', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.diff.adaptiveBg', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.diff.syntaxPerHunk', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.diff.cache', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.diff.turnSummary', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'chat.rendering.diff.turnBrowser', reason: '늘 켜짐 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'sessionFabric.telegram.reactions', reason: '늘 켬 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'sessionFabric.discord.reactions', reason: '늘 켬 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'nextFluent.enabled', reason: '늘 켬 — 옵션 졸업 (2026-09-26 설정 졸업 1-f)' },
  { path: 'tools.selfImplement.graphAuthoritative', reason: '2026-09-26 설정 졸업 — 그래프 권위는 항상 켬 · 지워도 된다' },
];

/** 설정 원문(JSON 객체)에서 폐기 키가 «있는» 항목만 돌려준다. 순수. */
export function findRetiredConfigKeys(raw: unknown, keys: readonly RetiredConfigKey[] = RETIRED_CONFIG_KEYS): RetiredConfigKey[] {
  return keys.filter(({ path }) => {
    let node: unknown = raw;
    for (const segment of path.split('.')) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.prototype.hasOwnProperty.call(node, segment)) return false;
      node = (node as Record<string, unknown>)[segment];
    }
    return true;
  });
}

/** 설정 «파일»의 폐기 키. 파일이 없거나 JSON 이 아니면 빈 목록(doctor 는 그 경우 다른 줄로 이미 말한다). */
export function findRetiredConfigKeysInFile(path: string = defaultPath(), read: (p: string) => string = (p) => readFileSync(p, 'utf-8')): RetiredConfigKey[] {
  try {
    return findRetiredConfigKeys(JSON.parse(read(path)));
  } catch {
    return [];
  }
}

let retiredConfigKeysObserved = false;
export function __resetRetiredConfigKeysObservationForTests(): void {
  retiredConfigKeysObserved = false;
}

function observeRetiredConfigKeysOnce(raw: Record<string, unknown>): void {
  if (retiredConfigKeysObserved) return;
  const retired = findRetiredConfigKeys(raw);
  if (!retired.length) return;
  retiredConfigKeysObserved = true;
  try {
    debug.log('user-config.retired', 'retired-key-present', { paths: retired.map(({ path }) => path) });
  } catch { /* observation must never break config loading */ }
}

/** Owner tracks the steward may assign (key → what that track owns). The one place the role table lives. */
function parseStewardTracks(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = Object.fromEntries(Object.entries(input as Record<string, unknown>)
    .filter((e): e is [string, string] => /^[A-Za-z][\w-]{0,15}$/.test(e[0]) && typeof e[1] === 'string' && e[1].trim().length > 0)
    .map(([k, v]) => [k, v.trim()]));
  return Object.keys(out).length ? out : undefined;
}

function parseDecisionsConfig(input: unknown): NonNullable<UserConfig['decisions']> {
  const defaults: Record<EventSeat, EventSeat> = { OP: 'TC', TC: 'OP', MK: 'OP', UX: 'OP' };
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const neighbors = { ...defaults };
  if (raw.crossCheckNeighbor !== undefined) {
    if (!raw.crossCheckNeighbor || typeof raw.crossCheckNeighbor !== 'object' || Array.isArray(raw.crossCheckNeighbor)) {
      warnUserConfigDrop('decisions.crossCheckNeighbor', '자리별 이웃 자리 객체가 아닙니다 — 기본값으로 진행합니다.');
    } else {
      const values = raw.crossCheckNeighbor as Record<string, unknown>;
      for (const seat of Object.keys(defaults) as EventSeat[]) {
        if (values[seat] === undefined) continue;
        const to = values[seat];
        if ((to === 'OP' || to === 'TC' || to === 'MK' || to === 'UX') && to !== seat) neighbors[seat] = to;
        else warnUserConfigDrop(`decisions.crossCheckNeighbor.${seat}`, '다른 자리가 아닙니다 — 기본값으로 진행합니다.');
      }
      for (const seat of Object.keys(values)) {
        if (!(seat in defaults)) warnUserConfigDrop(`decisions.crossCheckNeighbor.${seat}`, '알 수 없는 자리입니다 — 기본값으로 진행합니다.');
      }
    }
  }
  const wait = raw.crossCheckWaitMinutes;
  if (wait !== undefined && !(typeof wait === 'number' && Number.isSafeInteger(wait) && wait > 0)) {
    warnUserConfigDrop('decisions.crossCheckWaitMinutes', '양의 정수가 아닙니다 — 기본값 120으로 진행합니다.');
  }
  return { linearProjection: { enabled: (raw.linearProjection as { enabled?: unknown } | undefined)?.enabled === true },
    requireCrossCheck: raw.requireCrossCheck === true, crossCheckNeighbor: neighbors,
    crossCheckWaitMinutes: typeof wait === 'number' && Number.isSafeInteger(wait) && wait > 0 ? wait : 120 };
}

function parseLoopOwners(input: unknown): { owners: Record<string, EventSeat>; defaultOwner: EventSeat } {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const valid = (value: unknown): value is EventSeat => value === 'OP' || value === 'TC' || value === 'MK' || value === 'UX';
  const defaultOwner = valid(raw.defaultOwner) ? raw.defaultOwner : 'OP';
  if (raw.defaultOwner !== undefined && !valid(raw.defaultOwner)) warnUserConfigDrop('loops.defaultOwner', '잘못된 자리 — 기본 OP 로 진행');
  // Prototype-less: a loop titled «__proto__» (or «constructor») must keep its owner (review round 3).
  const owners: Record<string, EventSeat> = Object.create(null) as Record<string, EventSeat>;
  if (raw.owners !== undefined) {
    if (!raw.owners || typeof raw.owners !== 'object' || Array.isArray(raw.owners)) {
      warnUserConfigDrop('loops.owners', '객체가 아니다 — 기본 자리로 진행');
    } else {
      for (const [key, value] of Object.entries(raw.owners)) {
        if (key.trim() && valid(value)) owners[key] = value;
        else warnUserConfigDrop(`loops.owners.${key}`, `잘못된 자리 — 기본 ${defaultOwner} 로 진행`);
      }
    }
  }
  return { owners, defaultOwner };
}

function parseSeatLoopsConfig(input: unknown): SeatLoopConfig {
  const defaults: SeatLoopConfig = { mode: 'shadow', questions: 'shadow', seats: ['MK'], podPool: 'pool-node-b@node-b:8' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaults;
  const seat = (input as Record<string, unknown>).seat;
  if (!seat || typeof seat !== 'object' || Array.isArray(seat)) return defaults;
  const values = seat as Record<string, unknown>;
  const mode = values.mode;
  return {
    mode: mode === 'on' || mode === 'shadow' || mode === 'live-safe' || mode === 'off' ? mode : 'shadow',
    questions: values.questions === 'on' ? 'on' : 'shadow',
    seats: Array.isArray(values.seats) && values.seats.length > 0
      && values.seats.every((value) => typeof value === 'string' && /^(?:MK|OP|TC|UX)$/.test(value))
      ? [...new Set(values.seats as string[])] : ['MK'],
    podPool: typeof values.podPool === 'string' && values.podPool.trim() ? values.podPool.trim() : defaults.podPool,
    ...(() => {
      const raw = values.neighbors;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const neighbors: NonNullable<SeatLoopConfig['neighbors']> = {};
      for (const [owner, entries] of Object.entries(raw)) {
        if (!/^(?:OP|TC|MK|UX)$/.test(owner) || !Array.isArray(entries)) continue;
        const valid = entries.filter((entry): entry is import('./loops/neighbors.js').Neighbor => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
          const value = entry as Record<string, unknown>;
          const heartbeat = value.heartbeat && typeof value.heartbeat === 'object' && !Array.isArray(value.heartbeat)
            ? value.heartbeat as Record<string, unknown> : undefined;
          const onAbsent = value.onAbsent && typeof value.onAbsent === 'object' && !Array.isArray(value.onAbsent)
            ? value.onAbsent as Record<string, unknown> : undefined;
          return typeof value.id === 'string' && /^(?:op|tc|mk|ux)-seat$/.test(value.id)
            && value.id !== `${owner.toLowerCase()}-seat`
            && Array.isArray(value.exchange) && value.exchange.length > 0
            && value.exchange.every((item) => typeof item === 'string' && ['status', 'request', 'decision', 'blocked'].includes(item))
            && !!heartbeat && Number.isSafeInteger(heartbeat.everyMinutes) && (heartbeat.everyMinutes as number) > 0
            && Number.isSafeInteger(heartbeat.missedTicks) && (heartbeat.missedTicks as number) > 0
            && !!onAbsent && typeof onAbsent.action === 'string' && ['delegate', 'defer', 'escalate'].includes(onAbsent.action)
            && typeof onAbsent.delegateTo === 'string' && onAbsent.delegateTo.trim().length > 0;
        });
        neighbors[owner as keyof typeof neighbors] = valid;
      }
      return { neighbors };
    })(),
    ...(typeof values.reportPr === 'number' && Number.isSafeInteger(values.reportPr) && values.reportPr > 0
      ? { reportPr: values.reportPr } : {}),
    ...(() => {
      const stall = values.stall;
      if (!stall || typeof stall !== 'object' || Array.isArray(stall)) return {};
      const raw = stall as Record<string, unknown>;
      const parents = raw.parents && typeof raw.parents === 'object' && !Array.isArray(raw.parents)
        ? Object.fromEntries(Object.entries(raw.parents).filter(([from, to]) =>
          /^(?:MK|OP|TC|UX)$/.test(from) && typeof to === 'string' && /^(?:MK|OP|TC|UX)$/.test(to) && from !== to))
        : undefined;
      const minutes = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      return { stall: {
        ...(parents ? { parents } : {}),
        ...(minutes(raw.redMinutes) ? { redMinutes: raw.redMinutes } : {}),
        ...(minutes(raw.blockedMinutes) ? { blockedMinutes: raw.blockedMinutes } : {}),
      } };
    })(),
    ...(typeof values.repeatStop === 'number' && Number.isSafeInteger(values.repeatStop) && values.repeatStop > 0
      ? { repeatStop: values.repeatStop } : {}),
    ...(() => {
      const raw = values.opDecide;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const mode = (raw as Record<string, unknown>).mode;
      return mode === 'shadow' || mode === 'live' ? { opDecide: { mode } } : {};
    })(),
    ...(values.idleLadder === 'shadow' || values.idleLadder === 'live' ? { idleLadder: values.idleLadder } : {}),
  };
}

function parseStewardLoopsConfig(input: unknown): UserConfig['loops'] {
  const loops = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const value = loops.steward;
  const s = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const roles: NonNullable<NonNullable<UserConfig['loops']>['steward']>['roles'] = {};
  if (s.roles && typeof s.roles === 'object' && !Array.isArray(s.roles)) {
    for (const [role, entry] of Object.entries(s.roles)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const max = (entry as Record<string, unknown>).maxConcurrent;
      if (typeof max === 'number' && Number.isInteger(max) && max >= 0) roles[role] = { maxConcurrent: max };
    }
  }
  return { steward: {
    mode: s.mode === 'off' || s.mode === 'shadow' || s.mode === 'live' || s.mode === 'rescue' ? s.mode :
      s.launch === 'off' || s.launch === 'shadow' || s.launch === 'live' ? s.launch : 'shadow',
    // A valid legacy launch setting remains effective when mode is absent; explicit mode always wins.
    ...(s.launch === 'off' || s.launch === 'shadow' || s.launch === 'live' ? { launch: s.launch } : {}),
    ...(typeof s.maxParallel === 'number' && Number.isSafeInteger(s.maxParallel) && s.maxParallel > 0 ? { maxParallel: s.maxParallel } : {}),
    ...(typeof s.podPool === 'string' && s.podPool.trim() ? { podPool: s.podPool.trim() } : {}),
    ...(typeof s.linearTeam === 'string' && s.linearTeam.trim() ? { linearTeam: s.linearTeam.trim() } : {}),
    ...(Object.keys(roles).length ? { roles } : {}),
    ...(typeof s.budget === 'number' && Number.isFinite(s.budget) && s.budget >= 0 ? { budget: s.budget } : {}),
    ...(typeof s.alertAfterFailures === 'number' && Number.isSafeInteger(s.alertAfterFailures) && s.alertAfterFailures > 0 ? { alertAfterFailures: s.alertAfterFailures } : {}),
    ...(parseStewardTracks(s.tracks) ? { tracks: parseStewardTracks(s.tracks)! } : {}),
  } };
}

export function parseCliHelpRole(raw: unknown): NonNullable<UserConfig['cli']>['helpRole'] {
  const cli = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return cli.helpRole === 'general' || cli.helpRole === 'contributor' ? cli.helpRole : 'owner';
}

const HQ_FENCE_ROLES: readonly HqFenceRole[] = ['telegram-poller', 'cron', 'seat-loop', 'release-run', 'conatus', 'git-push'];
/** `hq` block (HQ-HB · HQ-FENCE): keep only well-typed fields — absent/invalid fields fall back to the hq module defaults. */
export function parseHqConfig(raw: unknown): HqConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const out: HqConfig = {};
  for (const key of ['arbiter', 'hostName', 'standby', 'tailnetDomain', 'tailscaleBin', 'seenGenerationFile'] as const) {
    const v = str(r[key]); if (v) out[key] = v;
  }
  if (typeof r.ttlSeconds === 'number' && Number.isFinite(r.ttlSeconds) && r.ttlSeconds > 0) out.ttlSeconds = r.ttlSeconds;
  if (typeof r.probeTimeoutSeconds === 'number' && Number.isFinite(r.probeTimeoutSeconds) && r.probeTimeoutSeconds > 0) out.probeTimeoutSeconds = r.probeTimeoutSeconds;
  if (r.boardFencing === 'shadow' || r.boardFencing === 'enforce') out.boardFencing = r.boardFencing;
  if (r.autoPromote && typeof r.autoPromote === 'object' && !Array.isArray(r.autoPromote)) {
    const auto = r.autoPromote as Record<string, unknown>;
    const setting: NonNullable<HqConfig['autoPromote']> = {};
    if (typeof auto.enabled === 'boolean') setting.enabled = auto.enabled;
    if (typeof auto.streak === 'number' && Number.isSafeInteger(auto.streak) && auto.streak > 0) setting.streak = auto.streak;
    if (Object.keys(setting).length) out.autoPromote = setting;
  }
  if (Array.isArray(r.failOpenRoles)) out.failOpenRoles = r.failOpenRoles.filter((v): v is HqFenceRole => HQ_FENCE_ROLES.includes(v as HqFenceRole));
  if (r.healthUrls && typeof r.healthUrls === 'object' && !Array.isArray(r.healthUrls)) {
    out.healthUrls = Object.fromEntries(Object.entries(r.healthUrls as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  return Object.keys(out).length ? out : undefined;
}

function parseOutboundConfig(raw: unknown): UserConfig['outbound'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const outbound = raw as Record<string, unknown>;
  const attempts = outbound.deferredMaxAttempts;
  const quietHours = outbound.quietHours;
  const validQuietHours = quietHours === 'off'
    || (typeof quietHours === 'string'
      && /^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/.test(quietHours)
      && quietHours.slice(0, 5) !== quietHours.slice(6));
  const result: NonNullable<UserConfig['outbound']> = {};
  if (Number.isSafeInteger(attempts) && (attempts as number) > 0) result.deferredMaxAttempts = attempts as number;
  if (validQuietHours) result.quietHours = quietHours as 'off' | string;
  return Object.keys(result).length ? result : undefined;
}

export function buildUserConfig(path: string = defaultPath()): UserConfig {
  const rawObj = readUserConfigObject(path);
  if (!rawObj) return defaultConfigWithRuntimeProvider();
  observeRetiredConfigKeysOnce(rawObj);
  const harness = rawObj.harness && typeof rawObj.harness === 'object' && !Array.isArray(rawObj.harness) ? rawObj.harness as Record<string, unknown> : {};
  const harnessPod = harness.pod && typeof harness.pod === 'object' && !Array.isArray(harness.pod) ? harness.pod as Record<string, unknown> : {};
  const legacyPod = rawObj.pod && typeof rawObj.pod === 'object' && !Array.isArray(rawObj.pod) ? rawObj.pod as Record<string, unknown> : {};

  const sr = (rawObj.skillRouter ?? {}) as Record<string, unknown>;
  let llm = (rawObj.llm ?? {}) as Record<string, unknown>;
  // LLM fallback substrate (2026-05-13) — when primary's `llm` section is
  // sparse / wiped, merge from `~/.elanous/llm-fallback.json`. The fallback
  // file is user-curated + read-only (0444), so even if a misbehaving
  // writer flattens config.json the daemon can still boot.
  if (isLlmSectionEmpty(llm)) {
    const fallback = readLlmFallback();
    if (fallback !== null && !isLlmSectionEmpty(fallback)) {
      // Primary is "empty" by isLlmSectionEmpty heuristic (provider
      // missing / 'auto' / 'none'). Fallback wins so its non-sentinel
      // provider replaces primary's sentinel. Non-llm fields (rare ·
      // primary might have stray non-provider keys) are preserved on
      // the LHS spread.
      llm = { ...llm, ...fallback };
      logFallbackUsedOnce();
    }
  }
  const runtimeProvider = runtimeLlmProviderOverride();
  const escalationProvider = process.env.ELANOUS_ESCALATE_PROVIDER?.trim();
  const baseProvider = normalizeProvider(llm.provider);
  // Per-run provider selection wins over saved config, but an explicit escalation
  // provider remains the narrower existing override for its child process.
  const selectedProvider = escalationProvider
    ? normalizeProvider(escalationProvider)
    : runtimeProvider ?? baseProvider;
  debug.log('user-config.llm', 'provider-resolved', {
    provider: selectedProvider,
    source: escalationProvider ? 'escalate-env' : runtimeProvider ? 'env' : 'config',
  });
  const sk = (rawObj.skills ?? {}) as Record<string, unknown>;
  const ob = (rawObj.obsidian ?? {}) as Record<string, unknown>;
  const tg = (rawObj.telegram ?? {}) as Record<string, unknown>;
  const dc = (rawObj.discord ?? {}) as Record<string, unknown>;
  const fin = (rawObj.finance ?? {}) as Record<string, unknown>;
  const ob2 = (rawObj.onboarding ?? {}) as Record<string, unknown>;
  const dbg = (rawObj.debug ?? {}) as Record<string, unknown>;
  const logsRaw = (rawObj.logs ?? {}) as Record<string, unknown>;
  const sh = (rawObj.shell ?? {}) as Record<string, unknown>;
  const voice = (rawObj.voice ?? {}) as Record<string, unknown>;
  const voiceStt = (voice.stt ?? {}) as Record<string, unknown>;
  const voiceTts = (voice.tts ?? {}) as Record<string, unknown>;
  const voiceVad = (voice.vad ?? {}) as Record<string, unknown>;
  const voiceChat = (voice.chat ?? {}) as Record<string, unknown>;
  const voiceDiscord = (voice.discord ?? {}) as Record<string, unknown>;
  const voiceDiscordChannel = (voiceDiscord.voiceChannel ?? {}) as Record<string, unknown>;
  const voiceTelegram = (voice.telegram ?? {}) as Record<string, unknown>;
  const voicePwa = (voice.pwa ?? {}) as Record<string, unknown>;
  const intake = (rawObj.intake ?? {}) as Record<string, unknown>;
  const intakeTelegram = (intake.telegram ?? {}) as Record<string, unknown>;
  const intakeDiscord = (intake.discord ?? {}) as Record<string, unknown>;
  const dash = (rawObj.dashboard ?? {}) as Record<string, unknown>;
  const retiredModeKeys = (['uiMode', 'defaultMode'] as const)
    .filter((key) => Object.prototype.hasOwnProperty.call(dash, key));
  if (retiredModeKeys.length > 0) {
    debug.log('dashboard.ui-mode', 'retired-config-ignored', { key: retiredModeKeys.join(',') });
  }
  const dashPromptBank = (dash.promptBank ?? {}) as Record<string, unknown>;
  const vw = (rawObj.vw ?? {}) as Record<string, unknown>;
  const acp = (rawObj.acp ?? {}) as Record<string, unknown>;
  const acpHopCap = (acp.hopCap ?? {}) as Record<string, unknown>;
  const acpToolApproval = (acp.toolApproval ?? {}) as Record<string, unknown>;
  const lspRaw = (rawObj.lsp ?? {}) as Record<string, unknown>;

  // RFC #2161 (PLAN-config-unification-elanous-root) — `elanous nexus config
  // set` writes user-level entries under `global.<...>`. The Phase 2
  // typed-root surface (below) exposes `global` but legacy parsers still
  // reach for top-level keys. For schemas that have already migrated to
  // the `global.` namespace via the CLI, prefer the namespaced read and
  // fall back to the legacy top-level slot.
  const rawGlobalObj =
    rawObj.global && typeof rawObj.global === 'object' && !Array.isArray(rawObj.global)
      ? (rawObj.global as Record<string, unknown>)
      : undefined;
  const rawNotifications = rawGlobalObj?.notifications ?? rawObj.notifications;
  const autopilotConfig = parseAutopilotConfig(rawObj.autopilot);
  const stewardLoops = parseStewardLoopsConfig(rawObj.loops);
  const orgRaw = rawObj.org && typeof rawObj.org === 'object' && !Array.isArray(rawObj.org) ? rawObj.org as Record<string, unknown> : {};
  const budgetRaw = orgRaw.budget && typeof orgRaw.budget === 'object' && !Array.isArray(orgRaw.budget) ? orgRaw.budget as Record<string, unknown> : {};
  const seatBudgets: NonNullable<NonNullable<UserConfig['org']>['budget']> = Object.create(null);
  for (const [seat, value] of Object.entries(budgetRaw)) {
    if (!seat || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const dailyGoals = row.dailyGoals;
    const concurrentPods = row.concurrentPods;
    seatBudgets[seat] = {
      ...(typeof dailyGoals === 'number' && Number.isSafeInteger(dailyGoals) && dailyGoals >= 0 ? { dailyGoals } : {}),
      ...(typeof concurrentPods === 'number' && Number.isSafeInteger(concurrentPods) && concurrentPods >= 0 ? { concurrentPods } : {}),
    };
  }

  const nexus = rawObj.nexus && typeof rawObj.nexus === 'object' && !Array.isArray(rawObj.nexus)
    ? rawObj.nexus as Record<string, unknown> : {};
  const rawTui = rawObj.tui && typeof rawObj.tui === 'object' && !Array.isArray(rawObj.tui)
    ? rawObj.tui as Record<string, unknown> : {};
  const rawTuiNext = rawTui.next && typeof rawTui.next === 'object' && !Array.isArray(rawTui.next)
    ? rawTui.next as Record<string, unknown> : {};
  const compactHeight = rawTuiNext.compactHeight;
  const gateRemoteConfig = parseGateRemoteConfig(rawObj.gateRemote);
  const projects = parseProjectsConfig(rawObj.projects);
  const outboundConfig = parseOutboundConfig(rawObj.outbound);
  const config: UserConfig = {
    // Legacy TUI preferences remain retired; the next compact height is a new explicit setting.
    tui: { sidetab: 'collapsed',
      ...(typeof compactHeight === 'number' && Number.isInteger(compactHeight) && compactHeight >= 8 && compactHeight <= 100
        ? { next: { compactHeight } } : {}) },
    ...(projects ? { projects } : {}),
    ...(rawObj.starter && typeof rawObj.starter === 'object' && !Array.isArray(rawObj.starter)
      && Array.isArray((rawObj.starter as Record<string, unknown>).topics)
      ? { starter: { topics: ((rawObj.starter as { topics: unknown[] }).topics).filter((topic): topic is string => typeof topic === 'string' && !!topic.trim()) } } : {}),
    ...(rawObj.watch && typeof rawObj.watch === 'object' && !Array.isArray(rawObj.watch)
      && typeof (rawObj.watch as Record<string, unknown>).enabled === 'boolean'
      ? { watch: { enabled: (rawObj.watch as { enabled: boolean }).enabled } } : {}),
    nexus: {
      demoMode: nexus.demoMode === true,
      ...(nexus.relay && typeof nexus.relay === 'object' && !Array.isArray(nexus.relay)
        ? (() => {
          const relay = nexus.relay as Record<string, unknown>;
          const parsed = {
            ...(typeof relay.enabled === 'boolean' ? { enabled: relay.enabled } : {}),
            ...(typeof relay.url === 'string' && relay.url.trim() ? { url: relay.url.trim() } : {}),
            ...(typeof relay.identityFile === 'string' && relay.identityFile.trim() ? { identityFile: relay.identityFile.trim() } : {}),
          };
          return Object.keys(parsed).length ? { relay: parsed } : {};
        })()
        : {}),
    },
    ...(Object.keys(seatBudgets).length ? { org: { budget: seatBudgets } } : {}),
    pod: {
      ...(typeof legacyPod.pool === 'string' && legacyPod.pool.trim() ? { pool: legacyPod.pool.trim() } : {}),
      ...(typeof legacyPod.warmProviderConfig === 'string' && legacyPod.warmProviderConfig.trim()
        ? { warmProviderConfig: legacyPod.warmProviderConfig.trim() } : {}),
      ...(typeof legacyPod.hostMirror === 'string' && legacyPod.hostMirror.trim() ? { hostMirror: legacyPod.hostMirror.trim() } : {}),
      ...(typeof legacyPod.childLogMaxBytes === 'number' && Number.isSafeInteger(legacyPod.childLogMaxBytes) && legacyPod.childLogMaxBytes > 0 ? { childLogMaxBytes: legacyPod.childLogMaxBytes } : {}),
      ...(typeof legacyPod.groundingUrl === 'string' ? { groundingUrl: legacyPod.groundingUrl } : {}),
      memory: { adviseDefaults: Boolean(legacyPod.memory && typeof legacyPod.memory === 'object' && !Array.isArray(legacyPod.memory)
        && (legacyPod.memory as Record<string, unknown>).adviseDefaults === true) },
      lease: { perAccount: (() => {
        const lease = legacyPod.lease && typeof legacyPod.lease === 'object' && !Array.isArray(legacyPod.lease)
          ? (legacyPod.lease as Record<string, unknown>) : {};
        return typeof lease.perAccount === 'number' && Number.isSafeInteger(lease.perAccount) && lease.perAccount > 0
          ? lease.perAccount : 4;
      })() },
      warmReuse: (() => {
        const warm = legacyPod.warmReuse && typeof legacyPod.warmReuse === 'object' && !Array.isArray(legacyPod.warmReuse)
          ? (legacyPod.warmReuse as Record<string, unknown>) : {};
        return {
          gateRecheck: warm.gateRecheck === true,
          gateShardExecution: warm.gateShardExecution !== false,
          land: warm.land === true,
          ta: warm.ta === true,
          minMatchSamples: typeof warm.minMatchSamples === 'number' && Number.isSafeInteger(warm.minMatchSamples) && warm.minMatchSamples > 0
            ? warm.minMatchSamples : 3,
        };
      })(),
    },
    harness: {
      edgeRail: (() => {
        const value = harness.edgeRail && typeof harness.edgeRail === 'object' && !Array.isArray(harness.edgeRail)
          ? harness.edgeRail as Record<string, unknown> : {};
        return {
          canaryOkRuns: typeof value.canaryOkRuns === 'number' && Number.isSafeInteger(value.canaryOkRuns) && value.canaryOkRuns > 0 ? value.canaryOkRuns : 3,
          failureMultiplier: typeof value.failureMultiplier === 'number' && Number.isFinite(value.failureMultiplier) && value.failureMultiplier > 1 ? value.failureMultiplier : 2,
          minSamples: typeof value.minSamples === 'number' && Number.isSafeInteger(value.minSamples) && value.minSamples > 0 ? value.minSamples : 30,
        };
      })(),
      revertGuard: { depth: (() => {
        const value = harness.revertGuard && typeof harness.revertGuard === 'object' && !Array.isArray(harness.revertGuard)
          ? (harness.revertGuard as Record<string, unknown>).depth : undefined;
        return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 50;
      })() },
      pod: { grokApiKeyOptIn: harnessPod.grokApiKeyOptIn === true },
      difficultyPlacement: harness.difficultyPlacement === true,
      exposeGate: harness.exposeGate === 'strict' ? 'strict' : 'warn',
      queue: { seatCap: Object.fromEntries(Object.entries(
        harness.queue && typeof harness.queue === 'object' && !Array.isArray(harness.queue)
          && (harness.queue as Record<string, unknown>).seatCap && typeof (harness.queue as Record<string, unknown>).seatCap === 'object'
          && !Array.isArray((harness.queue as Record<string, unknown>).seatCap)
          ? (harness.queue as { seatCap: Record<string, unknown> }).seatCap : {},
      ).filter(([seat, cap]) => /^(OP|TC|MK|UX)$/.test(seat) && typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0)),
      ...(harness.queue && typeof harness.queue === 'object' && !Array.isArray(harness.queue)
        && typeof (harness.queue as Record<string, unknown>).directSay === 'boolean'
        ? { directSay: (harness.queue as { directSay: boolean }).directSay } : {}),
      ...(() => {
        const queue = harness.queue && typeof harness.queue === 'object' && !Array.isArray(harness.queue)
          ? harness.queue as Record<string, unknown> : {};
        const stale = queue.staleRunMinutes, unknownCap = queue.unknownSeatCap, burstMax = queue.burstMax;
        return {
          ...(typeof burstMax === 'number' && Number.isSafeInteger(burstMax) && burstMax > 0 ? { burstMax } : {}),
          ...(typeof stale === 'number' && Number.isSafeInteger(stale) && stale > 0 ? { staleRunMinutes: stale } : {}),
          ...(typeof unknownCap === 'number' && Number.isSafeInteger(unknownCap) && unknownCap >= 0 ? { unknownSeatCap: unknownCap } : {}),
        };
      })() },
      ...(harness.substrate === 'local' || harness.substrate === 'pod' || harness.substrate === 'auto' ? { substrate: harness.substrate } : {}),
      ...(typeof harness.podPool === 'string' && harness.podPool.trim() ? { podPool: harness.podPool.trim() } : {}),
      ...(() => {
        if (harness.imageCommit === undefined) return {};
        const v = typeof harness.imageCommit === 'string' ? harness.imageCommit.trim().toLowerCase() : '';
        if (/^[0-9a-f]{12,40}$/u.test(v)) return { imageCommit: v };
        warnUserConfigDrop('harness.imageCommit', `커밋 hex 12~40자리가 아니다(${JSON.stringify(harness.imageCommit)}) — 무시하고 HEAD 비교·굽기로 진행`);
        return {};
      })(),
      ...(typeof harness.registryTagKeep === 'number' && Number.isSafeInteger(harness.registryTagKeep)
        && harness.registryTagKeep > 0 && harness.registryTagKeep <= 100
        ? { registryTagKeep: harness.registryTagKeep } : {}),
      ...(typeof harness.worktreeAddTimeoutSec === 'number' && Number.isSafeInteger(harness.worktreeAddTimeoutSec)
        && harness.worktreeAddTimeoutSec > 0 && harness.worktreeAddTimeoutSec <= 2_147_483
        ? { worktreeAddTimeoutSec: harness.worktreeAddTimeoutSec } : {}),
      ...(typeof harness.defaultRepo === 'string' && isAbsolute(harness.defaultRepo)
        ? { defaultRepo: harness.defaultRepo } : {}),
      ...(typeof harness.repo === 'string' && harness.repo.trim()
        ? { repo: harness.repo.trim() } : {}),
      helper: (() => {
        const helper = harness.helper && typeof harness.helper === 'object' && !Array.isArray(harness.helper)
          ? harness.helper as Record<string, unknown> : {};
        const repairPerDay = helper.repairPerDay;
        return {
          repair: helper.repair === 'live' ? 'live' as const : 'shadow' as const,
          repairPerDay: typeof repairPerDay === 'number' && Number.isSafeInteger(repairPerDay) && repairPerDay >= 0
            ? repairPerDay : 3,
        };
      })(),
      ...(harness.authorGrade === 'lite' || harness.authorGrade === 'full' ? { authorGrade: harness.authorGrade } : {}),
      ...(harness.authorOnPod === true ? { authorOnPod: true } : {}),
      ...(() => {
        const sibling = harness.siblingResync && typeof harness.siblingResync === 'object' && !Array.isArray(harness.siblingResync)
          ? harness.siblingResync as Record<string, unknown> : undefined;
        const maxFetch = sibling?.maxFetch;
        return typeof maxFetch === 'number' && Number.isSafeInteger(maxFetch) && maxFetch >= 0 ? { siblingResync: { maxFetch } } : {};
      })(),
      ...(harness.nestedElanous === 'allow' || harness.nestedElanous === 'refuse'
        ? { nestedElanous: harness.nestedElanous } : {}),
      nestedElanousMaxDepth: typeof harness.nestedElanousMaxDepth === 'number'
        && Number.isSafeInteger(harness.nestedElanousMaxDepth) && harness.nestedElanousMaxDepth > 0
        ? harness.nestedElanousMaxDepth : 2,
      ...(typeof harness.launchStallMinutes === 'number' && Number.isFinite(harness.launchStallMinutes) && harness.launchStallMinutes > 0
        ? { launchStallMinutes: harness.launchStallMinutes } : {}),
      followUp: harness.followUp === 'live' ? 'live' : 'shadow',
      budgetGate: parseHarnessBudgetGate(
        rawObj.harness && typeof rawObj.harness === 'object' && !Array.isArray(rawObj.harness)
          ? (rawObj.harness as Record<string, unknown>).budgetGate
          : undefined,
      ),
    },
    skillRouter: {
      autoRoute: sr.autoRoute === true,
      autoRouteCountdownMs: clampNum(sr.autoRouteCountdownMs, SR_DEFAULTS.autoRouteCountdownMs, 0, 10000),
      llmFallback: sr.llmFallback === true,
      keywordScoreThreshold: clampNum(sr.keywordScoreThreshold, SR_DEFAULTS.keywordScoreThreshold, 0, 100),
      llmConfidenceThreshold: clampNum(sr.llmConfidenceThreshold, SR_DEFAULTS.llmConfidenceThreshold, 0, 1),
      autoRouteMinScore: clampNum(sr.autoRouteMinScore, SR_DEFAULTS.autoRouteMinScore, 0, 100),
      autoRouteRequireAutoTrigger: sr.autoRouteRequireAutoTrigger === false ? false : true,
      fullMenuTier: (['T1', 'T2', 'T3'].includes(sr.fullMenuTier as string) ? sr.fullMenuTier : SR_DEFAULTS.fullMenuTier) as SkillTier,
      fullMenuConfidenceThreshold: clampNum(sr.fullMenuConfidenceThreshold, SR_DEFAULTS.fullMenuConfidenceThreshold, 0, 1),
      harnessExecAllowlist: Array.isArray(sr.harnessExecAllowlist)
        ? (sr.harnessExecAllowlist as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : [...SR_DEFAULTS.harnessExecAllowlist],
    },
    llm: {
      // ★ 자율 escalation 장치(#2·2026-07-22 대표) — self-dev rework 마지막 라운드가 강한 모델(opus)로 뜨도록
      //   driver 가 escalate 스폰의 자식 env 에 ELANOUS_ESCALATE_MODEL/PROVIDER 를 심으면 여기서 llm 티어 override.
      //   config 파일 무변경·escalate 스폰에만 존재하는 env escape-hatch(자기완결). 미설정=종전.
      ...(() => {
        // ⭐ escalate 401 근본수리(2026-07-26 · 대표 결정) — 종전엔 `provider` 만 전환하고
        //   `apiKey: str(llm.apiKey)` 로 **base 키를 그대로** 들고 가, escalate(tier=opus·anthropic)가
        //   openai-codex 키로 anthropic 에 붙어 **100% 401 즉사**했다(실측: toolCalls 0 · 자율 완주 블로커).
        //   provider 를 바꾸는 자리에서 **키도 함께** 해석한다 — rotation(config) → env → (미전환 시만) 상속.
        //   ⚠️ escalate 는 provider↔model 이 정합해서 `llm.ts` 의 key-family 가드가 발동조차 안 한다.
        //      그래서 판정을 하나 더 얹는 게 아니라 이 자리에서 해석하는 것이 근본이다.
        const escalateProvider = selectedProvider;
        const rotation = parseRotation(llm.rotation);
        const baseApiKey = str(llm.apiKey);

        // ⚠️ **전환이 실제로 일어난 경우에만** 새 해석을 적용한다 (리뷰 must-fix #5488 2R).
        //    무조건 rotation→env→base 순서로 바꾸면, escalate 와 **무관한 평상시 경로**에서도 머신 env
        //    (OPENAI_API_KEY 등)가 config 의 `llm.apiKey` 를 덮는다 = 이 수리 범위 밖의 인증 계약 변경.
        //    provider 가 그대로면 종전과 **글자 그대로 동일**(str(llm.apiKey))해야 무회귀다.
        if (escalateProvider === baseProvider) {
          return { provider: escalateProvider, apiKey: baseApiKey, rotation, baseUrl: str(llm.baseUrl) };
        }

        const cred = resolveProviderCredential({ provider: escalateProvider, rotation, baseApiKey, baseProvider });
        observeCredentialResolution(escalateProvider, cred, 'escalate');
        return {
          provider: escalateProvider,
          ...(cred.apiKey ? { apiKey: cred.apiKey } : {}),
          rotation,
          // ⚠️ baseUrl 도 키와 **같은 규율**(리뷰 should-fix 10R) — 전환인데 옛 엔드포인트를 물려주면
          //    새 키·provider 를 이전 주소로 보낸다(401 과 같은 계열). rotation 명시가 없으면 undefined
          //    = provider 기본 엔드포인트. 전환이 아닌 경로는 위 early-return 이 종전값을 그대로 준다.
          ...(cred.baseUrl ? { baseUrl: cred.baseUrl } : {}),
        };
      })(),
      model: resolveRuntimeLlmModel(baseProvider, selectedProvider, str(llm.model), escalationProvider || undefined),
      codexTokenOwnerHost: typeof llm.codexTokenOwnerHost === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(llm.codexTokenOwnerHost.trim())
        ? llm.codexTokenOwnerHost.trim() : undefined,
      streamIdleTimeoutMs: positiveFiniteNumber(llm.streamIdleTimeoutMs),
      openrouter: (() => {
        const router = llm.openrouter;
        if (!router || typeof router !== 'object' || Array.isArray(router)) return undefined;
        const preferences = (router as Record<string, unknown>).providerPreferences;
        const fallbackModel = (router as Record<string, unknown>).fallbackModel;
        const upstreamPins = (router as Record<string, unknown>).upstreamPins;
        const out = {
          ...(preferences && typeof preferences === 'object' && !Array.isArray(preferences)
            ? { providerPreferences: { ...preferences } as Record<string, unknown> } : {}),
          ...(typeof fallbackModel === 'string' ? { fallbackModel } : {}),
          ...(upstreamPins && typeof upstreamPins === 'object' && !Array.isArray(upstreamPins)
            ? { upstreamPins: Object.fromEntries(Object.entries(upstreamPins as Record<string, unknown>)
              .filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((x) => typeof x === 'string'))) } : {}),
        };
        return Object.keys(out).length > 0 ? out : undefined;
      })(),
      // ★ escalate effort override(#2·2026-07-22 대표) — ELANOUS_ESCALATE_EFFORT 있으면 reasoning effort 를 그 값으로
      //   (sol high 등 강한 시도). reasoningLevel(anthropic/일반)+codexReasoning(openai-codex/sol) 둘 다 커버. 미설정=종전.
      reasoningLevel: parseReasoningLevel(process.env.ELANOUS_ESCALATE_EFFORT?.trim() || llm.reasoningLevel),
      codexReasoning: (() => {
        const esc = process.env.ELANOUS_ESCALATE_EFFORT?.trim();
        const base = parseCodexReasoning(llm.codexReasoning);
        return esc ? { ...base, effort: esc as NonNullable<LLMConfig['codexReasoning']>['effort'] } : base;
      })(),
      goalLoop: parseGoalLoop(llm.goalLoop),
      memoryJudge: parseMemoryJudge(llm.memoryJudge),
      codexInspectExempt: llm.codexInspectExempt === true ? true : undefined,
      podHostAcpReview: llm.podHostAcpReview === true ? true : undefined,
      // ⛔⭐ 「false 만 끈다」 — 미설정·true 는 undefined 로 두어 기본 ON 을 유지한다(대표 결정 ②).
      //   ⚠️ 이 줄이 «없으면» 타입만 있고 파서가 안 읽어 ***노브가 no-op 이 된다***(실측으로 잡았다).
      codexAccountRotation: llm.codexAccountRotation === false ? false : undefined,
      // ⛔⭐ 알림 축도 «false 만 끈다» — 회전 축과 같은 관용구, 다른 스위치.
      codexAccountAlerts: llm.codexAccountAlerts === false ? false : undefined,
      // ⛔ 여기서 «수만» 통과시킨다 — 범위 정규화는 판정기(`normalizedRotationThresholdPercent`)가
      //   한 자로 한다. 두 곳에서 정규화하면 두 자가 갈린다.
      codexAccountRotationThresholdPercent: typeof llm.codexAccountRotationThresholdPercent === 'number'
        ? llm.codexAccountRotationThresholdPercent
        : undefined,
      codexAccountRotationThresholdPercentByAccount: llm.codexAccountRotationThresholdPercentByAccount
        && typeof llm.codexAccountRotationThresholdPercentByAccount === 'object'
        && !Array.isArray(llm.codexAccountRotationThresholdPercentByAccount)
        ? Object.fromEntries(Object.entries(llm.codexAccountRotationThresholdPercentByAccount)
          .filter(([, value]) => typeof value === 'number'))
        : undefined,
      // ⛔ 같은 모양(문자열 배열)이라 아래 fallbackChain 과 «같은 자»를 쓴다.
      codexCreditsAllowed: llm.codexCreditsAllowed === true ? true : undefined,
      codexQuotaPolicy: isCodexQuotaPolicy(llm.codexQuotaPolicy) ? llm.codexQuotaPolicy : undefined,
      codexCreditReserve: typeof llm.codexCreditReserve === 'number' && Number.isFinite(llm.codexCreditReserve) && llm.codexCreditReserve >= 0
        ? llm.codexCreditReserve : undefined,
      grokWeeklyCapPct: typeof llm.grokWeeklyCapPct === 'number' && Number.isFinite(llm.grokWeeklyCapPct)
        && llm.grokWeeklyCapPct >= 0 && llm.grokWeeklyCapPct <= 100 ? llm.grokWeeklyCapPct : LLM_DEFAULTS.grokWeeklyCapPct,
      // ⛔ 타입·파서·재노출 «셋»이 다 있어야 노브가 산다(형제 주석의 실측) — 재노출은 saveUserConfig 의 llm 블록.
      zaiCodingPlan: (() => {
        const z = llm.zaiCodingPlan;
        if (!z || typeof z !== 'object' || Array.isArray(z)) return undefined;
        const overage = (z as Record<string, unknown>).overage;
        const maxConcurrent = (z as Record<string, unknown>).maxConcurrent;
        const out = {
          ...(overage === 'stop' || overage === 'balance' || overage === 'openrouter' ? { overage: overage as 'stop' | 'balance' | 'openrouter' } : {}),
          ...(typeof maxConcurrent === 'number' && Number.isSafeInteger(maxConcurrent) && maxConcurrent >= 1 ? { maxConcurrent } : {}),
        };
        return Object.keys(out).length > 0 ? out : undefined;
      })(),
      codexAccountOrder: Array.isArray(llm.codexAccountOrder)
        ? llm.codexAccountOrder.filter((v: unknown): v is string => typeof v === 'string' && v.length > 0)
        : undefined,
      codexResetAutoConsumePerDay: typeof llm.codexResetAutoConsumePerDay === 'number'
        && Number.isSafeInteger(llm.codexResetAutoConsumePerDay) && llm.codexResetAutoConsumePerDay >= 0
        ? llm.codexResetAutoConsumePerDay : undefined,
      // ⛔ 여기선 «배열이고 문자열 원소만» 통과시킨다 — 아는 이름인지의 판정은
      //   `normalizeFallbackChain()` 이 «한 자»로 한다(두 곳에서 정규화하면 자가 갈린다).
      fallbackChain: Array.isArray(llm.fallbackChain)
        ? llm.fallbackChain.filter((s: unknown): s is string => typeof s === 'string')
        : undefined,
      reviewFallbackModels: Array.isArray(llm.reviewFallbackModels)
        ? llm.reviewFallbackModels.filter((s: unknown): s is string => typeof s === 'string')
        : undefined,
      geminiSafety: llm.geminiSafety === 'permissive' || llm.geminiSafety === 'strict'
        ? llm.geminiSafety
        : (llm.geminiSafety === 'default' ? 'default' : undefined),
      geminiServerTools: parseGeminiServerTools(llm.geminiServerTools),
      answerPriority: parseAnswerPriority(llm.answerPriority),
      maxTurns: parseMaxTurnsBudget(llm.maxTurns),
      missionRouting: parseMissionRouting(llm.missionRouting),
      routePolicy: parseLlmRoutePolicy(llm.routePolicy),
      autoRoute: parseAutoRoute(llm.autoRoute),
    },
    skills: {
      // Sparse saves omit the default preset. A present config must resolve
      // that omission exactly like an absent config, while invalid explicit
      // values still use normalizeSkillSet's legacy opencode fallback.
      activeSet: sk.activeSet === undefined ? skillsDefaults().activeSet : normalizeSkillSet(sk.activeSet),
      dirs: strArray(sk.dirs, skillsDefaults().dirs),
      giftEndpoint: str(sk.giftEndpoint) ?? 'https://elanous.ai',
      ...(() => { const sources = parsePersistedSkillSources(sk.sources, sk.connected); return sources ? { sources } : {}; })(),
      allow: strArray(sk.allow, []),
      deny: strArray(sk.deny, []),
      urlRouting: parseUrlRouting(sk.urlRouting),
      devRequestRouting: parseDevRequestRouting(sk.devRequestRouting),
      includeClaudePackageSkills: sk.includeClaudePackageSkills === true ? true : undefined,
      includeClaudePackageCommands: sk.includeClaudePackageCommands === true ? true : undefined,
    },
    obsidian: {
      vault: str(ob.vault) ?? obsidianDefaults().vault,
      ...(str(ob.testVault) ? { testVault: str(ob.testVault)! } : {}),
    },
    telegram: {
      enabled: tg.enabled === true,
      botToken: str(tg.botToken),
      allowedUsers: numArray(tg.allowedUsers, []),
      homeChannel: typeof tg.homeChannel === 'number' ? tg.homeChannel : undefined,
      reportChannel: normalizeReportChannel(tg.reportChannel),
      channels: normalizeTelegramChannels(tg.channels),
      testChannel: normalizeTestChannel(tg.testChannel),
      ...(tg.poller === 'standalone' || tg.poller === 'nexus' ? { poller: tg.poller } : {}),
      ...(normalizeKindRoles(tg.kindRoles) ? { kindRoles: normalizeKindRoles(tg.kindRoles)! } : {}),
      ...(str(tg.fieldDefaultEvent) ? { fieldDefaultEvent: str(tg.fieldDefaultEvent)! } : {}),
      ...(tg.fieldReelMode === 'instant' || tg.fieldReelMode === 'standard' ? { fieldReelMode: tg.fieldReelMode } : {}),
      ...(tg.contextFirst === false ? { contextFirst: false } : {}),
    },
    discord: {
      enabled: dc.enabled === true,
      botToken: str(dc.botToken),
      // Discord IDs are 64-bit snowflakes — too big for JS number.
      // Store as strings. Accept either strings or (legacy) numbers
      // in stored JSON and normalize on load.
      allowedUsers: Array.isArray(dc.allowedUsers)
        ? (dc.allowedUsers as unknown[]).map(v => String(v)).filter(Boolean)
        : [],
      homeChannel: typeof dc.homeChannel === 'string' ? dc.homeChannel
        : typeof dc.homeChannel === 'number' ? String(dc.homeChannel) : undefined,
      testChannel: normalizeDiscordTestChannel((dc as Record<string, unknown>).testChannel),
      ...(dc.contextFirst === false ? { contextFirst: false } : {}),
      ...(Array.isArray(dc.chatChannels)
        ? { chatChannels: (dc.chatChannels as unknown[]).map(v => String(v).trim()).filter(Boolean) }
        : {}),
      // Sprint 21 wiring sub-block (2026-05-01)
    },
    finance: {
      enabled: fin.enabled === true,
      autoLoop: {
        enabled: ((fin.autoLoop ?? {}) as Record<string, unknown>).enabled === true,
        maxPerScan: Math.max(1, Math.min(Number(((fin.autoLoop ?? {}) as Record<string, unknown>).maxPerScan ?? 2) || 2, 5)),
      },
      // R5 — strict-true arming + clamped budgets (autoLoop pattern).
      dig: {
        autoGoal: {
          enabled: (((fin.dig ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).enabled === true,
          maxPerDay: Math.max(1, Math.min(Number((((fin.dig ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).maxPerDay ?? 2) || 2, 5)),
          maxTurns: Math.max(1, Math.min(Number((((fin.dig ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).maxTurns ?? 6) || 6, 12)),
          independentChecker: (((fin.dig ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).independentChecker === true,
        },
      },
      // 온톨로지 새벽 공고화 arming(strict-true·READ-ONLY 판단·매매 격리).
      kg: {
        extract: { enabled: (((fin.kg ?? {}) as Record<string, unknown>).extract as Record<string, unknown> ?? {}).enabled === true },
        anomalyDig: { enabled: (((fin.kg ?? {}) as Record<string, unknown>).anomalyDig as Record<string, unknown> ?? {}).enabled === true },
      },
      // M4 — 새벽 수면 리플레이 자율 루프 arming(strict-true·READ-ONLY·매매 격리·저턴).
      replay: {
        autoGoal: {
          enabled: (((fin.replay ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).enabled === true,
          maxTurns: Math.max(1, Math.min(Number((((fin.replay ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).maxTurns ?? 3) || 3, 6)),
          tokenCap: Math.max(20_000, Math.min(Number((((fin.replay ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).tokenCap ?? 80_000) || 80_000, 200_000)),
          windowStartHour: Math.max(0, Math.min(Number((((fin.replay ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).windowStartHour ?? 6) || 6, 23)),
          windowEndHour: Math.max(1, Math.min(Number((((fin.replay ?? {}) as Record<string, unknown>).autoGoal as Record<string, unknown> ?? {}).windowEndHour ?? 7) || 7, 24)),
        },
      },
      // 파리티 검증된 Conatus TS 포트 라우팅(strict-true·기본 false → python 경로 불변).
      conatusNativePort: fin.conatusNativePort === true,
      secContactEmail: typeof fin.secContactEmail === 'string' && fin.secContactEmail.includes('@')
        ? fin.secContactEmail.trim()
        : undefined,
      liveOrders: fin.liveOrders === true,
      relaxedGates: fin.relaxedGates === true,
    },
    onboarding: {
      ...(typeof ob2.webFirst === 'boolean' ? { webFirst: ob2.webFirst } : {}),
      ...(typeof ob2.ready === 'boolean' ? { ready: ob2.ready } : {}),
      completed: ob2.completed === true,
      completedAt: str(ob2.completedAt),
      version: typeof ob2.version === 'number' ? ob2.version : 0,
    },
    debug: {
      // Default ON — explicit `false` opts out. Any other value
      // (missing key, wrong type) falls back to the default so a
      // stale/incomplete config doesn't disable the forensic log.
      file: dbg.file === false ? false : DEBUG_DEFAULTS.file,
      level: normalizeDebugLevel(dbg.level),
      exposeFullLlmTools: dbg.exposeFullLlmTools === false
        ? false
        : DEBUG_DEFAULTS.exposeFullLlmTools,
      // OH9 — 기본 false(억제). 명시 true 만 렌더 로그를 살린다(override).
      renderLogs: dbg.renderLogs === true ? true : DEBUG_DEFAULTS.renderLogs,
    },
    logs: {
      retention: (() => {
        const r = ((logsRaw.retention ?? {}) as Record<string, unknown>);
        const num = (v: unknown, d: number): number =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;
        return {
          maxAgeDays: num(r.maxAgeDays, LOGS_DEFAULTS.retention.maxAgeDays),
          maxDbMb: num(r.maxDbMb, LOGS_DEFAULTS.retention.maxDbMb),
          minRetainHours: num(r.minRetainHours, LOGS_DEFAULTS.retention.minRetainHours),
        };
      })(),
      ...(typeof logsRaw.instanceName === 'string' && logsRaw.instanceName.trim().length > 0
        ? { instanceName: logsRaw.instanceName.trim() }
        : {}),
    },
    shell: {
      // Default OFF — explicit `true` required to surface any of the
      // mutating/network tools at the dashboard chat level. Any non-
      // true value = off.
      allowDashboardPty: sh.allowDashboardPty === true,
      allowDashboardBash: sh.allowDashboardBash === true,
      bashApproval: parseBashApprovalMode(sh.bashApproval),
      allowDashboardTerminalInject: sh.allowDashboardTerminalInject === true,
      allowDashboardApiCall: sh.allowDashboardApiCall === true,
      allowDashboardRunShell: sh.allowDashboardRunShell === true,
    },
    ...((): { errorReports?: ErrorReportsConfig } => { const er = parseErrorReportsConfig(rawObj.errorReports); return er ? { errorReports: er } : {}; })(),
    chat: parseChatConfig(rawObj.chat),
    voice: {
      // Sparse parse: only set fields the user EXPLICITLY put in the
      // config file. Missing fields stay `undefined` so resolvers can
      // fall through to env (backward compat) → hardcoded default.
      stt: {
        ...(voiceStt.provider !== undefined
          ? { provider: normalizeVoiceSttProvider(voiceStt.provider) }
          : {}),
        // G-VOX-1/2 (2026-06-02) — sparse parse · 사용자가 명시한 키만 set.
        ...(typeof voiceStt.apiKey === 'string' && voiceStt.apiKey.trim().length > 0
          ? { apiKey: voiceStt.apiKey.trim() }
          : {}),
        ...(typeof voiceStt.model === 'string' && voiceStt.model.trim().length > 0
          ? { model: voiceStt.model.trim() }
          : {}),
        ...(typeof voiceStt.realtimeBaseModel === 'string' && voiceStt.realtimeBaseModel.trim().length > 0
          ? { realtimeBaseModel: voiceStt.realtimeBaseModel.trim() }
          : {}),
        ...(voiceStt.mode === 'streaming' || voiceStt.mode === 'batch'
          ? { mode: voiceStt.mode }
          : {}),
        ...(typeof voiceStt.language === 'string' && voiceStt.language.trim().length > 0
          ? { language: voiceStt.language.trim() }
          : {}),
      },
      tts: {
        ...(voiceTts.provider !== undefined
          ? { provider: normalizeVoiceTtsProvider(voiceTts.provider) }
          : {}),
        ...(typeof voiceTts.auto === 'boolean' ? { auto: voiceTts.auto } : {}),
        ...(typeof voiceTts.maxSentenceChars === 'number' && voiceTts.maxSentenceChars > 0
          ? { maxSentenceChars: Math.floor(voiceTts.maxSentenceChars) }
          : {}),
        ...(typeof voiceTts.drainCooldownMs === 'number'
          && voiceTts.drainCooldownMs >= 0
          && voiceTts.drainCooldownMs <= 2000
          ? { drainCooldownMs: Math.floor(voiceTts.drainCooldownMs) }
          : {}),
        ...(typeof voiceTts.voiceId === 'string' && voiceTts.voiceId.trim().length > 0
          ? { voiceId: voiceTts.voiceId.trim() }
          : {}),
      },
      vad: {
        ...(voiceVad.mode !== undefined
          ? { mode: normalizeVoiceVadMode(voiceVad.mode) }
          : {}),
        ...(typeof voiceVad.threshold === 'number' && voiceVad.threshold >= 0 && voiceVad.threshold <= 1
          ? { threshold: voiceVad.threshold }
          : {}),
        ...(typeof voiceVad.silenceMs === 'number' && voiceVad.silenceMs >= 50 && voiceVad.silenceMs <= 10000
          ? { silenceMs: Math.floor(voiceVad.silenceMs) }
          : {}),
        ...(typeof voiceVad.minSpeechMs === 'number' && voiceVad.minSpeechMs >= 0 && voiceVad.minSpeechMs <= 5000
          ? { minSpeechMs: Math.floor(voiceVad.minSpeechMs) }
          : {}),
      },
      chat: {
        ...(typeof voiceChat.multiTurn === 'boolean' ? { multiTurn: voiceChat.multiTurn } : {}),
      },
      discord: {
        ...(typeof voiceDiscord.voiceLanguage === 'string' && voiceDiscord.voiceLanguage.length > 0
          ? { voiceLanguage: voiceDiscord.voiceLanguage }
          : {}),
        ...(typeof voiceDiscord.voiceChannel === 'object' && voiceDiscord.voiceChannel !== null
          ? {
              voiceChannel: {
                ...(typeof voiceDiscordChannel.enabled === 'boolean'
                  ? { enabled: voiceDiscordChannel.enabled }
                  : {}),
                ...(normalizeVoiceDiscordChannelListenFilter(voiceDiscordChannel.listenFilter) !== undefined
                  ? { listenFilter: normalizeVoiceDiscordChannelListenFilter(voiceDiscordChannel.listenFilter)! }
                  : {}),
                ...(typeof voiceDiscordChannel.leaveOnEmpty === 'boolean'
                  ? { leaveOnEmpty: voiceDiscordChannel.leaveOnEmpty }
                  : {}),
                ...(typeof voiceDiscordChannel.bargeIn === 'boolean'
                  ? { bargeIn: voiceDiscordChannel.bargeIn }
                  : {}),
                ...(typeof voiceDiscordChannel.bargeInSustainMs === 'number'
                  && voiceDiscordChannel.bargeInSustainMs >= 50 && voiceDiscordChannel.bargeInSustainMs <= 5000
                  ? { bargeInSustainMs: Math.floor(voiceDiscordChannel.bargeInSustainMs) }
                  : {}),
                ...(typeof voiceDiscordChannel.selfEchoTailMs === 'number'
                  && voiceDiscordChannel.selfEchoTailMs >= 0 && voiceDiscordChannel.selfEchoTailMs <= 5000
                  ? { selfEchoTailMs: Math.floor(voiceDiscordChannel.selfEchoTailMs) }
                  : {}),
                ...(typeof voiceDiscordChannel.sttSilenceFinalizeMs === 'number'
                  && voiceDiscordChannel.sttSilenceFinalizeMs >= 100 && voiceDiscordChannel.sttSilenceFinalizeMs <= 10000
                  ? { sttSilenceFinalizeMs: Math.floor(voiceDiscordChannel.sttSilenceFinalizeMs) }
                  : {}),
              },
            }
          : {}),
        // override 필드라 normalize(기본값 강제) 대신 유효 id 만 수용 —
        // 오타는 조용히 openai 로 바뀌는 대신 미설정(전역 체인)으로 남는다.
        ...(voiceDiscord.sttProvider === 'openai-realtime-stt'
          || voiceDiscord.sttProvider === 'gemini-live-stt'
          || voiceDiscord.sttProvider === 'whisper-cpp-local'
          || voiceDiscord.sttProvider === 'elevenlabs-scribe-realtime'
          ? { sttProvider: voiceDiscord.sttProvider }
          : {}),
      },
      telegram: {
        ...(normalizeVoiceTelegramDispatch(voiceTelegram.dispatch) !== undefined
          ? { dispatch: normalizeVoiceTelegramDispatch(voiceTelegram.dispatch)! }
          : {}),
        ...(voiceTelegram.replyMode === 'auto'
          || voiceTelegram.replyMode === 'text'
          || voiceTelegram.replyMode === 'voice'
          ? { replyMode: voiceTelegram.replyMode as VoiceTelegramReplyMode }
          : {}),
        ...(typeof voiceTelegram.voiceLanguage === 'string' && voiceTelegram.voiceLanguage.length > 0
          ? { voiceLanguage: voiceTelegram.voiceLanguage }
          : {}),
      },
      pwa: {
      },
    },
    intake: {
      eventMax: typeof intake.eventMax === 'number' && Number.isSafeInteger(intake.eventMax) && intake.eventMax >= 0 ? intake.eventMax : 10,
      ...(typeof intake.briefingTopic === 'string' && intake.briefingTopic.trim()
        ? { briefingTopic: intake.briefingTopic.trim() } : {}),
      telegram: {
        ...(normalizeIntakeAmbientCaptureMode(intakeTelegram.ambientCapture) !== undefined
          ? { ambientCapture: normalizeIntakeAmbientCaptureMode(intakeTelegram.ambientCapture)! }
          : {}),
      },
      discord: {
        ...(normalizeIntakeAmbientCaptureMode(intakeDiscord.ambientCapture) !== undefined
          ? { ambientCapture: normalizeIntakeAmbientCaptureMode(intakeDiscord.ambientCapture)! }
          : {}),
      },
      ...(intake.approvals && typeof intake.approvals === 'object' && !Array.isArray(intake.approvals)
        && typeof (intake.approvals as Record<string, unknown>).repo === 'string'
        ? { approvals: { repo: (intake.approvals as { repo: string }).repo } }
        : {}),
    },
    dashboard: {
      // Retired display/layout controls; keep only fixed internal defaults.
      views: undefined,
      theme: undefined,
      foldMode: 'task-unit',
      benchmark: undefined,
      bootBanner: undefined,
      enableVirtualWindowSwitchKeys: false,
      promptBank: {
        enabled: dashPromptBank.enabled === true,
        dashboardTurns: dashPromptBank.dashboardTurns === true,
        skillRuns: dashPromptBank.skillRuns === true,
        budgetTokens: clampNum(
          dashPromptBank.budgetTokens,
          DASHBOARD_PROMPT_BANK_DEFAULTS.budgetTokens,
          100,
          20000,
        ),
        limit: clampNum(
          dashPromptBank.limit,
          DASHBOARD_PROMPT_BANK_DEFAULTS.limit,
          1,
          100,
        ),
        record: dashPromptBank.record === false ? false : DASHBOARD_PROMPT_BANK_DEFAULTS.record,
      },
    },
    vw: (() => {
      const entries = {
        acp: parseVwEntry('acp', vw.acp, {}),
        sim: parseVwEntry('sim', vw.sim, { resident: vw.simResident === true ? true : VW_DEFAULTS.simResident }),
        iul: parseVwEntry('iul', vw.iul, {
          resident: vw.iulResident === true ? true : VW_DEFAULTS.iulResident,
          foregroundOnStartup: vw.iulForegroundOnStartup === true ? true : VW_DEFAULTS.iulForegroundOnStartup,
        }),
      };
      const order = Array.isArray(vw.order)
        ? parseVwOrder(vw.order)
        : (vw && typeof vw === 'object' && VW_KNOWN_NAMES.some((name) => name in (vw as Record<string, unknown>))
            ? parseNamedVwOrder(vw as Record<string, unknown>)
            : [...VW_ORDER_DEFAULT]);
      return {
        windowNames: stringRecord(vw.windowNames),
        paneNames: stringRecord(vw.paneNames),
        entries,
        simResident: entries.sim.resident,
        iulResident: entries.iul.resident,
        iulForegroundOnStartup: entries.iul.foregroundOnStartup,
        order,
      };
    })(),
    acp: {
      hopCap: parseHopCap(acpHopCap),
      toolApproval: {
        timeoutMs: acpApprovalTimeoutMs(acpToolApproval.timeoutMs)
          ?? acpApprovalTimeoutEnv() ?? ACP_DEFAULTS.toolApproval.timeoutMs,
      },
      ...(typeof acp.reviewBackend === 'string' && acp.reviewBackend.trim()
        ? { reviewBackend: acp.reviewBackend.trim() }
        : {}),
      ...(typeof acp.reworkBackend === 'string' && acp.reworkBackend.trim()
        ? { reworkBackend: acp.reworkBackend.trim() }
        : {}),
      ...(Object.keys(stringRecord(acp.binaryPaths)).length > 0
        ? { binaryPaths: stringRecord(acp.binaryPaths) }
        : {}),
      ...(typeof acp.slashMaxTurns === 'number' && acp.slashMaxTurns > 0
        ? { slashMaxTurns: Math.floor(acp.slashMaxTurns) }
        : {}),
      ...(acp.editApproval === true ? { editApproval: true } : {}),
    },
    lsp: parseLspConfig(lspRaw),
    plan: parsePlanConfig(rawObj.plan),
    goals: parseGoalsConfig(rawObj.goals),
    registry: parseRegistryConfig(rawObj.registry),
    tools: parseToolsConfig(rawObj.tools),
    ...(rawObj.hitl && typeof rawObj.hitl === 'object' && !Array.isArray(rawObj.hitl)
      && typeof (rawObj.hitl as Record<string, unknown>).executionDeadlineMinutes === 'number'
      ? { hitl: { executionDeadlineMinutes: (rawObj.hitl as { executionDeadlineMinutes: number }).executionDeadlineMinutes } }
      : {}),
    ...(outboundConfig ? { outbound: outboundConfig } : {}),
    ...(parseHqConfig(rawObj.hq) ? { hq: parseHqConfig(rawObj.hq)! } : {}),
    ...(gateRemoteConfig ? { gateRemote: gateRemoteConfig } : {}),
    cli: { helpRole: parseCliHelpRole(rawObj.cli) },
    coo: { linearProject: typeof (rawObj.coo as { linearProject?: unknown } | undefined)?.linearProject === 'string' && (rawObj.coo as { linearProject: string }).linearProject.trim()
      ? (rawObj.coo as { linearProject: string }).linearProject.trim() : '외부 행정·큰 일 (COO)' },
    decisions: parseDecisionsConfig(rawObj.decisions),
    loops: { ...(stewardLoops ?? {}), ...parseLoopOwners(rawObj.loops), orchestrator: parseOrchestratorLoopConfig((rawObj.loops as { orchestrator?: unknown } | undefined)?.orchestrator), seat: parseSeatLoopsConfig(rawObj.loops),
      persona: { enabled: (rawObj.loops as { persona?: { enabled?: unknown } } | undefined)?.persona?.enabled === true } },
    events: parseEventsConfig(rawObj.events),
    guardian: parseGuardianConfig(rawObj.guardian),
    taskAgent: parseTaskAgentConfig(rawObj.taskAgent),
    // M1-1: sparse — undefined when the user hasn't set anything, so
    // resolvers fall through to zero-config defaults.
    ...spreadIfDefined('modelTier', parseModelTierConfig(rawObj.modelTier)),
    ...spreadIfDefined('sessionFabric', parseSessionFabricConfig(rawObj.sessionFabric)),
    ...spreadIfDefined('nextFluent', parseNextFluentConfig(rawObj.nextFluent)),
    ...spreadIfDefined('taste', parseTasteConfig(rawObj.taste)),
    ...spreadIfDefined('webSearch', parseWebSearchConfig(rawObj.webSearch)),
    ...spreadIfDefined('design', parseDesignConfig(rawObj.design)),
    diagnostics: parseDiagnosticsConfig(rawObj.diagnostics),
    ...spreadIfDefined('budget', parseBudgetConfig(rawObj.budget)),
    ...spreadIfDefined('smartDefaults', parseSmartDefaultsConfig(rawObj.smartDefaults)),
    ...spreadIfDefined('roleModels', parseRoleModelConfig(rawObj.roleModels)),
    ...spreadIfDefined('roleModelTiers', parseRoleModelTierConfig(rawObj.roleModelTiers)),
    ...spreadIfDefined('roleLlm', parseRoleLlmConfig(rawObj.roleLlm)),
    ...spreadIfDefined('autoReview', parseAutoReviewConfig(rawObj.autoReview)),
    ...spreadIfDefined('ops', parseOpsConfig(rawObj.ops)),
    ...(autopilotConfig ? { autopilot: autopilotConfig } : {}),
    grounding: parseGroundingSources(rawObj.grounding),
    ...spreadIfDefined('notifications', parseNotificationsConfig(rawNotifications)),
    ...spreadIfDefined('mcp', parseMcpConfig(rawObj.mcp)),
    ...spreadIfDefined('backgroundReasoning', parseBackgroundReasoningConfig(rawObj.backgroundReasoning)),
    raw: rawObj,
    // Phase 2 (PLAN-config-unification-elanous-root-2026-05-10):
    //   NEXUS schema fields surface at the typed root so `elanous config
    //   get global.<...>` resolves through the shared dotted-path
    //   resolver. Daemon-side reader (`src/nexus/config/user-config.ts`)
    //   continues to read these directly from the same JSON file.
    version: typeof rawObj.version === 'number' ? rawObj.version : undefined,
    global: rawObj.global && typeof rawObj.global === 'object' && !Array.isArray(rawObj.global)
      ? rawObj.global as Record<string, unknown>
      : undefined,
    tabs: rawObj.tabs && typeof rawObj.tabs === 'object' && !Array.isArray(rawObj.tabs)
      ? rawObj.tabs as Record<string, Record<string, unknown>>
      : undefined,
  };
  const asideConfig = parseAsideConfig(rawObj.aside);
  if (asideConfig) config.aside = asideConfig;
  return config;
}

function parseVwOrder(raw: unknown): Array<'acp' | 'sim' | 'iul'> {
  const seen = new Set<'acp' | 'sim' | 'iul'>();
  const out: Array<'acp' | 'sim' | 'iul'> = [];
  const push = (value: unknown) => {
    if (value !== 'acp' && value !== 'sim' && value !== 'iul') return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) push(entry);
  }
  for (const fallback of VW_ORDER_DEFAULT) push(fallback);
  return out;
}

function parseVwEntry(
  name: VwKnownName,
  raw: unknown,
  legacy: { resident?: boolean; foregroundOnStartup?: boolean } = {},
): VwEntryConfig {
  const defaults = VW_ENTRY_DEFAULTS[name];
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const resident = obj.resident === true
    ? true
    : obj.resident === false
      ? false
      : legacy.resident ?? defaults.resident;
  const foregroundOnStartup = obj.foregroundOnStartup === true
    ? true
    : legacy.foregroundOnStartup ?? defaults.foregroundOnStartup;
  return { resident, foregroundOnStartup };
}

function parseNamedVwOrder(raw: Record<string, unknown>): VwKnownName[] {
  const keyed = Object.keys(raw).filter((key): key is VwKnownName =>
    VW_KNOWN_NAMES.includes(key as VwKnownName),
  );
  const orderHints = new Map<VwKnownName, number>();
  for (const name of keyed) {
    const entry = raw[name];
    if (!entry || typeof entry !== 'object') continue;
    const hint = (entry as Record<string, unknown>).order;
    if (typeof hint === 'number' && Number.isFinite(hint)) {
      orderHints.set(name, Math.trunc(hint));
    }
  }
  if (orderHints.size === 0) return parseVwOrder(keyed);
  const fallbackPos = new Map<VwKnownName, number>();
  parseVwOrder(keyed).forEach((name, idx) => fallbackPos.set(name, idx));
  return [...VW_KNOWN_NAMES].sort((a, b) => {
    const ah = orderHints.get(a);
    const bh = orderHints.get(b);
    if (ah !== undefined && bh !== undefined && ah !== bh) return ah - bh;
    if (ah !== undefined && bh === undefined) return -1;
    if (ah === undefined && bh !== undefined) return 1;
    return (fallbackPos.get(a) ?? 999) - (fallbackPos.get(b) ?? 999);
  });
}

function parsePlanConfig(raw: unknown): PlanConfig {
  if (!raw || typeof raw !== 'object') return { ...PLAN_DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    autoWorktree: r.autoWorktree === true,
  };
}

function parseGoalsConfig(raw: unknown): GoalsConfig {
  if (!raw || typeof raw !== 'object') return { ...GOALS_DEFAULTS };
  const r = raw as Record<string, unknown>;
  const modeRaw = typeof r.modeDefault === 'string' ? r.modeDefault : '';
  return {
    maxTurns: clampNum(r.maxTurns, GOALS_DEFAULTS.maxTurns, 1, 1000),
    wallClockMaxMs: clampNum(r.wallClockMaxMs, GOALS_DEFAULTS.wallClockMaxMs, 60_000, 24 * 60 * 60_000),
    tokenBudget: clampNum(r.tokenBudget, GOALS_DEFAULTS.tokenBudget, 0, 10_000_000),
    judgeModel: typeof r.judgeModel === 'string' ? r.judgeModel : GOALS_DEFAULTS.judgeModel,
    judgeRetries: clampNum(r.judgeRetries, GOALS_DEFAULTS.judgeRetries, 0, 10),
    resumeOnPlanModeExit: r.resumeOnPlanModeExit === true,
    modeDefault: modeRaw === 'spec' ? 'spec' : 'judge',
  };
}

function cloneLspDefaults(): LspConfig {
  return {
    enabled: LSP_DEFAULTS.enabled,
    typescript: cloneLspLang(LSP_DEFAULTS.typescript),
    python:     cloneLspLang(LSP_DEFAULTS.python),
    rust:       cloneLspLang(LSP_DEFAULTS.rust),
    idleTimeoutMs: LSP_DEFAULTS.idleTimeoutMs,
    workspaceSymbolLanguage: LSP_DEFAULTS.workspaceSymbolLanguage,
  };
}

function cloneLspLang(e: LspLanguageConfig | false): LspLanguageConfig | false {
  if (e === false) return false;
  return {
    command: e.command,
    ...(e.args ? { args: [...e.args] } : {}),
    extensions: [...e.extensions],
  };
}

function parseLspLanguage(
  raw: unknown,
  fallback: LspLanguageConfig | false,
): LspLanguageConfig | false {
  if (raw === false) return false;
  if (!raw || typeof raw !== 'object') return cloneLspLang(fallback);
  const r = raw as Record<string, unknown>;
  // Fallback entry is false when the user hasn't configured this
  // language; an explicit `{ command: 'x' }` overrides. If the user
  // supplies an object without `command`, we treat it as "enable
  // defaults for this language" — but only when the default is not
  // already `false` (otherwise we'd silently conjure a binary name).
  const cmd = str(r.command) ?? (fallback !== false ? fallback.command : undefined);
  if (!cmd) return cloneLspLang(fallback);
  const args = Array.isArray(r.args)
    ? (r.args as unknown[]).filter(a => typeof a === 'string') as string[]
    : (fallback !== false && fallback.args ? [...fallback.args] : undefined);
  const exts = Array.isArray(r.extensions) && r.extensions.length > 0
    ? (r.extensions as unknown[]).filter(a => typeof a === 'string').map(s => (s as string).toLowerCase().replace(/^\./, ''))
    : (fallback !== false ? [...fallback.extensions] : []);
  return {
    command: cmd,
    ...(args ? { args } : {}),
    extensions: exts,
  };
}

function parseLspConfig(raw: Record<string, unknown>): LspConfig {
  return {
    enabled: raw.enabled === false ? false : true,
    typescript: parseLspLanguage(raw.typescript, LSP_DEFAULTS.typescript),
    python:     parseLspLanguage(raw.python,     LSP_DEFAULTS.python),
    rust:       parseLspLanguage(raw.rust,       LSP_DEFAULTS.rust),
    idleTimeoutMs: clampNum(raw.idleTimeoutMs, LSP_DEFAULTS.idleTimeoutMs, 5_000, 60 * 60 * 1000),
    workspaceSymbolLanguage: (raw.workspaceSymbolLanguage === 'python' || raw.workspaceSymbolLanguage === 'rust')
      ? raw.workspaceSymbolLanguage
      : 'typescript',
  };
}

function parseHopCap(raw: Record<string, unknown>): AcpHopCapConfig {
  const out: AcpHopCapConfig = {};
  for (const k of ['claude', 'codex', 'gemini', 'default'] as const) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      out[k] = Math.floor(v);
    }
  }
  return out;
}

function normalizeDebugLevel(v: unknown): DebugConfig['level'] {
  switch (v) {
    case 'off':
    case 'trail':
    case 'diag':
    case 'normal':
    case 'verbose':
    case 'detail':
    case 'keytrace':
      return v;
    default:
      return DEBUG_DEFAULTS.level;
  }
}

/** Follow-up #7 — resolve the effective HOP_CAP for a brand from
 *  user-config. Returns `undefined` when no brand-specific and no
 *  `default` entry is set; the DRM resolver then falls back to
 *  `DEFAULT_HOP_CAP`. Exposed as a helper so the dashboard boot can
 *  wire it into `setAcpHopCapResolver` without replicating the lookup
 *  chain. */
export function resolveAcpHopCapFromConfig(
  brandId: string,
  config: UserConfig = getUserConfig(),
): number | undefined {
  const hc = config.acp.hopCap;
  if (brandId === 'claude' && hc.claude !== undefined) return hc.claude;
  if (brandId === 'codex' && hc.codex !== undefined) return hc.codex;
  if (brandId === 'gemini' && hc.gemini !== undefined) return hc.gemini;
  return hc.default;
}

/** 자식 worktree 뿌리 — ⭐ **소비처는 이 함수만 부른다**(`getUserConfig().tools….worktreeRoot` 를 직접 쓰지 않는다).
 *
 *  ⛔ 왜 함수로 뽑나(리뷰 2R must-fix ①②): 소비처마다 같은 표현식을 손으로 쓰면
 *  ⑴ 누가 `worktreeRoot: undefined` 를 넘겨도 「인자를 썼다」는 검사는 통과하고
 *  ⑵ 별칭·래퍼로 부르면 소스 스캔이 못 본다.
 *  ⇒ 🩹 값을 «내는 자리»를 하나로 만들면 그 둘이 «구조적으로» 사라진다 — 넘길 잘못된 값이 없다.
 *  ⭐ 그리고 이 함수 하나만 런타임으로 검증하면 모든 소비처의 전달값이 같이 검증된다. */
export function configuredWorktreeRoot(configPath?: string): string {
  return getUserConfig(configPath).tools.selfImplement.worktreeRoot;
}

/** Normalized Nexus outbound relay configuration; disabled unless explicitly enabled. */
export function resolveNexusRelayConfig(config: UserConfig = getUserConfig()): {
  enabled: boolean;
  url?: string;
  identityFile?: string;
} {
  const relay = config.nexus?.relay;
  return {
    enabled: relay?.enabled === true,
    ...(relay?.url ? { url: relay.url } : {}),
    ...(relay?.identityFile ? { identityFile: relay.identityFile } : {}),
  };
}

/** Resolve the explicit startup environment switch; legacy config keys are retired. */
export function resolveTuiUnattended(
  config: UserConfig = getUserConfig(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  void config;
  return env.ELANOUS_TUI_UNATTENDED === String(1);
}

// Read at call time, not registration time, so reload/reset and on-disk edits keep their semantics.
// Stored timezone is kept in raw by buildUserConfig; do not change getUserConfig's returned shape.
setConfigTimeZoneSource(() => {
  const config = getUserConfig();
  return config.timezone ?? (typeof config.raw.timezone === 'string' ? config.raw.timezone : undefined);
});

/** Default backup path — sits next to config.json so `elanous provider
 *  restore` can find it without extra arguments. A/B comparison: if
 *  you want multiple named backups, use `saveUserConfigBackupTo(path)`. */
export function backupConfigPath(path: string = defaultPath()): string {
  return `${path}.bak`;
}

/** Copy the current config.json to its `.bak` sibling. Returns true
 *  if a backup was written, false if the source doesn't exist. Throws
 *  on IO failure (bad permissions etc). Used by `elanous provider set`
 *  before mutating config so the user can always roll back. */
export function backupUserConfig(
  path: string = defaultPath(),
  backupPath: string = backupConfigPath(path),
): boolean {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, 'utf-8');
  writeFileSync(backupPath, raw);
  return true;
}

/** Restore config.json from its `.bak` sibling. Returns true if the
 *  restore happened, false if no backup was found. Deletes the backup
 *  afterwards so repeated restores can't resurrect an ancient state. */
export function restoreUserConfig(
  path: string = defaultPath(),
  backupPath: string = backupConfigPath(path),
): boolean {
  if (!existsSync(backupPath)) return false;
  const raw = readFileSync(backupPath, 'utf-8');
  writeFileSync(path, raw);
  return true;
}

// ── Rotation helpers ──
//
// The user maintains an ordered list of provider-shaped entries
// (provider, model, apiKey, baseUrl, label). `elanous provider:rotate`
// / `/provider next` advance through the list; `elanous provider:use
// <label>` jumps to a specific entry by label / provider name /
// model substring. The active LLMConfig fields at the top level
// (provider, apiKey, model, baseUrl) are copied FROM the selected
// entry when it activates — so the rest of the app sees the new
// settings through the existing cfg.llm channel without any
// rotation-awareness.

/** Build the default display label for a rotation entry. Used when
 *  the user didn't supply one — keeps the list readable. */
export function rotationEntryLabel(e: RotationEntry): string {
  return e.label ?? (e.model ? `${e.provider}:${e.model}` : e.provider);
}

/** Vendor-default model identifier per provider. Used by the model
 *  picker (status-bar pill popup) to surface a real model name even
 *  when a rotation entry was added without an explicit `model` field
 *  (e.g. `elanous provider:rotate add anthropic` with no `-m`). Sourced
 *  from the same defaults `elanous provider:rotate add` uses; lives
 *  here so UI consumers don't import from src/index.ts (which would
 *  pull in the entire CLI surface). */
export const PROVIDER_DEFAULT_MODEL: Record<LLMProviderName, string> = {
  auto: '',
  // ⛔ 2026-09-23: `claude-opus-4-8` 은 별칭 감사가 ***stale*** 로 판정한 값이었다
  //    (`auditFamilyAliasFreshness` → recommendedModel: claude-opus-5). 실물 flagship 으로 맞춘다.
  // ⭐ 2026-09-25 (대표 「모델별 최신으로」): anthropic → opus 5.5 · gemini → 3.8-flash. 근거 = 각 provider 목록 실측(사다리 머리말).
  //   ⛔ openai(API 키)는 gpt-4o 그대로 — `gpt-6-*` 는 openai-codex 계열이라 openai 로 부르면 호환 판정이 거부한다(09-23 대표 · 같은 날 되돌림).
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-4o',
  // 2026-10-28: GPT-6.1 Terra is the current recommended Codex default.
  //    `llm.ts` avoids importing this UI-facing module, so keep its local default aligned here.
  //    ⚠️ `llm.ts` 에서 import 하지 «않는다» — 이 파일은 UI 소비자가 CLI 표면을 안 끌어오게
  //    «일부러» 독립돼 있다(이 상수의 머리말). ⇒ 값을 맞추고 «자»로 묶는다.
  'openai-codex': 'gpt-6.1-terra',
  'hq-proxy': 'gpt-6.1-terra',
  // ⛔ 2026-08-18: 'grok-4-1-fast' 는 «200 OK 로 응답하지만 실제로는 grok-4.3 이 도는»
  //    레거시 별칭이었다(xAI 실호출 대조). 실물 flagship 으로 고친다.
  grok: 'grok-4.7',
  // 대표 2026-09-23 — 사다리 balanced 와 같다(`llm.ts` OPENROUTER_MODEL). 자가 둘을 묶는다.
  openrouter: 'openrouter/z-ai/glm-5.3',
  opengateway: 'opengateway/deepseek/deepseek-v4.1-flash-ultrafast',
  // ⛔ 2026-08-18: 'gemini-2.0-flash' 는 카탈로그의 «가장 낡은» 항목이었다. 같은 날 grok 을
  //    고치면서 이 줄이 빠졌다. 카탈로그가 recommended 로 표시한 실물 flash 로 맞춘다.
  gemini: 'gemini-3.8-flash',
  // ⛔ 2026-08-18: 'llama-3' 는 이 저장소가 로컬 LLM 을 쓰기 시작한 이래 «한 번도» 갱신되지 않았고
  //    LM Studio 실물 목록에 없다. 같은 날 grok·gemini 에서 잡은 것과 같은 병(기본값이 실물을 안 가리킨다).
  // ⛔ 2026-09-23 — ***`local:` 접두를 붙인다.*** `#19867` 에서 사다리에만 붙여 «정렬이 깨졌고»
  //   `local-tier-resolution.test.ts` 가 그것을 물었다(내가 낸 회귀 · origin/main 에서도 3 fail).
  //   ⭐ 접두가 «옳은» 이유 둘: ⑴ 요청 직전에 벗겨진다(`llm.ts` stripLocalLlmSpec)
  //     ⑵ 클라우드 `qwen-*` 과 ***이름이 겹치는 것을 가른다*** — 접두 없이는 계열 추론이
  //        `qwen3.8-27b-mlx` 를 클라우드 qwen 으로 읽는다(그게 `#19867` 에서 고친 그 병이다).
  local: 'local:qwen3.8-27b-mlx',
  kimi: 'kimi-k2.6',
  qwen: 'qwen3.6-flash',
  glm: 'glm-5.1',
  // BEDROCK-PROVIDER (2026-10-10) — Bedrock 의 Claude(`anthropic.` 접두 · 공식 «Supported models» 표).
  bedrock: BEDROCK_DEFAULT_MODEL,
};

/** Resolve the display model for a rotation entry — falls back to the
 *  provider's vendor default when the entry doesn't pin a model. */
export function modelDisplayForRotationEntry(e: RotationEntry): string {
  return e.model ?? PROVIDER_DEFAULT_MODEL[e.provider] ?? '';
}

/** Find the rotation index that matches the current active top-level
 *  (provider, model). Returns -1 when no entry matches — typical when
 *  the user set the active provider manually without adding it to
 *  the rotation. Callers should treat -1 as "start from the top on
 *  next rotate". */
export function currentRotationIndex(cfg: UserConfig): number {
  const rot = cfg.llm.rotation;
  if (!rot || rot.length === 0) return -1;
  for (let i = 0; i < rot.length; i++) {
    const e = rot[i]!;
    if (e.provider !== cfg.llm.provider) continue;
    // When the entry has an explicit model, require match; otherwise
    // any model of the same provider is considered "current".
    if (e.model && cfg.llm.model && e.model !== cfg.llm.model) continue;
    return i;
  }
  return -1;
}

/** Apply a rotation entry to the active LLMConfig fields. Pure
 *  function — returns a new cfg without mutating the input. The
 *  apiKey / baseUrl fall back to the previous active values when
 *  the entry doesn't provide them, so partial entries (provider +
 *  model only, relying on env-var API keys) keep working. */
export function applyRotationEntry(cfg: UserConfig, entry: RotationEntry): UserConfig {
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      provider: entry.provider,
      // Explicit undefined ERASES the field; only copy when present
      // OR when the previous cfg had no corresponding top-level.
      ...(entry.model   !== undefined ? { model:   entry.model }   : {}),
      ...(entry.apiKey  !== undefined ? { apiKey:  entry.apiKey }  : {}),
      ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
    },
  };
}

/** Advance the rotation by one step (wraps to index 0 after the last
 *  entry). Returns { cfg, entry } — the new cfg and the freshly-
 *  activated entry, or { cfg: original, entry: null } if rotation is
 *  empty. Caller is responsible for saveUserConfig + reloadUserConfig. */
export function rotateNextProvider(cfg: UserConfig): { cfg: UserConfig; entry: RotationEntry | null } {
  const rot = cfg.llm.rotation;
  if (!rot || rot.length === 0) return { cfg, entry: null };
  const cur = currentRotationIndex(cfg);
  const next = cur < 0 ? 0 : (cur + 1) % rot.length;
  const entry = rot[next]!;
  return { cfg: applyRotationEntry(cfg, entry), entry };
}

/** Jump to the first rotation entry matching `needle` — checked
 *  against (in priority order): label exact match, provider exact
 *  match, model substring match, provider substring match. Returns
 *  { cfg, entry } on success or { cfg: original, entry: null } on
 *  no-match. Case-insensitive. */
export function jumpToRotationEntry(
  cfg: UserConfig,
  needle: string,
): { cfg: UserConfig; entry: RotationEntry | null } {
  const rot = cfg.llm.rotation;
  if (!rot || rot.length === 0) return { cfg, entry: null };
  const q = needle.toLowerCase();
  // Priority scan: label exact > provider exact > model contains > provider contains.
  const byLabel = rot.findIndex(e => (e.label ?? '').toLowerCase() === q);
  const byProv  = rot.findIndex(e => e.provider.toLowerCase() === q);
  const byMdlSub = rot.findIndex(e => (e.model ?? '').toLowerCase().includes(q));
  const byProvSub = rot.findIndex(e => e.provider.toLowerCase().includes(q));
  const idx = [byLabel, byProv, byMdlSub, byProvSub].find(i => i >= 0) ?? -1;
  if (idx < 0) return { cfg, entry: null };
  const entry = rot[idx]!;
  return { cfg: applyRotationEntry(cfg, entry), entry };
}

/** Append an entry to the rotation (dedup by label-or-provider:model
 *  so repeated adds are idempotent). Does NOT modify the active
 *  top-level llm fields — use rotateNextProvider / jumpToRotationEntry
 *  for that. */
export function addRotationEntry(cfg: UserConfig, entry: RotationEntry): UserConfig {
  const key = rotationEntryLabel(entry);
  const existing = cfg.llm.rotation ?? [];
  const filtered = existing.filter(e => rotationEntryLabel(e) !== key);
  return {
    ...cfg,
    llm: { ...cfg.llm, rotation: [...filtered, entry] },
  };
}

/** Remove rotation entry by label / provider / model (same matching
 *  rules as jumpToRotationEntry). Returns new cfg + the removed
 *  entry, or {cfg, removed: null} when no match. */
export function removeRotationEntry(
  cfg: UserConfig,
  needle: string,
): { cfg: UserConfig; removed: RotationEntry | null } {
  const rot = cfg.llm.rotation;
  if (!rot || rot.length === 0) return { cfg, removed: null };
  const q = needle.toLowerCase();
  const idx = rot.findIndex(e =>
    (e.label ?? '').toLowerCase() === q
    || e.provider.toLowerCase() === q
    || (e.model ?? '').toLowerCase() === q,
  );
  if (idx < 0) return { cfg, removed: null };
  const removed = rot[idx]!;
  const next = rot.slice(0, idx).concat(rot.slice(idx + 1));
  return {
    cfg: { ...cfg, llm: { ...cfg.llm, rotation: next.length > 0 ? next : undefined } },
    removed,
  };
}


export function saveUserConfig(cfg: UserConfig, path: string = defaultPath()): void {
  const serializerDeps = {
    parseProjectRubricAxes,
    stripUndef,
    acpApprovalTimeoutMs,
    acpApprovalTimeoutEnv,
    acpDefaults: ACP_DEFAULTS,
    vwOrderDefault: VW_ORDER_DEFAULT,
    vwEntryDefaults: VW_ENTRY_DEFAULTS,
    parseModelTierConfig,
    parseDiagnosticsConfig,
  };
  const out = sparseUserConfig(
    serializeUserConfig(cfg, serializerDeps),
    serializeUserConfig(defaultConfig(), serializerDeps),
    cfg.raw,
  );
  mkdirSync(dirname(path), { recursive: true });
  // FU3: lock-protected atomic write. Path B's patchUserConfig acquires
  // the same lock so simultaneous writers cannot lose each other's
  // updates. Read phase is NOT inside the lock — callers that need full
  // R-M-W exclusion should re-read inside a withFileLockSync block.
  withFileLockSync(path + '.lock', () => {
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf-8');
    renameSync(tmp, path);
    // Bundle 2' (2026-04-27) · always chmod 600. Was previously gated on
    // `cfg.telegram.botToken` — but the file also contains `llm.apiKey`,
    // future Discord/MCP tokens, and other personal config (skill paths,
    // vault path). Owner-only is the safe default. On Windows chmodSync
    // sets the readonly bit and is best-effort; we suppress errors so a
    // host that rejects the call doesn't block the wizard.
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  });
  // Capture post-write mtime so the reader can distinguish our own write
  // from an external writer updating the file behind the cache.
  rememberSavedUserConfig(cfg, path, readMtimeMsOrNull(path));
}

// ── VW rename mutators (VW-B3/B4) ────────────────────────────────
//
// Pure setters that return a new UserConfig with one VW entry
// inserted / removed. Callers pair them with saveUserConfig() to
// persist. Passing an empty string removes the override — matches
// the VW registry rule that setPaneTitle('') clears the map entry.

export function setVwWindowName(cfg: UserConfig, spawnTitle: string, next: string | undefined): UserConfig {
  const map = { ...cfg.vw.windowNames };
  const trimmed = (next ?? '').trim();
  if (!trimmed) delete map[spawnTitle];
  else map[spawnTitle] = trimmed;
  return { ...cfg, vw: { ...cfg.vw, windowNames: map } };
}

export function setVwPaneName(cfg: UserConfig, key: string, next: string | undefined): UserConfig {
  const map = { ...cfg.vw.paneNames };
  const trimmed = (next ?? '').trim();
  if (!trimmed) delete map[key];
  else map[key] = trimmed;
  return { ...cfg, vw: { ...cfg.vw, paneNames: map } };
}

/** PLAN-model-intelligence-router · Part B / Phase B4 — pin a concrete
 *  model (and optional provider) as the active LLM selection. Used by the
 *  setup-once cadence: the suggester resolves a model from intent, then
 *  this writes it as a plain pin so subsequent turns behave like a
 *  hand-picked model (no per-turn routing). Pure — caller persists via
 *  `saveUserConfig`. */
export function withLlmModel(
  cfg: UserConfig,
  model: string,
  provider?: LLMProviderName,
): UserConfig {
  const trimmed = (model ?? '').trim();
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      ...(trimmed ? { model: trimmed } : {}),
      ...(provider ? { provider } : {}),
    },
  };
}

/** Build the composite key used for pane-name lookups. Kept here
 *  so the VW registry and user-config stay aligned on the format. */
export function vwPaneKey(windowSpawnTitle: string, paneContentTitle: string): string {
  return `${windowSpawnTitle}|${paneContentTitle}`;
}

export function markOnboardingComplete(cfg: UserConfig): UserConfig {
  return {
    ...cfg,
    onboarding: {
      completed: true,
      completedAt: new Date().toISOString(),
      version: ONBOARDING_VERSION,
    },
  };
}

export function currentOnboardingVersion(): number { return ONBOARDING_VERSION; }

function normalizeProvider(v: unknown): LLMProviderName {
  const allowed = CONFIG_LLM_PROVIDER_NAMES;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) {
    return v as LLMProviderName;
  }
  // Phase 2 (RFC #2161 · 2026-05-10) — alias resolution via Layer A
  // catalog (`catalog/providers/*.yaml`). 'claude' → 'anthropic',
  // 'codex' → 'openai-codex' (special case · keep legacy split for the
  // openai-codex switch path; full merge is Phase 4 scope), etc. Only
  // accept registry-resolved id when it lands inside the legacy union
  // — preserves the silent-fallback-to-'auto' contract for typos.
  if (typeof v === 'string' && v.trim()) {
    // Special case: 'codex' alias maps to 'openai' in registry, but the
    // legacy switch path needs 'openai-codex' to dispatch to the Codex
    // adapter. Honor the explicit codex alias as 'openai-codex'.
    const lower = v.trim().toLowerCase();
    if (lower === 'codex') return 'openai-codex';
    try {
      // Lazy import to avoid circular module init order during
      // user-config bootstrap (registry loader reads YAML which sits
      // outside the user-config dependency graph).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { normalizeProviderId } = require('./registry/normalize.js') as {
        normalizeProviderId: (s: string | null | undefined) => string | null;
      };
      const fromRegistry = normalizeProviderId(v);
      if (fromRegistry && (allowed as string[]).includes(fromRegistry)) {
        return fromRegistry as LLMProviderName;
      }
    } catch {
      // Fall through to 'auto' if registry isn't available yet.
    }
  }
  return 'auto';
}

/** Parse the optional `llm.rotation` array from raw JSON into
 *  typed RotationEntry[]. Rejects malformed entries (missing
 *  provider, unknown provider name) so a garbled config can't
 *  crash the runtime — just silently drops bad rows. Returns
 *  undefined when no rotation is configured (preserves the
 *  absence so callers can distinguish "never set up" from
 *  "empty array"). */
/** Validate provider-agnostic reasoning level. Same fault-tolerance
 *  as `parseRotation` / `parseCodexReasoning` — silent drop on
 *  garbage. */
/** ⭐ export 인 이유 — 시험 러너는 config 를 격리해 `getUserConfig()` 경로로는 이 파서를 못 문다(2026-09-23 실측). */
export function parseReasoningLevel(raw: unknown): ReasoningLevel | undefined {
  const allowed = ['off', 'low', 'medium', 'high', 'xhigh'] as const;
  if (typeof raw !== 'string') return undefined;
  return (allowed as readonly string[]).includes(raw) ? raw as ReasoningLevel : undefined;
}

/** Validate Codex Responses API reasoning options. Returns undefined
 *  when the input is missing OR when both fields fail validation —
 *  mirroring `parseRotation`'s "silent drop on garbage" stance so a
 *  malformed config never crashes the LLM stack. */
function parseCodexReasoning(raw: unknown): { effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; summary?: 'auto' | 'concise' | 'detailed' } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  // GPT-5.6(sol/terra/luna) — xhigh/max 신규 effort. 하위 모델은 무시(모델이 depth 결정).
  const effortAllowed = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
  const summaryAllowed = ['auto', 'concise', 'detailed'] as const;
  const out: { effort?: typeof effortAllowed[number]; summary?: typeof summaryAllowed[number] } = {};
  if (typeof obj.effort === 'string' && (effortAllowed as readonly string[]).includes(obj.effort)) {
    out.effort = obj.effort as typeof effortAllowed[number];
  }
  if (typeof obj.summary === 'string' && (summaryAllowed as readonly string[]).includes(obj.summary)) {
    out.summary = obj.summary as typeof summaryAllowed[number];
  }
  return (out.effort !== undefined || out.summary !== undefined) ? out : undefined;
}

function parseGoalLoop(raw: unknown): { enabled?: boolean; maxIterations?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: { enabled?: boolean; maxIterations?: number } = {};
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  if (typeof obj.maxIterations === 'number' && obj.maxIterations > 0) out.maxIterations = Math.floor(obj.maxIterations);
  return (out.enabled !== undefined || out.maxIterations !== undefined) ? out : undefined;
}

function parseMemoryJudge(raw: unknown): { enabled?: boolean; model?: string; crossRecall?: boolean } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: { enabled?: boolean; model?: string; crossRecall?: boolean } = {};
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  if (typeof obj.model === 'string' && obj.model.trim()) out.model = obj.model.trim();
  if (typeof obj.crossRecall === 'boolean') out.crossRecall = obj.crossRecall;
  return (out.enabled !== undefined || out.model !== undefined || out.crossRecall !== undefined) ? out : undefined;
}

function parseAnswerPriority(raw: unknown): 'cost' | 'balanced' | 'quality' | 'exhaustive' | undefined {
  return raw === 'cost' || raw === 'balanced' || raw === 'quality' || raw === 'exhaustive'
    ? raw
    : undefined;
}

function parseMaxTurnsField(raw: unknown): number | null | undefined {
	  // Tri-state: positive int = explicit cap, null/0 = unlimited,
	  // anything else = field omitted (fall through to answerPriority).
	  if (raw === null || raw === 0) return null;
	  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	  return undefined;
	}

	/** Budget-override keys. Pair of NAMED_MAX_TURNS_FAMILIES in llm.ts —
	 *  adding a name here is what opens `llm.maxTurns.<family>` (incl. 0/null
	 *  = unlimited). Kept as a local const so this file does not import llm.ts
	 *  (hot-path cycle). `default` stays the residual bucket. */

	function parseMaxTurnsBudget(raw: unknown): MaxTurnsBudget | undefined {
	  if (!raw || typeof raw !== 'object') return undefined;
	  const obj = raw as Record<string, unknown>;
	  const out: MaxTurnsBudget = {};
	  for (const key of MAX_TURNS_BUDGET_KEYS) {
	    const parsed = parseMaxTurnsField(obj[key]);
	    if (parsed !== undefined) out[key] = parsed;
	  }
	  return Object.keys(out).length > 0 ? out : undefined;
	}

function parseRotation(raw: unknown): RotationEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RotationEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const provider = normalizeProvider(obj.provider);
    // Skip entries that defaulted to 'auto' — usually means the
    // provider field was garbage. A true "auto" rotation entry
    // wouldn't make sense (rotation implies explicit choice).
    if (provider === 'auto' && obj.provider !== 'auto') continue;
    out.push({
      provider,
      model:   str(obj.model),
      apiKey:  str(obj.apiKey),
      baseUrl: str(obj.baseUrl),
      label:   str(obj.label),
    });
  }
  return out.length > 0 ? out : undefined;
}

const MISSION_KINDS: ReadonlyArray<'plan' | 'build' | 'review' | 'research' | 'quick' | 'vision'> = [
  'plan', 'build', 'review', 'research', 'quick', 'vision',
];

function parseMissionRouting(raw: unknown): MissionRoutingConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: MissionRoutingConfig = {};
  if (obj.mode === 'auto' || obj.mode === 'manual') out.mode = obj.mode;
  const missionsRaw = obj.missions;
  if (missionsRaw && typeof missionsRaw === 'object') {
    const missions: MissionRoutingConfig['missions'] = {};
    for (const kind of MISSION_KINDS) {
      const entry = (missionsRaw as Record<string, unknown>)[kind];
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const provider = str(e.provider);
      if (!provider) continue;
      missions[kind] = { provider, model: str(e.model) };
    }
    if (Object.keys(missions).length > 0) out.missions = missions;
  }
  if (out.mode === undefined && out.missions === undefined) return undefined;
  return out;
}

function parseLlmRoutePolicy(raw: unknown): LlmRoutePolicyConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const mode = v.mode === 'codex-first' || v.mode === 'active-provider' ? v.mode : undefined;
  const opusEscalation = v.opusEscalation === 'evidence-hitl' ? v.opusEscalation : undefined;
  return mode || opusEscalation ? { ...(mode ? { mode } : {}), ...(opusEscalation ? { opusEscalation } : {}) } : undefined;
}

function parseAutoRoute(raw: unknown): AutoRouteConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: AutoRouteConfig = {};
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  if (typeof obj.useClassifierLlm === 'boolean') out.useClassifierLlm = obj.useClassifierLlm;
  if (typeof obj.applyNuance === 'boolean') out.applyNuance = obj.applyNuance;
  if (out.enabled === undefined && out.useClassifierLlm === undefined && out.applyNuance === undefined) {
    return undefined;
  }
  return out;
}

function normalizeSkillSet(v: unknown): SkillSetName {
  return (typeof v === 'string' && (SKILL_SET_NAMES as string[]).includes(v))
    ? v as SkillSetName
    : 'opencode';
}

function stripUndef<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
