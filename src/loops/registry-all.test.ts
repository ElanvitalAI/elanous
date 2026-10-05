import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { buildUserConfig } from '../user-config.js';
import { checkLoops } from './checker.js';
import { debug } from '../debug/log.js';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cronEntryId, inventoryCrontab, listSchedules, openSchedulesDb } from '../domains/schedule-registry.js';
import { listAllLoops, listLoops, unregisteredCronLoops } from './registry.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('all inventory joins graph cron once and adds seat, shell and orchestrator with real cron periods', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-all-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'), { recursive: true });
  writeFileSync(join(root, 'graphs', 'daily.yaml'), "graph_id: daily\nloop:\n  title: Daily\n  owner: OP\n  trigger:\n    cron: '*/10 * * * *'\n");
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      `*/10 * * * * cd ${root} && bun bin/elanous.mjs graph run graphs/daily.yaml`,
      '*/15 * * * * bun scripts/seat-loop.ts --seat OP',
      '*/20 * * * * bun scripts/seat-loop.ts --seat TC',
      '*/30 * * * * bun scripts/seat-loop.ts --seat MK',
      '0 * * * * bun scripts/seat-loop.ts --seat UX',
      '*/5 * * * * zsh scripts/refresh.sh',
      '*/10 * * * * bun scripts/loop-orchestrator.ts',
    ].join('\n') + '\n' });
    db.run("UPDATE schedule_registry SET category = 'monitor' WHERE command LIKE '%--seat TC'");
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const before = listLoops(opts);
    const all = listAllLoops(opts);
    expect(listLoops(opts)).toEqual(before);
    expect(all.map(loop => loop.kind).sort()).toEqual(['cron-shell', 'graph', 'orchestrator', 'seat', 'seat', 'seat', 'seat']);
    expect(all.find(loop => loop.id === 'daily')).toMatchObject({ kind: 'graph', title: 'Daily', owner: 'OP', registered: true,
      enabled: true, expectEveryMinutes: 10, recentStatuses: [] });
    for (const [seat, minutes] of [['OP', 15], ['TC', 20], ['MK', 30], ['UX', 60]] as const) {
      expect(all.find(loop => loop.id === `${seat.toLowerCase()}-seat:${opts.schedules.find(row => row.command?.includes(`--seat ${seat}`))?.id}`)).toMatchObject({
        kind: 'seat', owner: seat, enabled: true, registered: true, expectEveryMinutes: minutes,
      });
    }
    expect(all.find(loop => loop.kind === 'graph')).toMatchObject({ host: hostname(), observationCategory: 'graph.runner' });
    expect(all.find(loop => loop.kind === 'seat' && loop.owner === 'TC')).toMatchObject({ host: hostname(), observationCategory: 'monitor' });
    expect(all.find(loop => loop.kind === 'cron-shell')).toMatchObject({ expectEveryMinutes: 5, registered: true, host: hostname(), observationCategory: 'maintenance' });
    expect(all.find(loop => loop.kind === 'orchestrator')).toMatchObject({ expectEveryMinutes: 10, registered: true, host: hostname(), observationCategory: 'maintenance' });
  } finally { db.close(); }
});

test('four fenced seat loop CLI crons are owned by their seat and accounted once; unknown seat warns', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-seat-cli-')));
  roots.push(root);
  const now = new Date('2026-10-04T12:02:00Z');
  const log = join(root, 'seat.log');
  writeFileSync(log, 'run');
  utimesSync(log, new Date('2026-10-04T11:59:00Z'), new Date('2026-10-04T11:59:00Z'));
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      ...(['MK', 'TC', 'UX', 'OP'] as const).map((seat, index) =>
        `*/${index + 5} * * * * hq-fence seat-loop 'cd ${root} && bun bin/elanous.mjs seat loop --seat ${seat} --once >> ${log} 2>&1'`),
      `*/9 * * * * hq-fence seat-loop 'bun bin/elanous.mjs seat loop --seat ZZ --once >> ${log} 2>&1'`,
    ].join('\n') + '\n' });
    const schedules = listSchedules(db);
    const opts = { root, stateRoot: root, now, schedules };
    expect(listLoops(opts)).toEqual([]);
    const all = listAllLoops(opts);
    expect(listLoops(opts)).toEqual([]);
    const seats = all.filter(entry => entry.kind === 'seat');
    expect(seats).toHaveLength(4);
    for (const [index, seat] of (['MK', 'TC', 'UX', 'OP'] as const).entries()) {
      expect(seats.find(entry => entry.id === `elanous:seat-loop:${seat}`)).toMatchObject({
        owner: seat, ownerSource: 'seat-arg', kind: 'seat', registered: true, enabled: true,
        fenceRole: 'seat-loop', expectEveryMinutes: index + 5,
        evidence: 'log-mtime', lastRunAt: '2026-10-04T11:59:00.000Z',
        command: schedules.find(row => row.command?.includes(`--seat ${seat}`))?.command,
      });
    }
    expect(all.filter(entry => entry.kind === 'unregistered').map(entry => entry.cron)).toEqual(['*/9 * * * *']);
    expect(unregisteredCronLoops(all, opts).map(row => row.cron)).toEqual(['*/9 * * * *']);
    expect(unregisteredCronLoops(seats, { ...opts, schedules: schedules.filter(row => row.command?.includes('--seat ZZ') === false) })).toEqual([]);
    expect(checkLoops(seats, now).every(entry => entry.state === 'alive')).toBe(true);
    const related = schedules.filter(row => row.command?.includes('hq-fence seat-loop'));
    expect(related.length).toBe(seats.length + unregisteredCronLoops(all, opts).length);
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ loops: { owners: { 'elanous:seat-loop:MK': 'UX' } } }));
    expect(listAllLoops({ ...opts, config: buildUserConfig(configPath) }).find(entry => entry.id === 'elanous:seat-loop:MK'))
      .toMatchObject({ owner: 'UX', ownerSource: 'config' });
  } finally { db.close(); }
});

