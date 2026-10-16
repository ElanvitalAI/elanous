import { C } from '../tui.js';
import { logTurnThrew } from './turn-busy-teardown.js';
import { startThinking } from '../thinking-line.js';
import type { ContextRegistry } from '../context.js';
import { loadAllAttachments } from '../extractors.js';
import { FoldStack } from '../fold-stack.js';
import {
  countFoldedItems,
  formatAgentBatchStatus,
  renderLogEntry,
  type FoldMode,
  type LogEntry,
  type RenderOpts,
} from '../log-entry.js';
import {
  executeSkill,
  parseSkillMd,
  type AgentBatchStatusInfo,
  type ExecuteSkillResult,
  type ExecuteSkillOpts,
  type SkillManifest,
} from '../skills/runner.js';

type DashboardConversationTurn = { role: string; content: unknown };

type PendingFold = {
  entry: LogEntry;
  renderOpts: RenderOpts;
  foldable: boolean;
};

export interface DashboardSkillRuntimeDeps {
  chatHistory: readonly DashboardConversationTurn[];
  chatLines: string[];
  contextRegistry: ContextRegistry;
  foldStack: FoldStack;
  draw: () => void;
  pinChatTail: () => void;
  pushDebugBlank: () => void;
  pushDebugLine: (line: string) => void;
  attachStreamingKeys: (abortCtrl: AbortController) => () => void;
  formatSkillResponse: (text: string) => string[];
  skillContextLabel: string;
  allowAgentsScratch: boolean;
  showAgentsScratch: () => void;
  publishAgentBatchScratch: (
    skillName: string,
    info: AgentBatchStatusInfo,
    expanded: boolean,
  ) => void;
  parseSkill?: typeof parseSkillMd;
  executeSkill?: (
    manifest: SkillManifest,
    args: string,
    onDelta: (delta: string, full: string) => void,
    opts: ExecuteSkillOpts,
  ) => Promise<ExecuteSkillResult>;
  loadAttachments?: typeof loadAllAttachments;
  /** Current log fold mode. Forwarded to executeSkill so the first
   *  tool-result paint matches FoldStack rerenders. Omitted → runner
   *  keeps the existing line default. */
  foldMode?: FoldMode;
  /** When true, foldHint keeps the rich-mode "press f to expand" suffix.
   *  Omitted/false = count-only. Dashboard supplies `mode === 'rich'`. */
  expandHint?: boolean;
}

/** Convert the tail of a chat.history log into the `priorConversation`
 *  shape expected by executeSkill / buildSkillMessages. Only includes
 *  user + assistant turns, flattens ContentBlock[] to text, and
 *  drops empty strings. */
export function buildDashboardSkillPriorConversation(
  history: readonly DashboardConversationTurn[],
  limit: number,
): Array<{ role: 'user' | 'assistant'; text: string }> {
  if (!history || history.length === 0) return [];
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (let i = history.length - 1; i >= 0 && out.length < limit; i--) {
    const message = history[i]!;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    let text = '';
    if (typeof message.content === 'string') {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      const parts: string[] = [];
      for (const block of message.content as Array<{ type?: string; text?: string }>) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
      text = parts.join('\n').trim();
    }
    if (!text.trim()) continue;
    out.push({ role: message.role as 'user' | 'assistant', text });
  }
  return out.reverse();
}

