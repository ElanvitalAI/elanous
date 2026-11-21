// Real socket peers: the registered runtime survives the one-shot CLI which queued the input.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { elsSocketPath, startElsServer } from './server.js';

async function waitFor(check: () => boolean) {
  const end = Date.now() + 15000;
  while (!check()) { if (Date.now() > end) throw new Error('fixture timeout'); await Bun.sleep(25); }
}

for (const runtimeSurvives of [true, false]) test.skipIf(process.platform !== 'darwin')(`queued input after CLI exit: runtime alive=${runtimeSurvives}`, async () => {
  const root = mkdtempSync('/tmp/eqrt-');
  const ownerBefore = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const writes: string[] = [];
  let busy = true;
  const server = await startElsServer({ stateRoot: root, stall: false,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: (s: string) => writes.push(s), renderScreen: async () => busy ? 'Turn running' : 'ready', onExit: () => {}, kill: () => {} }) });
  if ('exitCode' in server) throw new Error(server.message);
  const runtimeFile = join(root, 'runtime.ts');
  const childFile = join(root, 'child.ts');
  const output = join(root, 'result.json');
  const cliExited = join(root, 'cli-exited');
  const child = `import { requestEls } from ${JSON.stringify(join(import.meta.dir, 'client.ts'))};\nimport { writeFileSync } from 'node:fs';\nawait Bun.sleep(30);\nconst result=await requestEls(${JSON.stringify(elsSocketPath(root))}, JSON.parse(process.argv[2]));\nwriteFileSync(process.argv[3],JSON.stringify(result));\n`;
  writeFileSync(childFile, child);
  const made = server.core.newPane({ ws: 'test', cwd: root, command: ['eln'], ownerSeat: 'OP' });
  writeFileSync(join(root, 'els', 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
  const pane = JSON.parse(made.message).pane;
  const registration = join(root, 'registration.json');
  writeFileSync(runtimeFile, `import { writeFileSync } from 'node:fs';\nimport { runShell } from ${JSON.stringify(join(import.meta.dir, '../shell-primitive/runtime.ts'))};\nconst run=async (request,out)=>{const result=await runShell({command:[process.execPath,${JSON.stringify(childFile)},JSON.stringify(request),out],approval:'none'}); if(result.exitCode) writeFileSync(out,JSON.stringify({childExit:result.exitCode}));};\nawait run({op:'seat-set',seat:'OP'},${JSON.stringify(registration)});\nawait run({op:'input-line',pane:${JSON.stringify(pane)},text:'pwd',from:'test'},${JSON.stringify(output)});\nwriteFileSync(${JSON.stringify(cliExited)}, 'exited');\nawait new Promise(()=>{});\n`);
  const runtime = Bun.spawn([process.execPath, runtimeFile], { env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'ignore', stderr: 'ignore' });
  let runtimeStopped = false;
  try {
    await waitFor(() => existsSync(cliExited));
    expect(JSON.parse(readFileSync(registration, 'utf8')).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ exitCode: 0, queued: 1 });
    expect(writes).toEqual([]);
    if (!runtimeSurvives) { runtime.kill(); await runtime.exited; runtimeStopped = true; }
    busy = false;
    await server.core.drain();
    expect(writes).toEqual(runtimeSurvives ? ['pwd\r'] : []);
    const rows = readFileSync(join(root, 'els', 'control-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.result)).toEqual(runtimeSurvives ? ['executing', 'queued', 'delivering', 'delivered'] : ['executing', 'queued', 'discarded']);
  } finally {
    if (!runtimeStopped) { runtime.kill(); await runtime.exited; }
    await server.close();
    if (ownerBefore === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = ownerBefore;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
