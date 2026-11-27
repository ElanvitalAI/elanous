// ELS-CHANNEL P0 — the real els owner: a same-uid caller outside any pane is the operator (a person's terminal); the
// server stamps that sender, answers a wait the moment a post lands, and the door marks reads vs writes.
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeLoopVoiceDecl } from './loop-voice.js';
import { requestEls } from './client.js';
import { isMutating } from './server-auth.js';
import { elsSocketPath, startElsServer } from './server.js';

// 출처: 내부 문서 `ELS-CHANNEL` §2 — the server holds a wait ≤25 s; the test waits 5 s and lets the client give up after 10 s.
const WAIT_MS = 5_000;
const CLIENT_MS = 10_000;

test('door: channel read/list/wait are reads; post/ack/hold/resume/open are writes', () => {
  for (const action of ['read', 'list', 'wait']) expect(isMutating({ op: 'channel', action })).toBe(false);
  for (const action of ['post', 'ack', 'hold', 'resume', 'open']) expect(isMutating({ op: 'channel', action })).toBe(true);
});

test('real owner: operator post is stamped operator+human, a pending wait is answered by the post, read returns it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-channel-server-'));
  const env = { ...process.env };
  delete process.env.ELANOUS_ELS_PANE_TOKEN;
  const started = await startElsServer({ stateRoot: root, stall: false });
  if ('exitCode' in started) throw new Error(started.message);
  try {
    const sock = elsSocketPath(root);
    const waiting = requestEls(sock, { op: 'channel', action: 'wait', channel: 'ws:demo', timeoutMs: WAIT_MS }, CLIENT_MS);
    await new Promise((r) => setTimeout(r, 100));
    const posted = await requestEls(sock, { op: 'channel', action: 'post', channel: 'ws:demo', type: 'ask', body: 'who is here?', ...({ from: { role: 'op' } } as object) });
    expect(posted.exitCode).toBe(0);
    const woke = JSON.parse((await waiting).message) as { message: { body: string; from: { role: string }; human?: boolean } };
    expect(woke.message).toMatchObject({ body: 'who is here?', from: { role: 'operator' }, human: true });
    const read = JSON.parse((await requestEls(sock, { op: 'channel', action: 'read', channel: 'ws:demo' })).message) as { lastSeq: number; open: string[] };
    expect(read.lastSeq).toBe(1);
    expect(read.open).toHaveLength(1);
    expect((await requestEls(sock, { op: 'channel', action: 'post', channel: 'bad id', body: 'x' })).exitCode).toBe(2);
  } finally { await started.close(); process.env = env; rmSync(root, { recursive: true, force: true }); }
});

test('real owner: a message to loop:<id> runs its declared voice once and the loop answers in the channel (P1b)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-channel-loop-'));
  const env = { ...process.env };
  delete process.env.ELANOUS_ELS_PANE_TOKEN;
  const started = await startElsServer({ stateRoot: root, stall: false });
  if ('exitCode' in started) throw new Error(started.message);
  try {
    const sock = elsSocketPath(root);
    const script = join(root, 'voice.sh');
    writeFileSync(script, '#!/bin/sh\nread line\necho "{\\"text\\":\\"guardian here\\",\\"evidence\\":[\\"host:node-b\\"],\\"actions\\":[\\"status\\"]}"\n');
    chmodSync(script, 0o755);
    writeLoopVoiceDecl(join(dirname(sock), 'loops'), 'guardian', [script]);
    const waiting = requestEls(sock, { op: 'channel', action: 'wait', channel: 'loop:guardian', after: 1, all: true, timeoutMs: WAIT_MS }, CLIENT_MS);
    expect((await requestEls(sock, { op: 'channel', action: 'post', channel: 'loop:guardian', type: 'ask', body: 'how is node-b?' })).exitCode).toBe(0);
    const reply = JSON.parse((await waiting).message) as { message: { type: string; body: string; from: { role: string; seat: string }; refs: string[] } };
    expect(reply.message).toMatchObject({ type: 'answer', body: 'guardian here', from: { role: 'loop', seat: 'loop:guardian' }, refs: ['host:node-b', 'action:status'] });
  } finally { await started.close(); process.env = env; rmSync(root, { recursive: true, force: true }); }
});
