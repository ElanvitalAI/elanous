import type { Command } from 'commander';
import { SERVICE_KEY_CATALOG, type ServiceKeyCatalogEntry } from '../setup/service-key-catalog.js';
import { verifyServiceKey, type ServiceKeyVerification } from '../setup/service-keys.js';

export interface CredentialInventoryRow {
  id: string;
  service: string;
  type: 'static-key' | 'subscription-login' | 'oauth-login' | 'cli-login' | 'local-tool' | 'unknown';
  status: 'present' | 'missing' | 'provider-managed' | 'local-only';
  source: string[];
  transfer: 'encrypted-bundle' | 'store-before-transfer' | 're-login' | 'none' | 'manual-review';
  verification: string;
}

export function buildCredentialInventory(
  catalog: readonly ServiceKeyCatalogEntry[],
  storedIds: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): CredentialInventoryRow[] {
  const stored = new Set(storedIds);
  const catalogRows: CredentialInventoryRow[] = catalog.map((entry): CredentialInventoryRow => {
    if (entry.kind === 'api-key') {
      const environmentNames = entry.envNames.filter((name) => Object.prototype.hasOwnProperty.call(environment, name));
      const secretNames = [entry.id, ...entry.envNames, ...(entry.storeIds ?? [])].filter((id) => stored.has(id));
      const source = [...new Set([
        ...environmentNames.map((name) => `env:${name}`),
        ...secretNames.map((id) => `eln-secret:${id}`),
      ])];
      return {
        id: entry.id,
        service: entry.label,
        type: 'static-key',
        status: source.length ? 'present' : 'missing',
        source,
        transfer: secretNames.length ? 'encrypted-bundle' : 'store-before-transfer',
        verification: entry.verification,
      };
    }
    if (entry.kind === 'subscription' || entry.kind === 'oauth' || entry.kind === 'cli') {
      return {
        id: entry.id,
        service: entry.label,
        type: entry.kind === 'subscription' ? 'subscription-login' : `${entry.kind}-login`,
        status: 'provider-managed',
        source: ['provider-managed · login state not inspected'],
        transfer: 're-login',
        verification: entry.verification,
      };
    }
    return {
      id: entry.id,
      service: entry.label,
      type: 'local-tool',
      status: 'local-only',
      source: ['local installation · credential not inspected'],
      transfer: 'none',
      verification: entry.verification,
    };
  });
  const knownStoredIds = new Set(catalog.flatMap((entry) => [entry.id, ...entry.envNames, ...(entry.storeIds ?? [])]));
  const unmappedRows: CredentialInventoryRow[] = storedIds
    .filter((id) => !knownStoredIds.has(id))
    .map((id) => ({
      id,
      service: 'Unmapped stored credential',
      type: 'unknown',
      status: 'present',
      source: [`eln-secret:${id}`],
      transfer: 'manual-review',
      verification: 'not configured',
    }));
  return [...catalogRows, ...unmappedRows];
}

export interface CredCliDeps {
  listSecrets: () => Promise<string[]>;
  getSecret: (id: string) => Promise<string | undefined>;
  verifySecret?: (serviceId: string, value: string) => Promise<{ result: ServiceKeyVerification; httpStatus?: number }>;
  storageBackend: () => string;
  initializeBackend: () => void;
  environment?: Readonly<Record<string, string | undefined>>;
  output?: { log: (line: string) => void; error: (line: string) => void };
  setExitCode?: (code: number) => void;
}

export function registerCredCommands(program: Command, deps: CredCliDeps): Command {
  const output = deps.output ?? console;
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const cred = program.command('cred').description('Inventory credential metadata without displaying credential values.');
  cred.command('inventory')
    .description('Show service, storage source names, credential type, and transfer policy; values are never read.')
    .option('--json', 'Print the inventory as JSON.')
    .allowExcessArguments(false)
    .action(async (options: { json?: boolean }) => {
      try {
        deps.initializeBackend();
        const rows = buildCredentialInventory(SERVICE_KEY_CATALOG, await deps.listSecrets(), deps.environment ?? process.env);
        if (options.json) {
          output.log(JSON.stringify({ storage: deps.storageBackend(), credentials: rows }, null, 2));
        } else {
          output.log(`storage\t${deps.storageBackend()}`);
          output.log('id\ttype\tstatus\tsource\ttransfer\tverification');
          for (const row of rows) output.log(`${row.id}\t${row.type}\t${row.status}\t${row.source.join(', ') || 'none'}\t${row.transfer}\t${row.verification}`);
        }
        setExitCode(0);
      } catch {
        output.error('credential inventory failed');
        setExitCode(1);
      }
    });
  cred.command('check <id>')
    .description('Make one bounded service verification request; only a status is displayed.')
    .allowExcessArguments(false)
    .action(async (id: string) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
        output.error('invalid credential identifier');
        setExitCode(1);
        return;
      }
      const service = SERVICE_KEY_CATALOG.find((entry) => entry.id === id && entry.kind === 'api-key');
      if (!service) {
        output.error('credential check is unsupported for this id');
        setExitCode(2);
        return;
      }
      try {
        deps.initializeBackend();
        const value = await deps.getSecret(id);
        if (!value) {
          output.log('check ' + id + ' · missing');
          setExitCode(1);
          return;
        }
        const result = await (deps.verifySecret ?? (async (serviceId, secret) => verifyServiceKey(serviceId, secret)))(service.id, value);
        const status = result.httpStatus === undefined ? result.result : result.result + ' · HTTP ' + result.httpStatus;
        output.log('check ' + id + ' · ' + status);
        setExitCode(result.result === 'verified' ? 0 : 1);
      } catch {
        output.error('credential check failed');
        setExitCode(1);
      }
    });
  return cred;
}
