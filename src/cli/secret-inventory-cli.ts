// HQ-VAULT V1 · `eln secret inventory [--json]` — read only, values 0.
// Registered under the existing `secret` command in secret-cli.ts.

import type { Command } from 'commander';
import { lstatSync, readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { elanousConfigDir } from '../nexus/config/paths.js';
import { collectSecretInventory, renderSecretInventory, type InventoryFs } from '../nexus/config/secrets/vault/inventory.js';
import { readVaultMeta, type VaultItemMeta } from '../nexus/config/secrets/vault/meta.js';
import { defaultVaultDir, vaultEnvelopePath } from '../nexus/config/secrets/vault/store.js';
import { defaultVaultEventSink, vaultEvent, type VaultEventSink } from '../nexus/config/secrets/vault/events.js';

export interface SecretInventoryCliDeps {
  home?: string;
  configDir?: string;
  vaultDir?: string;
  fs?: InventoryFs;
  now?: () => Date;
  uid?: number;
  host?: string;
  emit?: VaultEventSink;
  output?: { log: (line: string) => void; error: (line: string) => void };
  setExitCode?: (code: number) => void;
}

const nodeInventoryFs: InventoryFs = {
  lstat(path) {
    try { return lstatSync(path); } catch { return undefined; }
  },
  readdir(path) { return readdirSync(path); },
};

export function registerSecretInventoryCommand(secret: Command, deps: SecretInventoryCliDeps = {}): Command {
  const io = deps.output ?? console;
  const exit = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  return secret.command('inventory')
    .description('List vault items (metadata) and known credential file locations: existence, mode and owner only — never values.')
    .option('--json', 'machine-readable output')
    .allowExcessArguments(false)
    .action((opts: { json?: boolean }) => {
      const now = (deps.now ?? (() => new Date()))();
      const emit = deps.emit ?? defaultVaultEventSink;
      const vaultDir = deps.vaultDir ?? defaultVaultDir();
      let items: readonly VaultItemMeta[];
      try { items = readVaultMeta(vaultDir).items; }
      catch (error) {
        const code = error instanceof Error && /^VAULT_[A-Z_]+$/.test(error.message) ? error.message : 'VAULT_META_UNREADABLE';
        io.error(`secret inventory: vault metadata unreadable (${code})`);
        emit(vaultEvent('inventory', { reason: code }, now, 'warn'));
        exit(1);
        return;
      }
      const inventory = collectSecretInventory({
        home: deps.home ?? homedir(),
        configDir: deps.configDir ?? elanousConfigDir(),
        vaultDir,
        items,
        envelopePath: (id) => vaultEnvelopePath(vaultDir, id),
        fs: deps.fs ?? nodeInventoryFs,
        now,
        uid: deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1),
        host: deps.host ?? hostname().toLowerCase().replace(/\.local$/, ''),
      });
      emit(vaultEvent('inventory', { items: inventory.summary.items, external: inventory.summary.external,
        risky: inventory.summary.risky, flags: inventory.summary.flags }, now, inventory.summary.risky > 0 ? 'warn' : 'info'));
      if (opts.json) io.log(JSON.stringify(inventory, null, 2));
      else for (const line of renderSecretInventory(inventory)) io.log(line);
      exit(0);
    });
}