test('direct seat loop CLI recognizes a real seat argument, not quoted mentions or unknown values', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-seat-direct-'));
  roots.push(root);
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      '*/5 * * * * bun bin/elanous.mjs seat loop --seat=TC --once',
      '*/6 * * * * bun bin/elanous.mjs seat loop --seat ZZ --once',
      '*/7 * * * * echo "elanous seat loop --seat MK --once"',
      '*/8 * * * * bun bin/elanous.mjs seat loop --seat MK',
    ].join('\n') + '\n' });
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const all = listAllLoops(opts);
    expect(all.filter(entry => entry.kind === 'seat')).toMatchObject([
      { id: 'elanous:seat-loop:TC', owner: 'TC', ownerSource: 'seat-arg', cron: '*/5 * * * *' },
    ]);
    expect(all.filter(entry => entry.kind === 'unregistered').map(entry => entry.cron).sort())
      .toEqual(['*/6 * * * *', '*/7 * * * *', '*/8 * * * *']);
    expect(unregisteredCronLoops(all, opts).map(row => row.cron).sort()).toEqual(['*/6 * * * *', '*/7 * * * *', '*/8 * * * *']);
  } finally { db.close(); }
});

test('a second installed CLI cron for one seat remains visible as an unregistered warning', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-seat-duplicate-'));
  roots.push(root);
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      '*/5 * * * * bun bin/elanous.mjs seat loop --seat MK --once',
      '*/10 * * * * bun bin/elanous.mjs seat loop --seat MK --once',
    ].join('\n') + '\n' });
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const all = listAllLoops(opts);
    expect(all.map(entry => [entry.kind, entry.id])).toEqual([
      ['seat', 'elanous:seat-loop:MK'],
      ['unregistered', opts.schedules[1]!.id],
    ]);
    expect(unregisteredCronLoops(all, opts).map(row => row.id)).toEqual([opts.schedules[1]!.id]);
    expect(opts.schedules).toHaveLength(all.length);
  } finally { db.close(); }
});

test('37 owner lookup keys preserve graph id, seat hash, cron hash and elanous action slots', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-owner-keys-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'));
  writeFileSync(join(root, 'graphs', 'daily.yaml'), "graph_id: daily\nloop:\n  trigger:\n    cron: '*/5 * * * *'\n");
  const commands = [
    `cd ${root} && bun bin/elanous.mjs graph run graphs/daily.yaml`,
    ...(['OP', 'TC', 'MK', 'UX'] as const).map(seat => `bun scripts/seat-loop.ts --seat ${seat}`),
    'zsh scripts/refresh.sh', 'bun scripts/loop-orchestrator.ts',
    ...Array.from({ length: 30 }, () => '/home/ops/.bun/bin/eln hq heartbeat'),
  ];
  const crons = commands.map((_, index) => `${index % 60} ${Math.floor(index / 60)} * * *`);
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: commands.map((command, index) => `${crons[index]} ${command}`).join('\n') + '\n' });
    const expected = commands.map((command, index) => {
      if (index === 0) return 'daily';
      if (index >= 7) return `elanous:hq-heartbeat${index > 7 ? `-${index - 6}` : ''}`;
      const hash = cronEntryId(crons[index]!, command);
      return index <= 4 ? `${['op', 'tc', 'mk', 'ux'][index - 1]}-seat:${hash}` : hash;
    });
    expect(expected).toHaveLength(37);
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ loops: { owners: Object.fromEntries(expected.map(id => [id, 'UX'])) } }));
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db), config: buildUserConfig(configPath) };
    const entries = listAllLoops(opts);
    expect(entries).toHaveLength(37);
    expect(new Set(entries.map(entry => entry.id))).toEqual(new Set(expected));
    expect(entries.every(entry => entry.owner === 'UX' && entry.ownerSource === 'config')).toBe(true);
    expect(unregisteredCronLoops(entries, opts)).toEqual([]);
  } finally { db.close(); }
});

