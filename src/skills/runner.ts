// ── Skill execution engine ──
// Discover SKILL.md files under ~/.claude/skills/, parse their YAML frontmatter,
// substitute template variables, and run them through the selected LLM provider.

import { debug } from '../debug/log.js';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { LOCAL_SKILLS_DIR } from '../config.js';
import { applyToolPolicy } from '../tool-runtime/tool-policy.js';
import {
  getProvider, resolveDefaultProvider, isModelCompatible, streamLLM, streamLLMWithTools,
  buildMessagesWithContext, isLikelyVisionModel,
  type LLMMessage, type LLMProvider, type LLMToolSpec,
} from '../llm.js';
import { loadAllAttachments } from '../extractors.js';
import { listAttachments, type ContextRegistry } from '../context.js';
import { buildBashTool, dispatchBash } from './tools/index.js';
import { buildReadTool, dispatchRead } from './tools/read.js';
import { buildEditTool, dispatchEdit } from './tools/edit.js';
import { buildWriteTool, dispatchWrite } from './tools/write.js';
import { buildGrepTool, dispatchGrep } from './tools/grep.js';
import { buildGlobTool, dispatchGlob } from './tools/glob.js';
import { buildListDirTool, dispatchListDir } from './tools/list-dir.js';
import { buildAstGrepTool, dispatchAstGrep } from './tools/ast-grep.js';
import { buildLspTool, dispatchLsp } from './tools/lsp/index.js';
import { buildWebFetchTool, dispatchWebFetch } from './tools/webfetch.js';
import { buildWebSearchTool, dispatchWebSearch } from './tools/web-search.js';
import { buildSetToolHintTool, dispatchSetToolHint } from './tools/set-hint.js';
import { buildMermaidRenderTool, dispatchMermaidRender } from './tools/mermaid.js';
import { buildMermaidSyntaxTool, dispatchMermaidSyntax } from './tools/mermaid-syntax.js';
import { buildYoutubeTranscriptTool, dispatchYoutubeTranscript } from './tools/youtube-transcript.js';
import {
  buildDashboardSlashExecuteTool,
  dispatchDashboardSlashExecute,
} from './tools/dashboard-slash.js';
import {
  buildDashboardConfigGetTool,
  buildDashboardConfigSetTool,
  dispatchDashboardConfigGet,
  dispatchDashboardConfigSet,
} from './tools/dashboard-config.js';
import {
  buildDashboardWidgetListTool,
  buildDashboardWidgetToggleTool,
  buildDashboardPaneFocusTool,
  dispatchDashboardWidgetList,
  dispatchDashboardWidgetToggle,
  dispatchDashboardPaneFocus,
} from './tools/dashboard-widget.js';
import {
  buildWidgetSnapshotTool,
  buildWidgetDescribeTool,
  buildWidgetCallTool,
  dispatchWidgetSnapshot,
  dispatchWidgetDescribe,
  dispatchWidgetCall,
} from './tools/widget-inspector.js';
import {
  buildDashboardViewSwitchTool,
  buildDashboardWidgetInvokeTool,
  dispatchDashboardViewSwitch,
  dispatchDashboardWidgetInvoke,
} from './tools/dashboard-view.js';
import { buildApiCallTool, dispatchApiCall } from './tools/api-call.js';
import { buildOmniSearchTool, dispatchOmniSearch } from './tools/omni-search.js';
import { buildMarketQuoteTool, dispatchMarketQuote } from './tools/market-quote.js';
import { buildKrFlowTool, dispatchKrFlow } from './tools/kr-flow.js';
import {
  buildPtyShellStartTool,
  buildPtyShellPollTool,
  buildPtyShellSendTool,
  buildPtyShellKillTool,
  buildPtyShellListTool,
  dispatchPtyShellStart,
  dispatchPtyShellPoll,
  dispatchPtyShellSend,
  dispatchPtyShellKill,
  dispatchPtyShellList,
} from './tools/pty.js';
import { killNonDetached } from '../pty-shell/registry.js';
import {
  buildShellListTool,
  buildShellPollTool,
  buildShellKillTool,
  dispatchShellList,
  dispatchShellPoll,
  dispatchShellKill,
} from './tools/shell-runner.js';
import { getShellRegistry } from '../shell-runner/registry.js';
import { persistToolOutputPreview } from '../tool-runtime/truncation-store.js';
import {
  buildTerminalModalListTool,
  buildTerminalModalObserveTool,
  buildTerminalModalFocusTool,
  buildTerminalModalDetachTool,
  buildTerminalModalKillTool,
  dispatchTerminalModalList,
  dispatchTerminalModalObserve,
  dispatchTerminalModalFocus,
  dispatchTerminalModalDetach,
  dispatchTerminalModalKill,
} from './tools/terminal-modal.js';
import {
  buildTerminalModalInjectTool,
  dispatchTerminalModalInject,
} from './tools/terminal-modal-inject.js';
import {
  buildSnapshotPtyStateTool,
  buildListPtySnapshotsTool,
  buildComparePtySnapshotsTool,
  dispatchSnapshotPtyState,
  dispatchListPtySnapshots,
  dispatchComparePtySnapshots,
} from './tools/tty-snapshot.js';
import {
  buildAgentHandoffTool,
  dispatchAgentHandoff,
} from './tools/agent-handoff.js';
import {
  buildBudgetStatusTool,
  buildBudgetHistoryTool,
  buildBudgetForecastTool,
  buildBudgetSetLimitTool,
  dispatchBudgetStatus,
  dispatchBudgetHistory,
  dispatchBudgetForecast,
  dispatchBudgetSetLimit,
} from './tools/budget.js';
import {
  buildPolicyDecideTool,
  buildPolicyExplainTool,
  dispatchPolicyDecide,
  dispatchPolicyExplain,
} from './tools/route.js';
import {
  buildAgentRoomComposeTool,
  buildAgentRoomListTool,
  buildAgentRoomCloseTool,
  dispatchAgentRoomCompose,
  dispatchAgentRoomList,
  dispatchAgentRoomClose,
} from './tools/agent-room.js';
import {
  buildAgentReplyTool,
  dispatchAgentReply,
} from './tools/agent-reply.js';
import {
  buildListCaptureSourcesTool,
  buildSnapshotSourceTool,
  dispatchListCaptureSources,
  dispatchSnapshotSource,
} from './tools/capture-source.js';
import {
  buildInjectCaptureToContextTool,
  dispatchInjectCaptureToContext,
} from './tools/capture-inject.js';
import {
  buildLaneHandoffTool,
  dispatchLaneHandoff,
} from './tools/lane-handoff.js';
import {
  buildLlmListNodesTool,
  buildLlmListAvailableModelsTool,
  dispatchLlmListNodes,
  dispatchLlmListAvailableModels,
} from './tools/llm-manager.js';
import {
  buildLlmRequestInstallTool,
  dispatchLlmRequestInstall,
} from './tools/llm-install.js';
import { createInjectApprover } from '../dashboard/runtime/approvers.js';
import {
  buildBrowserOpenTool,
  buildBrowserNavigateTool,
  buildBrowserScreenshotTool,
  buildBrowserReadTool,
  buildBrowserCloseTool,
  buildIPhoneNotifyTool,
  buildIPhoneOpenUrlTool,
  buildIPhoneAgentResultTool,
  buildIPhoneConfirmTool,
  buildHitlConfirmTool,
  dispatchBrowserOpen,
  dispatchBrowserNavigate,
  dispatchBrowserScreenshot,
  dispatchBrowserRead,
  dispatchBrowserClose,
  dispatchIPhoneNotify,
  dispatchIPhoneOpenUrl,
  dispatchIPhoneAgentResult,
  dispatchIPhoneConfirm,
  dispatchHitlConfirm,
} from './tools/browser-iphone.js';
export function buildBrowserSessionTools(): LLMToolSpec[] {
  return [
    buildBrowserOpenTool(),
    buildBrowserNavigateTool(),
    buildBrowserScreenshotTool(),
    buildBrowserReadTool(),
    buildBrowserCloseTool(),
  ];
}

export const browserSessionDispatchers = {
  BrowserOpen: (args: Record<string, unknown>) => dispatchBrowserOpen(args),
  BrowserNavigate: (args: Record<string, unknown>) => dispatchBrowserNavigate(args),
  BrowserScreenshot: (args: Record<string, unknown>) => dispatchBrowserScreenshot(args),
  BrowserRead: (args: Record<string, unknown>) => dispatchBrowserRead(args),
  BrowserClose: (args: Record<string, unknown>) => dispatchBrowserClose(args),
};

import { buildAgentTool, dispatchAgent } from './tools/agent.js';
import { buildSkillToolDisciplinePrompt } from './tool-discipline-prompt.js';
import {
  findNativeTool,
  listNativeToolsForHost,
  nativeToolCatalog,
  type NativeToolCatalogEntry,
} from '../native-tool-catalog.js';
import { evaluateGate } from '../tool-hints/gate.js';
import { endTurn as endHintTurn, listHints } from '../tool-hints/registry.js';
import { collectSignals } from '../tool-hints/signals.js';
import { applyHintFeedback, resetFeedbackCounterOnTurnEnd } from '../tool-hints/feedback.js';
import { SessionCache } from '../session/cache.js';
import {
  type LogEntry, renderLogEntry, renderLogEntryAsString, summarizeToolCall,
  formatAgentDone,
  type FoldMode,
  type RenderOpts,
} from '../log-entry.js';
import { getModelPromptAddon, getModelFamily } from '../models/prompts.js';
import { buildUniversalPreamble } from '../prompt-library/universal-preamble.js';
import { getUserConfig } from '../user-config.js';
import { resolveChatSystemPrompt } from '../prompt-library/registry.js';
import {
  buildPromptInjection,
  getPromptBankStore,
  renderPromptInjectionForSystemAddendum,
} from '../prompt-bank/index.js';

