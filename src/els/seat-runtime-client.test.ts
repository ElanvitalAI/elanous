import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { requestEls } from './client.js';

test('the private registration-token alongside the socket is sent separately from the pane credential', async () => {
  const root = mkdtempSync('/tmp/seat-client-');
  const path = join(root, 'runtime-token'); const socket = join(root, 'sock');
  const previous = process.env.ELANOUS_ELS_RUNTIME_TOKEN_FILE;
  const pane = process.env.ELANOUS_ELS_PANE_TOKEN;
  const owner = process.env.ELANOUS_ELS_OWNER_TOKEN;
  writeFileSync(path, 'fixture-registration-token', { mode: 0o600 });
  delete process.env.ELANOUS_ELS_RUNTIME_TOKEN_FILE;
  delete process.env.ELANOUS_ELS_PANE_TOKEN; delete process.env.ELANOUS_ELS_OWNER_TOKEN;
  const frames: any[] = [];
  const server = createServer(peer => {
    let pending = '';
    peer.on('data', data => {
      pending += data.toString();
      const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines) {
        const frame = JSON.parse(line); frames.push(frame);
        if (frame.op === 'auth') peer.write(JSON.stringify({ exitCode: 0, message: 'auth: outsider' }) + '\n');
        else peer.end(JSON.stringify({ exitCode: 0, message: 'ok' }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    expect((await requestEls(socket, { op: 'ping' })).exitCode).toBe(0);
    expect(frames[0]).toMatchObject({ op: 'auth', runtimeToken: 'fixture-registration-token' });
    expect(frames[0].token).toBeUndefined();
    const savedRuntime = process.env.ELN_SEAT_RUNTIME;
    try {
      process.env.ELN_SEAT_RUNTIME = JSON.stringify({ pid: 42, start: '123:456' });
      expect((await requestEls(socket, { op: 'seat-set', seat: 'OP' })).exitCode).toBe(0);
      expect(frames.at(-1)).toEqual({ op: 'seat-set', seat: 'OP', runtime: { pid: 42, start: '123:456' } });
    } finally {
      if (savedRuntime === undefined) delete process.env.ELN_SEAT_RUNTIME; else process.env.ELN_SEAT_RUNTIME = savedRuntime;
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.ELANOUS_ELS_RUNTIME_TOKEN_FILE; else process.env.ELANOUS_ELS_RUNTIME_TOKEN_FILE = previous;
    if (pane === undefined) delete process.env.ELANOUS_ELS_PANE_TOKEN; else process.env.ELANOUS_ELS_PANE_TOKEN = pane;
    if (owner === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = owner;
    rmSync(root, { recursive: true, force: true });
  }
});
