import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { userConfigPath } from '../user-config.js';
import { debug, redactSecretText } from '../debug/log.js';
import { addMarket, listMarkets, MarketFetchError, updateMarket } from '../plugins/install/market-fetch.js';
import { emitDecision } from '../live/detail-switch.js';
import { OFFICIAL_INDEX_KEYS } from '../market/official-keys.js';
import { installPlugin, listInstalledPlugins, PluginInstallError, removePlugin, type InstallEvent } from '../plugins/install/plugin-install.js';
import { credentialStatus, setPluginCredentials } from '../plugins/install/plugin-credentials.js';

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

function outputEvent(event: InstallEvent, json: boolean, nodeCount: { value: number }): void {
  // Connector field names are useful; values and secret-field metadata are not needed here.
  const safe = event.event === 'credentials'
    ? { event: 'credentials', connectors: event.connectors.map(({ id, fields }) => ({ id, fields: fields.map(({ name }) => name) })) }
    : event;
  debug.log('plugin.cli', event.event, { event: event.event });
  if (event.event === 'registered') nodeCount.value = event.nodes.length;
  if (json) stdout.write(JSON.stringify(safe) + '\n');
  else if (event.event === 'credentials') {
    if (event.connectors.length) console.log(`Connectors: ${event.connectors.map(connector => connector.id).join(', ')} — configure via elanous connector settings (no secrets requested here)`);
  } else if (event.event === 'done') console.log(`Installed ${event.plugin}@${event.version} (${nodeCount.value} nodes)`);
  else if (event.event === 'consent' && event.required) console.log(`Permissions: ${event.capabilities.join(', ')}`);
}

/** Only our own install/market errors carry a cause (fixed wording that may name the user's own spec); URLs and secrets are masked; any other error stays generic. */
function safeCause(error: unknown): string {
  if (!(error instanceof PluginInstallError || error instanceof MarketFetchError)) return 'unexpected error';
  return redactSecretText(error.message.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]'));
}

