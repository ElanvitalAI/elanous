import { expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemberStore } from '../nexus/members/member-store.js';
import { issueToPrivateFile, registerMemberKeyTokenCommands } from './member-key-token-cli.js';
import { Command } from 'commander';

test('member key issue retries through the official API and rejects expired sessions without network', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-key-retry-'));
  const output: string[] = []; const exits: number[] = []; let calls = 0;
  const path = join(root, 'member-session.json');
  const session = { nexusUrl: 'https://api.elanous.ai', sessionToken: 'aps_syntheticRetry', appSlug: 'demo-app', expiresAt: '2000-01-01T00:00:00Z' };
  const program = () => {
    const cmd = new Command();
    registerMemberKeyTokenCommands(cmd, cmd.command('token'), { configDir: () => root,
      output: { log: m => output.push(m), error: m => output.push(m) }, exit: code => exits.push(code),
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls++; expect(String(url)).toBe('https://api.elanous.ai/v1/member/keys');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer aps_syntheticRetry');
        return Response.json({ id: '11111111-1111-4111-8111-111111111111', key: 'emk_syntheticRetry' }, { status: 201 });
      }) as typeof fetch });
    return cmd;
  };
  try {
    writeFileSync(path, JSON.stringify(session), { mode: 0o600 });
    await program().parseAsync(['member', 'key', 'issue'], { from: 'user' });
    expect(exits).toEqual([1]); expect(calls).toBe(0);
    session.expiresAt = '2099-01-01T00:00:00Z'; writeFileSync(path, JSON.stringify(session), { mode: 0o600 });
    const before = readFileSync(path, 'utf8');
    await program().parseAsync(['member', 'key', 'issue'], { from: 'user' });
    expect(exits).toEqual([1, 0]); expect(calls).toBe(1); expect(readFileSync(path, 'utf8')).toBe(before);
    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(readFileSync(config.nexus.relay.memberKeyFile, 'utf8').trim()).toBe('emk_syntheticRetry');
    expect(output.join(' ')).not.toContain('emk_'); expect(output.join(' ')).not.toContain('aps_');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('key rotation commits only after durable private-file delivery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-key-cli-'));
  const store = createMemberStore({ path: ':memory:' });
  try {
    const member = store.register({ sub: 'cli-test', email: 'cli@example.test', emailVerified: true, name: 'CLI' },
      { consents: { privacy: 'v1', terms: 'v1' } });
    const old = member.initialKey!;
    const failedPath = join(dir, 'failed.key');
    expect(() => issueToPrivateFile(failedPath,
      deliver => store.rotateMemberKey(member.id, old.id, undefined, deliver),
      () => { throw new Error('directory sync failed'); })).toThrow('directory sync failed');
    expect(existsSync(failedPath)).toBe(false);
    expect(store.memberForKey(old.key)).toMatchObject({ keyId: old.id });
    const path = join(dir, 'rotated.key');
    const issued = issueToPrivateFile(path, deliver => store.rotateMemberKey(member.id, old.id, undefined, deliver));
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8').trim()).toBe(issued.key);
    expect(store.memberForKey(old.key)).toBeNull();
    expect(store.memberForKey(issued.key)).toMatchObject({ keyId: issued.id });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
