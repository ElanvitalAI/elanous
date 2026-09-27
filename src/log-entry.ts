// ── Structured log entries (Phase F1) ──
//
// Until now tool activity in the chat pane was raw ANSI strings stitched
// together in skill-runner.ts: `$ cmd`, `[Read] path`, `[Agent ▸ sub]`.
// Flat, untyped, no room for threading/folding/Done summaries.
//
// LogEntry introduces a typed model borrowed from claude-code-fork's
// Agent/Tool card layout:
//
//   ⏺ Bash(python3 ...)         ← tool-header (flat, top-level)
//   ⏺ Agent(Data collector ...)  ← agent-start (opens a card)
//     ⎿ Prompt: ...             ← agent-prompt   (child of card)
//     ⎿ Bash(...)               ← agent-child    (child of card)
//     ⎿ Response: ...           ← agent-response (child of card)
//     ⎿ Done (2 tool uses · 26.2k tokens · 9s)  ← agent-done (closes card)
//
// Phase F1a ships the types + renderer for top-level tool/agent headers
// only. Child nesting (dispatchAgent child events → `⎿ Bash(...)`) and
// Done-line accounting (ProgressTracker) land in F1b / F1c.
//
// Why render to string[] (not a tree structure retained by the log
// pane): dashboard.ts already owns `chatLines: string[]` (283 call
// sites); a big-bang swap to a typed pane model is too risky to do in
// one pass. Keeping chatLines as string[] + rendering LogEntry → lines
// at push time lets us port the visual layer WITHOUT touching the pane
// data model. Fold/expand (Phase F4) will need a typed pane later; for
// now the strings carry ANSI styling only.

import { FIGURES } from './render.js';
import { C } from './tui.js';
import { agentColor } from './agent/color-map.js';
import { debug } from './debug/log.js';

// ── Glyphs ──
// Single source of truth so the renderer here and any future per-agent
// pane share the same visual language. `⏺` is the "tool invocation
// happened" marker (Claude orange). `⎿` is the "this row is nested
// under the one above" bracket (muted). Both already in render.ts
// FIGURES — we just alias them here for readability.
export const G = {
  CIRCLE:  FIGURES.BLACK_CIRCLE,   // ⏺
  BRACKET: FIGURES.RESULT_BRACKET, // ⎿
  TREE_MID:   '\u251C\u2500',       // ├─
  TREE_LAST:  '\u2514\u2500',       // └─
  SPARKLE: FIGURES.TEARDROP,        // ✻ (progress/idle marker)
} as const;

// ── Entry kinds ──
// Keep the union FLAT (not nested) — each entry renders independently
// to one or more lines. Parent/child relationships are expressed via
// indentation during render, not structural containment. This matches
// how chatLines works (flat list of lines).

