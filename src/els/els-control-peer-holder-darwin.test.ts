// Real Darwin PTY contract: a private server socket, detached production holder and raw-tty byte recorder.
// The only injected boundaries are a private ledger and a simulated herdr response; OS PID and process identity are real.
// The outer test allocates its own controlling tty, including on a headless gate.
// The recorder is a local inert fixture; it never runs an agent or contacts an operational server.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processIdentity, resolvePeerSeat } from './peer-seat.js';
import { requestEls } from './client.js';
import { runElsControl } from './els-control-tool.js';
import { connectHolderElsPty, holderMetaPath, spawnHolderDetached } from './holder.js';
import { elsSocketPath, elsToolSocketPath, startElsServer } from './server.js';

// Real asynchronous holder/PTY boot and IO need a bounded wait; not a latency assertion.
const WAIT_MS = 15_000;
const POLL_MS = 25;
const sleep = () => new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out waiting for real holder PTY'); await sleep(); }
}

(test.skipIf(process.platform !== 'darwin'))('real peer identity resolves fixture seat through both doors to holder PTY', async () => {
  if (process.env.ELS_TEST_IN_PRIVATE_TTY !== '1') {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path], {
      env: { ...process.env, ELS_TEST_IN_PRIVATE_TTY: '1', NO_COLOR: '1' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = stdout + stderr;
    expect({ exitCode, output }).toMatchObject({ exitCode: 0, output: expect.stringContaining('1 pass') });
    expect(output).toContain('0 fail');
    return;
  }
  // Short root avoids Darwin sockaddr_un limit. Everything, including the recorder, is under this root.
  const root = mkdtempSync('/tmp/ecpty-');
  const bytesPath = join(root, 'bytes');
  const readyPath = join(root, 'ready');
  const stateDir = join(root, 'els');
  const socketPath = elsSocketPath(root);
  const ownerBefore = process.env.ELANOUS_ELS_OWNER_TOKEN;
  let verified = true;
  const observations: { pid: number | undefined; baseline: ReturnType<typeof processIdentity>; current: ReturnType<typeof processIdentity> }[] = [];
  const ledgerReads: string[] = [];
  const ledgerPath = join(root, 'seat-panes.tsv');
  writeFileSync(ledgerPath, 'OP\twFixture:p1\n');
  let holderPid: number | undefined;
  let pane = '';
  const python = 'import os,sys,tty\ntty.setraw(0)\nopen(sys.argv[2],"w").close()\nf=open(sys.argv[1],"ab",buffering=0)\nwhile True:\n b=os.read(0,1024)\n if not b: break\n f.write(b)';
  const server = await startElsServer({ stateRoot: root, stall: false,
    seatLookup: async (pid, baseline) => {
      observations.push({ pid, baseline, current: processIdentity(process.pid) });
      return resolvePeerSeat(pid, baseline, ledgerPath, {
        identity: processIdentity,
        ledger: async path => { ledgerReads.push(path); return readFileSync(path, 'utf8'); },
        // A fixture, not an invocation of the installed herdr; peer itself is the simulated shell.
        paneInfo: async pane => ({ pane_id: pane, shell_pid: verified ? process.pid : -1 }),
      });
    },
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
    const allow = (enabled: boolean) => writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules: enabled ? [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] : [] }));
    const toolSocketPath = elsToolSocketPath(root);
    const send = (text: string) => runElsControl({ action: 'send', pane, text }, { socketPath: toolSocketPath, stateDir });
    const stop = () => runElsControl({ action: 'stop', pane, text: 'ignored' }, { socketPath: toolSocketPath, stateDir });
    const bytes = () => existsSync(bytesPath) ? readFileSync(bytesPath).toString('hex') : '';
    allow(false);
    for (const result of [await send('pwd'), await stop()]) {
      expect(result.ok).toBe(false);
      expect(result.message).toContain('not in control-allow.json');
    }
    expect(bytes()).toBe('');
    allow(true);
    verified = false;
    const refusedSend = await send('pwd');
    expect(refusedSend.ok).toBe(false);
    expect(refusedSend.message).toContain('not in control-allow.json');
    const refusedStop = await stop();
    expect(refusedStop.ok).toBe(false);
    expect(refusedStop.message).toContain('interrupt denied — server owner terminal');
    expect(bytes()).toBe('');
    verified = true;
    expect(await send('pwd')).toMatchObject({ ok: true, exitCode: 0, request: { op: 'input-line', pane, text: 'pwd', from: 'ElsControl' } });
    await until(() => bytes().length >= 8);
    expect(bytes()).toBe(Buffer.from('pwd\r').toString('hex'));
    expect(await stop()).toMatchObject({ ok: true, exitCode: 0, request: { op: 'interrupt', pane } });
    await until(() => bytes().length >= 10);
    expect(bytes()).toBe(Buffer.from('pwd\r\x1b').toString('hex'));
    expect(observations.length).toBeGreaterThan(0); // 출처: #39422 real peer identity lookup must occur.
    for (const { pid, baseline, current } of observations) {
      expect(pid).toBe(process.pid);
      expect(baseline).toBeDefined();
      expect(baseline).toEqual(current);
    }
    expect(ledgerReads.length).toBeGreaterThan(0); // 출처: #39422 seat resolution must read the ledger.
    expect(ledgerReads.every(path => path === ledgerPath)).toBe(true);
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
