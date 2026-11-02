import { afterEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isElanousTuiManifestRow, registerRemoteElnPtyCommands, queryRemoteHostInventory, registeredRemoteSidetabSessions, resolveSidetabUnregisterRef, type RemoteElnPtyCommandDeps } from './remote-eln-pty.js';
import { setPtyManifestDbPathForTesting, registerPtySidetabEntry, readPtySidetabRegistrationsReadOnly } from '../pty-shell/pty-manifest.js';
import type { PtyManifestRow, PtySidetabRegistration } from '../pty-shell/pty-manifest.js';

const oldCode = process.exitCode;
afterEach(() => { process.exitCode = oldCode ?? 0; });
const mkRow = (id: string, alive: boolean): PtyManifestRow => ({
  id, kind: 'tui', cmd: 'eln', ownerPid: 1, ptyPid: 0, instance: 'test', startedAt: 1, alive, exitCode: alive ? null : 0,
  snapshot: '', snapshotAt: 0, updatedAt: 10, frame: '', frameAt: 0, runId: '', runIdSource: '', spaceId: '', sessionId: '',
  parentPtyId: '', parentPid: 0, parentKind: '', closedAt: alive ? 0 : 10, codeSha: '',
});
const reg = (ptyId: string, name: string): PtySidetabRegistration => ({ ptyId, host: 'aws1', name, registeredBy: 'OP', registeredAt: 10 });

