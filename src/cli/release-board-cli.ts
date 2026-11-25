/**
 * `eln release graph board [<v>]` — the interactive Release Board. Collection (release-loop/release-board.ts) and the
 * pure render (tui/widgets/scenes/release-board.ts) stay separate; this file is only the terminal loop: 2-second
 * refresh (home + overwrite, no clear → no flicker), raw keys through the pure reducer, writes through the real graph
 * functions (markDone · skipStep · resumeFrom) for OP/REL after a y/N confirmation.
 * `--replay <scenario>` = a temp test universe driven by synthetic events through the real graph code.
 */
import { join } from 'node:path';
import { collectReleaseBoard, latestVersion, listInstances, previewQuickSurgery, type CollectInput, type Collected } from '../release-loop/release-board.js';
import { createReplay, REPLAY_SECONDS, SCENARIOS, type Replay } from '../release-loop/release-board-replay.js';
import { markDone, resumeFrom, skipStep, type Mode, type PlanOptions } from '../release-loop/release-graph-exec.js';
import { renderReleaseBoard, renderReleaseBoardNoData, type ReleaseBoardSnapshot } from '../tui/widgets/scenes/release-board.js';
import { boardKey, initialUi, parseKeys, type BoardAction, type KeyState } from '../tui/widgets/scenes/release-board-keys.js';

export const REFRESH_MS = 2000;

export interface BoardOptions {
  version?: string;
  stateRoot: string;
  mode: (version: string) => Mode;
  universe: ReleaseBoardSnapshot['universe'];
  trafficRoots: string[];
  planOptions?: PlanOptions;
  role: string | null;
  replay?: string;
  seed?: number;
  speed?: number;
  once?: boolean;
  width?: number;
  height?: number;
  run?: string;
}

const COLOR: ReadonlyArray<readonly [RegExp, string]> = [
  [/■ HARD STOP.*$/u, '31'], [/✓/gu, '32'], [/[!~](?= )/gu, '33'], [/✗/gu, '31'], [/[◐◓◑◒]/gu, '36'],
];
/** ANSI colour on top of the uncoloured render (green fine · amber watch · red act · cyan running only). */
export function colorize(line: string): string {
  let out = line;
  for (const [re, code] of COLOR) out = out.replace(re, (m) => `\x1b[${code}m${m}\x1b[39m`);
  return out;
}

/** One board session: state (instances · follow · tick · ui) and one `frame()` per refresh. Exported for the sim tests. */
export function boardSession(o: BoardOptions, replay?: Replay) {
  const stateRoot = replay?.root ?? o.stateRoot;
  let version = replay?.version ?? o.version ?? latestVersion(stateRoot) ?? '';
  let following = !o.run;
  let run = o.run ?? '';
  let ui: KeyState = initialUi;
  let tick = 0;
  let prevEventKey: string | undefined;
  let last: Collected | null = null;
  const now = () => replay?.now() ?? new Date();
  const input = (): CollectInput => {
    if (!version) version = latestVersion(stateRoot) ?? '';
    const instances = version ? listInstances(stateRoot, version) : [];
    if (following || !instances.includes(run)) run = instances.at(-1) ?? version;
    return { stateRoot, run, instances, following, mode: replay ? 'live' : o.mode(version), universe: replay ? 'replay' : o.universe, now: now(), tick, trafficRoots: o.trafficRoots, ...(replay ? { planOptions: replay.deps.planOptions } : o.planOptions ? { planOptions: o.planOptions } : {}), ...(prevEventKey !== undefined ? { prevEventKey } : {}) };
  };
  const collect = (): Collected => {
    try {
      const i = input();
      if (!i.run) return { ok: false, reason: 'no release graph run in this universe' };
      const c = ui.preview ? previewQuickSurgery(i) : collectReleaseBoard(i);
      if (c.ok) prevEventKey = c.eventKey;
      return c;
    } catch (e) { return { ok: false, reason: `board could not read the run: ${e instanceof Error ? e.message : String(e)}` }; }
  };
  const act = (a: BoardAction): string => {
    const by = o.role ?? 'unknown';
    const at = now();
    const opts = replay?.deps.planOptions ?? o.planOptions;
    try {
      if (a.kind === 'mark') markDone(stateRoot, run, a.step, by, `release board (${by})`, at, opts);
      else if (a.kind === 'skip') skipStep(stateRoot, run, a.step, by, a.reason ?? '', at, opts);
      else resumeFrom(stateRoot, run, a.step, by, at, opts);
      return `${a.kind} ${a.step}: done by ${by}`;
    } catch (e) { return `${a.kind} ${a.step} refused: ${e instanceof Error ? e.message : String(e)}`; }
  };
  return {
    get ui() { return ui; },
    get run() { return run; },
    get following() { return following; },
    refresh(): void { last = collect(); tick += 1; },
    frame(width: number, height: number): string[] {
      if (!last) last = collect();
      if (!last.ok) return renderReleaseBoardNoData(version, last.reason, width, height);
      const n = last.snapshot.steps.length;
      if (ui.selected >= n) ui = { ...ui, selected: Math.max(0, n - 1) };
      return renderReleaseBoard(last.snapshot, ui, width, height);
    },
    /** Returns true to quit. */
    key(data: string): boolean {
      for (const k of parseKeys(data)) {
        const steps = last?.ok ? last.snapshot.steps.map(s => s.id) : [];
        const r = boardKey(ui, k, { steps, role: o.role });
        ui = r.ui;
        if (r.quit) return true;
        if (r.follow) following = true;
        if (r.nextRun) {
          const inst = listInstances(stateRoot, version);
          if (inst.length) { following = false; run = inst[(inst.indexOf(run) + 1) % inst.length]!; ui = { ...ui, flash: `Run ${run} (pinned · f follows the newest)` }; }
        }
        if (r.action) ui = { ...ui, flash: act(r.action) };
        last = collect();
      }
      return false;
    },
  };
}

