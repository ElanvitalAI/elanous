/**
 * `elanous burst-board` — the Burst Board in the current pane.
 *   (default)            live board: collectBurstSnapshot (planner · burst state · fed-state · RES), redraw 2 s, re-read 30 s
 *   --replay demo        4-minute scenario computed by the real planner over the test-universe world (seed 1; --seed 2|3)
 *   --fixture <name>     print one replay state and exit (--width/--height · --color)
 *   --capture <dir>      write every replay snapshot as plain text frames (evidence)
 *   prewarm              start a burst in the TEST universe so the live board is hot before a demo
 * Keys (live): b start burst · p plan preview · x exit burst · ? help · q quit. b/x confirm with y and run only with
 * --test-universe (ELANOUS_SEAT_STATE must point away from the real seat-state); otherwise they print the OP command.
 */
import type { Command } from 'commander';
import { join, resolve } from 'node:path';

const realSeatState = () => join(process.env.HOME ?? '', 'elanous-hq', 'seat-state');

function testUniverse(dir: string | undefined): string | null {
  const d = dir ?? process.env.ELANOUS_SEAT_STATE;
  if (!d) return null;
  const abs = resolve(d);
  return abs === resolve(realSeatState()) ? null : abs;
}

async function prewarm(dir: string, opts: { hours: string }): Promise<void> {
  const { DEFAULT_BURST_CONFIG, recordLaunch, startBurst } = await import('../loops/op-pulse-burst.js');
  const { readActiveBurst, writeBurst } = await import('../loops/op-pulse-run.js');
  const path = join(dir, 'OP', 'pulse', 'burst.json');
  const now = new Date();
  let state = startBurst({ goal: 'land', until: new Date(now.getTime() + Number(opts.hours) * 3_600_000).toISOString(), scope: ['ALL'], by: 'OP', now,
    preset: DEFAULT_BURST_CONFIG.presets.find((p) => p.name === '4h')!, trigger: 'prewarm:test-universe', allIn: true }, readActiveBurst(path));
  // Local + LAN only; launch ids are test-universe records (no pane, no VM).
  const plan: Array<[import('../loops/op-pulse-burst.js').BurstLane, string, number]> = [['hands', 'mshq', 4], ['remote', 'node-b', 2], ['remote', 'node-c', 2], ['review', 'mshq', 2], ['pregate', 'minim5', 2]];
  for (const [lane, host, n] of plan) for (let i = 0; i < n; i++) state = recordLaunch(state, { lane, id: `test-${lane}-${host}-${i}`, host }, now, 0);
  writeBurst(path, state);
  console.log(`prewarm: burst ${state.id} active in test universe ${dir} until ${state.until} · ${state.launches.length} test launches (local+LAN, no VM)`);
  console.log(`board:   ELANOUS_SEAT_STATE=${dir} bun bin/elanous.mjs burst-board --test-universe`);
  console.log("stop:    press x on the board, then y (test-universe exit: closes the test launches, files the receipt)");
}

/** Header line: mode (read-only monitor / test universe) · budget and lane ceilings from the burst config · cloud needs a card. */
export function boardHeader(o: { testUniverse: string | null; config: import('../loops/op-pulse-burst.js').BurstConfig; active: import('../loops/op-pulse-burst.js').BurstState | null }): string {
  const preset = o.config.presets.find((p) => p.name === '4h');
  const budget = o.active ? `burst budget $${o.active.budgetUsd} (spent $${o.active.spentUsd ?? 0})` : `4h preset budget $${preset?.budgetUsd ?? 0}`;
  const ceil = (['hands', 'review', 'pregate'] as const).map((l) => `${l}≤${o.config.lanes[l].max}`).join(' ');
  const mode = o.testUniverse ? `TEST UNIVERSE ${o.testUniverse} · b/x enabled` : 'MONITOR · read-only (b/x print the OP command)';
  return ` ${mode} · ${budget} · ceilings ${ceil} · cloud $${o.config.cloudBudgetUsd} auto (VM = card + person)`;
}

