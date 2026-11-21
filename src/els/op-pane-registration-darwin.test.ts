// Real peer ancestry and server-minted pane credential; no live state or credentials.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { elsSocketPath, startElsServer } from './server.js';

test.skipIf(process.platform !== 'darwin')('OP pane credential without a live holder binding cannot register an unrelated runtime', async () => {
  const root = mkdtempSync('/tmp/op-pane-reg-');
  const oldOwner = process.env.ELANOUS_ELS_OWNER_TOKEN;
  let paneToken = '';
  const server = await startElsServer({ stateRoot: root, stall: false, spawn: (_c, _d, _t, env) => {
    paneToken = env.ELANOUS_ELS_PANE_TOKEN!;
    return { id: 'fixture', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} };
  } });
  if ('exitCode' in server) throw new Error(server.message);
  const child = join(root, 'child.ts'), runtimeFile = join(root, 'runtime.ts'), result = join(root, 'result.json');
  server.core.newPane({ ws: 'test', cwd: root, command: ['eln'], ownerSeat: 'OP', parent: { kind: 'op' } });
  writeFileSync(child, `import { requestEls } from ${JSON.stringify(join(import.meta.dir, 'client.ts'))};\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(result)},JSON.stringify(await requestEls(${JSON.stringify(elsSocketPath(root))},{op:'seat-set',seat:'OP'})));\n`);
  writeFileSync(runtimeFile, `import { runShell } from ${JSON.stringify(join(import.meta.dir, '../shell-primitive/runtime.ts'))};\nawait runShell({command:[process.execPath,${JSON.stringify(child)}],approval:'none'});\nawait new Promise(()=>{});\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_ELS_PANE_TOKEN: paneToken };
  delete env.ELANOUS_ELS_OWNER_TOKEN;
  const runtime = Bun.spawn([process.execPath, runtimeFile], { env, stdout: 'ignore', stderr: 'ignore' });
  try {
    const end = Date.now() + 15000;
    while (!existsSync(result)) { if (Date.now() > end) throw new Error('registration fixture timeout'); await Bun.sleep(25); }
    expect(JSON.parse(readFileSync(result, 'utf8'))).toMatchObject({
      exitCode: 1, message: 'auth: outsider', transport: { outcome: 'answered' },
    });
    expect(existsSync(join(root, 'els', 'runtime-token'))).toBe(false);
  } finally {
    runtime.kill(); await runtime.exited;
    await server.close();
    if (oldOwner === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = oldOwner;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test.skipIf(process.platform !== 'darwin')('pane credential without a verified live generation cannot read its pane', async () => {
  const root = mkdtempSync('/tmp/pane-token-unbound-');
  const oldOwner = process.env.ELANOUS_ELS_OWNER_TOKEN;
  let paneToken = '';
  const server = await startElsServer({ stateRoot: root, stall: false, spawn: (_c, _d, _t, env) => {
    paneToken = env.ELANOUS_ELS_PANE_TOKEN!;
    return { id: 'fixture', isAlive: () => true, write: () => {}, renderScreen: async () => 'private-screen', onExit: () => {}, kill: () => {} };
  } });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const pane = JSON.parse(server.core.newPane({ ws: 'test', cwd: root, command: ['fixture'], ownerSeat: 'OP', parent: { kind: 'op' } }).message).pane;
    const response = await new Promise<{exitCode: number; message: string}>((resolve, reject) => {
      const socket = createConnection(elsSocketPath(root)); let data = '';
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('socket timeout')); });
      socket.on('connect', () => { socket.write(JSON.stringify({ op: 'auth', token: paneToken }) + '\n'); socket.write(JSON.stringify({ op: 'read', pane }) + '\n'); });
      socket.on('data', chunk => { data += chunk.toString(); });
      socket.on('end', () => resolve(JSON.parse(data.trim().split('\n').pop()!)));
      socket.on('error', reject);
    });
    expect(response.exitCode).toBe(1);
    expect(response.message).not.toContain('private-screen');
  } finally {
    await server.close();
    if (oldOwner === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = oldOwner;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
