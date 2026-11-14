import type { Command } from 'commander';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { createMemberStore, type IssuedMemberKey } from '../nexus/members/member-store.js';

function privateFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('key file must be a regular 0600 file');
  const value = readFileSync(path, 'utf8').trim();
  if (!/^emk_[A-Za-z0-9]{1,43}$/.test(value)) throw new Error('invalid member key file');
  return value;
}

export function issueToPrivateFile(path: string, issue: (deliver: (issued: IssuedMemberKey) => void) => IssuedMemberKey,
  sync: (fd: number, path: string) => void = (fd, path) => {
    fsyncSync(fd);
    const dirFd = openSync(dirname(path), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }): IssuedMemberKey {
  const fd = openSync(path, 'wx', 0o600);
  try {
    return issue(issued => {
      const line = `${issued.key}\n`;
      if (writeSync(fd, line) !== Buffer.byteLength(line)) throw new Error('member key file write incomplete');
      sync(fd, path);
    });
  } catch (error) { unlinkSync(path); throw error; }
  finally { closeSync(fd); }
}

export function registerMemberKeyTokenCommands(program: Command, tokenCommand: Command): void {
  const member = program.commands.find(command => command.name() === 'member')
    ?? program.command('member').description('Manage local Nexus member credentials');
  const key = member.command('key');
  key.command('create').requiredOption('--member-id <id>').requiredOption('--name <name>').requiredOption('--out <file>')
    .action((opts: { memberId: string; name: string; out: string }) => {
      const store = createMemberStore();
      try {
        const issued = issueToPrivateFile(opts.out, deliver => store.createMemberKey(opts.memberId, opts.name, undefined, deliver));
        console.log(JSON.stringify({ id: issued.id, name: issued.name, file: opts.out }));
      } finally { store.close(); }
    });
  key.command('list').requiredOption('--member-id <id>').action((opts: { memberId: string }) => {
    const store = createMemberStore();
    try { console.log(JSON.stringify(store.listMemberKeys(opts.memberId))); }
    finally { store.close(); }
  });
  key.command('revoke <id>').requiredOption('--member-id <id>').action((id: string, opts: { memberId: string }) => {
    const store = createMemberStore();
    try { if (!store.revokeMemberKey(opts.memberId, id)) throw new Error('member key not found'); console.log('revoked'); }
    finally { store.close(); }
  });
  key.command('rotate <id>').requiredOption('--member-id <id>').requiredOption('--out <file>')
    .action((id: string, opts: { memberId: string; out: string }) => {
      const store = createMemberStore();
      try {
        const issued = issueToPrivateFile(opts.out, deliver => store.rotateMemberKey(opts.memberId, id, undefined, deliver));
        console.log(JSON.stringify({ id: issued.id, file: opts.out }));
      } finally { store.close(); }
    });
  tokenCommand.command('mint').requiredOption('--scope <scopes>', 'Comma-separated entitlement scopes')
    .requiredOption('--key-file <file>').requiredOption('--endpoint <https-url>').requiredOption('--out <file>')
    .option('--audience <tailnet-ip>').option('--ttl-sec <seconds>')
    .action(async (opts: { scope: string; keyFile: string; endpoint: string; out: string; audience?: string; ttlSec?: string }) => {
      const url = new URL('/v1/tokens', opts.endpoint);
      if (url.protocol !== 'https:') throw new Error('token endpoint must use HTTPS');
      const scopes = opts.scope.split(',').map(value => value.trim());
      const ttlSec = opts.ttlSec === undefined ? undefined : Number(opts.ttlSec);
      const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${privateFile(opts.keyFile)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ scopes, ...(ttlSec === undefined ? {} : { ttlSec }), ...(opts.audience ? { audience: opts.audience } : {}) }) });
      if (response.status !== 201) throw new Error(`token mint failed (${response.status})`);
      const body = await response.json() as { token?: string; expiresAt?: string };
      if (!body.token || !/^emt_[A-Za-z0-9]{1,43}$/.test(body.token)) throw new Error('invalid token response');
      writeFileSync(opts.out, `${body.token}\n`, { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ file: opts.out, expiresAt: body.expiresAt }));
    });
}
