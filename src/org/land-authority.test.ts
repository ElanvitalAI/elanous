// JUD-SPLIT-FU-CONSUMERS — landing vs veto consumers follow the org map across move · rollback · missing map.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerOrgCommands } from '../cli/org-cli.js';
import { evaluateLandVetoes, landRefusalRecipient, landingOwner, maySetVeto, mayRunLandOps, vetoOwner, disputeRecipient } from './land-authority.js';
import { liveStewardRequests } from '../resource-opt/steward-live.js';

const world = (seed: number) => {
  const root = mkdtempSync(join(tmpdir(), `land-auth-${seed}-`));
  mkdirSync(join(root, '.elanous'), { recursive: true });
  writeFileSync(join(root, '.elanous', 'federation.yaml'), 'version: 1\n');
  const deps = { cwd: root, home: join(root, 'home') };
  const program = new Command().exitOverride();
  let code = 0;
  registerOrgCommands(program, {
    cwd: () => root, home: () => join(root, 'home'), stateRoot: () => join(root, 'state'),
    post: () => 1, openDutyMail: () => [], out: () => {}, err: () => {}, setExitCode: c => { code = c; },
  });
  const run = async (...a: string[]) => { code = 0; await program.parseAsync(['node', 'eln', ...a]); return code; };
  const judgeMail = () => { const sent: string[] = []; const requestJudge = liveStewardRequests(m => sent.push(m.to), 'OP', deps).requestJudge; if (!requestJudge) throw new Error('requestJudge missing'); requestJudge({ cell: `C${seed}`, pr: seed, ageMin: 7 } as never); return sent; };
  return { root, deps, run, judgeMail };
};

const check = (w: ReturnType<typeof world>, landing: string) => {
  // (a) refusal mail → landing owner
  expect(landingOwner(w.deps)).toBe(landing);
  expect(landRefusalRecipient(w.deps)).toBe(landing);
  expect(mayRunLandOps(landing, w.deps)).toBe(true);
  expect(mayRunLandOps('MK', w.deps)).toBe(false);
  // (b) HOLD by the veto owner blocks — whoever owns landing
  expect(vetoOwner(w.deps)).toBe('JUD');
  expect(disputeRecipient(w.deps)).toBe('JUD');
  expect(maySetVeto('JUD', w.deps)).toBe(true);
  expect(evaluateLandVetoes([{ seat: 'JUD', kind: 'hold' }], w.deps).blocked).toBe(true);
  expect(evaluateLandVetoes([{ seat: 'jud', kind: 'security-veto' }], w.deps).blocked).toBe(true);
  // (c) HOLD by a non-veto seat (incl. the landing owner) is ignored
  expect(maySetVeto(landing === 'JUD' ? 'TC' : landing, w.deps)).toBe(false);
  const r = evaluateLandVetoes([{ seat: 'TC', kind: 'hold' }, { seat: 'OP', kind: 'no-go' }], w.deps);
  expect(r.blocked).toBe(false);
  expect(r.ignored.map(m => m.seat)).toEqual(['TC', 'OP']);
  // judge requests follow the veto owner
  expect(w.judgeMail()).toEqual(['JUD']);
};

describe('land authority follows the org map (seeds 1..3)', () => {
  for (const seed of [1, 2, 3]) test(`seed ${seed}: default → move landing TC → rollback`, async () => {
    const w = world(seed);
    check(w, 'JUD');
    expect(await w.run('org', 'move', 'landing', '--to', 'TC')).toBe(0);
    check(w, 'TC');
    // (d) rollback restores routing
    expect(await w.run('org', 'rollback')).toBe(0);
    check(w, 'JUD');
  });

  test('(e) fallback: no map and unreadable map keep today (JUD)', () => {
    const none = mkdtempSync(join(tmpdir(), 'land-auth-none-'));
    expect(landingOwner({ cwd: none, home: none })).toBe('JUD');
    expect(vetoOwner({ cwd: none, home: none })).toBe('JUD');
    const bad = mkdtempSync(join(tmpdir(), 'land-auth-bad-'));
    mkdirSync(join(bad, '.elanous'), { recursive: true });
    writeFileSync(join(bad, '.elanous', 'federation.yaml'), 'version: 1\norg: [ : : broken\n');
    expect(landRefusalRecipient({ cwd: bad, home: join(bad, 'home') })).toBe('JUD');
    expect(evaluateLandVetoes([{ seat: 'JUD', kind: 'hold' }], { cwd: bad, home: join(bad, 'home') }).blocked).toBe(true);
    expect(evaluateLandVetoes([{ seat: 'TC', kind: 'hold' }], { cwd: bad, home: join(bad, 'home') }).blocked).toBe(false);
  });
});
