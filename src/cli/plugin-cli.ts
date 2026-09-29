import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { userConfigPath } from '../user-config.js';
import { debug } from '../debug/log.js';
import { emitDecision } from '../live/detail-switch.js';
import { OFFICIAL_INDEX_KEYS } from '../market/official-keys.js';
import { installPlugin, listInstalledPlugins, PluginInstallError, removePlugin, type InstallEvent } from '../plugins/install/plugin-install.js';

function keys(): ReadonlyArray<{ keyId: string; publicKey: string }> {
  const configPath = userConfigPath();
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) as { market?: { trustedKeys?: unknown } } : {};
  const additional = config.market?.trustedKeys;
  if (additional === undefined) return OFFICIAL_INDEX_KEYS;
  if (!Array.isArray(additional) || !additional.every(key => key && typeof key.keyId === 'string' && typeof key.publicKey === 'string')) {
    throw new PluginInstallError('io', 'invalid trusted keys configuration');
  }
  return [...OFFICIAL_INDEX_KEYS, ...additional];
}

async function askConsent(capabilities: string[], json: boolean): Promise<boolean> {
  if (!stdin.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: json ? stderr : stdout, terminal: true });
  try {
    const answer = await prompt.question(`Plugin permissions: ${capabilities.join(', ')}\nAllow? [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function outputEvent(event: InstallEvent, json: boolean): void {
  // Connector field names are useful; values and secret-field metadata are not needed here.
  const safe = event.event === 'credentials'
    ? { event: 'credentials', connectors: event.connectors.map(({ id, fields }) => ({ id, fields: fields.map(({ name }) => name) })) }
    : event;
  debug.log('plugin.cli', event.event, { event: event.event });
  if (json) stdout.write(JSON.stringify(safe) + '\n');
  else if (event.event === 'credentials') {
    if (event.connectors.length) console.log(`Connectors: ${event.connectors.map(connector => connector.id).join(', ')} — configure via elanous connector settings (no secrets requested here)`);
  } else if (event.event === 'done') console.log(`Installed ${event.plugin}@${event.version}`);
  else if (event.event === 'consent' && event.required) console.log(`Permissions: ${event.capabilities.join(', ')}`);
}

export function registerPluginCommands(program: Command): void {
  const plugin = program.command('plugin').description('Install and manage Elanous plugins');
  plugin.command('add <spec>').description('Install a local path, pinned git plugin or signed market plugin')
    .option('--yes', 'Accept requested capabilities')
    .option('--json', 'NDJSON progress events')
    .option('--allow-unsigned', 'Allow unsigned marketplace indices')
    .action(async (spec: string, opts: { yes?: boolean; json?: boolean; allowUnsigned?: boolean }) => {
      try {
        const root = elanousStateRoot();
        await installPlugin(spec, {
          root, marketDir: join(root, 'plugins', 'markets'), trustedKeys: keys(),
          yes: opts.yes, allowUnsigned: opts.allowUnsigned,
          onEvent: event => outputEvent(event, !!opts.json),
          consent: capabilities => askConsent(capabilities, !!opts.json),
        });
        emitDecision({ kind: 'ROUTE', what: 'plugin add', reason: 'plugin installed', purpose: 'make plugin available', target: 'plugin host' });
      } catch (error) {
        const reason = error instanceof PluginInstallError ? error.reason : 'io';
        // Installer errors may embed an arbitrary source path or git URL; never echo them or config secrets.
        const detail = reason === 'consent-denied' ? 'plugin capabilities require consent' : `plugin installation ${reason} error`;
        debug.log('plugin.cli', 'failed', { reason }, { level: 'error' });
        emitDecision({ kind: 'ESCALATE', what: 'plugin add', reason, purpose: 'report installation failure', target: 'user' });
        if (opts.json) stdout.write(JSON.stringify({ event: 'failed', reason, detail }) + '\n');
        else console.error(`plugin add failed: ${detail}`);
        process.exitCode = 1;
      }
    });
  plugin.command('list').description('List installed plugins').option('--json', 'JSON array')
    .action((opts: { json?: boolean }) => {
      try {
        const root = elanousStateRoot();
        const ledgerPath = join(root, 'plugins', 'installed.json');
        const ledger: unknown = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : [];
        if (!Array.isArray(ledger) || !ledger.every(row => row && typeof row.market === 'string' && typeof row.name === 'string' && typeof row.version === 'string')) throw new Error('invalid plugin ledger');
        const registered = new Set(ledger.map((row: { market: string; name: string; version: string }) => `${row.market}/${row.name}/${row.version}`));
        const installed = listInstalledPlugins(root).filter(item => registered.has(`${item.market}/${item.name}/${item.version}`));
        debug.log('plugin.cli', 'list', { count: installed.length });
        if (opts.json) stdout.write(JSON.stringify(installed) + '\n');
        else for (const item of installed) console.log(`${item.name}@${item.version} (${item.market})`);
      } catch {
        console.error('plugin list failed: invalid plugin ledger');
        process.exitCode = 1;
      }
    });
  plugin.command('remove <name>').description('Remove installed plugin versions')
    .action((name: string) => {
      try {
        const count = removePlugin(name, elanousStateRoot());
        debug.log('plugin.cli', 'remove', { count });
        console.log(`Removed ${count} installation(s) of ${name}`);
      } catch {
        console.error('plugin remove failed');
        process.exitCode = 1;
      }
    });
}
