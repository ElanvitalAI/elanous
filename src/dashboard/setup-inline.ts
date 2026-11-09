import { DiscordBot } from '../discord.js';
import { addRotationEntry, rotationEntryLabel } from '../user-config.js';
import type { LLMProviderName, RotationEntry, UserConfig } from '../user-config/types.js';
import { BUILTIN_CATALOG } from '../intelligence-map/model-catalog.js';
import type { ModelEntry } from '../intelligence-map/types.js';
import { getInventory } from '../llm/local-manager/manager.js';
import { freemem, totalmem } from 'node:os';
import { validateApiKey, validateDiscordToken, validateIntList } from '../onboarding/validators.js';
import { SelectView, type SelectOption } from '../ui/widgets/select-view.js';
import { EditView, createPromptEditView } from '../ui/widgets/edit-view.js';
import { debug } from '../debug/log.js';
import {
  detectProviderEnvKeys,
  listEnvDetectedProviders,
  summarizeAuxiliaryAiEnv,
  type DetectableProvider,
  type ProviderEnvDetection,
  type ProviderEnvDetectionMap,
} from '../setup/llm-env-detect.js';
import {
  mountViewAsModalSurface,
  formatChromeControlsTitleRight,
  type ModalShadowSpec,
  type ViewSurfaceHandle,
} from '../ui/modal-adapter.js';
import { BoxView, TextView, type View } from '../ui/view.js';
import { LinearLayout } from '../ui/layout/linear.js';
import { resolveWidgetChromeBoxViewOptions } from '../ui/declarative/index.js';
import type { WidgetChromeSpec } from '../ui/declarative/spec.js';
import { resolvePickerChromePresentation, resolvePickerChromeSpec } from '../ui/chrome/picker-chrome.js';
import { DEFAULT_CLOSE_GLYPH } from '../ui/chrome/control-glyphs.js';
import { themeColor, colorize, type ThemeTokens } from '../theme/tokens.js';
import { createActionPickerView, type ActionItem } from '../mouse-action-recipes.js';
import type { ModalBounds, ModalSurface } from '../display/modal-stack.js';

export const DASHBOARD_SETUP_INLINE_TARGETS = ['provider', 'discord', 'local-llm'] as const;
export type DashboardSetupInlineTarget = typeof DASHBOARD_SETUP_INLINE_TARGETS[number];

export interface DashboardProviderSetupOption {
  provider: LLMProviderName;
  label: string;
  description: string;
  /** Human-readable label for the API-key prompt + validator. */
  apiKeyLabel: string;
  /** Display label for the rotation entry. */
  rotationLabel: string;
  /** Setup branch:
   *  - 'apiKey'      classic API key prompt (anthropic / gemini / grok / openai)
   *  - 'codex'       OAuth-or-apikey-or-skip (delegates to popup wizard)
   *  - 'local'       4-runtime probe (delegates to popup wizard)
   *  - 'auto'        no key, just save provider:'auto' */
  flow: 'apiKey' | 'codex' | 'local' | 'auto';
}

export const DASHBOARD_PROVIDER_SETUP_OPTIONS: readonly DashboardProviderSetupOption[] = [
  {
    provider: 'anthropic',
    label: 'Anthropic',
    description: 'Claude · API key (ANTHROPIC_API_KEY)',
    apiKeyLabel: 'Anthropic API key',
    rotationLabel: 'Anthropic',
    flow: 'apiKey',
  },
  {
    provider: 'gemini',
    label: 'Google Gemini',
    description: 'Google · API key (GEMINI_API_KEY / GOOGLE_API_KEY)',
    apiKeyLabel: 'Google Gemini API key',
    rotationLabel: 'Google Gemini',
    flow: 'apiKey',
  },
  {
    provider: 'grok',
    label: 'Grok',
    description: 'xAI · API key (XAI_API_KEY / GROK_API_KEY)',
    apiKeyLabel: 'Grok API key',
    rotationLabel: 'Grok',
    flow: 'apiKey',
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    description: 'OpenAI · API key (OPENAI_API_KEY)',
    apiKeyLabel: 'OpenAI API key',
    rotationLabel: 'OpenAI',
    flow: 'apiKey',
  },
  {
    provider: 'openai-codex',
    label: 'OpenAI Codex',
    description: 'ChatGPT OAuth or API key · runs in popup wizard',
    apiKeyLabel: 'OpenAI API key',
    rotationLabel: 'OpenAI Codex',
    flow: 'codex',
  },
  {
    provider: 'local',
    label: 'Local (Ollama / LM Studio)',
    description: 'OpenAI-compatible · auto-probe 4 runtimes (LOCAL_LLM_URL)',
    apiKeyLabel: 'Local LLM base URL',
    rotationLabel: 'Local LLM',
    flow: 'local',
  },
  {
    provider: 'auto',
    label: 'Auto-detect at runtime',
    description: 'Pick first available provider from env every call',
    apiKeyLabel: '',
    rotationLabel: 'Auto',
    flow: 'auto',
  },
  // Chinese cloud chat families · all OpenAI-compatible. Local
  // open-weight variants (e.g. qwen3.6:35b-a3b, glm-z1:32b) live
  // under the separate 'Local LLM' setup target.
  {
    provider: 'kimi',
    label: 'Kimi (Moonshot)',
    description: 'api.moonshot.cn · K2.6 1T MoE · vision · 256K ctx',
    apiKeyLabel: 'Moonshot Kimi API key',
    rotationLabel: 'Kimi',
    flow: 'apiKey',
  },
  {
    provider: 'qwen',
    label: 'Qwen (Alibaba)',
    description: 'DashScope intl · Qwen3.6 Max/Plus/Flash · 1M ctx',
    apiKeyLabel: 'DashScope API key',
    rotationLabel: 'Qwen',
    flow: 'apiKey',
  },
  {
    provider: 'glm',
    label: 'GLM (Zhipu)',
    description: 'Z.ai / BigModel · GLM-5.1 754B MoE · MIT open',
    apiKeyLabel: 'Zhipu / Z.ai API key',
    rotationLabel: 'GLM',
    flow: 'apiKey',
  },
] as const;

export interface DashboardDiscordSetupInput {
  token: string;
  allowedUsers: string[];
  homeChannel?: string;
}

export function findProviderSetupOption(
  provider: string,
): DashboardProviderSetupOption | null {
  return DASHBOARD_PROVIDER_SETUP_OPTIONS.find((item) => item.provider === provider) ?? null;
}

