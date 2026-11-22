import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { MsgStore } from '../msg/msg-store.js';
import { scriptCommandPolicy } from '../skills/tools/run-shell-script.js';

const entry = `import { Command } from 'commander'; import { registerMsgCommands } from './src/cli/msg-cli.ts'; const cli = new Command(); registerMsgCommands(cli); await cli.parseAsync(process.argv.slice(1), {from:'user'});`;
test('count is body-free, read-only and distinguishes zero, unread and unavailable ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-count-prb-'));
  const path = join(dir, 'msg', 'messages.db');
  const run = () => spawnSync('bun', ['-e', entry, 'msg', 'count', '--to', 'OP', '--json'], { cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' });
  try {
    let result = run();
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ status: 'unknown', count: null });
    expect(existsSync(path)).toBe(false);
    const store = new MsgStore(path);
    mkdirSync(join(dir, 'seat-state'), { recursive: true });
    writeFileSync(join(dir, 'seat-state', 'seat-registry.json'), JSON.stringify({ version: 1, seats: [] }));
    result = run(); expect(JSON.parse(result.stdout)).toEqual({ status: 'unknown', count: null });
    writeFileSync(join(dir, 'seat-state', 'seat-registry.json'), JSON.stringify({ version: 1, seats: [{ address: 'OP', host: 'local', wake: 'none', replyBody: 'agent', optIn: false }] }));
    result = run(); expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', count: 0 });
    store.post({from:'TC', to:'OP', body:'secret-body-do-not-display'});
    store.close();
    result = run(); expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', count: 1 });
    expect(result.stdout).not.toContain('secret-body');
    const ack = new MsgStore(path); expect(ack.getCursor('OP')).toBe(0); ack.ack('OP', 1); ack.close();
    result = run(); expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', count: 0 });
    const invalid = spawnSync('bun', ['-e', entry, 'msg', 'count', '--to', 'ALL'], { cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' });
    expect(invalid.status).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('count matches unread semantics for broadcasts, groups, expiration and individual acknowledgements', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-count-semantics-'));
  const path = join(dir, 'msg', 'messages.db');
  try {
    const store = new MsgStore(path);
    mkdirSync(join(dir, 'seat-state'), { recursive: true });
    writeFileSync(join(dir, 'seat-state', 'seat-registry.json'), JSON.stringify({ version: 2, seats: [{ address: 'OP', host: 'local', runtime: 'eln', delivery: 'queue', replyBody: 'agent', optIn: false }] }));
    store.createGroup('team', 'OP');
    store.post({ from: 'TC', to: 'OP', body: 'direct' });
    store.post({ from: 'TC', to: 'ALL', body: 'broadcast' });
    store.post({ from: 'OP', to: 'ALL', body: 'own broadcast' });
    store.post({ from: 'TC', to: 'group:team', body: 'group' });
    store.post({ from: 'TC', to: 'OP', body: 'expired', expiresAt: '2000-01-01T00:00:00Z' });
    const acked = store.post({ from: 'TC', to: 'OP', body: 'acked' });
    store.ackMessage('OP', acked.id);
    expect(store.unreadCount('OP')).toBe(3);
    store.close();
    const result = spawnSync('bun', ['-e', entry, 'msg', 'count', '--to', 'OP', '--json'], { cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'ok', count: 3 });
    const after = new MsgStore(path, { readOnly: true });
    expect(after.getCursor('OP')).toBe(0);
    expect(after.unreadCount('OP')).toBe(3);
    after.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('count does not misreport corrupt ledger as zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-count-corrupt-'));
  try {
    mkdirSync(join(dir,'msg')); writeFileSync(join(dir,'msg','messages.db'), 'not sqlite');
    mkdirSync(join(dir, 'seat-state'), { recursive: true });
    writeFileSync(join(dir, 'seat-state', 'seat-registry.json'), JSON.stringify({ version: 1, seats: [{ address: 'OP', host: 'local', wake: 'none', replyBody: 'agent', optIn: false }] }));
    const result = spawnSync('bun', ['-e', entry, 'msg', 'count', '--to', 'OP', '--json'], { cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: dir }, encoding: 'utf8' });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ status: 'unknown', count: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('only the exact body-free count argv becomes read-local', () => {
  expect(scriptCommandPolicy(['eln','msg','count','--to','OP'])).toBe('approval');
  expect(scriptCommandPolicy(['eln','msg','count','--to','OP','--json'])).toBe('read-local');
  for (const argv of [['eln','msg','count'], ['eln','msg','count','--to','MK','--json'], ['eln','msg','count','--to','OP','--json','--extra'], ['eln','msg','unread','--to','OP'], ['eln','msg','list','--to','OP']]) expect(scriptCommandPolicy(argv)).toBe('approval');
});
