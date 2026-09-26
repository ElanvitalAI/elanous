import { copyFileSync, existsSync, openSync, closeSync, readFileSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { userConfigPath } from '../../src/nexus/config/paths.js';
import { getSecret } from '../../src/nexus/config/secrets/index.js';
import { isSecretRef, secretIdFromRef } from '../../src/nexus/config/types.js';
import { probeChannelBotToken, resolveChannelBotToken, storeChannelBotToken, type ChannelBotPlatform } from '../../src/channel-bot-token.js';

type RawConfig = Record<string, unknown> & { tabs?: Record<string, { tokenRef?: unknown }> };
type Candidate = {
  platform: ChannelBotPlatform;
  token: string;
  id: string;
  action: 'new-ref' | 'replace-stale-ref' | 'reuse-ref' | 'remove-empty-plaintext' | 'skipped';
  stale?: 'invalid-form' | 'missing-secret';
  reason?: 'no-plaintext' | 'empty-plaintext';
};
const PLATFORMS: ChannelBotPlatform[] = ['telegram', 'discord'];

class MigrationFailure extends Error {
  constructor(readonly reason: string, readonly platform?: ChannelBotPlatform) {
    super(reason);
  }
}

const USAGE = 'usage: channel-bot-token-migrate.ts [--apply] [--verify] [--config-dir DIR]';

function readConfig(path: string): RawConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
}

function candidates(cfg: RawConfig, checkConflicts = true): Candidate[] {
  const found: Candidate[] = [];
  for (const platform of PLATFORMS) {
    const section = cfg[platform];
    const hasPlaintext = typeof section === 'object' && section !== null && Object.hasOwn(section, 'botToken');
    if (!hasPlaintext && checkConflicts) continue;
    const token = hasPlaintext ? (section as Record<string, unknown>).botToken : '';
    if (typeof token !== 'string') throw new MigrationFailure('invalid botToken', platform);
    const ref = cfg.tabs?.[`${platform}:1`]?.tokenRef;
    const hasRef = ref != null && ref !== '';
    const refId = isSecretRef(ref) ? secretIdFromRef(ref) : null;
    const stale = hasRef && !refId ? 'invalid-form'
      : refId && getSecret(refId) === undefined ? 'missing-secret' : undefined;
    const id = `${platform}_1__tokenRef`;
    const action = !hasPlaintext ? 'skipped' : !token ? 'remove-empty-plaintext'
      : stale ? 'replace-stale-ref' : refId ? 'reuse-ref' : 'new-ref';
    const reason = !hasPlaintext ? 'no-plaintext' : !token ? 'empty-plaintext' : undefined;
    if (token && checkConflicts) {
      const existing = getSecret(id);
      const referenced = refId && !stale ? getSecret(refId) : undefined;
      if ((existing !== undefined && existing !== token) || (referenced !== undefined && referenced !== token))
        throw new MigrationFailure('secret conflict', platform);
      const envName = platform === 'telegram' ? 'ELANOUS_TELEGRAM_BOT_TOKEN' : 'ELANOUS_DISCORD_BOT_TOKEN';
      const envToken = process.env[envName];
      if (envToken && envToken !== token && existing === undefined) {
        throw new MigrationFailure('environment token conflict', platform);
      }
    }
    found.push({ platform, token, id, action, ...(stale ? { stale } : {}), ...(reason ? { reason } : {}) });
  }
  return found;
}

export async function migrateChannelBotTokens(apply = false): Promise<void> {
  const path = userConfigPath();
  if (!existsSync(path)) { console.log('No config found; nothing to migrate'); return; }
  if (!apply) {
    for (const entry of candidates(readConfig(path), false)) {
      console.log(`dry-run: ${entry.platform} · action=${entry.action} · plaintext=${entry.token ? 'present' : 'absent'}${entry.stale ? ` · stale=${entry.stale}` : ''}${entry.reason ? ` · reason=${entry.reason}` : ''}`);
    }
    return;
  }
  let pending: Candidate[] = [];
  await storeChannelBotToken(cfg => {
    pending = candidates(cfg as RawConfig);
    if (pending.length === 0) return [];
    const backup = `${path}.channel-bot-token-${randomUUID()}.bak`;
    const fd = openSync(backup, 'wx', 0o600);
    closeSync(fd);
    copyFileSync(path, backup);
    chmodSync(backup, 0o600);
    console.log(`Backup: ${backup}`);
    return pending.map(({ platform, token }) => ({ platform, token }));
  }, true);
  if (pending.length === 0) { console.log('Nothing to migrate'); return; }
  for (const { platform } of pending) console.log(`migrated: ${platform}`);
  console.log('Bot restart required; restart manually.');
}

export async function verifyChannelBotTokens(): Promise<boolean> {
  const cfg = readConfig(userConfigPath());
  let failed = false;
  let verified = 0;
  for (const platform of PLATFORMS) {
    const ref = cfg.tabs?.[`${platform}:1`]?.tokenRef;
    const hasRef = ref != null && ref !== '';
    const refId = isSecretRef(ref) ? secretIdFromRef(ref) : null;
    const referencedSecret = refId ? getSecret(refId) : undefined;
    if (hasRef && !referencedSecret) {
      console.error(`${platform}: verification failed (tokenRef secret unavailable)`);
      failed = true;
      continue;
    }
    const token = resolveChannelBotToken(platform, cfg as Parameters<typeof resolveChannelBotToken>[1])?.token;
    if (!token) continue;
    verified++;
    const result = await probeChannelBotToken(platform, token);
    if (result.ok) console.log(`${platform}: ${result.botName}`);
    else {
      console.error(`${platform}: verification failed`);
      failed = true;
    }
  }
  if (verified === 0 && !failed) {
    console.error('No bot credentials to verify');
    return false;
  }
  return !failed;
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
      console.log(USAGE);
    } else {
      const dirIdx = argv.indexOf('--config-dir');
      if (dirIdx !== -1) {
        if (!argv[dirIdx + 1] || argv[dirIdx + 1].startsWith('--')) throw new MigrationFailure('usage');
        setElanousConfigDir(argv[dirIdx + 1]);
        argv.splice(dirIdx, 2);
      }
      if (argv.some(arg => arg !== '--apply' && arg !== '--verify')) throw new MigrationFailure('usage');
      if (argv.includes('--apply')) await migrateChannelBotTokens(true);
      else if (!argv.includes('--verify')) await migrateChannelBotTokens(false);
      if (argv.includes('--verify') && !(await verifyChannelBotTokens())) process.exitCode = 1;
    }
  } catch (error) {
    // Never forward arbitrary error messages: filesystem/HTTP errors can embed credentials.
    const platform = error instanceof MigrationFailure ? error.platform ?? 'migration' : 'migration';
    const reason = error instanceof MigrationFailure ? error.reason : 'config, secret store or file permissions';
    console.error(`Channel bot token migration failed: ${platform}: ${reason}`);
    process.exitCode = 1;
  }
}
