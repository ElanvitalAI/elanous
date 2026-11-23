// SIM-WORLD-KERNEL (S1) — runs the reserved world packs scenario × engine with one seed (SIM-WORLD §4).
//   eln --test sim world run memory|ta|graph|supervisors|all --seed N [--engine legacy|graph|both] [--only ID]
// Packs: src/ux-sim/worlds/sim-world-<world>.yaml rows { id, module }; the module exports `simWorldScenarios`
// (and optionally `simWorldDevices`, the device registration hook). Expectations: src/ux-sim/worlds/sim-world-expect.json.
// Each scenario run gets its own test universe (<run>/.universe/<dir>) set as the test state root while it runs;
// a non-empty pack runs in its own OS network sandbox process (scripts/sim-world-runner.ts), because fake-clock is
// process-global (fake-clock.ts:16) — worlds run in parallel processes, scenarios inside a world run serially; with
// isolate: 'inline' every world shares this process, so worlds run serially too. A scenario id may appear in one pack only.
// Every skip / refuse / infra branch becomes a summary event (and a debug.log row); none is a silent pass.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../../debug/log.js';
import { getTestStateRoot, setTestStateRoot } from '../../nexus/paths.js';
import { sandboxedRunnerCommand } from '../world.js';
import { compareDeviceResponseShapes, deviceFidelityStatus } from '../device-fidelity.js';
import { classifySimWorldOutcome, judgeSimWorldScenario, resolveSimWorldExpectation, SIM_WORLD_RED_VERDICTS } from './expect.js';
import { readSimWorldExpectTable } from './expect-load.js';
import { checkSimWorldRatchet } from './ratchet.js';
import { canonicalJson, createSimWorldRecorder, SIM_WORLD_RECORD_FILES, type SimWorldRecorderOptions } from './recorder.js';
import { SIM_WORLD_IDS, type SimWorldDeviceDef, type SimWorldEngine, type SimWorldEngineOption, type SimWorldExpectTable, type SimWorldPack,
  type SimWorldPackId, type SimWorldReservedId, type SimWorldScenario, type SimWorldSummary, type SimWorldVerdict, type SimWorldVerdictRecord } from './types.js';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const SIM_WORLD_PACK_ROOT = join(REPO_ROOT, 'src/ux-sim/worlds');
const VERDICTS: readonly SimWorldVerdict[] = ['pass', 'xfail', 'promoted', 'promote-required', 'regression', 'ratchet-violation', 'infra-error', 'unlisted',
  'wrong-reason-red', 'unmeasured', 'malformed', 'contract-violation'];

export type SimWorldKernelEvent = SimWorldSummary['events'][number];
type Row = SimWorldVerdictRecord & { readonly dir: string; readonly wallMs: number };
export interface SimWorldPackRequest {
  readonly world: SimWorldPackId;
  readonly seed: number;
  readonly engine: SimWorldEngineOption;
  readonly only: string | null;
  readonly runDir: string;
  readonly packRoot: string;
  readonly expectFile: string;
  readonly expectBaseFile: string | null;
}
export interface SimWorldRunOptions extends Omit<SimWorldPackRequest, 'world' | 'runDir' | 'packRoot' | 'expectFile'> {
  readonly worldId: SimWorldReservedId;
  readonly stateRoot: string;
  readonly runId: string;
  readonly packRoot?: string;
  readonly expectFile?: string;
  /** 'sandbox' (default) spawns one network-zero process per non-empty pack; 'inline' runs in this process. */
  readonly isolate?: 'sandbox' | 'inline';
  /** With worldId 'all': run exactly these worlds (a replay restores the recorded list, not the current registry). */
  readonly worlds?: readonly SimWorldPackId[];
  /** Test seam for the disk-failure axis. */
  readonly recorderFs?: SimWorldRecorderOptions['fs'];
  /** Per-world wall budget; defaults to SIM_WORLD_WALL_BUDGET_MS. */
  readonly wallBudgetMs?: number;
  /** Repository whose refs/remotes/origin/main is recorded as summary.mainSha; defaults to this checkout. */
  readonly mainRefRoot?: string;
  /** Sandbox pack runner; defaults to the OS network-zero runner (tests inject a failing one). */
  readonly runPack?: (request: SimWorldPackRequest) => Promise<{ readonly rows: (SimWorldVerdictRecord & { readonly dir: string; readonly wallMs: number })[]; readonly events: SimWorldKernelEvent[] }>;
}