export type LogEntry =
  // Generic passthrough — plain text / blank line / section header.
  | { kind: 'text';        text: string }
  | { kind: 'section';     label: string; color?: ChalkFn }
  // Top-level tool (Bash / Read / Edit / Grep / WebFetch) — no card,
  // just a `⏺ ToolName(summary)` header line. Body text (tool output)
  // is handled separately via tool-body entries.
  | { kind: 'tool-header'; toolName: string; summary: string }
  // Top-level tool result body — appears under its header (no glyph;
  // raw text). We keep this KIND-tagged for future filtering/folding
  // but render it the same as 'text' for now.
  | { kind: 'tool-body';   text: string; isError?: boolean }
  // Agent card header — `⏺ Agent(description)`. The description is
  // whatever the parent LLM passed; subagent_type is shown as a dim
  // tag in parens if non-default.
  | { kind: 'agent-start'; description: string; subagentType: string }
  // Agent card child (rendered indented with `⎿`). Used for inline
  // sub-agent activity: Prompt:, Bash(cmd), Response:, Done. The label
  // variant controls visual styling; summary is the tail text.
  | {
      kind:  'agent-child';
      variant: 'prompt' | 'tool' | 'response' | 'done' | 'note';
      label: string;   // e.g. "Prompt", "Bash", "Response", "Done"
      summary: string; // the tail (command, file path, token stats)
    }
  // Agent-child block: `⎿ Label:` header + multi-line indented body.
  // Strictly richer than the one-line `agent-child` variant — the
  // body is rendered under the header and truncated past
  // FOLD_LIMITS.BLOCK_BODY. Promoting this into a first-class kind
  // (in addition to the legacy renderAgentChildBlock helper) lets
  // the FoldStack pipeline treat it as any other foldable entry:
  // countFoldedItems, static fold registration, Infinity-expand on
  // toggle. Skill-runner can emit EITHER this kind OR call the old
  // helper — renderLogEntry routes the kind through the same
  // implementation so the output is byte-identical.
  | {
      kind: 'agent-child-block';
      variant: 'prompt' | 'response';
      label: string;
      body: string;
    }
  // Background-agent batch launch banner (Phase F5). Rendered when the
  // parent LLM fans out ≥2 Agent calls in a single turn — the first
  // line is `⏺ N background agents launched`, followed by a tree of
  // descriptions using ├─ / └─. Child tool activity is SUPPRESSED
  // during batch runs (5 agents interleaving Bash rows would be
  // chaotic); individual `⏺ Agent "desc" completed` toasts land via
  // the `bg-agent-complete` entry as each promise resolves.
  | {
      kind: 'bg-batch-launch';
      descriptions: string[];
    }
  // One-line completion toast for a backgrounded agent, followed
  // inline by that agent's Response + Done blocks in skill-runner.
  // Elapsed time shown as the per-agent run duration; remaining is
  // the count of sibling agents still running. Rendered once per
  // promise-resolution inside the batch.
  //
  // `runningDescriptions` (Phase F5 iter) — names of siblings still
  // in-flight. When provided the bake checkpoint reads
  //   `✻ Baked for 45s · 3 still running: Semi, Quant, Value`
  // giving the user visibility into WHO is still working rather than
  // just a count. Omitted → falls back to "N agents still running".
  | {
      kind: 'bg-agent-complete';
      description: string;
      elapsedMs: number;
      remaining: number;
      batchElapsedMs: number;
      runningDescriptions?: string[];
    }
  // One-line closer emitted after the last agent in a batch finishes
  // — an "✨ Panel complete: 5 agents · 1m 52s · aggregate 127 tool
  // uses · 8k tokens" terminal marker. Gives the user a clean total
  // without having to sum the individual Done lines. Aggregates are
  // computed by the caller from per-agent Done summaries.
  | {
      kind: 'bg-batch-summary';
      totalCount: number;
      batchElapsedMs: number;
      totalToolCount: number;
      totalTokens: number;
    };

type ChalkFn = (s: string) => string;

export type FoldMode = 'line' | 'task-unit' | 'kind-unit';

export interface RenderOpts {
  /** Maximum visible width for one-line summaries. Truncates with
   *  ellipsis. Defaults to 100 which is a safe terminal width. */
  maxSummaryWidth?: number;
  /** Leading indent for agent-child lines. Defaults to "  " (two
   *  spaces) which aligns the `⎿` under the character after `⏺`
   *  on the parent agent-start line. */
  childIndent?: string;
  /** Max body lines for multi-line entries (tool-body, agent-child
   *  block bodies). Overrides TOOL_BODY_MAX_LINES / block defaults. */
  maxLines?: number;
  /** Fold strategy for tool bodies. Default 'line' preserves the
   *  existing line-budget behavior; 'task-unit' hides multi-line tool
   *  bodies as one work unit while keeping the tool header visible.
   *  'kind-unit' is the adjacent same-kind coalescing mode; a single
   *  tool-body still renders with the line-budget (coalescing lives in
   *  the presentation path, not here). */
  foldMode?: FoldMode;
  /** Max background-agent descriptions to print before folding the
   *  launch tree. Defaults to 6; pass Infinity to show all. */
  maxBatchItems?: number;
  /** Apply a stable per-agent color (FNV-1a hash of the agent's
   *  description → AGENT_PALETTE_HEX) to agent names in the batch-
   *  launch tree and completion toast. Default true. Tests that
   *  assert on raw text content set it to false. */
  colorByAgent?: boolean;
  /** When true, foldHint appends the rich-mode "press f to expand"
   *  invitation. Omitted/false = count-only (essential/unknown).
   *  The essential dashboard passes false. */
  expandHint?: boolean;
}

const DEFAULT_SUMMARY_WIDTH = 100;
const DEFAULT_CHILD_INDENT  = '  ';

/** Single source of truth for every fold-related line budget in the
 *  log pane. Each constant has one job:
 *    TOOL_BODY    — cap on raw tool output lines (Read/Bash/Grep).
 *    BLOCK_BODY   — cap on agent-child prompt/response block bodies.
 *    BATCH_TREE   — cap on bg-batch-launch tree rows.
 *    FOOTER_NAMES — cap on running-agent names in the compact live
 *                   footer (formatAgentBatchStatus default).
 *  Kept together so raising/lowering the "fold aggressiveness" is a
 *  one-constant edit and so the user-facing hint text can be
 *  generated uniformly via `foldHint()`. */