export function registerPluginCommands(program: Command): void {
  const plugin = program.command('plugin').description('Install and manage Elanous plugins');
  plugin.command('add <spec>').description('Install a local path, pinned git plugin or signed market plugin')
    .option('--yes', 'Accept requested capabilities')
    .option('--json', 'NDJSON progress events')
    .option('--allow-unsigned', 'Allow unsigned marketplace indices')
    .option('--refresh', 'Refresh the signed marketplace index before installing')
    .action(async (spec: string, opts: { yes?: boolean; json?: boolean; allowUnsigned?: boolean; refresh?: boolean }) => {
      try {
        const root = elanousStateRoot();
        const nodeCount = { value: 0 };
        await installPlugin(spec, {
          root, marketDir: join(root, 'plugins', 'markets'), trustedKeys: keys(),
          yes: opts.yes, allowUnsigned: opts.allowUnsigned, refresh: opts.refresh,
          onEvent: event => outputEvent(event, !!opts.json, nodeCount),
          consent: capabilities => askConsent(capabilities, !!opts.json),
        });
        emitDecision({ kind: 'ROUTE', what: 'plugin add', reason: 'plugin installed', purpose: 'make plugin available', target: 'plugin host' });
      } catch (error) {
        const reason = error instanceof PluginInstallError ? error.reason : 'io';
        const detail = reason === 'consent-denied' ? 'plugin capabilities require consent' : `plugin installation ${reason} error`;
        const cause = safeCause(error);
        debug.log('plugin.cli', 'failed', { reason, cause }, { level: 'error' });
        emitDecision({ kind: 'ESCALATE', what: 'plugin add', reason, purpose: 'report installation failure', target: 'user' });
        if (opts.json) stdout.write(JSON.stringify({ event: 'failed', reason, detail, ...(reason === 'consent-denied' ? {} : { cause }) }) + '\n');
        else console.error(`plugin add failed: ${detail}${reason === 'consent-denied' ? '' : `: ${cause}`}`);
        process.exitCode = 1;
      }
    });
  const market = plugin.command('market').description('Manage signed plugin marketplaces');
  market.command('add <name> <url>').description('Register a marketplace URL')
    .action((name: string, url: string) => {
      try {
        const added = addMarket(name, url);
        debug.log('plugin.cli', 'market.add', { name: added.name });
        console.log(`Added market ${added.name} (${added.url})`);
      } catch (error) {
        console.error(`plugin market add failed: ${safeCause(error)}`);
        process.exitCode = 1;
      }
    });
  market.command('list').description('List configured marketplaces').option('--json', 'JSON array')
    .action((opts: { json?: boolean }) => {
      try {
        const markets = listMarkets();
        debug.log('plugin.cli', 'market.list', { count: markets.length });
        if (opts.json) stdout.write(JSON.stringify(markets) + '\n');
        else for (const entry of markets) console.log(`${entry.name} (${entry.url})`);
      } catch (error) {
        if (opts.json) stdout.write(JSON.stringify({ event: 'failed', cause: safeCause(error) }) + '\n');
        else console.error(`plugin market list failed: ${safeCause(error)}`);
        process.exitCode = 1;
      }
    });
  market.command('update [name]').description('Refresh signed marketplace indices')
    .action(async (name?: string) => {
      try {
        const markets = listMarkets();
        const selected = name ? markets.filter(entry => entry.name === name) : markets;
        if (!selected.length) throw new Error('market not configured');
        const root = elanousStateRoot();
        for (const entry of selected) {
          try {
            const result = await updateMarket(entry.name, { root, marketDir: join(root, 'plugins', 'markets') });
            debug.log('plugin.cli', 'market.update', { name: result.market.name, sequence: result.index.sequence });
            console.log(`Updated market ${result.market.name} (sequence ${result.index.sequence})`);
          } catch (error) {
            console.error(`plugin market update ${entry.name} failed: ${safeCause(error)}`);
            process.exitCode = 1;
          }
        }
      } catch (error) {
        console.error(`plugin market update failed: ${safeCause(error)}`);
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
        else for (const item of installed) console.log(`${item.name}@${item.version} (${item.market})${item.installedAt ? ` — installed ${item.installedAt}` : ''}`);
      } catch {
        console.error('plugin list failed: invalid plugin ledger');
        process.exitCode = 1;
      }
    });
  plugin.command('credentials <plugin>').description('Show or update installed plugin credential status')
    .option('--set <NAME=VALUE>', 'Set a declared field', (value: string, values: string[]) => [...values, value], [] as string[])
    .option('--unset <NAME>', 'Remove a declared field', (value: string, values: string[]) => [...values, value], [] as string[])
    .option('--stdin <NAME>', 'Read one credential value from standard input')
    .option('--json', 'JSON status')
    .action(async (name: string, opts: { set: string[]; unset: string[]; stdin?: string; json?: boolean }) => {
      try {
        const root = elanousStateRoot();
        const fields: Record<string, string | null> = Object.create(null);
        for (const assignment of opts.set) {
          const equal = assignment.indexOf('=');
          if (equal < 1) throw new Error('invalid credential assignment');
          fields[assignment.slice(0, equal)] = assignment.slice(equal + 1);
        }
        for (const field of opts.unset) fields[field] = null;
        if (opts.stdin !== undefined) {
          let input = '';
          for await (const chunk of stdin) {
            input += chunk.toString();
            if (input.includes('\n')) break;
          }
          if (!input) throw new Error('credential stdin is empty');
          fields[opts.stdin] = input.split(/\r?\n/, 1)[0]!;
        }
        if (Object.keys(fields).length > 0) {
          setPluginCredentials(name, fields, root);
          debug.log('plugin.credentials', 'set', { plugin: name, fields: Object.keys(fields), count: Object.keys(fields).length });
        }
        const status = credentialStatus(name, root);
        if (opts.json) stdout.write(JSON.stringify(status) + '\n');
        else for (const field of status.fields) console.log(`${field.name}\t${field.env}\t${field.set ? 'set' : 'unset'}`);
        // The web app's PUT reloads MCP clients itself; a CLI write reaches an already-running daemon only after a reload.
        // stderr in both modes, so `--json` stdout stays one JSON line.
        if (Object.keys(fields).length > 0) console.error('A running daemon applies this to plugin MCP servers after `elanous mcp reload` (the web app does it for you).');
      } catch {
        if (opts.json) stdout.write(JSON.stringify({ error: 'plugin credentials failed' }) + '\n');
        else console.error('plugin credentials failed');
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
