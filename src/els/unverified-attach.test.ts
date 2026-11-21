import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { elsSocketPath, startElsServer } from './server.js';

test('unverifiable non-tty caller cannot attach to a private pane', async () => {
  const root = mkdtempSync('/tmp/els-attach-unverified-');
  const previousOwner = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const server = await startElsServer({ stateRoot: root, stall: false, spawn: () => ({
    id: 'fixture', isAlive: () => true, write: () => {}, renderScreen: async () => 'private-attach-screen', onExit: () => {}, kill: () => {},
  }) });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const pane = JSON.parse(server.core.newPane({ ws: 'test', cwd: root, command: ['sh'], ownerSeat: 'OP' }).message).pane;
    const file = join(root, 'client.ts');
    writeFileSync(file, `import { createConnection } from 'node:net';\nconst s = createConnection(${JSON.stringify(elsSocketPath(root))});\ns.setTimeout(5000, () => { console.error('timeout'); s.destroy(); process.exitCode = 1; });\ns.on('connect', () => s.write(JSON.stringify({op:'attach',pane:${JSON.stringify(pane)},cols:80,rows:24}) + '\\n'));\ns.once('data', data => { console.log(data.toString()); s.destroy(); });\n`);
    const child = Bun.spawn([process.execPath, file], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root } });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    const result = JSON.parse(out.trim().split('\n')[0]!);
    expect(result.exitCode).toBe(1);
    expect(out).not.toContain('private-attach-screen');
  } finally {
    await server.close();
    if (previousOwner === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = previousOwner;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
