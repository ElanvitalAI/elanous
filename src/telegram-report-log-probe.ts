import { sendTelegramReport } from './telegram-report.js';
import { getUserConfig, setUserConfigOverlay } from './user-config.js';
import { registerStandaloneLogSink } from './domains/standalone-log-sink.js';

// Focused subprocess fixture (BRIEF-DELIVERY-1007): the production shape — a channels table whose
// trading channel lacks the `report` role while the legacy reportChannel points at that bot.
setUserConfigOverlay(cfg => ({
  ...cfg,
  telegram: {
    ...cfg.telegram,
    channels: [
      { name: 'main', botToken: '111111:private-secret', chatId: 98765, interactive: true, roles: ['qa', 'default', 'system'] },
      { name: 'conatus', botToken: '222222:private-secret', chatId: 98766, interactive: false, roles: ['investment', 'finance'] },
    ],
    reportChannel: { botToken: '222222:private-secret', chatId: 98766 },
  },
}));
// The entry point attaches logs.db, exactly as cron morning-report does.
if (process.env.NODE_ENV !== 'test') await registerStandaloneLogSink('telegram-report-probe');
console.log(`probe-start ${new Date().toISOString()}`);
if (await sendTelegramReport(getUserConfig(), 'SECRET-BODY-DO-NOT-LOG', { kind: 'report' })) process.exitCode = 1;
