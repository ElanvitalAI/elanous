import { existsSync } from 'node:fs';

import { debug } from '../debug/log.js';
import { buildUserConfig, resolveSkillSources, type UserConfig as MainUserConfig } from '../user-config.js';
import { decideProviderForConfig } from '../llm.js';
import { resolveGrokCredential } from '../grok/credential.js';
import { loadTokens } from '../oauth/store.js';
import {
  readUserConfig as readNexusUserConfig,
  readSwitchValue,
} from './config/user-config.js';
import type { UserConfig as NexusUserConfig } from './config/types.js';
import { resolveLaunchdEnvironment } from './install/launchd.js';
import { resolveSystemdEnvironment } from './install/systemd.js';
import { resolvePwaStaticDir } from './static-dir-resolve.js';
import { SKILLS_STEP_COMMAND, unattendedSetupHint } from '../onboarding/entry-hints.js';

export type SetupItemId = 'llm' | 'pwa-build' | 'channel-bot' | 'skill-dirs' | 'os-install';

export interface SetupItem {
  id: SetupItemId;
  label: string;
  passed: boolean;
  hint: string;
  detail?: string;
}

export interface SetupCheckResult {
  required: SetupItem[];
  recommended: SetupItem[];
  ok: boolean;
}

export type SetupBootMode = 'normal' | 'setup' | 'refuse';

export interface SetupBootDecision {
  mode: SetupBootMode;
  missing: string[];
}

/** LLM 만 빠졌으면 PWA `/setup` 으로 채울 수 있다. PWA 빌드가 없으면 셋업 화면 자체가 없다. */
export function setupBootMode(result: SetupCheckResult): SetupBootDecision {
  const missing = result.required.filter((item) => !item.passed).map((item) => item.label);
  const pwaMissing = result.required.some((item) => item.id === 'pwa-build' && !item.passed);
  const onlyLlmMissing = missing.length > 0
    && result.required.every((item) => item.passed || item.id === 'llm');
  const mode: SetupBootMode = missing.length === 0
    ? 'normal'
    : (pwaMissing ? 'refuse' : (onlyLlmMissing ? 'setup' : 'refuse'));
  debug.log('nexus.boot', 'setup-mode', { mode, missing });
  return { mode, missing };
}

export interface SetupModeBootPlan {
  skipTabKinds: string[];
  skipCrons: string[];
}

/** 셋업 모드면 채널 봇·데몬 탭과 탐색·기기 크론을 띄우지 않는다. pwa-host 는 셋업 화면이라 남긴다. */
export function setupModeBootPlan(setupMode: boolean): SetupModeBootPlan {
  if (!setupMode) return { skipTabKinds: [], skipCrons: [] };
  return {
    skipTabKinds: ['daemon', 'channel-bot'],
    skipCrons: ['discovery', 'devices'],
  };
}

export interface NexusSetupModeRead {
  setupMode: boolean;
  setupMissing: string[];
}

/**
 * 기동 때 한 번. `ELANOUS_NEXUS_SETUP_MODE === '1'` 이면
 * `setupBootMode(checkSetupStatus()).missing` 을 읽는다.
 * `check` 는 테스트가 LLM 만 빠진 설정을 주입할 때 쓴다. 기동 경로는 넘기지 않는다.
 */
export function readNexusSetupMode(
  env: NodeJS.ProcessEnv,
  check: () => SetupCheckResult = () => checkSetupStatus(),
): NexusSetupModeRead {
  if (env.ELANOUS_NEXUS_SETUP_MODE !== '1') {
    return { setupMode: false, setupMissing: [] };
  }
  return {
    setupMode: true,
    setupMissing: setupBootMode(check()).missing,
  };
}

