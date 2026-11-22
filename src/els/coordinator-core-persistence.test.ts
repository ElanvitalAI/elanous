import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElsCore, type ElsPty } from './core.js';
import { loadJournal, saveJournal } from './journal.js';

function fixture(path: string) {
  let failSave = false;
  let sequence = 0;
  const core = createElsCore({
    load: () => loadJournal(path),
    save: journal => { if (failSave) throw new Error('disk full'); saveJournal(path, journal); },
    mailBadges: () => new Map(),
    spawn: () => ({ id: `pty-${++sequence}`, isAlive: () => true, write: () => {},
      renderScreen: async () => '', onExit: () => {}, kill: () => {} } as ElsPty),
  });
  return { core, fail: (value: boolean) => { failSave = value; } };
}

function listed(core: ReturnType<typeof fixture>['core']) {
  return JSON.parse(core.list().message) as { workspaces: { id: string; name: string; role?: string }[] };
}
function coordinator(core: ReturnType<typeof fixture>['core']) {
  return listed(core).workspaces.filter(ws => ws.role === 'coordinator').map(ws => ws.name);
}

test('default OP is read-only; two assignments survive disk reload and restart; closing the assigned workspace restores default', () => {
  const dir = mkdtempSync('/tmp/els-coordinator-core-');
  const path = join(dir, 'journal.json');
  try {
    const first = fixture(path).core;
    expect(first.start()).toBeUndefined();
    for (const ws of ['alpha', 'OP', 'beta']) {
      expect(first.newPane({ ws, cwd: '/work', command: ['sh'] }).exitCode).toBe(0);
    }
    const beforeList = readFileSync(path, 'utf8');
    expect(coordinator(first)).toEqual(['OP']);
    expect(listed(first).workspaces[0]!.name).toBe('OP');
    expect(readFileSync(path, 'utf8')).toBe(beforeList);
    expect(loadJournal(path).workspaces.every(ws => ws.role === undefined)).toBe(true);

    const opId = listed(first).workspaces.find(ws => ws.name === 'OP')!.id;
    const alphaId = listed(first).workspaces.find(ws => ws.name === 'alpha')!.id;
    expect(first.setCoordinator('alpha', 123).exitCode).toBe(0);
    expect(loadJournal(path).coordinatorAudit).toEqual([expect.objectContaining({ op: 'coordinator', peerPid: 123, result: `els ws coordinator: ${opId} -> ${alphaId}` })]);
    expect(coordinator(first)).toEqual(['alpha']);
    const betaId = listed(first).workspaces.find(ws => ws.name === 'beta')!.id;
    expect(first.setCoordinator(betaId).exitCode).toBe(0);
    expect(coordinator(first)).toEqual(['beta']);
    expect(loadJournal(path).workspaces.filter(ws => ws.role === 'coordinator').map(ws => ws.name)).toEqual(['beta']);

    const restarted = fixture(path).core;
    expect(restarted.start()).toBeUndefined();
    expect(coordinator(restarted)).toEqual(['beta']);
    expect(loadJournal(path).coordinatorAudit?.map(row => row.op)).toEqual(['coordinator', 'coordinator']);
    expect(listed(restarted).workspaces[0]!.name).toBe('beta');
    expect(restarted.closeWorkspace('beta').exitCode).toBe(0);
    expect(coordinator(restarted)).toEqual(['OP']);
    expect(loadJournal(path).workspaces.every(ws => ws.role === undefined)).toBe(true);
    const again = fixture(path).core;
    expect(again.start()).toBeUndefined();
    expect(coordinator(again)).toEqual(['OP']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown targets and failed saves preserve both in-memory and on-disk assignment', () => {
  const dir = mkdtempSync('/tmp/els-coordinator-failure-');
  const path = join(dir, 'journal.json');
  try {
    const f = fixture(path);
    expect(f.core.start()).toBeUndefined();
    for (const ws of ['OP', 'alpha', 'beta']) {
      expect(f.core.newPane({ ws, cwd: '/work', command: ['sh'] }).exitCode).toBe(0);
    }
    expect(f.core.setCoordinator('alpha').exitCode).toBe(0);
    const auditBefore = loadJournal(path).coordinatorAudit;
    expect(auditBefore).toHaveLength(1);
    const opId = listed(f.core).workspaces.find(ws => ws.name === 'OP')!.id;
    expect(auditBefore![0]!.result).toContain(`${opId} ->`);
    const before = readFileSync(path, 'utf8');
    expect(f.core.setCoordinator('missing').exitCode).toBe(1);
    expect(f.core.setCoordinator(' ').exitCode).toBe(2);
    f.fail(true);
    expect(f.core.setCoordinator('beta').exitCode).toBe(1);
    expect(coordinator(f.core)).toEqual(['alpha']);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(loadJournal(path).coordinatorAudit).toEqual(auditBefore);
    const restarted = fixture(path).core;
    expect(restarted.start()).toBeUndefined();
    expect(coordinator(restarted)).toEqual(['alpha']);
    expect(loadJournal(path).coordinatorAudit).toEqual(auditBefore);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restart refuses duplicate coordinator roles without overwriting the journal', () => {
  const dir = mkdtempSync('/tmp/els-coordinator-corrupt-');
  const path = join(dir, 'journal.json');
  try {
    const ws = (id: string) => ({ id, name: id, rootCwd: '/work', purpose: '', host: 'local', role: 'coordinator' });
    const contents = JSON.stringify({ version: 1, workspaces: [ws('a'), ws('b')], tabs: [], panes: [] });
    writeFileSync(path, contents);
    const result = fixture(path).core.start();
    expect(result?.exitCode).toBe(1);
    expect(result?.message).toContain('multiple coordinators');
    expect(readFileSync(path, 'utf8')).toBe(contents);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
