import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAdminToken } from '../../auth/token-store.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { handleMcpHttpPost } from './mcp-http.js';

test('MCP mailbox tools require a daemon-bound seat and an admin bearer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-seat-'));
  const previousConfig = getElanousConfigDirOverride();
  const previousSeat = process.env.ELANOUS_SEAT_ID;
  setElanousConfigDir(dir);
  process.env.ELANOUS_SEAT_ID = 'NM-1';
  const token = ensureAdminToken({ configDir: dir });
  const request = (authorization?: string) => new Request('http://localhost/v1/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const names = async (authorization?: string) => {
    const response = await handleMcpHttpPost(request(authorization), { peerAddress: '127.0.0.1' });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    return body.result.tools.map((tool) => tool.name);
  };
  try {
    expect(await names()).not.toContain('MsgInbox');
    const bound = await names(`Bearer ${token}`);
    expect(bound).toContain('MsgInbox');
    expect(bound).toContain('MsgAck');
    delete process.env.ELANOUS_SEAT_ID;
    expect(await names(`Bearer ${token}`)).not.toContain('MsgInbox');
  } finally {
    if (previousSeat === undefined) delete process.env.ELANOUS_SEAT_ID;
    else process.env.ELANOUS_SEAT_ID = previousSeat;
    if (previousConfig === undefined) resetElanousConfigDir();
    else setElanousConfigDir(previousConfig);
    rmSync(dir, { recursive: true, force: true });
  }
});
