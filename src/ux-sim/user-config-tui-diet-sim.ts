import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { readTuiSlashAudience } from '../maturity/tui-slash-maturity.js';
import { buildUserConfig, getUserConfig, resolveTuiUnattended, saveUserConfig } from '../user-config.js';

export interface UserConfigTuiDietSimulation {
  readonly sidetab: string;
  readonly unattended: boolean;
  readonly slashAudience: ReturnType<typeof readTuiSlashAudience>;
  readonly dashboardTheme: unknown;
  readonly channelVoiceReplyMode: unknown;
  readonly notificationEnvironment: unknown;
  readonly savedChannelVoiceReplyMode: unknown;
  readonly savedNotificationEnvironment: unknown;
  readonly savedTui: unknown;
  readonly savedDashboard: unknown;
  readonly pwaVoiceSttProvider: unknown;
  readonly savedPwaVoiceSttProvider: unknown;
  readonly savedJsonVoiceSttProvider: unknown;
}

/** Feed a legacy config through the real loader, TUI readers, and serializer. */
export function simulateUserConfigTuiDiet(root: string): UserConfigTuiDietSimulation {
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    tui: {
      sidetab: 'open', unattended: true, role: 'general', showBeta: true,
      display: { density: 'compact' }, theme: { accent: 'magenta' },
      keymap: { submit: 'ctrl+enter' }, panel: { sidebar: false },
      animation: { enabled: false }, notifications: { enabled: false },
      voice: { enabled: false },
    },
    dashboard: { theme: { accent: 'magenta', density: 'compact' } },
    voice: { stt: { provider: 'gemini-live-stt' }, telegram: { replyMode: 'text' }, discord: { sttProvider: 'gemini-live-stt' }, pwa: {} },
    notifications: { apns: {
      keyId: 'K000000001', teamId: 'T000000001', bundleId: 'example.app',
      keyPath: '/tmp/test-apns-key.p8', environment: 'sandbox',
    } },
  }));
  setElanousConfigDir(root);
  try {
    const config = getUserConfig();
    const result = {
      sidetab: config.tui?.sidetab ?? 'collapsed',
      unattended: resolveTuiUnattended(config, { ...process.env, ELANOUS_TUI_UNATTENDED: String(0) }),
      slashAudience: readTuiSlashAudience(),
      dashboardTheme: config.dashboard.theme,
      channelVoiceReplyMode: config.voice.telegram.replyMode,
      notificationEnvironment: config.notifications?.apns?.environment,
      pwaVoiceSttProvider: config.voice.stt.provider,
    };
    saveUserConfig(config, configPath);
    const saved = JSON.parse(readFileSync(configPath, 'utf8')) as {
      voice?: { telegram?: { replyMode?: unknown }; stt?: { provider?: unknown } };
      notifications?: { apns?: { environment?: unknown } };
      tui?: unknown; dashboard?: Record<string, unknown>;
    };
    return {
      ...result,
      savedChannelVoiceReplyMode: saved.voice?.telegram?.replyMode,
      savedNotificationEnvironment: saved.notifications?.apns?.environment,
      savedTui: saved.tui,
      savedDashboard: saved.dashboard,
      savedPwaVoiceSttProvider: buildUserConfig(configPath).voice.stt.provider,
      savedJsonVoiceSttProvider: saved.voice?.stt?.provider,
    };
  } finally {
    resetElanousConfigDir();
  }
}
