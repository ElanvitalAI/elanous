// Real OS descendants using the human socket must still pass the tool policy.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { elsSocketPath, startElsServer } from './server.js';

for (const runtimeSurvives of [true, false]) test.skipIf(process.platform !== 'darwin')(`runtime descendant: tool policy and queued reauthorization (alive=${runtimeSurvives})`, async () => {
  const root = mkdtempSync('/tmp/ertd-');
  const oldOwner = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const writes: string[] = [];
  let busy = true;
  const server = await startElsServer({ stateRoot: root, stall: false,
    spawn: () => ({ id: 'fixture', isAlive: () => true, write: s => writes.push(s), renderScreen: async () => busy ? 'Turn running' : 'ready', onExit: () => {}, kill: () => {} }) });
  if ('exitCode' in server) throw new Error(server.message);
  const childFile = join(root, 'child.ts'), runtimeFile = join(root, 'runtime.ts');
  const registration = join(root, 'registration.json'), prose = join(root, 'prose.json'), output = join(root, 'result.json');
  writeFileSync(childFile, `import { requestEls } from ${JSON.stringify(join(import.meta.dir, 'client.ts'))};\nimport { writeFileSync } from 'node:fs';\nconst result = await requestEls(${JSON.stringify(elsSocketPath(root))}, JSON.parse(process.argv[2]));\nwriteFileSync(process.argv[3], JSON.stringify(result));\n`);
  const pane = JSON.parse(server.core.newPane({ ws: 'test', cwd: root, command: ['eln'], ownerSeat: 'OP' }).message).pane;
  writeFileSync(join(root, 'els', 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
  writeFileSync(runtimeFile, `import { writeFileSync } from 'node:fs';\nimport { runShell } from ${JSON.stringify(join(import.meta.dir, '../shell-primitive/runtime.ts'))};\nconst run=async (request,out)=>{const result=await runShell({command:[process.execPath,${JSON.stringify(childFile)},JSON.stringify(request),out],approval:'none'}); if(result.exitCode) writeFileSync(out,JSON.stringify({childExit:result.exitCode}));};\nawait run({op:'seat-set',seat:'OP'},${JSON.stringify(registration)});\nawait run({op:'input-line',pane:${JSON.stringify(pane)},text:'Please inspect this task',from:'fixture'},${JSON.stringify(prose)});\nawait run({op:'input-line',pane:${JSON.stringify(pane)},text:'pwd',from:'fixture'},${JSON.stringify(output)});\nawait new Promise(()=>{});\n`);
  const runtime = Bun.spawn([process.execPath, runtimeFile], { env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'ignore', stderr: 'ignore' });
  let stopped = false;
  try {
    const end = Date.now() + 15000;
    while (!existsSync(output)) { if (Date.now() > end) throw new Error('fixture timeout'); await Bun.sleep(25); }
    expect(JSON.parse(readFileSync(registration, 'utf8')).exitCode).toBe(0);
    const held = JSON.parse(readFileSync(prose, 'utf8'));
    expect(held.exitCode).toBe(1);
    expect(held.message).toContain('agent prose is not supported');
    expect(held.message).toContain('eln msg');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ exitCode: 0, queued: 1 });
    expect(writes).toEqual([]);
    if (!runtimeSurvives) { runtime.kill(); await runtime.exited; stopped = true; }
    busy = false;
    await server.core.drain();
    expect(writes).toEqual(runtimeSurvives ? ['pwd\r'] : []);
  } finally {
    if (!stopped) { runtime.kill(); await runtime.exited; }
    await server.close();
    if (oldOwner === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = oldOwner;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
