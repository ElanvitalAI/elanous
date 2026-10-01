// ── Codex 1-point setup ──
//
// Single-shot "log in + pick model + write config" flow. Composes the
// three pieces already shipped (oauth-codex.loginWithCodex, the model
// catalog, the user-config writer) into one UX:
//
//   elanous codex setup
//   /codex-setup          (from the TUI chat input)
//   onboarding wizard (step 1, codex branch)
//
// The function is pure orchestration — no TTY coupling — so the same
// code runs from the wizard (scriptedIO-driven, testable) and the
// CLI (realIO-driven, interactive). Callers supply a WizardIO so
// output flows where the user can see it.

import { loginWithCodex, CODEX_DEVICE_LOGIN_URL } from '../oauth/codex.js';
import { authStorePath, loadTokens } from '../oauth/store.js';
import { chooseFrom } from '../onboarding/io-extended.js';
import {
  CODEX_MODELS, findCodexModel, defaultCodexModel,
} from './models.js';
import {
  getUserConfig, saveUserConfig, markOnboardingComplete,
  type UserConfig,
} from '../user-config.js';
import type { WizardIO } from '../onboarding.js';

/** Auth modes:
 *   - oauth       → run the device-code flow (fresh login)
 *   - oauth-keep  → existing tokens on file, user opted to keep them
 *                   (no network call, just clear apiKey so OAuth wins
 *                   at provider-build time)
 *   - apikey      → prompt for / reuse an OpenAI API key
 *   - skip        → leave config as-is
 */
export type CodexAuthMode = 'oauth' | 'oauth-keep' | 'apikey' | 'skip';

export interface CodexSetupOpts {
  io: WizardIO;
  /** Existing config to mutate; defaults to current on-disk config. */
  initial?: UserConfig;
  /** Override the default save path (tests pass a tmp path). */
  path?: string;
  /** Inject a fetch impl for the OAuth call (tests). */
  fetchImpl?: typeof fetch;
  /** Inject sleep (tests set to no-op). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Poll-interval override for tests. */
  pollIntervalMs?: number;
  /** Skip the Codex CLI mirror write (tests). */
  mirrorCodex?: boolean;
  /** Mark onboarding.completed=true at the end. Default true for the
   *  CLI/slash paths (a successful setup means the user's done). */
  markComplete?: boolean;
}

export interface CodexSetupResult {
  authMode: CodexAuthMode;
  model: string;
  config: UserConfig;
}

// ── Picker helpers (shared with onboarding) ──────────────────────────

export interface CodexAuthModeDeps {
  loadTokens?: typeof loadTokens;
  /** OB1 — a codex CLI login (~/.codex/auth.json) the runtime already uses; default = `inspectSubscription`. */
  hasCodexCliLogin?: () => boolean;
}

export async function pickCodexAuthMode(io: WizardIO, deps: CodexAuthModeDeps = {}): Promise<CodexAuthMode> {
  const existing = (deps.loadTokens ?? loadTokens)('openai-codex');
  // OB1 (10-01): a user already signed in to the codex CLI was sent through the device-code flow again,
  // because only elanous's own token store counted. The runtime reads ~/.codex/auth.json, so it counts too.
  // Same judgment as the runtime (`codexOAuthAvailable` in llm.ts) — two judgments drifting apart was the bug.
  const codexCli = !existing && (deps.hasCodexCliLogin ?? (() => {
    try {
      const { codexOAuthAvailable } = require('../llm.js') as typeof import('../llm.js');
      return codexOAuthAvailable();
    } catch { return false; }
  }))();
  if (existing || codexCli) {
    if (existing) {
      const exp = existing.tokens.expiresAt;
      const when = exp != null
        ? (Date.now() > exp ? 'EXPIRED' : `${Math.round((exp - Date.now()) / 60000)}min left`)
        : 'no expiry tracked';
      io.print(`  OAuth tokens already on file (${when}).`);
    } else {
      io.print('  Found your ChatGPT/Codex login from the codex CLI (~/.codex/auth.json).');
    }
    // Sprint 11 — chooseFrom Yes/No so fullScreenIO renders the arrow
    // picker (with 'y'/'n' + 한글 자모 quick-pick from PR #986 + #988)
    // instead of a bare text input. The runner distinguishes 'oauth-keep'
    // from 'oauth' so existing tokens stay untouched (avoids burning a
    // rotation on an unnecessary refresh).
    const keep = await chooseFrom<boolean>(
      io,
      'Keep using existing OAuth tokens?',
      [
        { key: 'y', label: 'Yes — keep them', value: true },
        { key: 'n', label: 'No — re-run device-code flow', value: false },
      ],
      { defaultIndex: 0 },
      undefined,
      'codex-keep-tokens',
    );
    if (keep) return 'oauth-keep';
    io.print('  → re-running device-code flow.');
  }
  return chooseFrom<CodexAuthMode>(
    io,
    'Auth mode:',
    [
      { key: '1', label: 'OAuth (recommended — ChatGPT account via device code)', value: 'oauth' },
      { key: '2', label: 'API key (developer key from platform.openai.com)', value: 'apikey' },
      { key: '3', label: 'Skip — configure later via `elanous login openai-codex`', value: 'skip' },
    ],
    { defaultIndex: 0 },
    undefined,
    'codex-auth-mode',
  );
}

