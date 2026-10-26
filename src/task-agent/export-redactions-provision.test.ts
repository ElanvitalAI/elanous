import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionExportRedactions } from './export-redactions-provision.js';
import type { SshRunner } from './parent-host.js';

const fixture = 'private-example\tpublic-example\n';

test('provisions the exact release redaction list over SSH stdin with private atomic destination', () => {
  const sourceHome = mkdtempSync(join(tmpdir(), 'export-source-'));
  const remoteHome = mkdtempSync(join(tmpdir(), 'export-remote-'));
  try {
    const source = join(sourceHome, 'redactions.tsv');
    writeFileSync(source, fixture, { mode: 0o600 });
    chmodSync(source, 0o600);
    let calls = 0;
    let expected = fixture;
    const ssh: SshRunner = (host, script, _timeout, stdin) => {
      calls++;
      expect(host).toBe('node-b');
      expect(stdin).toBe(expected);
      expect(script).not.toContain('private-example');
      const result = spawnSync('/bin/sh', ['-c', script], {
        encoding: 'utf8', input: stdin, env: { ...process.env, HOME: remoteHome, ELANOUS_EXPORT_REDACTIONS: '' },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    provisionExportRedactions('node-b', source, ssh);
    const destination = join(remoteHome, '.elanous', 'export-redactions.tsv');
    expect(calls).toBe(1);
    expect(readFileSync(destination, 'utf8')).toBe(fixture);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(statSync(join(remoteHome, '.elanous')).mode & 0o777).toBe(0o700);
    expected = 'other-value\tother-public\n';
    writeFileSync(source, expected);
    chmodSync(source, 0o600);
    provisionExportRedactions('node-b', source, ssh);
    expect(readFileSync(destination, 'utf8')).toBe(expected);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(sourceHome, { recursive: true, force: true });
    rmSync(remoteHome, { recursive: true, force: true });
  }
});

test('remote ELANOUS_EXPORT_REDACTIONS overrides the remote HOME default', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-remote-override-'));
  try {
    const source = join(root, 'source.tsv');
    const remoteHome = join(root, 'home');
    const override = join(root, 'private', 'export-redactions.tsv');
    writeFileSync(source, fixture, { mode: 0o600 });
    const ssh: SshRunner = (_host, script, _timeout, stdin) => {
      const result = spawnSync('/bin/sh', ['-c', script], {
        encoding: 'utf8', input: stdin,
        env: { ...process.env, HOME: remoteHome, ELANOUS_EXPORT_REDACTIONS: override },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    provisionExportRedactions('node-b', source, ssh);
    expect(readFileSync(override, 'utf8')).toBe(fixture);
    expect(statSync(override).mode & 0o777).toBe(0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing, loose, and empty sources fail before SSH', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-invalid-'));
  let calls = 0;
  const ssh: SshRunner = () => { calls++; return { status: 0, stdout: '', stderr: '' }; };
  try {
    const source = join(root, 'redactions.tsv');
    expect(() => provisionExportRedactions('node-b', source, ssh)).toThrow('source unavailable');
    writeFileSync(source, fixture, { mode: 0o644 });
    chmodSync(source, 0o644);
    expect(() => provisionExportRedactions('node-b', source, ssh)).toThrow('source unavailable');
    writeFileSync(source, '# comment only\n');
    chmodSync(source, 0o600);
    expect(() => provisionExportRedactions('node-b', source, ssh)).toThrow('source unavailable');
    expect(calls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('remote failure and host rejection do not disclose source bytes or stderr', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-failure-'));
  try {
    const source = join(root, 'redactions.tsv');
    writeFileSync(source, fixture, { mode: 0o600 });
    chmodSync(source, 0o600);
    expect(() => provisionExportRedactions('untrusted', source, () => { throw new Error('must not connect'); })).toThrow('host not allowed');
    try {
      provisionExportRedactions('node-b', source, () => ({ status: 9, stdout: '', stderr: fixture }));
      throw new Error('expected failure');
    } catch (error) {
      expect(String(error)).toContain('ssh rc=9');
      expect(String(error)).not.toContain('private-example');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
