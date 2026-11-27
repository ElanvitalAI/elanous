/**
 * `elanous release graph …` — operator surface of the release graph executor (src/release-loop/release-graph-exec.ts).
 *
 *   plan <v>                 step DAG · needs · would-run commands · critical path vs serial (manual) minutes
 *   run <v> [--resume X]     create the run (first time: --rehearsal-at/--cut-at/--publish-at) and tick once (--watch: until done)
 *   mark <v> <step|L-n>      a human/REL did it — the DAG continues from there (--by · --ref required)
 *   nogo <v>                 explicit NO-GO (CEO/REL/OP/security) — the only non-mechanical hard stop
 *   status <v>               «graph would-run vs REL actual» per step
 *   board [<v>]              interactive Release Board (TUI) · --replay <scenario> = test universe
 *   tick                     one tick over every run (the trigger-registry graph graphs/release/release-rocket.yaml calls this)
 *
 * Mode is never a flag: live only when config `release.graph.mode` = live AND `release.graph.version` = <v>; else shadow.
 */
import type { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { userConfigPath } from '../user-config.js';
import { defaultConditionProbes } from '../loops/trigger-conditions.js';
import { readSchedule } from '../release-loop/feature-store.js';
import { dispatchScheduledGraph } from '../release-loop/scheduled-graph-dispatch.js';
import {
  compareTable, configuredMode, createRun, criticalPath, defaultDetect, defaultStart, listRuns, loadRun, createRehearsal, markDone, enterQuickSurgery, noGoWith, skipStep, pidAlive, rehearsalKey, rehearsalReceiptPath,
  releaseHome, releaseSteps, resumeFrom, runDir, stepsFor, tickRelease, type ExecDeps, type PlanOptions, type PlanPaths, type ReleaseClock,
} from '../release-loop/release-graph-exec.js';

function readConfig(): Record<string, unknown> | null {
  const path = getElanousConfigDirOverride() ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath();
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : null; } catch { return null; }
}

function graphConfig(): { cli?: string; cwd?: string } {
  const g = (readConfig() as { release?: { graph?: { cli?: unknown; cwd?: unknown } } } | null)?.release?.graph;
  return { ...(typeof g?.cli === 'string' ? { cli: g.cli } : {}), ...(typeof g?.cwd === 'string' ? { cwd: g.cwd } : {}) };
}

function seatState(): string { return process.env.ELANOUS_SEAT_STATE ?? join(homedir(), 'elanous-hq', 'seat-state'); }

export interface ReleaseGraphCliDeps {
  exec?: (stateRoot: string) => Partial<ExecDeps>; stateRoot?: string;
  graphConfig?: () => { mode?: unknown; version?: unknown } | undefined;
  schedule?: (version: string) => ReturnType<typeof readSchedule>;
  heartbeat?: (event: { name: string; saw: number; everyMin: number; last?: string; err?: string }) => void;
}

/** One scheduler step. All side effects are supplied by the caller for isolated tests. */
export async function scheduleGraphTick(input: {
  stateRoot: string; version?: string; d: ExecDeps;
  schedule: (version: string) => ReturnType<typeof readSchedule>;
}): Promise<string> {
  const { stateRoot, version, d } = input;
  if (!version || d.mode(version) !== 'live') return 'none';
  const hasRun = !!loadRun(stateRoot, version);
  // An existing run does not depend on the schedule store remaining available.
  let schedule: ReturnType<typeof readSchedule> = null;
  if (!hasRun) {
    try { schedule = input.schedule(version); }
    catch (error) {
      d.post('OP', 'alert', `🔴 release graph ${version}: no run; cannot read schedule: ${error instanceof Error ? error.message : String(error)}`);
      return 'red';
    }
  }
  const outcome = await dispatchScheduledGraph({
    mode: 'live', version, now: d.now(), hasRun,
    schedule, claimPath: join(stateRoot, 'release-graph', 'schedule-claims.sqlite'),
    red: async (v, reason) => { d.post('OP', 'alert', `🔴 release graph ${v}: ${reason}`); },
    create: async (v, clock) => { createRun(stateRoot, { version: v, quick: true, clock }, d.now()); },
  });
  if (outcome === 'already-claimed' && !loadRun(stateRoot, version)) {
    d.post('OP', 'alert', `🔴 release graph ${version}: creation claim exists without a run; reconcile before retry`);
    return 'red';
  }
  return outcome;
}