// ── Stale baseUrl guard ─────────────────────────────────────────────
//
// When a user has previously configured `provider: local` against LM
// Studio / Ollama / vLLM, their `llm.baseUrl` lands on a LAN host
// (e.g. http://192.168.0.50:1234/v1). Running `elanous codex setup`
// flips `provider` to openai-codex but — by design, for users who run
// a Codex-compatible proxy — preserves baseUrl. The result is every
// Codex request being routed to the local OpenAI-compatible server,
// which then rejects with "Invalid model identifier gpt-5.4" because
// it doesn't have OpenAI's hosted models downloaded.
//
// We can't distinguish "Codex proxy" from "orphan local-LLM URL"
// heuristically alone, but we can detect the strong signals (RFC 1918
// address, known LLM-server default ports) and ask the user to
// confirm before we write. Cleared baseUrl → wire requests hit
// chatgpt.com/backend-api/codex as intended.

/** True when a URL's host looks like a local/LAN address OR the port
 *  matches a well-known local-LLM-server default (1234 LM Studio,
 *  11434 Ollama). False for public hosts on other ports — those might
 *  be legitimate Codex-compatible proxies, so we don't prompt. */
export function looksLikeLocalLLMServer(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    // RFC 1918 private ranges.
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    // Known local-LLM-server default ports — even on a public host,
    // these are strong evidence of a misconfigured leftover.
    if (u.port === '1234' || u.port === '11434') return true;
    return false;
  } catch {
    return false;
  }
}

/** Prompt the user when an existing baseUrl smells like a stale
 *  local-LLM leftover. Returns the resolved value to write into the
 *  new config — either the original string (keep) or undefined (clear).
 *  Silent passthrough when baseUrl is empty or clearly non-local. */
export async function maybePromptStaleBaseUrl(
  io: WizardIO,
  existing: string | undefined,
): Promise<string | undefined> {
  if (!existing || !looksLikeLocalLLMServer(existing)) return existing;
  io.print('');
  io.print(`  Existing llm.baseUrl detected: ${existing}`);
  io.print('    Looks like a local/LAN OpenAI-compatible server (LM Studio / Ollama / vLLM).');
  io.print('    Codex requests will be routed there, not to chatgpt.com/backend-api/codex.');
  const decision = await chooseFrom<'clear' | 'keep'>(
    io,
    'Stale baseUrl detected — what to do?',
    [
      { key: '1', label: 'Clear — route to the ChatGPT Codex backend (recommended)', value: 'clear' },
      { key: '2', label: 'Keep — only correct if you run a Codex-compatible proxy at that URL', value: 'keep' },
    ],
    { defaultIndex: 0 },
  );
  if (decision === 'keep') {
    io.print('  → baseUrl kept. Verify the proxy forwards /responses with Codex semantics.');
    return existing;
  }
  io.print('  → baseUrl cleared. Codex calls will hit chatgpt.com/backend-api/codex.');
  return undefined;
}

export async function pickCodexModel(
  io: WizardIO,
  currentId?: string,
): Promise<string> {
  const defaultIdx = (() => {
    if (currentId) {
      const idx = CODEX_MODELS.findIndex(m => m.id === currentId);
      if (idx >= 0) return idx;
    }
    const recIdx = CODEX_MODELS.findIndex(m => m.recommended);
    return recIdx >= 0 ? recIdx : 0;
  })();
  type ModelChoice = { kind: 'preset'; id: string } | { kind: 'custom' };
  const options: Array<{
    key: string;
    label: string;
    value: ModelChoice;
    description?: string;
  }> = CODEX_MODELS.map((m, i) => ({
    key: String(i + 1),
    label: m.label ?? m.id,
    value: { kind: 'preset', id: m.id },
    description: m.recommended ? 'recommended' : undefined,
  }));
  options.push({
    key: String(CODEX_MODELS.length + 1),
    label: 'Custom — enter any model id supported by your account',
    value: { kind: 'custom' },
  });
  const choice = await chooseFrom<ModelChoice>(io, 'Pick a model:', options, {
    defaultIndex: defaultIdx,
    help: 'Codex CLI honors /v1/models — any id works.',
  });
  if (choice.kind === 'preset') return choice.id;
  // Custom path — empty input falls back to recommended.
  const custom = await io.ask('  Custom model id: ');
  return custom.trim() || defaultCodexModel().id;
}

// ── Orchestrator ─────────────────────────────────────────────────────

