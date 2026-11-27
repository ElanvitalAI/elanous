// ELS-ZAXIS: ElsControl overlay — «옵시디언 띄워줘» → overlay open element obsidian in the caller pane's workspace.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildElsControlTool, runElsControl } from './els-control-tool.js';

const LISTING = { workspaces: [{ id: 'w1', name: 'one' }], tabs: [{ id: 't1', workspaceId: 'w1' }], panes: [{ pane: 'p1', tab: 't1', kind: 'agent' }] };

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
const answer = (request: Record<string, unknown>) => request.op === 'ls' ? { exitCode: 0, message: JSON.stringify(LISTING) } : { exitCode: 0, message: JSON.stringify({ id: 'ov1' }) };

test('overlay open (default element obsidian) goes to the server with the pane workspace from the journal, audited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elsctl-ov-'));
  const fake = await fakeEls(join(dir, 's.sock'), answer);
  const outcome = await runElsControl({ action: 'overlay', pane: 'p1' }, { socketPath: join(dir, 's.sock'), stateDir: dir });
  expect(outcome.ok).toBe(true);
  expect(fake.received.filter((r) => r.op !== 'ls')).toEqual([{ op: 'overlay', action: 'open', kind: 'obsidian', ws: 'w1', props: {} }]);
  expect(readFileSync(join(dir, 'control-audit.jsonl'), 'utf8')).toContain('"action":"overlay.open"');
  await fake.close();
});

test('overlay close by element, toast with text, list without a pane', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elsctl-ov2-'));
  const fake = await fakeEls(join(dir, 's.sock'), answer);
  const deps = { socketPath: join(dir, 's.sock'), stateDir: dir };
  await runElsControl({ action: 'overlay', overlay: 'close', element: 'obsidian', pane: 'p1' }, deps);
  await runElsControl({ action: 'overlay', element: 'toast', text: '안녕', level: 'success', pane: 'p1' }, deps);
  await runElsControl({ action: 'overlay', overlay: 'list' }, deps);
  expect(fake.received.filter((r) => r.op !== 'ls')).toEqual([
    { op: 'overlay', action: 'close', kind: 'obsidian' },
    { op: 'overlay', action: 'open', kind: 'toast', ws: 'w1', props: { text: '안녕', level: 'success' } },
    { op: 'overlay', action: 'list' },
  ]);
  await fake.close();
});

test('overlay refusals: unknown pane, bad sub-action, server denial passed through', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elsctl-ov3-'));
  const fake = await fakeEls(join(dir, 's.sock'), (r) => r.op === 'ls' ? answer(r) : { exitCode: 1, message: 'els: overlay denied — a pane acts on overlays of its own workspace only (OP: every space)' });
  const deps = { socketPath: join(dir, 's.sock'), stateDir: dir };
  expect((await runElsControl({ action: 'overlay', pane: 'nope' }, deps)).code).toBe('unknown-pane');
  expect((await runElsControl({ action: 'overlay', overlay: 'explode', pane: 'p1' }, deps)).exitCode).toBe(2);
  const denied = await runElsControl({ action: 'overlay', pane: 'p1' }, deps);
  expect([denied.ok, denied.message]).toEqual([false, 'els: overlay denied — a pane acts on overlays of its own workspace only (OP: every space)']);
  await fake.close();
});

test('the tool spec offers overlay with element obsidian|toast and tells the model what «옵시디언 띄워줘» means', () => {
  const spec = buildElsControlTool();
  const props = (spec.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
  expect(props.action!.enum).toContain('overlay');
  // ELS-ELEMENT-HOST: element is free text (any registered kind); the description names them.
  expect(props.element!.enum).toBeUndefined();
  expect(String((props.element as { description?: string }).description)).toContain('term(팝업 터미널');
  expect(spec.description).toContain('«팝업 터미널 띄워줘» → overlay open element term');
  expect(spec.description).toContain('«메모 띄워줘» → overlay open element memo');
  expect(spec.description).toContain('«옵시디언 띄워줘» → overlay open element obsidian');
  expect(spec.description).toContain('«사이드챗 열어줘» → overlay open element sidechat');
});
