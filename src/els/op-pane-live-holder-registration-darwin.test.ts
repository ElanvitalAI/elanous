// Private Darwin holder -> real pane runtime -> child socket peer registration regression.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectHolderElsPty, holderMetaPath, spawnHolderDetached } from './holder.js';
import { elsSocketPath, startElsServer } from './server.js';

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 15_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('private holder fixture timeout'); await Bun.sleep(25); }
};

test.skipIf(process.platform !== 'darwin')('real holder pane descendant registers OP runtime', async () => {
  if (process.env.ELS_LIVE_REG_TTY !== '1') {
    const p = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path], {
      env: { ...process.env, ELS_LIVE_REG_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ exitCode, output: stdout + stderr }).toMatchObject({ exitCode: 0, output: expect.stringContaining('1 pass') });
    return;
  }
  const root = mkdtempSync('/tmp/oplive-');
  const oldOwner = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const result = join(root, 'result.json'), go = join(root, 'go');
  const runtime = join(root, 'runtime.ts'), child = join(root, 'child.ts');
  let holderPid: number | undefined;
  let pane = '';
  const server = await startElsServer({ stateRoot: root, stall: false, spawn: (command, cwd, title, env) => {
    const id = env.ELANOUS_ELS_PANE;
    holderPid = spawnHolderDetached({ stateRoot: root, paneId: id, cwd, title, env, command }).pid;
    return connectHolderElsPty(root, id, undefined);
  } });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    writeFileSync(child, `import { requestEls } from ${JSON.stringify(join(import.meta.dir, 'client.ts'))};\nimport { createConnection } from 'node:net';\nimport { writeFileSync } from 'node:fs';\nconst path=${JSON.stringify(elsSocketPath(root))};\nconst r=await requestEls(path,{op:'seat-set',seat:'OP'});\nconst own=await requestEls(path,{op:'read',pane:process.env.ELANOUS_ELS_PANE});\nconst noCredential=await new Promise((resolve,reject)=>{const s=createConnection(path);let data='';s.setTimeout(5000,()=>{s.destroy();reject(Error('socket timeout'))});s.on('connect',()=>s.write(JSON.stringify({op:'read',pane:process.env.ELANOUS_ELS_PANE})+'\\n'));s.on('data',c=>data+=c);s.on('end',()=>resolve(JSON.parse(data)));s.on('error',reject)});\nwriteFileSync(${JSON.stringify(result)},JSON.stringify({exitCode:r.exitCode,own:own.exitCode,noCredential:noCredential.exitCode}));\n`);
    writeFileSync(runtime, `import { runtimeProcessIdentity } from ${JSON.stringify(join(import.meta.dir, 'seat-runtime.ts'))};\nimport { existsSync } from 'node:fs';\nwhile(!existsSync(${JSON.stringify(go)})) await Bun.sleep(25);\nconst p=runtimeProcessIdentity(process.pid); if(!p) throw Error('runtime identity unavailable');\nconst env={...process.env, ELN_SEAT_RUNTIME:JSON.stringify({pid:p.pid,start:p.start})}; delete env.ELANOUS_ELS_OWNER_TOKEN;\nconst c=Bun.spawn([process.execPath,${JSON.stringify(child)}],{env,stdout:'ignore',stderr:'ignore'}); await c.exited;\nawait new Promise(()=>{});\n`);
    const made = server.core.newPane({ ws: 'test', cwd: root, command: [process.execPath, runtime], ownerSeat: 'OP', parent: { kind: 'op' } });
    expect(made.exitCode).toBe(0);
    pane = JSON.parse(made.message).pane;
    await waitFor(() => existsSync(holderMetaPath(root, pane)) && !!server.core.paneProcessBinding(pane));
    writeFileSync(go, 'go');
    await waitFor(() => existsSync(result));
    const registration = JSON.parse(readFileSync(result, 'utf8'));
    expect(registration).toMatchObject({ exitCode: 0, own: 0, noCredential: 1 });
    expect(existsSync(join(root, 'els', 'runtime-token'))).toBe(true);
  } finally {
    if (holderPid !== undefined) {
      try { process.kill(holderPid, 'SIGTERM'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
      await waitFor(() => { try { process.kill(holderPid!, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; } });
    }
    await server.close();
    if (oldOwner === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = oldOwner;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
