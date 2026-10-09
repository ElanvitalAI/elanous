import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerLoopCommands } from './loop-cli.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';
import { checkLoops } from './checker.js';
import { inventoryCrontab, listSchedules, openSchedulesDb } from '../domains/schedule-registry.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { listAllLoops, listLoops, loopRecentRuns, loopStatus, runLoop, setLoopEnabled, type LoopRegistryOptions } from './registry.js';

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

test('cron shell chooses the newest redirect from outer and inner fence commands, or the newer DB record', () => {
  const f = fixture();
  const now = new Date('2026-10-05T07:30:00Z');
  const at = (name: string, time: string) => {
    const file = join(f.root, name);
    writeFileSync(file, name);
    utimesSync(file, new Date(time), new Date(time));
    return file;
  };
  at('A.json', '2026-10-05T07:29:00Z');
  at('A.err', '2026-10-05T07:24:00Z');
  at('F.log', '2026-10-05T07:20:00Z');
  const lone = at('only.err', '2026-10-05T07:28:00Z');
  const older = at('older.log', '2026-10-05T07:10:00Z');
  const lines = [
    `*/5 * * * * cd ${f.root} && hq-fence cron 'eln loop status --json > A.json 2>> A.err' >> F.log`,
    `*/5 * * * * eln loop status --json 2>>'${lone}'`,
    '*/5 * * * * eln loop status --json > /dev/null 2>&1',
    `*/5 * * * * eln loop status --json 1>> "${older}"`,
    '*/5 * * * * eln loop list --all',
  ];
  const db = openSchedulesDb(join(f.root, 'redirects.db'));
  const observations: Array<{ id: string; targets: number; picked: string }> = [];
  const original = debug.log;
  try {
    inventoryCrontab(db, { crontab: lines.join('\n') + '\n' });
    const rows = listSchedules(db);
    db.run('UPDATE schedule_registry SET last_run = ? WHERE id = ?',
      ['2026-10-05T07:15:00Z', rows.find(row => row.command?.includes('/dev/null'))!.id]);
    db.run('UPDATE schedule_registry SET last_run = ? WHERE id = ?',
      ['2026-10-05T07:25:00Z', rows.find(row => row.command?.includes('older.log'))!.id]);
    debug.log = ((category, event, data) => {
      if (category === 'loops.registry' && event === 'cron-last-run') observations.push(data as typeof observations[number]);
    }) as typeof debug.log;
    const all = listAllLoops({ ...f.opts, now, schedules: listSchedules(db) }).filter(loop => loop.kind === 'cron-shell');
    const get = (needle: string) => all.find(loop => loop.command?.includes(needle))!;
    const inner = get('A.json');
    const only = get('only.err');
    const nullOnly = get('/dev/null');
    const dbNewer = get('older.log');
    const none = get('loop list');
    expect(inner).toMatchObject({ lastRunAt: '2026-10-05T07:29:00.000Z', evidence: 'log-mtime' });
    expect(only).toMatchObject({ lastRunAt: '2026-10-05T07:28:00.000Z', evidence: 'log-mtime' });
    expect(nullOnly).toMatchObject({ lastRunAt: '2026-10-05T07:15:00Z', evidence: 'registry' });
    expect(dbNewer).toMatchObject({ lastRunAt: '2026-10-05T07:25:00Z', evidence: 'registry' });
    expect(none.lastRunAt).toBeUndefined();
    expect(none.evidence).toBeUndefined();
    expect(observations).toHaveLength(5);
    expect(observations).toEqual(expect.arrayContaining([
      { id: inner.id, targets: 3, picked: 'log-mtime' },
      { id: only.id, targets: 1, picked: 'log-mtime' },
      { id: nullOnly.id, targets: 0, picked: 'registry' },
      { id: dbNewer.id, targets: 1, picked: 'registry' },
      { id: none.id, targets: 0, picked: 'none' },
    ]));
    expect(checkLoops([inner], now)[0]?.state).toBe('alive');
  } finally { debug.log = original; db.close(); }
});

test('operational hq-fence loop checker run within five minutes is not late', () => {
  const f = fixture();
  const now = new Date('2026-10-05T07:30:00Z');
  const output = join(f.root, 'loop-check.json');
  const error = join(f.root, 'loop-check.err');
  writeFileSync(output, '{}');
  writeFileSync(error, '');
  utimesSync(output, new Date('2026-10-05T07:28:00Z'), new Date('2026-10-05T07:28:00Z'));
  utimesSync(error, new Date('2026-10-05T07:18:00Z'), new Date('2026-10-05T07:18:00Z'));
  const db = openSchedulesDb(join(f.root, 'operational.db'));
  try {
    inventoryCrontab(db, { crontab: `*/5 * * * * /home/ops/.elanous/bin/hq-fence cron '/home/ops/.bun/bin/eln loop status --all --notify --json > ${output} 2>> ${error}' # LOOP-CHECK1 5분 점검기\n` });
    const row = listSchedules(db)[0]!;
    db.run('UPDATE schedule_registry SET last_run = ? WHERE id = ?', ['2026-10-04T03:12:00Z', row.id]);
    const configPath = join(f.root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ loops: { owners: { 'elanous:loop-status': 'MK' } } }));
    const entry = listAllLoops({ ...f.opts, now, schedules: listSchedules(db), config: buildUserConfig(configPath) })
      .find(loop => loop.id === 'elanous:loop-status')!;
    expect(entry).toMatchObject({ id: 'elanous:loop-status', owner: 'MK', lastRunAt: '2026-10-05T07:28:00.000Z', evidence: 'log-mtime' });
    expect(checkLoops([entry], now)[0]?.state).toBe('alive');
  } finally { db.close(); }
});

