import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('CLI renders only structured progress from a chunked remote SSH stderr stream', () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-progress-integration-'));
  try {
    const known = join(dir, 'known_hosts');
    writeFileSync(known, 'fixture', { mode: 0o600 });
    // This executable replaces SSH only; the real child stderr pipe, parser and CLI action are used.
    writeFileSync(join(dir, 'ssh'), `#!/bin/sh
cat >/dev/null
printf 'token=secret-' >&2
sleep 0.1
printf 'value /private/path\\nELS_UPDATE_PRO' >&2
sleep 0.1
printf 'GRESS remaining=2 eta=35\\nELS_UPDATE_PROGRESS remaining=3 eta=4 token=secret-value\\n' >&2
if [ "$FIXTURE_FAIL" = 1 ]; then exit 7; fi
printf 'ELS_UPDATE_ALL_BEFORE={"commit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}\\n'
printf 'ELS_UPDATE_ALL_RESULT={"ok":true,"desired":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","installed":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rows":[]}\\n'
`, { mode: 0o700 });
    const fixture = join(dir, 'fixture.ts');
    const source = join(import.meta.dir, 'els-cli.ts');
    const hosts = join(import.meta.dir, '../els/hosts.ts');
    const update = join(import.meta.dir, '../els/update-all.ts');
    writeFileSync(fixture, `
import { mock } from 'bun:test';
import { Command } from ${JSON.stringify(join(import.meta.dir, '../../node_modules/commander/index.js'))};
const host = { name: 'fixture', baseUrl: 'http://127.0.0.1:18793', update: { sshTarget: 'test@127.0.0.1', knownHostsFile: ${JSON.stringify(known)}, catchUpSeat: 'TC' } };
const originalHosts = await import(${JSON.stringify(hosts)});
mock.module(${JSON.stringify(hosts)}, () => ({ ...originalHosts, loadHostRegistry: () => ({ hosts: [host], rejected: [] }), registeredHostAtExecution: () => host }));
mock.module(${JSON.stringify(update)}, () => ({ updateResultsTable: () => 'fixture table', updateSummary: () => 'fixture summary', updateInstallProgress: () => 'fixture install', updatePreview: () => 'fixture preview', updateAllElsTabs: async (deps) => {
  try { await deps.list(); } catch {} // list sets the registry snapshot; no live host is needed.
  const result = await deps.remoteUpdate(host, [], 'a'.repeat(40));
  return { ok: true, rows: result.panes };
} }));
const { registerElsCommands } = await import(${JSON.stringify(source)});
const program = new Command();
registerElsCommands(program);
await program.parseAsync(['node', 'test', 'side', 'update-all']);
`);
    const result = spawnSync(process.execPath, [fixture], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: dir, ELANOUS_STATE_DIR: join(dir, 'state'), PATH: `${dir}:/usr/bin:/bin`, FIXTURE_FAIL: '0' },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('els update-all: [fixture] Remaining seats: 2 · 35s remaining\n');
    expect(result.stdout + result.stderr).not.toContain('secret-value');
    expect(result.stdout + result.stderr).not.toContain('/private/path');
    const failed = spawnSync(process.execPath, [fixture], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: dir, ELANOUS_STATE_DIR: join(dir, 'state'), PATH: `${dir}:/usr/bin:/bin`, FIXTURE_FAIL: '1' },
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toBe('els update-all: [fixture] Remaining seats: 2 · 35s remaining\nels update-all: fixture: SSH/local catch-up failed (7); remote output omitted\n');
    expect(failed.stdout + failed.stderr).not.toContain('secret-value');
    expect(failed.stdout + failed.stderr).not.toContain('/private/path');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
