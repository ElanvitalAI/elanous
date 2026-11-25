// Terra #38973 r1 — the remote attach window and client: malformed %-encoding, DNS pinning, detach before the
// request exists, and frames dropped on a full buffer.
import { afterEach, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ElsCore } from './core.js';
import { attachFrameStep, startElsHttp, type AttachShown, type ElsDoPolicy } from './http.js';
import { attachRemote } from './remote-attach-client.js';

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

function policy(allowed: boolean): { policy: ElsDoPolicy; audit: Record<string, unknown>[] } {
  const audit: Record<string, unknown>[] = [];
  return { audit, policy: { allows: () => allowed, audit: (entry) => { audit.push(entry); } } };
}

// Only the methods the window touches on these paths; a call to anything else fails the test loudly.
const fakeCore = {
  list: () => ({ exitCode: 0, message: JSON.stringify({ panes: [] }) }),
  paneExists: () => undefined,
  locate: () => undefined,
} as unknown as ElsCore;

async function windowOn(allowed: boolean) {
  const made = policy(allowed);
  const server = await startElsHttp(fakeCore, 'box-w', { host: '127.0.0.1', port: 0 }, made.policy);
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, audit: made.audit };
}

test('a malformed %-escape in the attach path is a 400 and an audit line, and the window keeps answering', async () => {
  const { port, audit } = await windowOn(true);
  const bad = await fetch(`http://127.0.0.1:${port}/els/attach/%E0%A4%A`, { method: 'POST', body: '' });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: 'bad pane in the path' });
  expect(audit.map((entry) => entry.result)).toEqual(['bad request: pane is not valid %-encoding']);
  const after = await fetch(`http://127.0.0.1:${port}/els/ls`);
  expect(after.status).toBe(200);
  expect(await after.json()).toEqual({ host: 'box-w', panes: [], workspaces: [] });
});

test('the allow check comes before decoding: a refused source with a malformed path is a 403', async () => {
  const { port, audit } = await windowOn(false);
  const refused = await fetch(`http://127.0.0.1:${port}/els/attach/%ZZ`, { method: 'POST', body: '' });
  expect(refused.status).toBe(403);
  expect(audit.map((entry) => entry.result)).toEqual(['refused: source not in do-allow.json']);
});

test('a frame dropped on a full buffer is not counted as shown, so the same screen is sent on the next poll', () => {
  const shown: AttachShown = { seq: 0 };
  const sent: number[] = [];
  attachFrameStep(shown, 'final-screen', () => false);           // buffer full: dropped
  expect(shown).toEqual({ seq: 0 });
  attachFrameStep(shown, 'final-screen', (seq) => { sent.push(seq); return true; });   // drained: sent now
  expect(sent).toEqual([1]);
  expect(shown).toEqual({ seq: 1, lastKey: 'final-screen' });
  attachFrameStep(shown, 'final-screen', (seq) => { sent.push(seq); return true; });   // unchanged: nothing
  expect(sent).toEqual([1]);
});

async function recorder(): Promise<{ port: number; seen: { host?: string; url?: string }[] }> {
  const seen: { host?: string; url?: string }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    seen.push({ host: req.headers.host, url: req.url });
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'recorded' }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

test('the connection goes to the address that was checked, with the name only in the Host header', async () => {
  const { port, seen } = await recorder();
  const lookups: string[] = [];
  const ended = await new Promise<{ code: number; reason: string }>((resolve) => {
    attachRemote({ name: 'box-p', baseUrl: `http://box-p.example-tail.ts.net:${port}` }, 'p7', { cols: 20, rows: 5 }, {
      onFrame: () => {}, onEnd: (code, reason) => resolve({ code, reason }),
    }, 'here/OP', { lookup: async (name) => { lookups.push(name); return ['127.0.0.1']; } });
  });
  // The name is not resolvable by the system resolver: reaching the recorder proves it connected by the checked IP.
  expect(lookups).toEqual(['box-p.example-tail.ts.net']);
  expect(ended).toEqual({ code: 1, reason: 'recorded' });
  expect(seen).toEqual([{ host: `box-p.example-tail.ts.net:${port}`, url: '/els/attach/p7?cols=20&rows=5&from=here%2FOP' }]);
});

test('a name that resolves outside the tailnet is refused without a request', async () => {
  const { port, seen } = await recorder();
  const ended = await new Promise<{ code: number; reason: string }>((resolve) => {
    attachRemote({ name: 'box-q', baseUrl: `http://box-q.example-tail.ts.net:${port}` }, 'p7', { cols: 20, rows: 5 }, {
      onFrame: () => {}, onEnd: (code, reason) => resolve({ code, reason }),
    }, '', { lookup: async () => ['203.0.113.9'] });
  });
  expect(ended).toEqual({ code: 1, reason: 'els attach: box-q.example-tail.ts.net resolves to 203.0.113.9, not a tailnet or loopback address' });
  expect(seen).toEqual([]);
});

test('detach while the name is still resolving opens no request afterwards', async () => {
  const { port, seen } = await recorder();
  let answer: (addresses: string[]) => void = () => {};
  const ends: string[] = [];
  const attached = attachRemote({ name: 'box-d', baseUrl: `http://box-d.example-tail.ts.net:${port}` }, 'p7', { cols: 20, rows: 5 }, {
    onFrame: () => {}, onEnd: (_code, reason) => { ends.push(reason); },
  }, '', { lookup: () => new Promise((resolve) => { answer = resolve; }) });
  attached.detach();
  answer(['127.0.0.1']);
  await Bun.sleep(300);
  expect(seen).toEqual([]);
  expect(ends).toEqual([]);
});
