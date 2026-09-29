import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerLoopCommands } from './loop-cli.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryCrontab, listSchedules, openSchedulesDb } from '../domains/schedule-registry.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { listLoops, loopStatus, runLoop, setLoopEnabled, type LoopRegistryOptions } from './registry.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'loops-registry-'));
  dirs.push(root);
  const stateRoot = join(root, 'state');
  mkdirSync(join(root, 'graphs', 'daily'), { recursive: true });
  const body = (id: string, header = '') => `graph_id: ${id}\nversion: 1\n${header}entry_node: step\nterminal_nodes: [done]\nnodes:\n  - { node_id: step, kind: agent, recipe: 'cmd:step', max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: step, to: done }\n`;
  const cronFile = join(root, 'graphs', 'daily', 'cron.yaml');
  writeFileSync(cronFile, body('daily', "loop:\n  title: Daily\n  trigger:\n    cron: '0 7 * * *'\n"));
  writeFileSync(join(root, 'graphs', 'event.yaml'), body('event', 'loop:\n  trigger:\n    events: [manual]\n'));
  writeFileSync(join(root, 'graphs', 'plain.yaml'), body('plain'));
  writeFileSync(join(root, 'graphs', 'daily', 'recipes.yaml'), 'step:\n  command: "printf ok"\n');
  const db = openSchedulesDb(join(root, 'schedules.db'));
  const line = '0 7 * * * cd ' + root + ' && bun bin/elanous.mjs graph run graphs/daily/cron.yaml';
  inventoryCrontab(db, { crontab: line + '\n' });
  const rows = listSchedules(db);
  db.close();
  const opts: LoopRegistryOptions = { root, stateRoot, now: new Date('2026-09-28T06:30:00.000Z'), schedules: rows };
  return { root, stateRoot, cronFile, line, opts };
}

test('list joins graph and cron by path, excludes untriggered graph, exposes next and last run', () => {
  const f = fixture();
  mkdirSync(join(f.stateRoot, 'graph-runs', 'daily'), { recursive: true });
  const path = join(f.stateRoot, 'graph-runs', 'daily', 'run-1.json');
  writeFileSync(path, JSON.stringify({ graphId: 'daily', runId: 'run-1', startedAt: '2026-09-27T00:00:00Z', finishedAt: '2026-09-27T00:00:05Z', status: 'failed', nodes: [{ nodeId: 'step', ok: false }], path: ['step'] }));
  const list = listLoops(f.opts);
  expect(list.map(l => l.id)).toEqual(['daily', 'event']);
  expect(list[0]).toMatchObject({ title: 'Daily', enabled: true, nextRun: expect.any(String),
    trigger: { cron: '0 7 * * *' }, lastRun: { status: 'failed', at: '2026-09-27T00:00:00Z', path, durationMs: 5000 } });
  expect(list[1]).toMatchObject({ enabled: false, nextRun: null, trigger: { events: ['manual'] } });
  expect(loopStatus('daily', f.opts).recentRuns[0]?.failedNodes).toEqual(['step']);
  expect(() => loopStatus('plain', f.opts)).toThrow('loop not found');
});

test('start plans absent cron, --yes registers; stop disables and start restores without deletion', async () => {
  const f = fixture();
  let line = '';
  const db = openSchedulesDb(join(f.root, 'fake.db'));
  const opts: LoopRegistryOptions = { ...f.opts, schedules: [], scheduleAction: async (action, args) => {
    if (action === 'create') line = `${args.cron} ${args.command}`;
    else if (action === 'disable') line = `# ${line}`;
    else line = line.replace(/^# /, '');
    inventoryCrontab(db, { crontab: line + '\n' });
    opts.schedules = listSchedules(db);
    return { changed: true };
  } };
  try {
    expect(await setLoopEnabled('daily', true, false, opts)).toMatchObject({ dryRun: true, changes: [{ action: 'create', cron: '0 7 * * *' }] });
    expect(line).toBe('');
    expect(await setLoopEnabled('daily', true, true, opts)).toMatchObject({ changed: true });
    expect(listLoops(opts).find(l => l.id === 'daily')?.enabled).toBe(true);
    expect(await setLoopEnabled('daily', false, false, opts)).toMatchObject({ dryRun: true, changes: [{ action: 'disable' }] });
    expect(await setLoopEnabled('daily', false, true, opts)).toMatchObject({ changed: true });
    expect(line.startsWith('# ')).toBe(true);
    expect(listLoops(opts).find(l => l.id === 'daily')?.enabled).toBe(false);
    expect(await setLoopEnabled('daily', true, false, opts)).toMatchObject({ dryRun: true, changes: [{ action: 'enable' }] });
    expect(line.startsWith('# ')).toBe(true);
    expect(await setLoopEnabled('daily', true, true, opts)).toMatchObject({ changed: true });
    expect(line.startsWith('# ')).toBe(false);
    expect(listLoops(opts).find(l => l.id === 'daily')?.enabled).toBe(true);
    await expect(setLoopEnabled('event', true, false, opts)).rejects.toThrow('no cron job');
  } finally { db.close(); }
});

test('loop run delegates to graph runner and records duration for dry-run', async () => {
  const f = fixture();
  const state = await runLoop('daily', true, f.opts);
  expect(state).toMatchObject({ graphId: 'daily', status: 'done', dryRun: true, executed: 0 });
  const stored = JSON.parse(readFileSync(state.statePath, 'utf8'));
  expect(stored.startedAt).toEqual(expect.any(String));
  expect(stored.finishedAt).toEqual(expect.any(String));
  expect(loopStatus('daily', f.opts).recentRuns[0]?.durationMs).toBeGreaterThanOrEqual(0);
});

test('loop CLI exposes the five lifecycle actions with safe mutation flags', () => {
  const program = new Command();
  registerLoopCommands(program);
  const loop = program.commands.find(c => c.name() === 'loop');
  expect(loop?.commands.map(c => c.name())).toEqual(['list', 'status', 'start', 'stop', 'run']);
  expect(loop?.commands.find(c => c.name() === 'start')?.options.map(o => o.long)).toContain('--yes');
  expect(loop?.commands.find(c => c.name() === 'stop')?.options.map(o => o.long)).toContain('--yes');
  expect(loop?.commands.find(c => c.name() === 'run')?.options.map(o => o.long)).toContain('--dry-run');
});

test('graph parser retains loop header and rejects invalid trigger', () => {
  const f = fixture();
  const source = readFileSync(f.cronFile, 'utf8');
  expect(parseGraphTemplateYaml(source).template?.loop?.trigger?.cron).toBe('0 7 * * *');
  expect(parseGraphTemplateYaml(source.replace("cron: '0 7 * * *'", 'cron: 7')).errors.some(e => e.path.endsWith('/loop/trigger/cron'))).toBe(true);
});
