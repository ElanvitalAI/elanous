import { existsSync, readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserConfig, TelegramConfig } from './types.js';

/**
 * @internal Reader state implementation. The compatibility façade configures its callbacks;
 * application callers must use reader.ts, which initializes that façade before re-exporting.
 */
interface UserConfigReaderDependencies {
  defaultPath(): string;
  build(path: string): UserConfig;
  readMtime(path: string): number | null;
  resetClaudePackageSkillDirs(): void;
}

let dependencies: UserConfigReaderDependencies | undefined;
let cache: UserConfig | null = null;
let cachedPath: string | null = null;
let cachedMtimeMs: number | null = null;
let configOverlay: ((config: UserConfig) => UserConfig) | null = null;
const scopedConfigSnapshot = new AsyncLocalStorage<UserConfig>();

export function configureUserConfigReader(value: UserConfigReaderDependencies): void {
  dependencies = value;
}

function readerDeps(): UserConfigReaderDependencies {
  if (!dependencies) throw new Error('user-config reader has not been initialized');
  return dependencies;
}

function applyOverlay(config: UserConfig): UserConfig {
  return configOverlay ? configOverlay(config) : config;
}

export function runWithUserConfigSnapshot<T>(snapshot: UserConfig, run: () => T): T {
  return scopedConfigSnapshot.run(snapshot, run);
}

export function setUserConfigOverlay(fn: ((config: UserConfig) => UserConfig) | null): ((config: UserConfig) => UserConfig) | null {
  const previous = configOverlay;
  configOverlay = fn;
  resetUserConfig();
  return previous;
}

/** Pure ISO-2 conversion policy retained for config sync callers. */
export function buildTestSafeDaemonConfig(config: UserConfig): UserConfig {
  const testToken = config.telegram.testChannel?.botToken?.trim();
  const testAllow = config.telegram.testChannel?.allowedUsers;
  const telegram: TelegramConfig = testToken
    ? { ...config.telegram, botToken: testToken,
        allowedUsers: testAllow && testAllow.length > 0 ? testAllow : config.telegram.allowedUsers,
        reportChannel: undefined, homeChannel: undefined, channels: undefined }
    : { ...config.telegram, enabled: false, reportChannel: undefined,
        homeChannel: undefined, channels: undefined };
  return { ...config, telegram, discord: { ...config.discord, enabled: false } };
}

export function getUserConfig(path: string = readerDeps().defaultPath()): UserConfig {
  const snapshot = scopedConfigSnapshot.getStore();
  if (snapshot) return snapshot;
  const deps = readerDeps();
  if (cache && cachedPath === path) {
    const currentMtimeMs = deps.readMtime(path);
    if (currentMtimeMs !== null && currentMtimeMs === cachedMtimeMs) return cache;
  }
  cache = applyOverlay(deps.build(path));
  cachedPath = path;
  cachedMtimeMs = deps.readMtime(path);
  return cache;
}

export function reloadUserConfig(path: string = readerDeps().defaultPath()): UserConfig {
  const deps = readerDeps();
  cache = applyOverlay(deps.build(path));
  cachedPath = path;
  cachedMtimeMs = deps.readMtime(path);
  return cache;
}

export function resetUserConfig(): void {
  cache = null;
  cachedPath = null;
  cachedMtimeMs = null;
  readerDeps().resetClaudePackageSkillDirs();
}

export function rememberSavedUserConfig(config: UserConfig, path: string, mtimeMs: number | null): void {
  cache = config;
  cachedPath = path;
  cachedMtimeMs = mtimeMs;
}

/** Read the on-disk config envelope. Shape validation and normalization stay in user-config.ts. */
export function readUserConfigObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
