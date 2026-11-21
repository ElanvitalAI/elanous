import { test, expect, setDefaultTimeout } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../ux-sim/in-process-cli.js';

setDefaultTimeout(15_000);

test('schedule create in an explicit config universe never invokes the system crontab', async () => {
  const root = mkdtempSync(join(tmpdir(), 'schedule-config-isolation-'));
  const bin = join(root, 'bin');
  const calls = join(root, 'system-crontab-calls');
  const isolated = join(root, 'isolated');
  const fake = join(bin, 'crontab');
  try {
    mkdirSync(bin);
    writeFileSync(fake, '#!/bin/sh\necho "$*" >> "$CRONTAB_CALLS"\nif [ "$1" = "-l" ]; then echo "0 1 * * * system-existing"; else cat >/dev/null; fi\n');
    chmodSync(fake, 0o755);
    const run = (action: string[]) => simCli(['--config-dir', isolated, 'schedule', ...action, '--json'], {
      mode: 'spawn', allowPaths: [['schedule']], stateRoot: isolated, configRoot: isolated,
      injectTestFlag: false, cwd: join(import.meta.dir, '../..'),
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, CRONTAB_CALLS: calls },
    });

    const created = await run(['create', '--cron', '13,43 * * * *', '--command', 'true']);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout).created).toContain('13,43 * * * * true');
    expect(existsSync(calls)).toBe(false);
    const sentinel = join(root, 'sentinel');
    writeFileSync(sentinel, '0 1 * * * must-stay\n');
    const backupDir = join(isolated, 'backups');
    const firstBackup = join(backupDir, readdirSync(backupDir).find(name => name.endsWith('.bak'))!);
    expect(lstatSync(firstBackup).isFile()).toBe(true);
    rmSync(firstBackup);
    symlinkSync(sentinel, firstBackup);
    const listed = await run(['list']);
    expect(listed.exitCode).toBe(0);
    const jobs = JSON.parse(listed.stdout).schedules.filter((item: { source: string }) => item.source === 'crontab');
    expect(jobs
      .map((item: { command_full: string }) => item.command_full))
      .toEqual(['true >> /tmp/true.log 2>&1']);
    expect(existsSync(calls)).toBe(false);
    expect(readFileSync(join(isolated, 'crontab'), 'utf8')).toContain('13,43 * * * * true');

    const updated = await run(['update', jobs[0].id, '--cron', '18 * * * *']);
    expect(updated.exitCode).toBe(0);
    expect(readFileSync(join(isolated, 'crontab'), 'utf8')).toContain('18 * * * * true');
    expect(existsSync(calls)).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('0 1 * * * must-stay\n');
    expect(lstatSync(firstBackup).isSymbolicLink()).toBe(true);
    expect(readdirSync(backupDir).filter(name => name.endsWith('.bak')).length).toBe(2);
    const afterUpdate = await run(['list']);
    const updatedId = JSON.parse(afterUpdate.stdout).schedules.find((item: { source: string }) => item.source === 'crontab').id;
    const deleted = await run(['delete', updatedId, '--yes']);
    expect(deleted.exitCode).toBe(0);
    expect(readFileSync(join(isolated, 'crontab'), 'utf8')).toBe('\n');
    expect(existsSync(calls)).toBe(false);

    rmSync(join(isolated, 'crontab'));
    symlinkSync(sentinel, join(isolated, 'crontab'));
    const linked = await run(['create', '--cron', '3 * * * *', '--command', 'true']);
    expect(linked.exitCode).not.toBe(0);
    expect(readFileSync(sentinel, 'utf8')).toBe('0 1 * * * must-stay\n');
    expect(existsSync(calls)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a config-dir symlink to the production root is rejected before opening schedules.db', async () => {
  const home = mkdtempSync(join(tmpdir(), 'schedule-linked-home-'));
  try {
    const prod = join(home, '.elanous');
    const linked = join(home, 'linked');
    mkdirSync(prod);
    symlinkSync(prod, linked);
    const result = await simCli(['--config-dir', linked, 'schedule', 'create', '--cron', '3 * * * *', '--command', 'true', '--json'], {
      mode: 'spawn', allowPaths: [['schedule']], stateRoot: linked, configRoot: linked,
      injectTestFlag: false, cwd: join(import.meta.dir, '../..'), env: { HOME: home },
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(prod, 'schedules.db'))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('schedule CLI refuses linked SQLite database and sidecar leaves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'schedule-db-leaves-'));
  const bin = join(root, 'bin');
  const calls = join(root, 'system-crontab-calls');
  try {
    mkdirSync(bin);
    const fake = join(bin, 'crontab');
    writeFileSync(fake, '#!/bin/sh\necho called >> "$CRONTAB_CALLS"\nexit 99\n');
    chmodSync(fake, 0o755);
    for (const [index, suffix] of ['', '-wal', '-shm', '-journal'].entries()) {
      const isolated = join(root, `isolated-${index}`);
      const outside = join(root, `outside-${index}`);
      mkdirSync(isolated);
      writeFileSync(outside, 'outside must stay');
      symlinkSync(outside, join(isolated, `schedules.db${suffix}`));
      const result = await simCli(['--config-dir', isolated, 'schedule', 'create', '--cron', '3 * * * *', '--command', 'true', '--json'], {
        mode: 'spawn', allowPaths: [['schedule']], stateRoot: isolated, configRoot: isolated,
        injectTestFlag: false, cwd: join(import.meta.dir, '../..'),
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, CRONTAB_CALLS: calls },
      });
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(outside, 'utf8')).toBe('outside must stay');
      expect(existsSync(calls)).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schedule CLI refuses a linked isolated backup directory before writing outside', async () => {
  const root = mkdtempSync(join(tmpdir(), 'schedule-backup-link-'));
  const isolated = join(root, 'isolated');
  const outside = join(root, 'outside');
  const bin = join(root, 'bin');
  const calls = join(root, 'system-crontab-calls');
  try {
    mkdirSync(isolated);
    mkdirSync(outside);
    mkdirSync(bin);
    symlinkSync(outside, join(isolated, 'backups'));
    const fake = join(bin, 'crontab');
    writeFileSync(fake, '#!/bin/sh\necho called >> "$CRONTAB_CALLS"\nexit 99\n');
    chmodSync(fake, 0o755);
    const result = await simCli(['--config-dir', isolated, 'schedule', 'create', '--cron', '3 * * * *', '--command', 'true', '--json'], {
      mode: 'spawn', allowPaths: [['schedule']], stateRoot: isolated, configRoot: isolated,
      injectTestFlag: false, cwd: join(import.meta.dir, '../..'),
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, CRONTAB_CALLS: calls },
    });
    expect(result.exitCode).not.toBe(0);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(calls)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
