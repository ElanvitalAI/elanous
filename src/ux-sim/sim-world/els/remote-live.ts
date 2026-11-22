// ELS-UPDATE-ALL-GRACEFUL 0.3.33: event-injected registered remote turn and timeout.
// The real SSH/ELS/TUI experiment is separate evidence; this pack calls the product core paths.
import { runSeatControl } from '../../../cli/seat-control-cli.js';
import { updateAllElsTabs, type UpdatePane, type UpdateSeatRow } from '../../../els/update-all.js';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

const DESIRED = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const CWD = '/sim-world/seats/TC';
const ADDRESS = 'node-b:w1/t1/p1';

interface RemoteTurnDevice {
  readonly pane: UpdatePane;
  readonly events: string[];
  rows(): readonly UpdateSeatRow[];
  tick(): Promise<void>;
  time(): number;
  migrate(seat: string, expected: { id: string; ownerPid: number; sessionId: string; workdir: string }): Promise<{ status: string; reason?: string }>;
}

const turnDevice: SimWorldDeviceDef<RemoteTurnDevice> = {
  id: 'els-remote-live-turn-clock',
  title: 'Remote ELS/TUI turn boundary, owner restart, and exact identity ledger event injector',
  create(ctx) {
    let now = 0;
    let accepted = false;
    let gapReads = 0;
    let current: readonly UpdateSeatRow[] = [{ id: 'tui:401', seat: 'TC', ownerPid: 401, alive: true,
      kind: 'tui', sessionId: 'session-1', workdir: CWD, build: { sha: OLD, source: 'installed' } }];
    const events: string[] = [];
    const mark = (kind: string) => { events.push(kind); ctx.recorder.event(kind, { now, pane: ADDRESS }); };
    return {
      pane: { address: ADDRESS, host: 'node-b', reach: 'local', seat: 'TC', state: 'working',
        cwd: CWD, pid: 401, kind: 'pty' }, events,
      rows: () => { if (now === 2_000 && current.length === 0) gapReads++; return current; },
      time: () => now,
      migrate: (seat, expected) => runSeatControl(seat, 'migrate', {
        sender: () => 'RES-INFRA', rows: () => current,
        send: async () => { accepted = true; mark('migrate-waiting'); return { status: 'success', reason: 'waiting' }; },
      }, expected),
      tick: async () => {
        now += 1_000;
        if (!accepted) throw new Error('timer advanced before the product migrate request');
        if (now === 1_000) mark('busy-turn-still-running');
        if (now === 2_000) {
          mark('shell-completed');
          current = [];
          mark('owner-gap');
        }
        if (now === 3_000) {
          if (gapReads < 1) throw new Error('product did not poll the owner gap');
          mark('owner-gap-observed');
          current = [{ id: 'tui:402', seat: 'TC', ownerPid: 402, alive: true, kind: 'tui',
            sessionId: 'session-1', workdir: CWD, build: { sha: DESIRED, source: 'installed' } }];
          mark('same-pane-owner-restarted');
        }
      },
    };
  },
};

