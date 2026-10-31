// Coding-agent terminal preset.
//
// Thin wrapper over TerminalSessionRegistry that knows how to spawn
// a "live agent host" session (claude-code / codex / grok) with:
//
//   • ELANOUS_SESSION_ID env so the child can self-identify in any
//     scripts/hooks it runs
//   • TERM=xterm-ghostty for rich color/terminfo
//   • CLICOLOR_FORCE so agents that detect piping still emit color
//   • Auto hint-registry nudge ("prefer observing over spawning") so
//     follow-up model turns don't blindly re-spawn another modal
//   • Binary validation via `which` so the user sees a clean error
//     instead of a spawned sh that immediately reports "command
//     not found"

import { spawnSync } from 'node:child_process';
import type { CodingAgentBrand, TerminalSession, TerminalSessionRegistry } from './session-registry.js';
import { wrapCommandForKeychainUnlock } from './keychain-unlock.js';
import { buildPtyEnv } from '../agent/identity-env.js';
import type { ChromeControlResult } from '../ui/modal-adapter.js';

export interface SpawnCodingAgentOpts {
  brand: CodingAgentBrand;
  cwd: string;
  /** Optional stable UUID used to bind scoped mission-line authority to this PTY. */
  id?: string;
  /** Extra CLI args to pass through after the binary name. */
  extraArgs?: string[];
  /** Override title. Defaults to `<brand> [<basename(cwd)>]`. */
  title?: string;
  env?: Record<string, string>;
  /** Forwarded to InteractiveTerminalModal so /claude and /codex
   *  popups inherit the BrowserPreview-style title-bar `[ ─ ]` /
   *  `[ ✕ ]` controls. The dashboard maps the action to detach or
   *  kill against the session registry. Without this, title clicks
   *  on coding-agent popups would silently no-op. */
  onTitleAction?: (action: 'copy' | 'minimize' | 'close') => ChromeControlResult;
  /** PTY exit hook. Forwarded to registry.spawn so the dashboard
   *  can react to claude/codex termination (typed `exit`, child
   *  killed externally, etc.) — close the modal, push a chatline,
   *  redraw. Matches the shape registry.spawn already accepts. */
  onExit?: (session: TerminalSession, code: number | null) => void;
}

export interface SpawnCodingAgentDeps {
  registry: TerminalSessionRegistry;
  termCols: number;
  termRows: number;
  /** When provided, called after successful spawn so a host can
   *  register a session-scope hint. Keeps the hint registry out of
   *  this module's imports (tests don't pay the cost). */
  onSpawned?: (session: TerminalSession) => void;
  /** Test seam for `which` — returns absolute path or null. */
  whichBinary?: (name: string) => string | null;
  /** Test seam — overrides the SSH/macOS keychain-unlock command
   *  wrap. Default uses real env detection. */
  wrapCommand?: (cmd: string) => string;
}

export class CodingAgentBinaryMissing extends Error {
  constructor(public readonly binary: string) {
    super(`${binary} binary not found in PATH`);
    this.name = 'CodingAgentBinaryMissing';
  }
}

export function spawnCodingAgent(
  opts: SpawnCodingAgentOpts,
  deps: SpawnCodingAgentDeps,
): TerminalSession {
  const binary = binaryForBrand(opts.brand);
  const which = deps.whichBinary ?? defaultWhich;
  if (which(binary) === null) {
    throw new CodingAgentBinaryMissing(binary);
  }

  const cwdName = basenameSafe(opts.cwd);
  const title = opts.title ?? `${opts.brand} [${cwdName}]`;
  const extraArgs = opts.extraArgs ?? (opts.brand === 'grok' ? ['--always-approve'] : undefined);
  const rawCommand = extraArgs && extraArgs.length > 0
    ? `${binary} ${extraArgs.join(' ')}`
    : binary;
  // Only `claude` reads the macOS keychain — codex does not. Gate
  // the SSH unlock preamble on brand to avoid spawning a `sh -c`
  // wrapper for codex sessions.
  const command = opts.brand === 'claude-code'
    ? (deps.wrapCommand ?? wrapCommandForKeychainUnlock)(rawCommand)
    : rawCommand;

  // Start from the captured login env so the child PTY gets HOME,
  // USER, PATH, LOGNAME, etc. PreviewTerminal replaces (not merges)
  // when `opts.env` is provided, so without this prefix the spawned
  // shell would see a 4-var env and `$HOME` would expand to "" —
  // breaking `security unlock-keychain "$HOME/Library/…"` in the
  // SSH keychain wrap and any other path-relative lookup. The
  // captured env mirrors what a fresh Terminal.app login would see
  // (see shell-env-bootstrap.ts), so it's the right baseline.
  const callerEnv = { ...(opts.env ?? {}) };
  const grokAuthEnvKeys = ['XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY'] as const;
  if (opts.brand === 'grok') for (const key of grokAuthEnvKeys) delete callerEnv[key];
  const env: Record<string, string> = buildPtyEnv({
    ...callerEnv,
    ...(opts.brand === 'grok' ? { GROK_DISABLE_API_KEY_AUTH: '1' } : {}),
    ELANOUS_AGENT_BRAND: opts.brand,
    // Session id is filled in below once we know it.
    TERM: 'xterm-ghostty',
    // COLORTERM=truecolor — needed for prompt themes (p10k, starship)
    // to render 24-bit. SSH strips COLORTERM by default and our
    // captured login env strips it in the seed phase, so we set it
    // explicitly to match xterm-ghostty's truecolor capability.
    COLORTERM: 'truecolor',
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
  }, process.env, { unset: opts.brand === 'grok' ? grokAuthEnvKeys : [] });

  const session = deps.registry.spawn(
    {
      id: opts.id,
      title,
      cwd: opts.cwd,
      command,
      env,
      kind: 'coding-agent',
      agentBrand: opts.brand,
      termName: 'xterm-ghostty',
      onTitleAction: opts.onTitleAction,
      onExit: opts.onExit,
    },
    { termCols: deps.termCols, termRows: deps.termRows },
  );

  // Backfill ELANOUS_SESSION_ID now that we have the id. The PTY
  // inherits the env at spawn time; we can't mutate it after the
  // fact, so the child sees ELANOUS_AGENT_BRAND without the id.
  // That's acceptable for P9 — any script that needs the id can
  // fetch it from the socket API (follow-up).

  try { deps.onSpawned?.(session); } catch { /* swallow */ }
  return session;
}

// ─── Internals ──────────────────────────────────────────────────

function binaryForBrand(brand: CodingAgentBrand): string {
  switch (brand) {
    case 'claude-code': return 'claude';
    case 'codex':       return 'codex';
    case 'gemini':      return 'gemini';
    case 'grok':        return 'grok';
  }
}

function defaultWhich(name: string): string | null {
  try {
    const r = spawnSync('command', ['-v', name], { stdio: ['ignore', 'pipe', 'ignore'] });
    const out = r.stdout?.toString().trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function basenameSafe(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