export const FOLD_LIMITS = {
  TOOL_BODY:    8,
  BLOCK_BODY:   12,
  BATCH_TREE:   6,
  FOOTER_NAMES: 3,
} as const;

/** Back-compat re-export — TOOL_BODY_MAX_LINES has external call sites
 *  (tests, skill-runner) and is the one fold constant that's pretty
 *  stable. Point it at FOLD_LIMITS so we only edit in one place. */
export const TOOL_BODY_MAX_LINES = FOLD_LIMITS.TOOL_BODY;

/** Unified fold-sentinel text. Any fold point (tree, body, block)
 *  should use this so the user sees one consistent invitation
 *  instead of three different phrasings. Returns just the text
 *  content — the caller is responsible for styling (typically
 *  `C.muted`) and indent glyphs.
 *
 *  The "press f to expand" suffix is opt-in: only a caller that
 *  knows the key is reachable (rich log-pane focus) should pass
 *  `{ expandHint: true }`. Omitted/false keeps the folded count
 *  and drops the unreachable-key instruction. */
export function foldHint(
  noun: 'line' | 'agent' | 'item',
  hidden: number,
  opts: { expandHint?: boolean } = {},
): string {
  const plural = hidden === 1 ? '' : 's';
  const count = `\u2026 (${hidden} more ${noun}${plural} folded`;
  return opts.expandHint === true
    ? `${count} — press f to expand)`
    : `${count})`;
}

/**
 * Adjacent helper for kind-unit summaries.
 * foldHint's noun is a count-unit ('line' | 'agent' | 'item'), not an operation kind —
 * do not coerce a kind into that slot.
 */
export function foldKindHint(kind: string, count: number): string {
  return `\u2026 (${count} ${kind})`;
}

/** Tool names already classified by summarizeToolCall — reuse, do not invent kinds. */
const CLASSIFIED_TOOL_OPERATION_KINDS = [
  'Bash',
  'Read',
  'Edit',
  'Grep',
  'Glob',
  'ListDir',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Lsp',
  'RunShell',
  'GetDashboardState',
] as const;

/**
 * Derive the coalescing operation kind for kind-unit fold mode.
 * Reuses summarizeToolCall's classified tool names first; unknown tools
 * fall back to the tool name so adjacent same-name calls still group.
 */
export function toolOperationKind(
  toolName: string,
  _args: Record<string, unknown> = {},
): string {
  const trimmed = toolName.trim();
  if (!trimmed) return trimmed;
  const classified = CLASSIFIED_TOOL_OPERATION_KINDS.find(
    (name) => name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (classified) return classified;
  if (trimmed === 'update_plan' || trimmed === 'UpdatePlan') return 'UpdatePlan';
  if (trimmed === 'update_goal' || trimmed === 'UpdateGoal') return 'UpdateGoal';
  return trimmed;
}

function shouldFoldToolBodyAsTaskUnit(lineCount: number, opts: RenderOpts): boolean {
  const maxLines = opts.maxLines ?? FOLD_LIMITS.TOOL_BODY;
  return Number.isFinite(maxLines)
    && (opts.foldMode ?? 'line') === 'task-unit'
    && lineCount > 1;
}

/** Truncate a one-line string to fit the summary budget. Preserves
 *  ANSI by operating on raw text only — don't pass styled strings. */
function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  return flat.slice(0, Math.max(1, width - 1)) + FIGURES.ELLIPSIS;
}

/** Build the one-line summary string shown after the tool name in the
 *  `⏺ Bash(...)` / `⎿ Bash(...)` headers. Each tool has its own shape
 *  — we lift the formatting out of skill-runner.ts so both the top-
 *  level and nested-child rendering share the same surface. */
