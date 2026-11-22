import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { getElanousConfigDirOverride, getElanousConfigDirOverrideSource, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunShellApprovalIssuer } from '../tui-client/next-runshell-approval.js';
import { consumeRunShellApproval } from './runshell-approval.js';
import type { SpawnFunction } from './spawn-gateway.js';
import { buildMacOsProfile } from './sandbox.js';

import { testRunShellIssuer as gatewayIssuer } from './runshell-test-issuer.js';
const { spawnGateway } = await import('./spawn-gateway.js');

test('gateway refuses an unapproved non-local invocation before spawn', () => {
  let spawned = false;
  const spawnFn = (() => { spawned = true; throw new Error('spawn reached'); }) as SpawnFunction;
  expect(() => spawnGateway('/bin/echo', ['not approved'], { cwd: '/tmp' }, spawnFn))
    .toThrow('RunShell approval required');
  expect(spawned).toBe(false);
});

test('gateway classifies actual direct and sandbox-wrapped argv without a caller boolean', () => {
  let spawned = 0;
  const spawnFn = (() => { spawned++; return {} as any; }) as SpawnFunction;
  spawnGateway('/usr/bin/uname', ['-s'], { cwd: '/tmp', shell: false }, spawnFn);
  spawnGateway('/usr/bin/git', ['log', '--oneline'], { cwd: '/tmp' }, spawnFn);
  spawnGateway('/opt/bin/eln', ['ops', 'status'], { cwd: '/tmp' }, spawnFn);
  spawnGateway('/usr/bin/sandbox-exec', ['-p', buildMacOsProfile({ cwd: '/tmp', network: 'inherit' }), '/usr/bin/git', 'log'], { cwd: '/tmp' }, spawnFn);
  const wrapper = ['--ro-bind', '/', '/', '--bind', '/tmp', '/tmp', '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', '--die-with-parent', '--new-session', '--unshare-net'];
  spawnGateway('/usr/bin/bwrap', [...wrapper, '/opt/bin/eln', 'ops', 'status'], { cwd: '/tmp' }, spawnFn);
  expect(spawned).toBe(5);
  expect(() => spawnGateway('/usr/bin/uname', ['--invalid'], { cwd: '/tmp' }, spawnFn)).toThrow();
  expect(() => spawnGateway('/usr/bin/git', ['status'], { cwd: '/tmp' }, spawnFn)).toThrow();
  expect(() => spawnGateway('/usr/bin/sandbox-exec', ['-p', 'profile', '/usr/bin/git', 'status'], { cwd: '/tmp' }, spawnFn)).toThrow();
  expect(() => spawnGateway('/usr/bin/bwrap', [...wrapper, '/opt/bin/eln', 'msg', 'send'], { cwd: '/tmp' }, spawnFn)).toThrow();
  expect(() => spawnGateway('/usr/bin/uname', ['-s'], { cwd: '/tmp', shell: true }, spawnFn)).toThrow();
  expect(spawned).toBe(5);
});

test('gateway binds the original executable for direct and sandboxed commands', () => {
  const home = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'runshell-gateway-test-'));
  try {
    const executablePath = '/bin/echo';
    const bytesSha256 = createHash('sha256').update(readFileSync(executablePath)).digest('hex');
    const issuer = gatewayIssuer;
    const spawnFn = (() => ({} as any)) as SpawnFunction;
    const grantFor = (argv: string[]) => ({
      approval: issuer.issue({ argv, cwd: '/tmp', bytesSha256, callerSeat: 'seat', sessionId: 'session' }),
      publicKeyPem: issuer.publicKey, callerSeat: 'seat', sessionId: 'session', executablePath,
    });
    expect(() => spawnGateway('/bin/date', [], { cwd: '/tmp' }, spawnFn, grantFor(['/bin/date'])))
      .toThrow('RunShell executable path mismatch');
    const mac = ['/usr/bin/sandbox-exec', '-p', 'profile', executablePath, 'hello'];
    expect(() => spawnGateway(mac[0]!, mac.slice(1), { cwd: '/tmp' }, spawnFn, grantFor(mac))).not.toThrow();
    const linux = ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--bind', '/tmp', '/tmp', '--tmpfs', '/tmp',
      '--proc', '/proc', '--dev', '/dev', '--die-with-parent', '--new-session', '--unshare-net', executablePath, 'hello'];
    expect(() => spawnGateway(linux[0]!, linux.slice(1), { cwd: '/tmp' }, spawnFn, grantFor(linux))).not.toThrow();
    const wrong = [...mac]; wrong[3] = '/bin/date';
    expect(() => spawnGateway(wrong[0]!, wrong.slice(1), { cwd: '/tmp' }, spawnFn, grantFor(wrong)))
      .toThrow('RunShell executable path mismatch');
  } finally {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
  }
});

describe('RunShell approval consumer (primitive only)', () => {
  test('records consumption under the selected isolated config root', () => {
    const previous = getElanousConfigDirOverride();
    const source = getElanousConfigDirOverrideSource();
    const root = mkdtempSync(join(tmpdir(), 'runshell-config-root-'));
    setElanousConfigDir(root);
    try {
      const executablePath = '/bin/echo';
      const request = { argv: [executablePath, 'hello'], cwd: '/tmp', bytesSha256: createHash('sha256').update(readFileSync(executablePath)).digest('hex'), callerSeat: 'seat', sessionId: 'session' };
      const issuer = createRunShellApprovalIssuer();
      const approval = issuer.issue(request);
      const input = { approval, publicKeyPem: issuer.publicKey, argv: request.argv, cwd: request.cwd, executablePath, callerSeat: request.callerSeat, sessionId: request.sessionId };
      consumeRunShellApproval(input);
      expect(existsSync(join(root, 'runshell', 'consumed', approval.payload.nonce))).toBe(true);
      expect(() => consumeRunShellApproval(input)).toThrow();
    } finally {
      if (previous === undefined) resetElanousConfigDir(); else setElanousConfigDir(previous, source);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects mismatched binding, tampering and expiration; consumes a valid nonce once', () => {
    const home = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'runshell-consumer-test-'));
    try {
      const executablePath = '/bin/echo';
      const request = { argv: [executablePath, 'hello'], cwd: '/tmp', bytesSha256: createHash('sha256').update(readFileSync(executablePath)).digest('hex'), callerSeat: 'test-seat', sessionId: 'test-session' };
      const issuer = createRunShellApprovalIssuer();
      const approval = issuer.issue(request);
      const input = { approval, publicKeyPem: issuer.publicKey, argv: request.argv, cwd: request.cwd, executablePath, callerSeat: request.callerSeat, sessionId: request.sessionId };
      expect(() => consumeRunShellApproval({ ...input, argv: [executablePath, 'changed'] })).toThrow();
      expect(() => consumeRunShellApproval({ ...input, cwd: '/' })).toThrow();
      expect(() => consumeRunShellApproval({ ...input, callerSeat: 'other' })).toThrow();
      expect(() => consumeRunShellApproval({ ...input, sessionId: 'other' })).toThrow();
      expect(() => consumeRunShellApproval({ ...input, approval: { ...approval, payload: { ...approval.payload, bytesSha256: '0'.repeat(64) } } })).toThrow();
      expect(() => consumeRunShellApproval({ ...input, approval: { ...approval, payload: { ...approval.payload, expiresAt: 0 } } })).toThrow();
      expect(() => consumeRunShellApproval(input)).not.toThrow();
      expect(() => consumeRunShellApproval(input)).toThrow();
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });
});
