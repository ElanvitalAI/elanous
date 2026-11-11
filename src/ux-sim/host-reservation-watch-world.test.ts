import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostReservationWatchTick, observeHostProcesses, runHostReservationWatch } from '../loops/host-reservation-watch.js';
import { openMsgStore } from '../msg/msg-store.js';

test('shadow tick sees one gate process and one seat test, then records one violation and one seat mail', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-reservation-watch-'));
  try {
    let birthTick = '10001';
    let seatCommand = 'bun test src/ux-sim/world.test.ts';
    const calls: string[] = [];
    const run = (command: string, args: string[], host?: string) => {
      calls.push(`${host}:${command}:${args.join(' ')}`);
      if (command === 'ps') return { status: 0, stdout: [
        '4242 Tue Nov 11 15:00:00 2026 bun bin/elanous.mjs release run --run-id gate-1',
        `4343 Tue Nov 11 15:01:00 2026 ${seatCommand}`,
      ].join('\n'), stderr: '' };
      if (command === 'cat' && args[0] === '/proc/4343/stat') return { status: 0,
        stdout: `4343 (bun) S ${Array(18).fill('0').join(' ')} ${birthTick}\n`, stderr: '' };
      if (command === 'cat' && args[0] === '/proc/sys/kernel/random/boot_id') return { status: 0,
        stdout: '11111111-2222-3333-4444-555555555555\n', stderr: '' };
      if (command === 'readlink') return { status: 0,
        stdout: args[0] === '/proc/4343/cwd' ? '/repo/seats/R-TICKET/work\n' : '/repo/gate\n', stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected probe' };
    };
    const result = runHostReservationWatch(root, {
      reservations: () => [{ host: 'node-b', runId: 'gate-1' }],
      run,
    });
    expect(result.observed).toBe(1); // Source: LOOP-HOST-RESERVATION-WATCH fixture reserves one host.
    expect(result.violations).toHaveLength(1); // Source: LOOP-HOST-RESERVATION-WATCH fixture has one non-gate seat test.
    expect(result.violations[0]).toMatchObject({ host: 'node-b', runId: 'gate-1', pid: 4343, seat: 'R-TICKET' });
    expect(calls).toContain('node-b:readlink:/proc/4343/cwd');
    expect(calls).not.toContain('node-b:readlink:/proc/4242/cwd');
    const incidentDir = join(root, 'loops', 'host-reservation-watch', 'incidents');
    const incidents = readdirSync(incidentDir).map(name => JSON.parse(readFileSync(join(incidentDir, name), 'utf8')) as { event: string; seat: string });
    expect(incidents).toHaveLength(1); // Source: LOOP-HOST-RESERVATION-WATCH one detected violation emits one incident.
    expect(incidents[0]).toMatchObject({ event: 'host-reservation-violation', seat: 'R-TICKET' });
    const messages = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      const mail = messages.listByRecipient('R-TICKET', 0, 20);
      expect(mail).toHaveLength(1); // Source: LOOP-HOST-RESERVATION-WATCH one violating seat receives one mail.
      expect(mail[0]).toMatchObject({ from: 'GUARDIAN', kind: 'incident' });
      expect(mail[0]!.body).toContain('node-b');
      expect(mail[0]!.body).toContain('프로세스를 종료하지 않았습니다');
    } finally { messages.close(); }
    seatCommand = 'bun test src/ux-sim/changed-world.test.ts';
    runHostReservationWatch(root, {
      reservations: () => [{ host: 'node-b', runId: 'gate-2' }], run,
    });
    expect(readdirSync(incidentDir)).toHaveLength(1); // Source: LOOP-HOST-RESERVATION-WATCH repeated shadow ticks retain one incident identity.
    const replayed = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(replayed.listByRecipient('R-TICKET', 0, 20)).toHaveLength(1); // Source: LOOP-HOST-RESERVATION-WATCH provenance deduplicates repeated seat mail.
    } finally { replayed.close(); }
    birthTick = '10002';
    runHostReservationWatch(root, {
      reservations: () => [{ host: 'node-b', runId: 'gate-2' }], run,
    });
    expect(readdirSync(incidentDir)).toHaveLength(2); // Source: LOOP-HOST-RESERVATION-WATCH a reused PID with a new start is a new process.
    const reused = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(reused.listByRecipient('R-TICKET', 0, 20)).toHaveLength(2); // Source: LOOP-HOST-RESERVATION-WATCH new process lifetime receives a new mail.
    } finally { reused.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only the reserved release run is exempt from the shadow incident', () => {
  const incidents: string[] = [];
  const result = hostReservationWatchTick({
    reservations: () => [{ host: 'node-b', runId: 'gate-1' }],
    processes: () => ({ unmeasured: [], processes: [{ pid: 4242, startedAt: 'Tue Nov 11 15:00:00 2026', birthToken: 'linux:10001', seat: 'R-TICKET',
      command: 'bun bin/elanous.mjs release run --run-id other' }] }),
    incident: violation => { incidents.push(violation.identity); },
    notify: () => undefined,
  });
  expect(result.violations).toHaveLength(1); // Source: LOOP-HOST-RESERVATION-WATCH another release run is not the reserved gate run.
  expect(incidents).toHaveLength(1); // Source: LOOP-HOST-RESERVATION-WATCH wrong-run consumer creates one incident.
});