export function summarizeToolCall(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'Bash': {
      const cmd = String(args.command ?? '').trim();
      return cmd || '(empty command)';
    }
    case 'Read': {
      const path = String(args.file_path ?? '');
      const offset = args.offset ? ` offset=${args.offset}` : '';
      const limit  = args.limit  ? ` limit=${args.limit}`   : '';
      return `${path}${offset}${limit}`;
    }
    case 'Edit': {
      const path = String(args.file_path ?? '');
      return `${path}${args.replace_all ? ' (replace_all)' : ''}`;
    }
    case 'Grep': {
      const pattern = String(args.pattern ?? '');
      const where = args.path ? ` in ${args.path}` : '';
      const glob  = args.glob  ? ` glob=${args.glob}` : '';
      const mode  = args.output_mode ? ` mode=${args.output_mode}` : '';
      return `"${pattern}"${where}${glob}${mode}`;
    }
    case 'Glob': {
      const pattern = String(args.pattern ?? '');
      const where = args.path ? ` in ${args.path}` : '';
      const limit = args.head_limit ? ` limit=${args.head_limit}` : '';
      const offset = args.offset ? ` offset=${args.offset}` : '';
      return `"${pattern}"${where}${limit}${offset}`;
    }
    case 'ListDir': {
      const path = String(args.path ?? '');
      const hidden = args.show_hidden ? ' hidden' : '';
      const sort = args.sort ? ` sort=${args.sort}` : '';
      const limit = args.head_limit ? ` limit=${args.head_limit}` : '';
      return `${path}${hidden}${sort}${limit}`;
    }
    case 'WebFetch': {
      return String(args.url ?? '');
    }
    case 'WebSearch': {
      const query = String(args.query ?? '').trim();
      const provider = args.provider ? ` via ${args.provider}` : '';
      const limit = args.limit ? ` limit=${args.limit}` : '';
      return `"${query}"${provider}${limit}`;
    }
    case 'Agent': {
      const desc = String(args.description ?? '').trim();
      return desc || '(no description)';
    }
    case 'Lsp': {
      // Per-op compact shape so the dashboard chat log shows
      //   ⏺ Lsp(hover src/llm.ts:10:20)
      //   ⏺ Lsp(findReferences src/llm.ts:1251:15)
      //   ⏺ Lsp(workspaceSymbol "streamLLM")
      // instead of the raw JSON argument dump.
      const op = String(args.operation ?? '');
      if (op === 'workspaceSymbol') {
        return `workspaceSymbol "${String(args.query ?? '')}"`;
      }
      const filePath = String(args.filePath ?? '');
      if (op === 'documentSymbol') {
        return `documentSymbol ${filePath}`;
      }
      return `${op} ${filePath}:${args.line ?? '?'}:${args.character ?? '?'}`;
    }
    case 'RunShell': {
      const command = Array.isArray(args.command)
        ? (args.command as unknown[]).filter(v => typeof v === 'string').join(' ')
        : '';
      const cwd = args.cwd ? ` cwd=${args.cwd}` : '';
      const mode = args.mode ? ` mode=${args.mode}` : '';
      return `${command || '(empty command)'}${cwd}${mode}`;
    }
    case 'GetDashboardState': {
      return 'current dashboard snapshot';
    }
    default: {
      try {
        return JSON.stringify(args);
      } catch { return '(unrenderable args)'; }
    }
  }
}

/** Render a LogEntry to ANSI-styled lines. The caller pushes each
 *  returned string into the log pane (chatLines). An entry may render
 *  to zero, one, or many lines — text entries preserve embedded
 *  newlines, headers are always single-line. */