test('owner precedence and cron-shell log mtime flow through registry and checker', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-ownership-')));
  roots.push(root);
  mkdirSync(join(root, 'graphs'), { recursive: true });
  writeFileSync(join(root, 'graphs', 'owned.yaml'), "graph_id: owned\nloop:\n  title: Owned\n  owner: UX\n  trigger:\n    cron: '*/5 * * * *'\n");
  writeFileSync(join(root, 'graphs', 'title.yaml'), "graph_id: by-title\nloop:\n  title: Config title\n  trigger:\n    cron: '*/5 * * * *'\n");
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ loops: { owners: { owned: 'MK', 'Config title': 'TC', configured: 'UX' } } }));
  const config = buildUserConfig(configPath);
  const aliveLog = join(root, 'alive.log');
  const lateLog = join(root, 'late.log');
  writeFileSync(aliveLog, 'not read');
  writeFileSync(lateLog, 'not read');
  const now = new Date('2026-10-04T12:02:00Z');
  utimesSync(aliveLog, new Date('2026-10-04T11:59:00Z'), new Date('2026-10-04T11:59:00Z'));
  utimesSync(lateLog, new Date('2026-10-04T11:44:00Z'), new Date('2026-10-04T11:44:00Z'));
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      `*/5 * * * * cd ${root} && bun bin/elanous.mjs graph run graphs/owned.yaml`,
      `*/5 * * * * cd ${root} && bun bin/elanous.mjs graph run graphs/title.yaml`,
      '*/5 * * * * bun scripts/seat-loop.ts --seat MK',
      `*/5 * * * * zsh scripts/configured.sh >> "${aliveLog}" 2>&1 # configured shell`,
      `*/5 * * * * zsh scripts/default.sh >> ${lateLog} 2>&1`,
      `*/5 * * * * zsh scripts/missing.sh >> ${root}/missing.log 2>&1`,
      `*/5 * * * * cd ${root} && zsh scripts/relative.sh >> alive.log 2>&1`,
    ].join('\n') + '\n' });
    const events: unknown[] = [];
    const original = debug.log;
    debug.log = ((category, event, data) => { if (category === 'loop.check' && event === 'ownership') events.push(data); }) as typeof debug.log;
    let all: ReturnType<typeof listAllLoops>;
    try { all = listAllLoops({ root, stateRoot: root, now, schedules: listSchedules(db), config }); }
    finally { debug.log = original; }
    expect(all.find(loop => loop.id === 'owned')).toMatchObject({ owner: 'UX', ownerSource: 'header' });
    expect(all.find(loop => loop.id === 'by-title')).toMatchObject({ owner: 'TC', ownerSource: 'config' });
    expect(all.find(loop => loop.kind === 'seat')).toMatchObject({ owner: 'MK', ownerSource: 'seat' });
    const configured = all.find(loop => loop.command?.includes('configured.sh'))!;
    const fallback = all.find(loop => loop.command?.includes('default.sh'))!;
    const missing = all.find(loop => loop.command?.includes('missing.sh'))!;
    const relative = all.find(loop => loop.command?.includes('relative.sh'))!;
    expect(configured).toMatchObject({ owner: 'UX', ownerSource: 'config', evidence: 'log-mtime', lastRunAt: '2026-10-04T11:59:00.000Z' });
    expect(fallback).toMatchObject({ owner: 'OP', ownerSource: 'default', evidence: 'log-mtime', lastRunAt: '2026-10-04T11:44:00.000Z' });
    expect(missing).toMatchObject({ owner: 'OP', ownerSource: 'default' });
    expect(missing.evidence).toBeUndefined();
    expect(relative).toMatchObject({ owner: 'OP', ownerSource: 'default', evidence: 'log-mtime', lastRunAt: '2026-10-04T11:59:00.000Z' });
    expect(checkLoops([configured, fallback, missing, relative], now)).toMatchObject([
      { ownerSource: 'config', owner: 'UX', evidence: 'log-mtime', state: 'alive' },
      { ownerSource: 'default', owner: 'OP', evidence: 'log-mtime', state: 'late' },
      { ownerSource: 'default', owner: 'OP', state: 'unknown' },
      { ownerSource: 'default', owner: 'OP', evidence: 'log-mtime', state: 'alive' },
    ]);
    expect(events).toEqual([{ total: 7, bySource: { header: 1, config: 2, seat: 1, 'seat-arg': 0, default: 3 } }]);
    const custom = listAllLoops({ root, stateRoot: root, now, schedules: listSchedules(db), config: {
      ...config, loops: { ...config.loops, owners: { [fallback.id]: 'UX', [all.find(loop => loop.kind === 'seat')!.id]: 'TC' }, defaultOwner: 'MK' },
    } });
    expect(custom.find(loop => loop.id === fallback.id)).toMatchObject({ owner: 'UX', ownerSource: 'config' });
    expect(custom.find(loop => loop.kind === 'seat')).toMatchObject({ owner: 'TC', ownerSource: 'config' });
    expect(custom.find(loop => loop.id === missing.id)).toMatchObject({ owner: 'MK', ownerSource: 'default' });
  } finally { db.close(); }
});

test('inherited object names are not configured owners by id or title', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-inherited-owner-')));
  roots.push(root);
  mkdirSync(join(root, 'graphs'), { recursive: true });
  writeFileSync(join(root, 'graphs', 'constructor.yaml'), "graph_id: constructor\nloop:\n  title: Unconfigured\n  trigger:\n    cron: '*/5 * * * *'\n");
  writeFileSync(join(root, 'graphs', 'title.yaml'), "graph_id: plain\nloop:\n  title: toString\n  trigger:\n    cron: '*/5 * * * *'\n");
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ loops: { owners: {} } }));
  const all = listAllLoops({ root, stateRoot: root, now: new Date('2026-10-04T12:02:00Z'), schedules: [], config: buildUserConfig(configPath) });
  expect(all.find(loop => loop.id === 'constructor')).toMatchObject({ owner: 'OP', ownerSource: 'default' });
  expect(all.find(loop => loop.id === 'plain')).toMatchObject({ owner: 'OP', ownerSource: 'default' });
});

test('cron-shell falls back to a valid recorded run only when log mtime is unavailable', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-run-fallback-')));
  roots.push(root);
  const db = openSchedulesDb(join(root, 'schedules.db'));
  const now = new Date('2026-10-04T12:02:00Z');
  try {
    const unreadableLog = join(root, 'unreadable.log');
    symlinkSync(unreadableLog, unreadableLog);
    inventoryCrontab(db, { crontab: [
      `*/5 * * * * zsh scripts/missing.sh >> ${root}/missing.log 2>&1`,
      '*/5 * * * * zsh scripts/no-redirect.sh',
      `*/5 * * * * zsh scripts/invalid.sh >> ${root}/invalid.log 2>&1`,
      `*/5 * * * * zsh scripts/unreadable.sh >> ${unreadableLog} 2>&1`,
    ].join('\n') + '\n' });
    const rows = listSchedules(db);
    const unreadable = rows.find(row => row.command?.includes('unreadable.sh'))!;
    const missing = rows.find(row => row.command?.includes('missing.sh'))!;
    const noRedirect = rows.find(row => row.command?.includes('no-redirect.sh'))!;
    const invalid = rows.find(row => row.command?.includes('invalid.sh'))!;
    db.run('UPDATE schedule_registry SET last_run = ? WHERE id = ?', ['2026-10-04T11:59:00Z', missing.id]);
    db.run('UPDATE schedule_registry SET last_run = ? WHERE id = ?', ['2026-10-04T11:59:00Z', unreadable.id]);
    db.run('UPDATE schedule_registry SET last_run = ? WHERE id = ?', ['2026-10-04T11:35:00Z', noRedirect.id]);
    db.run('UPDATE schedule_registry SET last_run = ? WHERE id = ?', ['not-a-date', invalid.id]);
    const all = listAllLoops({ root, stateRoot: root, now, schedules: listSchedules(db) });
    const results = checkLoops(all, now);
    expect(results.find(loop => loop.id === missing.id)).toMatchObject({ state: 'alive', lastRunAt: '2026-10-04T11:59:00Z' });
    expect(results.find(loop => loop.id === unreadable.id)).toMatchObject({ state: 'alive', lastRunAt: '2026-10-04T11:59:00Z' });
    expect(results.find(loop => loop.id === noRedirect.id)).toMatchObject({ state: 'late', lastRunAt: '2026-10-04T11:35:00Z' });
    expect(results.find(loop => loop.id === invalid.id)).toMatchObject({ state: 'unknown', reason: 'no valid run recorded' });
    expect(all.filter(loop => loop.evidence === 'log-mtime')).toEqual([]);
    expect(all.filter(loop => loop.evidence === 'registry').map(loop => loop.id).sort()).toEqual(
      [missing.id, unreadable.id, noRedirect.id].sort());
    const log = join(root, 'present.log');
    writeFileSync(log, 'not inspected');
    utimesSync(log, new Date('2026-10-04T11:59:00Z'), new Date('2026-10-04T11:59:00Z'));
    inventoryCrontab(db, { crontab: `*/5 * * * * zsh scripts/present.sh >> ${log} 2>&1\n` });
    const present = listSchedules(db).find(row => row.command?.includes('present.sh'))!;
    db.run('UPDATE schedule_registry SET last_run = ? WHERE id = ?', ['2026-10-04T11:35:00Z', present.id]);
    const observed = listAllLoops({ root, stateRoot: root, now, schedules: listSchedules(db) }).find(loop => loop.id === present.id)!;
    expect(observed).toMatchObject({ evidence: 'log-mtime', lastRunAt: '2026-10-04T11:59:00.000Z' });
    expect(checkLoops([observed], now)[0]?.state).toBe('alive');
  } finally { db.close(); }
});