test('process environment can identify a seat without an argv or cwd marker', () => {
  const records = observeHostProcesses('node-b', (command, args) => command === 'ps'
    ? { status: 0, stdout: '4545 Tue Nov 11 15:00:00 2026 bun test src/ux-sim/world.test.ts', stderr: '' }
    : args[0] === '/proc/sys/kernel/random/boot_id'
      ? { status: 0, stdout: '11111111-2222-3333-4444-555555555555\n', stderr: '' }
    : args[0] === '/proc/4545/stat'
      ? { status: 0, stdout: `4545 (bun) S ${Array(18).fill('0').join(' ')} 10001\n`, stderr: '' }
      : { status: 0, stdout: 'PATH=/usr/bin\0ELANOUS_TRACK=R-TICKET\0', stderr: '' }, 'gate-1');
  expect(records.processes.map(record => record.seat)).toEqual(['R-TICKET']);
});

test('generic seat command is observed while an inaccessible process stays explicitly unmeasured', () => {
  const observation = observeHostProcesses('node-b', (command, args) => {
    if (command === 'ps' && args[0] === '-eo') return { status: 0, stdout: [
      '4545 Tue Nov 11 15:00:00 2026 cargo test',
      '4646 Tue Nov 11 15:00:00 2026 make test',
      '4747 Tue Nov 11 15:00:00 2026 cargo test --seat R-TICKET',
    ].join('\n'), stderr: '' };
    if (command === 'readlink' && args[0] === '/proc/4545/cwd') return { status: 0, stdout: '/repo/seats/R-TICKET/work\n', stderr: '' };
    if (command === 'cat' && args[0] === '/proc/4545/stat') return { status: 0,
      stdout: `4545 (cargo) S ${Array(18).fill('0').join(' ')} 10001\n`, stderr: '' };
    if (command === 'cat' && args[0] === '/proc/4747/stat') return { status: 0,
      stdout: `4747 (cargo) S ${Array(18).fill('0').join(' ')} 10002\n`, stderr: '' };
    if (command === 'cat' && args[0] === '/proc/sys/kernel/random/boot_id') return { status: 0,
      stdout: '11111111-2222-3333-4444-555555555555\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unavailable' };
  }, 'gate-1');
  expect(observation.processes.map(process => process.seat)).toEqual(['R-TICKET', 'R-TICKET']);
  expect(observation.unmeasured).toEqual(['node-b/4646']);
});
