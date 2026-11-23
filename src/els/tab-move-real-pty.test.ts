import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestEls } from './client.js';
import { elsSocketPath, startElsServer } from './server.js';

test('moving a tab preserves a real holder PTY, cwd and authenticated pane credential', async () => {
  const root = mkdtempSync('/tmp/els-move-');
  const names = ['ELANOUS_ELS_OWNER_TOKEN', 'ELANOUS_ELS_PANE_TOKEN', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_SOCKET', 'ELANOUS_ELS_WS', 'ELANOUS_ELS_RUNTIME_TOKEN_FILE', 'ELANOUS_STATE_DIR', 'ELANOUS_STATE_DIR_SOURCE', 'ELANOUS_SKIP_LOGIN_ENV'] as const;
  const saved = Object.fromEntries(names.map(k => [k, process.env[k]]));
  for (const k of names) delete process.env[k];
  process.env.ELANOUS_SKIP_LOGIN_ENV = '1';
  const socket = elsSocketPath(root);
  let server: Awaited<ReturnType<typeof startElsServer>> | undefined;
  const panes: string[] = [];
  try {
    server = await startElsServer({ stateRoot: root });
    if ('exitCode' in server) throw new Error(server.message);
    expect((await requestEls(socket, { op: 'seat-set', seat: 'OP' })).exitCode).toBe(0);
    const make = async (ws: string) => {
      const r = await requestEls(socket, { op: 'new', ws, cwd: root, command: ['/bin/sh'] });
      expect(r.exitCode, r.message).toBe(0);
      const pane = (JSON.parse(r.message) as { pane: string }).pane;
      panes.push(pane); return pane;
    };
    const pane = await make('alpha');
    await make('beta');
    const journal = JSON.parse(readFileSync(join(root, 'els', 'journal.json'), 'utf8')) as { panes: { id: string; tabId: string }[] };
    const tab = journal.panes.find(p => p.id === pane)!.tabId;
    const list = async () => JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { pane: string; ptyId: string; cwd: string; workspace: string }[] };
    const before = (await list()).panes.find(p => p.pane === pane)!;
    expect(before.ptyId).toBeTruthy();
    expect(before.cwd).toBe(root);
    const client = new URL('./client.js', import.meta.url).pathname;
    writeFileSync(join(root, 'probe.mjs'), `import {writeFileSync, renameSync} from 'node:fs';\nimport {requestEls} from ${JSON.stringify(client)};\nconst r=await requestEls(process.env.ELANOUS_ELS_SOCKET,{op:'ls'});\nconst out=JSON.stringify({token:process.env.ELANOUS_ELS_PANE_TOKEN,cwd:process.cwd(),result:r.exitCode});\nwriteFileSync(process.argv[2]+'.tmp',out);renameSync(process.argv[2]+'.tmp',process.argv[2]);\n`);
    const probe = async (file: string) => {
      const sent = await requestEls(socket, { op: 'input', pane, bytes: `${process.execPath} ./probe.mjs ${file}\r` });
      expect(sent.exitCode, sent.message).toBe(0);
      const path = join(root, file);
      const end = Date.now() + 20000;
      while (!existsSync(path) && Date.now() < end) await Bun.sleep(50);
      expect(existsSync(path)).toBe(true);
      return JSON.parse(readFileSync(path, 'utf8')) as { token: string; cwd: string; result: number };
    };
    const first = await probe('one');
    expect(first.token).toMatch(/^[0-9a-f]{48}$/);
    expect(first.cwd).toBe(realpathSync(root));
    expect(first.result).toBe(0);
    const moved = await requestEls(socket, { op: 'move-tab', tab, ws: 'beta' });
    expect(moved.exitCode, moved.message).toBe(0);
    const after = (await list()).panes.find(p => p.pane === pane)!;
    expect(after.ptyId).toBe(before.ptyId);
    expect(realpathSync(after.cwd)).toBe(realpathSync(before.cwd));
    expect(after.workspace).toBe('beta');
    const second = await probe('two');
    expect(second).toEqual(first);
  } finally {
    if (server && !('exitCode' in server)) {
      for (const pane of panes) await requestEls(socket, { op: 'close', pane, confirmed: true });
      await server.close();
    }
    for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
