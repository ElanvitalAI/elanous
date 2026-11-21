import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestEls } from './client.js';
import { elsSocketPath, elsToolSocketPath, startElsServer } from './server.js';
import { elsJournalPath, loadJournal } from './journal.js';
import { processIdentity } from './peer-seat.js';

test('tool grant alone cannot authorize an unverified seat', async () => {
  const root = mkdtempSync('/tmp/els-tool-new-unverified-');
  let spawns = 0;
  const server = await startElsServer({ stateRoot: root, stall: false, spawn: () => {
    spawns++;
    return { id: 'fixture', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} };
  } });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    writeFileSync(join(root, 'els', 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['new'] }] }));
    const result = await requestEls(elsToolSocketPath(root), { op: 'new', ws: 'fixture', cwd: root, command: ['fixture-command'] });
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain('verified tool seat required');
    expect(spawns).toBe(0);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'darwin')('tool socket cannot spawn a command without an explicit tool new grant', async () => {
  // Bind this private-TTY test process as the first fixture pane's live shell.
  // Unlike a copied token, its actual socket peer then satisfies the ancestry check.
  if (process.env.ELS_TOOL_NEW_PRIVATE_TTY !== '1') {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path, '-t', 'tool socket cannot spawn a command without an explicit tool new grant'], {
      env: { ...process.env, ELS_TOOL_NEW_PRIVATE_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: out + err }).toMatchObject({ code: 0, output: expect.stringContaining('1 pass') });
    return;
  }
  const identity = processIdentity(process.pid);
  expect(identity).toBeDefined();
  const root = mkdtempSync('/tmp/els-tool-new-');
  const oldOwner = process.env.ELANOUS_ELS_OWNER_TOKEN;
  let spawns = 0;
  let createdToken: string | undefined;
  const server = await startElsServer({ stateRoot: root, stall: false, spawn: (_c, _d, _t, env) => {
    spawns++;
    createdToken = env.ELANOUS_ELS_PANE_TOKEN;
    return { id: 'fixture', ...(spawns === 1 ? { pid: process.pid, processBinding: { pid: process.pid, start: identity!.start, generation: 'tool-new-fixture' } } : {}), isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} };
  } });
  if ('exitCode' in server) throw new Error(server.message);
  const childFile = join(root, 'child.ts'), runtimeFile = join(root, 'runtime.ts');
  const registration = join(root, 'registration.json'), deniedFile = join(root, 'denied.json'), allowedFile = join(root, 'allowed.json');
  const ruleFile = join(root, 'els', 'control-allow.json');
  writeFileSync(childFile, `import { requestEls } from ${JSON.stringify(join(import.meta.dir, 'client.ts'))};\nimport { writeFileSync, renameSync } from 'node:fs';\nconst result = await requestEls(process.argv[2], JSON.parse(process.argv[3]));\nwriteFileSync(process.argv[4] + '.tmp', JSON.stringify(result));\nrenameSync(process.argv[4] + '.tmp', process.argv[4]);\n`);
  writeFileSync(runtimeFile, `import { writeFileSync } from 'node:fs';\nimport { runShell } from ${JSON.stringify(join(import.meta.dir, '../shell-primitive/runtime.ts'))};\nconst run=async (socket,request,out)=>{const result=await runShell({command:[process.execPath,${JSON.stringify(childFile)},socket,JSON.stringify(request),out],approval:'none'}); if(result.exitCode) writeFileSync(out,JSON.stringify({childExit:result.exitCode}));};\nawait run(${JSON.stringify(elsSocketPath(root))},{op:'seat-set',seat:'OP'},${JSON.stringify(registration)});\nconst request={op:'new',ws:'fixture',cwd:${JSON.stringify(root)},command:['fixture-command']};\nawait run(${JSON.stringify(elsToolSocketPath(root))},request,${JSON.stringify(deniedFile)});\nwhile (!require('node:fs').existsSync(${JSON.stringify(ruleFile)})) await Bun.sleep(25);\nawait run(${JSON.stringify(elsToolSocketPath(root))},request,${JSON.stringify(allowedFile)});\nawait new Promise(()=>{});\n`);
  const runtime = Bun.spawn([process.execPath, runtimeFile], { env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'ignore', stderr: 'ignore' });
  const waitFor = async (path: string) => {
    const end = Date.now() + 15000;
    while (!existsSync(path)) { if (Date.now() > end) throw new Error(`fixture timeout: ${path}`); await Bun.sleep(25); }
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  try {
    delete process.env.ELANOUS_ELS_OWNER_TOKEN;
    const unauthenticated = await requestEls(elsToolSocketPath(root), { op: 'new', ws: 'fixture', cwd: root, command: ['fixture-command'] });
    expect(unauthenticated.exitCode).not.toBe(0);
    expect((await waitFor(registration)).exitCode).toBe(0);
    const result = await waitFor(deniedFile);
    expect(result.exitCode).not.toBe(0);
    expect(spawns).toBe(0);
    writeFileSync(ruleFile, JSON.stringify({ rules: [
      { principal: 'eln:tool', workspace: '*', pane: '*', actions: ['new'] },
      { principal: '*', workspace: '*', pane: '*', actions: ['input'] },
    ] }));
    const allowed = await waitFor(allowedFile);
    expect(allowed.exitCode).toBe(0);
    expect(spawns).toBe(1);
    const created = JSON.parse(allowed.message).pane;
    expect(loadJournal(elsJournalPath(root)).panes.find(p => p.id === created)?.ownerSeat).toBe('OP');
    expect(createdToken).toBeTruthy();
    const { createConnection } = await import('node:net');
    const deniedRegistration = await new Promise<{exitCode: number; message: string}>((resolve, reject) => {
      const socket = createConnection(elsSocketPath(root)); let data = '';
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('registration timed out')); }); // 출처: #121062 denial must close.
      socket.on('connect', () => { socket.write(JSON.stringify({ op: 'auth', token: createdToken }) + '\n'); socket.write(JSON.stringify({ op: 'seat-set', seat: 'OP' }) + '\n'); });
      socket.on('data', chunk => { data += chunk.toString(); });
      socket.on('end', () => resolve(JSON.parse(data.trim().split('\n').pop()!)));
      socket.on('error', reject);
    });
    expect(deniedRegistration.exitCode).toBe(1);
    expect(deniedRegistration.message).toContain('seat-set denied');
    expect(deniedRegistration.message).toContain('hand seat unknown');
    const ownRead = await new Promise<{exitCode: number; message: string}>((resolve, reject) => {
      const socket = createConnection(elsSocketPath(root)); let data = '';
      socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('read timed out')); });
      socket.on('connect', () => { socket.write(JSON.stringify({ op: 'auth', token: createdToken }) + '\n'); socket.write(JSON.stringify({ op: 'read', pane: created }) + '\n'); });
      socket.on('data', chunk => { data += chunk.toString(); });
      socket.on('end', () => resolve(JSON.parse(data.trim().split('\n').pop()!)));
      socket.on('error', reject);
    });
    expect(ownRead.exitCode).toBe(0);
    const workerToken = createdToken;
    const attachTo = (pane: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = createConnection(elsSocketPath(root)); let data = '';
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('attach timed out')); });
      socket.on('connect', () => { socket.write(JSON.stringify({ op: 'auth', token: workerToken }) + '\n'); socket.write(JSON.stringify({ op: 'attach', pane }) + '\n'); });
      socket.on('data', chunk => {
        data += chunk.toString();
        const lines = data.split('\n');
        if (lines.length >= 3) { socket.destroy(); resolve(JSON.parse(lines[1]!)); }
      });
      socket.on('error', reject);
    });
    const attachReply = await attachTo(created);
    expect(attachReply.type).toBe('frame');
    expect(attachReply.pane).toBe(created);
    const foreign = JSON.parse(server.core.newPane({ ws: 'fixture', cwd: root, command: ['fixture-command'], ownerSeat: 'HAND-B' }).message).pane;
    const deniedAttach = await attachTo(foreign);
    expect(deniedAttach.exitCode).toBe(1);
    expect(deniedAttach.message).toContain('target is not owned by caller seat');
    const unassigned = JSON.parse(server.core.newPane({ ws: 'fixture', cwd: root, command: ['fixture-command'], ownerSeat: 'unknown' }).message).pane;
    const unassignedAttach = await attachTo(unassigned);
    expect(unassignedAttach.exitCode).toBe(1);
    expect(unassignedAttach.message).toContain('target is not owned by caller seat');
    const unassignedRead = await new Promise<{exitCode: number; message: string}>((resolve, reject) => {
      const socket = createConnection(elsSocketPath(root)); let data = '';
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('read timed out')); });
      socket.on('connect', () => { socket.write(JSON.stringify({ op: 'auth', token: workerToken }) + '\n'); socket.write(JSON.stringify({ op: 'read', pane: unassigned }) + '\n'); });
      socket.on('data', chunk => { data += chunk.toString(); });
      socket.on('end', () => resolve(JSON.parse(data.trim().split('\n').pop()!)));
      socket.on('error', reject);
    });
    expect(unassignedRead.exitCode).toBe(1);
    expect(unassignedRead.message).toContain('target is not owned by caller seat');
  } finally {
    runtime.kill(); await runtime.exited;
    await server.close();
    if (oldOwner === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = oldOwner;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