test('two installed cron entries for the same seat have distinct stable IDs and independent schedules', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-multi-seat-'));
  roots.push(root);
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      '*/15 * * * * bun scripts/seat-loop.ts --seat OP --task first',
      '*/30 * * * * bun scripts/seat-loop.ts --seat OP --task second',
    ].join('\n') + '\n' });
    const schedules = listSchedules(db);
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules };
    const seats = listAllLoops(opts).filter(loop => loop.kind === 'seat');
    expect(seats).toHaveLength(2);
    expect(seats.map(loop => loop.id).sort()).toEqual(schedules.map(row => `op-seat:${row.id}`).sort());
    expect(new Set(seats.map(loop => loop.id)).size).toBe(2);
    expect(seats.map(loop => loop.expectEveryMinutes).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([15, 30]);
    expect(listAllLoops(opts).map(loop => loop.id)).toEqual(seats.map(loop => loop.id));
  } finally { db.close(); }
});

test('declared graph without installed cron is unregistered while installed disabled graph remains registered', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-graph-registration-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'), { recursive: true });
  writeFileSync(join(root, 'graphs', 'absent.yaml'), "graph_id: absent\nloop:\n  host: remote-graph-host\n  observationCategory: graph.absent\n  trigger:\n    cron: '*/10 * * * *'\n");
  writeFileSync(join(root, 'graphs', 'installed.yaml'), "graph_id: installed\nloop:\n  trigger:\n    cron: '0 * * * *'\n");
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    const line = `0 * * * * cd ${root} && bun bin/elanous.mjs graph run graphs/installed.yaml`;
    inventoryCrontab(db, { crontab: line + '\n' });
    inventoryCrontab(db, { crontab: `# ${line}\n` });
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const before = listLoops(opts);
    const all = listAllLoops(opts);
    expect(listLoops(opts)).toEqual(before);
    expect(all.find(loop => loop.id === 'absent')).toMatchObject({ kind: 'graph', registered: false, enabled: false,
      host: 'remote-graph-host', observationCategory: 'graph.absent' });
    expect(all.find(loop => loop.id === 'installed')).toMatchObject({ kind: 'graph', registered: true, enabled: false, host: hostname(), observationCategory: 'graph.runner' });
  } finally { db.close(); }
});

test('installed cron-shell recognizes script and quoted shell -c launch, not argument mentions', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-shell-'));
  roots.push(root);
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      '*/5 * * * * sh -c \'printf alive\'',
      '*/6 * * * * /bin/bash -c "echo alive"',
      '*/7 * * * * cd /tmp && zsh scripts/refresh.sh',
      '*/8 * * * * scripts/direct.sh',
      '*/12 * * * * bash -lc \'echo alive\'',
      '*/13 * * * * sh -e scripts/strict.sh',
      '*/14 * * * * sh -c \'echo --seat OP\'',
      '*/9 * * * * echo scripts/decoy.sh',
      '*/10 * * * * bun scripts/worker.ts --argument sh -c \'echo no\'',
      '*/11 * * * * bun scripts/worker.ts --argument scripts/decoy.sh',
      '*/16 * * * * bun scripts/worker.ts --seat TC',
      '*/17 * * * * bun scripts/worker.ts --argument "--seat MK"',
    ].join('\n') + '\n' });
    const all = listAllLoops({ root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) });
    const shell = all.filter(loop => loop.kind === 'cron-shell');
    expect(shell.map(loop => loop.cron).sort()).toEqual(['*/12 * * * *', '*/13 * * * *', '*/14 * * * *', '*/5 * * * *', '*/6 * * * *', '*/7 * * * *', '*/8 * * * *']);
    expect(all.filter(loop => loop.kind === 'seat')).toEqual([]);
    expect(shell.every(loop => loop.registered && loop.enabled)).toBe(true);
  } finally { db.close(); }
});

test('disabled installed graph reports the installed cron, not the declared trigger', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-installed-cron-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'), { recursive: true });
  writeFileSync(join(root, 'graphs', 'drift.yaml'), "graph_id: drift\nloop:\n  trigger:\n    cron: '*/10 * * * *'\n");
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    const line = `0 * * * * cd ${root} && bun bin/elanous.mjs graph run graphs/drift.yaml`;
    inventoryCrontab(db, { crontab: line + '\n' });
    inventoryCrontab(db, { crontab: `# ${line}\n` });
    const all = listAllLoops({ root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) });
    expect(all.find(loop => loop.id === 'drift')).toMatchObject({ kind: 'graph', enabled: false, cron: '0 * * * *', expectEveryMinutes: 60 });
  } finally { db.close(); }
});