export function renderLogEntry(
  entry: LogEntry,
  opts: RenderOpts = {},
): string[] {
  const width = opts.maxSummaryWidth ?? DEFAULT_SUMMARY_WIDTH;
  const indent = opts.childIndent ?? DEFAULT_CHILD_INDENT;

  switch (entry.kind) {
    case 'text':
      // Preserve embedded newlines — caller may pass multi-line text.
      // Split so the pane scroll math sees one entry per line.
      return entry.text.length === 0 ? [''] : entry.text.split('\n');

    case 'section':
      return [(entry.color ?? C.peach)(entry.label)];

    case 'tool-header': {
      const head = `${C.peach(G.CIRCLE)} ${C.bold(entry.toolName)}(${C.subtext(truncate(entry.summary, width - entry.toolName.length - 4))})`;
      return [head];
    }

    case 'tool-body': {
      // Cap inline pane display at TOOL_BODY_MAX_LINES. The full text
      // still reaches the model's tool_result history — this
      // truncation only affects what we PUSH to chatLines so a 60KB
      // JSON Read doesn't flood the pane with 1559 raw rows. Each
      // displayed line is prefixed with its 1-based line number so
      // the user sees both content AND extent at a glance.
      if (entry.text.length === 0) return [];
      const all = entry.text.split('\n');
      const isError = !!entry.isError;
      const maxLines = opts.maxLines ?? FOLD_LIMITS.TOOL_BODY;
      if (!Number.isFinite(maxLines)) {
        return all.map(l => (isError ? C.error(l) : l));
      }
      if ((opts.foldMode ?? 'line') === 'task-unit') {
        if (shouldFoldToolBodyAsTaskUnit(all.length, opts)) {
          // No aggregation key: tool-body entries carry no call identifier.
          debug.log('log.fold', 'fold-applied', {
            mode: 'task-unit',
            preFoldLineCount: all.length,
            postFoldLineCount: 1,
          });
          return [C.muted(foldHint('line', all.length, { expandHint: opts.expandHint }))];
        }
        return all.map(l => (isError ? C.error(l) : l));
      }
      if (all.length <= maxLines) {
        return all.map(l => (isError ? C.error(l) : l));
      }
      const shown = all.slice(0, maxLines).map(l => (isError ? C.error(l) : l));
      const hiddenCount = all.length - maxLines;
      shown.push(C.muted(foldHint('line', hiddenCount, { expandHint: opts.expandHint })));
      return shown;
    }

    case 'agent-start': {
      // `⏺ Agent(description)` — default subagent_type is elided;
      // non-default appended as muted tag: `⏺ Agent(desc) [explorer]`.
      const isDefault = entry.subagentType === 'general-purpose' || !entry.subagentType;
      const descBudget = width - 'Agent()'.length - (isDefault ? 0 : entry.subagentType.length + 3);
      const descText = truncate(entry.description || '(no description)', descBudget);
      const tag = isDefault ? '' : ` ${C.muted(`[${entry.subagentType}]`)}`;
      return [`${C.peach(G.CIRCLE)} ${C.bold('Agent')}(${C.subtext(descText)})${tag}`];
    }

    case 'bg-batch-launch': {
      // Header line + N tree rows. Each description truncated to the
      // summary budget minus the tree prefix ("  ├─ ").
      const n = entry.descriptions.length;
      const head = `${C.peach(G.CIRCLE)} ${C.bold(`${n} background agent${n === 1 ? '' : 's'} launched`)}`;
      if (n === 0) return [head];
      const prefixWidth = indent.length + G.TREE_MID.length + 1; // "  ├─ "
      const descBudget = width - prefixWidth;
      const maxItems = opts.maxBatchItems ?? FOLD_LIMITS.BATCH_TREE;
      const folded = Number.isFinite(maxItems) && n > maxItems;
      const visible = folded
        ? entry.descriptions.slice(0, Math.max(0, maxItems))
        : entry.descriptions;
      const rows = visible.map((desc, i) => {
        const last = !folded && i === visible.length - 1;
        const glyph = last ? G.TREE_LAST : G.TREE_MID;
        const shown = truncate(desc || '(no description)', descBudget);
        // Per-agent stable color. Makes the launch tree scannable —
        // same color here should be what you see on the completion
        // toast and the Done line for THAT agent.
        const color = opts.colorByAgent === false
          ? C.subtext
          : agentColor(desc || '(no description)');
        return `${indent}${C.muted(glyph)} ${color(shown)}`;
      });
      if (folded) {
        const hidden = n - visible.length;
        rows.push(`${indent}${C.muted(G.TREE_LAST)} ${C.muted(foldHint('agent', hidden, { expandHint: opts.expandHint }))}`);
      }
      return [head, ...rows];
    }

    case 'bg-agent-complete': {
      // First line = completion toast (`⏺ Agent "desc" completed` —
      // matches claude-code-fork's UserAgentNotificationMessage style).
      // Second line = bake checkpoint. When runningDescriptions is
      // supplied and non-empty, the tail names each in-flight sibling
      // so the user knows WHO is still working, not just how many.
      const descShown = truncate(entry.description || '(no description)', width - 24);
      const descColor = opts.colorByAgent === false
        ? C.subtext
        : agentColor(entry.description || '(no description)');
      const toast = `${C.peach(G.CIRCLE)} ${C.bold('Agent')} ${descColor(`"${descShown}"`)} ${C.success('completed')} ${C.muted(`(${formatDuration(entry.elapsedMs)})`)}`;
      if (entry.remaining === 0) {
        return [toast, `${C.muted(G.SPARKLE)} ${C.muted(`Baked for ${formatDuration(entry.batchElapsedMs)} \u00B7 all agents finished`)}`];
      }
      const running = entry.runningDescriptions ?? [];
      // When no running-list is supplied, keep the legacy
      // "N agent(s) still running" form for backwards compatibility
      // with the pre-iteration callers (and to avoid bare "N still
      // running" which reads awkwardly without the noun).
      let bakeTail: string;
      if (running.length === 0) {
        const word = entry.remaining === 1 ? 'agent still running' : 'agents still running';
        bakeTail = `${entry.remaining} ${word}`;
      } else {
        // "N still running: name1, name2, ..." — truncated if too wide.
        const head = `${entry.remaining} still running`;
        const budget = Math.max(20, width - head.length - 14);
        const joined = running.join(', ');
        const list = joined.length <= budget ? joined : truncate(joined, budget);
        bakeTail = `${head}: ${list}`;
      }
      return [
        toast,
        `${C.muted(G.SPARKLE)} ${C.muted(`Baked for ${formatDuration(entry.batchElapsedMs)} \u00B7 ${bakeTail}`)}`,
      ];
    }

    case 'bg-batch-summary': {
      // Single-line aggregate closer emitted after onAgentBatchEnd.
      // Uses a ✨-style marker (SPARKLE alias fits fine — a "panel
      // complete" moment) to visually separate it from per-agent
      // completion toasts. Tokens/tool-count are aggregates from the
      // caller; we only format.
      const parts: string[] = [
        `${entry.totalCount} agent${entry.totalCount === 1 ? '' : 's'}`,
        formatDuration(entry.batchElapsedMs),
      ];
      if (entry.totalToolCount > 0) {
        parts.push(`${entry.totalToolCount} tool ${entry.totalToolCount === 1 ? 'use' : 'uses'}`);
      }
      if (entry.totalTokens > 0) {
        parts.push(`${formatCompactNumber(entry.totalTokens)} tokens`);
      }
      return [
        `${C.success(G.SPARKLE)} ${C.bold('Panel complete:')} ${C.subtext(parts.join(' \u00B7 '))}`,
      ];
    }

    case 'agent-child': {
      // Indented under its parent agent-start. Variant controls label
      // color; done uses success green.
      const labelColor =
        entry.variant === 'done'     ? C.success
      : entry.variant === 'note'     ? C.muted
      :                                C.peach;
      const remaining = width - indent.length - 2 - entry.label.length - 2;
      const summary = truncate(entry.summary, Math.max(10, remaining));
      // Variants:
      //   tool     → `⎿ Bash(cmd)`              fn-call form
      //   prompt   → `⎿ Prompt:` or `⎿ Prompt: <tail>`  block introducer (always ":")
      //   response → `⎿ Response:` / with tail          block introducer
      //   done     → `⎿ Done` or `⎿ Done: <tail>`       card closer
      //   note     → `⎿ <muted label>[: <tail>]`        free-form footnote
      // Block introducers (prompt/response) always keep the trailing
      // colon even when no inline summary is present — a body block
      // (pushed as subsequent `text` entries, indented) is expected.
      let rendered: string;
      const isBlockIntroducer = entry.variant === 'prompt' || entry.variant === 'response';
      if (entry.variant === 'tool') {
        rendered = `${indent}${C.muted(G.BRACKET)}  ${C.bold(entry.label)}(${C.subtext(summary)})`;
      } else if (isBlockIntroducer) {
        const tail = summary ? C.subtext(` ${summary}`) : '';
        rendered = `${indent}${C.muted(G.BRACKET)}  ${labelColor(entry.label)}${C.subtext(':')}${tail}`;
      } else {
        rendered = summary
          ? `${indent}${C.muted(G.BRACKET)}  ${labelColor(entry.label)}${C.subtext(`: ${summary}`)}`
          : `${indent}${C.muted(G.BRACKET)}  ${labelColor(entry.label)}`;
      }
      return [rendered];
    }

    case 'agent-child-block': {
      // Delegate to the existing helper so a single implementation
      // renders both the legacy direct-call path and the new entry-
      // kind path. Inherits maxLines / bodyIndent from opts.
      return renderAgentChildBlock(entry.variant, entry.label, entry.body, opts);
    }
  }
}