export function getSavedProviderRotationEntry(
  cfg: UserConfig,
  provider: LLMProviderName,
): RotationEntry | null {
  const rotation = cfg.llm.rotation ?? [];
  const exact = rotation.find((entry) => entry.provider === provider && entry.apiKey);
  if (exact) return exact;
  if (cfg.llm.provider === provider && cfg.llm.apiKey) {
    return {
      provider,
      apiKey: cfg.llm.apiKey,
      label: findProviderSetupOption(provider)?.rotationLabel,
    };
  }
  return null;
}

export function applyDashboardProviderSetup(
  cfg: UserConfig,
  option: DashboardProviderSetupOption,
  apiKey: string,
): UserConfig {
  const withRotation = addRotationEntry(cfg, {
    provider: option.provider,
    apiKey,
    label: option.rotationLabel,
  });
  return {
    ...withRotation,
    llm: {
      ...withRotation.llm,
      provider: option.provider,
      apiKey,
      model: undefined,
      baseUrl: undefined,
    },
  };
}

export function parseDiscordAllowedUsers(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((part) => part.trim().replace(/^<@!?/, '').replace(/>$/, ''))
    .filter((part) => /^\d{15,}$/.test(part));
}

export function applyDashboardDiscordSetup(
  cfg: UserConfig,
  input: DashboardDiscordSetupInput,
): UserConfig {
  return {
    ...cfg,
    discord: {
      enabled: true,
      botToken: input.token,
      allowedUsers: [...input.allowedUsers],
      homeChannel: input.homeChannel || undefined,
    },
  };
}

interface DashboardInlineSetupFlowDeps {
  termSize: () => { cols: number; rows: number };
  getUserConfig: () => UserConfig;
  saveUserConfig: (cfg: UserConfig) => void;
  reloadUserConfig: () => UserConfig;
  pushModal: (surface: ModalSurface) => { dispose(): void };
  getTheme?: () => ThemeTokens | undefined;
  draw: () => void;
  notifyInfo?: (text: string) => void;
  notifySuccess?: (text: string) => void;
  notifyWarning?: (text: string) => void;
  notifyError?: (text: string) => void;
  /** Optional. Launches the popup-terminal wizard at a specific
   *  legacy step (`elanous setup llm`). Used for `openai-codex` /
   *  `local` providers whose flows still live in the wizard
   *  (oauth, local probe). When omitted, codex/local picks fall
   *  back to a notice that asks the user to run `elanous setup llm`. */
  launchPopupWizard?: (step: 'llm') => void;
  /** Optional override for env scan — set in tests. */
  readEnv?: () => NodeJS.ProcessEnv;
}

interface PickerItem<T> {
  value: T;
  label: string;
  description?: string;
}

interface OpenTextPromptSpec {
  title: string;
  body: string[];
  initialValue?: string;
  placeholder?: string;
  secret?: boolean;
  validate?: (value: string) => string | null | Promise<string | null>;
  onSubmit: (value: string) => void | Promise<void>;
  onCancel?: () => void;
}

export interface DashboardInlineSetupFlow {
  open(target?: DashboardSetupInlineTarget): void;
}

