import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from './client.js';

// Real Unix sockets are the transport under test; each fixture owns a short temporary path.
async function withServer(handler: (socket: Socket) => void, run: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'els-c-'));
  const path = join(dir, 's');
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
  try { await run(path); } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}
let paneToken: string | undefined;
let ownerToken: string | undefined;
beforeEach(() => {
  paneToken = process.env.ELANOUS_ELS_PANE_TOKEN;
  ownerToken = process.env.ELANOUS_ELS_OWNER_TOKEN;
  delete process.env.ELANOUS_ELS_PANE_TOKEN;
  delete process.env.ELANOUS_ELS_OWNER_TOKEN;
});
afterEach(() => {
  if (paneToken === undefined) delete process.env.ELANOUS_ELS_PANE_TOKEN; else process.env.ELANOUS_ELS_PANE_TOKEN = paneToken;
  if (ownerToken === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = ownerToken;
});
const request = { op: 'ls' } as const;

test('classifies a validated server refusal without interpreting its message', async () => {
  await withServer(s => s.once('data', () => s.end('{"exitCode":1,"message":"els: the els server closed the connection without an answer"}\n')), async path => {
    const result = await requestEls(path, request);
    expect(result).toMatchObject({ exitCode: 1, transport: { outcome: 'answered' } });
  });
});

test('invalid response JSON and invalid result shapes are unknown, never success', async () => {
  for (const answer of ['nope', 'null', '[]', '{}', '{"exitCode":0}', '{"exitCode":3,"message":"x"}', '{"exitCode":0,"message":"x","queued":"1"}']) {
    await withServer(s => s.once('data', () => s.end(`${answer}\n`)), async path => {
      const result = await requestEls(path, request);
      expect(result).toMatchObject({ exitCode: 1, transport: { outcome: 'unknown', reason: 'malformed' } });
    });
  }
});

test('request observed by server followed by disconnect or timeout has unknown outcome', async () => {
  for (const mode of ['close', 'timeout'] as const) {
    let received = false;
    await withServer(s => s.once('data', () => { received = true; if (mode === 'close') s.end(); }), async path => {
      const result = await requestEls(path, request, 50);
      expect(received).toBe(true);
      expect(result.transport).toEqual({ outcome: 'unknown', reason: mode === 'close' ? 'disconnect' : 'timeout' });
    });
  }
});

test('missing socket and overlong path are provably not sent', async () => {
  const missing = join(tmpdir().length > 40 ? '/tmp' : tmpdir(), `els-missing-${process.pid}`, 's');
  expect((await requestEls(missing, request)).transport?.outcome).toBe('not-sent');
  expect((await requestEls('/' + 'a'.repeat(200), request)).transport?.outcome).toBe('not-sent');
});

test('explicit auth refusal is reported as an answered rejection', async () => {
  await withServer(s => s.once('data', () => s.end('{"exitCode":1,"message":"auth: outsider"}\n')), async path => {
    expect(await requestEls(path, request, 1000, 'test-token')).toMatchObject({
      exitCode: 1, message: 'auth: outsider', transport: { outcome: 'answered' },
    });
  });
});

test('legacy invalid credential rejection is explicit and cannot become a success', async () => {
  await withServer(s => s.once('data', () => s.end('{"exitCode":1,"message":"els: invalid credential"}\n{"exitCode":0,"message":"ok"}\n')), async path => {
    expect(await requestEls(path, request, 1000, 'stale-token')).toMatchObject({
      exitCode: 1, message: 'els: invalid credential', transport: { outcome: 'answered' },
    });
  });
  await withServer(s => s.once('data', () => s.end('{"exitCode":0,"message":"els: invalid credential"}\n')), async path => {
    expect((await requestEls(path, request, 1000, 'test-token')).transport).toEqual({ outcome: 'unknown', reason: 'malformed' });
  });
});

test('auth acknowledgement is validated before accepting a result', async () => {
  await withServer(s => s.once('data', () => s.end('{"exitCode":0,"message":"auth: owner"}\n{"exitCode":0,"message":"ok","queued":2}\n')), async path => {
    const result = await requestEls(path, request, 1000, 'test-token');
    expect(result).toMatchObject({ exitCode: 0, message: 'ok', queued: 2, transport: { outcome: 'answered' } });
  });
  await withServer(s => s.once('data', () => s.end('{}\n{"exitCode":0,"message":"ok"}\n')), async path => {
    expect((await requestEls(path, request, 1000, 'test-token')).transport).toEqual({ outcome: 'unknown', reason: 'malformed' });
  });
});
