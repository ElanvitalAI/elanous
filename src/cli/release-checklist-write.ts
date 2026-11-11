import { join } from 'node:path';
import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../instance/resolve.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { getUserConfig } from '../user-config/reader.js';
import { hqCliWriteAllowed } from '../hq/hq.js';
import { fileLeaseStore } from '../hq/lease.js';
import { isIsolatedLedgerWriteRoot } from '../hq/ledger-write-target.js';

export function mayWriteReleaseChecklist(cmd: Command): boolean {
  const command = 'release checklist ' + cmd.name();
  const ledgerRoot = releaseLedgerRoot();
  if (isIsolatedLedgerWriteRoot(ledgerRoot)) {
    try {
      debug.log('hq.fence', 'skipped-isolated', { root: ledgerRoot, command });
    } catch {
      /* fail-soft */
    }
    return true;
  }
  const override = Boolean(cmd.optsWithGlobals().hqOverride);
  const configOverride = getElanousConfigDirOverride();
  const config = configOverride ? getUserConfig() : undefined;
  const deps =
    configOverride && !config?.hq?.arbiter
      ? {
          store: fileLeaseStore(join(effectiveInstanceRoot(), 'hq', 'lease.json')),
          seenPath: join(effectiveInstanceRoot(), 'hq', 'seen-generation'),
          localPath: join(effectiveInstanceRoot(), 'hq', 'local.json'),
        }
      : {};
  return hqCliWriteAllowed(command, override, deps);
}
