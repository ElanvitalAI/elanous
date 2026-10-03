// ── Onboarding wizard ──
//
// Six-step interactive setup, plain-TTY (not altscreen), runs once on
// first launch or any time the user types `elanous setup`. The flow:
//
//   1. LLM provider     — pick one, enter API key + optional model + optional baseUrl
//   2. Skill dirs       — preset picker (claudecode | opencode | codex | hermes | openclaw)
//                          with optional custom-path additions
//   3. Obsidian         — absolute vault path (defaults to current $OBSIDIAN_VAULT)
//   4. Telegram         — optional: bot token + home channel + allowed user IDs
//   5. Discord          — optional: bot token + home channel + allowed user IDs
//   6. Control plane    — optional: elanous-control supervisor + launchd plist
//                          (Step 5 follow-up · 2026-04-28 · double-check D ⭐⭐ closed)
//
// Design choice: we keep this as a plain prompt loop against process.stdin
// (or an injected IO adapter), NOT as a TUI widget. Reasons:
//   - Runs before the dashboard, so no TUI context yet.
//   - User may be SSH'd in or piping from another tool; altscreen adds
//     nothing and breaks redirect workflows.
//   - Testable — inject a script of lines and assert the resulting config.
//
// The wizard uses `process.stdin` in line-mode via node:readline. The
// WizardIO interface lets tests inject a fake line queue. Nothing in
// here reaches for getUserConfig() except at the very end for the
// back-fill merge — so tests don't need to stub config paths either.

import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isHeadlessEnv, spawnCodexLogin, type CodexLoginResult } from './acp/codex-auth.js';
import { getRunContext, type RunContext } from './agent/run-context.js';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  type UserConfig, type LLMProviderName, type SkillSetName,
  saveUserConfig, markOnboardingComplete, buildUserConfig,
  skillSetDir, SKILL_SET_NAMES, userConfigPath, urlRoutingDefaults, devRequestRoutingDefaults, defaultSkillDirs, resolveSkillSources,
} from './user-config.js';
import {
  GROK_MODEL, OPENAI_MODEL, ANTHROPIC_MODEL, LOCAL_LLM_MODEL, GEMINI_MODEL,
  KIMI_MODEL, QWEN_MODEL, GLM_MODEL,
} from './config.js';
import { CODEX_DEFAULT_MODEL } from './llm.js';
import { suggestSetupModel } from './model-tier/index.js';
import { loginWithCodex, CODEX_DEVICE_LOGIN_URL } from './oauth/codex.js';
import { loginWithCodexBrowser } from './oauth/codex-browser-login.js';
import { loadTokens } from './oauth/store.js';
import { browserUnavailableReason } from './oauth/browser-availability.js';
import { TelegramBot } from './telegram.js';
import { DiscordBot } from './discord.js';
import { pickCodexAuthMode, pickCodexModel } from './codex/setup.js';
import { getInventory, resolveBaseUrl } from './llm/local-manager/manager.js';
import { getMessages, format as i18nFormat } from './expression/i18n/index.js';
import type {
  ChoiceOption,
  ChooseOpts,
  StepSpec,
} from './onboarding/io-extended.js';
import { showStepOr, chooseFrom } from './onboarding/io-extended.js';
import { askWithHelp } from './onboarding/wire-helpers.js';
import { stepTransition } from './onboarding/transition.js';
import { unattendedSetupHint } from './onboarding/entry-hints.js';
import { continueHereLines } from './onboarding/continue-here.js';
import type { NexusShowResult } from './cli/nexus-show.js';
import type { TailscaleProbe } from './nexus/onboarding/tailscale-probe.js';
import type { IssuedTempToken } from './auth/temp-tokens.js';
import {
  askValidated,
  validateIntList,
  validatePath,
  validateTelegramToken,
  validateDiscordToken,
  validateApiKey,
  SubPromptBackError,
} from './onboarding/validators.js';
import { debug } from './debug/log.js';
import { detectProviderEnvKeys } from './setup/llm-env-detect.js';
import { resolveGrokCredential, type GrokCredential } from './grok/credential.js';

/** Yes/No picker — uses `chooseFrom` so fullScreenIO / widgetIO render
 *  arrow-key Yes/No buttons while scriptedIO/realIO fallback to a
 *  numbered prompt with `y` / `n` quick keys (preserves the existing
 *  scriptedIO test harness). PR-Δ2 (2026-04-28). PR-Δ16 (2026-04-28)
 *  added the optional `allowBack` flag — when set, a "← Back" option
 *  is appended; if the user picks it, this fn throws `WizardBackError`
 *  for the caller's runOnboarding step loop to catch. */
async function askYesNo(
  io: WizardIO,
  prompt: string,
  defaultYes: boolean,
  allowBack = false,
): Promise<boolean> {
  const options: ChoiceOption<boolean | WizardBackValue>[] = [
    { key: 'y', label: 'Yes', value: true },
    { key: 'n', label: 'No', value: false },
  ];
  if (allowBack) options.push(buildBackOption<boolean>());
  const v = await chooseFrom(io, prompt, options, {
    defaultIndex: defaultYes ? 0 : 1,
  });
  if (isBackPicked(v)) throw new WizardBackError();
  return v;
}

/** PR-Δ16 (Sprint 14 · 2026-04-28) · Back navigation sentinel.
 *
 *  Thrown by a step function when the user picks "← Back" in its
 *  main picker. `runOnboarding` catches the throw and rewinds to the
 *  previous step, preserving the partial config built so far so the
 *  prior step's prompts default to the user's last answers (already
 *  cached in `next` via the recap edit loop pattern).
 *
 *  Design choice: Back is opt-in per step — the caller adds the
 *  `← Back` option to its picker only when the wizard is past Step 1.
 *  Step 1 never offers Back (no prior step). For sub-prompts WITHIN
 *  a step (e.g. Telegram bot token after the enable Y/N), Back is
 *  intentionally not supported in this PR — that requires per-prompt
 *  state machine work tracked in BACKLOG §F2 follow-up. */
export class WizardBackError extends Error {
  constructor() {
    super('wizard back to previous step');
    this.name = 'WizardBackError';
  }
}

/** Build a "← Back to previous step" option to splice into a step's
 *  main picker when the caller should be allowed to rewind. The
 *  `value` is a Symbol-tagged unique sentinel so the step function
 *  can detect it cleanly without name collision with real values. */
const WIZARD_BACK_VALUE = Symbol.for('elanous-wizard-back');
type WizardBackValue = typeof WIZARD_BACK_VALUE;
function buildBackOption<T>(): ChoiceOption<T | WizardBackValue> {
  return {
    key: 'b',
    label: '← Back to previous step',
    value: WIZARD_BACK_VALUE as T | WizardBackValue,
  };
}
function isBackPicked(v: unknown): v is WizardBackValue {
  return v === WIZARD_BACK_VALUE;
}

// ── Setup-wizard step header — moved to showStepOr (PR γ) ──────────
//
// PR α introduced `localizedStepHeader` that printed a single-line box
// header through `io.print`. PR γ (this commit) swaps that for
// `showStepOr(io, spec)` so hosts that implement `showStep` can render
// a full single-screen view (palette + progress dots + excerpt) while
// the fallback keeps the same one-line shape.

// ── IO adapter ───────────────────────────────────────────────────────

/** Minimal IO surface so tests can drive the wizard from an array. */
export interface WizardIO {
  ask(prompt: string, field?: string): Promise<string>;
  /** Bundle 2' (2026-04-27) · optional password-style prompt — input
   *  echo replaced with `*` when stdin is a TTY. Falls back to plain
   *  `ask` (with a one-time warning) on non-TTY pipes / SSH-without-PTY
   *  / scripted tests. Step functions route through `askValidated()`
   *  with `opts.secret = true`, which picks `askSecret` when present
   *  and `ask` otherwise. */
  askSecret?(prompt: string, field?: string): Promise<string>;
  print(text: string): void;
  /** Synthetic, unattended IO (never issue or display a connection token). */
  nonInteractive?: boolean;
  /** Called once after a successful config save. */
  complete?(): void;
  close(): void;

  // ── Phase 2 (PR β · 2026-04-28) — extended surface ─────────────────
  //
  // All five methods are optional. Step functions use the `*Or` helpers
  // in `src/onboarding/io-extended.ts` so a host can opt into any
  // subset incrementally. Phase 3 (single-screen renderer · PR γ) wires
  // `showStep` to expression-spec output.

  /** Multi-choice picker. Renders the option list + collects a value.
   *  Hosts decide presentation (numbered, arrow keys, fuzzy search).
   *  `stepId` and `pickerId` are optional locale-independent identifiers;
   *  `options` is the exact list presented to the user. */
  choose?<T>(
    prompt: string,
    options: ChoiceOption<T>[],
    opts?: ChooseOpts,
    stepId?: string,
    pickerId?: string,
  ): Promise<T>;

  /** Render a step header with optional excerpt. Replaces the legacy
   *  `┌─ Step N / total — title ─` print pattern when implemented. */
  showStep?(spec: StepSpec): void;

  /** Render an inline error tied to a field. Hosts can colorize. */
  showError?(field: string, message: string): void;

  /** Render an inline help / placeholder hint. Hosts can mute. */
  showHelp?(field: string, message: string): void;

  /** Render an inline success message. Hosts can colorize green. */
  showSuccess?(message: string): void;
}

/** Bundle 2' raw-mode `askSecret` for `realIO`. Reads stdin char-by-char
 *  in raw mode and echoes `*`, supporting backspace + Ctrl+C. On
 *  non-TTY stdin (CI / piped input / SSH-without-PTY) it warns once and
 *  falls back to readline-style input — secret will be visible on screen
 *  but the operation still completes. */
