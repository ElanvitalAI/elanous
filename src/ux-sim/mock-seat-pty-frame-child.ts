// N03 probe. The parent supplies only terminal, input, clock and host boundaries;
// this process exercises the production TUI lifecycle, key parser and renderer.
import { closeTui, initTui, readKey, render, termSize } from '../tui.js';

const runId = process.env.ELANOUS_UX_SIM_RUN_ID;
if (!runId || !process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('N03 requires a runId and a real PTY\n');
  process.exit(2);
}

const now = process.env.ELANOUS_UX_SIM_NOW ?? '';
const host = process.env.ELANOUS_UX_SIM_HOST ?? '';
const home = process.env.HOME ?? '';
if (now) Date.now = () => Date.parse(now);
const size = termSize();
initTui();
try {
  render([`N03 first run=${runId} host=${host} now=${Date.now()} size=${size.cols}x${size.rows} home=${home}`]);
  if (process.env.ELANOUS_UX_SIM_MARKERLESS === '1') {
    const { getUserConfig } = await import('../user-config.js');
    process.stdout.write(`N03 error-reports=${getUserConfig().errorReports?.enabled === false ? 'off' : 'on'}\n`);
  } else
    process.stdout.write(`N03:READY:${runId}\n`);
  const key = await readKey('main');
  render([`N03 key=${key.name} run=${runId} host=${host} now=${Date.now()} size=${size.cols}x${size.rows}`]);
  process.stdout.write(`N03:DONE:${runId}\n`);
} finally {
  closeTui();
}