export async function runCodexSetup(opts: CodexSetupOpts): Promise<CodexSetupResult> {
  const { io } = opts;
  const initial = opts.initial ?? getUserConfig();
  try {
    return await runCodexSetupImpl(opts, initial);
  } finally {
    // Real readline-backed IO keeps stdin open until .close() is
    // called; callers expect a clean process exit after the flow.
    // Onboarding wraps its own close() — we wrap ours here so all
    // three entry points (CLI, slash, wizard) behave the same.
    try { io.close(); } catch { /* no-op */ }
  }
}

export function codexFreshLoginAuthLabel(): string {
  return `OAuth (fresh login, tokens at ${authStorePath()})`;
}

async function runCodexSetupImpl(
  opts: CodexSetupOpts,
  initial: UserConfig,
): Promise<CodexSetupResult> {
  const { io } = opts;
  io.print('');
  io.print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  io.print('  Codex 1-point setup');
  io.print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1) Auth mode
  const authMode = await pickCodexAuthMode(io);
  let apiKey: string | undefined = initial.llm.apiKey;

  if (authMode === 'oauth') {
    io.print('  Launching device-code flow…');
    try {
      await loginWithCodex({
        onProgress: (p) => {
          if (p.type === 'user_code') {
            io.print('');
            io.print(`    1) Open in any browser: ${p.loginUrl}`);
            io.print(`    2) Enter code:          ${p.userCode}`);
            io.print('');
            io.print('  Waiting for sign-in…');
          }
          if (p.type === 'saved') io.print('  Signed in. Tokens saved.');
        },
        fetchImpl: opts.fetchImpl,
        sleepImpl: opts.sleepImpl,
        pollIntervalMs: opts.pollIntervalMs,
        mirrorCodex: opts.mirrorCodex,
      });
      // OAuth implies we don't use apiKey — clear any stale one so the
      // Codex provider takes the OAuth branch.
      apiKey = undefined;
    } catch (err: any) {
      io.print(`  ! OAuth failed: ${err?.message ?? err}`);
      io.print(`    Navigate to ${CODEX_DEVICE_LOGIN_URL} manually if the browser didn't open,`);
      io.print(`    or re-run \`elanous login openai-codex\` later.`);
    }
  } else if (authMode === 'oauth-keep') {
    // User chose to keep the existing tokens — no network call, just
    // clear any legacy apiKey so the Codex provider picks up OAuth.
    const existing = loadTokens('openai-codex')!;
    const exp = existing.tokens.expiresAt;
    const when = exp != null
      ? (Date.now() > exp ? 'EXPIRED (will auto-refresh on next use)'
                          : `~${Math.round((exp - Date.now()) / 60000)}min left`)
      : 'no expiry tracked';
    io.print(`  → keeping existing OAuth tokens (${when}).`);
    apiKey = undefined;
  } else if (authMode === 'apikey') {
    const key = await io.ask('  OpenAI API key (sk-…): ');
    apiKey = key || initial.llm.apiKey;
    if (!apiKey) {
      io.print('  ! No key entered. You\'ll need to add llm.apiKey later.');
    }
  } else {
    io.print('  → skipped auth. Run `elanous login openai-codex` before first use.');
  }

  // 2) Model pick
  const model = await pickCodexModel(io, initial.llm.model);

  // 2.5) Stale baseUrl guard — see maybePromptStaleBaseUrl above. When
  //      the user previously ran against LM Studio / Ollama and now
  //      switches to Codex OAuth, the orphan baseUrl would silently
  //      hijack every Codex request. Ask before preserving it.
  const resolvedBaseUrl = await maybePromptStaleBaseUrl(io, initial.llm.baseUrl);

  // 3) Write config
  const nextCfg: UserConfig = {
    ...initial,
    llm: {
      provider: 'openai-codex',
      model,
      apiKey,
      baseUrl: resolvedBaseUrl,
    },
  };
  const marked = opts.markComplete === false ? nextCfg : markOnboardingComplete(nextCfg);
  saveUserConfig(marked, opts.path);

  io.print('');
  io.print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  io.print('  Codex setup complete');
  {
    const authLabel =
      authMode === 'oauth'      ? codexFreshLoginAuthLabel() :
      authMode === 'oauth-keep' ? 'OAuth (kept existing tokens)' :
      authMode === 'apikey'     ? (apiKey ? 'API key' : 'API key (unset — add llm.apiKey later)') :
                                  'skipped — run `elanous login openai-codex` before use';
    io.print(`  Auth mode : ${authLabel}`);
  }
  io.print(`  Model     : ${model}`);
  const m = findCodexModel(model);
  if (m) io.print(`              ${m.label} — ${m.description}`);
  io.print('');
  io.print('  Try it:');
  io.print('    elanous chat "write a function that reverses a linked list"');
  io.print('');
  io.print('  Change model later:  edit llm.model in ~/.config/elanous/config.json');
  io.print('                       or re-run `elanous codex setup`.');
  io.print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  return { authMode, model, config: marked };
}