async function liveBoard(opts: { testUniverse: string | null; color: boolean }): Promise<void> {
  const { readLiveSources, refreshFast, liveSnapshot } = await import('../tui/widgets/scenes/burst-live.js');
  const { readActiveBurst } = await import('../loops/op-pulse-run.js');
  const { renderForTerminal } = await import('../tui/widgets/scenes/burst-replay.js');
  const { BURST_FRAMES } = await import('../tui/widgets/scenes/burst-board.js');
  if (opts.testUniverse) process.env.ELANOUS_SEAT_STATE = opts.testUniverse;
  const seatState = opts.testUniverse ?? process.env.ELANOUS_SEAT_STATE ?? realSeatState();
  let readings = await readLiveSources({ seatState });
  let tick = 0;
  const snapNow = () => liveSnapshot(refreshFast(readings, seatState, new Date(), readActiveBurst), tick);
  let snap = snapNow();
  let overlay: import('../tui/widgets/scenes/burst-board-panels.js').PanelOverlay | undefined;
  let confirm: 'b' | 'x' | null = null;
  let reading = false;
  let stop = false;
  const refresh = async () => {
    if (reading) return;
    reading = true;
    try { readings = await readLiveSources({ seatState }); snap = snapNow(); } catch { /* keep the last snapshot; gaps show on the next read */ } finally { reading = false; }
  };
  const act = async (key: 'b' | 'x') => {
    if (!opts.testUniverse) { overlay = { kind: 'note', text: key === 'b' ? 'live burst start is OP-only: eln pulse burst start --preset 4h --goal land --until <ISO> (board runs it only with --test-universe)' : 'live exit is OP-only: eln pulse burst stop --reason <why>' }; return; }
    const path = join(opts.testUniverse, 'OP', 'pulse');
    if (key === 'b') { await prewarm(opts.testUniverse, { hours: '4' }).catch((e) => { overlay = { kind: 'note', text: String(e instanceof Error ? e.message : e) }; }); }
    else {
      const { exitBurst } = await import('../loops/op-pulse-burst.js');
      const { readActiveBurst, writeBurst } = await import('../loops/op-pulse-run.js');
      const { appendFileSync, mkdirSync } = await import('node:fs');
      const active = readActiveBurst(join(path, 'burst.json'));
      if (!active) { overlay = { kind: 'note', text: 'no active burst in the test universe' }; return; }
      const { state, receipt } = await exitBurst(active, { now: new Date(), reason: 'board x (test universe)', closer: async () => {}, landedNow: null, greenNow: null });
      writeBurst(join(path, 'burst.json'), state);
      mkdirSync(path, { recursive: true });
      appendFileSync(join(path, 'burst-receipts.jsonl'), `${JSON.stringify(receipt)}\n`);
    }
    await refresh();
  };
  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', (buf: Buffer) => {
    const k = buf.toString();
    if (confirm) {
      const c = confirm; confirm = null; overlay = undefined;
      if (k === 'y' || k === 'Y') void act(c);
      return;
    }
    if (k === 'q' || k === '\x03') stop = true;
    else if (k === 'p') overlay = overlay?.kind === 'plan' ? undefined : { kind: 'plan' };
    else if (k === '?') overlay = overlay?.kind === 'help' ? undefined : { kind: 'help' };
    else if (k === '\x1b') overlay = undefined;
    else if (k === 'b' || k === 'x') {
      confirm = k;
      overlay = { kind: 'confirm', text: `${k === 'b' ? 'Start a 4h burst' : 'Exit the burst and file the receipt'}${opts.testUniverse ? ' in the TEST universe' : ''}? y / n` };
    }
  });
  // Long-lived tab (els widget add burst-board): end cleanly when the pane goes away (els restart re-runs the
  // journaled command), skip identical frames, and keep the slow planner read (one git fetch) at 60 s when read-only.
  const quit = () => { stop = true; };
  for (const sig of ['SIGHUP', 'SIGTERM'] as const) process.once(sig, quit);
  stdin.once('end', quit);
  let lastFrame = '';
  out.on('resize', () => { lastFrame = ''; });
  const slowMs = opts.testUniverse ? 30_000 : 60_000;
  try {
    let last = Date.now();
    while (!stop) {
      if (Date.now() - last > slowMs) { last = Date.now(); void refresh(); }
      snap = snapNow();
      for (let f = 0; f < BURST_FRAMES && !stop; f++) {
        const cols = out.columns ?? 160;
        const head = boardHeader({ testUniverse: opts.testUniverse, config: readings.config, active: snap.mode === 'burst' ? readActiveBurst(join(seatState, 'OP', 'pulse', 'burst.json')) : null }).slice(0, cols);
        const lines = [head, ...renderForTerminal({ ...snap, tick }, cols, Math.max(10, (out.rows ?? 50) - 1), f, opts.color, overlay)];
        const frame = `\x1b[H${lines.map((l) => `${l}\x1b[K`).join('\n')}\x1b[J`;
        if (frame !== lastFrame) { out.write(frame); lastFrame = frame; }
        await new Promise((r) => setTimeout(r, 500));
      }
      tick += 1;
    }
  } finally {
    for (const sig of ['SIGHUP', 'SIGTERM'] as const) process.off(sig, quit);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    out.write('\x1b[?25h\x1b[?1049l');
  }
}