test('redirect variants and home expansion use the newest existing file, never /dev/null', () => {
  const f = fixture();
  const now = new Date('2026-10-05T07:30:00Z');
  const file = join(f.root, 'space name.log');
  const newer = join(f.root, 'newer.log');
  writeFileSync(file, 'file');
  writeFileSync(newer, 'newer');
  for (const [path, time] of [[file, '07:20'], [newer, '07:29']] as const) {
    utimesSync(path, new Date(`2026-10-05T${time}:00Z`), new Date(`2026-10-05T${time}:00Z`));
  }
  const db = openSchedulesDb(join(f.root, 'variants.db'));
  const homeName = `.loop-check-registry-${process.pid}-${Date.now()}.log`;
  const home = join(f.root, 'home');
  mkdirSync(home, { recursive: true });
  const actualHomeFile = join(home, homeName);
  writeFileSync(actualHomeFile, 'home');
  utimesSync(actualHomeFile, new Date('2026-10-05T07:10:00Z'), new Date('2026-10-05T07:10:00Z'));
  try {
    inventoryCrontab(db, { crontab: `*/5 * * * * cd '${f.root}' && sh -c 'echo ok' > /dev/null 1> "space name.log" 1>> ~/${homeName} 2> missing.err 2>> $HOME/${homeName} &> /dev/null &>> '${newer}'\n` });
    const entry = listAllLoops({ ...f.opts, now, home, schedules: listSchedules(db) })
      .find(loop => loop.kind === 'cron-shell')!;
    expect(entry).toMatchObject({ lastRunAt: '2026-10-05T07:29:00.000Z', evidence: 'log-mtime' });
    const redirects = ['>', '>>', '1>', '1>>', '2>', '2>>', '&>', '&>>'];
    inventoryCrontab(db, { crontab: redirects.map((redirect, i) =>
      `*/5 * * * * zsh scripts/variant-${i}.sh ${redirect}'${newer}'`).join('\n') + '\n' });
    const variants = listAllLoops({ ...f.opts, now, schedules: listSchedules(db) }).filter(loop => loop.kind === 'cron-shell');
    expect(variants).toHaveLength(redirects.length);
    for (let i = 0; i < redirects.length; i++) {
      expect(variants.find(loop => loop.command?.includes(`variant-${i}.sh`))).toMatchObject({
        lastRunAt: '2026-10-05T07:29:00.000Z', evidence: 'log-mtime',
      });
    }
  } finally { db.close(); }
});

test('loop status keeps its five-run default while health can read older run history', () => {
  const f = fixture();
  const dir = join(f.stateRoot, 'graph-runs', 'daily');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 6; i++) {
    const file = join(dir, `run-${i}.json`);
    const at = new Date(Date.UTC(2026, 9, 8, i)).toISOString();
    writeFileSync(file, JSON.stringify({ graphId: 'daily', runId: `run-${i}`, startedAt: at,
      status: 'failed', nodes: [{ nodeId: 'step', ok: false }], path: ['step'] }));
    utimesSync(file, new Date(at), new Date(at));
  }
  expect(loopStatus('daily', f.opts).recentRuns.map(run => run.runId)).toEqual(['run-5', 'run-4', 'run-3', 'run-2', 'run-1']);
  expect(loopRecentRuns('daily', f.opts, 50).map(run => run.runId))
    .toEqual(['run-5', 'run-4', 'run-3', 'run-2', 'run-1', 'run-0']);
  expect(loopRecentRuns('daily', f.opts, 2).map(run => run.runId)).toEqual(['run-5', 'run-4']);
});

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

test('a wrapper cron counts as the loop only when it declares the graph id in a trailing marker', () => {
  const f = fixture();
  const db = openSchedulesDb(join(f.root, 'wrap.db'));
  inventoryCrontab(db, { crontab: [
    '0 7 * * * zsh $HOME/wrap/daily-cron.sh  # elanous-loop=daily',
    '0 8 * * * zsh $HOME/wrap/other.sh  # elanous-loop=daily-2',
    '0 9 * * * zsh $HOME/wrap/mentions.sh graphs/daily/cron.yaml',
  ].join('\n') + '\n' });
  const rows = listSchedules(db);
  db.close();
  const daily = listLoops({ ...f.opts, schedules: rows }).find(l => l.id === 'daily');
  expect(daily).toMatchObject({ enabled: true, nextRun: expect.any(String) });
  expect(daily?.jobs.map(j => j.cron)).toEqual(['0 7 * * *']);
});