export function createDashboardInlineSetupFlow(
  deps: DashboardInlineSetupFlowDeps,
): DashboardInlineSetupFlow {
  let activeCleanup: (() => void) | null = null;

  const closeActive = (): void => {
    if (!activeCleanup) return;
    const cleanup = activeCleanup;
    activeCleanup = null;
    try { cleanup(); } catch { /* ignore */ }
  };

  const mountHandle = (handle: ViewSurfaceHandle): void => {
    closeActive();
    // 2026-05-05 — fix key up/down + click input on setup popup.
    //
    // Key bug: relied on modal-adapter's default `onKey: handleKey`
    // wiring, but the explicit assignment is the documented contract
    // (mirror of context-menu-presenter.ts:165-170 pattern). Some
    // dispatch paths skip surfaces whose `onKey` ref isn't a direct
    // hard-bound function, so be explicit.
    //
    // Mouse bug: previous wrapper called handle.handleMouse(ev) but
    // ALWAYS returned `{type:'none'}` — coordinator interpreted that
    // as "passthrough", so even though the SelectView's row click
    // fired internally, the dispatcher kept routing the event past
    // the popup (no draw refresh, no consumption). The
    // context-menu-presenter pattern returns `{type:'refresh'}` on
    // consumed → triggers redraw + tells coordinator to stop.
    handle.surface.onKey = handle.handleKey;
    handle.surface.onMouse = (ev) =>
      handle.handleMouse(ev) === 'consumed'
        ? { type: 'refresh' }
        : { type: 'none' };
    const originalDispose = handle.surface.dispose?.bind(handle.surface);
    const mounted = deps.pushModal(handle.surface);
    activeCleanup = () => {
      try { handle.dispose(); } catch { /* ignore */ }
      try { mounted.dispose(); } catch { /* ignore */ }
    };
    const cleanupRef = activeCleanup;
    handle.surface.dispose = () => {
      if (activeCleanup === cleanupRef) activeCleanup = null;
      originalDispose?.();
    };
    deps.draw();
  };

  const saveAndReload = (nextCfg: UserConfig): void => {
    deps.saveUserConfig(nextCfg);
    deps.reloadUserConfig();
  };

  const openPicker = <T>(spec: {
    id: string;
    title: string;
    items: PickerItem<T>[];
    onPick: (value: T) => void;
    onCancel?: () => void;
  }): void => {
    const options: SelectOption<number>[] = spec.items.map((item, index) => ({
      value: index,
      label: item.label,
      description: item.description,
    }));
    const bounds = centeredBounds(deps.termSize(), {
      width: Math.max(38, Math.min(76, widestOptionWidth(options) + 10)),
      height: Math.min(spec.items.length, 10) + 5,
    });
    const presentation = resolvePickerChromePresentation({
      title: spec.title,
      primaryAction: 'select',
      cancelAction: 'close',
      browseMode: true,
      filterable: spec.items.length > 8,
      chromeSpec: {
        titleAlign: 'center',
      },
      maxWidth: bounds.width,
    });
    const select = new SelectView<number>({
      options,
      searchable: spec.items.length > 8,
      browseMode: true,
      visibleRows: Math.min(spec.items.length, 10),
      footerHint: spec.items.length > 8 ? presentation.footerHint : '',
      onSubmit: (picked) => {
        const item = spec.items[picked as number];
        if (!item) return;
        spec.onPick(item.value);
      },
      onCancel: spec.onCancel,
    });
    const handle = mountSurface({
      id: spec.id,
      title: spec.title,
      view: select,
      bounds,
      theme: deps.getTheme?.(),
      chromeSpec: presentation.chromeSpec,
      onClose: spec.onCancel,
    });
    mountHandle(handle);
  };

  const openTextPrompt = (spec: OpenTextPromptSpec): void => {
    const edit = createPromptEditView({
      initialValue: spec.initialValue,
      placeholder: spec.placeholder,
      maskChar: spec.secret ? '*' : undefined,
      onCancel: spec.onCancel,
      onSubmit: (value) => {
        void (async () => {
          const err = spec.validate ? await spec.validate(value) : null;
          if (err) {
            deps.notifyWarning?.(err);
            deps.draw();
            return;
          }
          closeActive();
          await spec.onSubmit(value);
          deps.draw();
        })();
      },
    });
    const bodyView = buildPromptBody(spec.body, edit);
    const handle = mountSurface({
      id: `setup-inline:${spec.title.toLowerCase().replace(/\s+/g, '-')}`,
      title: spec.title,
      view: bodyView,
      bounds: centeredBounds(deps.termSize(), {
        width: Math.min(84, Math.max(48, longestLine(spec.body, spec.placeholder) + 8)),
        height: Math.max(8, spec.body.length + 5),
      }),
      theme: deps.getTheme?.(),
      onClose: spec.onCancel,
    });
    mountHandle(handle);
  };

  const openDiscordHomePrompt = (input: DashboardDiscordSetupInput): void => {
    const current = deps.getUserConfig().discord;
    openTextPrompt({
      title: 'Setup · Discord',
      body: [
        'Home channel is optional.',
        'Leave blank to keep DM-only / manual delivery.',
        '',
        'Enter a Discord channel snowflake or press Enter on empty input.',
      ],
      initialValue: current.homeChannel ?? input.homeChannel ?? '',
      placeholder: '123456789012345678 (optional)',
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return null;
        return /^\d{15,}$/.test(trimmed)
          ? null
          : 'Home channel must be a Discord snowflake or blank.';
      },
      onCancel: () => {
        openDiscordAllowedUsersPrompt(input);
      },
      onSubmit: async (value) => {
        const nextCfg = applyDashboardDiscordSetup(deps.getUserConfig(), {
          ...input,
          homeChannel: value.trim() || undefined,
        });
        saveAndReload(nextCfg);
        deps.notifySuccess?.('Discord setup saved.');
      },
    });
  };

  const openDiscordAllowedUsersPrompt = (input: Pick<DashboardDiscordSetupInput, 'token'>): void => {
    const current = deps.getUserConfig().discord;
    openTextPrompt({
      title: 'Setup · Discord',
      body: [
        'Paste one or more allowed Discord user IDs.',
        'Comma or whitespace separated. Mention shapes like <@123> also work.',
        '',
        'First ID is typically your owner/operator account.',
      ],
      initialValue: current.allowedUsers.join(', '),
      placeholder: '123..., 456...',
      validate: (value) => validateIntList({ allowMentionWrappers: true })(value),
      onCancel: () => {
        openDiscordTokenPrompt();
      },
      onSubmit: async (value) => {
        const allowedUsers = parseDiscordAllowedUsers(value);
        if (allowedUsers.length === 0) {
          deps.notifyWarning?.('Allowlist is empty. The bot will refuse everyone until you add a user ID.');
        }
        openDiscordHomePrompt({
          token: input.token,
          allowedUsers,
          homeChannel: current.homeChannel,
        });
      },
    });
  };

  const openDiscordTokenPrompt = (): void => {
    const current = deps.getUserConfig().discord;
    openTextPrompt({
      title: 'Setup · Discord',
      body: [
        'Configure the Discord bot token first.',
        'Developer Portal → Application → Bot → Reset Token.',
        '',
        'The token is verified with Discord `/users/@me` before saving.',
      ],
      initialValue: current.botToken ?? '',
      placeholder: 'paste Discord bot token',
      secret: true,
      validate: async (value) => {
        const trimmed = value.trim();
        if (!trimmed) return 'Discord bot token required.';
        const shapeErr = validateDiscordToken()(trimmed);
        if (shapeErr) return shapeErr;
        try {
          const bot = new DiscordBot({
            token: trimmed,
            allowedUsers: [],
            onMessage: async () => undefined,
          });
          const me = await bot.getMe();
          deps.notifyInfo?.(`Connected as ${me.discriminator && me.discriminator !== '0' ? `${me.username}#${me.discriminator}` : me.username} (${me.id}).`);
          return null;
        } catch (err: any) {
          return `/users/@me failed: ${err?.message ?? err}`;
        }
      },
      onSubmit: async (value) => {
        openDiscordAllowedUsersPrompt({ token: value.trim() });
      },
    });
  };

  const scanEnv = (): ProviderEnvDetectionMap =>
    detectProviderEnvKeys(deps.readEnv?.() ?? process.env);

  const openProviderApiKeyPrompt = (
    option: DashboardProviderSetupOption,
  ): void => {
    const cfg = deps.getUserConfig();
    const existing = getSavedProviderRotationEntry(cfg, option.provider);
    const envDetection = option.provider !== 'auto'
      ? scanEnv()[option.provider as DetectableProvider]
      : undefined;
    const envHasKey = envDetection?.value;
    const placeholder = existing?.apiKey
      ? '(keep existing saved key)'
      : envHasKey
        ? `(found in ${envDetection!.source} — press Enter to use)`
        : `paste ${option.apiKeyLabel}`;
    const body: string[] = [`${option.label} · API key.`];
    if (envHasKey) body.push(`Detected in env: ${envDetection!.source}.`);
    if (existing?.apiKey) body.push('Saved key on disk — Enter to keep it.');
    body.push('');
    body.push(envHasKey
      ? 'Press Enter to accept the env value, or paste a different key.'
      : existing?.apiKey
        ? 'Press Enter on blank input to keep the existing saved key.'
        : `Enter ${option.apiKeyLabel}.`);
    openTextPrompt({
      title: `Setup · ${option.label}`,
      body,
      initialValue: '',
      placeholder,
      secret: true,
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed && (existing?.apiKey || envHasKey)) return null;
        if (!trimmed) return `${option.apiKeyLabel} required.`;
        return validateApiKey(option.apiKeyLabel)(trimmed);
      },
      onCancel: () => {
        openProviderPicker();
      },
      onSubmit: async (value) => {
        const trimmed = value.trim();
        const apiKey = trimmed || envHasKey || existing?.apiKey;
        if (!apiKey) {
          deps.notifyWarning?.(`${option.apiKeyLabel} required.`);
          return;
        }
        const source: 'typed' | 'env' | 'saved' =
          trimmed ? 'typed' : envHasKey ? 'env' : 'saved';
        if (debug.enabled) {
          debug.log('setup.provider.save', `${option.provider}/${source}`, {
            provider: option.provider,
            source,
            envSource: envDetection?.source,
          });
        }
        const nextCfg = applyDashboardProviderSetup(deps.getUserConfig(), option, apiKey);
        saveAndReload(nextCfg);
        const note = source === 'env'
          ? ` (from ${envDetection!.source})`
          : source === 'saved' ? ' (kept saved key)' : '';
        deps.notifySuccess?.(`${option.label} saved and activated${note}.`);
      },
    });
  };

  const openAutoProviderConfirm = (): void => {
    const detection = scanEnv();
    const detected = listEnvDetectedProviders(detection);
    const summary = detected.length > 0
      ? `Will pick first available of: ${detected.join(', ')}.`
      : 'No provider env vars detected — auto will fail until you export at least one.';
    openPicker({
      id: 'setup-inline:auto-confirm',
      title: 'Setup · Auto-detect',
      items: [
        { value: 'save' as const, label: 'Save provider = auto', description: summary },
        { value: 'cancel' as const, label: 'Back to provider list' },
      ],
      onCancel: () => openProviderPicker(),
      onPick: (choice) => {
        if (choice === 'cancel') { openProviderPicker(); return; }
        const cfg = deps.getUserConfig();
        const next: UserConfig = {
          ...cfg,
          llm: { ...cfg.llm, provider: 'auto', apiKey: undefined, model: undefined, baseUrl: undefined },
        };
        if (debug.enabled) {
          debug.log('setup.provider.save', 'auto', { detected });
        }
        saveAndReload(next);
        deps.notifySuccess?.(`Auto-detect saved. ${summary}`);
      },
    });
  };

  const openCodexOrLocalRedirect = (option: DashboardProviderSetupOption): void => {
    const isCodex = option.flow === 'codex';
    const cmd = 'elanous setup llm';
    const lines = isCodex
      ? [
          'OpenAI Codex needs the popup wizard for OAuth + model picker.',
          `Will launch \`${cmd}\` in a popup terminal.`,
          'Pick "OpenAI Codex" in the wizard and follow the OAuth flow.',
        ]
      : [
          'Local LLM auto-probes Ollama / LM Studio / MLX / Docker via the popup wizard.',
          `Will launch \`${cmd}\` in a popup terminal.`,
          'Pick "Local" in the wizard — found models become a one-key picker.',
        ];
    openPicker({
      id: `setup-inline:${option.provider}-redirect`,
      title: `Setup · ${option.label}`,
      items: [
        { value: 'launch' as const, label: 'Launch popup wizard', description: cmd },
        { value: 'cancel' as const, label: 'Back to provider list' },
      ],
      onCancel: () => openProviderPicker(),
      onPick: (choice) => {
        if (choice === 'cancel') { openProviderPicker(); return; }
        if (deps.launchPopupWizard) {
          if (debug.enabled) {
            debug.log('setup.provider.popup-launch', option.provider, { reason: option.flow });
          }
          // Show the rationale lines as toasts so the user has context
          // when the popup overlays the dashboard.
          for (const line of lines) deps.notifyInfo?.(line);
          deps.launchPopupWizard('llm');
        } else {
          deps.notifyWarning?.(`Run \`${cmd}\` to set up ${option.label}.`);
        }
      },
    });
  };

  const dispatchProviderPick = (provider: LLMProviderName): void => {
    const option = findProviderSetupOption(provider);
    if (!option) {
      deps.notifyError?.(`Unknown provider: ${provider}`);
      return;
    }
    if (debug.enabled) {
      debug.log('setup.provider.pick', provider, { flow: option.flow });
    }
    switch (option.flow) {
      case 'apiKey': openProviderApiKeyPrompt(option); return;
      case 'auto':   openAutoProviderConfirm(); return;
      case 'codex':
      case 'local':  openCodexOrLocalRedirect(option); return;
    }
  };

  const formatProviderRow = (
    option: DashboardProviderSetupOption,
    detection: ProviderEnvDetection | undefined,
    saved: RotationEntry | null,
  ): { label: string; description: string } => {
    const badges: string[] = [];
    if (detection?.value) badges.push(`✓ ${detection.source}`);
    else if (option.flow === 'apiKey' || option.flow === 'codex') badges.push('— env not set');
    if (saved?.apiKey) badges.push('● saved');
    if (detection?.modelOverride) badges.push(`model: ${detection.modelOverride}`);
    if (option.flow === 'local' && detection?.baseUrlOverride) {
      badges.push(`url: ${detection.baseUrlOverride}`);
    }
    const description = [option.description, ...badges].filter(Boolean).join('  ·  ');
    return { label: option.label, description };
  };

  const openProviderPicker = (): void => {
    const cfg = deps.getUserConfig();
    const detection = scanEnv();
    const items: PickerItem<LLMProviderName>[] = DASHBOARD_PROVIDER_SETUP_OPTIONS.map((opt) => {
      const det = opt.provider !== 'auto' ? detection[opt.provider as DetectableProvider] : undefined;
      const saved = getSavedProviderRotationEntry(cfg, opt.provider);
      const { label, description } = formatProviderRow(opt, det, saved);
      return { value: opt.provider, label, description };
    });
    openPicker({
      id: 'setup-inline:provider-picker',
      title: 'Setup · Provider',
      items,
      onCancel: () => {
        openCategoryPicker();
      },
      onPick: dispatchProviderPick,
    });
  };

  /** Sweep all env-detected providers and add each to rotation in one
   *  pass. The first one becomes the active provider; subsequent ones
   *  become rotation entries you can `/provider next` through. */
  const openDetectAllSweep = (): void => {
    // Async-inside-sync is fine here: openPicker / onPick handler is
    // already a fire-and-forget (it calls into LM Studio over HTTP for
    // local probing), so this matches the existing flow shape.
    void openDetectAllSweepAsync();
  };
  const openDetectAllSweepAsync = async (): Promise<void> => {
    const detection = scanEnv();
    const detected = listEnvDetectedProviders(detection);
    const apiKeyDetected = detected.filter(p => p !== 'local');
    if (apiKeyDetected.length === 0 && !detection.local?.value) {
      deps.notifyWarning?.('No provider env vars detected. Export ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / XAI_API_KEY etc. and re-run.');
      openCategoryPicker();
      return;
    }
    const summary = apiKeyDetected.length > 0
      ? `${apiKeyDetected.join(', ')}${detection.local?.value ? ` + local (${detection.local.source})` : ''}`
      : `local only (${detection.local?.source})`;
    openPicker({
      id: 'setup-inline:detect-all',
      title: 'Setup · Detect all from env',
      items: [
        {
          value: 'apply' as const,
          label: `Add ${detected.length} provider${detected.length === 1 ? '' : 's'} to rotation`,
          description: summary,
        },
        { value: 'cancel' as const, label: 'Back' },
      ],
      onCancel: () => openCategoryPicker(),
      onPick: (choice) => { void onPickAsync(choice); },
    });
    async function onPickAsync(choice: 'apply' | 'cancel'): Promise<void> {
        if (choice === 'cancel') { openCategoryPicker(); return; }
        let cfg = deps.getUserConfig();
        const startedWithActive = cfg.llm.provider !== 'auto' && Boolean(cfg.llm.apiKey || cfg.llm.baseUrl);
        const added: string[] = [];
        let firstActivated: LLMProviderName | null = null;
        for (const provider of detected) {
          const det = detection[provider];
          if (!det.value) continue;
          const opt = findProviderSetupOption(provider);
          if (!opt) continue;
          if (provider === 'local') {
            // 2026-05-05 generalisation: local provider was previously
            // recorded as active-only and SKIPPED when adding rotation
            // entries — that's the gap the user reported (qwen 3.6
            // didn't appear in `/provider next` cycle even though
            // LOCAL_LLM_URL was set + LM Studio was serving).
            //
            // Symmetric treatment: probe the local fleet, then add
            // ONE rotation entry per loaded LM Studio model (using
            // the canonical `local-llm:<nodeId>:<modelId>` spec). When
            // no models are loaded yet, fall back to a generic "local"
            // entry so the rotation still has a slot to cycle to.
            // Activate the FIRST rotation entry when nothing is
            // currently active (mirrors the cloud branch's behaviour).
            const localBaseUrl = det.value;
            const localEntries: RotationEntry[] = [];
            try {
              const inv = await getInventory();
              const loaded = inv.models.filter(
                (m) => m.runtime === 'lmstudio' && m.loaded === true,
              );
              for (const m of loaded) {
                localEntries.push({
                  provider: 'local',
                  model: `local-llm:${m.nodeId}:${m.id}`,
                  baseUrl: localBaseUrl,
                  label: `local:${m.label}`,
                });
              }
            } catch (err: any) {
              deps.notifyWarning?.(`local probe failed: ${err?.message ?? err}`);
            }
            // Catch-all so rotation never ends up empty when LM Studio
            // is reachable but has no models loaded yet.
            if (localEntries.length === 0) {
              localEntries.push({
                provider: 'local',
                ...(det.modelOverride ? { model: det.modelOverride } : {}),
                baseUrl: localBaseUrl,
                label: 'local',
              });
            }
            for (const entry of localEntries) {
              cfg = addRotationEntry(cfg, entry);
              added.push(rotationEntryLabel(entry));
              if (!startedWithActive && firstActivated === null) {
                cfg = {
                  ...cfg,
                  llm: {
                    ...cfg.llm,
                    provider: 'local',
                    baseUrl: localBaseUrl,
                    ...(entry.model !== undefined ? { model: entry.model } : { model: undefined }),
                    apiKey: undefined,
                  },
                };
                firstActivated = 'local';
              }
            }
            continue;
          }
          // Append to rotation without clobbering the active provider
          // when one is already configured. When nothing is active,
          // promote the first detected provider to active.
          const entry: RotationEntry = { provider, apiKey: det.value, label: opt.rotationLabel };
          cfg = addRotationEntry(cfg, entry);
          if (!startedWithActive && firstActivated === null) {
            cfg = {
              ...cfg,
              llm: { ...cfg.llm, provider, apiKey: det.value, model: undefined, baseUrl: undefined },
            };
            firstActivated = provider;
          }
          added.push(`${provider} (${det.source})`);
        }
        if (debug.enabled) {
          debug.log('setup.detect-all.apply', `${added.length} added`, {
            added, activated: firstActivated, kept: startedWithActive ? cfg.llm.provider : null,
          });
        }
        saveAndReload(cfg);
        const tail = firstActivated
          ? ` Active: ${firstActivated}.`
          : startedWithActive
            ? ` Active provider unchanged (${cfg.llm.provider}).`
            : '';
        deps.notifySuccess?.(`Added: ${added.join(', ')}.${tail} Press Alt+M or /provider next to cycle.`);
    }
  };

  // ── Local LLM picks (MLX-first / GGUF fallback / Ollama / LM Studio) ─
  // Surfaces what's already serving on the local fleet (via the existing
  // quad-probe getInventory) plus catalog-recommended pulls filtered to
  // models that fit the current host's free RAM. Picking a model shows
  // the suggested install command — actual install is left to the user
  // (LM Studio search / `huggingface-cli download` / `ollama pull`).

  interface LocalLlmPick {
    kind: 'installed' | 'recommended';
    label: string;
    description: string;
    detail: string[];
    /** When set, picking this entry adds it to the rotation pool and
     *  activates it. Only `installed` picks carry a spec — `recommended`
     *  picks are pull suggestions, not yet runnable. */
    modelSpec?: string;
    /** Display label for the rotation entry — falls back to the
     *  pick's display label when omitted. */
    rotationLabel?: string;
    /** Optional structured metadata for the colored picker label (2026-05-05).
     *  When present the picker uses these to paint state / node /
     *  format with theme colors instead of the plain `label` field.
     *  Only `installed` picks set this; `recommended` picks render
     *  as the plain catalog suggestion. */
    paint?: {
      loaded: boolean | undefined;
      runtime: string;
      nodeId: string;
      modelLabel: string;
      format: string | undefined;
      capabilities: readonly string[] | undefined;
      contextK: number | undefined;
      quantization: string | undefined;
    };
  }

  /** 2026-05-05 — paint a structured picker row with theme colors:
   *   - loaded → success (bold) · idle → muted · ? → dim
   *   - nodeId 'local' → accent · remote nodes → info
   *   - format 'mlx' → highlight (bold · "more important") · 'gguf' → dim
   *   - capabilities → muted (less prominent)
   *   - contextK → muted with K suffix
   *   - quantization → muted */
  const paintLocalLlmRow = (
    p: NonNullable<LocalLlmPick['paint']>,
    theme: ThemeTokens | undefined,
  ): string => {
    const t = theme ?? deps.getTheme?.();
    if (!t) {
      // No theme — fall back to plain text (test environments etc).
      const stateBadge = p.loaded === true ? '✓ loaded'
        : p.loaded === false ? 'idle' : '?';
      return `[${stateBadge} · ${p.runtime}] ${p.nodeId}/${p.modelLabel}`
        + ` · ${p.format ?? 'weights'}`
        + (p.capabilities?.length ? ` · ${p.capabilities.join(',')}` : '')
        + (p.contextK ? ` · ${p.contextK}K ctx` : '');
    }
    const stateBadge = p.loaded === true ? '✓ loaded'
      : p.loaded === false ? 'idle' : '?';
    const stateColor = p.loaded === true
      ? themeColor(t, 'success')
      : p.loaded === false
        ? themeColor(t, 'muted')
        : themeColor(t, 'dim');
    const nodeColor = p.nodeId === 'local'
      ? themeColor(t, 'accent')
      : themeColor(t, 'info');
    const formatColor = p.format === 'mlx'
      ? themeColor(t, 'highlight')
      : themeColor(t, 'dim');
    const mutedColor = themeColor(t, 'muted');
    const textColor = themeColor(t, 'text');

    const parts = [
      colorize(stateColor, { bold: p.loaded === true })(`[${stateBadge}]`),
      colorize(nodeColor, { bold: true })(p.nodeId),
      colorize(textColor, { bold: true })(p.modelLabel),
    ];
    if (p.format) {
      parts.push(colorize(formatColor, { bold: p.format === 'mlx' })(p.format));
    }
    if (p.capabilities?.length) {
      parts.push(colorize(mutedColor)(p.capabilities.join(',')));
    }
    if (p.contextK) {
      parts.push(colorize(mutedColor)(`${p.contextK}K ctx`));
    }
    if (p.quantization) {
      parts.push(colorize(mutedColor)(p.quantization));
    }
    return parts.join(' · ');
  };

  const buildLocalLlmPicks = async (): Promise<LocalLlmPick[]> => {
    const picks: LocalLlmPick[] = [];

    // 1. Already-installed models (quad-probe inventory). Cached when
    //    fresh; otherwise this triggers a probe across LM Studio /
    //    Ollama / MLX / Docker on every reachable node.
    let inv: Awaited<ReturnType<typeof getInventory>> | null = null;
    try {
      inv = await getInventory();
    } catch (err: any) {
      deps.notifyWarning?.(`local-llm probe failed: ${err?.message ?? err}`);
    }
    if (inv && inv.models.length > 0) {
      // 2026-05-05 (qwen3.6 dogfood): sort loaded models first so the
      // picker surfaces what's *actually* serving before what's just on
      // disk. The user's question — "실제 로딩되어 있는 모델로 probe
      // 가능할까요?" — is answered structurally here: the LM Studio v0
      // probe populates `m.loaded` and `m.capabilities`, and the wizard
      // shows them in the prefix so a 30-model fleet doesn't bury the
      // 2 that are warm.
      const sorted = [...inv.models].sort((a, b) => {
        if ((b.loaded ? 1 : 0) - (a.loaded ? 1 : 0) !== 0) {
          return (b.loaded ? 1 : 0) - (a.loaded ? 1 : 0);
        }
        if (a.nodeId !== b.nodeId) return a.nodeId.localeCompare(b.nodeId);
        return a.label.localeCompare(b.label);
      });
      for (const m of sorted) {
        const stateBadge = m.loaded === true
          ? '✓ loaded'
          : m.loaded === false
            ? 'idle'
            : '?';
        const capsLabel = m.capabilities && m.capabilities.length > 0
          ? ` · ${m.capabilities.join(',')}`
          : '';
        const ctx = m.loadedContextWindow ?? m.contextWindow;
        const ctxK = ctx ? Math.round(ctx / 1024) : undefined;
        const ctxLabel = ctxK ? ` · ${ctxK}K ctx` : '';
        picks.push({
          kind: 'installed',
          modelSpec: `local-llm:${m.nodeId}:${m.id}`,
          rotationLabel: `local:${m.label}`,
          // Plain `label` retained as fallback for when no theme is
          // available (test envs etc); the picker prefers the colored
          // render via `paint` metadata when both are present.
          label: `[${stateBadge} · ${m.runtime}] ${m.label}`,
          description: `${m.nodeId} · ${m.format ?? 'weights'}${capsLabel}${ctxLabel}`,
          paint: {
            loaded: m.loaded,
            runtime: m.runtime,
            nodeId: m.nodeId,
            modelLabel: m.label,
            format: m.format,
            capabilities: m.capabilities,
            contextK: ctxK,
            quantization: m.quantization,
          },
          detail: [
            `Node: ${m.nodeId}`,
            `Runtime: ${m.runtime}`,
            `Model id: ${m.id}`,
            m.publisher ? `Publisher: ${m.publisher}` : '',
            m.arch ? `Architecture: ${m.arch}` : '',
            m.format ? `Format: ${m.format}` : '',
            m.quantization ? `Quantization: ${m.quantization}` : '',
            m.contextWindow
              ? `Context window: ${m.contextWindow.toLocaleString()} tokens (max)`
              : '',
            m.loadedContextWindow && m.loadedContextWindow !== m.contextWindow
              ? `Loaded context: ${m.loadedContextWindow.toLocaleString()} tokens`
              : '',
            m.capabilities && m.capabilities.length > 0
              ? `Capabilities: ${m.capabilities.join(', ')}`
              : '',
            m.sizeBytes ? `Size: ${(m.sizeBytes / 1e9).toFixed(2)} GB` : '',
            m.loaded === true
              ? 'Currently loaded · ready to serve'
              : m.loaded === false
                ? 'On disk · LM Studio will lazy-load on first request'
                : 'Load state unknown · runtime did not report',
            '',
            `Use as: local-llm:${m.nodeId}:${m.id}`,
          ].filter(Boolean),
        });
      }
    }

    // 2. Catalog recommendations — open-weight + locally pullable +
    //    fits free RAM with headroom. Sort: smallest first so devboxes
    //    see runnable picks at the top.
    const freeGb = Math.max(1, Math.floor(freemem() / 1e9));
    const totalGb = Math.max(1, Math.floor(totalmem() / 1e9));
    const fits = (m: ModelEntry): boolean => {
      if (!m.openWeight) return false;
      if (m.localPullable === false) return false;
      const need = m.minRamGb ?? Math.ceil((m.sizeB ?? 0) * 0.7);
      return need > 0 && need <= totalGb;
    };
    const catalogPicks = BUILTIN_CATALOG.models
      .filter(fits)
      .slice()
      .sort((a, b) => (a.minRamGb ?? 0) - (b.minRamGb ?? 0));
    for (const m of catalogPicks) {
      const headRoom = (m.minRamGb ?? 0) <= freeGb;
      picks.push({
        kind: 'recommended',
        label: `${headRoom ? '★' : ' '} ${m.id}`,
        description: `${m.family} · ${m.minRamGb ?? '?'} GB Q4 · ${m.notes ?? ''}`.trim(),
        detail: [
          m.notes ? m.notes : '',
          m.contextWindow ? `Context: ${m.contextWindow.toLocaleString()} tokens` : '',
          `Hardware: needs ~${m.minRamGb ?? '?'} GB RAM (host has ${freeGb} GB free / ${totalGb} GB total)`,
          '',
          'Suggested install (pick the runtime you have):',
          m.mlxRepo
            ? `  • LM Studio (MLX · Apple Silicon)  →  search for "${m.mlxRepo}"`
            : '',
          m.huggingFaceRepo
            ? `  • HF GGUF / safetensors fallback   →  huggingface-cli download ${m.huggingFaceRepo}`
            : '',
          m.id.includes(':')
            ? `  • Ollama tag                       →  ollama pull ${m.id}`
            : '',
        ].filter(Boolean),
      });
    }

    return picks;
  };

  const openLocalLlmPickerView = async (): Promise<void> => {
    deps.notifyInfo?.('Probing local LLM fleet (LM Studio · MLX · Ollama · Docker)…');
    const picks = await buildLocalLlmPicks();
    if (picks.length === 0) {
      deps.notifyWarning?.('No local LLM models found and no catalog model fits this host. Try installing LM Studio first.');
      return;
    }
    // 2026-05-05 — UX overhaul: was generic openPicker (38-76 col,
    // ≤10 visible rows, no buttons, "↑↓ move · type filter · Click
    // select · Double-click/Enter select · Esc close" footer noise).
    // User asked for: (a) colored labels by class
    // (loaded/idle · local/remote · mlx/gguf), (b) Select/Close
    // buttons (vw-picker style), (c) wider window, (d) 15 visible
    // rows. Switch to createActionPickerView with actionButtons + a
    // larger custom bounds, and route each row's label through
    // paintLocalLlmRow when paint metadata is present.
    const theme = deps.getTheme?.();
    const items: ActionItem<number>[] = picks.map((p, i) => ({
      value: i,
      label: p.paint ? paintLocalLlmRow(p.paint, theme) : p.label,
      description: p.kind === 'recommended' ? p.description : undefined,
    }));
    const onPick = (idx: number): void => {
      const pick = picks[idx];
      if (!pick) return;
      handlePickedLocalLlm(pick);
    };
    const view = createActionPickerView<number>({
      id: 'setup-inline:local-llm-picker',
      title: 'Local LLM · MLX-first / GGUF fallback',
      items,
      onPick,
      onCancel: () => closeActive(),
      ...(theme ? { theme } : {}),
      actionButtons: true,
      primaryActionLabel: 'select',
      cancelActionLabel: 'close',
      visibleRows: 15,
      browseMode: true,
      filterable: picks.length > 15,
    }, { framed: false });
    // Bigger bounds — picker has lots of info per row (state, node,
    // model, format, capabilities, ctx). Width 96 fits comfortably on
    // typical 120-col terminals; height 22 = 15 rows + buttons + chrome
    // + 1-row footer. centeredBounds clamps to terminal size.
    const bounds = centeredBounds(deps.termSize(), {
      width: 96,
      height: Math.min(picks.length, 15) + 7,
    });
    const handle = mountSurface({
      id: 'setup-inline:local-llm-picker',
      title: 'Local LLM · MLX-first / GGUF fallback',
      view,
      bounds,
      ...(theme ? { theme } : {}),
      onClose: () => closeActive(),
    });
    mountHandle(handle);
  };

  const handlePickedLocalLlm = (pick: LocalLlmPick): void => {
        // 2026-05-05 — installed picks now ADD to rotation pool +
        // activate (was: read-only info display). The user reported
        // qwen 3.6 wasn't in `/provider next` cycle even after picking
        // it here; the gap was that the picker was guidance-only. Per
        // user decision (rotation = default for any added provider),
        // installed entries land in the pool unconditionally so
        // `/provider next` and the Alt+M hotkey can cycle to them.
        // Recommended picks (catalog-only, not yet installed) still
        // show install instructions because there's nothing to add.
        if (pick.kind === 'installed' && pick.modelSpec) {
          let cfg = deps.getUserConfig();
          const startedWithActive = cfg.llm.provider !== 'auto'
            && Boolean(cfg.llm.apiKey || cfg.llm.baseUrl);
          const baseUrl = cfg.llm.baseUrl
            || process.env['LOCAL_LLM_URL']
            || 'http://localhost:1234/v1';
          const entry: RotationEntry = {
            provider: 'local',
            model: pick.modelSpec,
            baseUrl,
            ...(pick.rotationLabel ? { label: pick.rotationLabel } : {}),
          };
          cfg = addRotationEntry(cfg, entry);
          // Activate when nothing else is active — preserves existing
          // active provider when one is already configured.
          if (!startedWithActive) {
            cfg = {
              ...cfg,
              llm: {
                ...cfg.llm,
                provider: 'local',
                model: pick.modelSpec,
                baseUrl,
                apiKey: undefined,
              },
            };
          }
          saveAndReload(cfg);
          // 2026-05-05 (UX): close the wizard entirely after a model is
          // added — previously this reopened the category picker which
          // confused the user (they just made a selection; reopening
          // looks like the action didn't take). Push 2 chat lines so
          // the success message stays visible in the chat log AFTER
          // the popup closes (notifySuccess pushes to chatLines, and
          // chatLines remain visible behind/after popups).
          closeActive();
          deps.notifySuccess?.(
            `✓ Added to rotation: ${rotationEntryLabel(entry)}`,
          );
          deps.notifyInfo?.(
            startedWithActive
              ? `  Active provider unchanged (${cfg.llm.provider}). Press Alt+M or /provider next to cycle.`
              : `  Now active. Press Alt+M or /provider next to cycle. Try sending a test message.`,
          );
          return;
        }
        // Recommended pick — show install hints.
        const lines = [
          pick.label,
          '',
          ...pick.detail,
          '',
          'Press Esc to close. (This is a pull suggestion — install via',
          'LM Studio / huggingface-cli / ollama, then reopen this picker',
          'to add it to the rotation pool.)',
        ];
        openTextPrompt({
          title: 'Local LLM · recommended (not yet installed)',
          body: lines,
          initialValue: '',
          placeholder: '(read-only · press Esc / Enter to close)',
          onCancel: () => openLocalLlmPickerView(),
          onSubmit: async () => { /* read-only */ },
        });
  };

  const openCategoryPicker = (): void => {
    const detection = scanEnv();
    const detected = listEnvDetectedProviders(detection);
    const aux = summarizeAuxiliaryAiEnv(deps.readEnv?.() ?? process.env);
    const detectAllDescription = detected.length > 0
      ? `Auto-add: ${detected.join(', ')}`
      : 'No provider env vars detected';
    const providerDescription = detected.length > 0
      ? `${DASHBOARD_PROVIDER_SETUP_OPTIONS.length} providers · ${detected.length} env-ready`
      : `${DASHBOARD_PROVIDER_SETUP_OPTIONS.length} providers · paste keys`;
    type CategoryRoute = 'detect-all' | 'provider' | 'local-llm' | 'discord' | 'aux-info';
    const items: PickerItem<CategoryRoute>[] = [];
    if (detected.length > 0) {
      items.push({ value: 'detect-all', label: '⚡ Detect all from env', description: detectAllDescription });
    }
    items.push({ value: 'provider', label: 'Provider', description: providerDescription });
    items.push({
      value: 'local-llm',
      label: 'Local LLM',
      description: 'MLX · GGUF · Ollama · LM Studio — installed + recommended pulls',
    });
    items.push({ value: 'discord', label: 'Discord', description: 'Bot token + allowlist + optional home channel' });
    if (aux.length > 0) {
      items.push({
        value: 'aux-info',
        label: `Auxiliary AI keys · ${aux.length} detected`,
        description: aux.map(v => v.name).join(', '),
      });
    }
    openPicker({
      id: 'setup-inline:category-picker',
      title: 'Setup',
      items,
      onPick: (target) => {
        if (target === 'detect-all') openDetectAllSweep();
        else if (target === 'provider') openProviderPicker();
        else if (target === 'local-llm') void openLocalLlmPickerView();
        else if (target === 'aux-info') {
          // Info-only — toast a per-service breakdown so the user knows
          // what elanous will pick up automatically, then re-open menu.
          for (const v of aux) deps.notifyInfo?.(`  ${v.name} → ${v.usedBy}`);
          openCategoryPicker();
        }
        else openDiscordTokenPrompt();
      },
    });
  };

  return {
    open(target?: DashboardSetupInlineTarget): void {
      if (!target) {
        openCategoryPicker();
        return;
      }
      if (target === 'provider') {
        openProviderPicker();
        return;
      }
      if (target === 'local-llm') {
        void openLocalLlmPickerView();
        return;
      }
      openDiscordTokenPrompt();
    },
  };
}

