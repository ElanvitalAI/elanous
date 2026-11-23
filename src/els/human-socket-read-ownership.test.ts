// Registered tool runtime descendants follow seat scope on the human socket. CEO 11-23 (ELS-ELN-SECURITY-RELAX):
// the OP seat may read every pane, so a registered OP runtime now reads another seat's pane too.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { elsSocketPath, startElsServer } from './server.js';
import { processIdentity } from './peer-seat.js';

test.skipIf(process.env.ELS_READ_OWNER_TTY === '1' || !!process.stdin.isTTY)('unverifiable non-tty caller cannot read, status or grep', async () => {
  const root = mkdtempSync('/tmp/els-unverified-read-');
  const server = await startElsServer({ stateRoot: root, stall: false, spawn: () => ({
    id: 'fixture', isAlive: () => true, write: () => {}, renderScreen: async () => 'private screen', onExit: () => {}, kill: () => {},
  }) });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const pane = JSON.parse(server.core.newPane({ ws: 'test', cwd: root, command: ['eln'], ownerSeat: 'OP' }).message).pane;
    const child = join(root, 'read.ts');
    writeFileSync(child, `import { requestEls } from ${JSON.stringify(join(import.meta.dir, 'client.ts'))};\nfor (const op of ['read','status','grep']) { const r=await requestEls(${JSON.stringify(elsSocketPath(root))},{op,pane:${JSON.stringify(pane)},pattern:'private'}); console.log(JSON.stringify(r)); }\n`);
    const p = Bun.spawn([process.execPath, child], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    const results = out.trim().split('\n').map(line => JSON.parse(line));
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('신원 확인 불가');
      expect(result.message).not.toContain('private screen');
    }
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
}, 60000);