test('intake cron entry script is counted once and start toggles that job instead of creating a second line', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'graphs', 'intake'));
  writeFileSync(join(f.root, 'graphs', 'intake', 'intake-daily.yaml'),
    readFileSync(join(import.meta.dir, '..', '..', 'graphs', 'intake', 'intake-daily.yaml')));
  const line = '0 7 * * * zsh $HOME/.claude/skills/yt-vault/scripts/intake-cron.sh';
  const db = openSchedulesDb(join(f.root, 'intake.db'));
  const refresh = (cron: string) => {
    inventoryCrontab(db, { crontab: cron + '\n' });
    opts.schedules = listSchedules(db);
  };
  const actions: string[] = [];
  const opts: LoopRegistryOptions = { ...f.opts, schedules: [], scheduleAction: async (action, args) => {
    actions.push(action);
    expect(args.id).toBe(opts.schedules?.find(row => row.command?.includes('intake-cron.sh'))?.id);
    refresh(action === 'disable' ? `# ${line}` : line);
    return { changed: true };
  } };
  try {
    refresh(line);
    const intake = listLoops(opts).find(l => l.id === 'intake-daily');
    expect(intake).toMatchObject({ enabled: true, jobs: [{ enabled: true, entryScript: true, cron: '0 7 * * *' }] });
    expect(intake?.jobs).toHaveLength(1);
    const jobId = intake!.jobs[0]!.id;
    expect(listLoops(opts).find(l => l.id === 'daily')?.jobs).toHaveLength(0);
    expect(await setLoopEnabled('intake-daily', true, false, opts)).toMatchObject({ changed: false, entryScript: true });
    expect(await setLoopEnabled('intake-daily', false, false, opts)).toMatchObject({ dryRun: true, entryScript: true,
      changes: [{ action: 'disable', id: jobId }] });
    expect(await setLoopEnabled('intake-daily', false, true, opts)).toMatchObject({ changed: true, entryScript: true });
    expect(listLoops(opts).find(l => l.id === 'intake-daily')).toMatchObject({ enabled: false, jobs: [{ enabled: false, entryScript: true }] });
    const preview = await setLoopEnabled('intake-daily', true, false, opts) as { changes: Array<{ action: string; id: string }> };
    expect(preview.changes).toEqual([{ action: 'enable', id: jobId }]);
    expect(preview.changes.filter(change => change.action === 'create')).toHaveLength(0);
    expect(await setLoopEnabled('intake-daily', true, true, opts)).toMatchObject({ changed: true, entryScript: true });
    expect(actions).toEqual(['disable', 'enable']);
    expect(listLoops(opts).find(l => l.id === 'intake-daily')?.jobs).toHaveLength(1);
    refresh(`${line} && bun bin/elanous.mjs graph run graphs/intake/intake-daily.yaml`);
    expect(listLoops(opts).find(l => l.id === 'intake-daily')?.jobs).toHaveLength(1);
  } finally { db.close(); }
});

test('cron_entry only matches the executed script, not a similarly named script or a mention', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'graphs', 'intake'));
  writeFileSync(join(f.root, 'graphs', 'intake', 'intake-daily.yaml'),
    readFileSync(join(import.meta.dir, '..', '..', 'graphs', 'intake', 'intake-daily.yaml')));
  const db = openSchedulesDb(join(f.root, 'entry-decoys.db'));
  try {
    inventoryCrontab(db, { crontab: [
      '0 7 * * * zsh $HOME/scripts/intake-cron.sh.bak',
      '0 8 * * * echo intake-cron.sh',
      '0 9 * * * zsh $HOME/scripts/other.sh intake-cron.sh',
      '0 10 * * * zsh $HOME/scripts/other.sh # intake-cron.sh',
    ].join('\n') + '\n' });
    const opts = { ...f.opts, schedules: listSchedules(db) };
    const intake = listLoops(opts).find(l => l.id === 'intake-daily');
    expect(intake).toMatchObject({ enabled: false, jobs: [] });
    expect(await setLoopEnabled('intake-daily', true, false, opts)).toMatchObject({
      dryRun: true, changes: [{ action: 'create' }],
    });
    expect(listLoops(opts).find(l => l.id === 'daily')?.jobs).toHaveLength(0);
  } finally { db.close(); }
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
    // cron runs in $HOME with a thin PATH — the line enters the package and names bun by absolute path.
    expect(line).toContain(`cd ${f.opts.root} && ${process.execPath} bin/elanous.mjs graph run `);
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
  expect(loop?.commands.map(c => c.name())).toEqual(['list', 'activity', 'status', 'start', 'stop', 'run', 'package']);
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
