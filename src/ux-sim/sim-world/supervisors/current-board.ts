// SIM-WORLD supervisors — CURRENT-RELEASE-ONE-SOURCE (대표 11-28 07:3x/07:5x/08:0x «현재 판 = 가장 중요한 기준선 ·
// 시뮬레이션 월드에서 충분히 검증»). Each scene drives the REAL release graph tick (tickRelease) over a test universe —
// only the outside is faked (clock · step processes · mail) — and reads the REAL board readers (judge butler target ·
// seat-assign guard · steward/work-next board · checklist CLI default · throughput throughputChecklistVersion · bulletin/pulse resolver ·
// land-graph/guardian pointer). Five seeds per scene, both engines:
//   legacy = the tick with an injected writer (flipBoardAfterPublish on the universe ledger · captured announce)
//   graph  = the tick with the CLI's own wiring (defaultExecDeps: flipBoardAfterPublish ⊕ announceBoardFlip → bus ⊕ fact)
// Expectations are independent literals (rule 11). No real ledger, config, bus or fact file is ever opened: the config dir
// override and ELANOUS_STATE_DIR point into ctx.universeRoot for the scene and are restored after it.
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../../../elanous-config-dir.js';
import { checklistVersion } from '../../../cli/release-checklist-read-cli.js';
import { defaultExecDeps } from '../../../cli/release-graph-cli.js';
import { butlerTarget } from '../../../judge-butler/live.js';
import { throughputChecklistVersion } from '../../../loops/throughput-controller-live.js';
import { activeBoardVersion, readBoardPointer, readReleaseGraphVersion, resolveCurrentVersion } from '../../../ops-dashboard/current-version.js';
import { checklistDevVersion } from '../../../release-loop/checklist.js';
import { boardHistoryPath, boardRecordPath, flipBoardAfterPublish, readBoardRecord, setBoard, announceBoardFlip } from '../../../release-loop/current-board.js';
import { createRun, loadRun, markDone, readLedger, tickRelease, type ExecDeps, type Mode, type StepDef } from '../../../release-loop/release-graph-exec.js';
import { liveSeatAssignDeps } from '../../../seat/seat-assign-live.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const seeds = (s: number): number[] => [s, s + 1, s + 2, s + 3, s + 4];
/** Per seed: [published, next] — literal pairs, never computed by the code under test. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [['0.3.38', '0.3.39'], ['0.3.39', '0.3.40'], ['0.4.9', '0.4.10'], ['1.0.0', '1.0.1'], ['0.3.99', '0.3.100']];
const pair = (seed: number) => PAIRS[((seed % 5) + 5) % 5]!;
const PRE_PUBLISH = ['cli-fresh', 'notes', 'roster', 'schedule', 'cut', 'cut-push', 'pregate', 'prebuild', 'prepare', 'rehearsal', 'go', 'notes-public'];
const PUBLISH_AT = '2026-11-27T21:00:00.000Z'; // 06:00 KST
const CLOCK = { rehearsalAt: '2026-11-27T13:00:00.000Z', cutAt: '2026-11-27T19:00:00.000Z', publishAt: PUBLISH_AT };
const OPTS = { seatState: '/sim/seat-state', uid: 501, cli: 'elanous', repo: '/sim/repo', instanceRoot: '/sim/i' };

interface World {
  readonly root: string;
  readonly mail: Array<{ to: string; kind: string; body: string }>;
  readonly started: string[];
  readonly bus: string[];
  readonly facts: string[];
  now: Date;
  exits: Record<string, number>;
  flipThrows: number;
  config(graphVersion: string | null, mode?: string): void;
  deps(mode: Mode): ExecDeps;
  tick(mode: Mode): Promise<void>;
  restore(): void;
}

/** One scene universe: config dir + ledger + state root = `<universe>/<tag>`; the tick sees only it. */
function world(ctx: SimWorldScenarioContext, tag: string, version: string, engine: SimWorldEngine): World {
  const root = join(ctx.universeRoot, tag);
  mkdirSync(root, { recursive: true });
  const prevOverride = getElanousConfigDirOverride();
  const prevState = process.env.ELANOUS_STATE_DIR; const prevFactTest = process.env.ELANOUS_FED_STATE_IN_TEST; const prevSeat = process.env.ELANOUS_SEAT_STATE;
  setElanousConfigDir(root, 'programmatic');
  process.env.ELANOUS_STATE_DIR = root; process.env.ELANOUS_FED_STATE_IN_TEST = '1'; process.env.ELANOUS_SEAT_STATE = join(root, 'seat-state');
  let pid = 1000;
  const w: World = {
    root, mail: [], started: [], bus: [], facts: [], now: new Date('2026-11-27T12:00:00.000Z'), exits: {}, flipThrows: 0,
    config(graphVersion, mode = 'live') {
      writeFileSync(join(root, 'config.json'), `${JSON.stringify({ release: { graph: { mode, ...(graphVersion ? { version: graphVersion } : {}) } } })}\n`);
    },
    deps(mode) {
      const fake: Partial<ExecDeps> = {
        now: () => w.now, mode: () => mode,
        probes: { now: () => w.now, watch: async () => null, mtimeMs: () => null, readJson: () => ({ ok: true }), readLines: () => [],
          cells: async () => [], idleSeats: async () => [], landedCount: async () => 0, handsUpCount: async () => 0, publishedVersions: async () => [], installedVersion: async () => null },
        detect: async (_v: string, step: StepDef) => (detected.has(step.id) ? { at: w.now.toISOString(), evidence: `REL hand ${step.id}` } : null),
        start: (step, _cmd, logPath, rcPath) => { w.started.push(step.id); writeFileSync(logPath, `start ${step.id}\n`); writeFileSync(rcPath, `${w.exits[step.id] ?? 0}\n`); return ++pid; },
        alive: () => false,
        post: (to, kind, body) => { w.mail.push({ to, kind, body }); return `msg#${w.mail.length}`; },
        planOptions: OPTS,
      };
      const unstable = (inner: NonNullable<ExecDeps['flipBoard']>): NonNullable<ExecDeps['flipBoard']> => (p, i) => {
        if (w.flipThrows > 0) { w.flipThrows--; throw new Error('EIO: injected write failure'); }
        return inner(p, i);
      };
      if (engine === 'graph') {
        const d = defaultExecDeps(root, fake);
        return { ...d, flipBoard: unstable(d.flipBoard!) };
      }
      return { stateRoot: root, ...fake, flipBoard: unstable((published, input) => {
        const r = flipBoardAfterPublish({ published, by: input.by, cause: input.cause, now: input.now, ledgerRoot: root });
        const announced = r.kind === 'flipped' ? announceBoardFlip(r.record, { stateRoot: root, busPost: (line) => { w.bus.push(line); }, fact: (rec) => { w.facts.push(`${rec.previous}->${rec.current}`); return true; } }) : undefined;
        return { kind: r.kind, current: r.record.current, previous: r.record.previous, ...(r.kind === 'refused' ? { reason: r.reason } : {}), ...(announced ? { announced } : {}) };
      }) } as ExecDeps;
    },
    async tick(mode) { await tickRelease(version, w.deps(mode)); },
    restore() {
      resetElanousConfigDir(); if (prevOverride) setElanousConfigDir(prevOverride, 'programmatic');
      const put = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
      put('ELANOUS_STATE_DIR', prevState); put('ELANOUS_FED_STATE_IN_TEST', prevFactTest); put('ELANOUS_SEAT_STATE', prevSeat);
    },
  };
  const detected = new Set<string>();
  (w as World & { detected: Set<string> }).detected = detected;
  createRun(root, { version, quick: true, clock: CLOCK, notesFile: join(root, 'notes.md'), prepDir: join(root, 'prep') }, w.now);
  for (const id of PRE_PUBLISH) markDone(root, version, id, 'SIM', 'pre-publish', w.now, OPTS);
  return w;
}
const detectedOf = (w: World): Set<string> => (w as World & { detected: Set<string> }).detected;

