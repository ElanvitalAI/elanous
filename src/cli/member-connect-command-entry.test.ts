import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMemberConnectCommands } from './member-connect-cli.js';

test('eln member connect starts approval and reaches the existing verified TUI consumer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-connect-command-'));
  const output: string[] = [];
  const exits: number[] = [];
  const calls: string[] = [];
  let state = '';
  try {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/connect/start')) {
        state = (JSON.parse(String(init?.body)) as { state: string }).state;
        return Response.json({ id: 'i'.repeat(24), approvalUrl: 'https://api.elanous.ai/v1/members/connect/approve?id=' + 'i'.repeat(24), userCode: 'ABCD-EFGH' }, { status: 201 });
      }
      if (url.includes('/connect/poll?')) return Response.json({ code: 'c'.repeat(43), state });
      if (url.endsWith('/app-slot/exchange')) {
        const body = JSON.parse(String(init?.body)) as { code: string; state: string; codeVerifier: string };
        expect(body.code).toBe('c'.repeat(43));
        expect(body.state).toBe(state);
        expect(body.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return Response.json({ sessionToken: 'aps_synthetic_member_a',
          expiresAt: new Date(Date.now() + 60_000).toISOString(), appSlot: { appSlug: 'member-a-app' } });
      }
      expect(url).toContain('/v1/members/owner?appSlug=member-a-app');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer aps_synthetic_member_a');
      return Response.json({ memberId: 'member-a' });
    }) as typeof fetch;
    const program = new Command();
    registerMemberConnectCommands(program, { configDir: () => root, fetchImpl,
      output: { log: line => output.push(line), error: line => output.push(line) }, exit: code => exits.push(code) });
    await program.parseAsync(['member', 'connect'], { from: 'user' });
    expect(exits).toEqual([0]);
    expect(calls).toHaveLength(4);
    expect(readdirSync(root)).toEqual(['member-session.json']);
    expect(JSON.parse(readFileSync(join(root, 'member-session.json'), 'utf8'))).toMatchObject({
      sessionToken: 'aps_synthetic_member_a', appSlug: 'member-a-app',
    });
    expect(output[0]).toContain('/v1/members/connect/approve?id=');
    expect(output[1]).toContain('ABCD-EFGH');
    expect(output.at(-1)).toBe('회원 앱 세션을 연결했습니다.');
    expect(output.join(' ')).not.toContain('aps_synthetic_member_a');
    expect(output.join(' ')).not.toContain('c'.repeat(43));
    expect(output.join(' ')).not.toContain(state);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