// ── Block rendering helpers (Phase F2) ──
// Prompt / Response blocks show a `⎿ Label:` header then an indented
// multi-line body beneath it. The body is a raw string — we split on
// newlines and prefix each line with a fixed indent so the pane's
// scrolling math sees one entry per line.

/** Max lines of a block body shown inline before the remainder is
 *  elided with the shared fold-hint. Keeps a verbose prompt from
 *  flooding the pane; the full text is still in the model's history.
 *  Aliased to FOLD_LIMITS.BLOCK_BODY so the fold-aggressiveness knob
 *  lives in exactly one place. */
const DEFAULT_BLOCK_MAX_LINES = FOLD_LIMITS.BLOCK_BODY;

/** Body-indent: 7 spaces aligns under the 8th char of the parent
 *  `  ⎿  Prompt:` line (indent + glyph + two-space gutter ≈ 7).
 *  Chosen so the body lines up visually underneath the `P` of the
 *  label on a standard monospaced terminal. */
const DEFAULT_BLOCK_BODY_INDENT = '       ';

/** Render a block (prompt/response) as { header-line, body-lines... }.
 *  The caller pushes each returned string through its log sink.
 *  When the body exceeds `maxLines` the tail is replaced with a
 *  "… (N more lines)" marker so the card stays scannable. */
