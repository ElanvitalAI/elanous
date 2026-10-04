import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { registerClaimsCommands } from './claims-cli.js';
import { ClaimsLedger } from '../claims/claims-ledger.js';

const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'claims-cli-')));

test('Commander add/verify/list --json round-trip, filters, show and explicit identity', () => {
  const stateDir = root();
  const lines: string[] = [];
  const program = new Command();
  const now = new Date('2026-10-04T00:00:00Z');
  registerClaimsCommands(program, { stateDir, now: () => now }, { log: line => lines.push(line) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['claims', ...args], { from: 'user' }); return lines[0]!; };
  const before = process.env.AI_AGENT;
  try {
    delete process.env.AI_AGENT;
    expect(run('add', 'C1', '--claim', 'Measured claim.', '--audience', 'team,personal', '--owner', 'MK', '--contrast', 'Faster')).toContain('C1 · draft');
    run('verify', 'C1', '--value', '42', '--command', 'measure', '--valid-until', '+1d');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    run('verify', 'C1', '--value', '42', '--command', 'measure', '--valid-until', '+1d', '--source', 'https://example.com/proof', '--by', 'TC');
    expect(JSON.parse(run('list', '--json'))).toMatchObject([{ id: 'C1', status: 'verified', audience: 'team,personal' }]);
    expect(JSON.parse(run('list', '--status', 'verified', '--audience', 'personal', '--json'))).toHaveLength(1);
    expect(JSON.parse(run('list', '--audience', 'enterprise', '--json'))).toEqual([]);
    expect(JSON.parse(run('show', 'C1', '--json'))).toMatchObject({ evidence: [{ value: '42', command: 'measure', source: 'https://example.com/proof', valid_until: '2026-10-05T00:00:00.000Z' }] });
    run('publish', 'C1');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    process.env.AI_AGENT = 'MK';
    expect(run('publish', 'C1')).toContain('C1 · public');
    run('link', 'C1', '--cell', 'CLAIMS1', '--version', '0.2.6');
    expect(JSON.parse(run('show', 'C1', '--json')).links).toMatchObject([{ cell: 'CLAIMS1', version: '0.2.6' }]);
    expect(new ClaimsLedger({ stateDir, now: () => now }).get('C1').status).toBe('public');
    run('verify', 'C1', '--value', 'bad', '--command', 'measure', '--valid-until', 'not-a-date');
    expect(process.exitCode).toBe(1);
  } finally { process.exitCode = 0; if (before === undefined) delete process.env.AI_AGENT; else process.env.AI_AGENT = before; rmSync(stateDir, { recursive: true, force: true }); }
});

