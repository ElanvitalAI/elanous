// SEAT-INPLACE-UPDATE simulation world — a fake coordinator seat with real durable files (wakeups incl. past-due and
// folded bundles · autopilot goal + task pin · requirement ledger) and volatile state (draft · queued person lines ·
// notices), driven through the real tick/restore code and the real launcher planner. Each case returns
// { case, expected, actual, durableDiff, turnLost } so the PR matrix is printed from the run itself.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatInPlaceTick, restoreSeatCarry, type SeatInPlacePorts } from '../tui/seat-inplace-wire.js';
import { planNextLaunch, runSeatLauncher, type LaunchState } from '../seat/seat-launcher.js';
import { SEAT_UPDATE_EXIT_CODE } from '../seat/inplace-update.js';

export interface WorldRow { readonly case: string; readonly expected: string; readonly actual: string; readonly durableDiff: readonly string[]; readonly turnLost: number }

interface Seat {
  ports: SeatInPlacePorts;
  state: { busy: boolean; capsules: number; draft: string; lastKey: number; now: number; installed: string; release: string | null; probeOk: boolean;
    queue: { kind: string; text: string; source?: string }[]; left: string[]; cards: string[]; logs: string[] };
  files: Record<string, string>;
  read: () => Record<string, string>;
}

function seedFiles(dir: string, seed: number): Record<string, string> {
  const files = { wakeups: join(dir, 'wakeups.json'), autopilot: join(dir, 'autopilot.json'), requirements: join(dir, 'requirements.json') };
  const wakeups = {
    entries: [
      { id: `w${seed}-overdue`, at: '2026-11-25T10:00:00Z', text: `check rail ${seed} landing — past due, awaiting turn-end delivery` },
      { id: `w${seed}-fold`, at: '2026-11-25T11:00:00Z', folded: [`mail bundle ${seed}-a full text`, `mail bundle ${seed}-b full text`] },
      { id: `w${seed}-repeat`, every: '30m', text: `three-axis eval ${seed}` },
    ],
  };
  writeFileSync(files.wakeups, JSON.stringify(wakeups));
  writeFileSync(files.autopilot, JSON.stringify({ mode: 'auto', goal: `0.3.${36 + seed} roster green`, pins: [{ id: `pin-${seed}`, text: `land #${40100 + seed}`, deadline: '2026-11-25T23:00:00Z' }] }));
  writeFileSync(files.requirements, JSON.stringify({ open: [`R${seed}-1 in-place update`, `R${seed}-2 sim matrix`], done: [`R${seed}-0 design`] }));
  return files;
}

