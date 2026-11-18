import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { dispatchScheduleManage } from '../domains/schedule-manage-tool.js';
import { parseCronLine } from '../domains/schedule-registry.js';
import { MsgStore } from '../msg/msg-store.js';
import { registerMsgReceiptsCommands } from './msg-receipts-cli.js';
import { runSchedule } from './schedule-cli.js';

test('schedule CRUD installs a five-minute ACK job and successive simulated ticks alert only once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ack-schedule-integration-'));
  const tab = join(root, 'crontab.txt');
  const fakeCrontab = join(root, 'crontab');
  writeFileSync(tab, '');
  writeFileSync(fakeCrontab, `#!/bin/sh\nif [ "$1" = "-l" ]; then cat "${tab}"; else cat > "${tab}"; fi\n`);
  chmodSync(fakeCrontab, 0o755);
  const old = { state: process.env.ELANOUS_STATE_DIR, config: process.env.ELANOUS_CONFIG_DIR, path: process.env.PATH };
  process.env.ELANOUS_STATE_DIR = root;
  process.env.ELANOUS_CONFIG_DIR = root;
  process.env.PATH = `${root}:${old.path ?? ''}`;
  const dbPath = join(root, 'mail.db');
  const store = new MsgStore(dbPath);
  try {
    const request = store.post({ from: 'RES', to: 'TC', body: 'private', intent: 'request' });
    let created: unknown;
    await runSchedule('create', { from: resolve(import.meta.dir, '../../docs/conductor/SEAT-MAIL-ACK-SCHEDULE.md'), json: true }, async args => {
      created = await dispatchScheduleManage(args); return created;
    }, () => {});
    expect(created).toHaveProperty('created');
    const lines = readFileSync(tab, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const job = parseCronLine(lines[0]!)!;
    expect(job.cron).toBe('*/5 * * * *');
    expect(job.command).toContain('msg overdue --after 15 --stage ack --mark --notify');
    const args = job.command.match(/\bmsg overdue\s+([^>]+?)(?:\s+>>|$)/)?.[1]?.trim().split(/\s+/);
    expect(args).toEqual(['--after', '15', '--stage', 'ack', '--mark', '--notify']);
    const exits: number[] = [];
    const base = Date.now();
    for (const minutes of [20, 25, 30]) {
      const cli = new Command();
      registerMsgReceiptsCommands(cli.command('msg'), {
        openStore: () => new MsgStore(dbPath), out: { log() {}, error() {} }, setExitCode: code => exits.push(code),
        now: () => new Date(base + minutes * 60_000), handleSignals: false,
      });
      await cli.parseAsync(['node', 'eln', 'msg', 'overdue', ...args!]);
    }
    for (const seat of ['RES', 'OP']) {
      expect(store.listByRecipient(seat).filter(m => m.from === 'MSG-SLA').map(m => m.refs)).toEqual([[`msg#${request.id}`]]);
    }
    expect(exits).toEqual([]);
  } finally {
    store.close();
    for (const [key, value] of Object.entries({ ELANOUS_STATE_DIR: old.state, ELANOUS_CONFIG_DIR: old.config, PATH: old.path })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