test('execution wrappers expose their inner launches and missing elanous cron lines alone are warned', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-wrapped-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'), { recursive: true });
  writeFileSync(join(root, 'graphs', 'daily.yaml'), "graph_id: daily\nloop:\n  trigger:\n    cron: '*/10 * * * *'\n");
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      `*/10 * * * * cd ${root} && env FOO=bar flock -n /tmp/lock nice -n 5 timeout 20 hq-fence bun bin/elanous.mjs graph run graphs/daily.yaml`,
      '*/5 * * * * env FOO=bar flock -n /tmp/lock nice -n 5 timeout 20 hq-fence bun scripts/seat-loop.ts --seat OP',
      '*/6 * * * * env FOO=bar flock -n /tmp/lock nice -n 5 timeout 20 hq-fence sh scripts/task.sh',
      '*/7 * * * * env FOO=bar flock -n /tmp/lock nice -n 5 timeout 20 hq-fence bun scripts/loop-orchestrator.ts',
      '*/8 * * * * env FOO=bar flock -n /tmp/lock nice -n 5 timeout 20 hq-fence elanous unknown-loop',
      '*/22 * * * * flock -o /tmp/lock elanous future-loop',
      '*/23 * * * * env FOO="bar" elanous future-loop',
      "*/24 * * * * flock /tmp/lock -c 'elanous future-loop'",
      "*/25 * * * * flock /tmp/lock -c 'bun scripts/seat-loop.ts --seat UX'",
      '*/9 * * * * echo "elanous unknown-loop"',
      '*/11 * * * * echo elanous unknown-loop',
      '*/26 * * * * elanous loop list --all',
      '*/27 * * * * env X=1 elanous config get roleLlm',
      '*/28 * * * * env X=1 bun bin/elanous.mjs loop run missing-loop',
      '*/29 * * * * bun scripts/seat-loop.ts --seat OP --label "elanous hq fence --role fake -- echo"',
      "*/31 * * * * flock /tmp/lock -c 'elanous hq fence --role inner -- bun scripts/seat-loop.ts --seat TC'",
      '*/18 * * * * bun bin/elanous.mjs hq fence --role seat-loop -- bun scripts/seat-loop.ts --seat MK',
      '*/19 * * * * bun bin/elanous.mjs hq fence --role cron -- sh scripts/fenced.sh',
      `*/21 * * * * cd ${root} && env X=1 bun bin/elanous.mjs hq fence --role cron -- bun bin/elanous.mjs graph run graphs/daily.yaml`,
    ].join('\n') + '\n' });
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const entries = listAllLoops(opts);
    expect(entries.filter(entry => entry.kind !== 'unregistered').map(entry => entry.kind).sort()).toEqual(['cron-shell', 'cron-shell', 'cron-shell', 'cron-shell', 'cron-shell', 'graph', 'orchestrator', 'seat', 'seat', 'seat', 'seat', 'seat']);
    expect(entries.filter(entry => entry.kind === 'unregistered').map(entry => entry.cron).sort()).toEqual([
      '*/8 * * * *', '*/22 * * * *', '*/23 * * * *', '*/24 * * * *', '*/9 * * * *', '*/11 * * * *',
    ].sort());
    expect(entries.find(entry => entry.cron === '*/26 * * * *')).toMatchObject({ id: 'elanous:loop-list', title: 'loop list' });
    expect(entries.find(entry => entry.kind === 'seat' && entry.owner === 'UX')).toMatchObject({ registered: true, cron: '*/25 * * * *' });
    expect(entries.find(entry => entry.id === 'daily')).toMatchObject({ registered: true, enabled: true, fenceRole: 'cron' });
    expect(entries.find(entry => entry.kind === 'seat' && entry.owner === 'MK')).toMatchObject({ fenceRole: 'seat-loop' });
    expect(entries.find(entry => entry.kind === 'cron-shell' && entry.cron === '*/19 * * * *')).toMatchObject({ fenceRole: 'cron' });
    expect(entries.find(entry => entry.kind === 'seat' && entry.owner === 'TC')).toMatchObject({ fenceRole: 'inner' });
    expect(entries.find(entry => entry.kind === 'seat' && entry.cron === '*/29 * * * *')?.fenceRole).toBeUndefined();
    expect(entries.every(entry => entry.fenceRole !== 'fake')).toBe(true);
    expect(unregisteredCronLoops(entries, opts).map(row => row.cron).sort()).toEqual([
      '*/8 * * * *', '*/22 * * * *', '*/23 * * * *', '*/24 * * * *', '*/9 * * * *', '*/11 * * * *',
    ].sort());
  } finally { db.close(); }
});