test('render and recheck commands expose copy and queued count without posting', () => {
  const stateDir = root();
  const instanceRoot = root();
  const lines: string[] = [];
  const program = new Command();
  let now = new Date('2026-10-04T00:00:00Z');
  registerClaimsCommands(program, { stateDir, instanceRoot, now: () => now }, { log: line => lines.push(line) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['claims', ...args], { from: 'user' }); return lines[0]!; };
  try {
    const store = new ClaimsLedger({ stateDir, now: () => now });
    store.add({ id: 'fresh', claim: '측정 결과.', audience: 'personal', owner: 'MK' });
    store.verify('fresh', { value: '420만+ 줄', command: 'measure', measuredAt: now.toISOString(), validUntil: '2026-10-06T00:00:00Z', by: 'TC' });
    store.publish('fresh', 'MK');
    store.add({ id: 'old', claim: '지난 결과.', audience: 'personal', owner: 'MK' });
    store.verify('old', { value: '1건', command: 'remeasure', measuredAt: now.toISOString(), validUntil: '2026-10-05T00:00:00Z', by: 'TC' });
    store.publish('old', 'MK');
    now = new Date('2026-10-05T00:00:00Z');
    // Rendering surfaces the stale claim and queues its re-measurement in the same act (review follow-up).
    expect(run('render', '--surface', 'deck')).toContain('## 왜 엘라누스인가');
    expect(JSON.parse(run('render', '--surface', 'site', '--audience', 'personal', '--json'))).toMatchObject({ included: ['fresh'], excluded: [{ id: 'old', reason: 'stale' }], rechecks: 0 });
    expect(JSON.parse(run('recheck', '--json'))).toEqual({ count: 0 });
    expect(run('recheck')).toBe('재측 요청 0건');
    expect(readFileSync(join(instanceRoot, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { rmSync(stateDir, { recursive: true, force: true }); rmSync(instanceRoot, { recursive: true, force: true }); }
});

test('real private command registration routes claims in an isolated CLI instance', () => {
  const stateDir = root();
  const configDir = root();
  const run = (...args: string[]) => spawnSync('bun', ['bin/elanous.mjs', '--test', '--config-dir', configDir, 'claims', ...args], {
    cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ELANOUS_STATE_DIR: stateDir, ELANOUS_CONFIG_DIR: undefined, AI_AGENT: 'TC', ELANOUS_SUPPRESS_XDG_WARNING: '1' },
  });
  try {
    const help = run('--help');
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('verify <id>');
    expect(help.stdout).toContain('render');
    expect(help.stdout).toContain('recheck');
    expect(help.stdout).toContain('retract <id>');
    const invalid = run('verify', 'X', '--value', 'v', '--command', 'c', '--valid-until', '2000-01-01T00:00:00Z');
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toBe('claims verify: validUntil must be after measuredAt\n');
    expect(invalid.stderr).not.toContain('function required');
    expect(invalid.stderr).not.toContain('보고 번호');
    const missing = run('verify', 'X', '--value', 'v', '--command', 'c', '--valid-until', '+1d');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe('claims verify: claim not found: X\n');
    const badStatus = run('list', '--status', 'unknown');
    expect(badStatus.status).toBe(1);
    expect(badStatus.stderr).toBe('claims list: invalid status\n');
    const add = run('add', 'C2', '--claim', 'Proof-based.', '--audience', 'enterprise', '--owner', 'MK');
    expect(add.status, add.stderr).toBe(0);
    const duplicateAdd = run('add', 'C2', '--claim', 'Other.', '--audience', 'enterprise', '--owner', 'MK');
    expect(duplicateAdd.status).toBe(1);
    expect(duplicateAdd.stderr).toBe('claims add: claim already exists: C2\n');
    expect(duplicateAdd.stderr).not.toContain('function required');
    expect(duplicateAdd.stderr).not.toContain('보고 번호');
    expect(duplicateAdd.stdout).toBe('');
    const verified = run('verify', 'C2', '--value', '7', '--command', 'echo 7', '--valid-until', '+1d', '--by', 'TC');
    expect(verified.status, verified.stderr).toBe(0);
    const list = run('list', '--json');
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject([{ id: 'C2', status: 'verified' }]);
    const show = run('show', 'C2', '--json');
    expect(show.status, show.stderr).toBe(0);
    expect(JSON.parse(show.stdout).evidence).toMatchObject([{ command: 'echo 7' }]);
    const retracted = run('retract', 'C2', '--reason', '근거보다 넓은 주장', '--by', 'MK');
    expect(retracted.status, retracted.stderr).toBe(0);
    expect(retracted.stdout).toBe('C2 · retracted · Proof-based. · enterprise · MK\n');
    const filtered = run('list', '--status', 'retracted', '--json');
    expect(filtered.status, filtered.stderr).toBe(0);
    expect(JSON.parse(filtered.stdout)).toMatchObject([{ id: 'C2', status: 'retracted' }]);
    const after = run('show', 'C2', '--json');
    expect(JSON.parse(after.stdout).history).toContainEqual(expect.objectContaining({ event: 'retract', by: 'MK', detail: '근거보다 넓은 주장' }));
    const duplicate = run('retract', 'C2', '--reason', 'again', '--by', 'MK');
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toBe('claims retract: claim already retracted: C2\n');
  } finally { rmSync(stateDir, { recursive: true, force: true }); rmSync(configDir, { recursive: true, force: true }); }
}, 180_000);
