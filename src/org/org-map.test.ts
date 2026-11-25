import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { applyOrgChange, DEFAULT_ORG, loadOrgMap, mergeOrg, orgDuty, orgParentOf, validateOrg } from './org-map.js';
import { registerOrgCommands } from '../cli/org-cli.js';
import { loadFederationLadder } from '../msg/hand-raise-ladder.js';

const scratch = (org = '') => {
  const root = mkdtempSync(join(tmpdir(), 'org-map-'));
  mkdirSync(join(root, '.elanous'), { recursive: true });
  writeFileSync(join(root, '.elanous', 'federation.yaml'), `version: 1\n# keep me\n${org}`);
  return root;
};

const cli = (root: string, mail: Record<string, { id: number; body: string }[]> = {}) => {
  const outs: string[] = []; const errs: string[] = []; const posted: { to: string; body: string; refs: string[] }[] = []; let code = 0; let next = 900;
  const program = new Command().exitOverride();
  registerOrgCommands(program, {
    cwd: () => root, home: () => join(root, 'home'), stateRoot: () => join(root, 'state'),
    post: (to, body, refs) => { posted.push({ to, body, refs }); return next++; },
    openDutyMail: (seat, duty) => (mail[`${seat}/${duty}`] ?? []),
    out: l => outs.push(l), err: l => errs.push(l), setExitCode: c => { code = c; },
  });
  return { run: async (...a: string[]) => { code = 0; await program.parseAsync(['node', 'eln', ...a]); return code; }, outs, errs, posted };
};

describe('org map defaults = today', () => {
  test('roles and duties literal', () => {
    expect(DEFAULT_ORG.seats.OP!.role).toBe('coo');
    expect(DEFAULT_ORG.seats.TC!.role).toBe('cto');
    expect(DEFAULT_ORG.seats.MK!.role).toBe('cmo');
    expect(DEFAULT_ORG.seats.UX!.role).toBe('cxo');
    expect(DEFAULT_ORG.duties.board).toBe('OP');
    expect(DEFAULT_ORG.duties['escalation-parent']).toBe('OP');
    expect(DEFAULT_ORG.duties.promotion).toBe('MK');
    expect(DEFAULT_ORG.duties['surface-owner:messenger']).toBe('UX');
    expect(DEFAULT_ORG.duties['surface-contract']).toBe('UX');
    expect(validateOrg(DEFAULT_ORG)).toEqual([]);
    expect(orgParentOf(DEFAULT_ORG, 'TC-ADV')).toBe('TC');
    expect(orgParentOf(DEFAULT_ORG, 'TC')).toBe('OP');
    expect(orgParentOf(DEFAULT_ORG, 'OP')).toBe('CEO');
  });
  test('no federation.yaml → defaults; orgDuty never throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'org-none-'));
    expect(orgDuty('board', { cwd: root, home: root })).toBe('OP');
    expect(loadOrgMap({ cwd: root, home: root }).declared).toBe(false);
  });
  test('bad role / unknown duty are errors', () => {
    expect(mergeOrg({ seats: { X: { role: 'king' } }, duties: { nope: 'OP' } }).errors.length).toBe(2);
  });
});