describe('remote eln pty inventory command adapter', () => {
  test('SSH adapter reads registration endpoint, merges stopped registrations and preserves host failures', async () => {
    const commands: string[] = [];
    const sessions = await queryRemoteHostInventory('aws1', async (_host, command) => {
      commands.push(command);
      if (command === 'eln pty list --all --json') return JSON.stringify([
        { id: 'live', kind: 'tui', nickname: 'old', alive: true, ageMs: 20 },
        { id: 'stopped', kind: 'tui', alive: false },
        { id: 'ordinary', kind: 'shell', alive: true },
      ]);
      return JSON.stringify([
        { ptyId: 'live', host: 'aws1', name: 'registered-live', registeredBy: 'OP', registeredAt: 1 },
        { ptyId: 'stopped', host: 'aws1', name: 'registered-stopped', registeredBy: 'UX', registeredAt: 2 },
        { ptyId: 'no-row', host: 'aws1', name: 'registered-no-row', registeredBy: 'UX', registeredAt: 3 },
      ]);
    });
    expect(commands.sort()).toEqual(['eln pty list --all --json', 'eln pty sidetab registry --json']);
    expect(sessions).toEqual([
      expect.objectContaining({ ptyId: 'live', name: 'registered-live', registered: true, alive: true }),
      expect.objectContaining({ ptyId: 'stopped', name: 'registered-stopped', registered: true, alive: false }),
      expect.objectContaining({ ptyId: 'ordinary', registered: false, alive: true }),
      expect.objectContaining({ ptyId: 'no-row', name: 'registered-no-row', registered: true, alive: false }),
    ]);
    await expect(queryRemoteHostInventory('aws1', async () => { throw new Error('registry unavailable'); })).rejects.toThrow('registry unavailable');
  });

  test('command exercises actual inventory/SSH adapter wiring and independent filters', async () => {
    const calls: string[] = [];
    const deps: RemoteElnPtyCommandDeps = {
      rows: () => [], registrations: () => [], register: () => false, unregister: () => false,
      remoteHosts: () => ['aws1'], now: () => 100, localHost: () => 'local',
      queryHost: (host) => queryRemoteHostInventory(host, async (_host, command) => {
        calls.push(command);
        return command.includes('list --all')
          ? JSON.stringify([{ id: 'tui-1', kind: 'tui', alive: false }])
          : JSON.stringify([{ ptyId: 'tui-1', host: 'aws1', name: 'stopped', registeredBy: 'OP', registeredAt: 2 }]);
      }),
    };
    let out = '';
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    try {
      const program = new Command(); registerRemoteElnPtyCommands(program, deps);
      await program.parseAsync(['node', 'eln', 'inventory', '--all-hosts', '--registered', 'yes', '--kind', 'tui', '--json']);
      expect(JSON.parse(out)).toEqual([expect.objectContaining({ host: 'aws1', ptyId: 'tui-1', registered: true, alive: false })]);
      expect(calls).toHaveLength(2);
    } finally { process.stdout.write = original; }
  });

  test('sidetab registration accepts only live elanous TUI manifests', async () => {
    const rows = [mkRow('eln-live', true), { ...mkRow('codex-live', true), cmd: 'codex' }, { ...mkRow('lookalike-live', true), cmd: 'my-elanous-wrapper' }];
    expect(isElanousTuiManifestRow(rows[0]!)).toBe(true);
    expect(isElanousTuiManifestRow(rows[1]!)).toBe(false);
    expect(isElanousTuiManifestRow(rows[2]!)).toBe(false);
    const saved: PtySidetabRegistration[] = [];
    const deps: RemoteElnPtyCommandDeps = {
      rows: () => rows, registrations: () => saved, register: (entry) => { saved.push(entry); return true; },
      unregister: () => true, remoteHosts: () => [], queryHost: async () => [], now: () => 20, localHost: () => 'aws1',
    };
    let out = '';
    let err = '';
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    try {
      const program = new Command(); registerRemoteElnPtyCommands(program, deps);
      await program.parseAsync(['node', 'eln', 'sidetab', 'register', 'eln-live', '--host', 'aws1', '--name', 'work', '--by', 'UX']);
      expect(JSON.parse(out)).toMatchObject({ ok: true, ptyId: 'eln-live' });
      expect(saved).toHaveLength(1);
      process.exitCode = 0;
      await program.parseAsync(['node', 'eln', 'sidetab', 'register', 'codex-live', '--host', 'aws1', '--name', 'external', '--by', 'UX']);
      expect(process.exitCode).toBe(1);
      expect(err).toContain('live TUI ref not found');
      expect(saved).toHaveLength(1);
      expect(registeredRemoteSidetabSessions(rows, [reg('codex-live', 'stale-registration')], 20)).toEqual([]);
    } finally {
      process.stdout.write = originalOut; process.stderr.write = originalErr;
    }
  });

  test('ambiguous unregister-by-name is explicitly rejected; qualified id remains resolvable', () => {
    const registrations = [reg('one', 'same'), reg('two', 'same')];
    expect(resolveSidetabUnregisterRef(registrations, 'same')).toEqual({ ambiguous: true });
    expect(resolveSidetabUnregisterRef(registrations, 'one')).toEqual({ entry: registrations[0], ambiguous: false });
  });
});

describe('read-only sidetab registration ledger', () => {
  test('reads registrations without schema migration and propagates corrupt database errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidetab-readonly-'));
    const dbPath = join(dir, 'manifest.db');
    try {
      setPtyManifestDbPathForTesting(dbPath);
      registerPtySidetabEntry(reg('tui-1', 'review'));
      const before = statSync(dbPath);
      expect(readPtySidetabRegistrationsReadOnly()).toEqual([reg('tui-1', 'review')]);
      const after = statSync(dbPath);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      const d = new Database(dbPath, { readonly: true });
      expect(d.query("SELECT name FROM sqlite_master WHERE type='table'").all().some((x: any) => x.name === 'pty_manifest')).toBe(true);
      d.close();
      const corrupt = join(dir, 'corrupt.db'); require('node:fs').writeFileSync(corrupt, 'not sqlite');
      expect(() => readPtySidetabRegistrationsReadOnly(corrupt)).toThrow();
    } finally { setPtyManifestDbPathForTesting(null); rmSync(dir, { recursive: true, force: true }); }
  });
});