export const isReservedSimWorldId = (id: string): id is SimWorldReservedId => id === 'all' || (SIM_WORLD_IDS as readonly string[]).includes(id);

function kernelEvent(events: SimWorldKernelEvent[], kind: string, world: SimWorldPackId | null, detail: string): void {
  events.push({ kind, world, detail });
  debug.log('ux.sim.world-kernel', kind, { world, detail });
}

function loadSimWorldPack(world: SimWorldPackId, packRoot: string): SimWorldPack {
  const file = join(packRoot, `sim-world-${world}.yaml`);
  const value = parseYaml(readFileSync(file, 'utf8')) as Partial<SimWorldPack> | null;
  if (!value || value.schema !== 1 || value.world !== world || !Array.isArray(value.scenarios))
    throw new Error(`sim world pack is invalid (needs schema: 1, world: ${world}, scenarios: []): ${file}`);
  const ids = new Set<string>();
  for (const row of value.scenarios) {
    if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(row.id) || ids.has(row.id)
      || typeof row.module !== 'string' || !/^src\/ux-sim\/sim-world\/[A-Za-z0-9/_.-]+\.ts$/u.test(row.module) || row.module.includes('..'))
      throw new Error(`sim world pack row is invalid or duplicated in ${file}: ${JSON.stringify(row)}`);
    ids.add(row.id);
  }
  return value as SimWorldPack;
}

