import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildUserConfig, CHAT_DEFAULTS, saveUserConfig } from '../user-config.js';

export interface UserConfigDefaultSparseSimulation {
  readonly savedDefaultChatFastPath: unknown;
  readonly savedDefaultDashboardFoldMode: unknown;
  readonly savedVoiceSttProvider: unknown;
  readonly savedTelegramReplyMode: unknown;
  readonly reloadedVoiceSttProvider: unknown;
  readonly reloadedTelegramReplyMode: unknown;
  readonly savedExplicitDefaultChoice: unknown;
  readonly reloadedExplicitDefaultChoice: unknown;
  readonly futureDefaultRetainsExplicitChoice: unknown;
  readonly savedUnknownEmptyExtension: unknown;
  readonly reloadedUnknownEmptyExtension: unknown;
}

/** Save a sparse user choice alongside generated defaults using real config IO. */
export function simulateUserConfigDefaultSparse(root: string): UserConfigDefaultSparseSimulation {
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    voice: {
      stt: { provider: 'gemini-live-stt' },
      telegram: { replyMode: 'text' },
    },
    extension: {},
  }));
  const loaded = buildUserConfig(configPath);
  saveUserConfig(loaded, configPath);
  const saved = JSON.parse(readFileSync(configPath, 'utf8')) as {
    chat?: { fastPath?: unknown };
    dashboard?: { foldMode?: unknown };
    voice?: { stt?: { provider?: unknown }; telegram?: { replyMode?: unknown } };
    extension?: unknown;
  };
  const reloaded = buildUserConfig(configPath);
  // A user can explicitly choose the value that a later release makes its default.
  writeFileSync(configPath, JSON.stringify({ chat: { fastPath: false } }));
  const explicit = buildUserConfig(configPath);
  saveUserConfig(explicit, configPath);
  const savedExplicitBeforeDefaultChange = JSON.parse(readFileSync(configPath, 'utf8')) as { chat?: { fastPath?: unknown } };
  const previousDefault = CHAT_DEFAULTS.fastPath;
  let savedExplicitAfterDefaultChange: { chat?: { fastPath?: unknown } };
  let reloadedExplicitAfterDefaultChange: ReturnType<typeof buildUserConfig>;
  try {
    CHAT_DEFAULTS.fastPath = false;
    const underNewDefault = buildUserConfig(configPath);
    saveUserConfig(underNewDefault, configPath);
    savedExplicitAfterDefaultChange = JSON.parse(readFileSync(configPath, 'utf8')) as { chat?: { fastPath?: unknown } };
    reloadedExplicitAfterDefaultChange = buildUserConfig(configPath);
  } finally {
    CHAT_DEFAULTS.fastPath = previousDefault;
  }
  return {
    savedDefaultChatFastPath: saved.chat?.fastPath,
    savedDefaultDashboardFoldMode: saved.dashboard?.foldMode,
    savedVoiceSttProvider: saved.voice?.stt?.provider,
    savedTelegramReplyMode: saved.voice?.telegram?.replyMode,
    reloadedVoiceSttProvider: reloaded.voice.stt.provider,
    reloadedTelegramReplyMode: reloaded.voice.telegram.replyMode,
    savedExplicitDefaultChoice: savedExplicitBeforeDefaultChange.chat?.fastPath,
    reloadedExplicitDefaultChoice: savedExplicitAfterDefaultChange!.chat?.fastPath,
    futureDefaultRetainsExplicitChoice: reloadedExplicitAfterDefaultChange!.chat.fastPath,
    savedUnknownEmptyExtension: saved.extension,
    reloadedUnknownEmptyExtension: reloaded.raw?.extension,
  };
}
