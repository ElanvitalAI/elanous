import type { DashboardSlashContext, DashboardSlashReturn } from './dashboard-handlers.js';
import type { SlashCommandRegistry } from './registry.js';
import { stripAnsi } from '../../tui.js';
import { resolveDashboardChatMainLogCommand } from '../input/chat-main-log-command.js';
import {
  dashboardLogHelpLines,
  resolveDashboardLogFilterAction,
  resolveDashboardLogFoldAction,
  resolveDashboardLogSearchAction,
  resolveDashboardLogSizeAction,
  resolveDashboardLogTurnAction,
} from '../input/chat-main-log-actions.js';
import { debug } from '../../debug/log.js';

type EmitReplyToChat = (ctx: Pick<DashboardSlashContext, 'pushChatLine'>, line: string) => void;

export function registerDashboardLogSlash(
  registry: SlashCommandRegistry<DashboardSlashContext, DashboardSlashReturn>,
  emitReplyToChat: EmitReplyToChat,
): void {
  registry.register('log', async (args, ctx) => {
    // Log pane control. Routes through resolveDashboardChatMainLog
    // Command + resolveDashboardLog*Action helpers are imported
    // in this module. Host-local state — heightBias / filter / search / freeze /
    // turnSeparator / foldMode / chatOnly — comes via ctx.logSlash.
    // Replies go to the chat buffer the person is looking at — never the
    // debug buffer, which the default layout does not draw.
    const logCommand = resolveDashboardChatMainLogCommand(args);
    if (debug.enabled) {
      debug.log('slash.log.handler', 'enter', {
        argsCount: args.length,
        args0: args[0] ?? null,
        kind: logCommand.kind,
        // unknown branch carries subcommand
        unknownSub: logCommand.kind === 'unknown' ? logCommand.subcommand : null,
      });
    }
    if (logCommand.kind === 'help') {
      const lines = dashboardLogHelpLines();
      for (const [index, line] of lines.entries()) {
        if (line === '') {
          emitReplyToChat(ctx, '');
        } else if (index === 0) {
          emitReplyToChat(ctx, ctx.accent(line));
        } else {
          emitReplyToChat(ctx, ctx.muted(line));
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'size') {
      const action = resolveDashboardLogSizeAction(logCommand.delta, ctx.logSlash.getLogHeightBias());
      if (action.kind === 'invalid') {
        emitReplyToChat(ctx, ctx.warning(action.message));
      } else {
        ctx.logSlash.setLogHeightBias(action.nextBias);
        ctx.logSlash.recomputePaneHeight();
        emitReplyToChat(ctx, ctx.muted(action.message));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'copy-all') {
      await ctx.logSlash.copyEntireLog();
      return;
    }
    if (logCommand.kind === 'return-to-input') {
      ctx.logSlash.returnFocusToInput();
      return;
    }
    if (logCommand.kind === 'clear') {
      ctx.chatLines.length = 0;
      ctx.attachmentRowMap.clear();
      ctx.clearLogSearch();
      ctx.clearLogFilter();
      emitReplyToChat(ctx, ctx.muted('Log cleared.'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'filter') {
      const q = logCommand.query;
      const currentQuery = ctx.logSlash.getLogFilterQuery();
      const activeCount = ctx.chatLines.filter(
        line => stripAnsi(line).toLowerCase().includes((q || currentQuery).toLowerCase()),
      ).length;
      const action = resolveDashboardLogFilterAction(q, currentQuery, activeCount);
      if (action.kind === 'clear') {
        ctx.clearLogFilter();
        emitReplyToChat(ctx, ctx.muted(action.message));
      } else if (action.kind === 'show-status') {
        emitReplyToChat(ctx, ctx.muted(action.message));
      } else {
        ctx.logSlash.applyLogFilter(q);
        emitReplyToChat(ctx, ctx.muted(action.message));
        ctx.setChatScrollOffset(-1);
      }
      return;
    }
    if (logCommand.kind === 'search') {
      const q = logCommand.query;
      const action = resolveDashboardLogSearchAction(q);
      if (action.kind === 'clear') {
        ctx.clearLogSearch();
        emitReplyToChat(ctx, ctx.muted(action.message));
      } else if (action.kind === 'open-modal') {
        ctx.logSlash.openLogSearchModal();
      } else {
        ctx.logSlash.applyLogSearch(action.query);
        const count = ctx.logSlash.getLogSearchResultsCount();
        if (count === 0) {
          emitReplyToChat(ctx, ctx.muted(`  no matches for "${action.query}"`));
        } else {
          emitReplyToChat(ctx, ctx.muted(
            `  ${count} match${count === 1 ? '' : 'es'} for "${action.query}" — n / N to cycle, Esc to clear`,
          ));
          // Jump to the first one.
          const firstIdx = ctx.logSlash.firstSearchResultLineIdx();
          if (firstIdx !== null) ctx.logSlash.scrollToSearchLineIdx(firstIdx);
        }
      }
      // Original case had `chatScrollOffset = chatScrollOffset` no-op
      // — preserved here as no setChatScrollOffset call (intentional).
      return;
    }
    if (logCommand.kind === 'freeze') {
      if (!ctx.logSlash.isLogFreezeEnabled()) {
        emitReplyToChat(ctx, ctx.muted('  scroll-freeze DISABLED (ELANOUS_LOG_PAUSE_ON_SCROLL=0).'));
      } else {
        const frozenIdx = ctx.logSlash.getLogFrozenTailIndex();
        if (frozenIdx === null) {
          emitReplyToChat(ctx, ctx.muted('  scroll-freeze inactive — log tail is live.'));
        } else {
          const queued = Math.max(0, ctx.logSlash.chatLinesLength() - frozenIdx);
          emitReplyToChat(ctx, ctx.muted(`  scroll-freeze active — ${queued} line${queued === 1 ? '' : 's'} queued. Press G to resume.`));
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'solo') {
      const next = ctx.logSlash.toggleSolo();
      const message = next
        ? '  log solo ON — chat-only layout active.'
        : '  log solo OFF — dashboard layout restored.';
      emitReplyToChat(ctx, ctx.muted(message));
      if (debug.enabled) {
        debug.log('slash.log.solo', next ? 'on' : 'off', {
          newChatOnlyMode: next,
        });
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'fold-all') {
      if (!ctx.logSlash.setAllFolds) {
        // A host without a fold controller cannot know whether anything is folded — say so, not «nothing».
        debug.log('log.fold', 'slash-set-all', { expanded: logCommand.expanded, changed: null, reason: 'no-fold-controller' });
        emitReplyToChat(ctx, ctx.warning('  fold controls are not available in this view'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      const changed = ctx.logSlash.setAllFolds(logCommand.expanded);
      debug.log('log.fold', 'slash-set-all', { expanded: logCommand.expanded, changed });
      emitReplyToChat(ctx, ctx.muted(changed > 0
        ? `  ${logCommand.expanded ? 'unfolded' : 'folded'} ${changed} block${changed === 1 ? '' : 's'}`
        : `  (nothing to ${logCommand.expanded ? 'unfold' : 'fold'})`));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'fold') {
      const action = resolveDashboardLogFoldAction(logCommand.mode, ctx.logSlash.getLogFoldMode());
      if (action.kind === 'set-mode') {
        ctx.logSlash.setLogFoldMode(action.mode);
        emitReplyToChat(ctx, ctx.muted(action.message));
        ctx.setChatScrollOffset(-1);
        return;
      }
      emitReplyToChat(ctx, ctx.warning(action.message));
      emitReplyToChat(ctx, ctx.muted(action.usage));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'turn') {
      const action = resolveDashboardLogTurnAction(logCommand.arg, ctx.logSlash.getLogTurnSeparatorMode());
      if (action.kind === 'emit-now') {
        const prev = ctx.logSlash.getLogTurnSeparatorMode();
        ctx.logSlash.setLogTurnSeparatorMode(action.nextModeWhileEmitting);
        ctx.logSlash.pushTurnSeparator();
        ctx.logSlash.setLogTurnSeparatorMode(prev);
        ctx.setChatScrollOffset(-1);
        return;
      }
      if (action.kind === 'set-mode') {
        ctx.logSlash.setLogTurnSeparatorMode(action.mode);
        emitReplyToChat(ctx, ctx.muted(action.message));
        ctx.setChatScrollOffset(-1);
        return;
      }
      emitReplyToChat(ctx, ctx.muted(action.message));
      emitReplyToChat(ctx, ctx.muted(action.usage));
      ctx.setChatScrollOffset(-1);
      return;
    }
    emitReplyToChat(ctx, ctx.warning(`  Unknown /log subcommand: ${logCommand.subcommand}. Try /log help.`));
    ctx.setChatScrollOffset(-1);
  });
}
