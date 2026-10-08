/**
 * OPS-OVERVIEW-CLI 첫 조각 — 수집기(한 시점에 모은다 · RFC §A1 «같은 스냅숏»).
 * ⛔ ssh 0 · kubectl 0 · GitHub 호출 0(호출 경로). 칸마다 실패는 그 칸만 «못 잼».
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { Checklist, ChecklistItem } from '../release-loop/checklist.js';
import type { ReleaseSchedule } from '../release-loop/release-schedule.js';
import type { ResourceView } from '../control-plane/ledger.js';
import type { TaskCard } from '../task-agent/task-hand.js';
import {
  okCell, unmeasured, type Cell, type CapacityInfo, type ChecklistCounts, type LaunchableInfo, type LoopRow, type MachineRow,
  type OverviewSnapshot, type OwnerTaskRow, type ParentsInfo, type PodMemberRow, type ReleaseRunInfo, type ScheduleInfo,
} from './overview.js';
import { SEAT_ERA_SOURCE, readDispatcherBeats, readDispatcherCapacity, readSeatEraHanded, seatEraFeederDir } from './overview-seat-era.js';

const GB = 1024 ** 3;
/** 하트비트 주기 30 s × 2 (RFC §A2 «낡음»). */
const HEARTBEAT_STALE_S = 60;
/** 디스패처 주기 ≈ 5.5 분 × 2. */
const DISPATCHER_STALE_S = 11 * 60;
const STALE_PARENT_S = 6 * 3600;
const TARGET_PATH = /대상 경로:/;

export interface CollectOptions {
  version?: string;
  sinceMs: number;
  sinceLabel: string;
  owner?: string;
  now?: number;
  root?: string;
  seatEraDir?: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 160);

function pickVersion(explicit: string | undefined, schedules: ReleaseSchedule[], now: number): string | null {
  if (explicit) return explicit;
  const upcoming = schedules.filter((s) => Date.parse(s.cutAt) > now).sort((a, b) => a.cutAt.localeCompare(b.cutAt));
  return upcoming[0]?.version ?? null;
}

export function countChecklist(items: readonly ChecklistItem[]): ChecklistCounts {
  const c: ChecklistCounts = { green: 0, yellow: 0, red: 0, done: 0, p0Yellow: 0 };
  for (const it of items) {
    c[it.status]++;
    if (it.status === 'yellow' && it.priority === 'P0') c.p0Yellow++;
  }
  return c;
}

/**
 * ⚠️ 임시 «발사 가능» 술어 — 오케스트레이터가 아직 술어를 export 하지 않는다(OVW-DISPATCH-LEDGER).
 * 노랑 ∧ 제목에 «대상 경로:» ∧ 아직 안 넘김(TASK-AGENT checklistId ⊕ 자리 시대 handed) ∧ 선행 모두 초록/끝.
 */
export function launchableCells(checklists: readonly Checklist[], handed: ReadonlySet<string>): LaunchableInfo {
  const status = new Map<string, ChecklistItem['status']>();
  for (const cl of checklists) for (const it of cl.items) if (!status.has(it.id)) status.set(it.id, it.status);
  const ids: string[] = [];
  const skipped = { noTargetPath: 0, predecessorOpen: 0, alreadyHanded: 0 };
  for (const cl of checklists) for (const it of cl.items) {
    if (it.status !== 'yellow') continue;
    if (handed.has(it.id)) { skipped.alreadyHanded++; continue; }
    if (!TARGET_PATH.test(it.title)) { skipped.noTargetPath++; continue; }
    const open = (it.predecessors ?? []).some((p) => { const st = status.get(p); return st !== undefined && st !== 'green' && st !== 'done'; });
    if (open) { skipped.predecessorOpen++; continue; }
    ids.push(it.id);
  }
  return { count: ids.length, ids: ids.slice(0, 20), skipped, interim: true };
}

export function ownerRows(cards: readonly TaskCard[], sinceIso: string, ownerFilter?: string): Record<string, OwnerTaskRow> {
  const rows: Record<string, OwnerTaskRow> = {};
  for (const card of cards) {
    if (!card || typeof card.createdAt !== 'string' || card.createdAt < sinceIso) continue;
    const owner = card.seat ? `seat:${card.seat}` : 'unassigned';
    if (ownerFilter && ownerFilter !== 'all' && owner !== ownerFilter && owner !== `seat:${ownerFilter}`) continue;
    const row = rows[owner] ??= { handed: 0, launched: 0, prBound: 0, failed: 0, launchFailed: 0 };
    if (card.status === 'handed') row.handed++;
    else if (card.status === 'launched') row.launched++;
    else if (card.status === 'failed') row.failed++;
    else if (card.status === 'launch-failed') row.launchFailed++;
    if ((card.history ?? []).some((h) => h.event === 'pr-bound')) row.prBound++;
  }
  return rows;
}

