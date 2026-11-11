import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeSsh } from '../../../ux-sim/fake-ssh.js';
import { deliverCodexMirrorAndRecord } from '../../../oauth/codex-owner-mirror.js';
import { credentialOwnerLedgerPath, readCredentialOwner, recordCredentialMirror } from './cred-owner.js';

test('fake host delivery records one mbp original and access-only remote mirrors without values', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-owner-'));
  try {
    const path = credentialOwnerLedgerPath(root);
    const hosts = createFakeSsh({ hosts: {
      mbp: { activeSessions: 0, maxStartups: 10 }, // Source: 내부 문서 `secrets` §5.3; fixed fake host capacity.
      'host-a': { activeSessions: 0, maxStartups: 10 }, // Source: 내부 문서 `secrets` §5.3; same fixed fake host capacity.
      aws2: { activeSessions: 0, maxStartups: 10 }, // Source: 내부 문서 `secrets` §5.3; same fixed fake host capacity.
    } });
    const rawAccessValue = 'raw-simulation-access-value';
    const deliver = (host: string) => () => {
      const result = hosts.ssh(host, `install access mirror ${rawAccessValue}`);
      if (result.rc !== 0) throw new Error('fake delivery failed');
    };
    const options = { ledgerPath: path, config: { llm: {}, hq: { hostName: 'mbp' } } as never, machine: 'mbp' };
    deliverCodexMirrorAndRecord('host-a', deliver('host-a'), options);
    deliverCodexMirrorAndRecord('aws2', deliver('aws2'), options);
    const row = readCredentialOwner('cred:codex-login', path);
    expect(row).toMatchObject({ slot: 'cred:codex-login', ownerHost: 'mbp', mirrors: [
      { host: 'host-a', mode: 'access-only' }, { host: 'aws2', mode: 'access-only' },
    ] });
    expect(hosts.calls.map((call) => call.host)).toEqual(['host-a', 'aws2']);
    const receipt = readCredentialOwner('cred:codex-login', path)!;
    Object.assign(receipt.mirrors[0]!, { host: 'tampered' });
    expect(readCredentialOwner('cred:codex-login', path)?.mirrors[0]?.host).toBe('host-a');
    expect(readFileSync(path, 'utf8')).not.toContain(rawAccessValue);
    expect(JSON.stringify(row)).not.toContain(rawAccessValue);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('non-owner host, failed delivery, and owner-as-mirror leave the owner ledger unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-owner-'));
  try {
    const path = credentialOwnerLedgerPath(root);
    const owner = { ledgerPath: path, config: { llm: {}, hq: { hostName: 'mbp' } } as never, machine: 'mbp' };
    let delivered = 0;
    expect(() => deliverCodexMirrorAndRecord('host-a', () => { delivered++; }, {
      ledgerPath: path, config: { llm: { codexTokenOwnerHost: 'host-a' }, hq: { hostName: 'host-a' } } as never, machine: 'host-a',
    })).toThrow('owner host');
    expect(delivered).toBe(0);
    expect(readCredentialOwner('cred:codex-login', path)).toBeUndefined();
    expect(() => deliverCodexMirrorAndRecord('host-a', () => {
      throw Object.assign(new Error('raw-simulation-access-value'), { code: 'ETIMEDOUT', rc: 255 }); // Source: SSH process exit status is an unsigned byte; the fake error body is intentionally private.
    }, owner)).toThrow('CODEX_MIRROR_DELIVERY_FAILED (reason=ETIMEDOUT; rc=255)');
    expect(readCredentialOwner('cred:codex-login', path)).toBeUndefined();
    expect(() => deliverCodexMirrorAndRecord('mbp', () => { delivered++; }, owner)).toThrow('owner cannot be a mirror');
    expect(delivered).toBe(0);
    expect(readCredentialOwner('cred:codex-login', path)).toBeUndefined();
    expect(() => recordCredentialMirror({ slot: 'cred:codex-login', ownerHost: 'host-a', mirrorHost: 'aws2' }, path))
      .toThrow('owner host must be mbp');
    expect(() => recordCredentialMirror({ slot: 'cred:unknown', ownerHost: 'mbp', mirrorHost: 'aws2' }, path))
      .toThrow('CREDENTIAL_OWNER_SLOT_INVALID');
    writeFileSync(path, '{"version":1,"slots":[{"slot":"cred:codex-login","ownerHost":"host-a","mirrors":[]}]}'); // Source: 내부 문서 `secrets` §5.6; forbidden non-mbp original fixture.
    expect(() => deliverCodexMirrorAndRecord('host-a', () => { delivered++; }, owner)).toThrow('CREDENTIAL_OWNER_LEDGER_CORRUPT');
    expect(delivered).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