const remoteLive: SimWorldScenario = {
  id: 'E-REMOTE-LIVE-TURN',
  title: 'registered remote busy TUI waits for turn end and restarts its exact pane owner',
  devices: [turnDevice.id],
  async run(ctx) {
    const device = ctx.device<RemoteTurnDevice>(turnDevice.id);
    const remotePane: UpdatePane = { ...device.pane, reach: 'up' };
    const childReceipts: Awaited<ReturnType<typeof updateAllElsTabs>>[] = [];
    const child = () => updateAllElsTabs({
      sender: () => 'RES-INFRA', expectedDesired: DESIRED,
      target: () => ({ desired: DESIRED, installed: DESIRED }),
      list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [device.pane] }),
      seats: device.rows, migrate: device.migrate, sleep: device.tick, now: device.time, timeoutMs: 3_000,
      localOnly: true,
    });
    const parent = await updateAllElsTabs({
      sender: () => 'RES-INFRA', expectedDesired: DESIRED,
      target: () => ({ desired: DESIRED, installed: DESIRED }),
      list: async () => ({ hosts: [{ name: 'mshq', reach: 'local' }, { name: 'node-b', reach: 'up' }], panes: [remotePane] }),
      seats: () => [], migrate: async () => { throw new Error('remote target must not use the parent ledger'); },
      remoteUpdate: async (_, panes, desired) => {
        if (panes.length !== 1 || panes[0]?.address !== ADDRESS || desired !== DESIRED) throw new Error('wrong remote selection');
        const receipt = await child();
        childReceipts.push(receipt);
        const childRow = receipt.rows.find(row => row.tab === ADDRESS);
        if (!receipt.ok || receipt.rows.length !== 1 || !childRow || childRow.result !== 'updated')
          throw new Error(`child refused: ${receipt.reason ?? childRow?.detail ?? 'unknown'}`);
        return { result: childRow.result, detail: `SSH simulated; child product row ${childRow.detail}`,
          panes: [childRow] };
      },
      sleep: async () => {}, now: () => 0,
    });
    const childReceipt = childReceipts[0];
    ctx.recorder.event('els-remote-live-result', { ok: parent.ok, rows: parent.rows,
      childRows: childReceipt?.rows ?? null, events: device.events });
    const childRow = childReceipt?.rows.find(row => row.tab === ADDRESS);
    const correctRows = parent.rows.length === 2 && parent.rows[0]?.tab === 'node-b:*' && parent.rows[0]?.result === 'updated'
      && parent.rows[1]?.tab === ADDRESS && parent.rows[1]?.result === 'updated'
      && childReceipt?.ok === true && childReceipt.rows.length === 1 && childRow?.result === 'updated';
    const correctOrder = device.events.join(',') === 'migrate-waiting,busy-turn-still-running,shell-completed,owner-gap,owner-gap-observed,same-pane-owner-restarted';
    return parent.ok && correctRows && correctOrder ? { ok: true } : {
      ok: false, reason: 'remote busy turn moved before shell completion or wrong pane',
      diff: `rows ${JSON.stringify(parent.rows)}; events ${JSON.stringify(device.events)}`,
    };
  },
};

const timeout: SimWorldScenario = {
  id: 'E-REMOTE-TIMEOUT',
  title: 'a silent registered host reports failed host and pane rows without a local migration',
  async run(ctx) {
    let localMigrations = 0;
    const result = await updateAllElsTabs({
      sender: () => 'RES-INFRA', expectedDesired: DESIRED,
      target: () => ({ desired: DESIRED, installed: DESIRED }),
      list: async () => ({ hosts: [{ name: 'mshq', reach: 'local' }, { name: 'node-b', reach: 'up' }],
        panes: [{ address: ADDRESS, host: 'node-b', reach: 'up', seat: 'TC', state: 'working', cwd: CWD, pid: 401 }] }),
      seats: () => [], migrate: async () => { localMigrations++; throw new Error('wrong local migration'); },
      remoteUpdate: async () => { throw new Error('injected SSH timeout'); },
      sleep: async () => {}, now: () => 0,
    });
    ctx.recorder.event('els-remote-timeout-result', { ok: result.ok, rows: result.rows, localMigrations });
    const host = result.rows.find(row => row.tab === 'node-b:*');
    const pane = result.rows.find(row => row.tab === ADDRESS);
    return !result.ok && localMigrations === 0 && result.rows.length === 2
      && host?.result === 'failed' && pane?.result === 'failed' ? { ok: true } : {
        ok: false, reason: 'remote timeout falsely updated a pane', diff: JSON.stringify(result.rows),
      };
  },
};

export const simWorldDevices: readonly SimWorldDeviceDef[] = [turnDevice];
export const simWorldScenarios: readonly SimWorldScenario[] = [remoteLive, timeout];
