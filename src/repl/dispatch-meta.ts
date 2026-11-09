// WT-A-3 — pure-output meta-command dispatcher.
//
// The CLI REPL (`src/repl/index.ts`) hosts a `handleMetaCommand()`
// that writes results via `ui.info` / `ui.error` to stdout and exits
// the readline loop on `:exit`. Web-terminal callers need:
//   - text output captured rather than streamed to stdout
//   - no readline / process.exit dependencies
//   - feature subset that fits the web context (skip `:attach <local-path>`
//     since the PWA can't reach the user's local fs; skip `:exit` since
//     the web term outlives any single REPL turn)
//
// Solution: a sibling dispatcher with the same vocabulary that returns
// a structured result the caller can stream back as a `terminalOutput`
// envelope. Both dispatchers stay in sync via convention (small,
// stable command set); the CLI version remains the source of truth
// for handlers that touch stdout/exit.

import { ensureCliSession, sessionBudget } from '../session/chat.js';
import { loadSession, setActiveSessionId } from '../session/index.js';
import { reloadUserConfig, saveUserConfig, jumpToRotationEntry } from '../user-config.js';
import type { UserConfig } from '../user-config/types.js';
import { setAmbientSessionId } from '../debug/log.js';
import { inspectActiveProvider } from '../provider-summary.js';

export interface MetaCommandContext {
  /** Current user config snapshot. The dispatcher returns an updated
   *  copy in `cfgUpdate` when the command persisted a change. */
  cfg: UserConfig;
  /** Active session id at call time. The dispatcher returns a new id
   *  in `sessionIdChange` when `:fork` ran. */
  sessionId: string;
  /** Caller surface (default 'cli'). `'web-term'` narrows the visible
   *  command set to terminal-context commands (:tab, :cwd, :capture,
   *  :peers) — session-management ones (:fork, :provider, :budget,
   *  etc) redirect to UI affordances since they're already covered by
   *  the TopBar / settings / chat composer. */
  surface?: 'cli' | 'web-term';
  /** Optional terminal id for web-term surface — required by :cwd,
   *  :capture. Caller passes the active tab id. */
  terminalId?: string;
}

export interface MetaCommandResult {
  /** True when the input started with `:` and a known cmd matched.
   *  False means the line is a regular shell command — caller should
   *  forward it to the PTY instead of treating it as a meta command. */
  consumed: boolean;
  /** Text to echo back to the terminal. Empty string when not consumed.
   *  Newline-terminated lines so xterm.js renders cleanly. */
  output: string;
  /** Set when the dispatcher persisted a config change. */
  cfgUpdate?: UserConfig;
  /** Set when `:fork` produced a new session id. */
  sessionIdChange?: string;
  /** Set when `:exit` would have fired in the CLI REPL. Web-terminal
   *  callers can treat this as "close the terminal tab" or just ignore. */
  exitRequested?: boolean;
  /** Set by `:tab` (web-term surface) so the PWA TerminalRepl client
   *  can switch the active tab without daemon round-trips touching
   *  client tab state. Values: 'next' · 'prev' · positive integer (1-indexed). */
  tabIntent?: 'next' | 'prev' | number;
  /** Set by `:capture` so the PWA can inject the saved path into the
   *  active terminal as if typed (mirrors the Camera/File flow). Empty
   *  when capture failed; `output` carries the error message in that case. */
  injectPath?: string;
  /** WT-A-3b — set by `:agent <prompt>` so the ACP handler can pick up
   *  the prompt and route it through `runAgentTurn` (which composes the
   *  terminal context bundle, calls `runDaemonPromptTurn`, and returns
   *  the assistant markdown). The dispatcher itself stays sync — heavy
   *  lift is the caller's responsibility, mirroring the `:capture`
   *  pattern.
   *
   *  Phase 3 — `scrollLines` carries the optional `--scroll N` cap so
   *  the bundler can limit how many trailing buffer lines reach the
   *  LLM (default unlimited = whatever `renderForLLM()` returns). */
  agentRequest?: { prompt: string; scrollLines?: number };
  /** WT-A-3b Phase 2 — set by `:agent` (no args). Caller (PWA
   *  TerminalRepl) flips its UI into chat mode: subsequent plain-text
   *  input is auto-prefixed with `:agent ` and routed through the
   *  same ACP path. Exits on `:exit` (caller observes `exitRequested`
   *  while in chat mode). Decoupled from `agentRequest` so the
   *  dispatcher stays one-line and the client owns the mode-stack
   *  state machine. */
  agentChatModeEnter?: boolean;
}

