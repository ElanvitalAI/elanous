// Real Darwin PTY contract: a private server socket, detached production holder and raw-tty byte recorder.
// seatLookup is deliberately injected: this verifies the server's decisions after lookup, NOT OS peer-to-seat resolution.
// The recorder is a local inert fixture; it never runs an agent or contacts an operational server.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestEls } from './client.js';
import { runElsControl } from './els-control-tool.js';
import { connectHolderElsPty, holderMetaPath, spawnHolderDetached } from './holder.js';
import { elsSocketPath, startElsServer } from './server.js';

// Real asynchronous holder/PTY boot and IO need a bounded wait; not a latency assertion.
const WAIT_MS = 15_000;
const POLL_MS = 25;
const sleep = () => new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out waiting for real holder PTY'); await sleep(); }
}

(test.skipIf(process.platform !== 'darwin'))('ElsControl send/stop traverse both doors to actual holder PTY bytes', async () => {
  // Short root avoids Darwin sockaddr_un limit. Everything, including the recorder, is under this root.
  const root = mkdtempSync('/tmp/ecpty-');
  const bytesPath = join(root, 'bytes');
  const readyPath = join(root, 'ready');
  const stateDir = join(root, 'els');
  const socketPath = elsSocketPath(root);
  const ownerBefore = process.env.ELANOUS_ELS_OWNER_TOKEN;
  let verified = true;
  let holderPid: number | undefined;
  let pane = '';
  const python = 'import os,sys,tty\ntty.setraw(0)\nopen(sys.argv[2],"w").close()\nf=open(sys.argv[1],"ab",buffering=0)\nwhile True:\n b=os.read(0,1024)\n if not b: break\n f.write(b)';
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: () => verified ? { pane: 'test-op-pane', seat: 'OP' } : undefined,
    // Real holder process, with its PID captured so finally can explicitly terminate it even on assertion failure.
    spawn: (command, cwd, title, env) => {
      const id = env.ELANOUS_ELS_PANE;
      holderPid = spawnHolderDetached({ stateRoot: root, paneId: id, cwd, title, env, command }).pid;
      return connectHolderElsPty(root, id, undefined);
    },
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const made = await requestEls(socketPath, { op: 'new', ws: 'test', cwd: root, command: ['/usr/bin/python3', '-u', '-c', python, bytesPath, readyPath] });
    expect(made.exitCode).toBe(0);
    pane = (JSON.parse(made.message) as { pane: string }).pane;
    await until(() => existsSync(readyPath) && existsSync(holderMetaPath(root, pane)));
    const allow = (enabled: boolean) => writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules: enabled ? [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do', 'list', 'read'] }] : [] }));
    const send = (text: string) => runElsControl({ action: 'send', pane, text }, { socketPath, stateDir });
    const stop = () => runElsControl({ action: 'stop', pane, text: 'ignored' }, { socketPath, stateDir });
    const bytes = () => existsSync(bytesPath) ? readFileSync(bytesPath).toString('hex') : '';
    allow(false);
    expect((await send('blocked')).ok).toBe(false);
    expect((await stop()).ok).toBe(false);
    expect(bytes()).toBe('');
    allow(true);
    verified = false;
    expect((await send('blocked')).ok).toBe(false);
    expect((await stop()).ok).toBe(false);
    expect(bytes()).toBe('');
    verified = true;
    const listing = await runElsControl({ action: 'ls' }, { socketPath, stateDir });
    expect(listing).toMatchObject({ ok: true, exitCode: 0, request: { op: 'ls' } });
    expect(JSON.stringify(listing.data)).toContain(pane);
    const screen = await runElsControl({ action: 'read', pane }, { socketPath, stateDir });
    expect(screen).toMatchObject({ ok: true, exitCode: 0, request: { op: 'read', pane } });
    expect(await send('pwd')).toMatchObject({ ok: true, exitCode: 0, request: { op: 'input-line', pane, text: 'pwd', from: 'ElsControl' } });
    await until(() => bytes().length >= 8);
    expect(bytes()).toBe(Buffer.from('pwd\r').toString('hex'));
    expect(await stop()).toMatchObject({ ok: true, exitCode: 0, request: { op: 'interrupt', pane } });
    await until(() => bytes().length >= 10);
    expect(bytes()).toBe(Buffer.from('pwd\r\x1b').toString('hex'));
  } finally {
    // server.close only detaches: terminate the exact holder spawned above and wait for its own cleanup.
    if (holderPid !== undefined) {
      try { process.kill(holderPid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await until(() => { try { process.kill(holderPid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } });
      if (pane) expect(existsSync(holderMetaPath(root, pane))).toBe(false);
    }
    await server.close();
    if (ownerBefore === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = ownerBefore;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000); // Real holder boot and multiple socket operations; per-step limit above.
