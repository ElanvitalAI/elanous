import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElsCore, type ElsPty } from './core.js';
import { createControl } from './control.js';
import { createHash } from 'node:crypto';
import { emptyJournal } from './space.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'els-queue-'));
  const rows: any[] = []; const writes: string[] = [];
  let busy = true, alive = true, clock = 0, failWrite = false, failIntent = false, failQueued = false;
  let onExit = () => {};
  const pty: ElsPty = { id: 'pty', isAlive: () => alive,
    write: (s) => { if (failWrite) throw new Error('write failed'); writes.push(s); },
    renderScreen: async () => busy ? 'Turn running' : 'ready',
    onExit: (cb) => { onExit = cb; }, kill: () => {} };
  const core = createElsCore({ load: emptyJournal, save: () => {}, spawn: () => pty, now: () => clock });
  core.start();
  const pane = JSON.parse(core.newPane({ ws: 'test', cwd: '/', command: ['eln'] }).message).pane as string;
  writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'local:1', seat: 'OP', workspace: '*', pane: '*', actions: ['input'] }] }));
  const door = createControl({ stateDir: dir, appendAudit: (_path, line) => {
    const row = JSON.parse(line); if ((failIntent && row.result === 'delivering') || (failQueued && row.result === 'queued')) throw new Error('audit down'); rows.push(row);
  }, execute: (input) => core.inputLine(input.target.pane, input.text ?? '', 'OP', input.queueAudit) });
  const send = (text: string) => door.run({ principal: { id: 'local:1', kind: 'cli', callerPane: 'w1:p2', callerSeat: 'OP' }, action: 'input', target: { workspace: 'w', pane, shell: false }, text, from: 'OP' });
  return { core, pane, writes, rows, send, idle: () => { busy = false; }, tick: () => { clock += 2500; },
    exit: () => { alive = false; onExit(); }, failWrite: () => { failWrite = true; }, failIntent: () => { failIntent = true; }, failQueued: () => { failQueued = true; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('queued inputs are FIFO ahead of ordinary lines and lifecycle audits correlate without plaintext', async () => {
  const f = await fixture();
  try {
    await f.core.do(f.pane, 'ordinary1', 'test');
    await f.send('priority1'); await f.send('priority2');
    await f.core.do(f.pane, 'ordinary2', 'test');
    expect(f.writes).toEqual([]); await f.core.drain(); expect(f.writes).toEqual([]);
    f.idle();
    for (let i = 0; i < 4; i++) { await f.core.drain(); f.tick(); }
    expect(f.writes).toEqual(['priority1\r', 'priority2\r', '⇢ test · ordinary1\r', '⇢ test · ordinary2\r']);
    const ids = [...new Set(f.rows.map((r) => r.requestId))]; expect(ids).toHaveLength(2);
    for (const id of ids) expect(f.rows.filter((r) => r.requestId === id).map((r) => r.result)).toEqual(['executing', 'queued', 'delivering', 'delivered']);
    expect(JSON.stringify(f.rows)).not.toContain('priority1');
  } finally { f.cleanup(); }
});

test('audit hashes the normalized line actually delivered, including queued lifecycle', async () => {
  const f = await fixture();
  try {
    const outcome = await f.send('  alpha\n\u001b  beta  ');
    expect(outcome.ok && outcome.exitCode).toBe(0);
    f.idle(); await f.core.drain();
    expect(f.writes).toEqual(['alpha beta\r']);
    const digest = createHash('sha256').update('alpha beta').digest('hex');
    expect(f.rows.map(row => row.result)).toEqual(['executing', 'queued', 'delivering', 'delivered']);
    for (const row of f.rows) { expect(row.sha256).toBe(digest); expect(row.chars).toBe(10); }
  } finally { f.cleanup(); }
});

test('queued audit failure never publishes or delivers the line', async () => {
  const f = await fixture();
  try {
    f.failQueued();
    const outcome = await f.send('sensitive');
    expect(outcome.ok && outcome.exitCode).toBe(1);
    expect(f.core.queued(f.pane)).toBe(0);
    f.idle(); await f.core.drain();
    expect(f.writes).toEqual([]);
    expect(f.rows.map((r) => r.result)).toEqual(['executing', 'executor-refused']);
  } finally { f.cleanup(); }
});

test('queued write failure, pane exit, close, shutdown and audit-intent failure are distinguished', async () => {
  for (const how of ['write', 'exit', 'close', 'shutdown', 'audit'] as const) {
    const f = await fixture();
    try {
      await f.send('sensitive');
      if (how === 'exit') f.exit();
      if (how === 'close') f.core.close(f.pane);
      if (how === 'shutdown') f.core.stopAll();
      if (how === 'write' || how === 'audit') {
        if (how === 'write') f.failWrite(); else f.failIntent();
        f.idle(); await f.core.drain();
      }
      expect(f.writes).toEqual([]);
      expect(f.rows.map((r) => r.result)).toEqual(how === 'write' ? ['executing', 'queued', 'delivering', 'delivery-failed'] : ['executing', 'queued', 'discarded']);
    } finally { f.cleanup(); }
  }
});