test.skipIf(process.platform !== 'darwin')('human socket read lets a registered OP runtime observe another seat pane', async () => {
  const root = mkdtempSync('/tmp/els-read-owner-');
  const oldOwner = process.env.ELANOUS_ELS_OWNER_TOKEN;
  let n = 0;
  const server = await startElsServer({ stateRoot: root, stall: false, spawn: () => {
    const id = ++n;
    return { id: `fixture-${id}`, isAlive: () => true, write: () => {}, renderScreen: async () => `screen-${id}`, onExit: () => {}, kill: () => {} };
  } });
  if ('exitCode' in server) throw new Error(server.message);
  const child = join(root, 'child.ts'), runtimeFile = join(root, 'runtime.ts');
  const registration = join(root, 'registration.json'), own = join(root, 'own.json'), other = join(root, 'other.json');
  const ownPane = JSON.parse(server.core.newPane({ ws: 'test', cwd: root, command: ['eln'], ownerSeat: 'OP' }).message).pane;
  const otherPane = JSON.parse(server.core.newPane({ ws: 'test', cwd: root, command: ['eln'], ownerSeat: 'HAND-X' }).message).pane;
  writeFileSync(child, `import { requestEls } from ${JSON.stringify(join(import.meta.dir, 'client.ts'))};\nimport { writeFileSync } from 'node:fs';\nconst result = await requestEls(${JSON.stringify(elsSocketPath(root))}, JSON.parse(process.argv[2]));\nwriteFileSync(process.argv[3], JSON.stringify(result));\n`);
  writeFileSync(runtimeFile, `import { writeFileSync } from 'node:fs';\nimport { runShell } from ${JSON.stringify(join(import.meta.dir, '../shell-primitive/runtime.ts'))};\nconst run=async (request,out)=>{const result=await runShell({command:[process.execPath,${JSON.stringify(child)},JSON.stringify(request),out],approval:'none'}); if(result.exitCode) writeFileSync(out,JSON.stringify({childExit:result.exitCode}));};\nawait run({op:'seat-set',seat:'OP'},${JSON.stringify(registration)});\nawait run({op:'read',pane:${JSON.stringify(ownPane)}},${JSON.stringify(own)});\nawait run({op:'read',pane:${JSON.stringify(otherPane)}},${JSON.stringify(other)});\nawait new Promise(()=>{});\n`);
  const runtime = Bun.spawn([process.execPath, runtimeFile], { env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'ignore', stderr: 'ignore' });
  try {
    const end = Date.now() + 15000;
    while (!existsSync(other)) { if (Date.now() > end) throw new Error('fixture timeout'); await Bun.sleep(25); }
    expect(JSON.parse(readFileSync(registration, 'utf8')).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(own, 'utf8')).exitCode).toBe(0);
    const observed = JSON.parse(readFileSync(other, 'utf8'));
    expect(observed.exitCode).toBe(0);
    expect(observed.message).toContain('screen-2');
  } finally {
    runtime.kill(); await runtime.exited;
    await server.close();
    if (oldOwner === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = oldOwner;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test.skipIf(process.platform !== 'darwin')('pane credential on human socket cannot read another seat', async () => {
  if (process.env.ELS_READ_OWNER_TTY !== '1') {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path], {
      env: { ...process.env, ELS_READ_OWNER_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exitCode, output: stdout + stderr }).toMatchObject({ exitCode: 0, output: expect.stringContaining('2 pass') });
    return;
  }
  const root = mkdtempSync('/tmp/els-pane-read-');
  const oldOwner = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const tokens: string[] = [];
  // Bind only the first pane to this TTY process; possession of a copied token is insufficient.
  const identity = processIdentity(process.pid);
  expect(identity).toBeDefined();
  const server = await startElsServer({ stateRoot: root, stall: false, spawn: (_c, _d, _t, env) => {
    tokens.push(env.ELANOUS_ELS_PANE_TOKEN!);
    const id = tokens.length;
    return { id: `fixture-${id}`, isAlive: () => true, write: () => {}, renderScreen: async () => `screen-${id}`, onExit: () => {}, kill: () => {},
      ...(id === 1 ? { pid: process.pid, processBinding: { pid: process.pid, start: identity!.start, generation: 'fixture' } } : {}) };
  } });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const own = JSON.parse(server.core.newPane({ ws: 'test', cwd: root, command: ['eln'], ownerSeat: 'HAND-A', parent: {kind:'hand', seat:'HAND-A', workspaces:['test']} }).message).pane;
    const other = JSON.parse(server.core.newPane({ ws: 'test', cwd: root, command: ['eln'], ownerSeat: 'HAND-B', parent: {kind:'hand', seat:'HAND-B', workspaces:['test']} }).message).pane;
    const { createConnection } = await import('node:net');
    const ask = (pane: string, op = 'read', authenticated: boolean | 'invalid' = true) => new Promise<{exitCode:number;message:string}>((resolve, reject) => {
      const socket = createConnection(elsSocketPath(root)); let data = '';
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('request did not complete')); }); // 출처: #39422 denial must close the connection.
      socket.on('connect', () => { if (authenticated) socket.write(JSON.stringify({op:'auth',token:authenticated === 'invalid' ? 'invalid-test-credential' : tokens[0]}) + '\n'); socket.write(JSON.stringify({op,pane}) + '\n'); });
      socket.on('data', chunk => {data += chunk.toString();});
      socket.on('end', () => resolve(JSON.parse(data.trim().split('\n').pop()!)));
      socket.on('error', reject);
    });
    const ownRead = await ask(own);
    expect(ownRead.exitCode).toBe(0);
    expect(ownRead.message).toContain('screen-1');
    const noToken = await ask(own, 'read', false);
    expect(noToken.exitCode).toBe(1);
    expect(noToken.message).not.toContain('screen-1');
    const denied = await ask(other);
    expect(denied.exitCode).toBe(1);
    expect(denied.message).not.toBe('auth: outsider');
    expect(denied.message).not.toContain('screen-2');
    expect((await ask(other, 'status')).exitCode).toBe(1);
    expect((await ask(other, 'snapshot')).exitCode).toBe(1);
    expect((await ask(other, 'attach')).exitCode).toBe(1);
    expect((await ask(other, 'subscribe')).exitCode).toBe(1);
    expect((await ask(other, 'close')).exitCode).toBe(1);
    const listing = await ask(own, 'ls');
    expect(listing.exitCode).toBe(0);
    expect(listing.message).toContain(own);
    expect(listing.message).toContain(other);
    expect(listing.message).not.toContain('screen-1');
    expect(listing.message).not.toContain('screen-2');
    for (const op of ['read', 'status', 'grep', 'attach']) {
      const invalid = await ask(other, op, 'invalid');
      expect(invalid.exitCode).toBe(1);
      expect(invalid.message).not.toContain('screen-2');
    }
    // A separate TTY session is an independently verified human, not a descendant of the bound pane.
    const humanScript = join(root, 'human.ts');
    const humanResult = join(root, 'human.json');
    writeFileSync(humanScript, `import { requestEls } from ${JSON.stringify(join(import.meta.dir, 'client.ts'))};\nimport { writeFileSync } from 'node:fs';\nconst result = await requestEls(${JSON.stringify(elsSocketPath(root))}, { op: 'read', pane: ${JSON.stringify(other)} });\nwriteFileSync(${JSON.stringify(humanResult)}, JSON.stringify(result));\n`);
    const humanEnv = { ...process.env };
    delete humanEnv.ELANOUS_ELS_OWNER_TOKEN;
    delete humanEnv.ELANOUS_ELS_PANE_TOKEN;
    const human = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, humanScript], { env: humanEnv, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    expect(await human.exited).toBe(0);
    const humanRead = JSON.parse(readFileSync(humanResult, 'utf8'));
    expect(humanRead.exitCode).toBe(0);
    expect(humanRead.message).toContain('screen-2');
  } finally {
    await server.close();
    if (oldOwner === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = oldOwner;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