function registerStaticFoldForEntry(
  entry: LogEntry,
  renderOpts: RenderOpts,
  searchStart: number,
  chatLines: string[],
  foldStack: FoldStack,
): void {
  // Existing caller path for RenderOpts.foldMode: folded entries are
  // rendered here, then rerendered below with the same RenderOpts.
  const rendered = renderLogEntry(entry, renderOpts);
  if (rendered.length === 0) return;
  const anchor = rendered[0];
  if (anchor === undefined) return;
  let lineStart = -1;
  for (let i = searchStart; i <= chatLines.length - rendered.length; i++) {
    if (chatLines[i] !== anchor) continue;
    let ok = true;
    for (let j = 1; j < rendered.length; j++) {
      if (chatLines[i + j] !== rendered[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    lineStart = i;
    break;
  }
  if (lineStart < 0) return;
  const lineEnd = lineStart + rendered.length;
  foldStack.push({
    kind: 'static',
    expanded: false,
    lineStart,
    lineEnd,
    rerender: (expanded) => {
      if (!expanded) return renderLogEntry(entry, renderOpts);
      return renderLogEntry(entry, {
        ...renderOpts,
        maxBatchItems: Infinity,
        maxLines: Infinity,
      });
    },
  });
}

export async function runDashboardSkillByName(
  skillArg: string,
  skillArgs: string,
  deps: DashboardSkillRuntimeDeps,
): Promise<boolean> {
  const parseSkill = deps.parseSkill ?? parseSkillMd;
  const execute = deps.executeSkill ?? executeSkill;
  const loadAttachments = deps.loadAttachments ?? loadAllAttachments;
  const manifest = parseSkill(skillArg);
  if (!manifest) {
    deps.pushDebugLine(C.error(`Skill not found: ${skillArg}`));
    deps.pushDebugLine(C.muted('Run /run-skill with no args to see available skills'));
    return false;
  }

  deps.pushDebugBlank();
  deps.pushDebugLine(C.accent(`❯ /run-skill ${skillArg}${skillArgs ? ` ${skillArgs}` : ''}`));
  deps.pushDebugLine(
    C.muted(`├─ ${manifest.description.slice(0, 100)}${manifest.description.length > 100 ? '…' : ''}`),
  );
  deps.pushDebugLine(C.info('▶ engaged — routing to LLM…'));
  deps.draw();

  const skillStartedAt = Date.now();
  const runThinking = startThinking({
    chatLines: deps.chatLines,
    onFrame: () => {
      deps.pinChatTail();
      deps.draw();
    },
    message: `Running ${manifest.name}`,
    metrics: { startedAt: skillStartedAt },
  });

  let skillStatus: 'completed' | 'interrupted' | 'failed' = 'completed';
  let skillError: string | undefined;
  let markerIdx = -1;
  let cleanupEsc: (() => void) | null = null;
  let pendingFoldableEntries: PendingFold[] = [];
  let latestBatchInfo: AgentBatchStatusInfo | null = null;
  let liveFooterExpanded = false;
  let liveFooterFoldId: string | null = null;

  const repaintLiveFooter = (): void => {
    if (!latestBatchInfo) return;
    const info = latestBatchInfo;
    const expanded = liveFooterExpanded;
    runThinking.updateAnimated(frame =>
      `Running ${manifest.name} · ${formatAgentBatchStatus(info, { expanded, frame })}`,
    );
  };

  try {
    const abortCtrl = new AbortController();
    cleanupEsc = deps.attachStreamingKeys(abortCtrl);

    deps.pushDebugBlank();
    markerIdx = deps.chatLines.length;
    await loadAttachments(deps.contextRegistry);

    let lastTurnLabel = '';
    const result = await execute(
      manifest,
      skillArgs,
      (_delta, full) => {
        runThinking.update(`Streaming ${manifest.name}${lastTurnLabel}`);
        runThinking.updateMetrics({ outputTokens: Math.ceil(full.length / 4) });
        const formatted = deps.formatSkillResponse(full);
        deps.chatLines.length = markerIdx;
        for (const line of formatted) deps.chatLines.push(line);
        deps.pinChatTail();
        deps.draw();
      },
      {
        signal: abortCtrl.signal,
        systemContext: deps.skillContextLabel,
        context: deps.contextRegistry,
        priorConversation: buildDashboardSkillPriorConversation(deps.chatHistory, 6),
        onTurn: (info) => {
          const tools = info.pendingCalls.length > 0
            ? ` → ${info.pendingCalls.slice(0, 3).join(', ')}${info.pendingCalls.length > 3 ? '…' : ''}`
            : '';
          lastTurnLabel = ` · turn ${info.turn + 1}${tools}`;
          runThinking.update(`Streaming ${manifest.name}${lastTurnLabel}`);
        },
        onAgentBatchStatus: (info) => {
          latestBatchInfo = info;
          if (deps.allowAgentsScratch) deps.showAgentsScratch();
          if (liveFooterFoldId === null) {
            liveFooterExpanded = false;
            liveFooterFoldId = deps.foldStack.push({
              kind: 'live',
              expanded: false,
              rerender: () => {
                const self = deps.foldStack.top();
                if (self && self.kind === 'live') liveFooterExpanded = self.expanded;
                repaintLiveFooter();
                deps.publishAgentBatchScratch(manifest.name, info, liveFooterExpanded);
              },
              onDispose: () => { liveFooterExpanded = false; },
            });
          }
          repaintLiveFooter();
          deps.publishAgentBatchScratch(manifest.name, info, liveFooterExpanded);
        },
        foldMode: deps.foldMode,
        expandHint: deps.expandHint,
        onFoldableEntry: (entry, renderOpts) => {
          const hidden = countFoldedItems(entry, renderOpts);
          pendingFoldableEntries.push({
            entry,
            renderOpts,
            foldable: hidden > 0,
          });
        },
      },
    );

    deps.pushDebugLine(C.info(`╰─ via ${result.provider} (${result.model})`));
    if (abortCtrl.signal.aborted) skillStatus = 'interrupted';
  } catch (err: any) {
    skillStatus = 'failed';
    skillError = err?.message || String(err);
    logTurnThrew('skill-run', err);
    deps.pushDebugLine(C.error(`Error: ${err?.message || err}`));
  } finally {
    cleanupEsc?.();
    if (liveFooterFoldId !== null) deps.foldStack.remove(liveFooterFoldId);
    if (markerIdx >= 0) {
      for (const pending of pendingFoldableEntries) {
        if (!pending.foldable) continue;
        registerStaticFoldForEntry(
          pending.entry,
          pending.renderOpts,
          markerIdx,
          deps.chatLines,
          deps.foldStack,
        );
      }
    }
    pendingFoldableEntries = [];
    latestBatchInfo = null;
    runThinking.stop({ status: skillStatus, errorText: skillError });
  }

  return true;
}