export interface SkillManifest {
  name: string;          // slug (directory name)
  description: string;
  model?: string;        // routing hint, e.g. 'claude-haiku-4-5', 'gpt-4o-mini', 'grok-4', 'local:llama3'
  /** Whitelist applied to the host tool roster before the LLM call.
   *  Pattern semantics match `ToolPolicy` in `src/tool-runtime/
   *  tool-policy.ts` — exact name, `mcp__server` whole-server prefix,
   *  or `mcp__server__tool` exact. `[]` (explicit empty) yields 0
   *  tools. Frontmatter key: `allowedTools` or `allowed-tools`. */
  allowedTools?: string[];
  /** Blacklist applied after `allowedTools`. Same pattern semantics.
   *  Deny wins over allow when both match a tool. Frontmatter key:
   *  `deniedTools` or `denied-tools`. Archon-port T1.1 (2026-05-08). */
  deniedTools?: string[];
  /** Skill-author-declared natural-language keywords that should route
   *  free-text user input to this skill. Matched case-insensitively
   *  as substrings by `skill-router.detectSkillTrigger()`. Empty /
   *  missing = skill is invokable only via explicit /run-skill. */
  triggers?: string[];
  /** When true AND the router's confidence exceeds its threshold, the
   *  dashboard MAY auto-route to this skill without a confirmation
   *  step. Still gated by a global user opt-in flag — defaults to
   *  false so skill authors surface behaviour explicitly. */
  autoTrigger?: boolean;
  /** Opt out of Phase-3 description-body trigger extraction. Default
   *  (unset/true) runs `extractTriggers()` over the description to
   *  derive additional keywords. Set `autoExtract: false` in
   *  frontmatter when the author wants only explicitly-listed
   *  `triggers:` to count. */
  autoExtract?: boolean;
  /** Phase-5 Bash bridge — interpreter for the Bash tool. 'bash'
   *  (default), 'zsh', or 'sh'. Most claude-code-style skills assume
   *  bash; only set otherwise when the skill body relies on shell-
   *  specific syntax. */
  shell?: string;
  /** Per-call default timeout for the Bash tool, in ms. Capped at
   *  600_000. Default 120_000 (mirrors claude-code-fork). Lift this
   *  for skills that legitimately need long subprocess runs (audio
   *  transcription, large LLM SDK calls, etc.). */
  bashTimeoutMs?: number;
  /** Minimum model tier required for the skill to run well. Session 21
   *  addition. The router refuses auto-route (but not /run-skill) when
   *  the active model is weaker than this bar.
   *   - `T1` = frontier (Opus/Sonnet 4.x, GPT-5, Gemini 2.x, Grok 4)
   *   - `T2` = mini (Haiku 4.5, GPT-5-mini, Gemini Flash)
   *   - `T3` = local (Gemma/Llama/Qwen via LM Studio / llama.cpp)
   *  Unset = treat as T2 (conservative default; author hasn't declared). */
  minTier?: SkillTier;
  /** Downstream skills this skill typically delegates to — metadata only.
   *  Session 21. Router reads this to pre-warm candidate ranking and to
   *  draw the composition graph in `skills-map.md`. Not a hard runtime
   *  dependency — a broken downstream doesn't prevent this skill from
   *  loading. */
  composes?: string[];
  /** Logical taxonomy tag (digest/search/market/visual/knowledge/code/…).
   *  Session 21 Option-A. Carried as metadata so the disk layout can stay
   *  flat (for Claude Code + Codex CLI compatibility) while the router
   *  and `skills.allow/deny` config can still scope by category. Unset
   *  = uncategorized. */
  category?: string;
  /** Auto-execution safety declaration. Missing or unknown values remain unset. */
  sideEffects?: 'none' | 'write' | 'spawn';
  /** Execution-cost declaration. Missing or unknown values remain unset. */
  cost?: 'light' | 'heavy';
  content: string;       // raw markdown body (frontmatter stripped)
  skillDir: string;      // absolute path
}

/** Ordered weak→strong. Session 21. */
export type SkillTier = 'T3' | 'T2' | 'T1';
const TIER_RANK: Record<SkillTier, number> = { T3: 1, T2: 2, T1: 3 };

/** True when `active` is at least as strong as `min`. Missing `min`
 *  treats as T2 (conservative). */
export function tierMeetsMin(active: SkillTier, min: SkillTier | undefined): boolean {
  const m: SkillTier = min ?? 'T2';
  return TIER_RANK[active] >= TIER_RANK[m];
}

function parseTier(raw: unknown): SkillTier | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toUpperCase();
  if (v === 'T1' || v === 'T2' || v === 'T3') return v;
  return undefined;
}

// ── Minimal YAML frontmatter parser ──
// Matches the format used in Claude Code skills: --- ... ---
// Supports: name, description (plain, quoted, or >-folded), model, allowed-tools (list or comma-separated)

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

function parseFrontmatter(md: string): { fm: Record<string, any>; body: string } {
  const match = md.match(FRONTMATTER_RE);
  if (!match) return { fm: {}, body: md };

  const raw = match[1]!;
  const body = md.slice(match[0].length);
  const fm: Record<string, any> = {};

  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }

    const key = m[1]!;
    let val = m[2]!.trim();

    // Block scalar ( > or | followed by indented lines)
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const fold = val.startsWith('>');
      const chomp = val.endsWith('-');
      const collected: string[] = [];
      i++;
      while (i < lines.length && (lines[i]!.startsWith('  ') || lines[i]!.trim() === '')) {
        collected.push(lines[i]!.replace(/^ {2}/, ''));
        i++;
      }
      let text = collected.join('\n');
      if (fold) text = text.replace(/\n(?!\n)/g, ' ').replace(/\n\n/g, '\n');
      if (chomp) text = text.replace(/\n+$/, '');
      fm[key] = text.trim();
      continue;
    }

    // List on following indented lines (- item)
    if (val === '' && i + 1 < lines.length && lines[i + 1]!.match(/^\s+-\s+/)) {
      const items: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.match(/^\s+-\s+/)) {
        items.push(lines[i]!.replace(/^\s+-\s+/, '').trim());
        i++;
      }
      fm[key] = items;
      continue;
    }

    // Flow-style array: `key: [a, b, c]` (session 21). Parsed into a
    // string[] so consumers see the same shape as the block-list path.
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      fm[key] = inner
        ? inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        : [];
      i++;
      continue;
    }

    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    fm[key] = val;
    i++;
  }

  return { fm, body };
}

// ── Skill discovery ──

/**
 * List all skill directories under the base skills dir.
 * A "skill" is any subdirectory containing SKILL.md.
 *
 * Session 21 — recursive-by-one-level discovery. With the B5.7 taxonomy
 * move, skills live under category dirs:
 *     skills/digest/omni-digest/SKILL.md
 *     skills/visual/diagram-master/SKILL.md
 * but legacy flat layouts remain supported:
 *     skills/omni-digest/SKILL.md
 * For each entry under `baseDir`:
 *   - starts with `.` or `_`  → skipped entirely (private / primitives).
 *   - contains `SKILL.md`     → treated as a skill at the root level.
 *   - doesn't                 → treated as a CATEGORY; its subdirs that
 *                               contain SKILL.md become skills. One-level
 *                               recursion only; no deeper nesting.
 *
 * Returns the skill *name* (directory leaf), preserving the invariant
 * that a skill is identified by its directory name. parseSkillMd uses
 * resolveSkillDir to recover the matching full path.
 */
