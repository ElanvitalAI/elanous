/**
 * `elanous burst-board --replay demo` — plays the synthetic 4-minute Burst Board scenario in the current pane.
 * B1 entry: the live board (`collectBurstSnapshot`) and the `pulse burst board` home arrive with B2/B3.
 */
import type { Command } from 'commander';

export function registerBurstBoardCommand(program: Command): void {
  program.command('burst-board')
    .description('Burst Board — calm ↔ burst resource board (B1: replay only)')
    .option('--replay <scenario>', 'play a synthetic scenario (demo)')
    .option('--speed <n>', 'playback speed multiplier', '1')
    .option('--fixture <name>', 'print one fixture frame and exit (calm|bursting|review-bottleneck|cloud-card-pending|step-up|exit|receipt)')
    .option('--width <n>', 'render width for --fixture', '120')
    .action(async (opts: { replay?: string; speed: string; fixture?: string; width: string }) => {
      const { renderBurstBoard } = await import('../tui/widgets/scenes/burst-board.js');
      const { burstFixture, BURST_FIXTURE_TICKS, playBurstReplay } = await import('../tui/widgets/scenes/burst-replay.js');
      if (opts.fixture) {
        if (!(opts.fixture in BURST_FIXTURE_TICKS)) {
          console.error(`burst-board: unknown fixture «${opts.fixture}» — one of ${Object.keys(BURST_FIXTURE_TICKS).join(', ')}`);
          process.exitCode = 2;
          return;
        }
        console.log(renderBurstBoard(burstFixture(opts.fixture as keyof typeof BURST_FIXTURE_TICKS), Number(opts.width) || 120, 0).join('\n'));
        return;
      }
      if (opts.replay !== 'demo') {
        console.error('burst-board: only «--replay demo» is available until the live board lands (B2)');
        process.exitCode = 2;
        return;
      }
      await playBurstReplay({
        write: (text) => process.stdout.write(text),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        columns: () => process.stdout.columns ?? 120,
      }, { speed: Number(opts.speed) || 1 });
    });
}
