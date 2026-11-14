import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApprovedMemberConnect } from './member-connect-start.js';

test('CLI prints only the approval URL and consumes then removes an owner-only handoff file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-connect-start-'));
  const output: string[] = [];
  let state = '';
  let calls = 0;
  try {
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
      if (String(url).endsWith('/start')) {
        const body = JSON.parse(String(init?.body)) as { state: string; codeChallenge: string; pollSecret: string };
        state = body.state;
        expect(body.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(body.pollSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return Response.json({ id: 'i'.repeat(24), approvalUrl: 'https://api.elanous.ai/v1/members/connect/approve?id=' + 'i'.repeat(24), userCode: 'ABCD-EFGH' }, { status: 201 });
      }
      return Response.json({ code: 'a'.repeat(43), state });
    }) as typeof fetch;
    let consumed = 0;
    await startApprovedMemberConnect({ configDir: dir, fetchImpl, output: line => output.push(line),
      consumeHandoff: async path => {
        consumed++;
        expect(statSync(path).mode & 0o777).toBe(0o600);
        const data = JSON.parse(readFileSync(path, 'utf8')) as { code: string; state: string; codeVerifier: string };
        expect(data.code).toBe('a'.repeat(43));
        expect(data.state).toBe(state);
        expect(data.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      } });
    expect(calls).toBe(2);
    expect(consumed).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(output).toHaveLength(2);
    expect(output[1]).toContain('ABCD-EFGH');
    expect(output[0]).toContain('https://api.elanous.ai/v1/members/connect/approve?id=');
    expect(output.join(' ')).not.toContain('a'.repeat(43));
    expect(output.join(' ')).not.toContain(state);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('first-run config directory is private and a symlink is refused before network', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'member-connect-config-'));
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response(null, { status: 503 }); }) as unknown as typeof fetch;
  try {
    const fresh = join(parent, 'fresh');
    await expect(startApprovedMemberConnect({ configDir: fresh, fetchImpl, output: () => {},
      consumeHandoff: async () => {} })).rejects.toThrow('member approval start unavailable');
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(calls).toBe(1);

    const alias = join(parent, 'alias');
    symlinkSync(fresh, alias);
    await expect(startApprovedMemberConnect({ configDir: alias, fetchImpl, output: () => {},
      consumeHandoff: async () => {} })).rejects.toThrow('unsafe member config directory');
    expect(calls).toBe(1);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
