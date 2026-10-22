import { Command } from 'commander';
import type { LightCliRoute } from './cli/light-entry-route.js';

/** Dispatch a small operational command without loading the full command registry. */
export async function runLightCli(route: LightCliRoute): Promise<void> {
  // Root instance flags stay on the full entry for the four hot commands.
  // Other light routes can still accept them; invoke the same shared bootstrap
  // helpers as src/index.ts, and only load those helpers when a flag is present.
  const args = process.argv.slice(2);
  // The legacy entry resolves the config root for operational commands and
  // warns when the removed ELANOUS_CONFIG_DIR env var disagrees with it.
  // Preserve that observable warning on hot routes without loading the
  // resolver for the common case where the ignored env var is absent.
  if (['msg', 'pty', 'logs', 'tasks'].includes(route) && process.env.ELANOUS_CONFIG_DIR !== undefined) {
    const { getElanousConfigDir } = await import('./elanous-config-dir.js');
    getElanousConfigDir();
  }
  const hasRootInstanceFlag = args.some(arg => ['--test', '--config-dir', '--test-state-dir', '--state-dir']
    .some(flag => arg === flag || arg.startsWith(`${flag}=`)));
  if (hasRootInstanceFlag) {
    const [{ applyTestStateDirFlagFromArgv }, { applyTestFlagFromArgv }, { applyConfigDirFlagFromArgv }] = await Promise.all([
      import('./cli/test-state-dir-flag.js'),
      import('./cli/test-flag.js'),
      import('./cli/config-dir-flag.js'),
    ]);
    applyTestStateDirFlagFromArgv();
    applyTestFlagFromArgv();
    applyConfigDirFlagFromArgv();
  }

  const program = new Command().name('elanous').enablePositionalOptions();
  switch (route) {
    case 'msg': {
      const { registerMsgCommands } = await import('./cli/msg-cli.js');
      registerMsgCommands(program);
      break;
    }
    case 'release': {
      const { registerReleaseChecklistReadCommands } = await import('./cli/release-checklist-read-cli.js');
      registerReleaseChecklistReadCommands(program);
      break;
    }
    case 'tasks': {
      const { registerTasksCommands } = await import('./cli/tasks-cli.js');
      registerTasksCommands(program);
      break;
    }
    case 'pty': {
      const { registerPtyTakeoverCommands } = await import('./cli/pty-takeover-cli.js');
      registerPtyTakeoverCommands(program);
      break;
    }
    case 'logs': {
      const { registerLogsCommands } = await import('./cli/logs-cli.js');
      registerLogsCommands(program);
      break;
    }
    case 'config': {
      const { getUserConfig } = await import('./user-config.js');
      const { redactSecrets, redactSecretText } = await import('./debug/log.js');
      const { resolveCurrentInstance } = await import('./instance/current.js');
      const redactDisplay = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(redactDisplay);
        if (value !== null && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
            redactSecretText(key), redactDisplay(child),
          ]));
        }
        return typeof value === 'string' ? redactSecretText(value) : value;
      };
      const config = program.command('config').description('Inspect and edit ~/.config/elanous/config.json');
      config.command('get [path]')
        .description('Print all config or one dotted path, e.g. llm.provider (secrets redacted by default)')
        .option('--reveal', 'Print unredacted output and record the reveal')
        .action(async (path: string | undefined) => {
          if (resolveCurrentInstance().kind === 'test' && String(resolveCurrentInstance().layer) === 'tree-derived') {
            console.error('⚠️ test 우주의 config를 읽습니다 — 운영 값은 --config-dir ~/.elanous');
          }
          const config = getUserConfig() as unknown as Record<string, unknown>;
          const lookup = (root: unknown): unknown => {
            let value = root;
            for (const part of path?.split('.').filter(Boolean) ?? []) {
              if (value === null || typeof value !== 'object') return undefined;
              value = (value as Record<string, unknown>)[part];
            }
            return value;
          };
          const selected = path ? (lookup(config) ?? lookup(config.raw)) : config;
          if (selected === undefined) {
            const { error } = await import('./ui.js');
            error(`config path not found: ${path}`);
            process.exitCode = 1;
            return;
          }
          const displayKey = path?.split('.').filter(Boolean).at(-1);
          const display = displayKey
            ? redactDisplay(redactSecrets({ [displayKey]: selected })[displayKey])
            : redactDisplay(redactSecrets(selected));
          console.log(typeof display === 'string' ? display : JSON.stringify(display, null, 2));
        });
      break;
    }
  }

  try {
    await program.parseAsync(['node', 'elanous', ...process.argv.slice(2)]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