test('HQ role wrappers and periodic elanous launches keep graph and shell keys while naming CLI cron loops', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-hq-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'));
  writeFileSync(join(root, 'graphs', 'daily.yaml'), "graph_id: daily\nloop:\n  trigger:\n    cron: '*/10 * * * *'\n");
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      `*/10 * * * * cd ${root} && ~/.elanous/bin/hq-fence cron 'bun bin/elanous.mjs graph run graphs/daily.yaml && echo ok'`,
      `*/17 * * * * hq-fence cron 'echo ready && bun bin/elanous.mjs graph run graphs/daily.yaml && echo ok'`,
      "*/5 * * * * ~/.elanous/bin/hq-fence git-push 'zsh scripts/tree-sync.sh'",
      "*/6 * * * * hq-fence conatus 'bash scripts/conatus.sh'",
      '*/7 * * * * hq-fence --role cron -- sh scripts/flagged.sh',
      '*/8 * * * * eln hq heartbeat',
      '*/9 * * * * eln hq heartbeat --verbose',
      "*/16 * * * * hq-fence --role cron -- 'echo ready && eln hq heartbeat && echo ok'",
      '*/11 * * * * bun bin/elanous.mjs harness queue tick',
      '*/12 * * * * elanous.mjs hq arbiter-check',
      '*/13 * * * * elanous card intake-scan',
      '*/14 * * * * echo "eln hq heartbeat"',
    ].join('\n') + '\n' });
    const rows = listSchedules(db);
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: rows };
    const all = listAllLoops(opts);
    expect(all).toHaveLength(11);
    expect(all.find(entry => entry.kind === 'unregistered')).toMatchObject({ cron: '*/14 * * * *', registered: false });
    expect(all.find(entry => entry.id === 'daily')).toMatchObject({ kind: 'graph', fenceRole: 'cron', registered: true });
    expect(listLoops(opts).find(entry => entry.id === 'daily')?.jobs.map(job => job.id)).toEqual(
      rows.filter(row => row.command?.includes('graphs/daily.yaml')).map(row => row.id));
    for (const [script, role] of [['tree-sync.sh', 'git-push'], ['conatus.sh', 'conatus'], ['flagged.sh', 'cron']] as const) {
      const row = rows.find(item => item.command?.includes(script))!;
      expect(all.find(entry => entry.command?.includes(script))).toMatchObject({ kind: 'cron-shell', id: row.id, fenceRole: role });
    }
    for (const [cron, id] of [
      ['*/8 * * * *', 'elanous:hq-heartbeat'],
      ['*/9 * * * *', 'elanous:hq-heartbeat-2'],
      ['*/16 * * * *', 'elanous:hq-heartbeat-3'],
      ['*/11 * * * *', 'elanous:harness-queue'],
      ['*/12 * * * *', 'elanous:hq-arbiter-check'],
      ['*/13 * * * *', 'elanous:card-intake-scan'],
    ] as const) {
      expect(all.find(entry => entry.cron === cron)).toMatchObject({ kind: 'cron-shell', id, registered: true });
    }
    expect(unregisteredCronLoops(all, opts).map(row => row.cron)).toEqual(['*/14 * * * *']);
    expect(unregisteredCronLoops([], opts).map(row => row.cron)).toContain('*/10 * * * *');
    expect(unregisteredCronLoops([], opts).map(row => row.cron)).toContain('*/17 * * * *');
    expect(unregisteredCronLoops([], opts).map(row => row.cron)).toContain('*/8 * * * *');
    expect(unregisteredCronLoops([], opts).map(row => row.cron)).toContain('*/16 * * * *');
    expect(unregisteredCronLoops([], opts).map(row => row.cron)).toContain('*/11 * * * *');
    expect(unregisteredCronLoops([], opts).map(row => row.cron)).toContain('*/14 * * * *');
    expect(listAllLoops(opts).map(entry => entry.id)).toEqual(all.map(entry => entry.id));
  } finally { db.close(); }
});

test('operational bun and node elanous cron lines share named keys with CLI launches; fenced git push keeps its hash owner key', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-operational-'));
  roots.push(root);
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      '*/5 * * * * cd /Users/ops/wt-ops-hq && /Users/ops/.bun/bin/bun bin/elanous.mjs --config-dir /Users/ops/.elanous hq heartbeat',
      "*/6 * * * * /Users/ops/.elanous/bin/hq-fence cron 'cd /Users/ops/elanous && /Users/ops/.bun/bin/bun bin/elanous.mjs --config-dir /Users/ops/.elanous harness queue tick'",
      "*/7 * * * * /Users/ops/.elanous/bin/hq-fence git-push 'cd /Users/ops/elanous && git push origin main'",
      "*/8 * * * * /Users/ops/.elanous/bin/hq-fence git-push 'cd /Users/ops/wt-ops-hq && /usr/bin/git push origin main'",
      '*/9 * * * * eln --test hq heartbeat',
      '*/10 * * * * node /Users/ops/elanous/bin/elanous.mjs --test --config-dir=/tmp/config harness queue tick',
      '*/11 * * * * echo "bun bin/elanous.mjs --config-dir /tmp hq heartbeat"',
      '*/12 * * * * bun bin/elanous.mjs --config-dir /tmp harness queue list',
    ].join('\n') + '\n' });
    const rows = listSchedules(db);
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: rows };
    const configPath = join(root, 'config.json');
    const gitRows = rows.filter(row => row.command?.includes('hq-fence git-push'));
    writeFileSync(configPath, JSON.stringify({ loops: { owners: Object.fromEntries(gitRows.map(row => [row.id, 'UX'])) } }));
    const all = listAllLoops({ ...opts, config: buildUserConfig(configPath) });
    expect(all).toHaveLength(8);
    expect(all.find(entry => entry.kind === 'unregistered')).toMatchObject({ cron: '*/11 * * * *', registered: false });
    expect(all.find(entry => entry.cron === '*/12 * * * *')).toMatchObject({ id: 'elanous:harness-queue-3', title: 'harness queue' });
    expect([all.find(entry => entry.cron === '*/5 * * * *')?.id, all.find(entry => entry.cron === '*/9 * * * *')?.id].sort())
      .toEqual(['elanous:hq-heartbeat', 'elanous:hq-heartbeat-2']);
    expect([all.find(entry => entry.cron === '*/6 * * * *')?.id, all.find(entry => entry.cron === '*/10 * * * *')?.id].sort())
      .toEqual(['elanous:harness-queue', 'elanous:harness-queue-2']);
    expect(all.find(entry => entry.cron === '*/6 * * * *')).toMatchObject({ title: 'harness queue (hq-fence cron)', fenceRole: 'cron' });
    expect(all.find(entry => entry.cron === '*/5 * * * *')).toMatchObject({ title: 'hq heartbeat' });
    expect(all.filter(entry => entry.id.startsWith('elanous:harness-queue')).map(entry => entry.id).sort())
      .toEqual(['elanous:harness-queue', 'elanous:harness-queue-2', 'elanous:harness-queue-3']);
    for (const row of gitRows) {
      expect(row.id).toBe(cronEntryId(row.cron!, row.command!));
      expect(all.find(entry => entry.id === row.id)).toMatchObject({
        kind: 'cron-shell', title: 'git push (hq-fence git-push)', owner: 'UX', ownerSource: 'config', fenceRole: 'git-push',
      });
    }
    expect(unregisteredCronLoops(all, opts).map(row => row.cron)).toEqual(['*/11 * * * *']);
    expect(unregisteredCronLoops([], opts).map(row => row.cron).sort()).toEqual([
      '*/5 * * * *', '*/6 * * * *', '*/7 * * * *', '*/8 * * * *', '*/9 * * * *', '*/10 * * * *', '*/11 * * * *', '*/12 * * * *',
    ].sort());
  } finally { db.close(); }
});

