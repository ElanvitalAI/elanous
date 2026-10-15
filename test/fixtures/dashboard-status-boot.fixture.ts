import { mkdirSync, writeFileSync } from 'node:fs';
import { spyOn } from 'bun:test';
import { seatLedgerPath } from '../../src/seat-loop/seat-loop.js';
import * as runningRuns from '../../src/self-implement/running-runs.js';
import { dispatchDashboardSlashExecute } from '../../src/skills/tools/dashboard-slash.js';
import { showDashboard } from '../../src/dashboard/index.js';

const root = process.env.DASHBOARD_STATUS_TEST_ROOT;
if (!root) throw new Error('DASHBOARD_STATUS_TEST_ROOT is required');
const now = new Date();
mkdirSync(`${root}/seat-loop/TC`, { recursive: true });
writeFileSync(seatLedgerPath('TC', root, now), JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'working',
  item: { source: 'checklist', id: 'TUI-STATUS-BOOT', title: 'TUI status boot' } }) + '\n');

const originalWrite = process.stdout.write.bind(process.stdout);
let screen = '';
process.stdout.write = ((chunk: string | Uint8Array) => {
  screen = (screen + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))).slice(-2000);
  return true;
}) as typeof process.stdout.write;

const query = spyOn(runningRuns, 'queryRunningRuns');
let probing = false;
const probe = setInterval(async () => {
  if (probing) return;
  probing = true;
  query.mockClear();
  try {
    const result = await dispatchDashboardSlashExecute({ name: 'status' });
    const observed = { seatVisible: result.output.includes('CTO TUI status boot'), queryCalls: query.mock.calls.length };
    originalWrite(`DASHBOARD_STATUS_PROBE=${JSON.stringify(observed)}\n`);
    process.exit(observed.seatVisible && observed.queryCalls === 0 ? 0 : 1);
  } catch (error) {
    if (!String(error).includes('not wired') && !String(error).includes('before initialization')) {
      originalWrite(`DASHBOARD_STATUS_ERROR=${String(error)}\n`);
      process.exit(1);
    }
  } finally {
    probing = false;
  }
}, 50);

setTimeout(() => {
  clearInterval(probe);
  originalWrite(`DASHBOARD_STATUS_TIMEOUT=${screen}\n`);
  process.exit(1);
}, 20_000).unref();

void showDashboard().then(() => {
  originalWrite('DASHBOARD_STATUS_EARLY_EXIT\n');
  process.exit(1);
}).catch(error => {
  originalWrite(`DASHBOARD_STATUS_BOOT_ERROR=${String(error)}\n`);
  process.exit(1);
});