function centeredBounds(
  term: { cols: number; rows: number },
  desired: { width: number; height: number },
): ModalBounds {
  const width = Math.min(desired.width, Math.max(28, term.cols - 4));
  const height = Math.min(desired.height, Math.max(6, term.rows - 4));
  return {
    row: Math.max(1, Math.floor((term.rows - height) / 2)),
    col: Math.max(1, Math.floor((term.cols - width) / 2)),
    width,
    height,
  };
}

function buildPromptBody(
  lines: string[],
  edit: EditView,
): View {
  const body = new TextView(lines);
  return new LinearLayout('vertical')
    .add({ view: body, size: Math.max(1, lines.length) })
    .add({ view: edit, size: 1 });
}

function mountSurface(spec: {
  id: string;
  title: string;
  view: View;
  bounds: ModalBounds;
  theme?: ThemeTokens;
  chromeSpec?: WidgetChromeSpec;
  onClose?: () => void;
}): ViewSurfaceHandle {
  const chrome = resolveWidgetChromeBoxViewOptions(
    spec.theme,
    spec.chromeSpec ?? resolvePickerChromeSpec({
      title: spec.title,
      primaryAction: 'continue',
      browseMode: false,
      filterable: false,
    }),
    spec.title,
  );
  const boxed = new BoxView(spec.view, {
    ...chrome,
    fill: ' ',
    titleRight: formatChromeControlsTitleRight({ closeButton: true }) ?? DEFAULT_CLOSE_GLYPH,
  });
  const shadow: ModalShadowSpec | undefined = spec.theme && process.env.ELANOUS_MODAL_SHADOW !== 'off'
    ? { theme: spec.theme }
    : undefined;
  return mountViewAsModalSurface({
    id: spec.id,
    bounds: spec.bounds,
    view: boxed,
    priority: 260,
    tier: 'dialog',
    // 2026-05-05 — without backgroundInteractionPolicy='block' the
    // setup picker is `interactionClass='blocking-modal'` but the
    // resolveModalInteractionPolicy() returns ownsPrimaryKeyRoute=false
    // (gated on `backgroundInteractionPolicy === 'block'`), so Enter
    // / arrow keys fall THROUGH the picker and reach the chat input
    // pane below — submitting whatever the user had previously typed
    // as a chat message. Forensic trace 2026-05-05 (debug log
    // 20260505171216): user pressed Enter on local-llm-picker, the
    // 'chat.picker.dispatch' event at `source: input-loop` fired with
    // `consumed: false` and the buffered chat input text was sent to
    // the LLM. Mirror mouse-action-recipes.ts:1030 which always sets
    // 'block' for the same reason.
    backgroundInteractionPolicy: 'block',
    theme: spec.theme,
    shadow,
    chromeControls: {
      closeButton: true,
      onClose: spec.onClose,
    },
  });
}

function widestOptionWidth<T>(options: SelectOption<T>[]): number {
  let width = 0;
  for (const option of options) {
    const text = option.label + (option.description ? `  ${option.description}` : '');
    if (text.length > width) width = text.length;
  }
  return width;
}

function longestLine(lines: string[], placeholder?: string): number {
  let width = placeholder?.length ?? 0;
  for (const line of lines) {
    if (line.length > width) width = line.length;
  }
  return width;
}