export function listSkillNames(baseDir: string = LOCAL_SKILLS_DIR): string[] {
  if (!existsSync(baseDir)) return [];
  const seen = new Set<string>();
  for (const name of readdirSync(baseDir)) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const dir = join(baseDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      if (existsSync(join(dir, 'SKILL.md'))) {
        seen.add(name);   // flat-layout skill at root
        continue;
      }
      // Category dir — scan one level deeper for skills.
      for (const child of readdirSync(dir)) {
        if (child.startsWith('.') || child.startsWith('_')) continue;
        const childDir = join(dir, child);
        try {
          if (!statSync(childDir).isDirectory()) continue;
          if (existsSync(join(childDir, 'SKILL.md'))) {
            // Collision policy: flat-layout entries win over nested.
            if (!seen.has(child)) seen.add(child);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return Array.from(seen).sort();
}

/** Resolve the on-disk directory for a skill under `baseDir`. Session 21
 *  adds one-level-deep category-dir support:
 *    1. `baseDir/skillName/SKILL.md` (flat)  → preferred
 *    2. `baseDir/<category>/skillName/SKILL.md` (nested)  → fallback
 *  Returns the matching dir or null. */
function resolveSkillDir(skillName: string, baseDir: string): string | null {
  const flat = join(baseDir, skillName);
  if (existsSync(join(flat, 'SKILL.md'))) return flat;
  if (!existsSync(baseDir)) return null;
  for (const name of readdirSync(baseDir)) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const catDir = join(baseDir, name);
    try {
      if (!statSync(catDir).isDirectory()) continue;
      const cand = join(catDir, skillName);
      if (existsSync(join(cand, 'SKILL.md'))) return cand;
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Parse a single SKILL.md file into a manifest.
 * Returns null if the skill directory or file doesn't exist.
 */
export function parseSkillMd(skillName: string, baseDir: string = LOCAL_SKILLS_DIR): SkillManifest | null {
  const skillDir = resolveSkillDir(skillName, baseDir);
  if (!skillDir) return null;
  const skillPath = join(skillDir, 'SKILL.md');

  const raw = readFileSync(skillPath, 'utf-8');
  const { fm, body } = parseFrontmatter(raw);

  let allowedTools: string[] | undefined;
  const at = fm['allowed-tools'] ?? fm['allowedTools'];
  if (Array.isArray(at)) allowedTools = at;
  else if (typeof at === 'string' && at.trim()) {
    allowedTools = at.split(/[,\s]+/).filter(Boolean);
  }

  // Archon-port T1.1: deniedTools companion. Same parse shape as
  // allowedTools (array or comma/whitespace string). Applied via
  // applyToolPolicy in executeSkill — deny wins over allow.
  let deniedTools: string[] | undefined;
  const dt = fm['denied-tools'] ?? fm['deniedTools'];
  if (Array.isArray(dt)) deniedTools = dt;
  else if (typeof dt === 'string' && dt.trim()) {
    deniedTools = dt.split(/[,\s]+/).filter(Boolean);
  }

  let triggers: string[] | undefined;
  const tr = fm['triggers'] ?? fm['trigger'];
  if (Array.isArray(tr)) triggers = tr.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  else if (typeof tr === 'string' && tr.trim()) {
    triggers = tr.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  }

  // `autoTrigger: true` / `autoTrigger: yes` / `autoTrigger: 1` — all accepted.
  // Missing field defaults to false; the router treats absent/false as
  // "suggest only, don't auto-route".
  const autoTrigger = parseBool(fm['autoTrigger'] ?? fm['auto-trigger']);
  const autoExtract = parseBool(fm['autoExtract'] ?? fm['auto-extract']);

  const shell = typeof fm['shell'] === 'string' ? fm['shell'].trim() : undefined;
  let bashTimeoutMs: number | undefined;
  const bt = fm['bashTimeoutMs'] ?? fm['bash-timeout-ms'];
  if (typeof bt === 'number' && Number.isFinite(bt)) bashTimeoutMs = bt;
  else if (typeof bt === 'string' && bt.trim()) {
    const n = Number(bt);
    if (Number.isFinite(n)) bashTimeoutMs = n;
  }

  const minTier = parseTier(fm['minTier'] ?? fm['min-tier']);
  let composes: string[] | undefined;
  const comp = fm['composes'];
  if (Array.isArray(comp)) {
    composes = comp.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  } else if (typeof comp === 'string' && comp.trim()) {
    composes = comp.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  }

  const category = typeof fm['category'] === 'string' && fm['category'].trim()
    ? fm['category'].trim()
    : undefined;
  const rawSideEffects = fm['sideEffects'];
  const sideEffects = rawSideEffects === 'none' || rawSideEffects === 'write' || rawSideEffects === 'spawn'
    ? rawSideEffects
    : undefined;
  const rawCost = fm['cost'];
  const cost = rawCost === 'light' || rawCost === 'heavy' ? rawCost : undefined;

  return {
    name: fm['name'] || skillName,
    description: fm['description'] || '',
    model: fm['model'] || undefined,
    allowedTools,
    deniedTools,
    triggers,
    autoTrigger,
    autoExtract,
    shell,
    bashTimeoutMs,
    minTier,
    composes,
    category,
    sideEffects,
    cost,
    content: body,
    skillDir,
  };
}

function parseBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
  }
  return undefined;
}

// ── Template substitution ──

/**
 * Replace template variables in skill content:
 *   $ARGUMENTS         → user-supplied args string
 *   ${CLAUDE_SKILL_DIR}→ skill directory path
 *   $1, $2, ...        → individual args (whitespace-split)
 */
export function substituteTemplate(content: string, args: string, skillDir: string): string {
  let out = content;

  // ${CLAUDE_SKILL_DIR} — support both ${...} and bare form
  out = out.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);
  out = out.replace(/\$CLAUDE_SKILL_DIR\b/g, skillDir);

  // $ARGUMENTS — full args string
  out = out.replace(/\$ARGUMENTS\b/g, args);
  out = out.replace(/\$\{ARGUMENTS\}/g, args);

  // $1 $2 ... — positional args
  const parts = args.trim().split(/\s+/).filter(Boolean);
  out = out.replace(/\$(\d+)/g, (_m, n) => parts[Number(n) - 1] ?? '');

  return out;
}

// ── Skill execution ──

/** Payload for ExecuteSkillOpts.onAgentBatchStatus — exposed as a
 *  named type so callers (dashboard) can type their state buffers
 *  without duplicating the shape. */
export interface AgentBatchStatusInfo {
  phase: 'start' | 'tick' | 'complete' | 'end';
  batchElapsedMs: number;
  total: number;
  done: number;
  remaining: number;
  runningDescriptions: string[];
  completedDescription?: string;
}

export interface ExecuteSkillOpts {
  /** Override the provider (by name or model string). */
  modelOverride?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Additional system-level context to prepend (e.g. dashboard state). */
  systemContext?: string;
  /**
   * Optional attachment registry. When provided, every loaded attachment is
   * inlined into the user message (text kinds as labeled sections, images as
   * ContentBlock[]). Callers should `loadAllAttachments` before calling, or
   * pass `autoLoad=true` below.
   */
  context?: ContextRegistry;
  /**
   * If true and `context` is set, the registry's unloaded attachments are
   * materialized inside `executeSkill` before the LLM call. Default false —
   * most callers already load upstream.
   */
  autoLoad?: boolean;
  /** Optional: per-tool-loop-turn notification. Used by the dashboard
   *  to update the thinking line with live turn count + last tool calls. */
  onTurn?(info: { turn: number; durationMs: number; textChars: number; pendingCalls: string[] }): void;
  /** Optional: live notification for parallel Agent batches. Kept out
   *  of the display transcript so the dashboard can update one pinned
   *  status row instead of appending a new log line every second. */
  onAgentBatchStatus?(info: AgentBatchStatusInfo): void;
  /** Optional: notify the host whenever a foldable log entry is
   *  pushed (currently bg-batch-launch; tool-body/agent-child blocks
   *  may follow). Dashboard buffers these during the stream and
   *  converts them into FoldStack targets once chatLines stabilises.
   *  The `renderOpts` are the ones the entry was actually rendered
   *  with — needed so dashboard can reproduce the exact same line
   *  block when re-rendering for fold toggles. */
  onFoldableEntry?(entry: LogEntry, renderOpts: import('../log-entry.js').RenderOpts): void;
  /**
   * Fold strategy for this run's foldable log entries (tool-body first
   * paint and the matching onFoldableEntry registration). Omitted →
   * renderLogEntry keeps its existing 'line' default. Dashboard supplies
   * the current logFoldMode; the runner must not read dashboard state.
   */
  foldMode?: FoldMode;
  /** When true, foldHint keeps the rich-mode "press f to expand" suffix.
   *  Omitted/false = count-only. Dashboard supplies `mode === 'rich'`;
   *  the runner must not read dashboard state. */
  expandHint?: boolean;
  /** Optional: override the tool-loop turn budget for this run.
   *  Defaults to 20 — high enough for orchestrator skills that fan
   *  out via Agent. Set lower for one-shot lookups, higher for
   *  pathological multi-phase flows. */
  maxTurns?: number;
  /** Recent chat history to thread into the skill's context — lets a
   *  second skill trigger reference "해당 내용" / "that analysis" from
   *  the first skill without the user having to repeat it. Bounded
   *  upstream (dashboard slices the tail) so we don't balloon the
   *  skill's prompt. When present, `buildSkillMessages` renders it
   *  as a `## Recent conversation` section in the user turn BEFORE
   *  the dashboard's Context / Question blocks. Empty / undefined =
   *  no prior-conversation block (legacy behaviour). */
  priorConversation?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Dynamic Prompt Bank addendum materialized by executeSkill when
   *  dashboard.promptBank.skillRuns is enabled. Kept as an explicit
   *  pure-builder input so tests and future callers can reason about
   *  the final message shape without opening the SQLite store. */
  promptBankContext?: string;
}

export interface ExecuteSkillResult {
  provider: string;
  model: string;
  fullResponse: string;
}

/** RenderOpts for this skill run's foldable log entries.
 *  Unspecified foldMode keeps the existing empty-opts / 'line' path.
 *  Unspecified expandHint keeps the safe count-only foldHint. */
export function skillFoldRenderOpts(foldMode?: FoldMode, expandHint?: boolean): RenderOpts {
  return {
    ...(foldMode ? { foldMode } : {}),
    ...(expandHint ? { expandHint } : {}),
  };
}

/**
 * P5: resolve the native-tool catalog for this skill run through the
 * hint/signal/probe gate. Returns the filtered entry list + the
 * hint reasons to surface in the discipline prompt. When the gate
 * yields nothing useful (no probes, no hints, no signals), this is a
 * no-op wrapper around listNativeToolsForHost('skill').
 *
 * Kept sync — the gate is pure, signals are cheap, and probeOk
 * returns cached / fails-closed for async kinds. Called once per
 * buildSkillMessages invocation.
 */
/** P15 — read terminal session registry state if it's been initialized
 *  (dashboard startup primes it). Headless / test paths get an empty
 *  summary back, keeping signal defaults ('no active modal') accurate. */
function collectTerminalSessionSignals(): import('../tool-hints/signals.js').TerminalSessionSignals | undefined {
  try {
    // Late-bind to avoid a top-level import cycle with skill-tool-terminal-modal.
    const { getDashboardTerminalSessions } = require('../dashboard/terminal/session.js') as typeof import('../dashboard/terminal/session.js');
    const registry = getDashboardTerminalSessions();
    const all = registry.list();
    const alive = all.filter(s => s.state !== 'exited');
    if (alive.length === 0) return undefined;
    const fg = registry.foreground();
    return {
      hasActiveModal: true,
      backgroundedCount: registry.backgrounded().length,
      foregroundKind: fg?.kind,
      hasAttention: alive.some(s => s.attentionLevel >= 2),
    };
  } catch {
    // Registry not initialized yet (dashboard hasn't started).
    return undefined;
  }
}

/** P15 — summary for the discipline prompt's ACTIVE TERMINAL SESSIONS
 *  block. Returns empty array when the registry isn't primed. */
function collectTerminalSessionSummary(): Array<{
  id: string;
  title: string;
  state: 'foreground' | 'background' | 'exited';
  kind?: 'shell' | 'coding-agent';
  agentBrand?: string;
  attentionLevel: number;
  lastNotification?: string;
}> {
  try {
    const { getDashboardTerminalSessions } = require('../dashboard/terminal/session.js') as typeof import('../dashboard/terminal/session.js');
    const registry = getDashboardTerminalSessions();
    return registry.list().map(s => ({
      id: s.id,
      title: s.title,
      state: s.state,
      kind: s.kind,
      agentBrand: s.agentBrand,
      attentionLevel: s.attentionLevel,
      lastNotification: s.lastNotification?.title,
    }));
  } catch {
    return [];
  }
}

function resolveFilteredSkillCatalog(opts: {
  modelId?: string;
  recentUserText?: string;
  recentToolResults?: Array<{ tool: string; text: string; isError?: boolean }>;
}): { catalog: NativeToolCatalogEntry[]; hintReasons: string[] } {
  const hostCatalog = listNativeToolsForHost('skill');
  const signals = collectSignals({
    recentUserText: opts.recentUserText,
    recentToolResults: opts.recentToolResults,
    modelFamily: getModelFamily(opts.modelId),
    // modelTier is not currently threaded here; P6 will wire the
    // active chat/session tier when it lands /hint + tier-aware filtering.
    terminal: collectTerminalSessionSignals(),
  });
  const hints = listHints();
  const decision = evaluateGate(hostCatalog, hints, signals);
  const filteredIds = new Set(decision.filtered);
  // P15 — collect a compact session summary for the discipline prompt.
  const terminalSessions = collectTerminalSessionSummary();
  if (terminalSessions.length > 0) {
    // Attach via a side channel — decision is plain data; we widen
    // the contract minimally (hintReasons gets a synthetic line).
    decision.hintReasons = [...(decision.hintReasons ?? []), `${terminalSessions.length} active terminal session(s)`];
  }
  // Preserve catalog's declaration order for tools in the filtered set
  // (gate sort is by boost — fine for prompt ordering, but tests and
  // humans expect catalog order as the baseline; buildNativeToolPromptSummary
  // will re-read from this list in the filtered order).
  const catalog = nativeToolCatalog.filter(t => filteredIds.has(t.id));
  // Re-sort by gate's boost order so the discipline prompt lists
  // preferred tools first.
  const boostOrder = new Map(decision.filtered.map((id, i) => [id, i]));
  catalog.sort((a, b) => (boostOrder.get(a.id) ?? 99) - (boostOrder.get(b.id) ?? 99));
  return { catalog, hintReasons: decision.hintReasons };
}

/**
 * Pure message-construction step for a skill run. Separated from
 * `executeSkill` so tests can assert the shape of what we'd send to the LLM
 * without spinning up a real provider.
 *
 * When `context` is supplied, the user turn is built via
 * `buildMessagesWithContext` so text attachments get labeled code-fenced
 * sections and images land as ContentBlocks — matching the Q&A path.
 */
export function buildSkillMessages(
  manifest: SkillManifest,
  args: string,
  opts: Pick<ExecuteSkillOpts, 'systemContext' | 'context' | 'priorConversation' | 'promptBankContext'> & { modelId?: string; cwd?: string } = {},
): LLMMessage[] {
  const chatPromptVariant = resolveChatSystemPrompt({
    model: opts.modelId,
    config: getUserConfig().chat.systemPrompt,
  });
  // Per-model prompt addon — weak tool-callers (codex / gpt-5) get an
  // imperative discipline section appended. Claude / Grok / Gemini /
  // local see an empty string (no-op). See src/model-prompts.ts.
  const modelAddon = getModelPromptAddon(opts.modelId);

  // P5: resolve the gate-filtered catalog once. Uses `args` as a
  // proxy for user-intent text since skill triggers are invoked with
  // the user's phrasing; full prior-turn text threading is deferred
  // to P6 when /hint + set_tool_hint are live.
  const { catalog: filteredCatalog, hintReasons } = resolveFilteredSkillCatalog({
    modelId: opts.modelId,
    recentUserText: args,
  });

  const systemPrompt = [
    `You are executing the Claude Code skill "${manifest.name}".`,
    manifest.description ? `Skill description: ${manifest.description}` : '',
    `Skill directory: ${manifest.skillDir}`,
    // Phase-5: tell the model the Bash bridge exists. Without this
    // some providers (notably grok) treat skill bodies as prose and
    // role-play execution instead of using the tool. The note is
    // cheap to include and unambiguous.
    buildSkillToolDisciplinePrompt({
      catalog: filteredCatalog,
      hintReasons,
      terminalSessions: collectTerminalSessionSummary(),
    }) + '\n\n' +
    '## Agent tool — multi-worker delegation (read this carefully)\n\n' +
    'When the SKILL.md tells you to "spawn N agents", "use the Agent tool", "fan out to experts", or similar multi-worker language, you **MUST** call `Agent` N times in a single turn. This is not optional. After you call Agent N times, the N results come back as N separate tool_results on the next turn — THEN you synthesize the final answer from those results.\n\n' +
    'Concrete example for a 5-persona panel:\n\n' +
    '```\n' +
    '(same turn, 5 tool_calls)\n' +
    'Agent({\n' +
    '  description: "Value investor analysis on Samsung 2026",\n' +
    '  subagent_type: "general-purpose",\n' +
    '  prompt: "You are Margaret Chen, a Value Investor... [full persona profile from personas.json] ...\\n\\nAnalyze: Samsung Electronics 2026 outlook.\\n\\nUse Bash to call kr-flow/omni-market for fundamentals. Return 10 analytical points with stance + confidence, in Margaret\'s voice."\n' +
    '})\n' +
    'Agent({\n' +
    '  description: "Macro trader analysis on Samsung 2026",\n' +
    '  subagent_type: "general-purpose",\n' +
    '  prompt: "You are Alexei Volkov, a Global Macro Hedge Fund Manager... [full profile] ...\\n\\nAnalyze: Samsung Electronics 2026 outlook.\\n\\nUse Bash to check DXY, memory pricing cycles, USDKRW. Return 10 points in Alexei\'s voice."\n' +
    '})\n' +
    '... (3 more Agent calls in the SAME turn, one per persona)\n' +
    '```\n\n' +
    'Each Agent call gets its own context window (30k-token budget independent of yours), its own tool loop (20 turns each), and its own Bash/Read/etc. — so a persona can run kr-flow, omni-market, firecrawl in parallel without your context seeing the raw outputs. Only the final persona response lands in your history as a tool_result.\n\n' +
    '**Critical anti-patterns to avoid:**\n' +
    '- ❌ Enumerating personas by calling Bash/python3 to print them, then stopping — that is NOT execution, that is research. The actual work happens inside Agent() calls.\n' +
    '- ❌ Doing one persona\'s analysis inline in your own response — you must delegate to Agent so all N run with isolated contexts.\n' +
    '- ❌ Emitting an empty turn (no text, no tool calls) — always either call tools or produce the final synthesis. Empty turns waste your tool-loop budget.\n' +
    '- ❌ Calling Agent sequentially across multiple turns — always batch all N in ONE turn so they run with the same prompt cache.',
    modelAddon,
    chatPromptVariant.text,
    opts.systemContext || '',
    opts.promptBankContext || '',
  ].filter(Boolean).join('\n\n');

  const userPrompt = substituteTemplate(manifest.content, args, manifest.skillDir);
  // Prior-conversation block — when the dashboard hands us the tail
  // of chat.history, render it as a `## Recent conversation` section
  // ahead of the skill body so the LLM can reference "해당 내용" /
  // "that analysis" from an earlier turn. Each entry is compressed to
  // role-prefixed lines; empty array / undefined → skip entirely.
  const convoBlock = (() => {
    const hist = opts.priorConversation ?? [];
    if (hist.length === 0) return '';
    const lines = hist.map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      return `### ${role}\n${m.text.trim()}`;
    }).join('\n\n');
    return `## Recent conversation (prior turns — reference if relevant)\n\n${lines}\n\n---\n`;
  })();
  const userText = [
    convoBlock,
    args ? `Arguments: ${args}\n\n${userPrompt}` : userPrompt,
  ].filter(Boolean).join('\n');

  // P3 (2026-05-03) — Universal preamble plumbing for the skill runner
  // surface. Without this, codex/gpt-5.4 entered skill execution with
  // ZERO project anchor (AGENTS.md/CLAUDE.md) AND ZERO codex behavioral
  // discipline addendum (anti-reread + parallelize + persist-to-completion
  // + narrate-before-act + verify-via-tests). PR #768 wired this for the
  // dashboard turn loop only — the skill runner, which executes most
  // user-invoked /commands, was a blind spot.
  //
  // The preamble emits 0-2 system messages (project anchor + codex-family
  // addendum). Spread BEFORE the skill-specific systemPrompt so the model
  // sees universal context first, then skill-specific instructions.
  const skillModelFamily = getModelFamily(opts.modelId);
  const skillCwd = opts.cwd ?? process.cwd();
  // Wave 4 (2026-05-04) — feed the gate-filtered skill catalog
  // displayNames into the universal preamble so session-specific
  // guidance fires for skills that include AskUserQuestion / Agent /
  // TaskCreate / Plan-mode tools.
  const skillEnabledTools = filteredCatalog.map(e => e.displayName);
  const universalPreamble = buildUniversalPreamble({
    cwd: skillCwd,
    ...(skillModelFamily !== undefined ? { modelFamily: skillModelFamily } : {}),
    enabledTools: skillEnabledTools,
  });
  if (debug.enabled) {
    debug.log('chat.skill-preamble', 'built', {
      skill: manifest.name,
      modelId: opts.modelId,
      modelFamily: skillModelFamily,
      universalCount: universalPreamble.length,
      universalChars: universalPreamble.reduce((sum, m) => {
        const c = m.content;
        return sum + (typeof c === 'string' ? c.length : JSON.stringify(c).length);
      }, 0),
      hasContext: !!opts.context,
      cwd: skillCwd,
    });
  }

  if (opts.context) {
    // buildMessagesWithContext returns [system, user(s)…]; spread the
    // universal preamble in front so the order is [universal…, skill
    // system, user…].
    const baseMsgs = buildMessagesWithContext(userText, opts.context, systemPrompt);
    return [...universalPreamble, ...baseMsgs];
  }

  return [
    ...universalPreamble,
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userText    },
  ];
}