describe('sim: org changes mid-run', () => {
  test('move board OP→TC · add MK advisor · role change · remove space · invalid refused — no lost cards, ladder consistent', async () => {
    const root = scratch();
    const c = cli(root, { 'OP/board': [{ id: 41, body: 'board card A' }, { id: 42, body: '✋ board B' }] });
    // board move with two open cards
    expect(await c.run('org', 'move', 'board', '--to', 'TC')).toBe(0);
    expect(orgDuty('board', { cwd: root, home: join(root, 'home') })).toBe('TC');
    expect(c.posted.filter(p => p.to === 'TC' && p.refs.includes('forwarded:41')).length).toBe(1);
    expect(c.posted.filter(p => p.to === 'TC' && p.refs.includes('forwarded:42')).length).toBe(1);
    expect(c.posted.filter(p => p.body.startsWith('[org · 정보')).map(p => p.to).sort()).toEqual(['OP', 'TC']);
    const yamlText = readFileSync(join(root, '.elanous', 'federation.yaml'), 'utf8');
    expect(yamlText).toContain('# keep me');
    expect(yamlText).toContain('board: TC');
    const audit = readFileSync(join(root, 'state', 'org', 'audit.jsonl'), 'utf8').trim().split('\n');
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0]!).from).toBe('OP');
    // MK advisor
    expect(await c.run('org', 'add-space', 'mk-adv', '--leader', 'MK', '--advisor', 'MK-ADV')).toBe(0);
    expect(orgParentOf(loadOrgMap({ cwd: root, home: join(root, 'home') }).org, 'MK-ADV')).toBe('MK');
    // role change OP coo→leader→coo
    const rc = await c.run('org', 'set-role', 'OP', 'leader'); if (rc) throw new Error(c.errs.join('|'));
    expect(await c.run('org', 'set-role', 'OP', 'coo')).toBe(0);
    // invalid: hand cannot hold board; ghost seat; unknown duty
    expect(await c.run('org', 'set-role', 'JUD', 'judge', '--dry-run')).toBe(0);
    expect(await c.run('org', 'move', 'board', '--to', 'JUD')).toBe(1);
    expect(await c.run('org', 'move', 'board', '--to', 'GHOST')).toBe(1);
    expect(await c.run('org', 'move', 'nope', '--to', 'OP')).toBe(1);
    // removing the tc space orphans TC's board duty → refused; removing judge space orphans landing → refused
    expect(await c.run('org', 'remove-space', 'tc')).toBe(1);
    expect(await c.run('org', 'remove-space', 'judge')).toBe(1);
    // move landing away first, then judge space can go
    expect(await c.run('org', 'move', 'landing', '--to', 'OP')).toBe(0);
    expect(await c.run('org', 'remove-space', 'judge')).toBe(0);
    expect(loadOrgMap({ cwd: root, home: join(root, 'home') }).org.spaces.judge).toBeUndefined();
    const final = loadOrgMap({ cwd: root, home: join(root, 'home') }).org;
    expect(validateOrg(final)).toEqual([]);
    expect(c.errs.some(e => e.includes('role judge not allowed'))).toBe(true);
    expect(c.errs.some(e => e.includes('GHOST'))).toBe(true);
  });

  test('kingdom duties (release · resource · landing) move under the CTO; kingdom leaders stay; mail re-pointed', async () => {
    const root = scratch();
    const c = cli(root, { 'REL/release-supervision': [{ id: 7, body: 'release card' }], 'RES/resource-supervision': [{ id: 8, body: '✋ host' }] });
    expect(await c.run('org', 'move', 'release-supervision', '--to', 'TC')).toBe(0);
    expect(await c.run('org', 'move', 'resource-supervision', '--to', 'TC')).toBe(0);
    expect(await c.run('org', 'move', 'landing', '--to', 'TC')).toBe(0);
    const m = loadOrgMap({ cwd: root, home: join(root, 'home') }).org;
    expect([m.duties['release-supervision'], m.duties['resource-supervision'], m.duties.landing]).toEqual(['TC', 'TC', 'TC']);
    expect(c.posted.filter(p => p.to === 'TC' && p.refs.some(r => r === 'forwarded:7' || r === 'forwarded:8')).length).toBe(2);
    expect(c.posted.filter(p => p.body.startsWith('[org · 정보')).map(p => p.to).sort()).toEqual(['JUD', 'REL', 'RES', 'TC', 'TC', 'TC']);
    expect(validateOrg(m)).toEqual([]);
  });

  test('edge matrix: concurrent move refused while lock held · rollback restores · rollback of rollback not repeated', async () => {
    const root = scratch();
    const c = cli(root);
    const lock = join(root, '.elanous', 'federation.yaml.org-lock');
    mkdirSync(lock);
    expect(await c.run('org', 'move', 'board', '--to', 'TC')).toBe(1);
    expect(c.errs.at(-1)).toContain('another org change');
    expect(orgDuty('board', { cwd: root, home: join(root, 'home') })).toBe('OP');
    rmSync(lock, { recursive: true });
    expect(await c.run('org', 'move', 'board', '--to', 'TC')).toBe(0);
    expect(await c.run('org', 'set-role', 'MK', 'leader')).toBe(0);
    expect(await c.run('org', 'rollback')).toBe(0);
    expect(loadOrgMap({ cwd: root, home: join(root, 'home') }).org.seats.MK!.role).toBe('cmo');
    expect(await c.run('org', 'rollback')).toBe(0);
    expect(orgDuty('board', { cwd: root, home: join(root, 'home') })).toBe('OP');
    expect(await c.run('org', 'rollback')).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  test('remove-space then rollback re-adds it with its advisor', async () => {
    const root = scratch();
    const c = cli(root);
    expect(await c.run('org', 'remove-space', 'tc')).toBe(0);
    expect(loadOrgMap({ cwd: root, home: join(root, 'home') }).org.spaces.tc).toBeUndefined();
    expect(await c.run('org', 'rollback')).toBe(0);
    expect(loadOrgMap({ cwd: root, home: join(root, 'home') }).org.spaces.tc).toEqual({ leader: 'TC', advisor: 'TC-ADV' });
  });

  test('advisor added to an existing space hangs under its leader on the live ✋ ladder', () => {
    const root = scratch('org:\n  spaces:\n    mk:\n      leader: MK\n      advisor: MK-ADV\n');
    const ladder = loadFederationLadder({ journalPath: join(root, 'missing.json'), cwd: root, home: root });
    expect(ladder.parentOf('MK-ADV')).toBe('MK');
    expect(ladder.parentOf('MK')).toBe('OP');
    expect(ladder.hq).toBe('OP');
  });

  test('declared escalation-parent moves the ladder root', () => {
    const root = scratch('org:\n  seats:\n    TC:\n      role: cto\n  duties:\n    escalation-parent: TC\n');
    const ladder = loadFederationLadder({ journalPath: join(root, 'missing.json'), cwd: root, home: root });
    expect(ladder.hq).toBe('TC');
    expect(ladder.parentOf('TC')).toBe('CEO');
  });

  test('cycle: advisor that leads its own space is refused', () => {
    const r = applyOrgChange(DEFAULT_ORG, { op: 'add-space', space: 'loop', leader: 'UX', advisor: 'UX' });
    expect(r.errors.some(e => e.includes('cycle'))).toBe(true);
  });

  test('show prints tree, duties, json, status row', async () => {
    const root = scratch();
    const c = cli(root);
    await c.run('org', 'show');
    expect(c.outs[0]).toBe('CEO');
    expect(c.outs[1]).toContain('OP (coo)');
    expect(c.outs.some(l => l.startsWith('surface-owner:mobile') && l.includes('UX'))).toBe(true);
    await c.run('org', 'show', '--json');
    const j = JSON.parse(c.outs.at(-1)!);
    expect(j.duties.brand).toBe('MK');
    expect(j.parents['TC-ADV']).toBe('TC');
    await c.run('org', 'show', '--status-row');
    expect(c.outs.at(-1)!.startsWith('org · 8 seats · 7 spaces · 18 duties · default')).toBe(true);
    expect(existsSync(join(root, 'state'))).toBe(false);
  });
});