export async function runReleaseBoard(o: BoardOptions): Promise<void> {
  let replay: Replay | undefined;
  if (o.replay) {
    const sc = SCENARIOS[o.replay];
    if (!sc) { console.error(`release graph board: unknown replay «${o.replay}» — one of ${Object.keys(SCENARIOS).join(', ')}`); process.exitCode = 2; return; }
    replay = createReplay(sc, o.seed ?? 1);
  }
  const session = boardSession(o, replay);
  const out = process.stdout;
  const size = () => ({ w: o.width ?? out.columns ?? 120, h: o.height ?? out.rows ?? 36 });
  if (o.once || !out.isTTY) {
    if (replay) for (let i = 0; i < 400; i++) { if ((await replay.step()).done) break; }
    session.refresh();
    const { w, h } = size();
    out.write(`${session.frame(w, h).join('\n')}\n`);
    return;
  }
  const tty = out.isTTY;
  const paint = () => {
    const { w, h } = size();
    const lines = session.frame(w, h).map(l => (tty ? colorize(l) : l));
    out.write(`\x1b[H${lines.map(l => `${l}\x1b[K`).join('\r\n')}\x1b[J`);
  };
  out.write('\x1b[?1049h\x1b[?25l');
  const stdin = process.stdin;
  let done = false;
  let finish: () => void = () => {};
  const closed = new Promise<void>(r => { finish = r; });
  const stop = () => { if (done) return; done = true; finish(); };
  const onData = (d: Buffer) => { if (session.key(d.toString('utf8'))) stop(); else paint(); };
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on('data', onData);
  stdin.resume();
  const onResize = () => paint();
  out.on('resize', onResize);
  const tickMs = replay ? Math.max(50, (REPLAY_SECONDS * 1000) / 165 / (o.speed && o.speed > 0 ? o.speed : 1)) : REFRESH_MS;
  let replayDone = false;
  const timer = setInterval(() => {
    void (async () => {
      if (replay && !replayDone) replayDone = (await replay.step()).done;
      session.refresh();
      paint();
    })();
  }, tickMs);
  session.refresh();
  paint();
  try { await closed; } finally {
    clearInterval(timer);
    stdin.off('data', onData);
    out.off('resize', onResize);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    out.write('\x1b[?25h\x1b[?1049l');
  }
}

export const defaultTrafficRoots = (seatState: string, stateRoot: string): string[] => [join(seatState, 'RES', 'graph-state'), join(stateRoot, 'loops', 'shadow', 'release-traffic')];