/** `[[dd-]hh:]mm:ss` → 초. */
export function parseEtime(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

const HARNESS_PARENT = /elanous\.mjs .*\bharness (?:say|ask)\b/;

/** `ps -axo etime=,command=` 출력 → 하니스 부모 요약(RFC §S «재는 명령»과 같은 술어). */
export function summarizeParents(psOut: string): ParentsInfo {
  let count = 0; let stale = 0; let oldest = -1;
  for (const line of psOut.split('\n')) {
    const m = /^\s*(\S+)\s+(.*)$/.exec(line);
    if (!m || !HARNESS_PARENT.test(m[2]!)) continue;
    const s = parseEtime(m[1]!);
    count++;
    if (s !== null) { if (s > STALE_PARENT_S) stale++; if (s > oldest) oldest = s; }
  }
  return { count, staleOver6h: stale, oldestHours: oldest < 0 ? null : Math.round(oldest / 360) / 10 };
}

function collectRelease(root: string, version: string | null, schedules: ReleaseSchedule[] | Error, now: number,
  readRuns: (dir: string) => Array<{ runId: string; status: string; startedAt: string; version: string | null; nodes: Array<{ nodeId: string; ok: boolean | null; startedAt?: string }> }> | 'unavailable',
  readList: (v: string) => Checklist): OverviewSnapshot['release'] {
  const versionCell: Cell<string> = version ? okCell(version, 'release schedule(다음 컷)', iso(now)) : unmeasured('release schedule', schedules instanceof Error ? `스케줄 못 읽음: ${errText(schedules)}` : '앞으로의 컷이 없음 — --version 으로 지정');
  let schedule: Cell<ScheduleInfo | 'none'>;
  if (schedules instanceof Error) schedule = unmeasured('release schedule', errText(schedules));
  else if (!version) schedule = okCell('none', 'release schedule', iso(now));
  else {
    const row = schedules.find((s) => s.version === version);
    schedule = okCell(row ? {
      cutAt: row.cutAt, landBy: row.landBy, publishAt: row.publishAt ?? null,
      freezeNow: !!(row.freezeFrom && row.freezeUntil && Date.parse(row.freezeFrom) <= now && now < Date.parse(row.freezeUntil)),
    } : 'none', 'release schedule', iso(now));
  }
  let checklist: Cell<ChecklistCounts>;
  if (!version) checklist = unmeasured('release checklist', '판 미정');
  else {
    try { checklist = okCell(countChecklist(readList(version).items), `release checklist(${version})`, iso(now)); }
    catch (error) { checklist = unmeasured(`release checklist(${version})`, errText(error)); }
  }
  const dir = join(root, 'graph-runs', 'release-loop');
  let run: Cell<ReleaseRunInfo | 'none'>;
  try {
    const runs = readRuns(dir);
    if (runs === 'unavailable') run = unmeasured(dir, 'runs-unavailable');
    else if (runs.length === 0) run = okCell('none', dir, iso(now));
    else {
      const r = runs[0]!;
      const current = r.nodes.find((n) => n.ok === null) ?? null;
      let pidAliveFlag: boolean | null = null;
      try {
        const raw = JSON.parse(readFileSync(join(dir, `${r.runId}.json`), 'utf8')) as { pid?: unknown };
        if (typeof raw.pid === 'number') { try { process.kill(raw.pid, 0); pidAliveFlag = true; } catch (e) { pidAliveFlag = (e as NodeJS.ErrnoException).code === 'EPERM'; } }
      } catch { /* pid 모름 */ }
      const node = current?.nodeId ?? null;
      const waitingOn: ReleaseRunInfo['waitingOn'] = r.status !== 'running' ? 'none'
        : node && /approv/i.test(node) ? 'approval'
          : pidAliveFlag === false ? 'process-gone'
            : node && /gate/i.test(node) ? 'gate' : 'none';
      const startedMs = Date.parse(current?.startedAt ?? r.startedAt);
      run = okCell({ runId: r.runId, status: r.status, currentNode: node, startedAt: r.startedAt, waitingOn,
        elapsedMinutes: Number.isNaN(startedMs) ? null : Math.round((now - startedMs) / 60000) }, `release run ledger(${r.version ?? '?'})`, iso(now));
    }
  } catch (error) { run = unmeasured(dir, errText(error)); }
  return { version: versionCell, run, schedule, checklist };
}

function collectMachines(root: string, ledgerRows: ResourceView[] | Error, poolSpec: string | null, psOut: string | Error, now: number): OverviewSnapshot['machines'] {
  const expected = new Set<string>();
  const pods: PodMemberRow[] = [];
  if (poolSpec) {
    for (const part of poolSpec.split(',').map((p) => p.trim()).filter(Boolean)) {
      const m = /^([^@:#]+)(?:@([^:#]+))?(?::(\d+))?/.exec(part);
      if (!m) continue;
      if (m[2]) expected.add(m[2]);
      pods.push({ context: m[1]!, capacity: m[3] === undefined ? 2 : Number(m[3]),
        occupied: unmeasured('pod pool', '호출 경로 kubectl 금지 — 멤버별 점유는 데몬 백그라운드 측정기(OVW-API) 대기') });
    }
  }
  const hosts: MachineRow[] = [];
  if (ledgerRows instanceof Error) {
    for (const name of expected) hosts.push({ name, load: unmeasured('control ledger', errText(ledgerRows)) });
  } else {
    const machines = ledgerRows.filter((r) => r.kind === 'machine');
    for (const r of machines) expected.add(r.machine);
    for (const name of [...expected].sort()) {
      const row = machines.find((r) => r.machine === name);
      const load = (row?.attrs as { load?: { loadAvg?: number[]; cpuCount?: number; freeMem?: number; totalMem?: number; observedAt?: number } } | undefined)?.load;
      if (!row || !load || !Array.isArray(load.loadAvg)) { hosts.push({ name, load: unmeasured('control ledger heartbeat', '하트비트 없음') }); continue; }
      const observed = typeof load.observedAt === 'number' ? load.observedAt : row.observedAt;
      const [l1, l5, l15] = load.loadAvg;
      const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
      if (!num(l1) || !num(l5) || !num(l15) || !num(load.cpuCount) || load.cpuCount <= 0 || !num(load.freeMem) || !num(load.totalMem)) {
        hosts.push({ name, load: unmeasured('control ledger heartbeat', '하트비트 항목 빠짐(loadAvg·cpuCount·freeMem·totalMem)', iso(observed)) });
        continue;
      }
      const age = Math.max(0, Math.round((now - observed) / 1000));
      const value = { load1: l1, load5: l5, load15: l15, cpuCount: load.cpuCount,
        freeGb: load.freeMem / GB, totalGb: load.totalMem / GB, ageSeconds: age };
      hosts.push({ name, load: age > HEARTBEAT_STALE_S
        ? unmeasured('control ledger heartbeat', `낡음(${age}초)`, iso(observed))
        : okCell(value, 'control ledger heartbeat', iso(observed)) });
    }
  }
  const parents: Cell<ParentsInfo> = psOut instanceof Error
    ? unmeasured(`ps(${hostname()})`, `ps-exec 실패: ${errText(psOut)}`)
    : okCell(summarizeParents(psOut), `ps(${hostname()} 로컬만 — 다른 기계는 OVW-MACHINE-HB)`, iso(now));
  void root;
  return { hosts, pods, parents };
}

export interface CollectDeps {
  listSchedules?: () => ReleaseSchedule[];
  listChecklist?: (v: string) => Checklist;
  readRuns?: (dir: string) => ReturnType<Parameters<typeof collectRelease>[4]>;
  readCards?: () => TaskCard[];
  ledger?: () => ResourceView[];
  poolSpec?: () => string | null;
  ps?: () => string;
  gitLog?: (sinceIso: string) => { lines: string[]; observedAt: string } ;
}

async function defaultDeps(root: string): Promise<Required<CollectDeps>> {
  const [{ listSchedules }, { listChecklist }, { readReleaseRuns }, { readTaskAgentState, taskAgentStatePath }, { ResourceLedger }, { getUserConfig }] = await Promise.all([
    import('../release-loop/release-schedule.js'), import('../release-loop/checklist.js'), import('../nexus/api/ops-api.js'),
    import('../task-agent/task-hand.js'), import('../control-plane/ledger.js'), import('../user-config.js'),
  ]);
  return {
    listSchedules: () => listSchedules(),
    listChecklist: (v) => listChecklist(v),
    readRuns: (dir) => readReleaseRuns(null, dir),
    readCards: () => {
      const state = readTaskAgentState<{ tasks?: Record<string, TaskCard> | TaskCard[] }>(taskAgentStatePath());
      const t = state.tasks ?? {};
      return Array.isArray(t) ? t : Object.values(t);
    },
    ledger: () => new ResourceLedger(root).list({ kind: 'machine' }),
    poolSpec: () => {
      const c = getUserConfig() as { harness?: { podPool?: string }; pod?: { pool?: string } };
      return process.env.ELANOUS_POD_POOL?.trim() || c.harness?.podPool || c.pod?.pool || null;
    },
    ps: () => execFileSync('ps', ['-axo', 'etime=,command='], { encoding: 'utf8', timeout: 1_500, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }),
    gitLog: (sinceIso) => {
      const c = getUserConfig() as { harness?: { defaultRepo?: string } };
      const repo = c.harness?.defaultRepo;
      if (!repo) throw new Error('harness.defaultRepo 없음');
      let fetched: number;
      try { fetched = statSync(join(repo, '.git', 'FETCH_HEAD')).mtimeMs; } catch { throw new Error(`FETCH_HEAD 없음(${repo})`); }
      const out = execFileSync('git', ['-C', repo, 'log', 'refs/remotes/origin/main', `--since=${sinceIso}`, '--first-parent', '--format=%cI%x09%s'],
        { encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] });
      return { lines: out.split('\n').filter(Boolean), observedAt: iso(fetched) };
    },
  };
}

/** 착지 원천(git origin/main)의 fetch 가 이보다 낡으면 «못 잼»(낡음). */
const LANDINGS_STALE_S = 30 * 60;

export async function collectOverview(opts: CollectOptions, injected: CollectDeps = {}): Promise<OverviewSnapshot> {
  const now = opts.now ?? Date.now();
  const root = opts.root ?? effectiveInstanceRoot();
  const deps = { ...(await defaultDeps(root)), ...injected };
  const seatDir = opts.seatEraDir ?? seatEraFeederDir();
  const sinceIso = iso(now - opts.sinceMs);

  let schedules: ReleaseSchedule[] | Error;
  try { schedules = deps.listSchedules(); } catch (error) { schedules = error instanceof Error ? error : new Error(String(error)); }
  const version = pickVersion(opts.version, schedules instanceof Error ? [] : schedules, now);
  const release = collectRelease(root, version, schedules, now, deps.readRuns, deps.listChecklist);

  // 일꾼 — 오늘(KST 0시) 이후 카드.
  const kstMidnight = iso(Math.floor((now + 9 * 3600_000) / 86400_000) * 86400_000 - 9 * 3600_000);
  let cards: TaskCard[] | Error;
  try { cards = deps.readCards(); } catch (error) { cards = error instanceof Error ? error : new Error(String(error)); }
  const byOwner: Cell<Record<string, OwnerTaskRow>> = cards instanceof Error
    ? unmeasured('task-agent ledger', errText(cards))
    : okCell(ownerRows(cards, kstMidnight, opts.owner), `task-agent ledger(오늘 KST · owner=seat 키)`, iso(now));
  const done = unmeasured<number>('task-agent ledger', '착지 판정은 PR 조회가 필요 — owner 모델(OVW-OWNER)·card-evidence 연결 전');

  // 발사 가능 — 열린 판(앞으로의 컷) 전부.
  let launchable: Cell<LaunchableInfo>;
  if (schedules instanceof Error) launchable = unmeasured('release checklist', `스케줄 못 읽음: ${errText(schedules)}`);
  else if (cards instanceof Error) launchable = unmeasured('task-agent ledger', `넘김 목록 못 읽음: ${errText(cards)}`);
  else {
    try {
      const open = schedules.filter((s) => Date.parse(s.cutAt) > now).map((s) => s.version);
      if (version && !open.includes(version)) open.push(version);
      const lists = open.map((v) => deps.listChecklist(v));
      const handed = new Set<string>([...cards.map((c) => c.checklistId).filter((x): x is string => typeof x === 'string'), ...readSeatEraHanded(seatDir)]);
      launchable = okCell(launchableCells(lists, handed), `release checklist(${open.join(',')}) ⊕ task-agent ⊕ ${SEAT_ERA_SOURCE} handed · 임시 술어`, iso(now));
    } catch (error) { launchable = unmeasured('release checklist', errText(error)); }
  }

  // 빈 자리 — 자리 시대 디스패처 로그(임시) · 호출 경로 kubectl 0.
  const capLine = readDispatcherCapacity(seatDir, now);
  let capacity: Cell<CapacityInfo>;
  if ('error' in capLine) capacity = unmeasured(SEAT_ERA_SOURCE, capLine.error);
  else if (capLine.ageSeconds > DISPATCHER_STALE_S) capacity = unmeasured(SEAT_ERA_SOURCE, `낡음(${Math.round(capLine.ageSeconds / 60)}분)`, capLine.at);
  else {
    const free = Math.max(0, capLine.podTarget - capLine.podUsed) + Math.max(0, capLine.localMax - capLine.localUsed);
    capacity = okCell({ podUsed: capLine.podUsed, podTarget: capLine.podTarget, localUsed: capLine.localUsed, localMax: capLine.localMax, free }, `${SEAT_ERA_SOURCE} dispatcher-OP.out`, capLine.at);
  }
  const tasks = { byOwner, done, launchable, capacity };

  let ledgerRows: ResourceView[] | Error;
  try { ledgerRows = deps.ledger(); } catch (error) { ledgerRows = error instanceof Error ? error : new Error(String(error)); }
  let poolSpec: string | null = null;
  try { poolSpec = deps.poolSpec(); } catch { poolSpec = null; }
  let psOut: string | Error;
  try { psOut = deps.ps(); } catch (error) { psOut = error instanceof Error ? error : new Error(String(error)); }
  const machines = collectMachines(root, ledgerRows, poolSpec, psOut, now);

  let landings: Cell<{ count: number; recent: string[] }>;
  try {
    const { lines, observedAt } = deps.gitLog(sinceIso);
    const age = Math.round((now - Date.parse(observedAt)) / 1000);
    landings = age > LANDINGS_STALE_S
      ? unmeasured('git origin/main(로컬 fetch)', `fetch 낡음(${Math.round(age / 60)}분)`, observedAt)
      : okCell({ count: lines.length, recent: lines.slice(0, 5).map((l) => l.split('\t')[1] ?? l) }, `git origin/main(로컬 fetch ${Math.round(age / 60)}분 전)`, observedAt);
  } catch (error) { landings = unmeasured('git origin/main(로컬 fetch)', errText(error)); }

  const loops: LoopRow[] = [];
  const productBeat = (name: string, paths: string[]): void => {
    let newest = -1;
    for (const p of paths) {
      try {
        const st = statSync(p);
        if (st.isDirectory()) { for (const f of readdirSync(p)) { try { newest = Math.max(newest, statSync(join(p, f)).mtimeMs); } catch { /* skip */ } } }
        else newest = Math.max(newest, st.mtimeMs);
      } catch { /* 없음 */ }
    }
    loops.push({ name, era: 'product', staleAfterSeconds: null,
      beat: newest < 0 ? unmeasured(paths.join(','), '원장 없음(계측 없음 — «죽었다» 아님)')
        : okCell({ lastAt: iso(newest), ageSeconds: Math.max(0, Math.round((now - newest) / 1000)), alive: null }, `${paths.join(',')} mtime`, iso(newest)) });
  };
  productBeat('orchestrator', [join(root, 'orchestrator')]);
  productBeat('steward', [join(root, 'steward', 'readiness.jsonl'), join(root, 'steward', 'streak.json')]);
  for (const b of readDispatcherBeats(seatDir, now)) {
    loops.push({ name: `dispatcher-${b.seat}`, era: 'seat-era', staleAfterSeconds: b.seat === 'OP' ? DISPATCHER_STALE_S : null,
      beat: okCell({ lastAt: b.lastAt, ageSeconds: b.ageSeconds, alive: b.alive }, `${SEAT_ERA_SOURCE} dispatcher-${b.seat}.pid`, b.lastAt) });
  }

  return { generatedAt: iso(now), instanceRoot: root, since: opts.sinceLabel, release, tasks, machines, landings, loops };
}

export function parseSince(raw: string | undefined): { ms: number; label: string } {
  const v = (raw ?? '1h').trim();
  const m = /^(\d+)\s*(m|h|d)$/.exec(v);
  if (!m) throw new Error(`--since 형식: <n>m|h|d (받음: ${v})`);
  const n = Number(m[1]);
  return { ms: n * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000), label: `최근 ${v}` };
}