export function defaultExecDeps(stateRoot: string, over: Partial<ExecDeps> = {}): ExecDeps {
  const cfg = graphConfig();
  const repo = cfg.cwd ?? join(homedir(), 'elanous-hq', 'repo.git');
  const planOptions: PlanOptions & PlanPaths = { seatState: seatState(), repo, instanceRoot: effectiveInstanceRoot(), ...(cfg.cli ? { cli: cfg.cli } : {}) };
  return {
    now: () => new Date(),
    stateRoot,
    mode: (v) => configuredMode(v, readConfig()),
    probes: defaultConditionProbes(),
    detect: defaultDetect({ seatState: seatState(), repo }),
    start: defaultStart(repo),
    alive: pidAlive,
    post: (to, kind, body) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { openMsgStore } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
      const store = openMsgStore();
      try { return `msg#${store.post({ from: 'release-graph', to, kind, body } as Parameters<typeof store.post>[0]).id}`; } finally { store.close(); }
    },
    planOptions,
    ...over,
  };
}

/**
 * The rehearsal = an instance run of the release graph's rehearsal subgraph. Every attempt is its own instance:
 * the previous attempt moves to `<v>-rehearsal#<n>` (history kept, the release run `<v>` never touched) and the
 * next tick starts a new one at `<v>-rehearsal`.
 */
export function archiveRehearsal(stateRoot: string, version: string): string | null {
  const dir = runDir(stateRoot, rehearsalKey(version));
  if (!existsSync(dir)) return null;
  let n = 1;
  while (existsSync(`${dir}#${n}`)) n++;
  renameSync(dir, `${dir}#${n}`);
  return `${dir}#${n}`;
}

/** `--at` replays the countdown on a virtual clock — shadow only, so a replay can never execute a release step. */
function virtualClock(d: ExecDeps, version: string, at?: string): ExecDeps {
  if (!at) return d;
  if (Number.isNaN(Date.parse(at))) throw new Error(`--at must be an ISO time: ${at}`);
  if (d.mode(version.replace(/-rehearsal$/, '')) === 'live') throw new Error('--at is shadow-only; this version is configured live');
  const fixed = new Date(at);
  return { ...d, now: () => fixed, probes: { ...d.probes, now: () => fixed } };
}

function out(value: unknown, json?: boolean, human?: () => void): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else if (human) human();
  else console.log(JSON.stringify(value, null, 2));
}

function fail(e: unknown, json?: boolean): void {
  const message = e instanceof Error ? e.message : String(e);
  if (json) process.stdout.write(`${JSON.stringify({ outcome: 'error', ok: false, error: message })}\n`); else console.error(`⛔ release graph: ${message}`);
  process.exitCode = 1;
}

function printTable(version: string, stateRoot: string, opts?: PlanOptions): void {
  const state = loadRun(stateRoot, version);
  if (!state) { console.log(`no run for ${version}`); return; }
  const kst = (iso: string | null) => iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ') : '—';
  console.log(`release graph ${version} · ${state.quick ? 'quick' : 'full'} · ${state.profile ?? 'quick-surgery'} · ${state.hardStop ? `HARD STOP: ${state.hardStop.reason}` : state.done ? 'finished' : 'open'}`);
  console.log('phase | step | status | graph would-run/start (KST) | REL actual (KST) | Δmin | by | warnings');
  for (const r of compareTable(state, opts)) console.log(`${r.phase} | ${r.step} | ${r.status} | ${kst(r.graphAt)} | ${kst(r.relActual)} | ${r.deltaMin ?? '—'} | ${r.by ?? '—'} | ${r.warnings}`);
}

