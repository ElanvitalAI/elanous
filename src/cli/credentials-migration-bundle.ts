import { SERVICE_KEY_CATALOG } from '../setup/service-key-catalog.js';
import { decryptSecretBundle, encryptSecretBundle } from '../nexus/config/secrets/transfer.js';

const MANIFEST_ID = 'migration:manifest';
// A catalog name, environment name and store name can refer to the same key.
// Multi-field service labels overlap every field; distinct fields do not overlap each other.
const staticSlotsById = new Map<string, readonly string[]>();
for (const entry of SERVICE_KEY_CATALOG.filter((row) => row.kind === 'api-key')) {
  const storeIds = entry.storeIds ?? [];
  if (storeIds.length > 1) {
    const fieldSlots = Array.from({ length: Math.max(entry.envNames.length, storeIds.length) },
      (_, index) => `${entry.id}:${index}`);
    staticSlotsById.set(entry.id, fieldSlots);
    entry.envNames.forEach((id, index) => staticSlotsById.set(id, [fieldSlots[index]!]));
    storeIds.forEach((id, index) => { if (!id.startsWith('cred:')) staticSlotsById.set(id, [fieldSlots[index]!]); });
  } else {
    for (const id of [entry.id, ...entry.envNames, ...storeIds]) {
      if (!id.startsWith('cred:')) staticSlotsById.set(id, [entry.id]);
    }
  }
}

export function migrationStaticSlots(id: string): readonly string[] | undefined { return staticSlotsById.get(id); }
export function isExportableMigrationStaticId(id: string): boolean { return staticSlotsById.has(id); }
export function assertDistinctMigrationStaticIds(ids: readonly string[]): void {
  const slots = new Set<string>();
  for (const id of ids) {
    const aliases = migrationStaticSlots(id);
    if (!aliases) throw new Error('INVALID_MIGRATION_CONTENTS');
    for (const slot of aliases) {
      if (slots.has(slot)) throw new Error('INVALID_MIGRATION_CONTENTS');
      slots.add(slot);
    }
  }
}

export interface TelegramMigrationSettings {
  readonly botToken: string;
  readonly homeChannel?: number;
  readonly allowedUsers: readonly number[];
}
export interface MigrationBundleContents {
  readonly sourceHost: string;
  readonly staticSecrets: Readonly<Record<string, string>>;
  readonly telegram?: TelegramMigrationSettings;
}

function assertTelegram(value: unknown): TelegramMigrationSettings | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_MIGRATION_CONTENTS');
  const row = value as Partial<TelegramMigrationSettings>;
  if (typeof row.botToken !== 'string' || !row.botToken || row.botToken.includes('\0')
    || (row.homeChannel !== undefined && (!Number.isSafeInteger(row.homeChannel) || row.homeChannel === 0))
    || !Array.isArray(row.allowedUsers) || row.allowedUsers.length > 256
    || row.allowedUsers.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('INVALID_MIGRATION_CONTENTS');
  return { botToken: row.botToken, ...(row.homeChannel !== undefined ? { homeChannel: row.homeChannel } : {}),
    allowedUsers: [...row.allowedUsers] };
}

function assertContents(input: MigrationBundleContents): MigrationBundleContents {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.sourceHost)
    || !input.staticSecrets || typeof input.staticSecrets !== 'object' || Array.isArray(input.staticSecrets))
    throw new Error('INVALID_MIGRATION_CONTENTS');
  const entries = Object.entries(input.staticSecrets);
  if (entries.some(([id, value]) => !isExportableMigrationStaticId(id) || typeof value !== 'string' || !value || value.includes('\0')))
    throw new Error('INVALID_MIGRATION_CONTENTS');
  assertDistinctMigrationStaticIds(entries.map(([id]) => id));
  if (input.telegram !== undefined && entries.some(([id]) => migrationStaticSlots(id)?.includes('telegram')))
    throw new Error('INVALID_MIGRATION_CONTENTS');
  return { sourceHost: input.sourceHost, staticSecrets: Object.fromEntries(entries),
    ...(input.telegram === undefined ? {} : { telegram: assertTelegram(input.telegram) }) };
}

/** The existing encrypted envelope carries only catalog static credentials and Telegram setup. */
export async function encryptMigrationBundle(input: MigrationBundleContents, passphrase: string): Promise<string> {
  const contents = assertContents(input);
  return encryptSecretBundle({ version: 1, secrets: {
    ...contents.staticSecrets,
    [MANIFEST_ID]: JSON.stringify({ version: 1, sourceHost: contents.sourceHost, telegram: contents.telegram }),
  } }, passphrase);
}

/** Reject older secret-export bundles and any OAuth/refresh material, even with a valid passphrase. */
export async function decryptMigrationBundle(serialized: string, passphrase: string): Promise<MigrationBundleContents> {
  const bundle = await decryptSecretBundle(serialized, passphrase);
  const manifestRaw = bundle.secrets[MANIFEST_ID];
  if (typeof manifestRaw !== 'string') throw new Error('INVALID_MIGRATION_CONTENTS');
  let manifest: { version?: unknown; sourceHost?: unknown; telegram?: unknown };
  try { manifest = JSON.parse(manifestRaw); } catch { throw new Error('INVALID_MIGRATION_CONTENTS'); }
  if (manifest.version !== 1 || typeof manifest.sourceHost !== 'string') throw new Error('INVALID_MIGRATION_CONTENTS');
  const staticSecrets = Object.fromEntries(Object.entries(bundle.secrets).filter(([id]) => id !== MANIFEST_ID));
  return assertContents({ sourceHost: manifest.sourceHost, staticSecrets,
    ...(manifest.telegram !== undefined ? { telegram: assertTelegram(manifest.telegram) } : {}) });
}