export interface SetupCheckOpts {
  cfg?: MainUserConfig;
  nexusCfg?: NexusUserConfig;
  pwaBuilt?: boolean;
  argvBin?: string;
  exists?: (path: string) => boolean;
  resolveGrokCredential?: typeof resolveGrokCredential;
  decideProviderForConfig?: typeof decideProviderForConfig;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOAuthToken(provider: 'openai-codex' | 'anthropic'): boolean {
  const state = loadTokens(provider);
  return Boolean(state?.tokens?.accessToken || state?.tokens?.refreshToken);
}

function checkLlm(
  cfg: MainUserConfig,
  resolveGrokCredentialDependency: typeof resolveGrokCredential,
  decideProviderForConfigDependency: typeof decideProviderForConfig,
): SetupItem {
  const provider = cfg.llm.provider as string | undefined;
  let passed = false;
  let credential: string | undefined;
  let detailProvider = provider;
  if (provider === 'auto') {
    const decision = decideProviderForConfigDependency(cfg);
    passed = decision.auth !== 'none';
    detailProvider = decision.provider;
    credential = passed ? decision.auth : undefined;
  } else if (provider && provider !== 'none') {
    if (provider === 'local') {
      passed = hasText(cfg.llm.baseUrl);
    } else if (provider === 'openai-codex') {
      passed = hasText(cfg.llm.apiKey) || hasOAuthToken('openai-codex');
    } else if (provider === 'anthropic') {
      passed = hasText(cfg.llm.apiKey) || hasOAuthToken('anthropic');
    } else if (provider === 'grok') {
      if (hasText(cfg.llm.apiKey)) {
        passed = true;
        credential = 'api-key';
      } else {
        const resolved = resolveGrokCredentialDependency();
        passed = resolved?.kind === 'subscription';
        credential = passed ? 'subscription' : undefined;
      }
    } else {
      passed = hasText(cfg.llm.apiKey);
    }
  }
  return {
    id: 'llm',
    label: 'LLM provider',
    passed,
    hint: `run \`elanous onboarding llm\` or interactive \`elanous nexus\`; ${unattendedSetupHint()}`,
    ...(detailProvider && detailProvider !== 'none' ? {
      detail: `provider=${detailProvider}${credential ? ` · credential=${credential}` : ''}`,
    } : {}),
  };
}

function checkPwaBuild(opts: SetupCheckOpts): SetupItem {
  const built = opts.pwaBuilt ?? Boolean(resolvePwaStaticDir({
    argvBin: opts.argvBin ?? process.argv[1] ?? '',
    ...(opts.exists ? { exists: opts.exists } : {}),
  }));
  return {
    id: 'pwa-build',
    label: 'PWA build',
    passed: built,
    hint: 'run `elanous nexus build`',
  };
}

function checkChannelBot(cfg: NexusUserConfig): SetupItem {
  const telegram = readSwitchValue(cfg, 'tabs.telegram:1.tokenRef');
  const discord = readSwitchValue(cfg, 'tabs.discord:1.tokenRef');
  return {
    id: 'channel-bot',
    label: 'Channel bot',
    passed: hasText(telegram) || hasText(discord),
    hint: `run \`elanous nexus channel-bot setup telegram|discord\`; ${unattendedSetupHint()}`,
  };
}

function checkSkillDirs(cfg: MainUserConfig, exists: (path: string) => boolean): SetupItem {
  // EN5 — the same list the loader reads (resolveSkillSources): the preset and what `elanous connect` registered.
  // Derived roots (shared ~/.agents/skills, Claude package roots) are optional extras, not «configured» dirs.
  const dirs = resolveSkillSources(cfg)
    .filter((source) => source.enabled && (source.kind === 'preset' || source.kind === 'connected'))
    .map((source) => source.path)
    .filter(hasText);
  const existingDirs = dirs.filter(exists);
  const missingDirs = dirs.filter((dir) => !exists(dir));
  const detail = `${dirs.length} dir${dirs.length === 1 ? '' : 's'} · ${existingDirs.length} exist`;
  return {
    id: 'skill-dirs',
    label: 'Skill dirs',
    passed: existingDirs.length > 0,
    hint: missingDirs.length > 0
      ? `create the missing skill directories or choose an already-existing skill directory; run \`${SKILLS_STEP_COMMAND}\`; ${unattendedSetupHint()}`
      : '',
    ...(dirs.length > 0 ? {
      detail: missingDirs.length > 0 ? `${detail} · missing: ${missingDirs.join(', ')}` : detail,
    } : {}),
  };
}

function osInstallHint(): string {
  if (process.platform === 'darwin') return 'run `elanous nexus install --launchd`';
  if (process.platform === 'linux') return 'run `elanous nexus install --systemd-user`';
  return 'run `elanous nexus install --launchd|--systemd-user`';
}

function checkOsInstall(exists: (path: string) => boolean): SetupItem {
  const launchdInstalled = exists(resolveLaunchdEnvironment().plistPath);
  const systemdInstalled = exists(resolveSystemdEnvironment().unitPath);
  return {
    id: 'os-install',
    label: 'OS install',
    passed: launchdInstalled || systemdInstalled,
    hint: osInstallHint(),
    ...(launchdInstalled
      ? { detail: 'launchd installed' }
      : (systemdInstalled ? { detail: 'systemd-user installed' } : {})),
  };
}

export function checkSetupStatus(opts: SetupCheckOpts = {}): SetupCheckResult {
  const cfg = opts.cfg ?? buildUserConfig();
  const nexusCfg = opts.nexusCfg ?? readNexusUserConfig();
  const exists = opts.exists ?? existsSync;
  const resolveGrokCredentialDependency = opts.resolveGrokCredential ?? resolveGrokCredential;
  const decideProviderForConfigDependency = opts.decideProviderForConfig ?? decideProviderForConfig;
  const required = [
    checkLlm(cfg, resolveGrokCredentialDependency, decideProviderForConfigDependency),
    checkPwaBuild(opts),
  ];
  const recommended = [
    checkChannelBot(nexusCfg),
    checkSkillDirs(cfg, exists),
    checkOsInstall(exists),
  ];
  return {
    required,
    recommended,
    ok: required.every((item) => item.passed),
  };
}

function formatItem(item: SetupItem, recommended: boolean): string {
  const glyph = item.passed ? '✓' : (recommended ? '○' : '✗');
  const detail = item.detail ? ` (${item.detail})` : '';
  return `    [${glyph}] ${item.label}${detail}  ${item.hint}`;
}

export function renderSetupStatus(
  result: SetupCheckResult,
  sink: { log: (s: string) => void; error: (s: string) => void },
): void {
  sink.log('');
  sink.log('  required:');
  for (const item of result.required) {
    sink.log(formatItem(item, false));
  }
  sink.log('');
  sink.log('  recommended (won\'t block boot):');
  for (const item of result.recommended) {
    sink.log(formatItem(item, true));
  }
}
