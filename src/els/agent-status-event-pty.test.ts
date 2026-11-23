import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestEls } from './client.js';
import { elsSocketPath, startElsServer } from './server.js';

// Existing real-holder tests allow 20 seconds for process startup.
const WAIT_MS = 20_000;
const POLL_MS = 50;

test('real pane emitter authenticates its turn event; an outsider cannot impersonate it', async () => {
  const root = mkdtempSync('/tmp/els-agent-event-');
  let panePid = 0;
  const server = await startElsServer({ stateRoot: root, ps: async () => panePid ? `${panePid} ${panePid} bun /fake/elanous.mjs` : '' });
  if ('exitCode' in server) throw new Error(server.message);
  let pane = '';
  try {
    const made = server.core.newPane({ ws: 'HQ', cwd: root, command: ['/bin/sh'], title: 'ELN-SEAT' });
    expect(made.exitCode).toBe(0); pane = (JSON.parse(made.message) as { pane: string }).pane;
    const deadline = Date.now() + WAIT_MS;
    while (!panePid && Date.now() < deadline) { panePid = server.core.shellPids()[0]?.pid ?? 0; if (!panePid) await Bun.sleep(POLL_MS); }
    expect(panePid).toBeGreaterThan(0);
    server.core.setForegrounds(new Map([[pane, { kind: 'eln', command: ['eln'], pid: panePid }]]));
    const frame = { op: 'event' as const, v: 1 as const, ws: 'HQ', pane, sid: 'outsider', seq: 1, at: Date.now(), event: { kind: 'turn' as const, phase: 'start' as const, id: 'bad' } };
    expect((await requestEls(elsSocketPath(root), frame)).exitCode).toBe(1);
    const script = join(root, 'emit.mjs'), marker = join(root, 'sent');
    const modulePath = new URL('../agent-events/transport.ts', import.meta.url).pathname;
    const emitterPath = new URL('../agent-events/emit.ts', import.meta.url).pathname;
    writeFileSync(script, `import {sendFrameOverSocket} from ${JSON.stringify(modulePath)}; import {getAgentEventEmitter} from ${JSON.stringify(emitterPath)}; import {writeFileSync} from 'node:fs'; const frame={op:'event',v:1,ws:'HQ',pane:process.env.ELANOUS_EVENT_PANE,sid:'real',seq:1,at:Date.now(),event:{kind:'turn',phase:'end',id:'real-turn'}}; const r=await sendFrameOverSocket(process.env.ELANOUS_EVENT_SOCKET,frame,{paneAuth:{token:process.env.ELANOUS_ELS_PANE_TOKEN,pid:process.pid}}); const e=getAgentEventEmitter(); if(e){e.turn('start','emitter-turn'); await e.flush();} writeFileSync(${JSON.stringify(marker)},JSON.stringify({r,emitter:!!e}));\n`);
    expect(server.core.input(pane, `${process.execPath} ${script}\r`).exitCode).toBe(0);
    const until = Date.now() + WAIT_MS;
    while (!existsSync(marker) && Date.now() < until) await Bun.sleep(POLL_MS);
    if (!existsSync(marker)) throw new Error(`emitter did not finish: ${(await server.core.read(pane)).message}`);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ r: { exitCode: 0, message: 'event: accepted' }, emitter: true });
    const listed = JSON.parse(server.core.list().message) as { panes: { pane: string; activityState: string }[] };
    expect(listed.panes.find(row => row.pane === pane)?.activityState).toBe('working');
  } finally { if (pane) server.core.close(pane); await server.close(); rmSync(root, { recursive: true, force: true }); }
}, 90_000);
