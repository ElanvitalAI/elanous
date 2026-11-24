// CEO 11-24 «불필요한 보안 강화 금지»: a same-UID caller with no pane credential and no provable ancestry
// (Claude OP outside els) reads, gets status and sends with no key file; a mid-turn send is queued for the next turn.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { elsSocketPath, startElsServer } from './server.js';

test.skipIf(process.env.ELS_READ_OWNER_TTY === '1' || !!process.stdin.isTTY)('same-UID local operator reads, status and queues a mid-turn send with no key', async () => {
  const root = mkdtempSync('/tmp/els-local-op-');
  const writes: string[] = [];
  let busy = true;
  const server = await startElsServer({ stateRoot: root, stall: false, spawn: () => ({
    id: 'fixture', isAlive: () => true, write: v => { writes.push(v); }, renderScreen: async () => busy ? 'answer in progress\nTurn running' : 'idle screen', onExit: () => {}, kill: () => {},
  }) });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const pane = JSON.parse(server.core.newPane({ ws: 'test', cwd: root, command: ['eln'], ownerSeat: 'OP' }).message).pane;
    const child = join(root, 'op.ts');
    writeFileSync(child, `import { requestEls } from ${JSON.stringify(join(import.meta.dir, 'client.ts'))};\n`
      + `for (const r of [{op:'read',pane:${JSON.stringify(pane)}},{op:'status',pane:${JSON.stringify(pane)}},{op:'send',pane:${JSON.stringify(pane)},text:'next message'},{op:'grep',pane:${JSON.stringify(pane)},pattern:'x'}]) console.log(JSON.stringify(await requestEls(${JSON.stringify(elsSocketPath(root))}, r)));\n`);
    // No key file, no pane token, no owner token: a plain same-UID process.
    const p = Bun.spawn([process.execPath, child], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    const [read, status, send, grep] = out.trim().split('\n').map(line => JSON.parse(line));
    expect(read.exitCode).toBe(0);
    expect(read.message).toContain('answer in progress');
    expect(status.exitCode).toBe(0);
    expect(send.exitCode).toBe(0);
    expect(send.queued).toBe(1);
    // The in-progress answer is untouched: nothing was typed into the busy pane.
    expect(writes).toEqual([]);
    // grep is outside the local operator scope and keeps the old refusal.
    expect(grep.exitCode).toBe(1);
    expect(grep.message).toContain('신원 확인 불가');
    busy = false;
    await server.core.drain();
    expect(writes.join('')).toContain('next message');
    const rows = readFileSync(join(root, 'els', 'local-operator-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => `${row.op}:${row.result}`)).toContain('read:allowed');
    expect(rows.map(row => `${row.op}:${row.result}`)).toContain('status:allowed');
    expect(rows.map(row => `${row.op}:${row.result}`)).toContain('send:queued');
    expect(rows.every(row => row.uid === process.getuid!())).toBe(true);
    expect(rows.find(row => row.op === 'send').chars).toBe(12);
    expect(JSON.stringify(rows)).not.toContain('next message');
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
}, 60000);
