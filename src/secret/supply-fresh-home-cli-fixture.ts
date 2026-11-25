import { Command } from 'commander';
import { registerSecretSupplyCommand } from '../cli/secret-supply-cli.js';
import { issueStaticLease } from './static-lease.js';

const issuer = process.env.FIXTURE_ISSUER!;
const home = process.env.FIXTURE_HOME!;
const canary = 'synthetic-canary-not-a-real-credential';
const secret = new Command('secret');
registerSecretSupplyCommand(secret, {
  supplyDeps: async () => ({
    configDir: issuer,
    delegates: {
      oauthIssue: async () => { throw new Error('unexpected OAuth'); },
      oauthRevoke: async () => false,
      staticRevoke: async () => false,
      staticIssue: async (id, to, ttlMs) => {
        const lease = await issueStaticLease({ id, to, ...(ttlMs === undefined ? {} : { ttlMs }) }, {
          configDir: () => issuer,
          knownConfigRoots: () => [home],
          readSourceValue: async () => canary,
          log: () => {},
        });
        return lease.ok ? { ok: true, leaseId: lease.record.leaseId, expiresAt: Date.parse(lease.record.expiresAt) } : { ok: false, reason: lease.reason };
      },
    },
  }),
});
await secret.parseAsync(process.argv.slice(2), { from: 'user' });
