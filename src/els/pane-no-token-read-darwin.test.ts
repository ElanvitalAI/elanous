import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { elsSocketPath, startElsServer } from './server.js';

test.skipIf(process.platform !== 'darwin').each(['read', 'status', 'grep'] as const)('pane process without credential cannot %s another pane', async (op) => {
  const root = mkdtempSync('/tmp/els-pane-no-token-');
  const oldOwner = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const childFile = join(root, 'child.ts'), input = join(root, 'input'), output = join(root, 'output');
  writeFileSync(childFile, `import { createConnection } from 'node:net'; import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nwhile (!existsSync(${JSON.stringify(input)})) await Bun.sleep(20);\nconst s=createConnection(${JSON.stringify(elsSocketPath(root))}); let text=''; s.on('connect',()=>s.write(readFileSync(${JSON.stringify(input)},'utf8')+'\\n')); s.on('data',c=>text+=c); s.on('end',()=>writeFileSync(${JSON.stringify(output)}, text));\n`);
  const child = Bun.spawn([process.execPath, childFile], { stdout: 'ignore', stderr: 'ignore' });
  let count = 0;
  const server = await startElsServer({ stateRoot: root, stall: false, spawn: () => {
    const id = ++count;
    return { id: `fixture-${id}`, ...(id === 1 ? { pid: child.pid } : {}), isAlive: () => true, write: () => {}, renderScreen: async () => `private-screen-${id}`, onExit: () => {}, kill: () => {} };
  } });
  if ('exitCode' in server) { child.kill(); throw new Error(server.message); }
  try {
    server.core.newPane({ ws: 'test', cwd: root, command: ['fixture'], ownerSeat: 'HAND-A' });
    const other = JSON.parse(server.core.newPane({ ws: 'test', cwd: root, command: ['fixture'], ownerSeat: 'HAND-B' }).message).pane;
    writeFileSync(input, JSON.stringify(op === 'grep' ? { op, pattern: 'private-screen-2' } : { op, pane: other }));
    const end = Date.now() + 10000;
    while (!existsSync(output)) { if (Date.now() > end) throw new Error('child timeout'); await Bun.sleep(25); }
    const result = JSON.parse(readFileSync(output, 'utf8'));
    expect(result.exitCode).toBe(1);
    expect(result.message).not.toContain('private-screen-2');
  } finally {
    child.kill(); await child.exited; await server.close();
    if (oldOwner === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = oldOwner;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