test('absolute-path eln loop checker and executable basenames register; unmatched related lines warn', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-checker-'));
  roots.push(root);
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      "*/5 * * * * /home/ops/.elanous/bin/hq-fence cron '/home/ops/.bun/bin/eln loop status --all --notify --json > /home/ops/.elanous/loop-check.json 2>> /home/ops/.elanous/loop-check.err' # LOOP-CHECK1 5분 점검기",
      '*/6 * * * * /home/ops/.bun/bin/elanous loop list --all',
      '*/7 * * * * /usr/bin/bun /home/ops/elanous/bin/elanous.mjs --config-dir /home/ops/.elanous hq heartbeat',
      '*/8 * * * * /usr/bin/node /home/ops/elanous/bin/elanous.mjs --config-dir=/tmp/config loop status --all',
      '*/9 * * * * /home/ops/.elanous/bin/mystery --unknown',
      '*/10 * * * * hq-fence cron unknown-worker',
      '*/11 * * * * /home/ops/.bun/bin/eln config get roleLlm',
      '*/12 * * * * unrelated worker',
    ].join('\n') + '\n' });
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const entries = listAllLoops(opts);
    expect(entries.filter(entry => entry.id.startsWith('elanous:')).map(entry => [entry.id, entry.title, entry.cron]).sort((a, b) => String(a[2]).localeCompare(String(b[2])))).toEqual([
      ['elanous:config-get', 'config get', '*/11 * * * *'],
      ['elanous:loop-status-2', 'loop status (hq-fence cron)', '*/5 * * * *'],
      ['elanous:loop-list', 'loop list', '*/6 * * * *'],
      ['elanous:hq-heartbeat', 'hq heartbeat', '*/7 * * * *'],
      ['elanous:loop-status', 'loop status', '*/8 * * * *'],
    ]);
    expect(unregisteredCronLoops(entries, opts).map(row => row.cron).sort()).toEqual([
      '*/9 * * * *', '*/10 * * * *',
    ].sort());
    expect(unregisteredCronLoops(entries.filter(entry => entry.id !== 'elanous:loop-status-2'), opts).map(row => row.cron))
      .toContain('*/5 * * * *');
  } finally { db.close(); }
});

test('every active elanous-related cron line is a loop, CLI action or unregistered warning', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-accounted-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'));
  writeFileSync(join(root, 'graphs', 'daily.yaml'), "graph_id: daily\nloop:\n  trigger:\n    cron: '*/5 * * * *'\n");
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    const lines = [
      `*/5 * * * * cd ${root} && bun bin/elanous.mjs graph run graphs/daily.yaml`,
      "*/6 * * * * hq-fence cron '/home/ops/.bun/bin/eln --version > /tmp/eln-version'",
      '*/7 * * * * eln where',
      '*/8 * * * * elanous future-action --json',
      '*/9 * * * * /home/ops/.elanous/bin/mystery --unknown',
      '*/10 * * * * echo "eln where"',
      '*/11 * * * * unrelated worker',
      '# */12 * * * * eln --version',
      '',
    ];
    inventoryCrontab(db, { crontab: lines.join('\n') + '\n' });
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const entries = listAllLoops(opts);
    expect(entries.find(entry => entry.id === 'daily')).toMatchObject({ kind: 'graph', registered: true });
    expect(entries.find(entry => entry.cron === '*/6 * * * *')).toMatchObject({ id: 'elanous:--version', fenceRole: 'cron' });
    expect(entries.find(entry => entry.cron === '*/7 * * * *')).toMatchObject({ id: 'elanous:where', title: 'where' });
    expect(entries.find(entry => entry.cron === '*/8 * * * *')).toMatchObject({ kind: 'unregistered', registered: false, command: 'elanous future-action --json' });
    const warnings = unregisteredCronLoops(entries, opts);
    expect(warnings.map(row => row.cron).sort()).toEqual(['*/10 * * * *', '*/8 * * * *', '*/9 * * * *']);
    expect(entries.filter(entry => entry.kind === 'unregistered').map(entry => entry.cron).sort())
      .toEqual(['*/10 * * * *', '*/8 * * * *', '*/9 * * * *']);
    expect(entries.filter(entry => entry.kind === 'unregistered').map(entry => entry.command).sort())
      .toEqual(['/home/ops/.elanous/bin/mystery --unknown', 'echo "eln where"', 'elanous future-action --json'].sort());
    const related = opts.schedules.filter(row => row.source === 'crontab' && row.run_via === 'crontab'
      && row.disabled_reason !== 'vanished' && row.disabled_reason !== 'manual'
      && /\b(?:eln|elanous|hq-fence)\b|\.elanous\//.test(row.command ?? ''));
    expect(related).toHaveLength(6);
    expect(related.length).toBe(entries.filter(entry => entry.kind === 'graph' && entry.registered).length
      + entries.filter(entry => entry.id.startsWith('elanous:')).length + warnings.length);
    expect(entries.filter(entry => entry.kind === 'unregistered').every(entry => !entry.registered && entry.enabled)).toBe(true);
    expect(checkLoops(entries, opts.now).filter(entry => entry.state === 'unregistered').map(entry => entry.id).sort())
      .toEqual(entries.filter(entry => entry.kind === 'unregistered').map(entry => entry.id).sort());
    expect(opts.schedules.some(row => row.raw === lines[7] && row.enabled)).toBe(false);
    const logs: Array<{ category: string; event: string; data: unknown }> = [];
    const original = debug.log;
    debug.log = ((category, event, data) => { logs.push({ category, event, data }); }) as typeof debug.log;
    try {
      const damaged = [...entries, entries.find(entry => entry.id === 'elanous:where')!];
      expect(unregisteredCronLoops(damaged, opts).map(row => row.cron)).toContain('*/7 * * * *');
    } finally { debug.log = original; }
    expect(logs).toContainEqual({ category: 'loops.registry', event: 'unaccounted', data: { lines: ['*/7 * * * * eln where'] } });
  } finally { db.close(); }
});