async function realAskSecret(prompt: string): Promise<string> {
  if (!input.isTTY) {
    output.write('  (warn: stdin is not a TTY — input will be echoed)\n');
    const rl = readline.createInterface({ input, output, terminal: false });
    try { return (await rl.question(prompt)).trim(); }
    finally { rl.close(); }
  }
  return new Promise<string>((resolve) => {
    output.write(prompt);
    const chars: string[] = [];
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = (data: string) => {
      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          output.write('\n');
          cleanup();
          resolve(chars.join('').trim());
          return;
        }
        if (code === 3) {                    // Ctrl+C
          output.write('\n');
          cleanup();
          process.exit(130);
        }
        if (ch === '\b' || code === 127) {   // backspace / DEL
          if (chars.length > 0) {
            chars.pop();
            output.write('\b \b');
          }
          continue;
        }
        if (code < 32) continue;             // ignore other control chars
        chars.push(ch);
        output.write('*');
      }
    };
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      // NOTE: do NOT input.pause() here. The shared readline interface
      // (realIO's `rl`) keeps stdin flowing for follow-up `rl.question`
      // calls; pausing makes the next prompt receive EOF and silently
      // collapses the rest of the wizard (telegram allowedUsers / home
      // channel + step 5 entirely).
    };
    input.on('data', onData);
  });
}

/** Real readline-based IO. Bundle 2' (2026-04-27) adds an `askSecret`
 *  override that suppresses input echo for API keys and bot tokens.
 *  Plain prompts stay on readline so history / line editing still work.
 *
 *  Phase 3 (PR γ · 2026-04-28) wires `showStep` through the expression
 *  step-renderer so each step gets a colorized box header + progress
 *  dots + excerpt body in one call. Other Phase 2 helpers
 *  (`showError`/`showHelp`/`showSuccess`) get tinted single-line
 *  variants so wizards on a TTY pick up the visual immediately. */
export function realIO(): WizardIO {
  const rl = readline.createInterface({ input, output, terminal: input.isTTY });
  if (debug.enabled) {
    debug.log('onboarding.realIO.create', 'instantiated', {
      isTTY: !!input.isTTY,
      hasColors: typeof output.hasColors === 'function' ? output.hasColors() : 'unknown',
    });
  }
  return {
    ask: async (prompt) => (await rl.question(prompt)).trim(),
    askSecret: realAskSecret,
    print: (text) => { output.write(text + '\n'); },
    close: () => { rl.close(); },
    showStep: (spec) => {
      if (debug.enabled) {
        debug.log('onboarding.realIO.showStep', `step ${spec.index}/${spec.total}`, {
          index: spec.index,
          total: spec.total,
          title: spec.title,
        });
      }
      // Lazy imports — keeps the cold path (one-shot CLI commands)
      // out of the expression-renderer module graph.
      const { renderStepBlock } = require('./onboarding/step-renderer.js');
      const { progressDots } = require('./onboarding/progress.js');
      const profile = output.hasColors?.() ? 'truecolor' : 'mono';
      const dots = progressDots(spec.index, spec.total, { profile });
      const body = spec.excerpt
        ? spec.excerpt.split('\n').filter((l: string) => l.length > 0)
        : [];
      // Suffix the title with progress dots so the existing renderer's
      // header layout stays one line; the dots ride alongside the
      // counter without changing the box width math.
      const titleWithDots = `${spec.title}  ${dots}`;
      const block = renderStepBlock(spec.index, spec.total, titleWithDots, body);
      output.write('\n' + block + '\n');
    },
    showError: (field, message) => { output.write(`  \x1b[31m! ${field}: ${message}\x1b[0m\n`); },
    showHelp: (field, message) => { output.write(`  \x1b[2m↳ ${field}: ${message}\x1b[0m\n`); },
    showSuccess: (message) => { output.write(`  \x1b[32m✓ ${message}\x1b[0m\n`); },
  };
}

/** Bundle 1' (2026-04-27) · summary of one local-LLM model surfaced to
 *  the wizard's auto-probe step. Decoupled from local-manager's LlmModel
 *  on purpose — wizard only needs the picker fields + a pre-resolved
 *  baseUrl, not the cache-state details. */
export interface LocalLlmSummary {
  /** Model id (passed straight to the LLM call as `model:`). */
  id: string;
  /** Display label for the picker line. */
  label: string;
  /** Runtime hosting the model (display only — `'ollama'` / `'lmstudio'` / `'mlx'` / `'docker'`). */
  runtime: string;
  /** Node id (display only — distinguishes models in a multi-host fleet). */
  nodeId: string;
  /** OpenAI-compat base URL — what gets written to `llm.baseUrl`. */
  baseUrl: string;
}

/** Bundle 1' · DI hook so tests can stub the auto-probe without bringing
 *  in network/SSH calls. Default impl uses local-manager's
 *  `getInventory()` + `resolveBaseUrl()`. Returning `[]` makes the
 *  wizard fall through to the legacy manual-entry prompts. */
export interface LocalProbeDeps {
  probe?: () => Promise<LocalLlmSummary[]>;
}

export interface GrokOnboardingDeps {
  resolveCredential?: () => GrokCredential | null;
  /** Subscription detection for step 1 (OB1) — tests inject; default = `detectProviders`. */
  detectProviders?: () => Promise<import('./llm/provider-detect.js').DetectedProvider[]>;
  /** OB1 — does the codex CLI already hold a usable login (~/.codex/auth.json)? Tests inject. */
  hasCodexCliLogin?: () => boolean;
  loadCodexTokens?: typeof loadTokens;
  /** Browser-first OAuth test seams. Defaults use the local environment. */
  codexEnv?: NodeJS.ProcessEnv;
  isHeadless?: (env: NodeJS.ProcessEnv) => boolean;
  loginWithCodexBrowser?: typeof loginWithCodexBrowser;
  spawnCodexLogin?: (opts: { deviceAuth: false; codexPath: string }) => Promise<CodexLoginResult>;
  loginWithCodex?: typeof loginWithCodex;
  /** Execute local browser/clipboard commands without a shell. Returns false when unavailable. */
  runAuthCommand?: (command: string, args: string[], input?: string) => boolean;
  authPlatform?: NodeJS.Platform;
  /** OSC52 fallback, when clipboard commands are unavailable. */
  writeAuthTerminal?: (data: string) => boolean;
}

function pathCodexBinary(env: NodeJS.ProcessEnv): string | null {
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try { if (existsSync(candidate) && statSync(candidate).isFile()) return candidate; }
    catch { /* skip inaccessible PATH entries */ }
  }
  return null;
}

function runAuthCommand(command: string, args: string[], input?: string): boolean {
  try {
    const result = spawnSync(command, args, {
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
      timeout: 3_000,
    });
    return result.status === 0 && !result.error;
  } catch { return false; }
}

function assistCodexDeviceLogin(
  io: WizardIO,
  url: string,
  code: string,
  deps: GrokOnboardingDeps,
): void {
  const env = deps.codexEnv ?? process.env;
  const platform = deps.authPlatform ?? process.platform;
  const execute = deps.runAuthCommand ?? runAuthCommand;
  const local = !(deps.isHeadless ?? isHeadlessEnv)(env);
  const unavailable = browserUnavailableReason(env, platform);
  if (unavailable) {
    io.print(`  ${unavailable}`);
    debug.log('browser.open', 'skipped', { reason: unavailable.includes('ssh') ? 'ssh' : 'no-display' });
  } else if (local) {
    try {
      if (platform === 'darwin') execute('open', [url]);
      else if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') execute('xdg-open', [url]);
    } catch { /* browser is optional; URL remains visible */ }
  }
  let copied = false;
  for (const [command, args] of platform === 'darwin'
    ? [['pbcopy', []]] as Array<[string, string[]]>
    : platform === 'linux' || platform === 'freebsd' || platform === 'openbsd'
      ? [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]] as Array<[string, string[]]>
      : []) {
    try { if (execute(command, args, code)) { copied = true; break; } }
    catch { /* try the next clipboard */ }
  }
  if (!copied) {
    try {
      const write = deps.writeAuthTerminal ?? ((data: string) => {
        if (!output.isTTY) return false;
        output.write(data);
        return true;
      });
      copied = write(`\x1b]52;c;${Buffer.from(code).toString('base64')}\x07`);
    } catch { /* terminals without OSC52 still show the code */ }
  }
  if (copied) io.print('  코드를 복사했습니다.');
  if (local) notifyDeviceCode(code, copied, platform, execute);
}

/** OB5c — on a desktop, raise an OS notification with the code so the person can paste it without
 *  hunting for the terminal. Missing notifier (or headless) is skipped silently; the code never goes to logs. */
function notifyDeviceCode(
  code: string,
  copied: boolean,
  platform: NodeJS.Platform,
  execute: (command: string, args: string[], input?: string) => boolean,
): void {
  const message = copied ? `인증 코드 ${code} — 클립보드에 복사됨 · 붙여넣기만` : `인증 코드 ${code}`;
  let notified = false;
  try {
    if (platform === 'darwin') {
      const quoted = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      notified = execute('osascript', ['-e', `display notification ${quoted(message)} with title "Elanous"`]);
    } else if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
      notified = execute('notify-send', ['Elanous', message]);
    }
  } catch { /* no notifier — the code stays on screen */ }
  debug.log('onboarding.codex', 'device-code-notify', { platform, copied, notified });
}

/** Default probe — calls into the local-LLM manager's quad-probe
 *  (lmstudio + ollama + mlx + docker) and converts the inventory to
 *  the wizard's `LocalLlmSummary` shape. Models without a resolvable
 *  baseUrl are dropped (defensive — manager normally guarantees one
 *  when reachable, but cache races can produce stale entries). */
async function defaultLocalProbe(): Promise<LocalLlmSummary[]> {
  const inv = await getInventory();
  const out: LocalLlmSummary[] = [];
  for (const m of inv.models) {
    const baseUrl = resolveBaseUrl(m.nodeId, m.id);
    if (!baseUrl) continue;
    out.push({
      id: m.id,
      label: m.label,
      runtime: m.runtime,
      nodeId: m.nodeId,
      baseUrl,
    });
  }
  return out;
}

/** Script-driven IO for tests. Unused prompts throw so a changed wizard
 *  doesn't silently consume the script queue. */
export function scriptedIO(lines: string[]): WizardIO & { outputs: string[] } {
  const queue = [...lines];
  const outputs: string[] = [];
  return {
    outputs,
    ask: async (prompt) => {
      outputs.push(prompt);
      if (queue.length === 0) {
        throw new Error(`wizard asked more than scripted. Last prompt: ${prompt}`);
      }
      return queue.shift()!.trim();
    },
    print: (text) => { outputs.push(text); },
    close: () => {},
  };
}

