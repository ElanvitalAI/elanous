/** One-time, name-only migration from literal market .env files into `eln secret` credential slots. */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSecretEnvFile } from '../src/nexus/config/secrets/env-import.js';
import { listCredentialSlotsAsync, setCredentialSlotBatchAsync } from '../src/nexus/config/secrets/cred-slots.js';
import { selectBackendFromConfig } from '../src/nexus/config/secrets/index.js';

const slots = {
  EODHD_API_KEY: 'cred:eodhd.api_key',
  TOSSINVEST_CLIENT_ID: 'cred:toss.client_id',
  TOSSINVEST_CLIENT_SECRET: 'cred:toss.client_secret',
  TOSSINVEST_ACCOUNT_SEQ: 'cred:toss.account_seq',
  TWELVEDATA_API_KEY: 'cred:twelvedata.api_key',
  FDS_API_KEY: 'cred:fds.api_key',
  KRX_API_KEY: 'cred:krx.api_key',
  KIS_APP_KEY: 'cred:kis.app_key',
  KIS_APP_SECRET: 'cred:kis.app_secret',
  KIS_ACCOUNT: 'cred:kis.account',
  KIS_ACCOUNT_NO: 'cred:kis.account',
  FINNHUB_API_KEY: 'cred:finnhub.api_key',
} as const;

export function planMarketEnvMigration(contents: readonly string[], existingIds: ReadonlySet<string>): Record<string, string> {
  const planned: Record<string, string> = {};
  for (const content of contents) {
    // Reuse the secret CLI's strict parser; .env files may omit the `export` keyword.
    const normalized = content.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      return !trimmed || trimmed.startsWith('#') || trimmed.startsWith('export ') ? line : `export ${line}`;
    }).join('\n');
    const parsed = parseSecretEnvFile(normalized);
    for (const [name, value] of Object.entries(parsed)) {
      const id = slots[name as keyof typeof slots];
      if (!id) continue;
      if (existingIds.has(id) || Object.hasOwn(planned, id)) throw new Error('credential slot already present or duplicated');
      planned[id] = value;
    }
  }
  if (!Object.keys(planned).length) throw new Error('no supported market credentials found');
  return planned;
}

/** KIS_MODE is configuration, never a credential slot. */
export function planKisMode(contents: readonly string[]): 'real' | 'vts' | undefined {
  let mode: 'real' | 'vts' | undefined;
  for (const content of contents) {
    const normalized = content.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      return !trimmed || trimmed.startsWith('#') || trimmed.startsWith('export ') ? line : `export ${line}`;
    }).join('\n');
    const raw = parseSecretEnvFile(normalized).KIS_MODE;
    if (raw === undefined) continue;
    const next = raw === 'real' || raw === 'prod' ? 'real' : raw === 'vts' || raw === 'paper' ? 'vts' : undefined;
    if (!next || (mode && mode !== next)) throw new Error('invalid or conflicting KIS_MODE');
    mode = next;
  }
  return mode;
}

export async function migrateMarketEnvFiles(paths: readonly string[], output: (line: string) => void = console.log): Promise<readonly string[]> {
  const contents = paths.filter(existsSync).map((path) => readFileSync(path, 'utf8'));
  selectBackendFromConfig();
  const existing = new Set((await listCredentialSlotsAsync()).filter((slot) => slot.present).map((slot) => slot.id));
  const planned = planMarketEnvMigration(contents, existing);
  const mode = planKisMode(contents);
  const modePath = join(homedir(), '.elanous/market-data.json');
  const current: { kis?: { mode?: string }; [key: string]: unknown } = mode && existsSync(modePath)
    ? JSON.parse(readFileSync(modePath, 'utf8')) : {};
  if (mode && current.kis?.mode && current.kis.mode !== mode) throw new Error('KIS mode already configured differently');
  await setCredentialSlotBatchAsync(planned);
  if (mode && !current.kis?.mode) {
    mkdirSync(dirname(modePath), { recursive: true });
    writeFileSync(`${modePath}.tmp`, JSON.stringify({ ...current, kis: { ...current.kis, mode } }) + '\n', { mode: 0o600 });
    renameSync(`${modePath}.tmp`, modePath);
  }
  if (mode) {
    output('configured kis.mode');
  }
  const names = Object.keys(planned).sort();
  for (const name of names) output(`imported ${name}`);
  output('source .env files retained; retire them after dependent skill migration is verified');
  return names;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const paths = args.length ? args : [...new Set([
    join(homedir(), '.claude/skills/omni-market/.env'),
    join(homedir(), '.claude/skills/kr-flow/.env'),
    process.env.CONATUS_ENV || join(homedir(), '.elanous/conatus/.env'),
    ...(process.env.CONATUS_DIR ? [join(process.env.CONATUS_DIR, '.env')] : []),
  ])];
  migrateMarketEnvFiles(paths).catch(() => {
    console.error('market credential migration failed; no values were displayed');
    process.exitCode = 1;
  });
}