test('graph job with trailing heartbeat does not consume the separate named heartbeat slot', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-graph-heartbeat-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'));
  writeFileSync(join(root, 'graphs', 'daily.yaml'), "graph_id: daily\nloop:\n  trigger:\n    cron: '*/10 * * * *'\n");
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      `*/10 * * * * cd ${root} && bun bin/elanous.mjs graph run graphs/daily.yaml && eln hq heartbeat`,
      '*/5 * * * * eln hq heartbeat',
      '*/6 * * * * eln hq heartbeat --json',
    ].join('\n') + '\n' });
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const entries = listAllLoops(opts);
    expect(entries.map(entry => entry.id)).toEqual(['daily', 'elanous:hq-heartbeat', 'elanous:hq-heartbeat-2']);
    expect(unregisteredCronLoops(entries, opts)).toEqual([]);
    expect(unregisteredCronLoops(entries.filter(entry => entry.id !== 'elanous:hq-heartbeat'), opts).map(row => row.cron)).toEqual(['*/5 * * * *']);
    expect(unregisteredCronLoops(entries.filter(entry => entry.id !== 'elanous:hq-heartbeat-2'), opts).map(row => row.cron)).toEqual(['*/6 * * * *']);
  } finally { db.close(); }
});

test('unclaimed elanous-related cron lines warn even when their command cannot be classified', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-cli-reads-'));
  roots.push(root);
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      '*/5 * * * * elanous logs query --since 1h',
      '*/6 * * * * eln hq status',
      '*/7 * * * * bun bin/elanous.mjs harness queue list',
      '*/8 * * * * elanous card list',
      '*/9 * * * * eln hq heartbeat',
      '*/10 * * * * bun bin/elanous.mjs harness queue tick',
    ].join('\n') + '\n' });
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const entries = listAllLoops(opts);
    expect(entries.filter(entry => entry.kind !== 'unregistered').map(entry => entry.id)).toEqual([
      'elanous:card-list', 'elanous:hq-status', 'elanous:hq-heartbeat',
      'elanous:harness-queue-2', 'elanous:harness-queue', 'elanous:logs-query',
    ]);
    expect(unregisteredCronLoops(entries, opts)).toEqual([]);
    expect(unregisteredCronLoops([], opts).map(row => row.cron).sort()).toEqual([
      '*/5 * * * *', '*/6 * * * *', '*/7 * * * *', '*/8 * * * *', '*/9 * * * *', '*/10 * * * *',
    ].sort());
  } finally { db.close(); }
});

test('separators inside quotes do not split a cron line into a fake fence or a fake loop launch', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-quoted-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'), { recursive: true });
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: [
      '*/29 * * * * bun scripts/seat-loop.ts --seat OP --label "x && elanous hq fence --role fake -- echo"',
      '*/13 * * * * echo "x && elanous loop run ghost"',
      "*/14 * * * * echo 'y; elanous graph run graphs/ghost.yaml'",
      "*/15 * * * * flock /tmp/lock -c 'cd /tmp && elanous hq fence --role inner -- bun scripts/seat-loop.ts --seat TC'",
    ].join('\n') + '\n' });
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const entries = listAllLoops(opts);
    expect(entries.find(entry => entry.kind === 'seat' && entry.cron === '*/29 * * * *')?.fenceRole).toBeUndefined();
    expect(entries.every(entry => entry.fenceRole !== 'fake')).toBe(true);
    expect(entries.find(entry => entry.kind === 'seat' && entry.cron === '*/15 * * * *')).toMatchObject({ fenceRole: 'inner' });
    expect(unregisteredCronLoops(entries, opts).map(row => row.cron).sort()).toEqual(['*/13 * * * *', '*/14 * * * *']);
  } finally { db.close(); }
});

test('wrapped cron entry still claims its graph and never leaves an orphan shell row', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-entry-wrapped-'));
  roots.push(root);
  mkdirSync(join(root, 'graphs'));
  writeFileSync(join(root, 'graphs', 'intake.yaml'), "graph_id: intake\ncron_entry: scripts/intake.sh\nloop:\n  trigger:\n    cron: '0 7 * * *'\n");
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: '0 7 * * * env X=1 flock -n /tmp/intake.lock bun scripts/cron-run.ts --schedule-id fake --shell zsh scripts/intake.sh\n' });
    const opts = { root, stateRoot: root, now: new Date('2026-10-04T12:00:00Z'), schedules: listSchedules(db) };
    const entries = listAllLoops(opts);
    expect(entries.map(entry => entry.id)).toEqual(['intake']);
    expect(entries[0]).toMatchObject({ registered: true, kind: 'graph' });
  } finally { db.close(); }
});

test('irregular cron reports the longest gap and marks itself irregular; regular cron does not', () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-irregular-'));
  roots.push(root);
  const db = openSchedulesDb(join(root, 'schedules.db'));
  try {
    inventoryCrontab(db, { crontab: ['0 9,17 * * * zsh scripts/twice.sh', '*/15 * * * * zsh scripts/steady.sh'].join('\n') + '\n' });
    for (const now of ['2026-10-04T00:30:00Z', '2026-10-04T08:30:00Z']) {
      const all = listAllLoops({ root, stateRoot: root, now: new Date(now), schedules: listSchedules(db) });
      expect(all.find(loop => loop.cron === '0 9,17 * * *')).toMatchObject({ expectEveryMinutes: 16 * 60, cronIrregular: true });
      const steady = all.find(loop => loop.cron === '*/15 * * * *');
      expect(steady).toMatchObject({ expectEveryMinutes: 15 });
      expect(steady?.cronIrregular).toBeUndefined();
    }
  } finally { db.close(); }
});
