// ELS-CHANNEL P0 — ElsControl channel: the eln tool posts/reads/waits through the tool door; it never names a sender.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildElsControlTool, runElsControl } from './els-control-tool.js';

async function fakeEls(socketPath: string, reply: (request: Record<string, unknown>) => { exitCode: number; message: string }) {
  const received: Record<string, unknown>[] = [];
  const server: Server = createServer((socket: Socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        if (request.op === 'auth') { socket.write(`${JSON.stringify({ exitCode: 0, message: 'auth: fixture' })}\n`); continue; }
        received.push(request);
        socket.write(`${JSON.stringify(reply(request))}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(dirname(socketPath), 'ctl.sock'), () => resolve()); });
  return { received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('post / read / wait / ack / list go to the server as op channel requests, without any sender field, audited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elsctl-ch-'));
  const fake = await fakeEls(join(dir, 's.sock'), () => ({ exitCode: 0, message: JSON.stringify({ id: 'cm-1-abcdef', seq: 1 }) }));
  const deps = { socketPath: join(dir, 's.sock'), stateDir: dir };
  const posted = await runElsControl({ action: 'channel', channelAction: 'post', channel: 'ws:w1', type: 'ask', text: 'review?', to: 'p2,p3', refs: 'pr:1', from: 'OP' }, deps);
  expect([posted.ok, (posted as { data?: unknown }).data]).toEqual([true, { id: 'cm-1-abcdef', seq: 1 }]);
  await runElsControl({ action: 'channel', channel: 'ws:w1', after: 3 }, deps);
  await runElsControl({ action: 'channel', channelAction: 'wait', channel: 'pair:p1+p2' }, deps);
  await runElsControl({ action: 'channel', channelAction: 'ack', channel: 'ws:w1', id: 'cm-1-abcdef' }, deps);
  await runElsControl({ action: 'channel', channelAction: 'list' }, deps);
  expect(fake.received).toEqual([
    { op: 'channel', action: 'post', channel: 'ws:w1', type: 'ask', body: 'review?', to: ['p2', 'p3'], refs: ['pr:1'] },
    { op: 'channel', action: 'read', channel: 'ws:w1', after: 3 },
    { op: 'channel', action: 'wait', channel: 'pair:p1+p2' },
    { op: 'channel', action: 'ack', channel: 'ws:w1', id: 'cm-1-abcdef' },
    { op: 'channel', action: 'list' },
  ]);
  expect(readFileSync(join(dir, 'control-audit.jsonl'), 'utf8')).toContain('"action":"channel.post"');
  await fake.close();
});

test('refusals: missing channel, unknown or open sub-action, server refusal passed through', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elsctl-ch2-'));
  const fake = await fakeEls(join(dir, 's.sock'), () => ({ exitCode: 1, message: JSON.stringify({ refused: 'ping-pong', message: 'paused for a person' }) }));
  const deps = { socketPath: join(dir, 's.sock'), stateDir: dir };
  expect((await runElsControl({ action: 'channel', channelAction: 'post', text: 'x' }, deps)).code).toBe('channel-required');
  expect((await runElsControl({ action: 'channel', channelAction: 'explode', channel: 'ws:w1' }, deps)).exitCode).toBe(2);
  expect((await runElsControl({ action: 'channel', channelAction: 'open', channel: 'run:r1' }, deps)).exitCode).toBe(2);
  const refused = await runElsControl({ action: 'channel', channelAction: 'post', channel: 'ws:w1', text: 'again' }, deps);
  expect([refused.ok, refused.message]).toEqual([false, JSON.stringify({ refused: 'ping-pong', message: 'paused for a person' })]);
  await fake.close();
});

test('the tool spec offers channel and tells the model the sender is decided by the server', () => {
  const spec = buildElsControlTool();
  const props = (spec.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
  expect(props.action!.enum).toContain('channel');
  expect(props.channelAction!.enum).toEqual(['post', 'read', 'list', 'ack', 'wait', 'hold', 'resume']);
  expect(props.type!.enum).toEqual(['say', 'ask', 'answer', 'handoff', 'file', 'done']);
  expect(spec.description).toContain('보낸 이는 서버가 pane 자격으로 정함');
});