export function renderAgentChildBlock(
  variant: 'prompt' | 'response',
  label: string,
  body: string,
  opts: RenderOpts & { maxLines?: number; bodyIndent?: string } = {},
): string[] {
  const header = renderLogEntryAsString(
    { kind: 'agent-child', variant, label, summary: '' },
    opts,
  );
  if (!body || body.length === 0) return [header];

  const maxLines = opts.maxLines ?? DEFAULT_BLOCK_MAX_LINES;
  const bodyIndent = opts.bodyIndent ?? DEFAULT_BLOCK_BODY_INDENT;
  // Normalize: collapse trailing blank lines so the ellipsis marker
  // always follows real content, not whitespace.
  const lines = body.replace(/\s+$/, '').split('\n');

  if (!Number.isFinite(maxLines) || lines.length <= maxLines) {
    return [header, ...lines.map(l => `${bodyIndent}${l}`)];
  }
  const shown = lines.slice(0, maxLines);
  const hidden = lines.length - maxLines;
  return [
    header,
    ...shown.map(l => `${bodyIndent}${l}`),
    `${bodyIndent}${C.muted(foldHint('line', hidden, { expandHint: opts.expandHint }))}`,
  ];
}

/** Convenience: render entry AND pre-join with '\n' so callers that
 *  still work in the old "one string per pushDisplay" mode can drop it
 *  into pushDisplay without changing shape. Callers that want per-line
 *  granularity should use renderLogEntry directly. */
export function renderLogEntryAsString(
  entry: LogEntry,
  opts: RenderOpts = {},
): string {
  return renderLogEntry(entry, opts).join('\n');
}

// ── Formatters ──
// Shared by the Done summary line (Phase F1c) and any future pane
// that shows per-task stats. Kept pure + compact so tests can assert
// the exact output shape claude-code-fork uses: "2 tool uses · 26.2k
// tokens · 9s" style.

/** Format a number for compact display: 26234 → "26.2k", 1 → "1",
 *  1_500_000 → "1.5M". Integer thousands are rounded to one decimal
 *  so 26000 renders as "26k" (no trailing .0) and 26234 as "26.2k". */
export function formatCompactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 10
      ? `${Math.round(k)}k`
      : `${k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = n / 1_000_000;
  return m >= 10
    ? `${Math.round(m)}M`
    : `${m.toFixed(1).replace(/\.0$/, '')}M`;
}

/** Format a wall-clock duration. <60s → "9s"; ≥60s → "1m 5s";
 *  ≥1h → "1h 2m" (seconds omitted past the minute scale). */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hr}h ${min}m` : `${hr}h`;
}

/** Build the Done summary string shown after the `Done` label in a
 *  `⎿ Done (2 tool uses · 26.2k tokens · 9s)` agent-child line. Token
 *  count is an estimate from prompt+output text; real provider-usage
 *  wiring comes later. toolCount=0 omits the "N tool uses" segment,
 *  matching claude-code-fork's "Done (1.2k tokens · 3s)" style. */
export function formatAgentDone(stats: {
  toolCount: number;
  durationMs: number;
  outputChars: number;
  promptChars: number;
}): string {
  // Rough token estimate: chars/4 is the canonical mid-point of the
  // ASCII (1/4 tok/char) and CJK (~1/2 tok/char) bands. We don't have
  // the raw text here — just char counts from dispatchAgent — so we
  // use the midpoint rather than re-synthesizing strings for the real
  // estimator. Off by ±50% vs a tokenizer, but this line is a quick
  // visual cue, not a billing figure.
  const tokens = Math.ceil((stats.outputChars + stats.promptChars) / 4);
  const parts: string[] = [];
  if (stats.toolCount > 0) {
    parts.push(`${stats.toolCount} tool ${stats.toolCount === 1 ? 'use' : 'uses'}`);
  }
  if (tokens > 0) parts.push(`${formatCompactNumber(tokens)} tokens`);
  parts.push(formatDuration(stats.durationMs));
  return parts.join(' \u00B7 ');   // " · " separator, matches claude-code-fork
}

