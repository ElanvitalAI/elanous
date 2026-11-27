// The trigger tick runs from cron (PATH=/usr/bin:/bin · cwd = the installed package · no ELANOUS_STATE_DIR). A node that spawns
// a bare `eln` there reads null and fails every write (release-traffic 11-27 22:21). These tests run the REAL release-traffic
// reader in that environment.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { elnArgv, liveTrafficDeps, runTrafficNode } from '../res-graphs/release-traffic.js';
import { elanousCliArgv, installedBin } from './cli-bin.js';
import { effectiveInstanceRoot } from './resolve.js';

const saved = { path: process.env.PATH, cwd: process.cwd(), state: process.env.ELANOUS_STATE_DIR, eln: process.env.ELANOUS_TRAFFIC_ELN, nodeEnv: process.env.NODE_ENV };
afterEach(() => {
  process.env.PATH = saved.path; process.chdir(saved.cwd);
  if (saved.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = saved.state;
  if (saved.eln === undefined) delete process.env.ELANOUS_TRAFFIC_ELN; else process.env.ELANOUS_TRAFFIC_ELN = saved.eln;
  if (saved.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.nodeEnv;
});
/** cron: PATH without any elanous bin · cwd somewhere that is not the HQ · no state stamp. */
function cronLike(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cron-cwd-'));
  process.env.PATH = '/usr/bin:/bin'; process.chdir(dir); delete process.env.ELANOUS_TRAFFIC_ELN; delete process.env.NODE_ENV; // cron has no NODE_ENV
  return dir;
}

describe('cli-bin — a node never spawns a bare eln (cron PATH)', () => {
  test('the CLI argv is absolute: this runtime\'s bun ⊕ bin/elanous.mjs', () => {
    const argv = elanousCliArgv();
    expect(argv.length).toBe(2);
    expect(argv.every(isAbsolute)).toBe(true);
    expect(argv[1]!.endsWith(join('bin', 'elanous.mjs'))).toBe(true);
    expect(existsSync(argv[1]!)).toBe(true);
    expect(isAbsolute(installedBin('els')) || installedBin('els') === 'els').toBe(true);
  });
  test('release-traffic: with no override its eln is that absolute CLI (not «eln»)', () => {
    cronLike();
    expect(elnArgv()).toEqual(elanousCliArgv());
  });
  test('release-traffic reads a real pregate slot under cron PATH from a non-HQ cwd', () => {
    // one stamped universe for this test and the CLI child it spawns (the child inherits the stamp, not PATH/cwd)
    const stamp = mkdtempSync(join(tmpdir(), 'cron-state-'));
    process.env.ELANOUS_STATE_DIR = stamp;
    writeFileSync(join(stamp, 'config.json'), JSON.stringify({ res: { policy: { pregateSlots: { simhost: 3 } } } }));
    const dir = cronLike();
    const deps = liveTrafficDeps({ live: false, root: dir, stateRoot: dir, seatState: dir });
    expect(deps.getSlots('simhost')).toBe(3);
  });
  test('the node resolves its state root canonically (never cwd) and a fail names it', () => {
    const dir = cronLike(); delete process.env.ELANOUS_STATE_DIR;
    const out = runTrafficNode({ input: { stage: 'shadow', shadowDir: join(dir, 'shadow') } }, {
      root: join(dir, 'shadow'), live: false, now: () => new Date('2026-11-27T13:21:58Z'),
      facts: () => ({}) as never, getSlots: () => null, setSlots: () => false, hostUp: () => true, requestCapacity: () => 'ok', updateAll: () => true, card: () => {}, owner: () => 'OP',
    } as never);
    expect(out.stateRoot).toBe(effectiveInstanceRoot());
    expect(out.stateRoot).not.toBe(dir);
  });
});