/** Every board reader the federation runs, read now. */
function readers(root: string, hq: string): Record<string, string> {
  const butler = butlerTarget({ hqRoot: hq, ledgerRoot: root });
  return {
    steward: activeBoardVersion(),
    checklistDefault: checklistVersion(undefined, {}),
    judgeButler: `${butler.version}${butler.actable ? '' : '(not actable)'}`,
    seatGuard: liveSeatAssignDeps().targetVersion?.() ?? 'null',
    pulse: resolveCurrentVersion({ hqRoot: hq, ledgerRoot: root }).version,
    landGraph: readBoardPointer() ?? 'null',
  };
}
const allEqual = (r: Record<string, string>, v: string): string | null => {
  const bad = Object.entries(r).filter(([, x]) => x !== v);
  return bad.length ? bad.map(([k, x]) => `${k}=${x}`).join(' · ') : null;
};

async function publishTick(w: World): Promise<void> {
  w.now = new Date(Date.parse(PUBLISH_AT) + 10_000); await w.tick('live'); // publish starts (rc written at once)
  w.now = new Date(Date.parse(PUBLISH_AT) + 60_000); await w.tick('live'); // publish done → flip in this tick
}

async function scene(ctx: SimWorldScenarioContext, body: (seed: number, engine: SimWorldEngine) => Promise<SimWorldScenarioOutcome | null>): Promise<SimWorldScenarioOutcome> {
  for (const seed of seeds(ctx.seed)) {
    const out = await body(seed, ctx.engine);
    if (out) return out;
  }
  ctx.recorder.event('board:scene', { scenario: ctx.scenarioId, engine: ctx.engine, seeds: 5 });
  return { ok: true };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'BOARD-PUBLISH-FLIP',
    title: 'publish done → the board flips in the same tick (before npm/verify/dev-bump start) → every reader sees <next> before the next tick · one bus row · one fact',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const [v, next] = pair(seed);
        const w = world(ctx, `flip-${engine}-s${seed}`, v, engine);
        try {
          w.config(v);
          await publishTick(w);
          const rec = readBoardRecord(w.root);
          if (rec?.current !== next || rec.previous !== v) return fail('no-flip', `seed ${seed}: record ${JSON.stringify(rec)}`);
          const bad = allEqual(readers(w.root, join(w.root, 'hq')), next);
          if (bad) return fail('reader-old-board', `seed ${seed}: ${bad}`);
          const rows = readLedger(w.root, v);
          const flipAt = rows.findIndex(r => r.kind === 'board-flip');
          const npmAt = rows.findIndex(r => r.kind === 'started' && r.step === 'npm');
          if (flipAt < 0 || npmAt < 0 || flipAt > npmAt) return fail('flip-after-tail', `seed ${seed}: board-flip row ${flipAt} · npm started row ${npmAt}`);
          const busRows = engine === 'graph' ? readFileSync(join(w.root, 'op-context-bus', 'OP.jsonl'), 'utf8').split('\n').filter(l => l.includes(`board:${next}`)).length : w.bus.length;
          const factRows = engine === 'graph' ? readFileSync(join(w.root, 'fed-state', 'facts.jsonl'), 'utf8').split('\n').filter(l => l.includes('"type":"board"')).length : w.facts.length;
          if (busRows !== 1 || factRows !== 1) return fail('announce-count', `seed ${seed}: bus ${busRows} · fact ${factRows} (want 1 · 1)`);
          await w.tick('live'); // a later tick never flips twice
          if (readBoardRecord(w.root)?.seq !== 1) return fail('double-flip', `seed ${seed}: seq ${readBoardRecord(w.root)?.seq}`);
          return null;
        } finally { w.restore(); }
      });
    },
  },
  {
    id: 'BOARD-PUBLISH-FAIL',
    title: 'publish exits 1 → hard stop, no flip, no record · readers stay on the published-to-be board (release.graph.version)',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const [v] = pair(seed);
        const w = world(ctx, `pubfail-${engine}-s${seed}`, v, engine);
        try {
          w.config(v); w.exits.publish = 1;
          await publishTick(w);
          const st = loadRun(w.root, v)!;
          if (!st.hardStop || st.steps['board-flip']?.status === 'done') return fail('flip-on-failed-publish', `seed ${seed}: hardStop ${st.hardStop?.reason ?? 'none'} · board-flip ${st.steps['board-flip']?.status}`);
          if (existsSync(boardRecordPath(w.root))) return fail('record-written', `seed ${seed}: ${readFileSync(boardRecordPath(w.root), 'utf8')}`);
          const bad = allEqual(readers(w.root, join(w.root, 'hq')), v);
          if (bad) return fail('reader-moved', `seed ${seed}: ${bad}`);
          return null;
        } finally { w.restore(); }
      });
    },
  },
  {
    id: 'BOARD-DEVBUMP-FAIL',
    title: 'dev-bump (and verify) exit 1 after publish → the flip already happened and stays · the dev-bump warning never moves the board',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const [v, next] = pair(seed);
        const w = world(ctx, `devbump-${engine}-s${seed}`, v, engine);
        try {
          w.config(v); w.exits['dev-bump'] = 1; w.exits.verify = 1;
          await publishTick(w);
          w.now = new Date(Date.parse(PUBLISH_AT) + 5 * 60_000); await w.tick('live');
          const st = loadRun(w.root, v)!;
          if (st.steps['dev-bump']?.by !== 'graph(soft-fail)') return fail('devbump-not-failed', `seed ${seed}: dev-bump ${st.steps['dev-bump']?.status}/${st.steps['dev-bump']?.by}`);
          const bad = allEqual(readers(w.root, join(w.root, 'hq')), next);
          if (bad) return fail('reader-old-board', `seed ${seed}: ${bad}`);
          return null;
        } finally { w.restore(); }
      });
    },
  },
  {
    id: 'BOARD-WRITE-FAIL',
    title: 'the flip write fails twice → step pending, readers keep the previous board, ONE card to OP · third tick writes it → readers move',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const [v, next] = pair(seed);
        const w = world(ctx, `writefail-${engine}-s${seed}`, v, engine);
        try {
          w.config(v); w.flipThrows = 2;
          await publishTick(w); // throw 1
          if (loadRun(w.root, v)!.steps['board-flip']?.status !== 'pending') return fail('failed-flip-not-pending', `seed ${seed}: ${loadRun(w.root, v)!.steps['board-flip']?.status}`);
          const bad1 = allEqual(readers(w.root, join(w.root, 'hq')), v);
          if (bad1) return fail('reader-moved-without-record', `seed ${seed}: ${bad1}`);
          w.now = new Date(w.now.getTime() + 60_000); await w.tick('live'); // throw 2
          w.now = new Date(w.now.getTime() + 60_000); await w.tick('live'); // writes
          const cards = w.mail.filter(m => m.to === 'OP' && m.body.includes('current board flip failed')).length;
          if (cards !== 1) return fail('card-count', `seed ${seed}: ${cards} failure cards (want 1)`);
          const bad2 = allEqual(readers(w.root, join(w.root, 'hq')), next);
          if (bad2) return fail('reader-old-board', `seed ${seed}: ${bad2}`);
          return null;
        } finally { w.restore(); }
      });
    },
  },
  {
    id: 'BOARD-RACE',
    title: 'two flips race: a live lock holder is waited for (busy → error, record untouched) · a dead lock (>30 s) is broken · same target twice → flipped + already (seq 1) · an older publish never moves a newer board back',
    async run(ctx) {
      return scene(ctx, async (seed) => {
        const [v, next] = pair(seed);
        const root = join(ctx.universeRoot, `race-s${seed}`);
        const lock = `${boardRecordPath(root)}.lock`;
        mkdirSync(join(root, 'release'), { recursive: true });
        writeFileSync(lock, '4242');
        let busy = '';
        try { flipBoardAfterPublish({ published: v, by: 'A', ledgerRoot: root, lockBudgetMs: 100 }); } catch (e) { busy = String(e); }
        if (!busy.includes('write lock busy') || existsSync(boardRecordPath(root))) return fail('lock-ignored', `seed ${seed}: ${busy || 'no error'}`);
        const old = new Date(Date.now() - 60_000); utimesSync(lock, old, old);
        const a = flipBoardAfterPublish({ published: v, by: 'A', ledgerRoot: root });
        const b = flipBoardAfterPublish({ published: v, by: 'B', ledgerRoot: root });
        if (a.kind !== 'flipped' || b.kind !== 'already' || b.record.seq !== 1 || b.record.by !== 'A') return fail('race-double-write', `seed ${seed}: ${a.kind}/${b.kind} seq ${b.record.seq} by ${b.record.by}`);
        const late = flipBoardAfterPublish({ published: '0.0.1', by: 'C', ledgerRoot: root });
        if (late.kind !== 'refused' || readBoardRecord(root)?.current !== next) return fail('moved-backwards', `seed ${seed}: ${late.kind} → ${readBoardRecord(root)?.current}`);
        if (readFileSync(boardHistoryPath(root), 'utf8').split('\n').filter(Boolean).length !== 1) return fail('history-count', `seed ${seed}: history lines ≠ 1`);
        return null;
      });
    },
  },
  {
    id: 'BOARD-READER-STALE',
    title: 'no reader cache: the same process reads the old board, a flip lands, the very next read is the new board · a corrupt record falls back (never throws) · a removed record falls back',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const [v, next] = pair(seed);
        const w = world(ctx, `stale-${engine}-s${seed}`, v, engine);
        try {
          w.config(v);
          const before = readers(w.root, join(w.root, 'hq'));
          if (allEqual(before, v)) return fail('reader-start', `seed ${seed}: ${allEqual(before, v)}`);
          flipBoardAfterPublish({ published: v, by: 'SIM', ledgerRoot: w.root });
          const bad = allEqual(readers(w.root, join(w.root, 'hq')), next);
          if (bad) return fail('stale-cache', `seed ${seed}: ${bad}`);
          writeFileSync(boardRecordPath(w.root), '{ not json');
          if (activeBoardVersion() !== v || readBoardPointer() !== v) return fail('corrupt-record', `seed ${seed}: ${activeBoardVersion()} / ${readBoardPointer()}`);
          writeFileSync(join(w.root, 'config.json'), '{}\n');
          if (readBoardPointer() !== null) return fail('pointer-invented', `seed ${seed}: ${readBoardPointer()}`);
          if (activeBoardVersion(undefined, () => 'pkg') !== 'pkg') return fail('fallback-broken', `seed ${seed}: ${activeBoardVersion(undefined, () => 'pkg')}`);
          return null;
        } finally { w.restore(); }
      });
    },
  },
  {
    id: 'BOARD-ROLLBACK',
    title: 'hand rollback `release current set <prev>` → every reader goes back · reason + previous recorded · history keeps both flips · the next publish flips forward again',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const [v, next] = pair(seed);
        const w = world(ctx, `rollback-${engine}-s${seed}`, v, engine);
        try {
          w.config(v);
          await publishTick(w);
          const back = setBoard({ to: v, by: 'OP', cause: `sim rollback s${seed}`, ledgerRoot: w.root });
          if (back.kind !== 'flipped' || back.record.previous !== next || back.record.seq !== 2) return fail('rollback-record', `seed ${seed}: ${JSON.stringify(back)}`);
          const bad = allEqual(readers(w.root, join(w.root, 'hq')), v);
          if (bad) return fail('reader-not-rolled-back', `seed ${seed}: ${bad}`);
          if (readFileSync(boardHistoryPath(w.root), 'utf8').split('\n').filter(Boolean).length !== 2) return fail('history-count', `seed ${seed}: ≠ 2 lines`);
          const again = flipBoardAfterPublish({ published: v, by: 'SIM', ledgerRoot: w.root });
          if (again.kind !== 'flipped' || again.record.current !== next || again.record.seq !== 3) return fail('reflip', `seed ${seed}: ${again.kind} ${again.record.current} seq ${again.record.seq}`);
          return null;
        } finally { w.restore(); }
      });
    },
  },
  {
    id: 'BOARD-READERS-AGREE',
    title: 'judge butler · seat-assign guard · steward/work-next · checklist CLI default · throughput (throughputChecklistVersion) · bulletin/pulse resolver · land-graph pointer = one value, before and after the flip',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const [v, next] = pair(seed);
        const w = world(ctx, `agree-${engine}-s${seed}`, v, engine);
        try {
          w.config(v);
          const hq = join(w.root, 'hq');
          if (existsSync(boardRecordPath(w.root)) || butlerTarget({ hqRoot: hq, ledgerRoot: w.root }).source !== 'graph') return fail('fallback-source', `seed ${seed}: expected absent board and graph fallback`);
          const tp1 = await throughputChecklistVersion(hq, w.root);
          const r1 = { ...readers(w.root, hq), throughput: tp1 };
          if (allEqual(r1, v)) return fail('disagree-before', `seed ${seed}: ${allEqual(r1, v)}`);
          await publishTick(w);
          const r2 = { ...readers(w.root, hq), throughput: await throughputChecklistVersion(hq, w.root) };
          if (allEqual(r2, next)) return fail('disagree-after', `seed ${seed}: ${allEqual(r2, next)}`);
          if (butlerTarget({ hqRoot: hq, ledgerRoot: w.root }).source !== 'board') return fail('butler-source', `seed ${seed}: ${butlerTarget({ hqRoot: hq, ledgerRoot: w.root }).source}`);
          return null;
        } finally { w.restore(); }
      });
    },
  },
  {
    id: 'BOARD-SHADOW-HAND',
    title: 'graph in shadow: a would-run publish never flips · REL publishes by hand (detected) → the board flips in that tick, still shadow',
    async run(ctx) {
      return scene(ctx, async (seed, engine) => {
        const [v, next] = pair(seed);
        const w = world(ctx, `shadow-${engine}-s${seed}`, v, engine);
        try {
          w.config(v, 'shadow');
          w.now = new Date(Date.parse(PUBLISH_AT) + 60_000); await w.tick('shadow');
          w.now = new Date(Date.parse(PUBLISH_AT) + 5 * 60_000); await w.tick('shadow');
          if (existsSync(boardRecordPath(w.root)) || w.started.length) return fail('shadow-flipped', `seed ${seed}: record ${existsSync(boardRecordPath(w.root))} · started ${w.started.join(',')}`);
          detectedOf(w).add('publish');
          w.now = new Date(Date.parse(PUBLISH_AT) + 6 * 60_000); await w.tick('shadow');
          if (readBoardRecord(w.root)?.current !== next) return fail('hand-publish-no-flip', `seed ${seed}: ${readBoardRecord(w.root)?.current ?? 'none'}`);
          return null;
        } finally { w.restore(); }
      });
    },
  },
  {
    id: 'BOARD-TIMELINE-1128',
    title: 'the 11-28 morning replayed (06:01 publish · 06:15 dev-bump on main · 06:59 graph.version by hand · 07:23 rail): pre-fix readers read 0.3.38 until 06:59/07:23 · fixed readers read 0.3.39 from the 06:01 tick',
    async run(ctx) {
      // Installed package version and release.graph.version over the morning (KST) — the facts of 11-28, literal.
      const pkgAt = (t: number) => (t < Date.parse('2026-11-27T22:23:00Z') ? '0.3.38-dev.0' : '0.3.39-dev.0');
      const graphAt = (t: number) => (t < Date.parse('2026-11-27T21:59:00Z') ? '0.3.38' : '0.3.39');
      // probe minute (KST) → [pre-fix checklist default, pre-fix board reader] — literal.
      const PRE: ReadonlyArray<readonly [string, string, string]> = [
        ['06:02', '0.3.38', '0.3.38'], ['06:16', '0.3.38', '0.3.38'], ['06:40', '0.3.38', '0.3.38'], ['07:00', '0.3.38', '0.3.39'], ['07:24', '0.3.39', '0.3.39'],
      ];
      return scene(ctx, async (seed, engine) => {
        const w = world(ctx, `timeline-${engine}-s${seed}`, '0.3.38', engine);
        try {
          w.config('0.3.38');
          mkdirSync(join(w.root, 'release', '0.3.38'), { recursive: true });
          writeFileSync(join(w.root, 'release', '0.3.38', 'release.json'), JSON.stringify({ version: '0.3.38', publishedAt: '2026-11-27T21:01:00Z' }));
          const shift = (seed % 3) * 60_000; // seed moves each probe 0–2 min inside its window
          // pre-fix world: no record — the readers' legacy path (graph.version → package · checklist default = package)
          let preWrongMin = 0;
          for (const [hhmm, wantChecklist, wantBoard] of PRE) {
            const t = Date.parse(`2026-11-28T${hhmm}:00+09:00`) + shift;
            w.config(graphAt(t));
            const checklistOld = checklistDevVersion(pkgAt(t));
            const boardOld = activeBoardVersion(() => readReleaseGraphVersion(), () => checklistDevVersion(pkgAt(t)));
            if (checklistOld !== wantChecklist || boardOld !== wantBoard) return fail('pre-fix-model', `seed ${seed} ${hhmm}: checklist ${checklistOld} board ${boardOld} (want ${wantChecklist}/${wantBoard})`);
            if (checklistOld !== '0.3.39') preWrongMin++;
          }
          if (preWrongMin !== 4) return fail('pre-fix-model', `seed ${seed}: ${preWrongMin} of 5 probes on the closed board (want 4)`);
          // fixed world: the 06:01 tick flips; every probe after it reads 0.3.39 whatever the package/graph say
          w.config('0.3.38');
          await publishTick(w);
          for (const [hhmm] of PRE) {
            const t = Date.parse(`2026-11-28T${hhmm}:00+09:00`) + shift;
            w.config(graphAt(t));
            const fixed = { ...readers(w.root, join(w.root, 'hq')), board: activeBoardVersion(undefined, () => checklistDevVersion(pkgAt(t))), throughput: await throughputChecklistVersion(join(w.root, 'hq'), w.root) };
            const bad = allEqual(fixed, '0.3.39');
            if (bad) return fail('fixed-reader-old-board', `seed ${seed} ${hhmm}: ${bad}`);
          }
          ctx.recorder.event('board:timeline', { seed, engine, preFixProbesOnClosedBoard: preWrongMin, fixedProbesOnClosedBoard: 0 });
          return null;
        } finally { w.restore(); }
      });
    },
  },
];