/**
 * Execute a skill: parse SKILL.md, substitute vars, stream the response
 * through the provider chosen by `manifest.model` (or `opts.modelOverride`).
 *
 * The SKILL.md body becomes the user prompt. A system prompt is synthesized
 * from the skill name + description so the model has orientation. If
 * `opts.context` is passed, attachments (text + images) are included via
 * `buildMessagesWithContext`.
 */
export async function executeSkill(
  manifest: SkillManifest,
  args: string,
  onChunk: (delta: string, full: string) => void,
  opts: ExecuteSkillOpts = {},
): Promise<ExecuteSkillResult> {
  debug.log('skill.router', 'executeSkill', {
    skill: manifest.name,
    args: args.length > 120 ? args.slice(0, 120) + '…' : args,
    modelOverride: opts.modelOverride,
    manifestModel: manifest.model,
    hasContext: !!opts.context,
    autoLoad: !!opts.autoLoad,
  });
  const rawModelHint = opts.modelOverride || manifest.model;
  // Route through resolveDefaultProvider so user-config wins over env
  // vars. Previously getProvider(modelHint) — env-only — meant a user
  // with config.provider=openai-codex but XAI_API_KEY still in env
  // would see every skill fall back to Grok.
  const provider: LLMProvider = resolveDefaultProvider(rawModelHint);
  // If the skill's declared model belongs to a DIFFERENT provider
  // family than the one user-config resolved to, drop it. Example:
  // user has openai-codex configured but a skill's SKILL.md says
  // `model: grok-4-1-fast-reasoning`. Passing that through to the
  // OpenAI endpoint would 400. Stripping lets the Codex provider use
  // its own configured default model (e.g. gpt-5.4-mini).
  const modelHint = isModelCompatible(provider.name, rawModelHint) ? rawModelHint : undefined;

  if (opts.context && opts.autoLoad) {
    await loadAllAttachments(opts.context);
  }

  // Phase 9 degrade warning: the skill has loaded image attachments but the
  // resolved model isn't known to accept image inputs. Stream the warning
  // through `onChunk` so it lands in the same pane as the skill output
  // (rather than getting lost in stderr under the TUI).
  if (opts.context) {
    const imgCount = listAttachments(opts.context).filter(
      a => a.kind === 'image' && !!a.base64,
    ).length;
    const resolvedModel = modelHint || provider.defaultModel;
    if (imgCount > 0 && !isLikelyVisionModel(resolvedModel)) {
      const warn = `⚠ ${imgCount} image attachment(s) present but ${resolvedModel} is not known to accept images — they will be ignored by the model.\n\n`;
      onChunk(warn, warn);
    }
  }

  const activeModelId = modelHint || provider.defaultModel;
  {
    const promptCfg = getUserConfig().chat.systemPrompt;
    const variantInfo = resolveChatSystemPrompt({
      model: activeModelId,
      config: promptCfg,
    });
    const modelAddon = getModelPromptAddon(activeModelId);
    // 2026-07-24 — `chat.system-prompt.resolve`(registry.ts) 를 삭제하면서 그쪽에만
    // 있던 증분 필드(overridePath / forcedVariant)를 여기로 흡수. 그 로그는 1Hz HUD
    // 티커에 물려 매초 발화하는데 소비처가 0건이었다(TIMELINE_CATEGORIES 미포함·
    // 레포 grep 0건). 턴 경로 관측은 이 한 지점으로 충분하다.
    debug.log('chat.presentation.system-prompt.variant', 'skill', {
      model: activeModelId,
      source: variantInfo.source,
      variant: variantInfo.variant,
      skill: manifest.name,
      addonApplied: !!modelAddon,
      ...(promptCfg.overridePath ? { overridePath: promptCfg.overridePath } : {}),
      ...(promptCfg.forceBuiltinVariant ? { forcedVariant: promptCfg.forceBuiltinVariant } : {}),
    });
  }
  debug.log('skill.router', 'model-prompt-addon', {
    model: activeModelId,
    family: getModelFamily(activeModelId),
  });
  const promptBankCfg = getUserConfig().dashboard.promptBank;
  const promptBankContext = promptBankCfg.enabled && promptBankCfg.skillRuns
    ? renderPromptInjectionForSystemAddendum(buildPromptInjection({
        store: getPromptBankStore(),
        state: {
          activeView: 'skill',
          focusedPane: 'log',
          visiblePanes: ['log'],
          activePlugins: [],
          loadedSkills: [manifest.name],
          loadedWorkflows: [],
          onlineResources: [],
          intents: ['skill', manifest.name],
          modelFamily: getModelFamily(activeModelId),
          tags: manifest.category ? [manifest.category] : [],
        },
        options: {
          model: activeModelId,
          budgetTokens: promptBankCfg.budgetTokens,
          limit: promptBankCfg.limit,
          record: promptBankCfg.record,
          turnId: `skill:${manifest.name}:${Date.now()}`,
          metadata: {
            source: 'skill-runner',
            skill: manifest.name,
            category: manifest.category,
          },
        },
      }))
    : '';
  const messages = buildSkillMessages(manifest, args, {
    systemContext: opts.systemContext,
    context: opts.context,
    modelId: activeModelId,
    priorConversation: opts.priorConversation,
    promptBankContext,
  });

  // PFC-S1 P2: drain pending background task-notifications and inject
  // a <task-notification> user message right after the system prompt.
  // Parents that fired `Agent(..., run_in_background: true)` last turn
  // see the completion XML here — one injection per turn-kickoff.
  // Sidebar badge / NotificationStore wiring is dashboard's concern
  // (subscribes to globalAgentRegistry.onTaskDone independently).
  {
    const { globalTaskNotificationQueue, renderTaskNotificationsXml } =
      await import('../agent/task-notification.js');
    const pending = globalTaskNotificationQueue.drain();
    if (pending.length > 0) {
      const xml = renderTaskNotificationsXml(pending);
      // Insert AFTER the system prompt so the model sees it as context
      // before reading its actual user prompt. messages[0] is system
      // by buildSkillMessages contract.
      const insertAt = messages.length > 0 && messages[0]!.role === 'system' ? 1 : 0;
      messages.splice(insertAt, 0, { role: 'user', content: xml });
    }
  }

  // PX-3 P5: Turn-hook dispatch wired below (after pushDisplay is defined).

  // Phase-5 Bash bridge: route through the tool loop so skills that
  // document `npx tsx ...` / `python3 ...` / `node ...` actually
  // execute instead of getting role-played by the LLM. We thread bash
  // tool_call + tool_result events into the same `onChunk` stream the
  // dashboard reads, so the user sees `$ command` lines and their
  // captured output inline with the model's narration.
  let display = '';
  const pushDisplay = (chunk: string) => {
    display += chunk;
    onChunk(chunk, display);
  };
  const foldRenderOpts = skillFoldRenderOpts(opts.foldMode, opts.expandHint);

  // PFC-S3.1 follow-up: Andon preamble auto-prepend. When any CRITICAL
  // escalation is pending, `buildAndonPreamble()` returns a banner that
  // must appear before ANY plugin-hook injects so the LLM sees "stop
  // the line" at the very top of the system prompt.
  {
    const { buildAndonPreamble } = await import('../cft/andon.js');
    const preamble = buildAndonPreamble();
    if (preamble && messages[0]?.role === 'system') {
      const base = typeof messages[0].content === 'string' ? messages[0].content : '';
      messages[0] = { role: 'system', content: `${preamble}\n\n${base}` };
    }
  }

  // PX-3 P5: Turn hook — zero cost when no hooks registered. Aborted
  // turns short-circuit by returning a stub display message.
  {
    const { globalHookDispatcher } = await import('../plugin-hooks/dispatcher.js');
    // core-hooks-bootstrap: idempotent registration of core Turn hooks
    // (Andon / Route / Mission). Safe to call every turn.
    const { bootstrapCoreHooks } = await import('../plugin-hooks/bootstrap.js');
    bootstrapCoreHooks();
    if (globalHookDispatcher.list('Turn').length > 0) {
      const systemText = (messages[0]?.role === 'system' ? messages[0].content : '') as string;
      const outcome = await globalHookDispatcher.dispatch('Turn', {
        turnNumber: 1,
        messages: [...messages],
        systemPrompt: typeof systemText === 'string' ? systemText : '',
        tools: [],
      });
      if (outcome.abort) {
        pushDisplay(`\n(turn aborted by hook: ${outcome.abort.reason})\n`);
        return {
          provider: provider.name,
          model: modelHint || provider.defaultModel,
          fullResponse: display,
        };
      }
      if (outcome.output.systemPromptInject && messages[0]?.role === 'system') {
        const base = typeof messages[0].content === 'string' ? messages[0].content : '';
        messages[0] = { role: 'system', content: `${base}\n\n${outcome.output.systemPromptInject}` };
      }
      if (outcome.output.messagesPrepend && outcome.output.messagesPrepend.length > 0) {
        const insertAt = messages[0]?.role === 'system' ? 1 : 0;
        messages.splice(insertAt, 0, ...outcome.output.messagesPrepend);
      }
    }
  }

  // Host tool roster — built once so the same array (with the same
  // closure-captured implementations) is what the parent LLM sees AND
  // what gets handed to sub-agents. Sub-agents inherit Bash/Read/Edit/
  // Grep/WebFetch via dispatchAgent, which strips Agent itself from
  // the child list to prevent runaway recursion.
  const hostTools = [
    buildBashTool(),
    buildReadTool(),
    buildEditTool(),
    buildWriteTool(),
    buildGrepTool(),
    buildGlobTool(),
    buildListDirTool(),
    buildAstGrepTool(),
    // L3 — 내부 문서 `ROADMAP-lsp-integration`. Skill runs now see `Lsp`
    // alongside the text + path tools so structural / symbol queries
    // (who calls X, where is Y defined, workspace symbol search) stop
    // bouncing off Grep's regex approximations.
    buildLspTool(),
    buildWebFetchTool(),
    buildWebSearchTool(),
    buildAgentTool(),
    // P6: meta-tool for the LLM to steer subsequent tool selection.
    // Gate-filtered in the discipline prompt so T3 models aren't
    // nudged to use it; always callable (safe no-op on any model).
    buildSetToolHintTool(),
    // P8: mermaid → TUI diagram renderer (probe-gated, hides when
    // `mermaidtui` not installed).
    buildMermaidRenderTool(),
    // T3-A2: Mermaid syntax reference — companion to MermaidRender.
    // Returns a known-good template + parser gotchas per diagram kind.
    buildMermaidSyntaxTool(),
    // T3-A1: YouTube transcript via Supadata (probe-gated on
    // SUPADATA_API_KEY). Native fast path — full digest pipeline
    // stays with the youtube-master skill.
    buildYoutubeTranscriptTool(),
    // T6-K3: queue a dashboard slash from control mode.
    buildDashboardSlashExecuteTool(),
    // T6-K4: read/write curated dashboard config keys.
    buildDashboardConfigGetTool(),
    buildDashboardConfigSetTool(),
    // T6-K5: widget + pane control.
    buildDashboardWidgetListTool(),
    buildDashboardWidgetToggleTool(),
    buildDashboardPaneFocusTool(),
    // Phase 4a: widget inspector surface — snapshot / describe /
    // call for LLM widget control.
    buildWidgetSnapshotTool(),
    buildWidgetDescribeTool(),
    buildWidgetCallTool(),
    // HT1/HT2: view switch + widget key-event injection.
    buildDashboardViewSwitchTool(),
    buildDashboardWidgetInvokeTool(),
    // P9: generic HTTP JSON tool — allowlist + rate-limit gated.
    buildApiCallTool(),
    // P10: parallel multi-provider search (skill-essence extraction
    // of omni-crawl). Wider than WebSearch; same provider registry.
    buildOmniSearchTool(),
    // P11: single-symbol price quote (skill-essence extraction
    // of omni-market). Probe-gated on EODHD/FDS keys.
    buildMarketQuoteTool(),
    // P12: Korean investor-flow snapshot (skill-essence extraction
    // of kr-flow). Probe-gated on KIS_APP_KEY+SECRET.
    buildKrFlowTool(),
    // P14: PTY shell family — codex unified_exec inspired. 4 tools
    // for long-running interactive processes. Probe-gated on
    // node-pty installability.
    buildPtyShellStartTool(),
    buildPtyShellPollTool(),
    buildPtyShellSendTool(),
    buildPtyShellKillTool(),
    buildPtyShellListTool(),
    // NT-C1b-2 (session nt): shell-runner auxiliary tools.
    buildShellListTool(),
    buildShellPollTool(),
    buildShellKillTool(),
    // P12: terminal modal context exchange — list/observe/focus/
    // detach/kill sessions from the TerminalSessionRegistry.
    // NT-C3 (session nt): Spawn tool removed; use RunShell mode='vw'.
    buildTerminalModalListTool(),
    buildTerminalModalObserveTool(),
    buildTerminalModalFocusTool(),
    buildTerminalModalDetachTool(),
    buildTerminalModalKillTool(),
    buildTerminalModalInjectTool(),
    // H5 P2 · embodied-agent TTY observability tools.
    buildSnapshotPtyStateTool(),
    buildListPtySnapshotsTool(),
    buildComparePtySnapshotsTool(),
    // H5 P3 · cross-agent handoff (snapshot + channel filter → new session).
    buildAgentHandoffTool(),
    // H6 P1 · multi-agent budget tracker (4 tools · T1 · read-only
    // except BudgetSetLimit which writes ~/.config/elanous/budget/limits.json).
    buildBudgetStatusTool(),
    buildBudgetHistoryTool(),
    buildBudgetForecastTool(),
    buildBudgetSetLimitTool(),
    // H6 P3 · Budget-aware policy router (Bundle 1 · recommend-only).
    // `PolicyDecide` returns a decision + alternatives; `PolicyExplain`
    // returns the rule-by-rule trace behind it. (Name avoids collision
    // with PFC-S5 intelligence-map's `RouteToModel` · see
    // `src/intelligence-map/tools/route-to-model.ts`.)
    buildPolicyDecideTool(),
    buildPolicyExplainTool(),
    // H6 P4 · VW agent-room (Bundle 1). Compose creates an N-pane VW
    // with one agent per pane; List + Close round out the lifecycle.
    buildAgentRoomComposeTool(),
    buildAgentRoomListTool(),
    buildAgentRoomCloseTool(),
    // H6 P5 · AgentReply (Bundle 1). Send + capture message to a live
    // embodied session · complements AgentHandoff.
    buildAgentReplyTool(),
    // H6 P6 · Capture source registry (Bundle 1). Discovery + dispatch
    // on top of existing capture infrastructure.
    buildListCaptureSourcesTool(),
    buildSnapshotSourceTool(),
    // H6 P7 · InjectCaptureToContext (Bundle 1). HITL-gated pipe from
    // P6 registry snapshot → target embodied session send() with 3
    // wrapping modes · edge kind 'inject' + control-audit log.
    buildInjectCaptureToContextTool(),
    // Showroom v2 (2026-04-28) · LaneHandoff. Cross-lane handoff inside
    // the most recent showroom — wraps /handoff, reuses HITL approver,
    // adds lane-aware audit detail.
    buildLaneHandoffTool(),
    // H6 P2 · Local LLM Manager (Bundle 1 + 2 B). Read-only inventory
    // of Tailscale fleet + LM Studio/Ollama model weights · feeds
    // `local-llm:<node>:<model>` routing + /acp-vw lll embodied
    // sessions. LlmRequestInstall (Bundle 2 B) is the HITL-gated
    // download tool.
    buildLlmListNodesTool(),
    buildLlmListAvailableModelsTool(),
    buildLlmRequestInstallTool(),
    // BI-P5: browser + iPhone + HITL confirm
    ...buildBrowserSessionTools(),
    buildIPhoneNotifyTool(),
    buildIPhoneOpenUrlTool(),
    buildIPhoneAgentResultTool(),
    buildIPhoneConfirmTool(),
    buildHitlConfirmTool(),
  ];

  // Archon-port T1.1 (2026-05-08) — apply manifest's allow/deny policy
  // BEFORE the LLM call, so the parent LLM AND any dispatched sub-agents
  // (which inherit `hostTools` via dispatchAgent → runner.ts:1642) see
  // the same filtered roster. `applyToolPolicy` is a no-op when both
  // allowed/deniedTools are absent — preserves existing behavior for
  // every skill that doesn't declare a policy.
  const filteredHostTools = applyToolPolicy(hostTools, {
    allow: manifest.allowedTools,
    deny: manifest.deniedTools,
  }) ?? hostTools;

  // Phase F5: background-agent batch state. When the parent LLM
  // fires ≥2 Agent calls in one turn, streamLLMWithTools switches to
  // Promise.all dispatch. We track "batch mode" here so we can:
  //   • skip inline `⏺ Agent(desc)` + `⎿ Prompt` for each call
  //     (already summarised in the launch banner's tree)
  //   • null out onChildToolCall so 5 concurrent Bash rows don't
  //     interleave chaotically in the pane
  //   • buffer Response + Done render until the individual agent's
  //     promise resolves (rendered inside onAgentComplete in
  //     completion order, not call order)
  type AgentSummary = { toolCount: number; durationMs: number; outputChars: number; promptChars: number };
  const batchState = {
    active: false,
    // callId → buffered card data, picked up in onAgentComplete.
    cards: new Map<string, {
      description: string;
      subagentType: string;
      output: string;
      summary: AgentSummary | null;
    }>(),
    // Phase F5 iter: original call-order descriptions, used to name
    // still-in-flight siblings on completion toasts and to resolve the
    // runningDescriptions list the tick handler reports.
    callOrder: [] as Array<{ id: string; description: string }>,
    completedIds: new Set<string>(),
    // Phase F5 iter: aggregate stats surfaced in the bg-batch-summary
    // closer. Accumulated as each agent's onDone summary arrives.
    aggregateToolCount: 0,
    aggregateTokens: 0,
  };

  // Per-execution dedup cache — passed to dispatchRead and
  // dispatchAgent so the same (file, offset, limit) or same
  // (agent description, prompt) gets a stub on repeat. Cleared
  // implicitly when this execution returns. Shared between the
  // parent skill loop AND every sub-agent it spawns, so a child
  // can't re-fetch what its parent already pulled.
  const sessionCache = new SessionCache();

  // ── Catalog-aware uniform dispatch table ──
  // Every tool whose dispatcher returns `{ output: string, ...meta }`
  // lives in this table instead of a dedicated if-branch. New Tier S
  // tools (Glob / ListDir / Write) were adding one if per tool to
  // dispatchHostTool; now they register here and the switch shrinks
  // to three branches: Bash (custom context), Agent (batch lifecycle),
  // table-lookup (the common path). Keys match the LLM-facing
  // displayName used in buildXTool() specs so the catalog's promptSummary
  // and this table can never drift out of sync silently — adding a
  // tool with a name that isn't in the catalog fails the
  // native-tool-catalog test. Adding a tool that doesn't map to a
  // dispatcher here simply falls through to the "tool not available"
  // error, preserving the existing contract.
  type UniformCtx = {
    sessionCache: SessionCache;
    signal: AbortSignal | undefined;
  };
  type UniformDispatcher = (
    args: Record<string, unknown>,
    ctx: UniformCtx,
  ) => Promise<{ output: string }>;
  const uniformDispatchers: Record<string, UniformDispatcher> = {
    Read:     (a, c) => dispatchRead(a, { sessionCache: c.sessionCache }),
    Edit:     (a)    => dispatchEdit(a),
    Write:    (a)    => dispatchWrite(a),
    Grep:     (a)    => dispatchGrep(a),
    Glob:     (a)    => dispatchGlob(a),
    ListDir:  (a)    => dispatchListDir(a),
    AstGrep:  (a)    => dispatchAstGrep(a),
    // dispatchLsp returns { output, operation, numResults, truncated };
    // uniformDispatcher only needs { output }.
    Lsp:      async (a) => ({ output: (await dispatchLsp(a)).output }),
    WebFetch: (a, c) => dispatchWebFetch(a, { signal: c.signal }),
    WebSearch: (a, c) => dispatchWebSearch(a, { signal: c.signal }),
    SetToolHint: (a) => dispatchSetToolHint(a),
    MermaidRender: async (a) => {
      const r = await dispatchMermaidRender(a);
      return { output: r.output };
    },
    MermaidSyntax: async (a) => {
      const r = await dispatchMermaidSyntax(a);
      return { output: r.output };
    },
    YoutubeTranscript: async (a) => {
      const r = await dispatchYoutubeTranscript(a);
      return { output: r.output };
    },
    DashboardSlashExecute: async (a) => {
      const r = await dispatchDashboardSlashExecute(a);
      return { output: r.output };
    },
    DashboardConfigGet: async (a) => {
      const r = await dispatchDashboardConfigGet(a);
      return { output: r.output };
    },
    DashboardConfigSet: async (a) => {
      const r = await dispatchDashboardConfigSet(a);
      return { output: r.output };
    },
    DashboardWidgetList: async (a) => {
      const r = await dispatchDashboardWidgetList(a);
      return { output: r.output };
    },
    DashboardWidgetToggle: async (a) => {
      const r = await dispatchDashboardWidgetToggle(a);
      return { output: r.output };
    },
    DashboardPaneFocus: async (a) => {
      const r = await dispatchDashboardPaneFocus(a);
      return { output: r.output };
    },
    DashboardWidgetSnapshot: async (a) => {
      const r = await dispatchWidgetSnapshot(a);
      return { output: r.output };
    },
    DashboardWidgetDescribe: async (a) => {
      const r = await dispatchWidgetDescribe(a);
      return { output: r.output };
    },
    DashboardWidgetCall: async (a) => {
      const r = await dispatchWidgetCall(a);
      return { output: r.output };
    },
    DashboardViewSwitch: async (a) => {
      const r = await dispatchDashboardViewSwitch(a);
      return { output: r.output };
    },
    DashboardWidgetInvoke: async (a) => {
      const r = await dispatchDashboardWidgetInvoke(a);
      return { output: r.output };
    },
    ApiCall: async (a) => {
      const r = await dispatchApiCall(a);
      return { output: r.output };
    },
    OmniSearch: async (a, c) => {
      const r = await dispatchOmniSearch(a);
      return { output: r.output };
    },
    MarketQuote: async (a) => {
      const r = await dispatchMarketQuote(a);
      return { output: r.output };
    },
    KrFlowSnapshot: async (a) => {
      const r = await dispatchKrFlow(a);
      return { output: r.output };
    },
    PtyShellStart: (a) => dispatchPtyShellStart(a),
    PtyShellPoll:  (a) => dispatchPtyShellPoll(a),
    PtyShellSend:  (a) => dispatchPtyShellSend(a),
    PtyShellKill:  (a) => dispatchPtyShellKill(a),
    PtyShellList:  async () => dispatchPtyShellList(),
    // NT-C1b-2 — shell-runner LLM tools.
    ShellList:     async (a) => dispatchShellList(a, getShellRegistry()),
    ShellPoll:     async (a) => dispatchShellPoll(a, getShellRegistry()),
    ShellKill:     (a) => dispatchShellKill(a, getShellRegistry()),
    TerminalModalList:    (a) => dispatchTerminalModalList(a),
    TerminalModalObserve: (a) => dispatchTerminalModalObserve(a),
    TerminalModalFocus:   (a) => dispatchTerminalModalFocus(a),
    TerminalModalDetach:  (a) => dispatchTerminalModalDetach(a),
    TerminalModalKill:    (a) => dispatchTerminalModalKill(a),
    TerminalModalInject:  (a) => dispatchTerminalModalInject(a, { approver: createInjectApprover() }),
    // H5 P2 · embodied-agent TTY observability.
    SnapshotPtyState:     (a) => dispatchSnapshotPtyState(a),
    ListPtySnapshots:     (a) => dispatchListPtySnapshots(a),
    ComparePtySnapshots:  (a) => dispatchComparePtySnapshots(a),
    // H5 P3 · cross-agent handoff.
    AgentHandoff:         (a) => dispatchAgentHandoff(a),
    // H6 P1 · budget tracker LLM tools.
    BudgetStatus:    async (a) => {
      const r = await dispatchBudgetStatus(a);
      return { output: r.output };
    },
    BudgetHistory:   async (a) => {
      const r = await dispatchBudgetHistory(a);
      return { output: r.output };
    },
    BudgetForecast:  async (a) => {
      const r = await dispatchBudgetForecast(a);
      return { output: r.output };
    },
    BudgetSetLimit:  async (a) => {
      const r = await dispatchBudgetSetLimit(a);
      return { output: r.output };
    },
    // H6 P3 · policy router LLM tools.
    PolicyDecide:    async (a) => {
      const r = await dispatchPolicyDecide(a);
      return { output: r.output };
    },
    PolicyExplain:   async (a) => {
      const r = await dispatchPolicyExplain(a);
      return { output: r.output };
    },
    // H6 P4 · agent-room LLM tools.
    AgentRoomCompose: async (a) => {
      const r = await dispatchAgentRoomCompose(a);
      return { output: r.output };
    },
    AgentRoomList:    async (a) => {
      const r = await dispatchAgentRoomList(a);
      return { output: r.output };
    },
    AgentRoomClose:   async (a) => {
      const r = await dispatchAgentRoomClose(a);
      return { output: r.output };
    },
    // H6 P5 · AgentReply LLM tool.
    AgentReply:       async (a) => {
      const r = await dispatchAgentReply(a);
      return { output: r.output };
    },
    // H6 P6 · capture source registry LLM tools.
    ListCaptureSources: async (a) => {
      const r = await dispatchListCaptureSources(a);
      return { output: r.output };
    },
    SnapshotSource: async (a) => {
      const r = await dispatchSnapshotSource(a);
      return { output: r.output };
    },
    // H6 P7 · InjectCaptureToContext LLM tool.
    InjectCaptureToContext: async (a) => {
      const r = await dispatchInjectCaptureToContext(a);
      return { output: r.output };
    },
    // Showroom v2 · LaneHandoff LLM tool (cross-lane context inject).
    LaneHandoff: async (a) => {
      const r = await dispatchLaneHandoff(a);
      return { output: r.output };
    },
    // H6 P2 · Local LLM Manager LLM tools (Bundle 1 + 2 B).
    LlmListNodes: async (a) => {
      const r = await dispatchLlmListNodes(a);
      return { output: r.output };
    },
    LlmListAvailableModels: async (a) => {
      const r = await dispatchLlmListAvailableModels(a);
      return { output: r.output };
    },
    LlmRequestInstall: async (a) => {
      const r = await dispatchLlmRequestInstall(a);
      return { output: r.output };
    },
    ...browserSessionDispatchers,
    IPhoneNotify:        (a) => dispatchIPhoneNotify(a),
    IPhoneOpenUrl:       (a) => dispatchIPhoneOpenUrl(a),
    IPhoneAgentResult:   (a) => dispatchIPhoneAgentResult(a),
    IPhoneConfirm:       (a) => dispatchIPhoneConfirm(a),
    HitlConfirm:         (a) => dispatchHitlConfirm(a),
  };

  // P7: fire-and-forget auto-hint feedback. Called after each leaf
  // tool dispatch (Bash + uniform table) so transient failures —
  // timeouts, rate-limit messages, DNS errors — can steer the next
  // call without the LLM having to reason about low-level plumbing.
  // Capped at 3/turn inside feedback.ts; errors swallowed so a broken
  // rule never breaks the dispatch path.
  const fireFeedback = (tool: string, toolArgs: Record<string, unknown>, output: unknown, isError: boolean, durationMs: number): void => {
    try {
      applyHintFeedback({ tool, args: toolArgs, outputText: String(output), isError, durationMs });
    } catch (err) {
      debug.log('hint.auto', 'error', { tool, err: String(err instanceof Error ? err.message : err) }, { level: 'error' });
    }
  };

  // Single dispatcher used by both the parent skill loop and any
  // sub-agent the parent spawns via Agent. Defined as a named const
  // so the recursive Agent path can reference it without re-creating
  // the closure each call.
  const dispatchHostTool = async (
    name: string,
    toolArgs: Record<string, unknown>,
    ctx?: { callId: string },
  ): Promise<unknown> => {
    // PX-3 P5: ToolCall hook — modifyInput / deny before the actual
    // tool runs. Matcher is the tool name so handlers can scope to
    // specific tools (e.g. a BudgetGuard only on Bash + WebFetch).
    // Zero cost when no handlers registered.
    {
      const { globalHookDispatcher } = await import('../plugin-hooks/dispatcher.js');
      if (globalHookDispatcher.list('ToolCall').length > 0) {
        const outcome = await globalHookDispatcher.dispatch('ToolCall', {
          turnNumber: 1,
          toolName: name,
          input: toolArgs,
        }, { subject: name });
        if (outcome.abort) {
          return { error: `tool ${name} aborted by hook: ${outcome.abort.reason}` };
        }
        if (outcome.output.deny) {
          return { error: `tool ${name} denied by hook: ${outcome.output.deny.reason}` };
        }
        if (outcome.output.modifyInput !== undefined && typeof outcome.output.modifyInput === 'object' && outcome.output.modifyInput !== null) {
          toolArgs = outcome.output.modifyInput as Record<string, unknown>;
        }
      }
    }
    // Bash has its own context shape (cwd / shell / timeout) so it
    // stays out of the uniform table.
    if (name === 'Bash') {
      const started = Date.now();
      const r = await dispatchBash(toolArgs, {
        cwd: manifest.skillDir,
        shell: manifest.shell,
        defaultTimeoutMs: manifest.bashTimeoutMs,
        signal: opts.signal,
      });
      const persisted = await persistToolOutputPreview(r.output, {
        sessionId: String(process.pid),
        toolName: 'Bash',
        config: getUserConfig().chat.toolOutput,
        allowAgentReference: filteredHostTools.some(t => t.name === 'Agent'),
      });
      fireFeedback('Bash', toolArgs, persisted.output, false, Date.now() - started);
      return persisted.output;
    }
    // Uniform tools: read/edit/write/grep/glob/list-dir/ast-grep/webfetch.
    // Accept catalog aliases (e.g. "read_file" → "Read") via the
    // findNativeTool lookup so snake_case names from future MCP /
    // plugin callers don't bypass the table.
    const resolved = findNativeTool(name);
    const resolvedName = resolved?.displayName ?? name;
    const uniform = uniformDispatchers[resolvedName];
    if (uniform) {
      const started = Date.now();
      const result = await uniform(toolArgs, { sessionCache, signal: opts.signal });
      const persisted = await persistToolOutputPreview(result.output, {
        sessionId: String(process.pid),
        toolName: resolvedName,
        config: getUserConfig().chat.toolOutput,
        allowAgentReference: filteredHostTools.some(t => t.name === 'Agent'),
      });
      fireFeedback(resolvedName, toolArgs, persisted.output, false, Date.now() - started);
      return persisted.output;
    }
    // Agent stays special — batch lifecycle, onChildToolCall,
    // onDone summary, dedup cache, and several callback closures
    // attached to opts. Routing it through the uniform table would
    // require leaking all of that plumbing into UniformCtx; keep it
    // as a dedicated branch.
    if (name === 'Agent') {
      let capturedSummary: AgentSummary | null = null;
      const r = await dispatchAgent(toolArgs, {
        hostTools: filteredHostTools, // sub-agent inherits parent's filtered roster (T1.1)
        dispatchTool: dispatchHostTool, // recursive ref — OK because Agent strips itself
        signal: opts.signal,
        sessionCache,     // shared across parent + children — prevents cross-level duplicate spawns
        // Phase F5: suppress per-child rendering when multiple agents
        // run in parallel — otherwise 5 concurrent Bash rows interleave
        // under a single ⏺ Agent header. In single-agent mode the
        // callback fires as before.
        onChildToolCall: batchState.active ? undefined : (ev) => {
          const entry: LogEntry = {
            kind: 'agent-child',
            variant: 'tool',
            label: ev.name,
            summary: summarizeToolCall(ev.name, ev.args),
          };
          pushDisplay(`${renderLogEntryAsString(entry)}\n`);
        },
        onDone: (summary) => { capturedSummary = summary; },
      });

      // Phase F5: in batch mode, stash the card data and let
      // onAgentComplete (fired by streamLLMWithTools when THIS
      // agent's promise resolves) handle the Response + Done render
      // alongside the completion toast. Keyed by callId so parallel
      // completions can't race.
      if (batchState.active && ctx?.callId) {
        batchState.cards.set(ctx.callId, {
          description: String((toolArgs as any)?.description ?? ''),
          subagentType: String((toolArgs as any)?.subagent_type ?? 'general-purpose'),
          output: r.output,
          summary: capturedSummary,
        });
        return r.output;
      }

      // Single-agent path (F1c + F2): deterministic ordering —
      //   ⏺ Agent(desc) / ⎿ Prompt  (already pushed by onToolCall)
      //   ⎿ Bash(...)               (streamed from onChildToolCall)
      //   ⎿ Response: …body…        (here, after dispatchAgent returns)
      //   ⎿ Done (stats)            (here; onToolResult skips Agent)
      const responseEntry: LogEntry = {
        kind: 'agent-child-block',
        variant: 'response',
        label: 'Response',
        body: r.output,
      };
      pushDisplay(`${renderLogEntry(responseEntry, foldRenderOpts).join('\n')}\n`);
      opts.onFoldableEntry?.(responseEntry, foldRenderOpts);

      if (capturedSummary) {
        const doneEntry: LogEntry = {
          kind: 'agent-child',
          variant: 'done',
          label: 'Done',
          summary: formatAgentDone(capturedSummary),
        };
        pushDisplay(`${renderLogEntryAsString(doneEntry)}\n`);
      }

      return r.output;
    }
    return { error: `Tool '${name}' not available — exposed tools: ${filteredHostTools.map(t => t.name).join(', ')}.` };
  };

  const fullResponse = await streamLLMWithTools(
    messages,
    {
      onText: (delta) => pushDisplay(delta),
      onToolCall: (call) => {
        // Phase F5: when we're inside a parallel Agent batch, skip
        // the inline `⏺ Agent(desc)` header and `⎿ Prompt` block
        // for each individual call — the batch launch banner already
        // showed all N descriptions in a tree. The per-agent header
        // will be re-rendered alongside its Response/Done block by
        // onAgentComplete, in completion order.
        if (call.name === 'Agent' && batchState.active) return;

        const a = call.args as Record<string, unknown>;
        const entry: LogEntry = call.name === 'Agent'
          ? {
              kind: 'agent-start',
              description: String(a.description ?? '').trim(),
              subagentType: String(a.subagent_type ?? 'general-purpose'),
            }
          : {
              kind: 'tool-header',
              toolName: call.name,
              summary: summarizeToolCall(call.name, a),
            };
        pushDisplay(`\n\n${renderLogEntryAsString(entry)}\n`);

        // Phase F2a: for Agent calls, follow the header with a
        // `⎿ Prompt:` block previewing the instructions the parent
        // LLM handed to the sub-agent. Truncated to the default max
        // lines so a 3000-char prompt doesn't flood the pane. The
        // full prompt is still in the sub-agent's history.
        if (call.name === 'Agent') {
          const prompt = String(a.prompt ?? '').trim();
          if (prompt) {
            const promptEntry: LogEntry = {
              kind: 'agent-child-block',
              variant: 'prompt',
              label: 'Prompt',
              body: prompt,
            };
            pushDisplay(`${renderLogEntry(promptEntry, foldRenderOpts).join('\n')}\n`);
            opts.onFoldableEntry?.(promptEntry, foldRenderOpts);
          }
        }
      },
      onToolResult: ({ name, result }) => {
        // Agent writes its own `⎿ Response:` block + `⎿ Done` line in
        // the dispatchHostTool path (so ordering is correct with
        // relation to child tool calls and Done summary). Skip the
        // default body-dump here to avoid duplicating the sub-agent's
        // text in the pane.
        if (name === 'Agent') return;
        const text = typeof result === 'string'
          ? result
          : (result && typeof (result as any).output === 'string')
            ? (result as any).output
            : JSON.stringify(result);
        // Route through the tool-body renderer so a multi-thousand-line
        // Read (60KB personas.json in the sto-multi-agent skill trace)
        // doesn't flood the pane — it truncates past TOOL_BODY_MAX_LINES
        // with a "N more lines — full content in model history" marker.
        // The full text is still in `result` → tool_result block → LLM
        // history, so the parent can see every byte it needs.
        const bodyEntry: LogEntry = { kind: 'tool-body', text };
        const bodyLines = renderLogEntry(bodyEntry, foldRenderOpts);
        if (bodyLines.length > 0) pushDisplay(`${bodyLines.join('\n')}\n`);
        // Register for post-run fold if the output was long enough
        // to truncate — lets the user hit `f` to reveal the rest
        // without re-running the tool. The dashboard content-matches
        // the first line to locate the block in chatLines.
        opts.onFoldableEntry?.(bodyEntry, foldRenderOpts);
      },
      onTurnEnd: (info) => { opts.onTurn?.(info); },
      // Phase F5: background-agent batch lifecycle. onAgentBatchStart
      // fires BEFORE the Promise.all dispatch — we flip batch mode on
      // and render the launch banner with the tree of descriptions.
      // onAgentComplete fires per agent as each promise resolves (in
      // completion order); we emit the completion toast + bake line,
      // then render THAT agent's buffered card (⏺ Agent header →
      // Response → Done). onAgentBatchEnd clears batch state.
      onAgentBatchStart: (calls) => {
        batchState.active = true;
        batchState.cards.clear();
        batchState.completedIds.clear();
        batchState.aggregateToolCount = 0;
        batchState.aggregateTokens = 0;
        batchState.callOrder = calls.map(c => ({
          id: c.id,
          description: String((c.args as any)?.description ?? '').trim() || '(no description)',
        }));
        const entry: LogEntry = {
          kind: 'bg-batch-launch',
          descriptions: batchState.callOrder.map(x => x.description),
        };
        const launchRenderOpts = foldRenderOpts;
        pushDisplay(`\n\n${renderLogEntry(entry, launchRenderOpts).join('\n')}\n`);
        // Register the batch-launch as a foldable entry so the host
        // (dashboard) can attach a FoldStack target once the run is
        // done and chatLines has its final shape. Skipped for small
        // batches — no hidden items means nothing to unfold.
        opts.onFoldableEntry?.(entry, launchRenderOpts);
        opts.onAgentBatchStatus?.({
          phase: 'start',
          batchElapsedMs: 0,
          total: calls.length,
          done: 0,
          remaining: calls.length,
          runningDescriptions: batchState.callOrder.map(x => x.description),
        });
      },
      onAgentComplete: ({ id, description, elapsedMs, remaining, batchElapsedMs }) => {
        batchState.completedIds.add(id);
        const runningDescriptions = batchState.callOrder
          .filter(x => !batchState.completedIds.has(x.id))
          .map(x => x.description);
        opts.onAgentBatchStatus?.({
          phase: 'complete',
          batchElapsedMs,
          total: batchState.callOrder.length,
          done: batchState.completedIds.size,
          remaining,
          runningDescriptions,
          completedDescription: description || '(no description)',
        });

        const toast: LogEntry = {
          kind: 'bg-agent-complete',
          description: description || '(no description)',
          elapsedMs,
          remaining,
          batchElapsedMs,
          runningDescriptions,
        };
        pushDisplay(`\n${renderLogEntry(toast).join('\n')}\n`);

        // Flush this agent's buffered card underneath the toast.
        const card = batchState.cards.get(id);
        if (!card) return;
        batchState.cards.delete(id);

        // Accumulate aggregate stats for the batch summary closer.
        if (card.summary) {
          batchState.aggregateToolCount += card.summary.toolCount;
          batchState.aggregateTokens +=
            Math.ceil((card.summary.outputChars + card.summary.promptChars) / 4);
        }

        // Re-emit the ⏺ Agent(desc) header — dropped in onToolCall
        // during batch — so the Response/Done block has its own
        // context even when scrolled past the launch banner.
        const headerEntry: LogEntry = {
          kind: 'agent-start',
          description: card.description,
          subagentType: card.subagentType,
        };
        pushDisplay(`${renderLogEntryAsString(headerEntry)}\n`);

        const responseEntry: LogEntry = {
          kind: 'agent-child-block',
          variant: 'response',
          label: 'Response',
          body: card.output,
        };
        pushDisplay(`${renderLogEntry(responseEntry, foldRenderOpts).join('\n')}\n`);
        opts.onFoldableEntry?.(responseEntry, foldRenderOpts);

        if (card.summary) {
          const doneEntry: LogEntry = {
            kind: 'agent-child',
            variant: 'done',
            label: 'Done',
            summary: formatAgentDone(card.summary),
          };
          pushDisplay(`${renderLogEntryAsString(doneEntry)}\n`);
        }
      },
      onAgentBatchEnd: ({ totalCount, batchElapsedMs }) => {
        // Close with a one-line aggregate summary so the user sees the
        // total effort at a glance without summing individual Dones.
        const summary: LogEntry = {
          kind: 'bg-batch-summary',
          totalCount,
          batchElapsedMs,
          totalToolCount: batchState.aggregateToolCount,
          totalTokens: batchState.aggregateTokens,
        };
        pushDisplay(`\n${renderLogEntry(summary).join('\n')}\n`);
        opts.onAgentBatchStatus?.({
          phase: 'end',
          batchElapsedMs,
          total: totalCount,
          done: totalCount,
          remaining: 0,
          runningDescriptions: [],
        });

        batchState.active = false;
        batchState.cards.clear();
        batchState.callOrder = [];
        batchState.completedIds.clear();
        batchState.aggregateToolCount = 0;
        batchState.aggregateTokens = 0;
      },
      onAgentBatchTick: (info) => {
        debug.log('agent.batch', 'tick', {
          batchElapsedMs: info.batchElapsedMs,
          total: info.total,
          done: info.done,
          remaining: info.remaining,
          running: info.runningDescriptions,
        });
        opts.onAgentBatchStatus?.({ phase: 'tick', ...info });
      },
      dispatchTool: dispatchHostTool,
    },
    {
      provider,
      model: modelHint || provider.defaultModel,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens ?? 4096,
      signal: opts.signal,
      tools: filteredHostTools,
      // Multi-phase skills (especially those that fan out via Agent)
      // need much more than the 6-turn chat default. 20 covers a
      // typical orchestrator flow: setup → fan out N agents → collect
      // → aggregate → respond, with slack for retries.
      maxTurns: opts.maxTurns ?? 20,
    },
  );

  // PX-3 P5: Message hook — fires after the LLM's final assistant
  // text settles. Lets plugins append follow-up messages or route
  // the response. Zero cost when no handlers registered.
  {
    const { globalHookDispatcher } = await import('../plugin-hooks/dispatcher.js');
    if (globalHookDispatcher.list('Message').length > 0) {
      await globalHookDispatcher.dispatch('Message', {
        turnNumber: 1,
        role: 'assistant',
        content: typeof fullResponse === 'string' ? fullResponse : '',
      });
      // followupMessages/redirectTo are ignored by the current
      // single-turn skill-runner path — PX-7 wires full multi-turn
      // handling into the chat loop.
    }
  }

  // P7: turn-scoped hints are per-skill-run from the tool-hints
  // layer's perspective. Clearing turn hints + resetting the
  // feedback-per-turn counter on skill exit prevents leakage across
  // distinct skill invocations. Session-scope hints survive.
  endHintTurn();
  resetFeedbackCounterOnTurnEnd();
  // P14: kill any PTYs the skill spawned without detach:true.
  // Detached PTYs survive (intentionally — long-running dev servers).
  killNonDetached();

  return {
    provider: provider.name,
    model: modelHint || provider.defaultModel,
    // streamLLMWithTools returns LLM text only; dashboard echo uses
    // `display` (text + bash IO) — but callers of executeSkill rarely
    // need the raw text so we keep the public contract stable.
    fullResponse: display || fullResponse,
  };
}

/**
 * Lightweight preview — parse manifest and report availability without running.
 * Useful for `/provider` / `/run-skill` command pickers.
 */
export function describeSkill(skillName: string): string {
  const m = parseSkillMd(skillName);
  if (!m) return `${skillName}: (SKILL.md not found)`;
  const desc = m.description.split('\n')[0]!.slice(0, 80);
  const model = m.model ? ` [${m.model}]` : '';
  return `${m.name}${model}: ${desc}`;
}