// #126458 P0 SIM-WORLD-REGISTRY-NO-SHARED-EDIT: 기대표는 월드별 조각 worlds/expect/<world>.json 이 원천.
// 레거시 단일 sim-world-expect.json 이 그 자리에 있으면(테스트 fixture 등) 그것이 원천으로 이긴다.
const readTable = (file: string): SimWorldExpectTable => readSimWorldExpectTable(file);
const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '(empty diff)';
function seededRandom(key: string): () => number {
  let state = createHash('sha256').update(key).digest().readUInt32LE(0);
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Run one pack in this process. The sandbox runner calls this; tests call it with isolate: 'inline'. */
export async function runSimWorldPackInProcess(request: SimWorldPackRequest, recorderFs?: SimWorldRecorderOptions['fs']):
  Promise<{ readonly rows: Row[]; readonly events: SimWorldKernelEvent[] }> {
  const { world, seed } = request;
  const rows: Row[] = [];
  const events: SimWorldKernelEvent[] = [];
  const head = readTable(request.expectFile);
  const base = request.expectBaseFile ? readTable(request.expectBaseFile) : null;
  const pack = loadSimWorldPack(world, request.packRoot);
  const selected = pack.scenarios.filter((row) => request.only === null || row.id === request.only);
  if (selected.length < pack.scenarios.length) kernelEvent(events, 'only-filtered', world, `${pack.scenarios.length - selected.length} skipped by --only ${request.only}`);
  const engines: SimWorldEngine[] = request.engine === 'both' ? ['legacy', 'graph'] : [request.engine];
  const modules = new Map<string, { scenarios: readonly SimWorldScenario[]; devices: readonly SimWorldDeviceDef[] } | Error>();
  const devices = new Map<string, SimWorldDeviceDef | 'conflict'>();
  for (const module of new Set(selected.map((row) => row.module))) {
    try {
      const loaded = await import(join(REPO_ROOT, module)) as { simWorldScenarios?: unknown; simWorldDevices?: unknown };
      if (!Array.isArray(loaded.simWorldScenarios)) throw new Error('module does not export simWorldScenarios[]');
      const defs = (Array.isArray(loaded.simWorldDevices) ? loaded.simWorldDevices : []) as SimWorldDeviceDef[];
      for (const def of defs) {
        const prior = devices.get(def.id);
        if (prior && prior !== def) { devices.set(def.id, 'conflict'); kernelEvent(events, 'device-conflict', world, `${def.id} exported by more than one module`); }
        else devices.set(def.id, def);
      }
      modules.set(module, { scenarios: loaded.simWorldScenarios as SimWorldScenario[], devices: defs });
    } catch (error) {
      modules.set(module, error instanceof Error ? error : new Error(String(error)));
      kernelEvent(events, 'module-load-failed', world, `${module}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const row of selected) {
    for (const engine of engines) {
      const dirName = request.engine === 'both' ? `${row.id}@${engine}` : row.id;
      const loaded = modules.get(row.module)!;
      const scenario = loaded instanceof Error ? undefined : loaded.scenarios.find((item) => item.id === row.id);
      if (scenario?.engines && !scenario.engines.includes(engine)) {
        kernelEvent(events, 'engine-unsupported', world, `${row.id} does not run on ${engine}`);
        continue;
      }
      const recorder = createSimWorldRecorder({ dir: join(request.runDir, dirName), world, scenario: row.id, engine, seed, ...(recorderFs ? { fs: recorderFs } : {}) });
      const universeRoot = join(request.runDir, '.universe', dirName);
      let actual: SimWorldVerdictRecord['actual'];
      let diff: string | null = null;
      let observedReason: string | null = null;
      const contractProblems: string[] = [];
      const prior = getTestStateRoot();
      const created: [SimWorldDeviceDef, unknown][] = [];
      const startedAt = performance.now();
      try {
        if (loaded instanceof Error) throw new Error(`module load failed: ${loaded.message}`);
        if (!scenario) throw new Error(`${row.module} does not export scenario ${row.id}`);
        mkdirSync(universeRoot, { recursive: true });
        setTestStateRoot(universeRoot);
        const deviceCtx = { world, scenarioId: row.id, seed, engine, universeRoot, recorder };
        for (const id of scenario.devices ?? []) {
          const def = devices.get(id);
          if (!def || def === 'conflict') throw new Error(`device ${id} is ${def ? 'exported by more than one module' : 'not registered'}`);
          created.push([def, await def.create(deviceCtx)]);
        }
        const instances = new Map(created.map(([def, instance]) => [def.id, instance]));
        const raw: unknown = await scenario.run({ ...deviceCtx, random: seededRandom(`${seed}:${world}:${row.id}:${engine}`), ...(request.only ? { only: request.only } : {}),
          device: <T>(id: string): T => { if (!instances.has(id)) throw new Error(`device ${id} is not listed by ${row.id}`); return instances.get(id) as T; } });
        const outcome = classifySimWorldOutcome(raw);
        actual = outcome.actual;
        diff = outcome.diff === null ? null : firstLine(outcome.diff);
        observedReason = outcome.reason;
        for (const [def, instance] of created) {
          for (const contract of def.contracts ?? []) {
            if (!/^src\/ux-sim\/[A-Za-z0-9/._-]+\.json$/u.test(contract.recording) || contract.recording.includes('..'))
              throw new Error(`device ${def.id} contract ${contract.name}: recording must be a JSON file under src/ux-sim/`);
            const shapes = compareDeviceResponseShapes({ recording: JSON.parse(readFileSync(join(REPO_ROOT, contract.recording), 'utf8')) as unknown,
              call: contract.call, label: `${dirName}.${def.id}.${contract.name}`, responses: await contract.responses(instance) });
            const status = deviceFidelityStatus(shapes.deviceId, [shapes.recordingId]);
            recorder.event('kernel.device-fidelity', { device: def.id, contract: contract.name, fidelity: status.verdict, problems: shapes.problems });
            if (status.verdict !== 'green') contractProblems.push(...(shapes.problems.length ? shapes.problems : [`fidelity ${status.verdict}`]).map((line) => `${def.id}/${contract.name}${line.startsWith('#') ? line : ` ${line}`}`));
          }
        }
      } catch (error) {
        actual = 'infra-error';
        diff = firstLine(error instanceof Error ? error.message : String(error));
      } finally {
        // Precheck 5: devices are disposed inside the scenario's universe, and the process-global test root is
        // restored on every path (including a throw from dispose itself).
        try {
          for (const [def, instance] of created.reverse()) {
            try { await def.dispose?.(instance); }
            catch (error) { actual = 'infra-error'; diff = firstLine(`device ${def.id} dispose failed: ${error instanceof Error ? error.message : String(error)}`); }
          }
        } finally { setTestStateRoot(prior ?? null); }
      }
      if (actual === 'infra-error') { recorder.event('kernel.infra-error', { detail: diff }); kernelEvent(events, 'scenario-infra-error', world, `${dirName}: ${diff}`); }
      const expectation = resolveSimWorldExpectation(head, base, world, row.id, engine);
      let verdict = judgeSimWorldScenario({ ...expectation, actual, observedReason });
      if (actual !== 'infra-error' && contractProblems.length > 0) {
        verdict = 'contract-violation';
        diff = contractProblems[0]!;
        kernelEvent(events, 'contract-violation', world, `${dirName}: ${contractProblems.length} problem(s), first ${contractProblems[0]}`);
      }
      let record: SimWorldVerdictRecord = { world, scenario: row.id, engine, seed, expected: expectation.expected, actual, verdict, diffFirstLine: diff, observedReason };
      const written = recorder.finalize(record);
      if (!written.ok) {
        record = { ...record, actual: 'infra-error', verdict: 'infra-error', diffFirstLine: `recorder write failed: ${written.error}` };
        kernelEvent(events, 'recorder-write-failed', world, `${dirName}: ${written.error}`);
      }
      rows.push({ ...record, dir: written.dir, wallMs: Math.round(performance.now() - startedAt) });
    }
  }
  // Rule 14 (absent ≠ PASS): scenarios were selected but none executed (e.g. all engine-unsupported) → the world is
  // unmeasured and the run fails, instead of a green run with zero counts. An empty pack (0 selected) stays pack-empty.
  if (selected.length > 0 && rows.length === 0)
    kernelEvent(events, 'world-unmeasured', world, `${selected.length} scenario(s) selected, 0 executed (engine ${request.engine}) — nothing was measured`);
  return { rows, events };
}

/** Same JSON request through the network-zero runner (scripts/sim-world-runner.ts). */
function runPackInSandbox(request: SimWorldPackRequest, stateRoot: string): Promise<{ rows: Row[]; events: SimWorldKernelEvent[] }> {
  const runner = join(REPO_ROOT, 'scripts/sim-world-runner.ts');
  const { command, args } = sandboxedRunnerCommand(stateRoot, process.cwd());
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args, runner], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELANOUS_SIM_WORLD_STATE_ROOT: stateRoot, ELANOUS_SIM_WORLD_OS_SANDBOXED: '1', ELANOUS_SIM_WORLD_KERNEL_REQUEST: JSON.stringify(request) } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`sandbox runner exited ${code}: ${firstLine(stderr || stdout)}`));
      try { resolveRun(JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { rows: Row[]; events: SimWorldKernelEvent[] }); }
      catch { reject(new Error(`sandbox runner returned invalid JSON: ${firstLine(stdout)}`)); }
    });
  });
}

/** Quality bar 5: each world finishes on minim5 in under 3 minutes. Over budget is a warning event, not a failure. */
const SIM_WORLD_WALL_BUDGET_MS = 180_000;

/** Read a recorded run's summary.json and return the options that replay it (same world id, seed, engine, only, base table). */
export function simWorldReplayOptions(stateRoot: string, replayOf: string):
  Pick<SimWorldRunOptions, 'worldId' | 'seed' | 'engine' | 'only' | 'expectBaseFile' | 'worlds'> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(replayOf)) throw new Error(`sim world replay run id is invalid: ${replayOf}`);
  const file = join(stateRoot, 'sim-world', replayOf, 'summary.json');
  if (!existsSync(file)) throw new Error(`sim world replay has no recorded summary: ${file}`);
  const recorded = JSON.parse(readFileSync(file, 'utf8')) as Partial<SimWorldSummary>;
  if (recorded.schema !== 'sim-world.summary/1' || !Number.isSafeInteger(recorded.seed) || !Array.isArray(recorded.worlds) || !recorded.engine)
    throw new Error(`sim world replay summary is malformed: ${file}`);
  // A one-world record replays as that world; a longer one replays as `all` over the RECORDED list — comparing its length with the
  // current registry would restore only the first world once a world is added (JUD-B #114066).
  const known = recorded.worlds.filter((world): world is SimWorldPackId => (SIM_WORLD_IDS as readonly string[]).includes(world));
  if (recorded.worlds.length === 0 || known.length !== recorded.worlds.length) throw new Error(`sim world replay summary names a world this build does not register: ${file}`);
  const worldId: SimWorldReservedId = known.length === 1 ? known[0]! : 'all';
  // A summary from before expectBase was recorded has none: replay then runs without a base table, as it did.
  return { worldId, ...(worldId === 'all' ? { worlds: known } : {}), seed: recorded.seed!, engine: recorded.engine, only: recorded.only ?? null, expectBaseFile: recorded.expectBase?.path ?? null };
}

// #126458 JUD-B #127000/#127050: hash the *resolved* expect table (legacy single file or discovered
// fragments) — hashing the raw legacy path ENOENTs on a fragment-only tree.
const tableSha256 = (file: string) => createHash('sha256').update(JSON.stringify(readSimWorldExpectTable(file))).digest('hex');

// OP #127293 / JUD-C #127291/#127292: summaries written before `hashKind` recorded the RAW file hash (a legacy
// single file only — fragment trees crashed before r8). Replay compares those against the raw bytes when the
// base path is still a plain file; a fragment-only tree has none, so it falls back to the table hash.
const rawFileSha256 = (file: string): string | null => {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
};

function firstDiffLine(recorded: string, replayed: string): string {
  const left = recorded.split('\n');
  const right = replayed.split('\n');
  const index = left.findIndex((line, at) => line !== right[at]);
  const at = index < 0 ? left.length : index;
  return `line ${at + 1}: recorded ${JSON.stringify(left[at] ?? null)} · replayed ${JSON.stringify(right[at] ?? null)}`;
}

/** Run the reserved world id and write <stateRoot>/sim-world/<runId>/summary.json (with --replay: diff against that run). */
export async function runSimWorlds(options: SimWorldRunOptions & { readonly replayOf?: string }): Promise<SimWorldSummary & { readonly summaryPath: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.runId)) throw new Error(`sim world run id is invalid: ${options.runId}`);
  const runDir = join(options.stateRoot, 'sim-world', options.runId);
  if (existsSync(runDir)) throw new Error(`sim world run already exists: ${runDir}`);
  mkdirSync(runDir, { recursive: true });
  const worlds: SimWorldPackId[] = options.worldId === 'all' ? [...(options.worlds ?? SIM_WORLD_IDS)] : [options.worldId];
  const packRoot = options.packRoot ?? SIM_WORLD_PACK_ROOT;
  const expectFile = options.expectFile ?? join(packRoot, 'sim-world-expect.json');
  const events: SimWorldKernelEvent[] = [];
  if (options.expectBaseFile) {
    for (const violation of checkSimWorldRatchet(readTable(options.expectBaseFile), readTable(expectFile)))
      kernelEvent(events, `ratchet-${violation.kind}`, null, violation.key);
  } else readTable(expectFile);
  const engines: SimWorldEngine[] = options.engine === 'both' ? ['legacy', 'graph'] : [options.engine];
  const packs = new Map(worlds.map((world) => [world, loadSimWorldPack(world, packRoot)] as const));
  // Precheck 5: records live at <run>/<scn>, so one scenario id in two packs would overwrite the other's files.
  const owners = new Map<string, SimWorldPackId>();
  for (const [world, pack] of packs) {
    for (const row of pack.scenarios) {
      const owner = owners.get(row.id);
      if (owner) throw new Error(`sim world scenario id ${row.id} appears in packs ${owner} and ${world}; its records under ${join(runDir, row.id)} would collide`);
      owners.set(row.id, world);
    }
  }
  const inline = (options.isolate ?? 'sandbox') === 'inline';
  const runWorld = async (world: SimWorldPackId) => {
    const startedAt = performance.now();
    const request: SimWorldPackRequest = { world, seed: options.seed, engine: options.engine, only: options.only, runDir,
      packRoot, expectFile, expectBaseFile: options.expectBaseFile };
    const pack = packs.get(world)!;
    const local: SimWorldKernelEvent[] = [];
    let result: { readonly rows: Row[]; readonly events: SimWorldKernelEvent[] };
    if (pack.scenarios.length === 0) {
      kernelEvent(local, 'pack-empty', world, `sim-world-${world}.yaml has no scenarios`);
      result = { rows: [], events: local };
    } else if (inline) result = await runSimWorldPackInProcess(request, options.recorderFs);
    else {
      try { result = await (options.runPack ?? ((packRequest: SimWorldPackRequest) => runPackInSandbox(packRequest, options.stateRoot)))(request); }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        kernelEvent(local, 'sandbox-failed', world, detail);
        // Only the scenarios this run selected (--only) × requested engines failed to run; unselected rows are not reported.
        const selected = pack.scenarios.filter((row) => options.only === null || row.id === options.only);
        result = { rows: selected.flatMap((row) => engines.map((engine): Row => ({ world, scenario: row.id, engine, seed: options.seed,
          expected: null, actual: 'infra-error', verdict: 'infra-error', diffFirstLine: firstLine(detail), observedReason: null,
          dir: join(runDir, options.engine === 'both' ? `${row.id}@${engine}` : row.id), wallMs: 0 }))), events: local };
      }
    }
    return { ...result, world, wallMs: Math.round(performance.now() - startedAt) };
  };
  // Sandbox mode: one process per world, so worlds run in parallel. Inline mode shares this process's test root and
  // fake clock, so worlds run one after another (precheck 5).
  const results: Awaited<ReturnType<typeof runWorld>>[] = [];
  if (inline) for (const world of worlds) results.push(await runWorld(world));
  else results.push(...await Promise.all(worlds.map(runWorld)));
  const worldWallMs: Partial<Record<SimWorldPackId, number>> = {};
  for (const result of results) {
    events.push(...result.events);
    worldWallMs[result.world] = result.wallMs;
    const budget = options.wallBudgetMs ?? SIM_WORLD_WALL_BUDGET_MS;
    if (result.wallMs > budget) {
      const slowest = [...result.rows].sort((left, right) => right.wallMs - left.wallMs).slice(0, 3).map((row) => `${row.scenario}@${row.engine} ${row.wallMs}ms`);
      kernelEvent(events, 'world-over-budget', result.world, `${result.wallMs}ms > ${budget}ms · slowest ${slowest.join(', ') || '(no scenarios)'}`);
    }
  }
  const scenarios = results.flatMap((result) => result.rows);
  if (options.only !== null && scenarios.length === 0) kernelEvent(events, 'only-matched-nothing', null, options.only);
  let replay: SimWorldSummary['replay'] = null;
  if (options.replayOf) {
    const recordedRun = join(options.stateRoot, 'sim-world', options.replayOf);
    const recorded = (JSON.parse(readFileSync(join(recordedRun, 'summary.json'), 'utf8')) as SimWorldSummary).scenarios;
    const mismatches: { dir: string; file: string; firstDiff: string }[] = [];
    for (const row of recorded) {
      const dirName = row.dir.slice(row.dir.lastIndexOf('/') + 1);
      for (const file of SIM_WORLD_RECORD_FILES) {
        const before = join(recordedRun, dirName, file);
        const after = join(runDir, dirName, file);
        const left = existsSync(before) ? readFileSync(before, 'utf8') : null;
        const right = existsSync(after) ? readFileSync(after, 'utf8') : null;
        if (left === null || right === null) mismatches.push({ dir: dirName, file, firstDiff: left === null ? 'missing in the recorded run' : 'missing in the replay' });
        else if (left !== right) mismatches.push({ dir: dirName, file, firstDiff: firstDiffLine(left, right) });
      }
    }
    const recordedBase = (JSON.parse(readFileSync(join(recordedRun, 'summary.json'), 'utf8')) as Partial<SimWorldSummary>).expectBase ?? null;
    // OP #127293: an old record (no hashKind) hashed the raw file; a new one (hashKind 'table-sha256/1') hashes the
    // resolved table. Compare like with like; a fragment-only base has no raw file, so an old record falls back to
    // the table hash there (the only thing computable without ENOENT).
    const replayTableSha = options.expectBaseFile ? tableSha256(options.expectBaseFile) : null;
    const replayBaseSha = !options.expectBaseFile ? null
      : recordedBase?.hashKind === 'table-sha256/1' ? replayTableSha
      : rawFileSha256(options.expectBaseFile) ?? replayTableSha;
    if ((recordedBase?.sha256 ?? null) !== replayBaseSha)
      mismatches.push({ dir: '.', file: 'expect-base', firstDiff: `recorded ${recordedBase ? `${recordedBase.path} sha256 ${recordedBase.sha256}` : 'none'} · replayed ${options.expectBaseFile ? `${options.expectBaseFile} sha256 ${replayBaseSha}` : 'none'}` });
    if (scenarios.length !== recorded.length) mismatches.push({ dir: '.', file: 'summary.json', firstDiff: `recorded ${recorded.length} scenario runs · replayed ${scenarios.length}` });
    for (const mismatch of mismatches) kernelEvent(events, 'replay-mismatch', null, `${mismatch.dir}/${mismatch.file}: ${mismatch.firstDiff}`);
    replay = { of: options.replayOf, mismatches };
  }
  const counts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, scenarios.filter((row) => row.verdict === verdict).length])) as Record<SimWorldVerdict, number>;
  // The main reference this tree is judged against — never the checkout HEAD (a feature branch is not main).
  const sha = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: options.mainRefRoot ?? REPO_ROOT, encoding: 'utf8' });
  const mainSha = sha.status === 0 && /^[0-9a-f]{40}$/u.test(sha.stdout.trim()) ? sha.stdout.trim() : null;
  if (mainSha === null) kernelEvent(events, 'main-sha-unmeasured', null, `refs/remotes/origin/main not found${sha.stderr?.trim() ? `: ${firstLine(sha.stderr)}` : ''}`);
  const fatal = events.some((event) => event.kind.startsWith('ratchet-') || ['only-matched-nothing', 'sandbox-failed', 'replay-mismatch', 'world-unmeasured'].includes(event.kind));
  const summary: SimWorldSummary = { schema: 'sim-world.summary/1', runId: options.runId, seed: options.seed, engine: options.engine, only: options.only,
    worlds, mainSha, expectBase: options.expectBaseFile ? { path: resolve(options.expectBaseFile), sha256: tableSha256(options.expectBaseFile), hashKind: 'table-sha256/1' } : null,
    counts, scenarios, worldWallMs, replay, events, ok: !fatal && !scenarios.some((row) => SIM_WORLD_RED_VERDICTS.includes(row.verdict)) };
  const summaryPath = join(runDir, 'summary.json');
  writeFileSync(summaryPath, `${canonicalJson(summary, 2)}\n`);
  return { ...summary, summaryPath };
}