// ── Step definitions ─────────────────────────────────────────────────

interface ProviderChoice {
  key: LLMProviderName;
  label: string;
  defaultModel?: string;
  needsBaseUrl: boolean;
  needsApiKey: boolean;
  /** Suggested base URL when `needsBaseUrl` is true. Local providers
   *  default to `http://localhost:11434/v1`; cloud providers with
   *  region/platform variants (Qwen DashScope intl vs China · GLM
   *  Z.ai vs BigModel) populate this so the wizard prompts users with
   *  the canonical cloud endpoint instead of the local-LLM default. */
  defaultBaseUrl?: string;
}

const PROVIDER_CHOICES: ProviderChoice[] = [
  { key: 'openai-codex', label: 'OpenAI Codex (ChatGPT subscription · OAuth)', defaultModel: CODEX_DEFAULT_MODEL, needsBaseUrl: false, needsApiKey: true },
  { key: 'local',        label: 'Local (LM Studio · MLX · Ollama — Apple Silicon preferred)', defaultModel: LOCAL_LLM_MODEL, needsBaseUrl: true, needsApiKey: false },
  { key: 'grok',         label: 'Grok (xAI)', defaultModel: GROK_MODEL, needsBaseUrl: false, needsApiKey: true },
  { key: 'openai',       label: 'OpenAI (ChatGPT)', defaultModel: OPENAI_MODEL, needsBaseUrl: false, needsApiKey: true },
  { key: 'anthropic',    label: 'Anthropic (Claude)', defaultModel: ANTHROPIC_MODEL, needsBaseUrl: false, needsApiKey: true },
  { key: 'gemini',       label: 'Google Gemini (gemini-2.5-flash / pro)', defaultModel: GEMINI_MODEL, needsBaseUrl: false, needsApiKey: true },
  // Chinese chat-model families · OpenAI-compatible. Open-weight
  // local variants (Kimi-VL · Qwen3.6 35B-A3B · GLM-4.5-Air etc.)
  // are pulled separately via the `local` flow above.
  { key: 'kimi',         label: 'Kimi (Moonshot · K2.6 1T MoE)', defaultModel: KIMI_MODEL, needsBaseUrl: false, needsApiKey: true },
  { key: 'qwen',         label: 'Qwen (Alibaba DashScope · Qwen3.6 family)', defaultModel: QWEN_MODEL, needsBaseUrl: true, needsApiKey: true,
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  { key: 'glm',          label: 'GLM (Zhipu · Z.ai · GLM-5.1 754B MoE)', defaultModel: GLM_MODEL, needsBaseUrl: true, needsApiKey: true,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { key: 'auto',         label: 'Auto-detect (pick from env at runtime)', needsBaseUrl: false, needsApiKey: false },
];

/** PLAN-model-intelligence-router · Phase B4 — decide whether the model
 *  prompt input is a concrete model id or a natural-language intent. A
 *  real model id is a single token; any whitespace means the user
 *  described their use, so route it through the setup suggester. Empty
 *  input keeps the manual/default path. */
export function looksLikeModelIntent(input: string): boolean {
  const t = (input ?? '').trim();
  return t.length > 0 && /\s/.test(t);
}

async function askLLM(
  io: WizardIO,
  current: UserConfig['llm'],
  localDeps: LocalProbeDeps = {},
  grokDeps: GrokOnboardingDeps = {},
  stepOpts: { allowBack?: boolean } = {},
): Promise<UserConfig['llm']> {
  showStepOr(io, {
    index: 1, total: 7,
    title: getMessages().setupStepLLMTitle,
    excerpt: getMessages().setupStepLLMExcerpt,
    severity: 'required',
  });
  // OB1 (10-01): show subscriptions the machine already has and preselect one — the old default was the env-only
  // «Auto-detect», so a ChatGPT/Codex or Grok subscriber pressing Enter got a setup that found nothing.
  let detected: import('./llm/provider-detect.js').DetectedProvider[] = [];
  try {
    const detect = grokDeps.detectProviders ?? (async () => (await import('./llm/provider-detect.js')).detectProviders());
    detected = await detect();
  } catch { /* detection is advisory — the list still works */ }
  const { subscriptionHint } = await import('./onboarding/subscription-hint.js');
  const hint = subscriptionHint(detected);
  for (const found of hint.found) io.print(found.line);
  const configured = current.provider && current.provider !== 'auto' ? current.provider : undefined;
  const currentIdx = PROVIDER_CHOICES.findIndex(c => c.key === (configured ?? hint.preferred));
  const providerOptions: ChoiceOption<ProviderChoice | WizardBackValue>[] =
    PROVIDER_CHOICES.map((c, i) => ({
      key: String(i + 1),
      label: c.label,
      value: c,
    }));
  if (stepOpts.allowBack) providerOptions.push(buildBackOption<ProviderChoice>());
  const choice = await chooseFrom(
    io,
    'Pick provider:',
    providerOptions,
    { defaultIndex: currentIdx >= 0 ? currentIdx : 0 },
    'llm',
    'provider',
  );
  if (isBackPicked(choice)) throw new WizardBackError();

  const out: UserConfig['llm'] = { provider: choice.key };
  const grokSubscription = choice.key === 'grok'
    && (grokDeps.resolveCredential ?? resolveGrokCredential)()?.kind === 'subscription';
  if (grokSubscription) io.print('  Found grok subscription (~/.grok/auth.json)');
  if (choice.key === 'auto') {
    io.print('  → auto mode: uses a subscription login it finds (ChatGPT/Codex ~/.codex · Grok ~/.grok) first, then XAI/OPENAI/ANTHROPIC/LOCAL_LLM env vars.');
    return out;
  }

  // Codex: delegate to the shared 1-point flow (auth mode → model pick).
  // Keeps onboarding and `elanous codex setup` in sync — one picker, one
  // curated model catalog, one source of truth for provider defaults.
  if (choice.key === 'openai-codex') {
    const mode = await pickCodexAuthMode(io, {
      ...(grokDeps.hasCodexCliLogin ? { hasCodexCliLogin: grokDeps.hasCodexCliLogin } : {}),
      ...(grokDeps.loadCodexTokens ? { loadTokens: grokDeps.loadCodexTokens } : {}),
    });
    if (mode === 'oauth') {
      const env = grokDeps.codexEnv ?? process.env;
      let signedIn = false;
      const why = browserUnavailableReason(env, grokDeps.authPlatform ?? process.platform);
      if (why) {
        io.print(`  ${why}`);
        debug.log('browser.open', 'skipped', { reason: why.includes('ssh') ? 'ssh' : 'no-display' });
      }
      if (!why && !(grokDeps.isHeadless ?? isHeadlessEnv)(env)) {
        // Full-screen IO retains print() messages across redraws. Keep this
        // waiting hint transient so it cannot reappear on the device-code screen.
        if (io.showStep) output.write('  브라우저에서 로그인을 마치세요 — 끝나면 자동으로 이어집니다.\n');
        else io.print('  브라우저에서 로그인을 마치세요 — 끝나면 자동으로 이어집니다.');
        try {
          await (grokDeps.loginWithCodexBrowser ?? loginWithCodexBrowser)();
          signedIn = true;
        } catch { /* try PATH Codex, then device code */ }
        if (!signedIn) {
          const codexPath = pathCodexBinary(env);
          if (codexPath) {
            try {
              const result = await (grokDeps.spawnCodexLogin ?? spawnCodexLogin)({ deviceAuth: false, codexPath });
              signedIn = result.ok;
            } catch { /* device code remains available */ }
          }
        }
        if (signedIn) io.print('  → ChatGPT/Codex 로그인을 씁니다.');
        else io.print('  브라우저 로그인이 안 됐습니다 — 코드로 이어갑니다');
      }
      if (!signedIn) {
        io.print('  코드로 로그인합니다…');
        try {
          await (grokDeps.loginWithCodex ?? loginWithCodex)({
            onProgress: (p) => {
              if (p.type === 'user_code') {
                io.print('');
                io.print(`    1) 아무 브라우저에서 열기: ${p.loginUrl}`);
                io.print(`    2) 코드 입력:             ${p.userCode}`);
                io.print('');
                assistCodexDeviceLogin(io, p.loginUrl ?? CODEX_DEVICE_LOGIN_URL, p.userCode ?? '', grokDeps);
                io.print('  로그인을 기다리는 중…');
              }
              if (p.type === 'saved') io.print('  로그인했습니다. 저장했습니다.');
            },
          });
        } catch (err: any) {
          io.print(`  ! OAuth failed: ${err?.message ?? err}`);
          io.print(`    Navigate to ${CODEX_DEVICE_LOGIN_URL} manually,`);
          io.print(`    or re-run \`elanous login openai-codex\` / \`elanous codex setup\` later.`);
        }
      }
    } else if (mode === 'apikey') {
      // PR-Δ14 — askValidated catches blank/short/whitespace before
      // saving. Caller can still keep the existing key by pressing
      // Enter (validator allows empty when current.apiKey is set).
      const key = await askValidated(
        io,
        '  OpenAI API key (sk-…): ',
        (v) => {
          const t = v.trim();
          if (!t) return current.apiKey ? null : 'API key required.';
          return validateApiKey('OpenAI API key')(t) as string | null;
        },
        { secret: true, maxAttempts: 3, topic: 'llm', field: 'apiKey' },
      );
      if (key.trim()) out.apiKey = key.trim();
      else if (current.apiKey) out.apiKey = current.apiKey;
    } else if (mode === 'oauth-keep') {
      io.print('  → using your existing ChatGPT/Codex login.');
    } else {
      io.print('  → skipped. Run `elanous codex setup` or `elanous login openai-codex` later.');
    }
    out.model = await pickCodexModel(io, current.model);
    return out;
  }

  // Bundle 1' (2026-04-27) · local provider auto-probe.
  // For `provider=local`, run the quad-probe (lmstudio + ollama + mlx +
  // docker) and pick a model from the inventory:
  //   - 0 found → print warn + fall through to manual baseUrl/model prompts
  //   - 1 found → auto-select (hermes `_auto_detect_local_model` pattern)
  //   - 2+      → numbered picker
  // Tests inject `localDeps.probe` to skip real network calls.
  if (choice.key === 'local') {
    io.print('  Probing local LLM endpoints (Ollama / LM Studio / MLX / Docker)…');
    const probe = localDeps.probe ?? defaultLocalProbe;
    let found: LocalLlmSummary[] = [];
    try {
      found = await probe();
    } catch (err: any) {
      io.print(`  ! probe failed: ${err?.message ?? err}`);
      io.print('  Falling back to manual entry.');
    }
    if (found.length === 1) {
      const m = found[0];
      io.print(`  ✓ Auto-selected: ${m.label} — ${m.runtime} on ${m.nodeId}`);
      out.baseUrl = m.baseUrl;
      out.model = m.id;
      return out;
    }
    if (found.length >= 2) {
      io.print(`  ${found.length} models found:`);
      found.forEach((m, i) => {
        io.print(`    ${i + 1}) ${m.label}  —  ${m.runtime} on ${m.nodeId}`);
      });
      const raw = await askWithHelp(io, `  Pick [1-${found.length}]: `, { topic: 'llm' });
      const n = raw.trim() === '' ? 1 : parseInt(raw, 10);
      const idx = Math.min(Math.max(n, 1), found.length) - 1;
      const m = found[idx];
      io.print(`  → ${m.label} (${m.runtime})`);
      out.baseUrl = m.baseUrl;
      out.model = m.id;
      return out;
    }
    // 0 found → fall through to legacy manual-entry prompts below.
    io.print('  No local LLM detected. Configure manually below — start');
    io.print('  Ollama (`ollama serve` + `ollama pull <model>`) or LM Studio,');
    io.print('  then re-run `elanous setup` for auto-detect.');
  }

  if (choice.needsApiKey) {
    // PR-Δ14 — Grok/OpenAI/Anthropic/Gemini API keys go through
    // `askValidated` so blank/short/whitespace mistakes get caught
    // before they're saved. Empty input is allowed when the user
    // already has a key on disk (validator returns null for blank).
    //
    // 2026-05-03 — also accept blank input when the canonical env var
    // is exported (XAI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY /
    // GEMINI_API_KEY etc.). The wizard now prints "Found in $VAR —
    // press Enter to use it" before the prompt and saves the env value
    // when the user accepts. Mirrors the inline /setup picker.
    // `auto` / `openai-codex` / `local` returned earlier — by here
    // `choice.key` is one of grok / openai / anthropic / gemini.
    const envDetection = detectProviderEnvKeys()[choice.key as Exclude<LLMProviderName, 'auto'>];
    const envValue = envDetection?.value;
    // A resolved grok subscription wins on blank input (see `defaulted` and the save branch below),
    // so the env-key hint would promise a key that is never saved. Only show it without a subscription.
    if (envValue && !grokSubscription) {
      io.print(`  Found in ${envDetection!.source} — press Enter to accept, or paste a different key.`);
      if (debug.enabled) debug.log('onboarding.askLLM.env-detect', choice.key, { source: envDetection!.source });
    }
    const defaulted = grokSubscription
      ? ' (press enter to use the subscription)'
      : envValue ? ` (press enter to use ${envDetection!.source})`
      : current.apiKey ? ' (press enter to keep existing)' : '';
    const key = await askValidated(
      io,
      `  ${choice.label} — API key${defaulted}: `,
      (v) => {
        const t = v.trim();
        if (!t) {
          if (grokSubscription || envValue || current.apiKey) return null;
          return `${choice.label} API key required.`;
        }
        return validateApiKey(`${choice.label} API key`)(t) as string | null;
      },
      { secret: true, maxAttempts: 3, topic: 'llm', field: 'apiKey' },
    );
    const trimmed = key.trim();
    if (trimmed) out.apiKey = trimmed;
    else if (envValue && !grokSubscription) out.apiKey = envValue;
    else if (current.apiKey && !grokSubscription) out.apiKey = current.apiKey;
  }
  // PLAN-model-intelligence-router · Phase B4 — the model prompt is
  // dual-purpose: type a concrete model id (a single token, e.g.
  // `claude-opus-4-7`) as before, OR describe your use in a sentence
  // ("주로 빠른 채팅이랑 가벼운 코딩") and we resolve a model once from
  // that intent (setup-once cadence ②). Intent is detected by whitespace
  // — a real model id never contains a space — so NO new prompt slot is
  // added and existing scripted flows (model id / blank) are unaffected.
  const modelDefault = current.model || choice.defaultModel || '';
  const modelInput = await askWithHelp(
    io,
    `  Model [${modelDefault}] (또는 용도를 한 줄로 적으면 자동 추천): `,
    { topic: 'llm', field: 'model' },
  );
  const trimmedModel = modelInput.trim();
  if (looksLikeModelIntent(trimmedModel)) {
    const suggestion = await suggestSetupModel(trimmedModel, { provider: choice.key });
    io.print(`  → 추천: ${suggestion.model} · ${suggestion.tier} tier — ${suggestion.rationale}`);
    out.model = suggestion.model;
  } else {
    out.model = trimmedModel || modelDefault || undefined;
  }

  if (choice.needsBaseUrl) {
    const baseDefault = current.baseUrl || choice.defaultBaseUrl || 'http://localhost:11434/v1';
    const url = await askWithHelp(io, `  Base URL [${baseDefault}]: `, { topic: 'llm', field: 'baseUrl' });
    out.baseUrl = url || baseDefault;
  }

  // BACKLOG #7 (2026-05-05) — answerPriority sub-step. Picks the
  // tool-loop budget tier so users don't have to hand-edit
  // ~/.config/elanous/config.json after onboarding. Default = balanced
  // (preserves prior behaviour for existing configs that omit the
  // field). Current value (if any) becomes the picker's defaultIndex
  // so re-running the wizard is a no-op for users who already chose.
  const ap = await askAnswerPriority(io, current.answerPriority);
  if (ap !== undefined) out.answerPriority = ap;

  return out;
}

/** BACKLOG #7 — answerPriority picker. 4 tiers map directly to the
 *  enum in `src/user-config.ts:LLMConfig.answerPriority`; descriptions
 *  surface the tradeoff (cost ↔ depth) so users pick informed.
 *
 *  Returns the chosen value, or undefined when the picker isn't shown
 *  (no IO support — extremely defensive; real wizards always have it). */
export type AnswerPriority = NonNullable<UserConfig['llm']['answerPriority']>;
export const ANSWER_PRIORITY_CHOICES: { key: string; value: AnswerPriority; label: string; description: string }[] = [
  { key: '1', value: 'cost',       label: 'cost',       description: '비용 최소 — claude 4 / codex 3 / gemini 4 turn (간단 답변, 빠름)' },
  { key: '2', value: 'balanced',   label: 'balanced',   description: '균형 — claude 12 / codex 6 / gemini 6 turn (default)' },
  { key: '3', value: 'quality',    label: 'quality',    description: '깊은 탐색 — claude 24 / codex 8 / gemini 16 turn (분석/디버깅 권장)' },
  { key: '4', value: 'exhaustive', label: 'exhaustive', description: '완성도 우선 — claude 50 / codex 12 / gemini 12 turn (비용 큼)' },
];

export async function askAnswerPriority(
  io: WizardIO,
  current: AnswerPriority | undefined,
): Promise<AnswerPriority | undefined> {
  const currentIdx = current
    ? ANSWER_PRIORITY_CHOICES.findIndex(c => c.value === current)
    : ANSWER_PRIORITY_CHOICES.findIndex(c => c.value === 'balanced');
  const options: ChoiceOption<AnswerPriority>[] = ANSWER_PRIORITY_CHOICES.map(c => ({
    key: c.key,
    label: c.label,
    value: c.value,
    description: c.description,
  }));
  const picked = await chooseFrom(
    io,
    'Answer depth (tool-loop budget per turn):',
    options,
    { defaultIndex: currentIdx >= 0 ? currentIdx : 1 },
    'llm',
    'answer-priority',
  );
  return picked;
}

// ── Step 2: skill dirs ───────────────────────────────────────────────

/** Built-in presets, in the order shown to the user. Sprint 10
 *  (2026-04-28) — claudecode promoted to default · new priority based
 *  on user feedback (claudecode → codex → openclaw → hermes → opencode). */
export const SKILL_PRESETS: { key: SkillSetName; label: string; dir: string | null }[] =
  (['claudecode', 'codex', 'openclaw', 'hermes', 'opencode'] as SkillSetName[])
    .map(k => ({ key: k, label: k, dir: skillSetDir(k) }));

async function askSkills(
  io: WizardIO,
  current: UserConfig['skills'],
  stepOpts: { allowBack?: boolean } = {},
): Promise<UserConfig['skills']> {
  showStepOr(io, {
    index: 2, total: 7,
    title: getMessages().setupStepSkillsTitle,
    excerpt: getMessages().setupStepSkillsExcerpt,
    severity: 'required',
  });
  const currentIdx = SKILL_PRESETS.findIndex(c => c.key === current.activeSet);
  type SkillChoiceValue = { kind: 'preset'; preset: typeof SKILL_PRESETS[number] } | { kind: 'custom' };
  const skillOptions: ChoiceOption<SkillChoiceValue | WizardBackValue>[] = SKILL_PRESETS.map((c, i) => {
    const here = c.dir && existsSync(c.dir) ? ' [exists]' : '';
    return {
      key: String(i + 1),
      label: `${c.label.padEnd(11)} ${c.dir ?? '(no canonical path)'}${here}`,
      value: { kind: 'preset' as const, preset: c },
    };
  });
  skillOptions.push({
    key: String(SKILL_PRESETS.length + 1),
    label: 'custom      (enter paths manually)',
    value: { kind: 'custom' as const },
  });
  if (stepOpts.allowBack) skillOptions.push(buildBackOption<SkillChoiceValue>());
  const skillChoice = await chooseFrom(
    io,
    'Pick skill preset:',
    skillOptions,
    {
      defaultIndex: currentIdx >= 0 ? currentIdx : 0,
      help: 'Pick the agent whose skills you mainly use — becomes the active preset. Custom = your own paths only.',
    },
    'skills',
    'preset',
  );
  if (isBackPicked(skillChoice)) throw new WizardBackError();

  let activeSet: SkillSetName = 'claudecode';
  const dirs: string[] = [];
  if (skillChoice.kind === 'preset') {
    activeSet = skillChoice.preset.key;
    if (skillChoice.preset.dir) {
      if (!existsSync(skillChoice.preset.dir)) {
        io.print(`  (warn: "${skillChoice.preset.dir}" does not exist yet — keeping anyway; create it later)`);
      }
      dirs.push(skillChoice.preset.dir);
    }
  } else {
    // Sprint 10b — custom path is a single-line input. Multi-dir
    // concept removed per user feedback ("멀티플로 디렉토리를
    // 지정하는 컨셉이 어색"). Switch to a single skill directory.
    activeSet = 'custom';
    const line = await askWithHelp(io, '  Skill directory path: ', { topic: 'skills', field: 'dir' });
    if (line) {
      if (!existsSync(line)) {
        io.print(`  (warn: "${line}" does not exist yet — keeping anyway; create it later)`);
      } else {
        try {
          if (!statSync(line).isDirectory()) {
            io.print(`  (warn: "${line}" is not a directory — skipping)`);
            return { activeSet, dirs, urlRouting: urlRoutingDefaults(), devRequestRouting: devRequestRoutingDefaults() };
          }
        } catch { /* stat failed, keep anyway */ }
      }
      dirs.push(line);
    }
  }

  if (dirs.length === 0) {
    io.print('  (warn: no skill dir configured — skills won\'t load until you edit config.json)');
  }

  return { activeSet, dirs, urlRouting: urlRoutingDefaults(), devRequestRouting: devRequestRoutingDefaults() };
}

// ── Step 3: Obsidian ─────────────────────────────────────────────────

async function askObsidian(io: WizardIO, current: UserConfig['obsidian']): Promise<UserConfig['obsidian']> {
  showStepOr(io, {
    index: 3, total: 7,
    title: getMessages().setupStepObsidianTitle,
    excerpt: getMessages().setupStepObsidianExcerpt,
    severity: 'optional',
    skipBehavior: getMessages().setupStepObsidianSkipBehavior,
  });
  io.print('│  Absolute path to your Obsidian vault root. Used by the');
  io.print('│  Obsidian browser pane and vault-save skills.');
  io.print('└───');
  // vault path validation — `allowEmpty: true` so blank input keeps the
  // current default (PR-Δ7 default-preserving variant). Non-blank input
  // is validated for is-directory if the path exists; missing paths are
  // accepted (the post-step `existsSync` warning still fires for users
  // who configure paths before creating them).
  const vault = await askWithHelp(io, `  Vault path [${current.vault}]: `, {
    topic: 'obsidian',
    field: 'vault',
    validate: validatePath({ allowEmpty: true, requireDir: true }),
  });
  const v = vault || current.vault;
  if (!existsSync(v)) {
    io.print(`  (warn: "${v}" does not exist — create it or reconfigure later)`);
  }
  return { vault: v };
}

// ── Step 4: Telegram ─────────────────────────────────────────────────

export interface TelegramOnboardingDeps {
  /** Override for tests: a custom fetch impl used when we validate the
   *  bot token via /getMe. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** When true (default), attempt to call /getMe after the user pastes
   *  a token so we can show the bot's username back and catch typos
   *  early. Tests set false when there's no network. */
  validateToken?: boolean;
}

async function askTelegram(
  io: WizardIO,
  current: UserConfig['telegram'],
  deps: TelegramOnboardingDeps = {},
  stepOpts: { allowBack?: boolean; allowSubBack?: boolean } = {},
): Promise<UserConfig['telegram']> {
  const validate = deps.validateToken !== false;
  const subBack = stepOpts.allowSubBack === true;
  showStepOr(io, {
    index: 4, total: 7,
    title: getMessages().setupStepTelegramTitle,
    excerpt: getMessages().setupStepTelegramExcerpt,
    severity: 'optional',
    skipBehavior: getMessages().setupStepTelegramSkipBehavior,
  });
  io.print('│  Chat with your agent from your phone via a Telegram bot.');
  io.print('│');
  io.print('│  To prepare:');
  io.print('│    1) DM @BotFather → /newbot → get a token like 12345:ABC...');
  io.print('│    2) DM @userinfobot → copy your numeric user id');
  io.print('│    3) Optional: DM @BotFather → /setprivacy → Disable (group chat)');
  io.print('│');
  io.print('│  Skip now by answering n; re-run `elanous setup` any time.');
  if (subBack) io.print('│  (type "back" at any sub-prompt to revise the previous one)');
  io.print('└───');
  const enable = await askYesNo(
    io,
    `Enable Telegram?${current.enabled ? ' (currently enabled)' : ''}`,
    current.enabled,
    stepOpts.allowBack,
  );
  if (!enable) {
    return { enabled: false, allowedUsers: [] };
  }

  // PR-Δ14 (Sprint 8 · 2026-04-28) · use the validators module's
  // `askValidated` for shape check (silent retry up to 3) instead of
  // an inline `Try again? [Y/n]` pre-input prompt.
  //
  // PR-Δ20 (Sprint 15 · 2026-04-29 · F9) · async API probe (`/getMe`)
  // moved INTO the same askValidated validator — bad token now retries
  // silently up to 3 times (shape error + API error share one budget)
  // instead of the prior single-shot probe that left a typo'd token
  // saved on disk and forced a re-run of `elanous setup telegram`.
  //
  // PR-Δ22 (Sprint 16 · 2026-04-30 · F2-sub) · sub-prompt Back state
  // machine. The 3 sub-prompts (token / users / home) run as a small
  // index-tracked loop. Each prompt is opt-in `allowSubBack` so
  // typing `back` / `b` throws SubPromptBackError; the loop catches
  // and rewinds subIdx by one. If subIdx is already 0 (back at the
  // first sub-prompt), re-throw WizardBackError so the step loop
  // rewinds to the prior step (Step 3 Obsidian) — preserving Δ16's
  // step-level Back contract for the Telegram→Obsidian boundary.
  // subBack stays off in nonInteractive / scripted contexts that
  // don't pass stepOpts.allowSubBack. The token sub-prompt's async
  // validator (Δ20) executes inside askValidated so shape error +
  // API error share the silent retry budget; validatedUsername /
  // homeChannel / allowedUsers are captured via outer let so each
  // sub-prompt re-entry replaces only its own slice while the rest
  // of the partial config persists across rewinds.
  let token: string | undefined = current.botToken;
  let validatedUsername: string | undefined;
  let allowedUsers: number[] = current.allowedUsers ?? [];
  let homeChannel: number | undefined = current.homeChannel;

  const subPrompts: Array<() => Promise<void>> = [
    async () => {
      const tokenInput = await askValidated(
        io,
        `  Bot token (from @BotFather)${current.botToken ? ' [press enter to keep existing]' : ''}: `,
        async (v) => {
          const t = v.trim() || current.botToken || '';
          if (!t) return 'Token required (or answer n above to skip Telegram).';
          if (!validate) return null;
          const shapeErr = validateTelegramToken()(t);
          if (shapeErr) return shapeErr as string;
          try {
            const bot = new TelegramBot({
              token: t, allowedUsers: [], onMessage: async () => undefined,
              fetchImpl: deps.fetchImpl,
            });
            const me = await bot.getMe();
            validatedUsername = me.username ?? me.firstName ?? String(me.id);
            if (debug.enabled) {
              debug.log('onboarding.telegram', 'getMe-success', { username: validatedUsername });
            }
            return null;
          } catch (err: any) {
            validatedUsername = undefined;
            if (debug.enabled) {
              debug.log('onboarding.telegram', 'getMe-failure', { message: err?.message ?? String(err) });
            }
            return `/getMe failed: ${err?.message ?? err}`;
          }
        },
        { secret: true, maxAttempts: 3, topic: 'telegram', field: 'botToken', allowSubBack: subBack },
      );
      token = tokenInput.trim() || current.botToken;
      if (validate && validatedUsername) {
        io.print(`  ✓ Connected as @${validatedUsername}`);
      } else if (validate && token && !validatedUsername) {
        io.print('  (continuing — re-run `elanous setup telegram` to retry token validation)');
      }
    },
    async () => {
      const usersRaw = await askWithHelp(
        io,
        '  Allowed Telegram user IDs (comma-separated; first = owner; blank = public): ',
        { topic: 'telegram', field: 'allowedUsers', validate: validateIntList(), allowSubBack: subBack },
      );
      allowedUsers = usersRaw
        .split(/[,\s]+/)
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isFinite(n));
      if (allowedUsers.length === 0) {
        io.print('  ↳ Skipped — public access mode. Anyone who DMs @<bot> can chat.');
        io.print('     To restrict later: re-run `elanous setup telegram` with allowed IDs.');
      }
    },
    async () => {
      const homeRaw = await askWithHelp(
        io,
        '  Home channel / chat ID for cron deliveries (optional, blank = same as owner DM): ',
        { topic: 'telegram', field: 'homeChannel', allowSubBack: subBack },
      );
      homeChannel = homeRaw ? parseInt(homeRaw.trim(), 10) : undefined;
    },
  ];

  let subIdx = 0;
  while (subIdx < subPrompts.length) {
    try {
      await subPrompts[subIdx]!();
      subIdx++;
    } catch (err) {
      if (err instanceof SubPromptBackError) {
        if (debug.enabled) {
          debug.log('onboarding.telegram.subBack', `rewind sub from ${subIdx}`, { subIdx });
        }
        if (subIdx === 0) throw new WizardBackError();
        subIdx -= 1;
        continue;
      }
      throw err;
    }
  }

  const next: UserConfig['telegram'] = {
    enabled: true,
    botToken: token,
    allowedUsers,
    homeChannel: Number.isFinite(homeChannel as number) ? homeChannel : undefined,
  };
  if (validatedUsername) io.print(`  → Start the bot with \`elanous telegram\`. Say hi to @${validatedUsername}!`);
  return next;
}

// ── Step 5: Discord (Bundle 3' · 2026-04-27) ─────────────────────────
//
// Mirrors the Telegram step almost line-for-line — the surface is the
// same (token + allowlist + home channel), only the IDs are Discord
// snowflake strings (kept as strings since 64-bit integers don't fit
// safely in JS numbers) and the validation endpoint is `/users/@me`
// instead of `/getMe`. PR-γ (#865) of the meta-registry arc landed the
// daemon-side discovery; this step lets the user point a bot at a
// daemon without hand-editing config.json.

export interface DiscordOnboardingDeps {
  /** Override for tests: a custom fetch impl used when we validate the
   *  bot token via `/users/@me`. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** When true (default), attempt to call `/users/@me` after the user
   *  pastes a token so we can echo the bot's username back and catch
   *  typos early. Tests set false when there's no network. */
  validateToken?: boolean;
}

async function askDiscord(
  io: WizardIO,
  current: UserConfig['discord'],
  deps: DiscordOnboardingDeps = {},
  stepOpts: { allowBack?: boolean; allowSubBack?: boolean } = {},
): Promise<UserConfig['discord']> {
  const validate = deps.validateToken !== false;
  const subBack = stepOpts.allowSubBack === true;
  showStepOr(io, {
    index: 5, total: 7,
    title: getMessages().setupStepDiscordTitle,
    excerpt: getMessages().setupStepDiscordExcerpt,
    severity: 'optional',
    skipBehavior: getMessages().setupStepDiscordSkipBehavior,
  });
  io.print('│  Chat with your agent in any Discord server / DM.');
  io.print('│');
  io.print('│  To prepare:');
  io.print('│    1) https://discord.com/developers/applications → New');
  io.print('│       Application → Bot tab → Reset Token → copy');
  io.print('│    2) On Discord client, enable Developer Mode (Settings →');
  io.print('│       Advanced) → right-click your name → Copy User ID');
  io.print('│    3) Bot tab → Privileged Gateway Intents → enable');
  io.print('│       Message Content Intent (required for DM replies)');
  io.print('│    4) OAuth2 → URL Generator → bot scope → invite to server');
  io.print('│');
  io.print('│  Skip now by answering n; re-run `elanous setup` any time.');
  if (subBack) io.print('│  (type "back" at any sub-prompt to revise the previous one)');
  io.print('└───');
  const enable = await askYesNo(
    io,
    `Enable Discord?${current.enabled ? ' (currently enabled)' : ''}`,
    current.enabled,
    stepOpts.allowBack,
  );
  if (!enable) {
    return { enabled: false, allowedUsers: [] };
  }

  // PR-Δ14 — same pattern as askTelegram: askValidated for shape +
  // single-attempt API probe. Bot tokens are paste-friendly so the
  // regex is permissive (long-enough + no whitespace).
  //
  // PR-Δ20 (Sprint 15 · 2026-04-29 · F9) · async `/users/@me` probe
  // moved INTO the same askValidated validator — bad token now silent-
  // retries up to 3 times (shape + API errors share one budget) so a
  // typo + reattempt succeeds without the wizard saving a broken
  // token. validatedUsername + validatedTag captured via outer let so
  // the post-prompt success line stays in sync with whichever attempt
  // actually passed.
  //
  // PR-Δ22b (Sprint 18 · 2026-04-30) · sub-prompt Back state machine
  // — mirrors the Δ22 askTelegram pattern. The 3 sub-prompts (token /
  // users / home) run as a small index-tracked loop. Each prompt is
  // opt-in `allowSubBack` so typing `back` / `b` throws
  // SubPromptBackError; the loop catches and rewinds subIdx by one. If
  // subIdx is already 0 (back at the first sub-prompt), re-throw
  // WizardBackError so the step loop rewinds to the prior step (Step
  // 4 Telegram) — preserving Δ16's step-level Back contract for the
  // Discord→Telegram boundary. subBack stays off in nonInteractive /
  // scripted contexts that don't pass stepOpts.allowSubBack.
  let token: string | undefined = current.botToken;
  let validatedUsername: string | undefined;
  let validatedTag: string | undefined;
  let validatedId: string | undefined;
  let allowedUsers: string[] = current.allowedUsers ?? [];
  let homeChannel: string | undefined = current.homeChannel;

  const subPrompts: Array<() => Promise<void>> = [
    async () => {
      const tokenInput = await askValidated(
        io,
        `  Bot token (from Discord Developer Portal)${current.botToken ? ' [press enter to keep existing]' : ''}: `,
        async (v) => {
          const t = v.trim() || current.botToken || '';
          if (!t) return 'Token required (or answer n above to skip Discord).';
          if (!validate) return null;
          const shapeErr = validateDiscordToken()(t);
          if (shapeErr) return shapeErr as string;
          try {
            const bot = new DiscordBot({
              token: t, allowedUsers: [], onMessage: async () => undefined,
              fetchImpl: deps.fetchImpl,
            });
            const me = await bot.getMe();
            validatedUsername = me.username;
            validatedId = me.id;
            validatedTag = me.discriminator && me.discriminator !== '0'
              ? `${me.username}#${me.discriminator}`
              : me.username;
            if (debug.enabled) {
              debug.log('onboarding.discord', 'usersMe-success', { username: validatedUsername, id: validatedId });
            }
            return null;
          } catch (err: any) {
            validatedUsername = undefined;
            validatedTag = undefined;
            validatedId = undefined;
            if (debug.enabled) {
              debug.log('onboarding.discord', 'usersMe-failure', { message: err?.message ?? String(err) });
            }
            return `/users/@me failed: ${err?.message ?? err}`;
          }
        },
        { secret: true, maxAttempts: 3, topic: 'discord', field: 'botToken', allowSubBack: subBack },
      );
      token = tokenInput.trim() || current.botToken;
      if (validate && validatedTag) {
        io.print(`  ✓ Connected as ${validatedTag} (id ${validatedId})`);
      } else if (validate && token && !validatedTag) {
        io.print('  (continuing — re-run `elanous setup discord` to retry token validation)');
      }
    },
    async () => {
      // Snowflake IDs — keep as strings (JS numbers can't represent
      // the full 64-bit range safely). Filter empties + non-digit
      // junk so a pasted "<@123>" mention or stray comma doesn't
      // poison the list. PR-Δ7 — validateIntList with
      // allowMentionWrappers strips `<@123>` / `<@!123>` shapes
      // before counting integer tokens, matching the Discord step's
      // paste-friendly contract.
      const usersRaw = await askWithHelp(
        io,
        '  Allowed Discord user IDs (snowflakes, comma-separated; first = owner): ',
        { topic: 'discord', field: 'allowedUsers', validate: validateIntList({ allowMentionWrappers: true }), allowSubBack: subBack },
      );
      allowedUsers = usersRaw
        .split(/[,\s]+/)
        .map(s => s.trim().replace(/^<@!?|>$/g, '')) // strip mention wrapper if pasted
        .filter(s => /^\d{15,}$/.test(s));
      if (allowedUsers.length === 0) {
        io.print('  (warn: empty allowlist → no one will be able to talk to the bot)');
      }
    },
    async () => {
      const homeRaw = await askWithHelp(
        io,
        '  Home channel ID for cron deliveries (optional, blank = none): ',
        { topic: 'discord', field: 'homeChannel', allowSubBack: subBack },
      );
      homeChannel = homeRaw && /^\d{15,}$/.test(homeRaw.trim()) ? homeRaw.trim() : undefined;
    },
  ];

  let subIdx = 0;
  while (subIdx < subPrompts.length) {
    try {
      await subPrompts[subIdx]!();
      subIdx++;
    } catch (err) {
      if (err instanceof SubPromptBackError) {
        if (debug.enabled) {
          debug.log('onboarding.discord.subBack', `rewind sub from ${subIdx}`, { subIdx });
        }
        if (subIdx === 0) throw new WizardBackError();
        subIdx -= 1;
        continue;
      }
      throw err;
    }
  }

  const next: UserConfig['discord'] = {
    enabled: true,
    botToken: token,
    allowedUsers,
    homeChannel,
  };
  if (validatedUsername) io.print(`  → Start the bot with \`elanous discord\`. Say hi to ${validatedUsername}!`);
  return next;
}

// ── Orchestrator ─────────────────────────────────────────────────────

export interface RunWizardOpts {
  io?: WizardIO;
  /** Path to config.json — defaults to userConfigPath(). Tests pass a tmp path. */
  path?: string;
  /** Existing config to prefill prompts with. When absent, built from disk (defaults if absent). */
  initial?: UserConfig;
  /** Telegram step dependency injection — defaults to real fetch + token validation ON. */
  telegramDeps?: TelegramOnboardingDeps;
  /** Bundle 3' (2026-04-27) · Discord step DI — same shape as
   *  telegramDeps but for `/users/@me` validation. */
  discordDeps?: DiscordOnboardingDeps;
  /** Bundle 1' · Local LLM probe DI for the LLM step. Defaults to
   *  `local-manager.getInventory()`; tests inject a stubbed list. */
  localProbeDeps?: LocalProbeDeps;
  /** Grok credential resolver DI for the LLM step. */
  grokDeps?: GrokOnboardingDeps;
  /** Internal ownership transfer for wrappers that explicitly complete IO. */
  deferComplete?: boolean;
  /** Post-save connections; injection keeps wizard tests off the real daemon/token store. */
  continueHereDeps?: {
    showNexus?: () => Promise<Pick<NexusShowResult, 'urls' | 'status' | 'instance'>>;
    probeTailscale?: () => Promise<TailscaleProbe>;
    issueToken?: () => Pick<IssuedTempToken, 'token'>;
    renderQr?: (link: string) => string | undefined;
  };
}

/** Pick the default IO. TTY → `fullScreenIO` (Phase 5: cleared
 *  viewport + centered rounded box on every key event). Non-TTY (CI ·
 *  pipe · automated tests) → `realIO` (line-by-line readline). Both
 *  feed the same step functions through the `WizardIO` interface, so
 *  the choice is purely about presentation. RESEARCH-tui-installer
 *  §5.A1 explicitly bans altscreen — `fullScreenIO` clears + redraws
 *  in the regular terminal so redirect / scrollback / IDE
 *  integration stay intact. */
export function defaultIO(): WizardIO {
  if (input.isTTY) {
    const { fullScreenIO } = require('./onboarding/full-screen-io.js');
    return fullScreenIO();
  }
  return realIO();
}

/** 대화형 온보딩을 거부해야 하는가 — **순수 판정**(2026-07-27).
 *
 * 주입된 IO는 호출자가 답을 공급하는 통로이므로 컨텍스트·TTY와 무관하게 통과한다.
 * 주입되지 않은 대화형 마법사는 사람의 TTY에서만 열 수 있고, 자율 컨텍스트에서는
 * TTY가 있더라도 열 수 없다. */
export function shouldRefuseInteractiveOnboarding(
  o: { ioInjected: boolean; ctx: RunContext; stdinIsTTY: boolean },
): boolean {
  if (o.ioInjected) return false;
  return o.ctx !== 'production' || !o.stdinIsTTY;
}

export class OnboardingRefusedError extends Error {
  readonly code = 'onboarding-refused' as const;

  constructor(message: string, readonly reason: 'non-tty' | 'autonomous-empty-universe') {
    super(message);
    this.name = 'OnboardingRefusedError';
  }
}

/** Handle only typed refusals; the agent setup hint applies to its non-TTY path alone. */
export function handleOnboardingRefusal(error: unknown, entrance: 'agent' | 'other'): boolean {
  if (!(error instanceof OnboardingRefusedError) || error.code !== 'onboarding-refused') return false;
  if (entrance === 'agent' && error.reason === 'non-tty') {
    console.error(`elanous agent needs a configured LLM. Run \`elanous onboarding\` in a terminal, or ${unattendedSetupHint()} for unattended setup.`);
  } else {
    console.error(error.message);
  }
  process.exitCode = 2;
  return true;
}

function refuseInteractiveOnboardingIfNeeded(opts: RunWizardOpts, path: string): void {
  const ctx = getRunContext();
  const stdinIsTTY = !!input.isTTY;
  if (!shouldRefuseInteractiveOnboarding({ ioInjected: !!opts.io, ctx, stdinIsTTY })) return;

  const nonTTY = !stdinIsTTY;
  debug.log('onboarding', nonTTY ? 'refused-non-tty' : 'refused-autonomous', {
    ctx,
    path,
    stdinIsTTY,
    why: nonTTY
      ? 'TTY 없는 stdin에서 대화형 온보딩 요청'
      : '자율 컨텍스트에서 대화형 온보딩 요청 — 우주가 비어 있다(물질화 누락)',
  }, { level: 'error' });
  if (nonTTY) {
    throw new OnboardingRefusedError(
      '대화형 온보딩은 stdin TTY가 있는 자리에서만 실행할 수 있다. '
      + `무인 설정은 ${unattendedSetupHint()}를 사용하라.`,
      'non-tty',
    );
  }
  throw new OnboardingRefusedError(
    `온보딩 마법사는 자율 컨텍스트(${ctx})에서 뜰 수 없다 — config 가 비어 있다(${path}). `
    + '자식 우주가 물질화되지 않았다는 뜻이다: `elanous config sync-test --state-dir <그 우주>` '
    + '로 깔거나, 스포너가 provisionDerivedUniverse 를 부르는지 확인하라.',
    'autonomous-empty-universe',
  );
}

/** Run the five-step wizard (LLM → Skills → Obsidian → Telegram →
 *  Discord). Writes the resulting config to disk and marks onboarding
 *  complete. Returns the saved config. */
export async function runOnboarding(opts: RunWizardOpts = {}): Promise<UserConfig> {
  const path = opts.path ?? userConfigPath();
  // defaultIO()가 stdin에 readline을 연결하기 전에 거부해, 무인 호출이 프롬프트를
  // 출력한 뒤 성공으로 끝나지 않게 한다.
  refuseInteractiveOnboardingIfNeeded(opts, path);
  const io = opts.io ?? defaultIO();
  if (debug.enabled) {
    debug.log('onboarding.runOnboarding.enter', 'start', {
      path,
      ioFromOpts: !!opts.io,
      hasShowStep: typeof io.showStep === 'function',
      hasShowError: typeof io.showError === 'function',
      ioKeys: Object.keys(io),
    });
  }
  const initial = opts.initial ?? buildUserConfig(path);
  try {
    const m = getMessages();
    io.print('');
    io.print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    io.print(`  ${m.setupBanner}`);
    io.print(`  ${i18nFormat(m.setupWritingTo, { path })}`);
    io.print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // PR-Δ16 (Sprint 14 · 2026-04-28) · Back navigation. Steps run as
    // an array indexed by `idx`; if a step throws `WizardBackError`
    // (user picked "← Back" on the step's main picker), idx rewinds by
    // one. The partial config is cached in `next` so the prior step's
    // prompts default to the user's last answers. Step 1 (LLM) doesn't
    // offer Back (no prior step). Step 3 (Obsidian) is text-input-only
    // so Back is intentionally skipped — users can revise via the
    // Step 7 wrap-up edit picker (Δ13).
    let next: UserConfig = { ...initial };
    const stepFns: Array<(canBack: boolean) => Promise<void>> = [
      async (back) => { next.llm = await askLLM(io, next.llm, opts.localProbeDeps ?? {}, opts.grokDeps ?? {}, { allowBack: back }); },
      async (back) => { next.skills = await askSkills(io, next.skills, { allowBack: back }); },
      async () => { next.obsidian = await askObsidian(io, next.obsidian); },
      async (back) => { next.telegram = await askTelegram(io, next.telegram, opts.telegramDeps ?? {}, { allowBack: back, allowSubBack: true }); },
      async (back) => { next.discord = await askDiscord(io, next.discord, opts.discordDeps ?? {}, { allowBack: back, allowSubBack: true }); },
      // M1-5 (PLAN-friction-free-model-selection-ux-2026-05-12 §4a.2)
      // Voice & AI behavior. Default path is "Smart defaults" — the
      // user picks one option and elanous runs Balanced tier on every
      // surface. Power users can pick a per-surface tier or set a
      // monthly USD cap. Sparse: when the user picks Smart defaults
      // the modelTier sub-tree stays absent from UserConfig.
      async (back) => {
        const { askVoiceAI } = await import('./onboarding/voice-ai.js');
        const answer = await askVoiceAI(
          io,
          {
            ...(next.modelTier ? { modelTier: next.modelTier } : {}),
            ...(next.budget ? { budget: next.budget } : {}),
          },
          { allowBack: back, index: 6, total: 7 },
        );
        if (answer.modelTier) next.modelTier = answer.modelTier;
        else delete next.modelTier;
        if (answer.budget) next.budget = answer.budget;
        else delete next.budget;
      },
    ];
    let idx = 0;
    while (idx < stepFns.length) {
      try {
        await stepFns[idx]!(idx > 0);
        // PR-Δ24 (Sprint 17 · 2026-04-30 · F11) — visual hint between
        // steps: one-line "Step N → N+1" + ~60ms pause so the user's
        // eye latches onto the boundary instead of the next step
        // popping in instantly. mono / non-TTY auto-skip via
        // stepTransition's internal guards. Only fires on forward
        // motion (not on Back rewind, where the user already saw a
        // step transition in the opposite direction).
        if (idx + 1 < stepFns.length) {
          await stepTransition(io, idx + 1, idx + 2);
        }
        idx++;
      } catch (err) {
        if (err instanceof WizardBackError) {
          idx = Math.max(0, idx - 1);
          if (debug.enabled) {
            debug.log('onboarding.runOnboarding.back', `rewind to step ${idx}`, { from: idx + 1 });
          }
          continue;
        }
        throw err;
      }
    }

    // β-followup (2026-04-28) · summary recap pre-save. Skipped in
    // non-interactive mode (the synthetic IO can't loop back to a
    // step) — detected via the IO's `print` being a no-op.
    //
    // Sprint 12 (2026-04-28) · the recap is rendered inside a dedicated
    // Step 7 (Wrap-up) so the user sees a clean "Setup Complete —
    // Review & Save" header instead of the recap clinging to the end of
    // Step 6 (Control plane). Steps 1-6 advertise total=7 above so the
    // progress dots account for this final review step.
    if (opts.io === undefined && !process.env.ELANOUS_SETUP_NO_RECAP) {
      // Lazy import keeps the help / summary modules out of the cold
      // path for `elanous setup --non-interactive`.
      const { showSummaryRecap } = await import('./onboarding/summary.js');
      showStepOr(io, {
        index: 7, total: 7,
        title: m.setupWrapUpTitle,
        excerpt: m.setupWrapUpExcerpt,
        severity: 'required',
      });
      let recap = await showSummaryRecap(io, next);
      while (recap.action === 'edit' && recap.editSection) {
        const sec = recap.editSection;
        if (sec === 'llm') next.llm = await askLLM(io, next.llm, opts.localProbeDeps ?? {}, opts.grokDeps ?? {});
        else if (sec === 'skills') next.skills = await askSkills(io, next.skills);
        else if (sec === 'obsidian') next.obsidian = await askObsidian(io, next.obsidian);
        else if (sec === 'telegram') next.telegram = await askTelegram(io, next.telegram, opts.telegramDeps ?? {});
        else if (sec === 'discord') next.discord = await askDiscord(io, next.discord, opts.discordDeps ?? {});
        recap = await showSummaryRecap(io, next);
      }
      if (recap.action === 'cancel') {
        io.print('  (cancelled — no config written)');
        return next;
      }
    }

    const marked = markOnboardingComplete(next);
    saveUserConfig(marked, path);

    io.print('');
    io.print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    io.print(`  ${m.setupComplete}`);
    // ER1 — first-run consent notice (default on · 대표 10-01): what is sent and how to turn it off.
    io.print('  오류가 나면 운영팀에 자동으로 알립니다(오류 내용·버전·무작위 설치 ID — 이름·메일 없이). 끄기: elanous config set errorReports.enabled false');
    io.print(`  Provider : ${marked.llm.provider}${marked.llm.model ? ` (${marked.llm.model})` : ''}`);
    // EN5 — show what the loader will actually read (resolveSkillSources), not the raw preset fields.
    const skillSources = resolveSkillSources(marked).filter((source) => source.enabled);
    io.print(`  Skills   : ${marked.skills.activeSet} — ${skillSources.length} dir(s)`);
    for (const source of skillSources) io.print(`             ${source.path}${source.kind === 'preset' ? '' : `  (${source.id})`}`);
    // EN9 — skills the person already has in another agent: one line, one command (registers in place, no copy).
    try {
      const { CONNECT_AGENTS, planConnect } = await import('./skills/connect.js');
      const active = defaultSkillDirs(marked);
      for (const agent of CONNECT_AGENTS) {
        const plan = planConnect(agent, active);
        if (plan.state === 'new') io.print(`  쓰던 스킬 ${plan.skills.length}개 찾음(${agent}) — 가져오려면: elanous connect ${agent}`);
      }
    } catch { /* advisory */ }
    // EN13 — a bot the person already runs elsewhere: one line, one command (values never shown).
    try {
      const { channelImportHint } = await import('./channel-import/run.js');
      const hint = channelImportHint();
      if (hint) io.print(`  ${hint}`);
    } catch { /* advisory */ }
    io.print(`  Obsidian : ${marked.obsidian.vault}`);
    io.print(`  Telegram : ${marked.telegram.enabled ? 'enabled' : 'disabled'}`);
    io.print(`  Discord  : ${marked.discord.enabled ? 'enabled' : 'disabled'}`);
    io.print(`  ${i18nFormat(m.setupRerunHint, { cmd: 'elanous setup' })}`);
    io.print('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const interactive = !io.nonInteractive && !!(opts.io || input.isTTY);
    let shown: Pick<NexusShowResult, 'urls' | 'status' | 'instance'> | undefined;
    try {
      const showNexus = opts.continueHereDeps?.showNexus ?? (async () => {
        const { runNexusShow } = await import('./cli/nexus-show.js');
        return runNexusShow({ format: 'json', out: { log: () => {}, error: () => {} } });
      });
      shown = await showNexus();
    } catch { /* Config was saved; daemon discovery is advisory. */ }
    const daemonRunning = shown?.status === 'unregistered'
      || (shown?.status === 'registered' && shown.instance?.alive === true);
    const pwaUrl = daemonRunning ? shown?.urls?.pwa.tailnet ?? shown?.urls?.pwa.loopback : undefined;
    let phoneLink: string | undefined;
    if (interactive && daemonRunning && shown?.urls?.rest) {
      try {
        const { pickPhoneBase, endpointFromBaseUrl, buildPhoneConnectLink } = await import('./cli/phone-link.js');
        const picked = pickPhoneBase(shown.urls.rest);
        const endpoint = endpointFromBaseUrl(picked.base);
        if (endpoint) {
          const issued = opts.continueHereDeps?.issueToken
            ? opts.continueHereDeps.issueToken()
            : await (async () => {
                const { issueTempToken, parseTtl } = await import('./auth/temp-tokens.js');
                return issueTempToken({ ttlMs: parseTtl('24h'), label: 'phone' });
              })();
          phoneLink = buildPhoneConnectLink(endpoint, issued.token);
          try { debug.log('onboarding.continue-here', 'phone-link-issued', { kind: picked.kind, tls: endpoint.tls, temp: true }); }
          catch { /* Logging must not interrupt setup. */ }
        }
      } catch { /* No token/link on failure; show the manual command instead. */ }
    }
    let tailscale: { host?: string } | undefined;
    let installed = false;
    let alive = false;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const probe = opts.continueHereDeps?.probeTailscale ?? (async () => {
        const { probeTailscale } = await import('./nexus/onboarding/tailscale-probe.js');
        return probeTailscale({ timeoutMs: 2000 });
      });
      const status = await Promise.race([
        probe(),
        new Promise<undefined>(resolve => { probeTimer = setTimeout(() => resolve(undefined), 2000); }),
      ]);
      if (status) {
        installed = status.installed;
        alive = status.alive;
        // A bare hostname has no HTTPS certificate — offer the command without an address.
        if (installed && alive) tailscale = status.magicDnsHost ? { host: status.magicDnsHost } : {};
      }
    } catch { /* Tailscale discovery is advisory. */ }
    finally { if (probeTimer) clearTimeout(probeTimer); }
    try { debug.log('onboarding.tailscale', 'probed', { installed, alive, offered: !!tailscale }); }
    catch { /* Logging must not interrupt setup. */ }
    const directions = continueHereLines({ daemonRunning, pwaUrl, phoneLink, telegramEnabled: marked.telegram.enabled, interactive, tailscale });
    if (io.nonInteractive) {
      for (const line of directions) process.stdout.write(`${line}\n`);
    } else {
      io.print('');
      for (const line of directions) io.print(line);
    }
    if (interactive && phoneLink) {
      try {
        const renderQr = opts.continueHereDeps?.renderQr ?? ((link: string) => {
          const qr = spawnSync('qrencode', ['-t', 'ANSIUTF8', link], { encoding: 'utf8' });
          return qr.status === 0 ? qr.stdout : undefined;
        });
        const qr = renderQr(phoneLink);
        if (qr) io.print(qr);
      } catch { /* qrencode is optional, exactly as with phone link. */ }
    }
    try { debug.log('onboarding.continue-here', 'shown', { daemonRunning, interactive, phoneLinkIssued: !!phoneLink, telegramEnabled: marked.telegram.enabled }); }
    catch { /* Logging must not interrupt setup. */ }
    if (!opts.deferComplete) io.complete?.();
    return marked;
  } finally {
    io.close();
  }
}

/** Check whether onboarding needs to run for a given config. */
export function needsOnboarding(cfg: UserConfig): boolean {
  return !cfg.onboarding.completed;
}

export function needsFirstRun(cfg: UserConfig): boolean {
  return !cfg.onboarding.completed && cfg.onboarding.ready !== true;
}

/** γ (2026-04-28) · per-step wizard. Runs ONE of the 5 steps,
 *  preserving every other field. Used by:
 *
 *    - `elanous setup llm` / `skills` / `obsidian` / `telegram` / `discord`
 *    - the dashboard `/setup <step>` slash
 *    - dotfile re-deploy when only one provider key has rotated
 *
 *  Saves the updated config to disk + marks onboarding complete (if
 *  it wasn't already). */
export type OnboardingStepId =
  | 'llm'
  | 'skills'
  | 'obsidian'
  | 'telegram'
  | 'discord'
  | 'voice-ai';

export async function runOnboardingStep(
  step: OnboardingStepId,
  opts: RunWizardOpts = {},
): Promise<UserConfig> {
  const path = opts.path ?? userConfigPath();
  // `elanous setup <step>` must apply the same pre-readline refusal as the
  // full wizard; otherwise piped invocations can print a prompt and exit 0.
  refuseInteractiveOnboardingIfNeeded(opts, path);
  const ownIo = opts.io === undefined;
  const io = opts.io ?? defaultIO();
  const initial = opts.initial ?? buildUserConfig(path);
  try {
    const next: UserConfig = { ...initial };
    if (step === 'llm') next.llm = await askLLM(io, initial.llm, opts.localProbeDeps ?? {}, opts.grokDeps ?? {});
    else if (step === 'skills') next.skills = await askSkills(io, initial.skills);
    else if (step === 'obsidian') next.obsidian = await askObsidian(io, initial.obsidian);
    else if (step === 'telegram') next.telegram = await askTelegram(io, initial.telegram, opts.telegramDeps ?? {});
    else if (step === 'discord') next.discord = await askDiscord(io, initial.discord, opts.discordDeps ?? {});
    else if (step === 'voice-ai') {
      const { askVoiceAI } = await import('./onboarding/voice-ai.js');
      const answer = await askVoiceAI(
        io,
        {
          ...(initial.modelTier ? { modelTier: initial.modelTier } : {}),
          ...(initial.budget ? { budget: initial.budget } : {}),
        },
        { index: 6, total: 7 },
      );
      if (answer.modelTier) next.modelTier = answer.modelTier;
      else delete next.modelTier;
      if (answer.budget) next.budget = answer.budget;
      else delete next.budget;
    }
    const marked = markOnboardingComplete(next);
    saveUserConfig(marked, path);
    io.complete?.();
    io.print('');
    io.print(`Step "${step}" updated. Config saved to ${path}`);
    return marked;
  } finally {
    if (ownIo) io.close();
  }
}

/** γ · non-interactive wizard. Resolves answers from the answer
 *  file + env + provided overrides, then runs the same 5 step
 *  functions with a synthetic IO that returns the resolved values
 *  without prompting. Returns the saved config. Throws if a
 *  required field can't be resolved (e.g. provider API key
 *  missing). */
export async function runOnboardingNonInteractive(
  opts: RunWizardOpts & {
    /** Path to the answer file. Defaults to
     *  `defaultAnswerFilePath()` (~/.config/elanous/setup-answers.json). */
    answerFilePath?: string;
    /** Override the resolved env when reading env-bridge layer. */
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<UserConfig> {
  // Lazy import — keeps `expression/config/` out of the cold path.
  const { nonInteractiveIO } = await import('./onboarding/non-interactive.js');
  const io = nonInteractiveIO({
    answerFilePath: opts.answerFilePath,
    env: opts.env,
  });
  const config = await runOnboarding({ ...opts, io, deferComplete: true });
  io.complete?.();
  return config;
}

/** Bundle 4' (2026-04-27) · flip the on-disk `onboarding.completed`
 *  marker back to false so the next `elanous` boot re-launches the
 *  wizard. Used by the `/setup reset` dashboard slash. Does not touch
 *  any other field — provider keys, telegram/discord tokens, skill
 *  paths, vault path all stay intact. The wizard's existing prompts
 *  use `current.*` defaults, so re-running just lets the user revisit
 *  / change individual answers without losing what's already there. */
export function resetOnboardingMarker(path?: string): UserConfig {
  const target = path ?? userConfigPath();
  const cfg = buildUserConfig(target);
  const next: UserConfig = {
    ...cfg,
    onboarding: { ...cfg.onboarding, completed: false },
  };
  saveUserConfig(next, target);
  return next;
}
