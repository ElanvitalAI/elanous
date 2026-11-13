/** Value-free preflight for moving credentials between hosts. Secret material is never an input. */
export type MigrationKind = 'static-key' | 'telegram-bot' | 'oauth-access' | 'single-use-refresh' | 'setup-token';
export type MigrationAction = 'encrypted-restore' | 'access-mirror' | 'relogin-and-transfer' | 'reissue-on-destination';
export type MigrationBlocker = 'destination-conflict' | 'bot-poller-active' | 'source-poller-unknown' | 'destination-state-unknown' | 'owner-fence-missing' | 'access-mirror-missing' | 'setup-token-reissue-required';

export interface MigrationSource {
  id: string;
  kind: MigrationKind;
  ownerHost?: string;
  destinationPresent?: boolean;
  sourcePollerActive?: boolean;
  destinationPollerActive?: boolean;
  ownerFenceHeld?: boolean;
  accessMirrorReady?: boolean;
}

export interface MigrationPlanRow {
  id: string;
  kind: MigrationKind;
  action: MigrationAction;
  ownerChange: string;
  blocker: MigrationBlocker | null;
  verify: string;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hostPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Never accept credential values, raw file paths or arbitrary text into printable plan rows. */
export function planCredentialMigration(sources: readonly MigrationSource[], destinationHost: string): MigrationPlanRow[] {
  if (!hostPattern.test(destinationHost)) throw new Error('INVALID_DESTINATION_HOST');
  const seen = new Set<string>();
  return sources.map((source) => {
    if (!idPattern.test(source.id) || seen.has(source.id)) throw new Error('INVALID_CREDENTIAL_ID');
    seen.add(source.id);
    if (source.ownerHost !== undefined && !hostPattern.test(source.ownerHost)) throw new Error('INVALID_OWNER_HOST');
    const ownerChange = source.ownerHost === undefined ? 'unknown'
      : source.ownerHost !== destinationHost ? `${source.ownerHost} -> ${destinationHost}` : 'none';
    switch (source.kind) {
      case 'static-key':
        return { id: source.id, kind: source.kind, action: 'encrypted-restore', ownerChange,
          blocker: source.destinationPresent === undefined ? 'destination-state-unknown'
            : source.destinationPresent ? 'destination-conflict' : null, verify: 'provider-ping' };
      case 'telegram-bot':
        return { id: source.id, kind: source.kind, action: 'encrypted-restore', ownerChange,
          blocker: source.sourcePollerActive === true || source.destinationPollerActive === true ? 'bot-poller-active'
            : source.destinationPresent === true ? 'destination-conflict'
            : source.sourcePollerActive === undefined ? 'source-poller-unknown'
            : source.destinationPollerActive === undefined || source.destinationPresent === undefined ? 'destination-state-unknown'
            : null, verify: 'getMe+send+receive' };
      case 'oauth-access':
        return { id: source.id, kind: source.kind, action: 'access-mirror',
          ownerChange: source.ownerHost === undefined ? 'unknown' : 'none',
          blocker: source.accessMirrorReady ? null : 'access-mirror-missing', verify: 'one-authenticated-call' };
      case 'single-use-refresh':
        return { id: source.id, kind: source.kind, action: 'relogin-and-transfer', ownerChange,
          blocker: !source.ownerFenceHeld ? 'owner-fence-missing'
            : !source.accessMirrorReady ? 'access-mirror-missing' : null, verify: 'new-owner-authenticated-call' };
      case 'setup-token':
        return { id: source.id, kind: source.kind, action: 'reissue-on-destination', ownerChange,
          blocker: 'setup-token-reissue-required', verify: 'new-owner-authenticated-call' };
      default:
        throw new Error('UNSUPPORTED_CREDENTIAL_KIND');
    }
  });
}

export function renderCredentialMigrationDryRun(rows: readonly MigrationPlanRow[]): string {
  const lines = ['id\tkind\taction\towner-change\tblocker\tverify'];
  for (const row of rows) lines.push([row.id, row.kind, row.action, row.ownerChange, row.blocker ?? 'none', row.verify].join('\t'));
  return lines.join('\n');
}
