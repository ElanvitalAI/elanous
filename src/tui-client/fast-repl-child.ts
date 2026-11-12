/** Narrow Next TUI child entry: the parent already resolved its state root. */
import { setElanousConfigDir } from '../elanous-config-dir.js';

const sessionId = process.argv[2];
const configDir = process.argv[3];
if (!sessionId || !configDir) {
  process.stderr.write('Next TUI REPL child requires session and config directory.\n');
  process.exit(2);
}

setElanousConfigDir(configDir);
const { getUserConfig, reloadUserConfig } = await import('../user-config.js');
const cfg = getUserConfig();
// The parent only launches this child from Next. Provider-ready sessions may
// chat while optional web/Telegram onboarding remains unfinished.
if ((await import('../onboarding.js')).needsOnboarding(cfg) && cfg.onboarding.ready !== true) {
  process.stderr.write('No config yet — run `elanous` once interactively before using the Next TUI REPL.\n');
  process.exit(2);
}

if (process.env.ELANOUS_NEXT_TUI_BG_STATUS === '1') {
  try { await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('tui'); }
  catch { /* logging setup must not prevent a turn */ }
}

const { runRepl } = await import('../repl/index.js');
const code = await runRepl({
  cfg: reloadUserConfig(),
  initialSessionId: sessionId,
  forceNew: false,
  continueActive: false,
  enableTools: true,
  scenarioPath: undefined,
  scriptedFromStdin: true,
  jsonOutput: true,
  exitAfterScenario: true,
});
if (code !== 0) process.exit(code);
