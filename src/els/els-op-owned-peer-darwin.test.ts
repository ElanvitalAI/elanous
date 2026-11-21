// End-to-end fixture: real els-owned OP holder calls ElsControl against an isolated server.
// No seatLookup, herdr response, or live seat ledger is injected.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestEls } from './client.js';
import { loadJournal } from './journal.js';
import { connectHolderElsPty, spawnHolderDetached } from './holder.js';
import { elsSocketPath, startElsServer } from './server.js';

const sleep = () => new Promise<void>(r => setTimeout(r, 25));
async function until(check: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!check()) { if (Date.now() > deadline) throw new Error('fixture timed out'); await sleep(); }
}

(test.skipIf(process.platform !== 'darwin'))('els OP holder creates and controls its owned worker through real peer identity', async () => {
  const root = mkdtempSync('/tmp/eop-');
  const stateDir = join(root, 'els');
  const resultFile = join(root, 'result.json');
  const bytesFile = join(root, 'bytes');
  const foreignBytes = join(root, 'foreign-bytes');
  const foreignId = join(root, 'foreign-id');
  const script = join(root, 'op.ts');
  const recorder = join(root, 'recorder.py');
  const holders: number[] = [];
  const ownerBefore = process.env.ELANOUS_ELS_OWNER_TOKEN;
  writeFileSync(recorder, 'import os,sys,tty\ntty.setraw(0)\nf=open(sys.argv[1],"ab",buffering=0)\nwhile True:\n b=os.read(0,1024)\n if not b: break\n f.write(b)\n');
  writeFileSync(script, `import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nimport { runElsControl } from ${JSON.stringify(join(import.meta.dir, 'els-control-tool.ts'))};\nimport { runShell } from ${JSON.stringify(join(import.meta.dir, '../shell-primitive/runtime.ts'))};\nprocess.env.ELANOUS_STATE_DIR=${JSON.stringify(root)};\ndelete process.env.ELANOUS_ELS_PANE_TOKEN;\ndelete process.env.ELANOUS_ELS_OWNER_TOKEN;\nconst registration=await runShell({command:[process.execPath,${JSON.stringify(join(import.meta.dir, '../../bin/elanous.mjs'))},'side','seat','set','OP'],approval:'none'});\nconst registrationExit=registration.exitCode;\nif(registrationExit!==0){writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({registrationExit}));await new Promise(()=>{});}\ndelete process.env.ELANOUS_ELS_PANE_TOKEN;\nconst deps={socketPath:process.env.ELANOUS_ELS_SOCKET!,stateDir:${JSON.stringify(stateDir)}};\nconst pane=process.env.ELANOUS_ELS_PANE!;\nconst bytesFile=${JSON.stringify(bytesFile)};\nconst wait=async (check:()=>boolean)=>{const end=Date.now()+10000; while(!check()){if(Date.now()>end) throw new Error('recorder readiness timeout'); await new Promise(r=>setTimeout(r,25));}};\nconst created=await runElsControl({action:'new',pane,text:${JSON.stringify(`/usr/bin/python3 -u ${recorder} ${bytesFile}`)}},deps);\nconst worker=created.ok ? JSON.parse(created.message).pane : undefined;\nif(worker) await wait(()=>existsSync(bytesFile));\nconst sent=worker ? await runElsControl({action:'send',pane:worker,text:'pwd'},deps) : null;\nif(sent?.ok) await wait(()=>readFileSync(bytesFile).length>=4);\nconst foreign=readFileSync(${JSON.stringify(foreignId)},'utf8');\nconst rejected=await runElsControl({action:'send',pane:foreign,text:'pwd'},deps);\nconst stopped=worker ? await runElsControl({action:'stop',pane:worker},deps) : null;\nwriteFileSync(${JSON.stringify(resultFile)},JSON.stringify({registrationExit,created,worker,sent,rejected,stopped}));\nawait new Promise(()=>{});\n`);
  const server = await startElsServer({ stateRoot: root, stall: false,
    spawn: (command, cwd, title, env) => {
      const id = env.ELANOUS_ELS_PANE;
      holders.push(spawnHolderDetached({ stateRoot: root, paneId: id, cwd, title, env, command }).pid);
      return connectHolderElsPty(root, id, undefined);
    },
  });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['new', 'do'] }] }));
    const foreign = server.core.newPane({ ws: 'foreign', cwd: root, command: ['/usr/bin/python3', '-u', recorder, foreignBytes], ownerSeat: 'RES-INFRA' });
    expect(foreign.exitCode).toBe(0);
    writeFileSync(foreignId, JSON.parse(foreign.message).pane);
    await until(() => existsSync(foreignBytes));
    const socket = elsSocketPath(root);
    const op = await requestEls(socket, { op: 'new', ws: 'test', cwd: root, command: [process.execPath, script] });
    expect(op.exitCode).toBe(0);
    await until(() => existsSync(resultFile));
    const result = JSON.parse(readFileSync(resultFile, 'utf8'));
    expect(result.registrationExit).toBe(0);
    expect(result.created?.ok).toBe(true);
    expect(result.worker).toBeTruthy();
    expect(loadJournal(join(stateDir, 'journal.json')).panes.find(p => p.id === result.worker)?.ownerSeat).toBe('OP');
    expect(result.sent?.ok, JSON.stringify(result.sent)).toBe(true);
    expect(result.rejected?.ok, JSON.stringify(result.rejected)).toBe(false);
    expect(readFileSync(foreignBytes).length).toBe(0);
    expect(result.stopped?.ok).toBe(true);
    await until(() => existsSync(bytesFile) && readFileSync(bytesFile).length >= 5);
    expect(readFileSync(bytesFile).toString('hex')).toBe(Buffer.from('pwd\r\x1b').toString('hex'));
  } finally {
    for (const pid of holders) { try { process.kill(pid, 'SIGTERM'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
    for (const pid of holders) await until(() => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; } });
    await server.close();
    if (ownerBefore === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = ownerBefore;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