export function registerBurstBoardCommand(program: Command): void {
  const cmd = program.command('burst-board')
    .description('Burst Board — calm ↔ burst resource board (live · --replay demo · prewarm)')
    .option('--replay <scenario>', 'play the 4-minute demo scenario (real planner over the test-universe world)')
    .option('--seed <n>', 'replay seed (1 = demo; 2·3 vary the bundle)', '1')
    .option('--speed <n>', 'playback speed multiplier', '1')
    .option('--fixture <name>', 'print one replay state and exit (calm|bursting|review-bottleneck|cloud-card-pending|step-up|exit|receipt)')
    .option('--capture <dir>', 'write every replay snapshot as plain-text frames into <dir> and exit')
    .option('--width <n>', 'render width for --fixture/--capture', '200')
    .option('--height <n>', 'render height for --fixture/--capture', '80')
    .option('--color', 'ANSI colour for --fixture (the live board and replay colour on a TTY)')
    .option('--test-universe [dir]', 'enable b/x on the board — only against a test seat-state (default $ELANOUS_SEAT_STATE)')
    .action(async (opts: { replay?: string; seed: string; speed: string; fixture?: string; capture?: string; width: string; height: string; color?: boolean; testUniverse?: string | boolean }) => {
      const replay = await import('../tui/widgets/scenes/burst-replay.js');
      const width = Number(opts.width) || 200;
      const height = Number(opts.height) || 80;
      if (opts.fixture) {
        if (!(replay.BURST_FIXTURE_NAMES as readonly string[]).includes(opts.fixture)) {
          console.error(`burst-board: unknown fixture «${opts.fixture}» — one of ${replay.BURST_FIXTURE_NAMES.join(', ')}`);
          process.exitCode = 2;
          return;
        }
        console.log(replay.renderForTerminal(replay.burstFixture(opts.fixture as never), width, height, 0, opts.color === true).join('\n'));
        return;
      }
      if (opts.capture) {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(opts.capture, { recursive: true });
        for (let t = 0; t < replay.DEMO_TICKS; t++) writeFileSync(join(opts.capture, `frame-${String(t).padStart(3, '0')}.txt`), `${replay.renderForTerminal(replay.burstDemoSnapshot(t, Number(opts.seed) || 1), width, height, 0, false).join('\n')}\n`);
        console.log(`burst-board: ${replay.DEMO_TICKS} frames at ${width}×${height} → ${opts.capture}`);
        return;
      }
      if (opts.replay !== undefined) {
        if (opts.replay !== 'demo') { console.error('burst-board: only «--replay demo» exists'); process.exitCode = 2; return; }
        await replay.playBurstReplay({ write: (text) => process.stdout.write(text), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          columns: () => process.stdout.columns ?? 160, rows: () => process.stdout.rows ?? 50, color: process.stdout.isTTY === true },
        { speed: Number(opts.speed) || 1, seed: Number(opts.seed) || 1 });
        return;
      }
      const tu = opts.testUniverse === undefined ? null : testUniverse(typeof opts.testUniverse === 'string' ? opts.testUniverse : undefined);
      if (opts.testUniverse !== undefined && !tu) { console.error('burst-board: --test-universe needs a seat-state dir other than the real one (arg or $ELANOUS_SEAT_STATE)'); process.exitCode = 2; return; }
      await liveBoard({ testUniverse: tu, color: process.stdout.isTTY === true });
    });
  cmd.command('all-in')
    .description('the live «all resources» moment in the TEST universe: hands open as real els tabs (local only), review/pregate step up, forecast catches up, early exit closes the tabs, receipt')
    .argument('[phrase...]', 'the CEO line that starts it', ['all', 'resources'])
    .requiredOption('--test-universe <dir>', 'test seat-state dir (never the real seat-state)')
    .option('--hands <n>', 'hand tabs to open (local mshq only)', '6')
    .option('--ws <name>', 'els workspace for the hand tabs (tile it with: els tile --ws <name>)', 'burst-hands')
    .option('--speed <n>', 'timeline speed (1 ≈ 90 s)', '1')
    .action(async (phrase: string[], o: { testUniverse: string; hands: string; ws: string; speed: string }) => {
      const tu = testUniverse(o.testUniverse);
      if (!tu) { console.error('burst-board all-in: refuses the real seat-state'); process.exitCode = 2; return; }
      const hands = Math.max(1, Math.min(12, Number(o.hands) || 6));
      const { runAllIn } = await import('../tui/widgets/scenes/burst-allin.js');
      const { spawnSync } = await import('node:child_process');
      const els = (args: string[]) => {
        const r = spawnSync('els', args, { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`els ${args[0]} ${args[1] ?? ''} failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
        return r.stdout;
      };
      const handScript = (i: number) => `printf 'hand ${i + 1} · burst test universe · local only · no paid VM\\n'; n=0; while :; do n=$((n+1)); printf '%s  working · step %d\\n' "$(date +%T)" "$n"; sleep 3; done`;
      try {
        await runAllIn({ seatState: tu, phrase: phrase.join(' '), hands, speed: Number(o.speed) || 1 }, {
          spawn: async (i) => {
            const out = els(['new', '--ws', o.ws, '--cwd', tu, '--title', `hand-${i + 1}`, '--', 'sh', '-c', handScript(i)]);
            const pane = (JSON.parse(out.trim().split('\n').at(-1)!) as { pane?: string }).pane;
            if (!pane) throw new Error(`els new returned no pane id: ${out.trim()}`);
            return pane;
          },
          close: async (pane) => { els(['pane', 'close', pane]); },
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: () => new Date(),
          log: (line) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${line}`),
        });
      } catch (e) { console.error(`burst-board all-in: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
  cmd.command('prewarm')
    .description('start a 4h burst in the TEST universe (local+LAN test launches, no VM) so the live board is hot')
    .requiredOption('--test-universe <dir>', 'test seat-state dir (never the real seat-state)')
    .option('--hours <h>', 'burst length', '4')
    .action(async (o: { testUniverse: string; hours: string }) => {
      const tu = testUniverse(o.testUniverse);
      if (!tu) { console.error('burst-board prewarm: refuses the real seat-state'); process.exitCode = 2; return; }
      await prewarm(tu, o);
    });
}