function makeSeat(root: string, seat: string, seed: number, runningCommit: string): Seat {
  const dir = join(root, `${seat}-${seed}`);
  mkdirSync(dir, { recursive: true });
  const files = seedFiles(dir, seed);
  const state: Seat['state'] = { busy: false, capsules: 0, draft: '', lastKey: 0, now: 1_000_000, installed: runningCommit, release: null, probeOk: true,
    queue: [], left: [], cards: [], logs: [] };
  const ports: SeatInPlacePorts = {
    seat, sessionId: () => `sess-${seat}-${seed}`, carryRoot: dir, installRoot: dir, runningCommit,
    installedCommit: () => state.installed, busy: () => state.busy, capsulesActive: () => state.capsules > 0,
    draft: () => state.draft, setDraft: (text) => { state.draft = text; }, lastHumanKeyAt: () => state.lastKey,
    queueItems: () => state.queue, enqueuePerson: (text) => { state.queue.push({ kind: 'user', text }); },
    enqueueNotice: (text, source) => { state.queue.push({ kind: 'notice', text, source }); },
    provider: () => ({ provider: 'openai-codex', model: 'gpt-6.1-terra' }), durableFiles: () => files,
    releaseWindow: () => state.release, probe: () => state.probeOk,
    leave: (id) => { state.left.push(id); }, card: (body) => { state.cards.push(body); },
    now: () => state.now, log: (event) => { state.logs.push(event); },
  };
  const read = () => Object.fromEntries(Object.entries(files).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
  return { ports, state, files, read };
}

/** The new build booting in the same pane: same files, same carry root, empty volatile state, new running commit. */
function reboot(old: Seat, newCommit: string): Seat {
  const state: Seat['state'] = { ...old.state, busy: false, capsules: 0, draft: '', queue: [], left: [], cards: [], logs: [] };
  const ports: SeatInPlacePorts = { ...old.ports, runningCommit: newCommit,
    installedCommit: () => state.installed, busy: () => state.busy, capsulesActive: () => state.capsules > 0,
    draft: () => state.draft, setDraft: (text) => { state.draft = text; }, lastHumanKeyAt: () => state.lastKey,
    queueItems: () => state.queue, enqueuePerson: (text) => { state.queue.push({ kind: 'user', text }); },
    enqueueNotice: (text, source) => { state.queue.push({ kind: 'notice', text, source }); },
    releaseWindow: () => state.release, probe: () => state.probeOk,
    leave: (id) => { state.left.push(id); }, card: (body) => { state.cards.push(body); }, now: () => state.now,
    log: (event) => { state.logs.push(event); } };
  return { ports, state, files: old.files, read: old.read };
}

const memo = () => ({ failed: new Set<string>(), probeFailures: new Map<string, number>(), leaving: false });
const diffText = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter((k) => a[k] !== b[k]).sort();

export async function runSeatInPlaceUpdateWorld(seeds: readonly number[] = [1, 2, 3]): Promise<WorldRow[]> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seat-inplace-world-')));
  const rows: WorldRow[] = [];
  try {
    for (const seed of seeds) {
      const OLD = `old${seed}`.padEnd(40, '0'), NEW = `new${seed}`.padEnd(40, '0'), NEWER = `nwr${seed}`.padEnd(40, '0');
      // 1 · idle boundary + 4/5 durable survive (wakes incl. overdue/folded · pin · requirements · autopilot)
      {
        const s = makeSeat(root, 'OP', seed, OLD);
        s.state.queue.push({ kind: 'notice', text: `[mail #${seed}] full notice text ${seed}`, source: 'seat-mail' });
        const before = s.read();
        s.state.installed = NEW;
        const d = seatInPlaceTick(s.ports, memo());
        const n = reboot(s, NEW);
        const r = restoreSeatCarry(n.ports);
        const after = n.read();
        rows.push({ case: `s${seed} idle boundary`, expected: `go · sess-OP-${seed} · notices [mail #${seed}] full notice text ${seed}`,
          actual: `${d.action} · ${s.state.left.join(',')} · notices ${n.state.queue.filter((q) => q.kind === 'notice').map((q) => q.text).join('|')}`,
          durableDiff: [...diffText(before, after), ...r.lost], turnLost: d.action === 'go' && r.restored ? 0 : 1 });
      }
      // 2 · update arrives mid-turn → waits, goes after the turn ends
      {
        const s = makeSeat(root, 'OP', seed + 100, OLD); const m = memo();
        s.state.installed = NEW; s.state.busy = true;
        const first = seatInPlaceTick(s.ports, m);
        s.state.busy = false;
        const second = seatInPlaceTick(s.ports, m);
        rows.push({ case: `s${seed} mid-turn`, expected: 'wait:turn-running → go', actual: `${first.action}:${'reason' in first ? first.reason : ''} → ${second.action}`,
          durableDiff: [], turnLost: first.action === 'wait' ? 0 : 1 });
      }
      // 3 · person typing at the exit moment → waits; later the draft rides the carry; keys typed into the new build kept
      {
        const s = makeSeat(root, 'OP', seed + 200, OLD); const m = memo();
        s.state.installed = NEW; s.state.draft = `half typed line ${seed}`; s.state.lastKey = s.state.now - 1_000;
        const first = seatInPlaceTick(s.ports, m);
        s.state.now += 25_000;
        const second = seatInPlaceTick(s.ports, m);
        const n = reboot(s, NEW); n.state.draft = '+x';
        restoreSeatCarry(n.ports);
        rows.push({ case: `s${seed} typing at exit`, expected: `wait:person-typing → go · draft «half typed line ${seed}+x»`,
          actual: `${first.action}:${'reason' in first ? first.reason : ''} → ${second.action} · draft «${n.state.draft}»`,
          durableDiff: [], turnLost: n.state.draft === `half typed line ${seed}+x` ? 0 : 1 });
      }
      // 3b · person pressed Enter while busy (queued line) → waits; when idle with the line still queued it still waits
      {
        const s = makeSeat(root, 'OP', seed + 250, OLD);
        s.state.installed = NEW; s.state.queue.push({ kind: 'user', text: `queued ask ${seed}` });
        const d = seatInPlaceTick(s.ports, memo());
        rows.push({ case: `s${seed} queued person line`, expected: 'wait:queued-person-line', actual: `${d.action}:${'reason' in d ? d.reason : ''}`, durableDiff: [], turnLost: 0 });
      }
      // 6 · RunShell / detached capsule in flight → waits (the job is never cut)
      {
        const s = makeSeat(root, 'OP', seed + 300, OLD);
        s.state.installed = NEW; s.state.capsules = 1;
        const d = seatInPlaceTick(s.ports, memo());
        rows.push({ case: `s${seed} RunShell in flight`, expected: 'wait:capsule-running', actual: `${d.action}:${'reason' in d ? d.reason : ''}`, durableDiff: [], turnLost: 0 });
      }
      // 7 · crash loop on the new build → backoff 2/4 s, then previous build + one card
      {
        let st: LaunchState = { build: 'current', crashes: [], launches: 1 };
        const steps: string[] = []; let cards = 0;
        for (const at of [0, 3_000, 9_000]) {
          const next = planNextLaunch(st, 1, 10_000 + at);
          st = next.state;
          steps.push(next.step.kind === 'relaunch' ? `${next.step.why}:${next.step.delayMs}` : 'stop');
          if (next.step.kind === 'relaunch' && next.step.card) cards += 1;
        }
        rows.push({ case: `s${seed} crash loop`, expected: 'crash-backoff:2000 · crash-backoff:4000 · fallback-previous:0 · 1 card',
          actual: `${steps.join(' · ')} · ${cards} card`, durableDiff: [], turnLost: 0 });
      }
      // 8 · two updates back to back → one exit while leaving, next build taken on the new boot
      {
        const s = makeSeat(root, 'OP', seed + 400, OLD); const m = memo();
        s.state.installed = NEW;
        seatInPlaceTick(s.ports, m);
        s.state.installed = NEWER;
        seatInPlaceTick(s.ports, m);
        const n = reboot(s, NEW); restoreSeatCarry(n.ports);
        const again = seatInPlaceTick(n.ports, memo());
        const n2 = reboot(n, NEWER); const r2 = restoreSeatCarry(n2.ports);
        rows.push({ case: `s${seed} back-to-back`, expected: '1 exit on old · go on new · lost none', actual: `${s.state.left.length} exit on old · ${again.action} on new · lost ${r2.lost.length ? r2.lost.join(',') : 'none'}`,
          durableDiff: [...r2.lost], turnLost: 0 });
      }
      // 9 · release window → deferred
      {
        const s = makeSeat(root, 'OP', seed + 500, OLD);
        s.state.installed = NEW; s.state.release = 'release-window 04:00–06:30 KST';
        const d = seatInPlaceTick(s.ports, memo());
        rows.push({ case: `s${seed} release window`, expected: 'wait:release-window', actual: `${d.action}:${'reason' in d ? d.reason : ''}`, durableDiff: [], turnLost: 0 });
      }
      // 10 · leader seats same · a hand seat is not moved here
      {
        const out: string[] = [];
        for (const seat of ['TC', 'UX', 'MK', 'JUD', 'CC-1']) {
          const s = makeSeat(root, seat, seed + 600, OLD); s.state.installed = NEW;
          out.push(`${seat}:${seatInPlaceTick(s.ports, memo()).action}`);
        }
        rows.push({ case: `s${seed} leaders`, expected: 'TC:go UX:go MK:go JUD:go CC-1:none', actual: out.join(' '), durableDiff: [], turnLost: 0 });
      }
      // 11 · new entry does not start → stays on the old build, exactly one card
      {
        const s = makeSeat(root, 'OP', seed + 700, OLD); const m = memo();
        s.state.installed = NEW; s.state.probeOk = false;
        const a = seatInPlaceTick(s.ports, m), b = seatInPlaceTick(s.ports, m), c = seatInPlaceTick(s.ports, m);
        rows.push({ case: `s${seed} new build will not start`, expected: 'wait:probe-retry · stay-card · none · 1 card · 0 exits',
          actual: `${a.action}:${'reason' in a ? a.reason : ''} · ${b.action} · ${c.action} · ${s.state.cards.length} card · ${s.state.left.length} exits`, durableDiff: [], turnLost: 0 });
      }
      // 13 · FU: held (off-queue) notice + in-memory hand-block cap survive the switch
      {
        const s = makeSeat(root, 'OP', seed + 800, OLD);
        const restored: Record<string, number> = {};
        s.ports = { ...s.ports, heldNotices: () => [{ text: `held notice ${seed} full text` }], caps: () => ({ handBlockPullAt: 900_000 + seed }) };
        s.state.installed = NEW;
        seatInPlaceTick(s.ports, memo());
        const n = reboot(s, NEW);
        n.ports = { ...n.ports, restoreCaps: (caps) => { Object.assign(restored, caps); } };
        restoreSeatCarry(n.ports);
        rows.push({ case: `s${seed} held notice + cap`, expected: `held notice ${seed} full text · handBlockPullAt ${900_000 + seed}`,
          actual: `${n.state.queue.map((q) => q.text).join('|')} · handBlockPullAt ${restored.handBlockPullAt}`, durableDiff: [], turnLost: 0 });
      }
      // 12 · pane id unchanged across the launcher relaunch (update exit → same pane env, current build)
      {
        const panes: string[] = []; const codes = [SEAT_UPDATE_EXIT_CODE, 0];
        const installRoot = join(root, `inst-${seed}`); mkdirSync(join(installRoot, 'current', 'node_modules', 'elanous', 'bin'), { recursive: true });
        const prev = process.env.ELANOUS_ELS_PANE; process.env.ELANOUS_ELS_PANE = `p0000${seed}abc`;
        try {
          await runSeatLauncher({ installRoot, args: ['--resume', 'x'], sessionId: () => `sess-${seed}`,
            run: async (_cmd, argv, env) => { panes.push(`${env.ELANOUS_ELS_PANE}|${argv.slice(-1)[0]}`); return codes.shift() ?? 0; }, sleep: async () => {} });
        } finally { if (prev === undefined) delete process.env.ELANOUS_ELS_PANE; else process.env.ELANOUS_ELS_PANE = prev; }
        rows.push({ case: `s${seed} pane id`, expected: `p0000${seed}abc|sess-${seed} ×2`, actual: `${panes[0]} ×${panes.filter((p) => p === panes[0]).length}`, durableDiff: [], turnLost: 0 });
      }
    }
    return rows;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