export function registerReleaseGraphCommands(release: Command, deps: ReleaseGraphCliDeps = {}): void {
  const graph = release.command('graph').description('발사 카운트다운 그래프 — 손 퀵패스 순서를 그대로 걷는 DAG · 기본 그림자 · 실행은 config release.graph.mode=live + version 일치 때만');
  const root = () => deps.stateRoot ?? effectiveInstanceRoot();
  const exec = (stateRoot: string) => defaultExecDeps(stateRoot, deps.exec?.(stateRoot) ?? {});

  graph.command('plan <version>').description('단계·needs·실행 명령·크리티컬 패스(기대 분) — 읽기 전용')
    .option('--rehearsal-at <iso>').option('--cut-at <iso>').option('--publish-at <iso>').option('--demo-at <iso>')
    .option('--full', 'L-0…L-9 전체(기본 = 퀵패스)').option('--json')
    .action((version: string, o: { rehearsalAt?: string; cutAt?: string; publishAt?: string; demoAt?: string; full?: boolean; json?: boolean }) => {
      try {
        const existing = loadRun(root(), version);
        const clock: ReleaseClock = existing?.clock ?? { rehearsalAt: o.rehearsalAt ?? '', cutAt: o.cutAt ?? '', publishAt: o.publishAt ?? '', ...(o.demoAt ? { demoAt: o.demoAt } : {}) };
        const files = existing ?? { notesFile: join(releaseHome(version), `notes-${version}-final.md`), prepDir: join(releaseHome(version), 'critpath-prepared') };
        const planOpts = exec(root()).planOptions;
        const steps = existing ? stepsFor(existing, planOpts) : releaseSteps(version, clock, files, planOpts).filter(s => o.full || s.quick);
        const cp = criticalPath(steps);
        const value = { version, quick: !o.full, steps: steps.map(s => ({ id: s.id, phase: s.phase, needs: s.needs, host: s.host, hard: s.hard, always: !!s.always, expectMin: s.expectMin, clock: s.clock ?? null, cmd: s.cmd, checks: s.checks.map(c => c.id) })), criticalPath: cp };
        out(value, o.json, () => {
          for (const s of value.steps) console.log(`${s.phase} ${s.id}${s.hard ? ' [hard]' : ''} ← ${s.needs.join(',') || '—'} @${s.host}${s.clock ? ` clock ${s.clock.anchor}${s.clock.offsetMin >= 0 ? '+' : ''}${s.clock.offsetMin}m` : ''}\n    ${s.cmd ?? '(gate · checks only)'}${s.checks.length ? `\n    advisory: ${s.checks.join(', ')}` : ''}`);
          console.log(`critical path: ${cp.path.join(' → ')} = ${cp.minutes} min of work (serial sum ${cp.serialMinutes} min)`);
        });
      } catch (e) { fail(e, o.json); }
    });

  graph.command('run <version>').description('런 만들기(처음엔 시각 필수) ⊕ 한 틱 · --resume 단계/L-n 부터 · --watch 끝날 때까지')
    .option('--rehearsal-at <iso>').option('--cut-at <iso>').option('--publish-at <iso>').option('--demo-at <iso>')
    .option('--notes-file <md>', '공개 노트(기본 ~/.elanous/release/<v>/notes-<v>-final.md · 없으면 release/<v>-draft.md → release/next.md)')
    .option('--prep-dir <dir>', 'prepare 산출 폴더(기본 <instance>/release/<v>/critpath-prepared)')
    .option('--quick', '퀵패스(기본)').option('--quick-surgery', '공식 퀵 서저리 발행(기본 프로필) — 비크리티컬 거부는 경고 · 병렬 · mark/skip 사유')
    .option('--normal', '가드 런 — 비크리티컬 거부도 멈춤 · 발행 60분 전 멈춰 있으면 스스로 quick-surgery 로 전환').option('--full', 'L-0…L-9 전체')
    .option('--resume <step>', '이 단계(또는 L-n)부터 다시 — 조상 단계는 완료 처리 · 정지 해제')
    .option('--by <seat>', '--resume 기록자', 'OP')
    .option('--watch', '끝·정지까지 30초마다 틱')
    .option('--at <iso>', '가상 시각(그림자 전용 · 시험 우주 예행) — live 에서는 거부')
    .option('--json')
    .action(async (version: string, o: { rehearsalAt?: string; cutAt?: string; publishAt?: string; demoAt?: string; notesFile?: string; prepDir?: string; full?: boolean; resume?: string; by: string; watch?: boolean; at?: string; json?: boolean; quickSurgery?: boolean; normal?: boolean }) => {
      try {
        const stateRoot = root();
        if (o.quickSurgery && o.normal) throw new Error('--quick-surgery and --normal are exclusive');
        const d = virtualClock(exec(stateRoot), version, o.at);
        if (!loadRun(stateRoot, version)) {
          if (!o.cutAt || !o.publishAt) throw new Error('first run needs --cut-at and --publish-at (and --rehearsal-at)');
          createRun(stateRoot, { version, quick: !o.full, clock: { rehearsalAt: o.rehearsalAt ?? o.cutAt, cutAt: o.cutAt, publishAt: o.publishAt, ...(o.demoAt ? { demoAt: o.demoAt } : {}) },
            ...(o.notesFile ? { notesFile: o.notesFile } : {}), ...(o.prepDir ? { prepDir: o.prepDir } : {}), profile: o.normal ? 'normal' : 'quick-surgery' }, d.now());
          // The rehearsal is the dry-run subset of the same DAG; the tick fires it at --rehearsal-at.
          if (o.rehearsalAt) createRehearsal(stateRoot, { version, clock: loadRun(stateRoot, version)!.clock }, d.now());
        }
        else if (o.quickSurgery) enterQuickSurgery(stateRoot, version, o.by, d.now(), d.planOptions);
        if (o.resume) resumeFrom(stateRoot, version, o.resume, o.by, d.now(), d.planOptions);
        let summary = await tickRelease(version, d);
        while (o.watch && !summary.done && !summary.hardStop) {
          await new Promise(r => setTimeout(r, 30_000)); // Source: tick grain for a foreground watch; steps run detached.
          summary = await tickRelease(version, d);
        }
        out({ ok: !summary.hardStop, ...summary }, o.json, () => printTable(version, stateRoot, d.planOptions));
      } catch (e) { fail(e, o.json); }
    });

  graph.command('rehearse <version>').description('예행 = 같은 DAG 의 dry-run 부분(push·publish·tag·rail·update-all 없음) · 끝나면 영수 rehearsal-receipt.json(실발행엔 권고 입력)')
    .option('--rehearsal-at <iso>', '예행 시각(기본 지금 · 트리거 틱이 이 시각에 발사)').option('--watch', '끝날 때까지 30초마다 틱').option('--fresh', '진행 중인 예행도 <v>-rehearsal#<n> 으로 보관하고 새 인스턴스로 발사(끝난 예행은 기본으로 새 인스턴스 · 실발행 run 은 건드리지 않음)').option('--json')
    .action(async (version: string, o: { rehearsalAt?: string; watch?: boolean; fresh?: boolean; json?: boolean }) => {
      try {
        const stateRoot = root();
        const d = exec(stateRoot);
        const prev = loadRun(stateRoot, rehearsalKey(version));
        if (prev && (prev.done || o.fresh)) archiveRehearsal(stateRoot, version); // rerun = new instance
        const at = o.rehearsalAt ?? d.now().toISOString();
        const release = loadRun(stateRoot, version);
        createRehearsal(stateRoot, { version, clock: release ? { ...release.clock, rehearsalAt: at } : { rehearsalAt: at, cutAt: at, publishAt: at } }, d.now());
        const key = rehearsalKey(version);
        let summary = await tickRelease(key, d);
        while (o.watch && !summary.done) {
          await new Promise(r => setTimeout(r, 30_000)); // Source: tick grain for a foreground watch; steps run detached.
          summary = await tickRelease(key, d);
        }
        out({ ok: !summary.hardStop, receipt: rehearsalReceiptPath(version), ...summary }, o.json, () => printTable(key, stateRoot, d.planOptions));
      } catch (e) { fail(e, o.json); }
    });

  graph.command('mark <version> <step>').description('사람·REL 이 손으로 한 단계 표시 — 그래프는 거기서 이어 간다')
    .requiredOption('--by <seat>', '누가').requiredOption('--ref <ref>', 'msg#… · 영수 경로').option('--json')
    .action((version: string, step: string, o: { by: string; ref: string; json?: boolean }) => {
      try { const d = exec(root()); const s = markDone(root(), version, step, o.by, o.ref, d.now(), d.planOptions); out({ ok: true, version, step, steps: s.steps }, o.json, () => printTable(version, root(), d.planOptions)); }
      catch (e) { fail(e, o.json); }
    });

  graph.command('skip <version> <step>').description('퀵 서저리 — 단계를 사유와 함께 건너뜀(의존 단계는 충족으로 본다) · 그 단계가 멈춤 원인이면 멈춤 해제')
    .requiredOption('--by <seat>', '누가').requiredOption('--reason <text>', '왜 건너뛰나(영수에 남는다)').option('--json')
    .action((version: string, step: string, o: { by: string; reason: string; json?: boolean }) => {
      try { const d = exec(root()); const s = skipStep(root(), version, step, o.by, o.reason, d.now(), d.planOptions); out({ ok: true, version, step, hardStop: s.hardStop ?? null, steps: s.steps }, o.json, () => printTable(version, root(), d.planOptions)); }
      catch (e) { fail(e, o.json); }
    });

  graph.command('nogo <version>').description('명시 NO-GO(CEO·REL·OP·보안) — 유일한 비기계 정지')
    .requiredOption('--by <seat>').requiredOption('--reason <text>')
    .option('--security <kind>', 'security-4 finding: boundary | auth | secret | destructive').option('--json')
    .action((version: string, o: { by: string; reason: string; security?: string; json?: boolean }) => {
      try {
        if (o.security && !['boundary', 'auth', 'secret', 'destructive'].includes(o.security)) throw new Error('--security must be boundary|auth|secret|destructive');
        const s = noGoWith(root(), version, o.by, o.reason, new Date(), o.security); out({ ok: true, hardStop: s.hardStop }, o.json);
      } catch (e) { fail(e, o.json); }
    });

  graph.command('status <version>').description('«그래프 would-run vs REL 실제» 단계별 표').option('--json')
    .action((version: string, o: { json?: boolean }) => {
      try {
        const s = loadRun(root(), version);
        if (!s) throw new Error(`no run for ${version}`);
        const planOpts = exec(root()).planOptions;
        out({ version, runId: version, kind: s.kind ?? 'release', instance: Number(/#(\d+)$/.exec(version)?.[1] ?? 0) || (s.kind === 'rehearsal' ? 'latest' : null), mode: configuredMode(s.version, readConfig()), hardStop: s.hardStop ?? null, done: !!s.done, rows: compareTable(s, planOpts), runDir: runDir(root(), version) }, o.json, () => printTable(version, root(), planOpts));
      } catch (e) { fail(e, o.json); }
    });

  graph.command('board [version]').description('Release Board — interactive TUI of the release graph (↑↓ Enter · m/s/r for OP/REL with confirmation · p preview · ? help)')
    .option('--replay <scenario>', 'test universe + synthetic events through the real graph code (demo · clean · critical-stop · slow-lane)')
    .option('--seed <n>', 'replay seed', '1').option('--speed <n>', 'replay speed multiplier', '1')
    .option('--run <key>', 'pin a run instance (e.g. 0.3.36-rehearsal); default follows the newest')
    .option('--as <seat>', 'who you are for m/s/r (default $ELANOUS_TRACK / $ELANOUS_SEAT)')
    .option('--once', 'print one frame and exit (also when stdout is not a terminal)')
    .option('--width <n>').option('--height <n>')
    .action(async (version: string | undefined, o: { replay?: string; seed: string; speed: string; run?: string; as?: string; once?: boolean; width?: string; height?: string }) => {
      try {
        const { runReleaseBoard, defaultTrafficRoots } = await import('./release-board-cli.js');
        const stateRoot = root();
        const role = (o.as ?? process.env.ELANOUS_TRACK ?? process.env.ELANOUS_SEAT ?? '').trim().toUpperCase() || null;
        await runReleaseBoard({
          ...(version ? { version } : {}), stateRoot, mode: (v) => configuredMode(v, readConfig()),
          universe: getElanousConfigDirOverride() ? 'test' : 'operating', trafficRoots: defaultTrafficRoots(seatState(), stateRoot),
          planOptions: exec(stateRoot).planOptions, role,
          ...(o.replay ? { replay: o.replay } : {}), seed: Number(o.seed) || 1, speed: Number(o.speed) || 1,
          ...(o.run ? { run: o.run } : {}), ...(o.once ? { once: true } : {}),
          ...(o.width ? { width: Number(o.width) } : {}), ...(o.height ? { height: Number(o.height) } : {}),
        });
      } catch (e) { fail(e); }
    });

  graph.command('tick').description('모든 런 한 틱(트리거 그래프 graphs/release/release-rocket.yaml 이 부른다)')
    .option('--at <iso>', '가상 시각(그림자 전용)').option('--json')
    .action(async (o: { at?: string; json?: boolean }) => {
      try {
        const stateRoot = root();
        const d = exec(stateRoot);
        const config = deps.graphConfig ? deps.graphConfig() : (readConfig() as { release?: { graph?: { mode?: unknown; version?: unknown } } } | null)?.release?.graph;
        // Virtual-clock replays never create live runs or post live alerts.
        let scheduleOutcome = 'none';
        if (!o.at && config?.mode === 'live') {
          if (typeof config.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(config.version)) {
            d.post('OP', 'alert', `🔴 release graph: invalid configured live version ${String(config.version)}`);
            scheduleOutcome = 'red';
          } else scheduleOutcome = await scheduleGraphTick({ stateRoot, version: config.version, d, schedule: deps.schedule ?? (v => readSchedule(v)) });
        }
        const results = [];
        for (const v of listRuns(stateRoot)) {
          const s = loadRun(stateRoot, v);
          const vd = virtualClock(d, v, o.at);
          // A finished run keeps ticking until publish + 4h so REL's later hand steps still land in the comparison table.
          if (!s || (s.done && vd.now().getTime() > Date.parse(s.clock.publishAt) + 4 * 3600_000)) continue;
          results.push(await tickRelease(v, vd));
        }
        mkdirSync(join(stateRoot, 'release-graph'), { recursive: true });
        // Goal file for the trigger registry (file-mtime): proves the tick ran this window.
        writeFileSync(join(stateRoot, 'release-graph', 'last-tick.json'), `${JSON.stringify({ at: d.now().toISOString(), runs: results.map(r => ({ version: r.version, mode: r.mode, events: r.events.length, done: r.done, hardStop: r.hardStop })) })}\n`);
        const beat = deps.heartbeat ?? (await import('../kit/heartbeat/index.js')).beatSafe;
        beat({ name: 'release-graph-tick', saw: results.length, everyMin: 5, last: d.now().toISOString() });
        out({ outcome: scheduleOutcome === 'red' ? 'red' : 'ok', ok: scheduleOutcome !== 'red', scheduleOutcome, runs: results.map(r => ({ version: r.version, mode: r.mode, events: r.events.map(e => `${e.kind}${e.step ? `:${e.step}` : ''}`), done: r.done, hardStop: r.hardStop })) }, o.json);
      } catch (e) { (deps.heartbeat ?? (await import('../kit/heartbeat/index.js')).beatSafe)({ name: 'release-graph-tick', saw: 0, everyMin: 5, err: e instanceof Error ? e.message : String(e) }); fail(e, o.json); }
    });
}