const HELP_LINES = [
  ':help — list commands',
  ':provider [<label>] — show or switch active provider',
  ':budget — show session token budget',
  ':session — show active session id',
  ':history — preview last 3 messages',
  ':reload — reload ~/.config/elanous/config.json',
  ':fork — spawn a fresh session (new id, no shared history)',
  ':exit — request session close (web term: no-op signal)',
];

const WEB_TERM_HELP_LINES = [
  ':help — list web-terminal commands',
  ':tab next|prev|<N> — switch active terminal tab',
  ':cwd — show terminal spawn cwd',
  ':capture — screenshot the active terminal → PNG path inject',
  ':peers — list devices attached to this session',
];

/** Session-management commands the web sticky REPL no longer ships
 *  natively — UI surfaces them better. The dispatcher returns a
 *  redirect message instead of executing the CLI version. */
const WEB_TERM_REDIRECTED = new Set([
  'fork',     // → TopBar "New chat" button (or future /chat slash command)
  'provider', // → /settings ProviderPicker
  'budget',   // → /chat BudgetPill (always visible)
  'session',  // → TopBar settings popover (already shows sessionId)
  'history',  // → /chat ChatHistory (full history vs last-3 preview)
  'reload',   // → /settings (reload happens implicitly on next config save)
]);

const WEB_TERM_REDIRECT_HINTS: Record<string, string> = {
  fork: 'TopBar "New chat" button (or use the chat composer)',
  provider: '/settings → Default provider',
  budget: '/chat → BudgetPill (always-visible token meter)',
  session: 'TopBar ⚙️ → session id is shown in the popover',
  history: '/chat → full message history above the composer',
  reload: '/settings (config reloads on the next save)',
};

/** ANSI dim formatter — keeps meta-command echo visually distinct
 *  from PTY output without picking colors that fight the user's
 *  shell prompt theme. */
function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}
function red(text: string): string {
  return `\x1b[31m${text}\x1b[0m`;
}

/** Dispatch a single meta-command line. Idempotent + side-effects
 *  match the CLI REPL (provider switches persist to disk, fork
 *  creates a new daemon-side session). Caller is responsible for
 *  echoing `output` back to the user's terminal. */
