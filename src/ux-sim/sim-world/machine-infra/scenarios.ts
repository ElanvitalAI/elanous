import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadHealCard } from '../../../ops/heal-card.js';
import { runHealCard, type HealActionResult, type HealCard } from '../../../ops/heal-runner.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const DEVICE_ID = 'OPS-HEAL-FAILURE-INJECTOR';
const SIGNAL = 'pregate-load-over';

interface HealDevice {
  ledgerDir: string;
  calls: string[];
  card: HealCard;
  execute(action: string): Promise<HealActionResult>;
}

export const simWorldDevices: readonly SimWorldDeviceDef<HealDevice>[] = [{
  id: DEVICE_ID,
  title: 'isolated heal signal, action and ledger fault injector',
  create(ctx) {
    const ledgerDir = join(ctx.universeRoot, 'seat-state', 'OPS');
    mkdirSync(ledgerDir, { recursive: true });
    const calls: string[] = [];
    return {
      ledgerDir, calls,
      card: {
        signal: SIGNAL, owner: 'RES',
        diagnose: [{ action: 'host.load.read' }],
        repair: [{ action: 'host.load.wait', risk: 'safe', rollback: 'No state changed.' }],
        verify: [{ action: 'host.load.verify' }],
        escalate: { after: 1, message: 'Inspect the host load.' },
      },
      async execute(action) {
        calls.push(action);
        return { ok: true, detail: `injected ${action}` };
      },
    };
  },
}];

const failure = (reason: string, detail: unknown): SimWorldScenarioOutcome => ({
  ok: false, reason, diff: typeof detail === 'string' ? detail : JSON.stringify(detail),
});
const rows = (dir: string): Array<{ signal: string; outcome: string }> => {
  const path = join(dir, 'heal-events.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

const restart: SimWorldScenario = {
  id: 'OPS-HEAL-RESTART', title: 'a new invocation preserves the prior event and opens one improvement on the third signal',
  devices: [DEVICE_ID],
  async run(ctx) {
    const device = ctx.device<HealDevice>(DEVICE_ID);
    const opened: string[] = [];
    for (let i = 0; i < 4; i++) {
      // Each call has fresh dependencies, as after a CLI restart. Only the ledger carries state.
      const result = await runHealCard(device.card, {
        ledgerDir: device.ledgerDir, execute: (action) => device.execute(action),
        openImprovement: (signal) => { opened.push(signal); },
      });
      ctx.recorder.event('heal-invocation', { sequence: i + 1, outcome: result.outcome, improvementOpened: result.improvementOpened });
    }
    const events = rows(device.ledgerDir);
    const marker = existsSync(join(device.ledgerDir, `improve-${SIGNAL}.created`));
    return events.length === 4 && events.every((row) => row.signal === SIGNAL && row.outcome === 'ready')
      && opened.length === 1 && opened[0] === SIGNAL && marker
      ? { ok: true } : failure('restart lost or duplicated a heal event', { events, opened, marker });
  },
};

const deadHolder: SimWorldScenario = {
  id: 'OPS-HEAL-DEAD-LOCK', title: 'a dead ledger lock holder is reclaimed before a new heal event is committed',
  devices: [DEVICE_ID],
  async run(ctx) {
    const device = ctx.device<HealDevice>(DEVICE_ID);
    const lock = join(device.ledgerDir, 'heal-events.lock');
    writeFileSync(lock, '99999999\n', { flag: 'wx' });
    ctx.recorder.event('heal-fault-injected', { kind: 'dead-lock-holder', pid: 99999999 });
    const result = await runHealCard(device.card, { ledgerDir: device.ledgerDir, execute: (action) => device.execute(action) });
    const events = rows(device.ledgerDir);
    return result.outcome === 'ready' && events.length === 1 && !existsSync(lock)
      ? { ok: true } : failure('dead holder prevented a durable heal event', { result, events, lockPresent: existsSync(lock) });
  },
};

async function child(script: string, ledgerDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [script, ledgerDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8').on('data', (part: string) => { stdout += part; });
    proc.stderr.setEncoding('utf8').on('data', (part: string) => { stderr += part; });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const concurrent: SimWorldScenario = {
  id: 'OPS-HEAL-CONCURRENT', title: 'two independent heal processes commit two durable ledger rows',
  devices: [DEVICE_ID],
  async run(ctx) {
    const device = ctx.device<HealDevice>(DEVICE_ID);
    const script = join(import.meta.dir, 'worker.ts');
    const results = await Promise.all([child(script, device.ledgerDir), child(script, device.ledgerDir)]);
    const events = rows(device.ledgerDir);
    const pids = results.map((result) => { try { return JSON.parse(result.stdout).pid as number; } catch { return null; } });
    ctx.recorder.event('heal-processes', { results, pids, ledgerRows: events.length });
    return results.every((result) => result.code === 0) && pids[0] !== null && pids[1] !== null && pids[0] !== pids[1]
      && events.length === 2 && events.every((row) => row.signal === SIGNAL && row.outcome === 'ready')
      ? { ok: true } : failure('concurrent processes lost a heal event', { results, pids, events });
  },
};

const unresponsiveProvider: SimWorldScenario = {
  id: 'OPS-HEAL-PROVIDER-REFUSE', title: 'a provider action is rejected before an unresponsive external call can run',
  devices: [DEVICE_ID],
  async run(ctx) {
    const device = ctx.device<HealDevice>(DEVICE_ID);
    const root = join(ctx.universeRoot, 'seat-state');
    const cardDir = join(root, 'OPS', 'tb');
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, 'provider-unresponsive.yaml'), JSON.stringify({ ...device.card,
      signal: 'provider-unresponsive', diagnose: [{ action: 'provider.call' }],
    }));
    let refused = '';
    try { loadHealCard(root, 'provider-unresponsive'); }
    catch (error) { refused = error instanceof Error ? error.message : String(error); }
    ctx.recorder.event('heal-provider-refused', { refused, calls: device.calls.length, ledgerRows: rows(device.ledgerDir).length });
    return refused.includes('unsupported') && device.calls.length === 0 && rows(device.ledgerDir).length === 0
      ? { ok: true } : failure('unregistered provider action reached the heal runner', { refused, calls: device.calls });
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [restart, deadHolder, concurrent, unresponsiveProvider];