/** Live footer label for an in-flight Agent batch. Unlike
 *  bg-agent-complete / bg-batch-summary this is meant for a single
 *  mutable indicator row, not for transcript history. */
export function formatAgentBatchStatus(info: {
  phase: 'start' | 'tick' | 'complete' | 'end';
  batchElapsedMs?: number;
  total: number;
  done: number;
  remaining: number;
  runningDescriptions: string[];
  completedDescription?: string;
}, opts: {
  /** Show all running names instead of the compact 3-name summary. */
  expanded?: boolean;
  /** Animation frame from the caller's redraw loop. */
  frame?: number;
  /** Compact-mode running-name cap. Defaults to 3. */
  maxNames?: number;
} = {}): string {
  if (info.phase === 'end' || info.remaining === 0) {
    return `Agents ${info.done}/${info.total} complete`;
  }

  const scanner = agentBatchScanner(opts.frame ?? Math.floor((info.batchElapsedMs ?? 0) / 200));
  const names = info.runningDescriptions.filter(Boolean);
  const maxNames = opts.maxNames ?? FOLD_LIMITS.FOOTER_NAMES;
  const visibleNames = opts.expanded ? names : names.slice(0, maxNames);
  const running = visibleNames.join(', ');
  const more = !opts.expanded && names.length > maxNames
    ? ` +${names.length - maxNames}`
    : '';
  const completed = info.completedDescription
    ? ` \u00B7 completed: ${truncate(info.completedDescription, 28)}`
    : '';
  const elapsed = info.batchElapsedMs != null
    ? ` \u00B7 ${formatDuration(info.batchElapsedMs)}`
    : '';
  const mode = opts.expanded && names.length > maxNames ? ' \u00B7 expanded' : '';
  return `${scanner} Agents ${info.done}/${info.total} \u00B7 ${info.remaining} running${running ? `: ${running}${more}` : ''}${completed}${elapsed}${mode}`;
}

/** Does this entry, rendered at the given opts, produce any folded
 *  content? Used by dashboard to decide whether to register a post-
 *  run fold target (i.e. is there anything to unfold?). Returns the
 *  number of hidden items — 0 means the entry rendered in full and
 *  no fold affordance is needed. Currently handles bg-batch-launch
 *  and tool-body; extend here as we add fold support to more kinds. */
export function countFoldedItems(entry: LogEntry, opts: RenderOpts = {}): number {
  switch (entry.kind) {
    case 'bg-batch-launch': {
      const maxItems = opts.maxBatchItems ?? FOLD_LIMITS.BATCH_TREE;
      if (!Number.isFinite(maxItems)) return 0;
      return Math.max(0, entry.descriptions.length - maxItems);
    }
    case 'tool-body': {
      const lineCount = entry.text.length === 0
        ? 0
        : entry.text.split('\n').length;
      const maxLines = opts.maxLines ?? FOLD_LIMITS.TOOL_BODY;
      if (!Number.isFinite(maxLines)) return 0;
      if ((opts.foldMode ?? 'line') === 'task-unit') {
        return shouldFoldToolBodyAsTaskUnit(lineCount, opts) ? lineCount : 0;
      }
      return Math.max(0, lineCount - maxLines);
    }
    case 'agent-child-block': {
      // Matches renderAgentChildBlock: trailing whitespace trimmed
      // then split on '\n' → one row per line under the header.
      const maxLines = opts.maxLines ?? FOLD_LIMITS.BLOCK_BODY;
      if (!Number.isFinite(maxLines)) return 0;
      if (!entry.body || entry.body.length === 0) return 0;
      const lineCount = entry.body.replace(/\s+$/, '').split('\n').length;
      return Math.max(0, lineCount - maxLines);
    }
    default:
      return 0;
  }
}

/** Compact text-mode scanner inspired by opencode's Knight Rider
 *  indicator. Kept ASCII so it renders predictably in terminals and
 *  tests; color comes from the surrounding status line. */
export function agentBatchScanner(frame: number, width: number = 5): string {
  const w = Math.max(2, Math.floor(width));
  const cycle = w * 2 - 2;
  const pos0 = ((Math.floor(frame) % cycle) + cycle) % cycle;
  const pos = pos0 < w ? pos0 : cycle - pos0;
  let out = '';
  for (let i = 0; i < w; i++) {
    const d = Math.abs(i - pos);
    out += d === 0 ? '◆' : d === 1 ? '◇' : '·';
  }
  return out;
}
