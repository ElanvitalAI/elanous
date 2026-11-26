/**
 * `elanous demo invest board` — the Invest Research Board (DEMO-1126-INVEST-ORCH).
 *   --replay [pin]     play a pinned real run (default pin ships with the graph) — no network, cannot fail on stage
 *   (default)          run the real graph live and draw the board from its events
 *   --dry-run          live graph on recorded data and simulated panes (rehearsal)
 *   --frame <sec>      print one frame of the replay at that second and exit (with --width/--height)
 *   --record <file>    write the live run's events as a pin
 */
import type { Command } from 'commander';

export function registerInvestBoardCommand(program: Command): void {
  const demo = program.commands.find((c) => c.name() === 'demo') ?? program.command('demo').description('Demo scenes');
  const invest = demo.commands.find((c) => c.name() === 'invest') ?? demo.command('invest').description('Investment research demo');
  invest.command('run')
    .description('Conductor: the investment research run across els tabs (one per child agent) ending on the board\'s conclusion')
    .option('--els', 'run in els tabs (required: the conductor is an els demo)')
    .option('--ticker <symbol>', 'ticker', '005930.KS')
    .option('--record <file>', 'where the board writes the run as a pin')
    .option('--capture <file>', 'drive one attached els window in a private tmux and save its frames (JSON)')
    .option('--cycle <sec>', 'seconds per tab when cycling', '4')
    .option('--size <colsxrows>', 'captured window size', '190x54')
    .action(async (o: { els?: boolean; ticker: string; record?: string; capture?: string; cycle: string; size: string }) => {
      if (!o.els) { console.error('invest run: pass --els (the conductor runs the demo in els tabs)'); process.exitCode = 2; return; }
      const [cols, rows] = o.size.split('x').map(Number);
      const { runConductor } = await import('../../scripts/demo-invest-orch/conductor.js');
      const r = await runConductor({ ticker: o.ticker, ...(o.record ? { record: o.record } : {}), ...(o.capture ? { capture: o.capture } : {}), cycleSec: Number(o.cycle) || 4, ...(cols && rows ? { cols, rows } : {}) });
      process.exitCode = r.ok ? 0 : 1;
    });
  invest.command('board')
    .description('Invest Research Board — one ticker, one graph run (live, or --replay a pinned run)')
    .option('--ticker <symbol>', 'ticker', '005930.KS')
    .option('--question <text>', 'research question', 'What is the 2027 outlook for Samsung Electronics: buy, hold or sell?')
    .option('--replay [pin]', 'play a pinned run (default: the shipped pin)')
    .option('--variant <name>', 'synthetic edit of the pin: slow-child|failed-child|empty-evidence|long-name')
    .option('--seed <n>', 'seed for --variant', '1')
    .option('--speed <n>', 'replay speed multiplier', '1')
    .option('--frame <sec>', 'print one replay frame at this second and exit')
    .option('--width <n>', 'frame width for --frame', '120')
    .option('--height <n>', 'frame height for --frame', '36')
    .option('--dry-run', 'live graph on recorded data (rehearsal)')
    .option('--sim-delay-ms <n>', 'simulated pane duration for --dry-run')
    .option('--record <file>', 'write the live run as a pin')
    .option('--els', 'open one els tab per child agent in workspace «invest-demo» (live)')
    .option('--close-tabs', 'close the child tabs when the run ends')
    .action(async (o: { ticker: string; question: string; replay?: string | boolean; variant?: string; seed: string; speed: string; frame?: string; width: string; height: string; dryRun?: boolean; simDelayMs?: string; record?: string; els?: boolean; closeTabs?: boolean }) => {
      const size = () => ({ columns: process.stdout.columns ?? 120, rows: process.stdout.rows ?? 36 });
      if (o.replay !== undefined || o.frame !== undefined) {
        const { loadPin, variantPin, pinFrame, playPin, pinDurationMs } = await import('../tui/widgets/scenes/invest-board-pin.js');
        let pin = loadPin(typeof o.replay === 'string' ? o.replay : undefined);
        if (o.variant) {
          if (!['slow-child', 'failed-child', 'empty-evidence', 'long-name'].includes(o.variant)) { console.error(`invest board: unknown variant «${o.variant}»`); process.exitCode = 2; return; }
          pin = variantPin(pin, o.variant as 'slow-child', Number(o.seed) || 1);
        }
        if (o.frame !== undefined) {
          const t = o.frame === 'end' ? pinDurationMs(pin) + 1500 : Number(o.frame) * 1000;
          console.log(pinFrame(pin, t, Number(o.width) || 120, Number(o.height) || 36).join('\n'));
          return;
        }
        await playPin(pin, { write: (s) => process.stdout.write(s), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), size }, Number(o.speed) || 1);
        return;
      }
      // INVEST-PANEL-NL: --els from a plain shell had no universe for its tabs and threw (live run 11-26 14:16) —
      // the tabs go to the els of the universe this CLI resolved (installed → operational · tree → test).
      if (o.els && !process.env.ELANOUS_STATE_DIR?.trim()) {
        const { effectiveStateRoot } = await import('../instance/resolve.js');
        const { stateDirSourceForChild } = await import('../agent/identity-env.js');
        const root = effectiveStateRoot();
        process.env.ELANOUS_STATE_DIR_SOURCE = stateDirSourceForChild(root);
        process.env.ELANOUS_STATE_DIR = root;
      }
      const { runInvestBoardLive } = await import('../../scripts/demo-invest-orch/board-live.js');
      const r = await runInvestBoardLive({ ticker: o.ticker, question: o.question, dryRun: Boolean(o.dryRun), ...(o.simDelayMs ? { simDelayMs: Number(o.simDelayMs) } : {}), ...(o.record ? { record: o.record } : {}), els: Boolean(o.els), closeTabs: Boolean(o.closeTabs),
        write: (s) => process.stdout.write(s), size });
      process.exitCode = r.status === 'done' ? 0 : 1;
    });
}