export function dispatchMetaCommand(
  line: string,
  ctx: MetaCommandContext,
): MetaCommandResult {
  const trimmed = line.trim();
  if (!trimmed.startsWith(':')) return { consumed: false, output: '' };

  const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
  const isWebTerm = ctx.surface === 'web-term';

  // Web-term surface: redirect session-management commands to their
  // proper UI affordances rather than executing the CLI version.
  if (isWebTerm && cmd && WEB_TERM_REDIRECTED.has(cmd)) {
    const hint = WEB_TERM_REDIRECT_HINTS[cmd] ?? 'use the PWA UI';
    return {
      consumed: true,
      output: dim(`:${cmd} → ${hint}\r\n`),
    };
  }

  switch (cmd) {
    case 'help':
    case '?': {
      const lines = isWebTerm ? WEB_TERM_HELP_LINES : HELP_LINES;
      return {
        consumed: true,
        output: lines.map((l) => dim(l)).join('\r\n') + '\r\n',
      };
    }
    // Web-term-only: terminal-context commands.
    case 'tab': {
      if (!isWebTerm) {
        return { consumed: true, output: red(':tab is web-terminal only\r\n') };
      }
      const arg = args[0]?.toLowerCase();
      if (arg === 'next' || arg === 'prev') {
        return { consumed: true, output: dim(`:tab ${arg}\r\n`), tabIntent: arg };
      }
      const n = arg ? Number.parseInt(arg, 10) : NaN;
      if (Number.isFinite(n) && n >= 1) {
        return { consumed: true, output: dim(`:tab ${n}\r\n`), tabIntent: n };
      }
      return {
        consumed: true,
        output: red(':tab requires next | prev | <1-based index>\r\n'),
      };
    }
    case 'cwd': {
      if (!isWebTerm) {
        return { consumed: true, output: red(':cwd is web-terminal only — use shell `pwd`\r\n') };
      }
      const tid = ctx.terminalId;
      if (!tid) {
        return { consumed: true, output: red(':cwd needs an active terminalId\r\n') };
      }
      // Resolve via lookupPreviewTerminal lazily so this module stays
      // free of a hard dep on the web-terminal layer (test seam).
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- sync require keeps surface narrow + avoids top-level circular import
        const { lookupPreviewTerminal } = require('../web-terminal/preview-tap-registry.js') as typeof import('../web-terminal/preview-tap-registry.js');
        const pt = lookupPreviewTerminal(ctx.sessionId, tid);
        if (!pt) {
          return { consumed: true, output: red(`:cwd unknown terminal ${tid}\r\n`) };
        }
        const cwd = (pt as unknown as { opts: { cwd: string } }).opts?.cwd ?? '?';
        return {
          consumed: true,
          output: dim(`spawn cwd: ${cwd} (use \`pwd\` for live cwd)\r\n`),
        };
      } catch (e) {
        return { consumed: true, output: red(`:cwd error — ${String(e)}\r\n`) };
      }
    }
    case 'peers': {
      if (!isWebTerm) {
        return { consumed: true, output: red(':peers is web-terminal only\r\n') };
      }
      // Peer detail is owned by the ACP server; web-term caller layers
      // the actual list. Here we surface a stub so :help advertises the
      // command and the ACP handler can detect it via `consumed:true`
      // on the dispatcher's response. The real list lands as the ACP
      // handler enriches `output` post-dispatch (see acp/server.ts).
      return {
        consumed: true,
        output: dim(':peers — see ACP handler for live list\r\n'),
      };
    }
    case 'capture': {
      if (!isWebTerm) {
        return { consumed: true, output: red(':capture is web-terminal only\r\n') };
      }
      // Heavy lift (sharp render + attachment-store write) lives in the
      // ACP handler so the dispatcher stays sync. Mark consumed so the
      // shell doesn't see ":capture"; the handler replaces output +
      // injectPath when it finishes.
      return {
        consumed: true,
        output: dim(':capture — rendering screenshot…\r\n'),
      };
    }
    case 'exit':
    case 'quit':
    case 'q': {
      return {
        consumed: true,
        exitRequested: true,
        output: dim('exit requested\r\n'),
      };
    }
    case 'budget': {
      return {
        consumed: true,
        output: dim(`session ${ctx.sessionId.slice(0, 8)}  ${sessionBudget(ctx.sessionId)}\r\n`),
      };
    }
    case 'session': {
      return {
        consumed: true,
        output: dim(`active session: ${ctx.sessionId}\r\n`),
      };
    }
    case 'provider': {
      if (args.length === 0 || args[0] === '') {
        const p = inspectActiveProvider(ctx.cfg);
        return {
          consumed: true,
          output: dim(`current: ${p.provider}/${p.model ?? '?'}\r\n`),
        };
      }
      const label = args[0]!;
      const { cfg: nextCfg, entry } = jumpToRotationEntry(ctx.cfg, label);
      if (!entry) {
        return {
          consumed: true,
          output: red(`no rotation entry matching "${label}"\r\n`),
        };
      }
      try { saveUserConfig(nextCfg); } catch { /* best-effort */ }
      const p = inspectActiveProvider(nextCfg);
      return {
        consumed: true,
        cfgUpdate: nextCfg,
        output: dim(`provider → ${p.provider}/${p.model ?? '?'} (label "${label}")\r\n`),
      };
    }
    case 'reload': {
      const refreshed = reloadUserConfig();
      return {
        consumed: true,
        cfgUpdate: refreshed,
        output: dim('reloaded ~/.config/elanous/config.json\r\n'),
      };
    }
    case 'history': {
      const loaded = loadSession(ctx.sessionId);
      if (!loaded) {
        return {
          consumed: true,
          output: red('no history (session not found)\r\n'),
        };
      }
      const lines: string[] = [
        dim(`${loaded.meta.messageCount} message(s) — last 3:`),
      ];
      for (const m of loaded.messages.slice(-3)) {
        const head = m.content.slice(0, 80).replace(/\s+/g, ' ');
        lines.push(dim(`  [${m.role}] ${head}${m.content.length > 80 ? '…' : ''}`));
      }
      return { consumed: true, output: lines.join('\r\n') + '\r\n' };
    }
    case 'fork': {
      const next = ensureCliSession(ctx.cfg);
      setActiveSessionId(next.id);
      setAmbientSessionId(next.id);
      return {
        consumed: true,
        sessionIdChange: next.id,
        output: dim(`forked → fresh session ${next.id.slice(0, 8)}\r\n`),
      };
    }
    case 'agent': {
      // WT-A-3b — `:agent <prompt>` runs an LLM turn against the active
      // web terminal's context (visible buffer + cwd + dimensions). The
      // dispatcher only marks the request; the ACP `terminal/repl/exec`
      // handler picks up `agentRequest` and routes to `runAgentTurn`
      // because that path has access to the daemon's history + tool
      // surface. Mirrors `:capture` (sync placeholder + handler
      // override).
      //
      // Phase 2: `:agent` without args = enter chat mode. Returns a
      // marker the caller (PWA TerminalRepl) uses to flip its UI into
      // chat mode where every subsequent plain-text input is
      // auto-prefixed with `:agent ` and routed through this same
      // path. Exits on `:exit` (caller observes `exitRequested` while
      // in chat mode).
      //
      // Phase 3: optional flags
      //   --scroll <N> : cap context buffer to last N lines
      //   --chat       : explicit chat-mode entry (alias for no-args)
      let scrollLines: number | undefined;
      let explicitChat = false;
      const prompt: string[] = [];
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i]!;
        if (a === '--chat') {
          explicitChat = true;
          continue;
        }
        if (a === '--scroll') {
          const n = Number.parseInt(args[i + 1] ?? '', 10);
          if (Number.isFinite(n) && n > 0) {
            scrollLines = n;
            i += 1;
            continue;
          }
          return {
            consumed: true,
            output: red(':agent --scroll requires a positive integer\r\n'),
          };
        }
        prompt.push(a);
      }
      const promptStr = prompt.join(' ').trim();
      if (!promptStr || explicitChat) {
        return {
          consumed: true,
          output: dim('agent chat mode — every line you type runs as a turn. type `:exit` to leave.\r\n'),
          agentChatModeEnter: true,
        };
      }
      const reqOut: { prompt: string; scrollLines?: number } = { prompt: promptStr };
      if (scrollLines !== undefined) reqOut.scrollLines = scrollLines;
      return {
        consumed: true,
        output: dim(`:agent — running${scrollLines ? ` (scroll=${scrollLines})` : ''}…\r\n`),
        agentRequest: reqOut,
      };
    }
    case 'attach':
    case 'clear-attachments': {
      // CLI-only commands — web-terminal uses a different attachment
      // mechanism (PWA upload via /v1/* endpoints). Return a friendly
      // hint rather than executing the CLI version (which would resolve
      // paths against the *daemon's* cwd, surprising the user).
      return {
        consumed: true,
        output: red(`:${cmd} is CLI-only — use the PWA attach UI for web terminals\r\n`),
      };
    }
    default: {
      return {
        consumed: true,
        output: red(`unknown command: :${cmd}  (try :help)\r\n`),
      };
    }
  }
}
