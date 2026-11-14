import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { simCli } from '../ux-sim/in-process-cli.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerMemberConnectCommands } from './member-connect-cli.js';
import { tuiMemberSessionPath } from '../tui/member-session-contract.js';

test('real member command consumes a private handoff through exchange and owner verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-command-'));
  const file = join(root, 'approved.json');
  const handoff = { code: 'synthetic-code', state: 'synthetic-state', codeVerifier: 'synthetic-verifier' };
  const output: string[] = []; const exits: number[] = []; const calls: string[] = [];
  try {
    writeFileSync(file, JSON.stringify(handoff), { mode: 0o600 });
    const program = new Command();
    registerMemberConnectCommands(program, { configDir: () => root, output: { log: m => output.push(m), error: m => output.push(m) }, exit: c => exits.push(c),
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(String(url));
        if (String(url).endsWith('/exchange')) {
          expect(JSON.parse(String(init?.body))).toEqual(handoff);
          return Response.json({ sessionToken: 'aps_synthetic_session', expiresAt: new Date(Date.now() + 60_000).toISOString(), appSlot: { appSlug: 'synthetic-app' } });
        }
        expect(init?.headers).toMatchObject({ authorization: 'Bearer aps_synthetic_session' });
        return Response.json({ memberId: 'synthetic-member' });
      }) as typeof fetch });
    await program.parseAsync(['member', 'connect', '--handoff-file', file], { from: 'user' });
    expect(exits).toEqual([0]); expect(calls).toHaveLength(2);
    expect(JSON.parse(readFileSync(tuiMemberSessionPath(root), 'utf8')).sessionToken).toBe('aps_synthetic_session');
    expect(output.join(' ')).not.toContain('aps_'); expect(output.join(' ')).not.toContain('synthetic-code');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public or hard-linked handoff refuses before exchange and leaves no session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-command-refuse-'));
  const file = join(root, 'approved.json'); let fetches = 0;
  try {
    writeFileSync(file, JSON.stringify({ code: 'fake', state: 'fake', codeVerifier: 'fake' }), { mode: 0o644 });
    for (const hardlink of [false, true]) {
      if (hardlink) { chmodSync(file, 0o600); linkSync(file, join(root, 'alias')); }
      const program = new Command(); const exits: number[] = [];
      registerMemberConnectCommands(program, { configDir: () => root, output: { log: () => {}, error: () => {} }, exit: c => exits.push(c),
        fetchImpl: (async () => { fetches++; throw new Error(); }) as typeof fetch });
      await program.parseAsync(['member', 'connect', '--handoff-file', file], { from: 'user' });
      expect(exits).toEqual([1]); expect(existsSync(tuiMemberSessionPath(root))).toBe(false);
    }
    expect(fetches).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Source: #37564 FIFO regression: execution guards only, not a performance SLA.
const fifoSetupGuardMs = 5_000;
const fifoProcessGuardMs = fifoSetupGuardMs * 2;
const fifoTestGuardMs = fifoProcessGuardMs + fifoSetupGuardMs;
test.skipIf(process.platform === 'win32')('actual CLI refuses a FIFO handoff without waiting for a writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-command-fifo-'));
  const fifo = join(root, 'approved.pipe');
  try {
    writeFileSync(join(root, 'config.json'), '{}\n', { mode: 0o600 });
    const made = spawnSync('mkfifo', ['-m', '600', fifo], { encoding: 'utf8', timeout: fifoSetupGuardMs });
    expect(made.error).toBeUndefined(); expect(made.status).toBe(0);
    const result = await simCli(['member', 'connect', '--handoff-file', fifo], {
      mode: 'spawn', allowPaths: [['member', 'connect']], stateRoot: root, configRoot: root,
      env: { NODE_ENV: 'test' }, timeoutMs: fifoProcessGuardMs,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('회원 연결을 완료하지 못했습니다.');
    expect(result.stderr).not.toContain('timed out');
    expect(existsSync(tuiMemberSessionPath(root))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, fifoTestGuardMs);
