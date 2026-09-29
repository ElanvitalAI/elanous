import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runGitCommand } from '../git-fs/runner.js';
import { debug } from '../debug/log.js';
import { getPty, listPty, requestPtyTakeover } from '../pty-shell/registry.js';
import { getPtyManifest, isProcessAlive, listPtyManifest, listPtyManifestRows, listPtyManifestRowsAt, ptyManifestDbPath, readPtyManifestFrame, reapDeadPtyManifest, reapDeadPtyManifestAt, reapStalePtyManifest, removePtyManifest, PTY_MANIFEST_CLOSED_TTL_MS, PTY_MANIFEST_STALE_MS, type PtyManifestExternalReapResult, type PtyManifestRow } from '../pty-shell/pty-manifest.js';
import { readPtyEventsAfter, readPtyEventsAfterAt, type PtyEventLogReadResult, type PtyEventRow } from '../pty-shell/pty-event-log.js';
import { resolvePtyRef, type PtyRefItem } from '../pty-shell/pty-ref.js';
import { parsePtyWriteActor, resolveRemoteControlActor, resolveTakeover, type PtyWriteActor } from '../pty-shell/pty-write-arbiter.js';
import { registerPtyAttachDriveCommand } from './pty-drive-cli.js';
import { resolveNexusPwa, type NexusPwaResolution } from './nexus-show.js';
import { formatPtyWebAddress, ptyWebAddress, type PtyWebAddress } from './pty-web-address.js';
import { getHarnessRunId, normalizeRunIdSource, type RunIdSource } from '../harness/harness-space.js';
import { inspectControlInbox, type ControlInboxSnapshot } from '../harness/control-inbox.js';
import { requestRemotePtyControl, type PtyControlAction, type PtyControlPayload, type PtyControlRequestOptions, type PtyControlResult } from '../pty-shell/pty-control-ipc.js';
import { resolvePtySpecialKey } from '../pty-shell/pty-special-keys.js';
import { encodeSgrMouse, mouseModeOffReason, type PtyMouseInput } from '../pty-shell/pty-mouse.js';
import { resizePtyWithOutcome, writePtyWithOutcome } from '../pty-shell/pty-write-outcome.js';
import type { PtyControlTarget, PtyHandle } from '../pty-shell/registry.js';
import { ptyEventLogTargets, ptyManifestTargets } from '../domains/fleet.js';
import { loadRunLedger, resolveFederatedRunLedgerDirectories, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { selfDevRunsDir, type SelfDevRunState } from '../self-dev/run-store.js';
import { isRunStatus } from '../self-implement/run-status-mapping.js';
import { terminalTreeLabel } from '../pty-shell/terminal-tree.js';
import { RemotesStore } from './remotes.js';
import { bookmarkAttachDefaults } from './remote-resolve.js';
import { classifyFrameState, type FrameState } from '../capture/frame-state-detect.js';
import { installMissingTool, waitForPtyCompletion, type ToolInstallDeps, type ToolInstallResult } from '../agent-mission/tool-install.js';

interface PtyTakeoverCommandResult { readonly exitCode: 0 | 1 | 2; readonly message: string; readonly notice?: string; }
/** ⚠️ 내부 타입 — 파일 밖 소비자 없음(dead export 금지·review · `pty-control-ipc.ts:7` 선례).
 *  실 소비자가 생기면 그때 export 한다. */
/** ⭐⭐⭐ `workdir` 을 행에 싣는다 — 2026-08-02 에 **두 세션이 각각** 남의 TUI 를 집어 입력을
 *  보냈다. 둘 다 원인이 같다: `pty list` 가 **id·kind·alive 만** 줘서 *"내가 방금 띄웠으니 이게 내 것"*
 *  이라는 **추론**이 유일한 소유 근거였다. workdir 은 registry handle 과 manifest 양쪽에 이미
 *  있었고 **목록이 안 보여줬을 뿐**이다. ⇒ 보여 주면 소유가 추론이 아니라 조회가 된다. */
type PtyListItem = PtyRefItem & { readonly source: 'local' | 'remote'; readonly alive: boolean; readonly mode?: PtyHandle['accessMode']; readonly workdir?: string; readonly runId?: string; readonly terminalOriginCategory?: PtyManifestRow['terminalOriginCategory']; readonly terminalOriginReason?: string; readonly externalToolName?: string };
/** ⚠️ 내부 타입 — 파일 밖 production 소비자 없음(dead export 금지·review). `readLivePtyAddressBook`
 *  가 이 형태를 돌려주지만 호출부(테스트 포함)는 값만 쓰고 타입명을 import 하지 않는다. */
interface DeadPtyRef extends PtyRefItem {
  readonly livenessSource: 'pty-pid' | 'owner-pid';
  readonly ownerAlive?: boolean;
  readonly ptyAlive?: boolean;
  readonly exitCode: number | null;
}

interface PtyAddressBook {
  readonly refs: readonly PtyListItem[];
  readonly deadRefs: readonly DeadPtyRef[];
}

/** 연합 조회 한 행 — 로컬/원격 구분 대신 **어느 인스턴스 뿌리의 것인지**를 싣는다. */
export interface FederatedPtyRef {
  readonly instance: string;
  readonly id: string;
  readonly kind: string;
  readonly nickname?: string;
  readonly runId?: string;
  readonly workdir?: string;
  readonly terminalOriginCategory?: PtyManifestRow['terminalOriginCategory'];
  readonly terminalOriginReason?: string;
  readonly externalToolName?: string;
  readonly alive: boolean;
  /** Manifest database root that supplied this row; retained for human federation identity. */
  readonly sourceRoot?: string;
  /** Optional compatibility input for callers that already resolved owner liveness. */
  readonly ownerProcessAlive?: boolean;
  readonly updatedAt?: number;
}

/** 연합 조회 결과 — ⛔ **못 읽은 뿌리를 함께 돌려준다**(리뷰 must-fix). 읽기 실패를 삼켜
 *  빈 목록으로 만들면 *"PTY 가 없다"* 와 *"못 봤다"* 가 같은 모습이 된다(오늘 코퍼스 러너에서 같은 값을 치렀다). */
export interface FederatedPtyListing {
  readonly refs: readonly FederatedPtyRef[];
  /** 읽기에 실패한 인스턴스 이름들. 비어 있으면 전수를 봤다는 뜻이다. */
  readonly unreadable: readonly string[];
}

/** 인스턴스 뿌리 목록 × 각 뿌리의 매니페스트 행 → 연합 행. **순수**(파일·env 무접촉)라 회귀로 잠근다.
 *  ⛔ 살아있는 것만 싣는다 — 죽은 owner 까지 섞으면 *"밖에서 몰 수 있는 것"* 목록이 아니게 된다. */
export function federatedPtyRefs(
  targets: readonly { name: string; dbPath: string }[],
  readRows: (dbPath: string) => readonly { id: string; kind: string; nickname?: string; runId?: string; workdir?: string; terminalOriginCategory?: PtyManifestRow['terminalOriginCategory']; terminalOriginReason?: string; externalToolName?: string; alive: boolean; ownerPid?: number; ptyPid?: number; instance?: string; updatedAt?: number }[],
  alive: (pid: number) => boolean = isProcessAlive,
): FederatedPtyListing {
  const seen = new Set<string>();
  const out: FederatedPtyRef[] = [];
  const unreadable: string[] = [];
  for (const target of targets) {
    let rows: readonly { id: string; kind: string; nickname?: string; runId?: string; workdir?: string; terminalOriginCategory?: PtyManifestRow['terminalOriginCategory']; terminalOriginReason?: string; externalToolName?: string; alive: boolean; ownerPid?: number; ptyPid?: number; instance?: string; updatedAt?: number }[];
    try {
      rows = readRows(target.dbPath);
    } catch {
      unreadable.push(target.name);   // ⛔ 삼키지 않는다 — 못 본 뿌리는 이름으로 남는다
      continue;
    }
    for (const row of rows) {
      if (!row.alive) continue;
      // Keep the observatory's liveness ruler: PTY pid first, owner pid only when it is unknown.
      const pid = row.ptyPid && row.ptyPid > 0 ? row.ptyPid : row.ownerPid ?? 0;
      const ownerProcessAlive = pid > 0 && alive(pid);
      if (!ownerProcessAlive) continue;
      // ⚠️ 같은 물리 뿌리가 두 이름으로 등록될 수 있다 ⇒ id 로 dedup(먼저 만난 이름을 남긴다).
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ instance: row.instance || target.name, id: row.id, kind: row.kind, alive: true, sourceRoot: target.dbPath, ownerProcessAlive, ...(row.nickname ? { nickname: row.nickname } : {}), ...(row.runId ? { runId: row.runId } : {}), ...(row.workdir ? { workdir: row.workdir } : {}), ...(row.terminalOriginCategory ? { terminalOriginCategory: row.terminalOriginCategory } : {}), ...(row.terminalOriginReason ? { terminalOriginReason: row.terminalOriginReason } : {}), ...(row.externalToolName ? { externalToolName: row.externalToolName } : {}), ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }) });
    }
  }
  return { refs: out, unreadable };
}
interface PtyLineageRow {
  readonly ptyId: string;
  readonly kind: string;
  readonly instance: string;
  readonly sourceRoot?: string;
  readonly alive: boolean;
  readonly startedAt: number;
  readonly closedAt: number;
  readonly parentPtyId: string;
  readonly parentPid: number;
  readonly parentKind: string;
  readonly runId: string;
  readonly runIdSource: RunIdSource | '';
  readonly workdir?: string;
  readonly codeSha: string;
  readonly spaceId?: string;
  readonly nestDepth?: number;
  readonly originRoot?: string;
  readonly controller?: string;
}

interface PtyLineageGroup {
  readonly joinedBy: 'parent' | 'run' | 'workdir-heuristic';
  readonly key: string;
  readonly rows: readonly PtyLineageRow[];
  readonly parentMissing: boolean;
}

interface PtyLineageRoot {
  readonly name: string;
  readonly dbPath: string;
}

const PTY_LINEAGE_SCOPE = 'process-lineage';
const PTY_LINEAGE_NOTE = '이 런에 누가 참가했는지는 elanous self participants가 답합니다.';

interface PtyLineageResult {
  readonly scope: typeof PTY_LINEAGE_SCOPE;
  readonly note: typeof PTY_LINEAGE_NOTE;
  readonly groups: readonly PtyLineageGroup[];
  readonly unreadablePayloads: number;
  readonly unreadableRoots?: readonly PtyLineageRoot[];
  readonly missingRoots?: readonly PtyLineageRoot[];
}

function ptyLineageResult(groups: readonly PtyLineageGroup[], unreadablePayloads: number): PtyLineageResult {
  return { scope: PTY_LINEAGE_SCOPE, note: PTY_LINEAGE_NOTE, groups, unreadablePayloads };
}

type PtyLifecyclePayload = {
  event?: unknown; ptyId?: unknown; kind?: unknown; instance?: unknown; runId?: unknown; runIdSource?: unknown; workdir?: unknown; codeSha?: unknown;
  parentPtyId?: unknown; parentPid?: unknown; parentKind?: unknown; startedAt?: unknown; closedAt?: unknown;
};

function stringField(value: unknown): string { return typeof value === 'string' ? value : ''; }
function numberField(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function isLifecyclePayload(value: unknown): value is PtyLifecyclePayload {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lineageRowFromManifest(row: PtyManifestRow & { readonly sourceRoot?: string }): PtyLineageRow {
  return {
    ptyId: row.id, kind: row.kind, instance: row.instance, ...(row.sourceRoot ? { sourceRoot: row.sourceRoot } : {}),
    alive: row.alive, startedAt: row.startedAt, closedAt: row.closedAt, parentPtyId: row.parentPtyId, parentPid: row.parentPid,
    parentKind: row.parentKind, runId: row.runId, runIdSource: normalizeRunIdSource(row.runIdSource),
    ...(row.workdir ? { workdir: row.workdir } : {}), codeSha: row.codeSha,
    ...(row.spaceId !== undefined ? { spaceId: row.spaceId } : {}),
    ...(row.nestDepth !== undefined ? { nestDepth: row.nestDepth } : {}),
    ...(row.originRoot !== undefined ? { originRoot: row.originRoot } : {}),
    ...(row.controller !== undefined ? { controller: row.controller } : {}),
  };
}

const lifecycleEvents = new Set(['spawned', 'exited', 'seen-alive', 'seen-dead', 'seen-stale', 'seen-orphan', 'seen-purge', 'seen-remove']);
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type PtyLifecyclePatch = Partial<Mutable<PtyLineageRow>> & { ptyId: string };

function lifecyclePatchFromEvent(row: PtyEventRow, payload: PtyLifecyclePayload): PtyLifecyclePatch | null {
  const ptyId = stringField(payload.ptyId);
  const event = stringField(payload.event);
  if (!ptyId || !lifecycleEvents.has(event)) return null;
  const patch: PtyLifecyclePatch = { ptyId };
  const assignString = <K extends 'kind' | 'instance' | 'parentPtyId' | 'parentKind' | 'runId' | 'workdir' | 'codeSha'>(key: K): void => {
    if (typeof payload[key] === 'string') patch[key] = payload[key] as PtyLineageRow[K];
  };
  const assignRunIdSource = (): void => {
    if (typeof payload.runIdSource === 'string') patch.runIdSource = normalizeRunIdSource(payload.runIdSource);
  };
  const assignNumber = <K extends 'startedAt' | 'closedAt' | 'parentPid'>(key: K): void => {
    if (typeof payload[key] === 'number' && Number.isFinite(payload[key])) patch[key] = payload[key] as PtyLineageRow[K];
  };
  for (const key of ['kind', 'parentPtyId', 'parentKind', 'runId', 'workdir', 'codeSha'] as const) assignString(key);
  assignRunIdSource();
  if (typeof payload.instance === 'string') patch.instance = payload.instance;
  else if (event === 'spawned') patch.instance = row.instance;
  const sourceRoot = (row as PtyEventRow & { readonly sourceRoot?: string }).sourceRoot;
  if (sourceRoot) patch.sourceRoot = sourceRoot;
  for (const key of ['startedAt', 'parentPid'] as const) assignNumber(key);
  if (event === 'spawned' || event === 'seen-alive') {
    patch.alive = true;
    if (event === 'spawned') patch.closedAt = 0;
  } else {
    patch.alive = false;
    patch.closedAt = numberField(payload.closedAt) || row.tsMs;
  }
  return patch;
}

function mergeLifecyclePatch(previous: PtyLineageRow | undefined, patch: PtyLifecyclePatch): PtyLineageRow {
  const base: PtyLineageRow = previous ?? {
    ptyId: patch.ptyId, kind: '', instance: '', alive: true, startedAt: 0, closedAt: 0,
    parentPtyId: '', parentPid: 0, parentKind: '', runId: '', runIdSource: '', codeSha: '',
  };
  return {
    ...base,
    ...patch,
    startedAt: base.startedAt || patch.startedAt || 0,
    ...(patch.workdir === undefined ? (base.workdir ? { workdir: base.workdir } : {}) : patch.workdir ? { workdir: patch.workdir } : {}),
  };
}

/** A ledger seq is only meaningful inside its own database. Preserve target encounter order across ledgers,
 * while restoring the local reader's ascending-seq contract inside each ledger. */
function lifecycleRowsByLedgerSequence(lifecycleRows: readonly PtyEventRow[]): PtyEventRow[] {
  const ledgers = new Map<string, PtyEventRow[]>();
  for (const row of lifecycleRows) {
    const sourceRoot = (row as PtyEventRow & { readonly sourceRoot?: string }).sourceRoot ?? '';
    const ledger = ledgers.get(sourceRoot) ?? [];
    ledger.push(row);
    ledgers.set(sourceRoot, ledger);
  }
  return [...ledgers.values()].flatMap((ledger) => [...ledger].sort((a, b) => a.seq - b.seq));
}

/** 매니페스트 현재행과 lifecycle 원장을 한 계보 조회용 그룹으로 결합한다. 순수 함수다. */
export function joinPtyLineage(
  manifestRows: readonly PtyManifestRow[],
  lifecycleRows: readonly PtyEventRow[],
  query: string,
): PtyLineageResult {
  const rows = new Map<string, PtyLineageRow>();
  let unreadablePayloads = 0;
  for (const event of lifecycleRowsByLedgerSequence(lifecycleRows)) {
    if (event.kind !== 'lifecycle') continue;
    if (!event.payload) { unreadablePayloads++; continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(event.payload); } catch { unreadablePayloads++; continue; }
    if (!isLifecyclePayload(parsed)) { unreadablePayloads++; continue; }
    const patch = lifecyclePatchFromEvent(event, parsed);
    if (!patch) { unreadablePayloads++; continue; }
    const previous = rows.get(patch.ptyId);
    if (previous?.sourceRoot && patch.sourceRoot && previous.sourceRoot !== patch.sourceRoot) continue;
    rows.set(patch.ptyId, mergeLifecyclePatch(previous, patch));
  }
  // The manifest is the current-state authority, so it supersedes its ledger snapshot for the same PTY.
  // Across roots, preserve the first target exactly as the manifest federation does.
  const manifestIds = new Set<string>();
  for (const row of manifestRows) {
    if (manifestIds.has(row.id)) continue;
    manifestIds.add(row.id);
    rows.set(row.id, lineageRowFromManifest(row));
  }
  const allRows = [...rows.values()];
  const byId = allRows.filter((row) => row.ptyId === query);
  const byRun = allRows.filter((row) => row.runId === query);
  // ⛔⭐ 접미사 일치는 «경로 경계»에서만 문다 — 맨 `endsWith(query)` 는 `a` 같은 짧은 문자열이
  //   거의 모든 workdir 에 걸려, 어느 축과도 안 맞는 키에 «휴리스틱 그룹을 지어낸다».
  //   ⇒ 정확히 같거나, 마지막 경로 조각으로 끝날 때만(= `/` 뒤에 붙을 때만) 문다.
  const byWorkdir = allRows.filter((row) => row.workdir === query || row.workdir?.endsWith(`/${query}`));
  const byMissingParent = byId.length === 0 ? allRows.filter((row) => row.parentPtyId === query) : [];
  const selected = byId.length > 0 ? byId : byRun.length > 0 ? byRun : byWorkdir.length > 0 ? byWorkdir : byMissingParent;
  if (selected.length === 0) return ptyLineageResult([], unreadablePayloads);
  // ⛔⭐⭐⭐ 계보는 «전이적»이다 — 한 단계만 보면 손자가 빠지고 조상이 사라진다.
  //   종전 구현은 `ptyId === parentKey || parentPtyId === parentKey` 로 **직계 한 겹**만 모았다.
  //   그래서 A→B→C 에서 A 를 물으면 C 가 빠지고, C 를 물으면 그룹 키는 A 인데 A 행이 결과에 없는
  //   («parentMissing=false 인데 그 행이 안 보이는») 모순이 났다. ⇒ 위로 뿌리까지 · 아래로 전부, 둘 다 전이적으로 편다.
  const rowById = new Map(allRows.map((row) => [row.ptyId, row]));
  const childrenByParent = new Map<string, PtyLineageRow[]>();
  for (const row of allRows) {
    if (!row.parentPtyId) continue;
    const siblings = childrenByParent.get(row.parentPtyId) ?? [];
    siblings.push(row);
    childrenByParent.set(row.parentPtyId, siblings);
  }
  /** 부모 간선을 끝까지 타고 올라간 뿌리 id. ⭐ 부모 «id 는 있는데 행이 이 뿌리에 없으면» 그 id 가 뿌리다
   *  (부모와 자식은 서로 다른 우주의 매니페스트에 등록될 수 있다 — 그 경우 `parentMissing` 이 참이 된다).
   *  ⛔ `visited` 는 순환 방어다 — 매니페스트가 손상돼 A→B→A 가 되어도 멈춘다. */
  const rootOf = (startId: string): string => {
    let current = startId;
    const visited = new Set<string>([current]);
    for (;;) {
      const parentId = rowById.get(current)?.parentPtyId;
      if (!parentId || visited.has(parentId)) return current;
      visited.add(parentId);
      if (!rowById.has(parentId)) return parentId;   // 이 뿌리에 없는 부모 — 그 id 로 묶는다
      current = parentId;
    }
  };
  /** 뿌리에서 아래로 «전부». 뿌리 행 자신도 (있으면) 포함한다 — 그것이 없으면 `parentMissing=false` 인데
   *  그 행이 안 보이는 모순이 다시 난다. */
  const descendantsOf = (rootId: string): PtyLineageRow[] => {
    const out: PtyLineageRow[] = [];
    // ⚠️ 큐(너비 우선)다 — 스택으로 하면 형제 순서가 «뒤집힌다». 같은 `startedAt` 인 행들은 최종
    //   정렬이 안정 정렬이라 여기 순서가 그대로 남으므로, 발견 순서가 곧 출력 순서가 된다.
    const queue: string[] = [rootId];
    const visited = new Set<string>();
    for (let head = 0; head < queue.length; head += 1) {
      const id = queue[head]!;
      if (visited.has(id)) continue;
      visited.add(id);
      const row = rowById.get(id);
      if (row) out.push(row);
      for (const child of childrenByParent.get(id) ?? []) queue.push(child.ptyId);
    }
    return out;
  };
  // ⛔⭐⭐⭐ 전이 확장은 «모든 진입 축»에 걸린다 — 종전엔 `ptyId`/부모-부재 경로에만 걸려서,
  //   `runId`·`workdir` 로 물으면 그 축을 «안 가진» 조상·후손이 통째로 빠졌다(리뷰 지적).
  //   ⇒ 씨앗이 무엇으로 뽑혔든 각 씨앗을 뿌리까지 올린 뒤 후손 전부를 편다.
  const seedIds = byMissingParent.length > 0 ? [query] : selected.map((row) => row.ptyId);
  const ptyIdSeedIds = new Set(byId.map((row) => row.ptyId));
  // ptyId 가 맞으면 그 선택이 우선이다. runId/workdir 충돌 행의 계보는 이 질의의 확장 근거가 아니다.
  const lineageSeedIds = ptyIdSeedIds.size > 0 ? [...ptyIdSeedIds] : seedIds;
  const expanded = new Map<string, PtyLineageRow>();
  const edgelessRunSiblings = new Map<string, PtyLineageRow>();
  let sawParentEdge = false;
  for (const seedId of lineageSeedIds) {
    const root = rootOf(seedId);
    const seed = rowById.get(seedId);
    // 뿌리가 씨앗 자신이고 자식도 없으면 그 씨앗엔 부모 간선이 «없다» — ptyId 질의라면 같은 run의 형제를 보탠다.
    if (root === seedId && !seed?.parentPtyId && (childrenByParent.get(seedId)?.length ?? 0) === 0) {
      if (ptyIdSeedIds.has(seedId) && seed?.runId) {
        for (const row of allRows) if (row.runId === seed.runId) edgelessRunSiblings.set(row.ptyId, row);
      }
      continue;
    }
    sawParentEdge = true;
    for (const row of descendantsOf(root)) expanded.set(row.ptyId, row);
  }
  // 부모 간선이 하나도 없으면 씨앗과, ptyId로 찾은 고립 씨앗의 같은 run 형제만 scope에 둔다.
  // ⚠️ `expanded` 가 «먼저»다 — 그것이 뿌리→후손 위상 순서이고, 씨앗을 앞세우면 그 순서가 깨진다
  //   (같은 `startedAt` 인 행들은 최종 안정 정렬이 여기 순서를 그대로 남긴다).
  const scope = sawParentEdge
    ? [...new Map([...expanded.values(), ...selected].map((row) => [row.ptyId, row])).values()]
    : [...new Map([...selected, ...edgelessRunSiblings.values()].map((row) => [row.ptyId, row])).values()];
  const grouped = new Map<string, PtyLineageGroup>();
  const lineageRoot = (row: PtyLineageRow): string => {
    const root = rootOf(row.ptyId);
    // 자기 자신이 뿌리인데 자식이 없으면 «부모 간선이 없다» — 그때만 빈 문자열을 돌려 run/workdir 로 넘긴다.
    if (root === row.ptyId && !row.parentPtyId && (childrenByParent.get(row.ptyId)?.length ?? 0) === 0) return '';
    return root;
  };
  for (const row of scope) {
    const edgeKey = lineageRoot(row);
    const joinedBy = edgeKey ? 'parent' : row.runId ? 'run' : row.workdir ? 'workdir-heuristic' : null;
    const key = edgeKey || row.runId || row.workdir;
    if (!joinedBy || !key) continue;
    const groupKey = `${joinedBy}:${key}`;
    const group = grouped.get(groupKey);
    if (group) { (group.rows as PtyLineageRow[]).push(row); continue; }
    const parentMissing = joinedBy === 'parent' && !allRows.some((candidate) => candidate.ptyId === key);
    grouped.set(groupKey, { joinedBy, key, rows: [row], parentMissing });
  }
  return ptyLineageResult([...grouped.values()].map((group) => ({ ...group, rows: [...group.rows].sort((a, b) => a.startedAt - b.startedAt) })), unreadablePayloads);
}

export interface PtyTakeoverCommandDeps {
  getPty(id: string): PtyControlTarget | undefined;
  requestPtyTakeover(id: string, actor: 'human'): boolean;
  requestRemote(id: string, action: PtyControlAction, payload?: PtyControlPayload, options?: PtyControlRequestOptions): Promise<PtyControlResult>;
  readManifestFrame?(id: string): { readonly frame: string; readonly frameAt: number } | null;
  listManifestRows?(): readonly PtyManifestRow[];
  listManifestRowsAt?(dbPath: string): readonly PtyManifestRow[];
  currentManifestDbPath?(): string;
  realpath?(path: string): string;
  removeManifest?(id: string): void;
  isProcessAlive?(pid: number): boolean;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  readLifecycleRows?(): readonly PtyEventRow[];
  /** Read-only control inbox snapshot; injected so lineage tests do not require a real state root. */
  inspectControlInbox?(spaceId: string): ControlInboxSnapshot;
  readFederatedLineage?(opts: { includeTest: boolean }): { readonly manifestRows: readonly (PtyManifestRow & { readonly sourceRoot?: string })[]; readonly lifecycleRows: readonly PtyEventRow[]; readonly unreadableRoots: readonly PtyLineageRoot[]; readonly missingRoots: readonly PtyLineageRoot[] };
  listRefs?(): readonly PtyListItem[];
  readAddressBook?(): PtyAddressBook;
  /** Current instance's reusable PWA base, resolved once for each list invocation. */
  resolveNexusPwa?(): NexusPwaResolution;
  /** ⭐ 등록 인스턴스 전체의 살아있는 PTY(조회 전용). 미주입이면 `--all` 은 fail-closed. */
  listFederatedRefs?(opts: { includeTest: boolean }): FederatedPtyListing;
  reapManifestAt?(dbPath: string, opts: { readonly apply?: boolean }): PtyManifestExternalReapResult;
  manifestTargets?(opts: { includeTest: boolean }): readonly { name: string; dbPath: string }[];
  /** 이 프로세스의 run anchor ⊕ 대상 PTY 의 run anchor — `--actor agent` 인가에만 쓰인다(주입 가능=테스트). */
  runIdentity?(ptyId: string): { readonly requester: string; readonly target: string };
  /** PTY의 실행 원장 종결 상태. 원장을 찾거나 판정할 수 없으면 원인을 함께 둔다. */
  runTerminated?(runId: string, opts?: { includeTest: boolean }): RunTermination;
  /** `pty list`의 원장 우선 ⊕ checkpoint 폴백 관측. 기존 runTerminated 소비자는 그대로 둔다. */
  runTerminationResolution?(runId: string, opts: { includeTest: boolean }): RunTerminationResolution;
  /** Worktree provenance reader; injected so list tests can cover every git outcome without a repository. */
  resolveWorktreeProvenance?(workdir?: string): PtyWorktreeProvenance;
  /** 관측 sink 등록 — 독립 CLI 프로세스는 데몬 StoreSink 를 상속하지 않는다. 주입 가능(테스트가 실 db 를 안 건드린다). */
  registerObservationSink?(): Promise<void>;
  /** Bookmark store for `pty list -r` / `--remote <name>`. Tests inject a fixture store. */
  remotesStore?(): RemotesStore;
  /** Authenticated GET /v1/terminals. Tests inject a mock; live path uses fetch. */
  fetchRemoteTerminals?(url: string, token: string): Promise<RemoteTerminalsFetchResult>;
  /** Authenticated POST /v1/terminals/:id/control. Tests inject a mock; live path uses fetch. */
  postRemoteTerminalControl?(url: string, token: string, body: RemoteTerminalControlBody): Promise<RemoteTerminalControlFetchResult>;
  log(event: string, data: Record<string, unknown>): void;
}

type RemoteTerminalControlBody =
  | { readonly action: 'input-text' | 'input-key'; readonly chars: string }
  | ({ readonly action: 'input-mouse' } & PtyMouseInput)
  | { readonly action: 'snapshot'; readonly ansi?: true };

type RemoteTerminalControlFetchResult =
  | { readonly ok: true; readonly status: number; readonly json: unknown }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/** HTTP GET /v1/terminals result. Failures stay named — never a local listing.
 *  ⚠️ 내부 타입 — 파일 밖 소비자 없음(dead export 금지). */
type RemoteTerminalsFetchResult =
  | { readonly ok: true; readonly terminals: readonly RemoteTerminalListItem[] }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/** Remote-daemon terminal row. Fields the remote cannot know stay optional.
 *  ⚠️ 내부 타입 — 파일 밖 소비자 없음(dead export 금지). */
interface RemoteTerminalListItem {
  readonly id: string;
  readonly kind?: string;
  readonly nickname?: string;
  readonly runId?: string;
  readonly instance?: string;
  readonly alive?: boolean;
  readonly workdir?: string;
  readonly terminalOriginCategory?: PtyManifestRow['terminalOriginCategory'];
  readonly terminalOriginReason?: string;
  readonly externalToolName?: string;
  readonly startedAt?: number;
  readonly outputBytes?: number;
  readonly lastControlAt?: number;
  readonly ownerProcessAlive?: boolean;
  readonly sourceRoot?: { readonly name: string; readonly dbPath: string };
}

export function listPtyRefs(
  localHandles: readonly Pick<PtyHandle, 'id' | 'kind' | 'nickname' | 'isAlive' | 'accessMode' | 'workdir'>[],
  manifestRows: readonly { id: string; kind: string; nickname?: string; runId?: string; alive: boolean; workdir?: string; terminalOriginCategory?: PtyManifestRow['terminalOriginCategory']; terminalOriginReason?: string; externalToolName?: string }[],
): PtyListItem[] {
  // ⭐ 로컬 우선 — 같은 id 가 양쪽에 있으면 **로컬 handle 이 진실**이다(같은 프로세스의 실시간 상태).
  //    manifest 의 `alive` 는 하트비트 기반이라 stale 할 수 있어(프로세스가 죽어도 한동안 alive=1),
  //    로컬이 dead 면 manifest 가 alive 라 해도 **dead 로 보고한다**. 관측 창구가 거짓을 말하지 않게 하는 쪽.
  //    단, handle에는 등록 당시의 terminal-origin 결정이 없으므로 동일 행의 영속 메타데이터만 병합한다.
  const manifestById = new Map(manifestRows.map((row) => [row.id, row]));
  const local = localHandles.map((handle) => {
    const manifest = manifestById.get(handle.id);
    return {
      id: handle.id, kind: handle.kind, source: 'local' as const, alive: handle.isAlive(), mode: handle.accessMode,
      ...(handle.nickname ? { nickname: handle.nickname } : {}), ...(handle.workdir ? { workdir: handle.workdir } : {}),
      ...(manifest?.terminalOriginCategory ? { terminalOriginCategory: manifest.terminalOriginCategory } : {}),
      ...(manifest?.terminalOriginReason ? { terminalOriginReason: manifest.terminalOriginReason } : {}),
      ...(manifest?.externalToolName ? { externalToolName: manifest.externalToolName } : {}),
    };
  });
  const ids = new Set(local.map((item) => item.id));
  return [...local, ...manifestRows.filter((row) => !ids.has(row.id)).map((row) => ({ id: row.id, kind: row.kind, source: 'remote' as const, alive: row.alive, ...(row.nickname ? { nickname: row.nickname } : {}), ...(row.workdir ? { workdir: row.workdir } : {}), ...(row.runId ? { runId: row.runId } : {}), ...(row.terminalOriginCategory ? { terminalOriginCategory: row.terminalOriginCategory } : {}), ...(row.terminalOriginReason ? { terminalOriginReason: row.terminalOriginReason } : {}), ...(row.externalToolName ? { externalToolName: row.externalToolName } : {}) }))];
}

export function readLivePtyAddressBook(): PtyAddressBook {
  const local = listPty();
  const localIds = new Set(local.map((handle) => handle.id));
  try { reapDeadPtyManifest(); } catch { /* fail-soft */ }
  try { reapStalePtyManifest(Date.now()); } catch { /* fail-soft */ }
  const rows = listPtyManifest();
  const manifest = rows.filter((row) => row.alive);
  const deadRefs = rows
    .filter((row) => !row.alive && !localIds.has(row.id))
    .map((row) => {
      const livenessSource = row.livenessSource ?? (row.ptyPid > 0 ? 'pty-pid' : 'owner-pid');
      const otherPid = livenessSource === 'pty-pid' ? row.ownerPid : row.ptyPid;
      const otherAlive = otherPid > 0 && isProcessAlive(otherPid);
      return {
        id: row.id, kind: row.kind, source: 'remote' as const, alive: false, livenessSource, exitCode: row.exitCode,
        ...(livenessSource === 'pty-pid' ? { ownerAlive: otherAlive } : row.ptyPid > 0 ? { ptyAlive: otherAlive } : {}),
        ...(row.nickname ? { nickname: row.nickname } : {}),
      };
    });
  return {
    refs: listPtyRefs(local, manifest).filter((row) => row.alive),
    deadRefs,
  };
}

const liveDeps: PtyTakeoverCommandDeps = {
  getPty, requestPtyTakeover, requestRemote: requestRemotePtyControl, readManifestFrame: readPtyManifestFrame,
  // `find`/`retire` must prove before removal: this reader never invokes any reaper.
  listManifestRows: listPtyManifestRows,
  listManifestRowsAt: listPtyManifestRowsAt,
  currentManifestDbPath: ptyManifestDbPath,
  realpath: (path) => { try { return realpathSync(path); } catch { return path; } },
  removeManifest: removePtyManifest,
  isProcessAlive,
  now: Date.now,
  readLifecycleRows: () => readPtyEventsAfter(0, { kind: 'lifecycle' }),
  inspectControlInbox,
  readFederatedLineage({ includeTest }) {
    const manifestRows = ptyManifestTargets({ includeTest }).flatMap((target) => listPtyManifestRowsAt(target.dbPath).map((row) => ({ ...row, sourceRoot: target.name })));
    const lifecycleRows: PtyEventRow[] = [];
    const unreadableRoots: PtyLineageRoot[] = [];
    const missingRoots: PtyLineageRoot[] = [];
    for (const target of ptyEventLogTargets({ includeTest })) {
      const result: PtyEventLogReadResult = readPtyEventsAfterAt(target.dbPath, 0, { kind: 'lifecycle' });
      if (result.status === 'ok') lifecycleRows.push(...result.rows.map((row) => ({ ...row, sourceRoot: target.name })));
      else if (result.status === 'missing') missingRoots.push(target);
      else unreadableRoots.push(target);
    }
    return { manifestRows, lifecycleRows, unreadableRoots, missingRoots };
  },
  readAddressBook: readLivePtyAddressBook,
  resolveNexusPwa,
  // ⭐ 재발명 0 — `fleet screen --all` 이 쓰는 것과 **같은 인스턴스 열거 ⊕ 같은 db 경로**(`frame` =
  //    `<stateDir>/pty/manifest.db`)를 그대로 쓴다. 다른 목록을 만들면 두 창구가 갈린다.
  // ⭐⭐ 열거는 `ptyManifestTargets`(SSOT) 한 곳이다 — `fleet screen --all` 과 **같은 함수**.
  //    ⛔ 여기서 다시 조립했다가 리뷰가 잡았다(두 창구가 갈린다).
  //    ⚠️ 정적 import 로 배선한다 — `runPtyList` 는 동기라 `await import` 를 못 쓰고,
  //      ESM 에서 `require` 는 런타임 의존이다(Bun 에선 돌지만 계약으로 삼지 않는다·리뷰 must-fix).
  listFederatedRefs({ includeTest }) {
    return federatedPtyRefs(federatedManifestTargets(ptyManifestTargets({ includeTest }), ptyManifestDbPath(), (path) => { try { return realpathSync(path); } catch { return path; } }), (dbPath) => listPtyManifestRowsAt(dbPath));
  },
  reapManifestAt: reapDeadPtyManifestAt,
  manifestTargets: ({ includeTest }) => ptyManifestTargets({ includeTest }),
  runIdentity: (ptyId) => ({ requester: getHarnessRunId(process.env), target: getPtyManifest(ptyId)?.runId ?? '' }),
  // ⛔⭐ 원장 «전용»으로 둔다 — 이 축은 종전부터 있던 계약이고 다른 소비자가 있을 수 있다.
  //   런 스토어 폴백은 `pty list` 가 쓰는 `runTerminationResolution` «한 경로»에만 둔다(리뷰 must-fix).
  //   🩹 이 판이 여는 값은 「원장이 침묵할 때 다른 대장이 답한다」이지 「기존 답을 바꾼다」가 아니다.
  runTerminated(runId, opts = { includeTest: false }) {
    return resolveRunTermination(
      runId,
      resolveFederatedRunLedgerDirectories({ includeTest: opts.includeTest }),
      loadRunLedger,
      (event, data) => debug.log('pty.takeover', event, data),
    );
  },
  runTerminationResolution(runId, opts) {
    return ptyListRunTermination(
      runId,
      resolveFederatedRunLedgerDirectories({ includeTest: opts.includeTest }),
      loadRunLedger,
      (path) => readFileSync(path, 'utf8'),
      isProcessAlive,
      liveProcessStartedAt,
      (event, data) => debug.log('pty.takeover', event, data),
    );
  },
  // ⚠️ 관측 갭 봉합 — `elanous pty` 는 독립 CLI 프로세스라 데몬의 StoreSink 를 상속하지 않는다. 등록 없이는
  //    아래 `log`(=`debug.log('pty.takeover', …)`)가 **파일 트레일에만** 남아 `elanous logs --category
  //    pty.takeover` 로 안 보였다(= 관측 안 한 것). 인가 거부 사유가 조회되지 않으면 이 슬라이스는
  //    진단 자체가 불가능하다. fail-open — 등록이 실패해도 명령은 그대로 돈다.
  async registerObservationSink() {
    try { await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('pty'); } catch { /* fail-open */ }
  },
  log(event, data) { debug.log('pty.takeover', event, data); },
};

// ⚠️ `--actor` 파싱은 **arbiter 의 `parsePtyWriteActor` 가 SSOT** 다 — IPC 컬럼과 CLI 플래그는 둘 다
//    "신뢰 경계 밖 문자열" 이라 규칙이 하나여야 한다(여기에 같은 판정을 다시 쓰면 두 창구가 갈린다).

function addressBookFor(ref: string, deps: PtyTakeoverCommandDeps): PtyAddressBook {
  if (deps.readAddressBook) return deps.readAddressBook();
  return {
    refs: deps.listRefs?.() ?? [{ id: ref, kind: 'unknown', source: 'remote', alive: true }],
    deadRefs: [],
  };
}
function deadPtyMessage(action: string, ref: string, dead: DeadPtyRef): string {
  const subject = dead.livenessSource === 'pty-pid' ? 'PTY' : 'owner';
  const other = dead.livenessSource === 'pty-pid'
    ? dead.ownerAlive === true ? '; owner is alive' : ''
    : dead.ptyAlive === true ? '; PTY is alive' : '';
  const exitCode = dead.exitCode === null ? '' : ` (exitCode=${dead.exitCode})`;
  return `pty ${action}: ${subject} for ${ref} has exited${exitCode}${other}`;
}
function deadPtyRef(ref: string, addressBook: PtyAddressBook): DeadPtyRef | null {
  const resolved = resolvePtyRef(ref, addressBook.deadRefs);
  return (resolved.match as DeadPtyRef | null) ?? null;
}
function resolveId(ref: string, action: string, deps: PtyTakeoverCommandDeps): string | PtyTakeoverCommandResult {
  const addressBook = addressBookFor(ref, deps);
  const resolved = resolvePtyRef(ref, addressBook.refs);
  if (resolved.match) return resolved.match.id;
  if (resolved.reason === 'ambiguous') return { exitCode: 1, message: `pty: ambiguous ref ${ref}; candidates: ${resolved.candidates.map((x) => x.id).join(', ')}` };
  const dead = deadPtyRef(ref, addressBook);
  if (dead) return { exitCode: 1, message: deadPtyMessage(action, ref, dead) };
  if (ref.startsWith('agent:')) return { exitCode: 1, message: `pty: ${ref} is a participant without a PTY and cannot be controlled by this command; inspect it via the observatory list or elanous logs` };
  const count = addressBook.refs.length;
  return { exitCode: 1, message: `pty: ${ref} was not found in the current instance address book (${count} live PTY ref${count === 1 ? '' : 's'}); inspect all registered instances with elanous pty list --all --include-test` };
}
function unreachableMessage(action: string, ptyId: string, deps: PtyTakeoverCommandDeps): PtyTakeoverCommandResult {
  if (!deps.readAddressBook) return { exitCode: 1, message: `pty ${action}: owner for ${ptyId} is unreachable` };
  try {
    const dead = deadPtyRef(ptyId, deps.readAddressBook());
    return dead
      ? { exitCode: 1, message: deadPtyMessage(action, ptyId, dead) }
      : { exitCode: 1, message: `pty ${action}: owner for ${ptyId} is unreachable` };
  } catch {
    return { exitCode: 1, message: `pty ${action}: owner for ${ptyId} is unreachable` };
  }
}
/** 관측용 화면 크기. ⚠️ `screen.length` 는 **UTF-16 코드 단위**라 한글·이모지 화면에서
 *  바이트 수가 아니다(무인 리뷰 must-fix · 2026-07-29). TUI 화면은 한글이 흔하므로
 *  `Buffer.byteLength` 로 **실제 UTF-8 바이트**를 센다 — 안 그러면 payload 가 거짓을 말한다. */
function screenMetadata(screen: string): Record<string, number> { return { bytes: Buffer.byteLength(screen, 'utf8'), lines: screen === '' ? 0 : screen.split('\n').length }; }
function formatSnapshotResult(ptyId: string, control: PtyControlResult, status = 'running'): string {
  if (control.status === 'success') {
    const source = control.source ?? 'live';
    return `PtyShellSnapshot process_id=${ptyId} status=${status} source=${source}${source === 'frame' ? ` fallback=${control.diagnostic ?? 'render-unavailable'} frame_at=${control.frameAt ?? 0}` : ''}\n${control.screen ?? ''}`;
  }
  const reason = control.reason ?? control.status;
  return `pty snapshot: failed for ${ptyId} (reason=${reason}${control.diagnostic ? ` cause=${control.diagnostic}` : ''}${control.frameUnavailable ? ' frame=unavailable' : ''})`;
}
function manifestFrameSnapshot(id: string, deps: PtyTakeoverCommandDeps): PtyControlResult | null {
  const readFrame = deps.readManifestFrame ?? readPtyManifestFrame;
  const frame = readFrame(id);
  return frame ? { status: 'success', screen: frame.frame, source: 'frame', frameAt: frame.frameAt } : null;
}
function needsManifestFrame(control: PtyControlResult): boolean {
  return control.status === 'unknown-pty'
    || control.status === 'owner-unreachable'
    || (control.status === 'failed' && control.reason?.startsWith('screen-') === true);
}
function snapshotWithFallback(id: string, control: PtyControlResult, deps: PtyTakeoverCommandDeps): PtyControlResult {
  if (!needsManifestFrame(control)) return control;
  const diagnostic = control.status === 'unknown-pty' || control.status === 'owner-unreachable'
    ? 'owner-unavailable'
    : 'render-unavailable';
  const frame = manifestFrameSnapshot(id, deps);
  if (frame) return { ...frame, diagnostic };
  return { status: 'failed', reason: 'screen-unavailable', diagnostic, frameUnavailable: true };
}
function mapResult(action: string, ptyId: string, control: PtyControlResult, deps: PtyTakeoverCommandDeps, safe: Record<string, unknown> = {}): PtyTakeoverCommandResult {
  if (control.status === 'success') {
    // ⚠️ snapshot 은 분기 안에서 좁힌다 — 삼항으로 만든 `string | undefined` 를 같은 조건의
    //    다른 분기에서 쓰면 TS 가 두 조건을 상관시키지 못해 진단이 난다(실측 TS2345).
    if (action === 'snapshot') {
      const screen = control.screen ?? '';
      const source = control.source ?? 'live';
      deps.log(action, { ptyId, action, ...safe, source, ...(source === 'frame' ? { frameAt: control.frameAt ?? 0, fallback: control.diagnostic } : {}), ...screenMetadata(screen), from: control.from, to: control.to });
      return { exitCode: 0, message: formatSnapshotResult(ptyId, control) };
    }
    deps.log(action, { ptyId, action, ...safe, from: control.from, to: control.to });
    if (action === 'takeover') return { exitCode: 0, message: `pty takeover: ${ptyId} is now human write-owned` };
    if (action === 'release') return { exitCode: 0, message: `pty release: ${ptyId} returned to ${control.to ?? 'its prior'} mode` };
    return { exitCode: 0, message: `pty ${action}: delivered to ${ptyId}` };
  }
  const reason = control.reason ?? control.status;
  if (action === 'takeover' || action === 'release') {
    deps.log('denied', { ptyId, action, reason });
    if (control.status === 'unknown-pty') return { exitCode: 1, message: `pty ${action}: ${ptyId} was not found` };
    if (control.status === 'owner-unreachable') return unreachableMessage(action, ptyId, deps);
    return { exitCode: 1, message: `pty ${action}: denied for ${ptyId} (${reason})` };
  }
  if (control.status === 'denied') {
    deps.log('denied', { ptyId, action, reason, ...safe });
    return { exitCode: 1, message: `pty ${action}: denied for ${ptyId} (${reason})` };
  }
  deps.log('failed', { ptyId, action, reason, diagnostic: control.diagnostic, frameUnavailable: control.frameUnavailable, ...safe });
  if (action === 'snapshot') return { exitCode: 1, message: formatSnapshotResult(ptyId, control) };
  if (control.status === 'unknown-pty') return { exitCode: 1, message: `pty ${action}: ${ptyId} was not found` };
  if (control.status === 'owner-unreachable') return unreachableMessage(action, ptyId, deps);
  return { exitCode: 1, message: `pty ${action}: failed for ${ptyId} (${reason})` };
}

function formatPtyLineageRoots(roots: readonly PtyLineageRoot[]): string {
  const shown = roots.slice(0, 5).map(({ name, dbPath }) => `${name} (${dbPath})`);
  const folded = roots.length - shown.length;
  return [...shown, ...(folded > 0 ? [`… ${folded} more`] : [])].join(', ');
}

type PtyLineageControl = {
  readonly parentKind: string;
  readonly nestDepth?: number;
  readonly originRoot?: string;
  readonly controller?: string;
  readonly inbox?: ControlInboxSnapshot | { readonly directory: 'unreadable' };
};

type PtyLineageControlResult = Omit<PtyLineageResult, 'groups'> & {
  readonly groups: readonly (Omit<PtyLineageGroup, 'rows'> & { readonly rows: readonly (PtyLineageRow & { readonly control: PtyLineageControl })[] })[];
};

function controlForLineageRow(row: PtyLineageRow, inspect: ((spaceId: string) => ControlInboxSnapshot) | undefined): PtyLineageControl {
  let inbox: ControlInboxSnapshot | { readonly directory: 'unreadable' } | undefined;
  if (row.spaceId && inspect) {
    try { inbox = inspect(row.spaceId); } catch { inbox = { directory: 'unreadable' }; }
  }
  return {
    parentKind: row.parentKind,
    ...(row.nestDepth !== undefined ? { nestDepth: row.nestDepth } : {}),
    ...(row.originRoot !== undefined ? { originRoot: row.originRoot } : {}),
    ...(row.controller !== undefined ? { controller: row.controller } : {}),
    ...(inbox ? { inbox } : {}),
  };
}

function withPtyLineageControl(result: PtyLineageResult, inspect?: (spaceId: string) => ControlInboxSnapshot): PtyLineageControlResult {
  return {
    ...result,
    groups: result.groups.map((group) => ({ ...group, rows: group.rows.map((row) => ({ ...row, control: controlForLineageRow(row, inspect) })) })),
  };
}

function withoutPtyLineageControlFields(result: PtyLineageResult): PtyLineageResult {
  return {
    ...result,
    groups: result.groups.map((group) => ({
      ...group,
      rows: group.rows.map(({ spaceId: _spaceId, nestDepth: _nestDepth, originRoot: _originRoot, controller: _controller, ...row }) => row),
    })),
  };
}

function controlValue(value: string | number | undefined, missing = '?'): string {
  return value === undefined ? missing : value === '' ? '-' : String(value);
}

function isControlInboxSnapshot(inbox: PtyLineageControl['inbox']): inbox is ControlInboxSnapshot {
  return inbox !== undefined && 'memoCount' in inbox;
}

function formatPtyLineage(result: PtyLineageResult | PtyLineageControlResult, control = false): string {
  const lines = [`scope: ${result.scope}`, `note: ${result.note}`, ...result.groups.flatMap((group) => [
    `joinedBy=${group.joinedBy}${group.joinedBy === 'workdir-heuristic' ? ' (ambiguous workdir heuristic; not asserted as one run)' : ''}${group.parentMissing ? ' parent=이 뿌리에 없음' : ''}`,
    ...group.rows.flatMap((row) => {
      const basic = `  ${row.ptyId}\t${row.kind || '-'}\t${row.instance || '-'}\t${row.alive ? 'alive' : 'exited'}\t${row.closedAt || row.startedAt}`;
      if (!control || !('control' in row)) return [basic];
      const detail = row.control;
      const parent = detail.parentKind === 'process' ? 'root' : controlValue(detail.parentKind, '-');
      const parentWithId = detail.parentKind === 'process' || row.parentPtyId === '' ? parent : `${parent}:${row.parentPtyId}`;
      const inbox = detail.inbox;
      const snapshot = isControlInboxSnapshot(inbox) ? inbox : undefined;
      return [basic, `  ctl parent=${parentWithId} depth=${controlValue(detail.nestDepth)} origin=${controlValue(detail.originRoot)} controller=${controlValue(detail.controller)} inbox=${inbox?.directory ?? '?'} memo=${snapshot?.memoCount ?? '?'} stop=${snapshot ? snapshot.stop ? 'yes' : 'no' : '?'}`];
    }),
  ])];
  if (result.unreadablePayloads > 0) lines.push(`⚠️ unreadable lifecycle payloads: ${result.unreadablePayloads}`);
  if (result.missingRoots?.length) lines.push(`⚠️ missing lifecycle ledgers: ${formatPtyLineageRoots(result.missingRoots)}`);
  if (result.unreadableRoots?.length) lines.push(`⚠️ unreadable lifecycle ledgers: ${formatPtyLineageRoots(result.unreadableRoots)}`);
  return lines.length > 0 ? lines.join('\n') : 'pty lineage: no matching lineage found';
}

export function runPtyLineage(
  query: string,
  deps: PtyTakeoverCommandDeps = liveDeps,
  json = false,
  opts: { all?: boolean; includeTest?: boolean; control?: boolean } = {},
): PtyTakeoverCommandResult {
  if (opts.includeTest && !opts.all) return { exitCode: 1, message: 'pty lineage: --include-test requires --all' };
  if (opts.all) {
    if (!deps.readFederatedLineage) return { exitCode: 1, message: 'pty lineage: federated manifest and lifecycle ledger readers are unavailable' };
    const union = deps.readFederatedLineage({ includeTest: opts.includeTest === true });
    const result = { ...joinPtyLineage(union.manifestRows, union.lifecycleRows, query), unreadableRoots: union.unreadableRoots, missingRoots: union.missingRoots };
    const output = opts.control ? withPtyLineageControl(result) : result;
    const jsonOutput = opts.control ? output : withoutPtyLineageControlFields(result);
    return { exitCode: 0, message: json ? JSON.stringify(jsonOutput, null, 2) : formatPtyLineage(output, opts.control) };
  }
  if (!deps.listManifestRows || !deps.readLifecycleRows) {
    return { exitCode: 1, message: 'pty lineage: local manifest and lifecycle ledger readers are unavailable' };
  }
  const result = joinPtyLineage(deps.listManifestRows(), deps.readLifecycleRows(), query);
  const output = opts.control ? withPtyLineageControl(result, deps.inspectControlInbox) : result;
  const jsonOutput = opts.control ? output : withoutPtyLineageControlFields(result);
  return { exitCode: 0, message: json ? JSON.stringify(jsonOutput, null, 2) : formatPtyLineage(output, opts.control) };
}

export interface PtyFindMatch {
  readonly row: PtyManifestRow;
  readonly matchedBy: readonly ('ptyPid' | 'ownerPid' | 'ptyId' | 'runId')[];
}

/** Select manifest rows by independently testing PTY pid, owner pid, PTY id, and run id. */
export function findPtyManifestRows(rows: readonly PtyManifestRow[], key: string): readonly PtyFindMatch[] {
  const requestedPtyPid = Number(key);
  const hasPositivePtyPid = Number.isInteger(requestedPtyPid) && requestedPtyPid > 0;
  return rows.flatMap((row) => {
    const matchedBy = [
      ...(hasPositivePtyPid && row.ptyPid > 0 && row.ptyPid === requestedPtyPid ? ['ptyPid' as const] : []),
      ...(String(row.ownerPid) === key ? ['ownerPid' as const] : []),
      ...(row.id === key ? ['ptyId' as const] : []),
      ...(row.runId === key ? ['runId' as const] : []),
    ];
    return matchedBy.length > 0 ? [{ row, matchedBy }] : [];
  });
}

function formatPtyFind(matches: readonly PtyFindMatch[]): string {
  return matches.length === 0
    ? 'pty find: no manifest rows matched ptyPid, ownerPid, ptyId, or runId'
    : matches.map(({ row, matchedBy }) => `${row.id}\tmatchedBy=${matchedBy.join(',')}\tptyPid=${row.ptyPid}\townerPid=${row.ownerPid}\trunId=${row.runId || '-'}\tinstance=${row.instance}`).join('\n');
}

export function runPtyFind(key: string, deps: PtyTakeoverCommandDeps = liveDeps, json = false): PtyTakeoverCommandResult {
  if (!deps.listManifestRows) return { exitCode: 1, message: 'pty find: local manifest reader is unavailable' };
  const matches = findPtyManifestRows(deps.listManifestRows(), key);
  return { exitCode: 0, message: json ? JSON.stringify({ key, matches }, null, 2) : formatPtyFind(matches) };
}

export interface PtyRetirementProof {
  readonly id: string;
  readonly ownership: { readonly ownerPid: number; readonly instance: string };
  readonly inactivity: { readonly updatedAt: number; readonly ageMs: number; readonly stale: boolean; readonly thresholdMs: number };
  readonly liveness: { readonly pid: number; readonly alive: boolean };
  readonly state: { readonly alive: boolean; readonly closedAt: number; readonly closedGraceExpired: boolean; readonly closedTtlMs: number };
  readonly removable: boolean;
  readonly reasons: readonly string[];
}

export function provePtyRetirement(row: PtyManifestRow, now: number, checkProcessAlive: (pid: number) => boolean): PtyRetirementProof {
  const livenessPid = row.ptyPid > 0 ? row.ptyPid : row.ownerPid;
  const ageMs = Math.max(0, now - row.updatedAt);
  const stale = row.alive && ageMs > PTY_MANIFEST_STALE_MS;
  const processIsAlive = livenessPid > 0 && checkProcessAlive(livenessPid);
  // ⛔⭐ Closed grace runs from the **close time**, not the last update. A row that stayed active for a
  //   long time and then closed moments ago has an old `updatedAt` but a fresh `closedAt`; keying the TTL
  //   on `updatedAt` would let that row be removed immediately (review MF-444765bc). `closedAt<=0` means the
  //   close time is unknown (legacy or unmigrated), so treat it as not-yet-expired to fail safe.
  const closedGraceExpired = !row.alive && row.closedAt > 0 && now - row.closedAt > PTY_MANIFEST_CLOSED_TTL_MS;
  // Open rows follow the live reapers (stale heartbeat or dead process). Closed rows are tombstones and
  // remain protected for the full closed TTL regardless of process liveness.
  const reasons = row.alive
    ? [
        ...(stale ? ['heartbeat-stale'] : []),
        ...(!processIsAlive ? ['process-not-alive'] : []),
      ]
    : closedGraceExpired ? ['closed-grace-expired'] : [];
  return {
    id: row.id,
    ownership: { ownerPid: row.ownerPid, instance: row.instance },
    inactivity: { updatedAt: row.updatedAt, ageMs, stale, thresholdMs: PTY_MANIFEST_STALE_MS },
    liveness: { pid: livenessPid, alive: processIsAlive },
    state: { alive: row.alive, closedAt: row.closedAt, closedGraceExpired, closedTtlMs: PTY_MANIFEST_CLOSED_TTL_MS },
    removable: reasons.length > 0,
    reasons,
  };
}

function formatPtyRetirementProof(proof: PtyRetirementProof, removed: boolean): string {
  return [
    `pty retire: ${proof.id}${removed ? ' removed' : ' dry-run (pass --yes to remove manifest row)'}`,
    `ownership ownerPid=${proof.ownership.ownerPid} instance=${proof.ownership.instance}`,
    `inactivity updatedAt=${proof.inactivity.updatedAt} ageMs=${proof.inactivity.ageMs} stale=${proof.inactivity.stale} thresholdMs=${proof.inactivity.thresholdMs}`,
    `liveness pid=${proof.liveness.pid} alive=${proof.liveness.alive}`,
    `state alive=${proof.state.alive} closedAt=${proof.state.closedAt} closedGraceExpired=${proof.state.closedGraceExpired} closedTtlMs=${proof.state.closedTtlMs}`,
    `removable=${proof.removable} reasons=${proof.reasons.length}${proof.reasons.length ? ` (${proof.reasons.join(',')})` : ''}`,
  ].join('\n');
}

export function runPtyRetire(ref: string, deps: PtyTakeoverCommandDeps = liveDeps, yes = false, json = false, opts: { all?: boolean; includeTest?: boolean } = {}): PtyTakeoverCommandResult {
  if (!deps.listManifestRows || !deps.isProcessAlive) return { exitCode: 1, message: 'pty retire: local manifest reader or process liveness checker is unavailable' };
  if (opts.includeTest && !opts.all) return { exitCode: 1, message: 'pty retire: --include-test requires --all' };
  const currentDbPath = deps.currentManifestDbPath?.();
  if (opts.all && (!deps.manifestTargets || !deps.listManifestRowsAt)) return { exitCode: 1, message: 'pty retire --all: federated manifest readers are unavailable' };
  const candidates: Array<{ row: PtyManifestRow; sourceRoot?: { name: string; dbPath: string } }> = [];
  if (opts.all) {
    const targets = deps.manifestTargets!;
    const readAt = deps.listManifestRowsAt!;
    candidates.push(...targets({ includeTest: opts.includeTest === true }).flatMap((target) => readAt(target.dbPath).map((row) => ({ row, sourceRoot: { name: target.name, dbPath: target.dbPath } }))));
  } else {
    candidates.push(...deps.listManifestRows().map((row) => ({ row })));
  }
  const matches = candidates.filter(({ row }) => findPtyManifestRows([row], ref).length > 0);
  if (matches.length === 0) return { exitCode: 1, message: `pty retire: ${ref} was not found in the ${opts.all ? 'federated' : 'local'} manifest` };
  if (matches.length > 1) return { exitCode: 1, message: `pty retire: ${ref} is ambiguous; candidates: ${matches.map(({ row, sourceRoot }) => sourceRoot ? `${row.id} (${sourceRoot.name})` : row.id).join(', ')}` };
  const { row, sourceRoot } = matches[0]!;
  const proof = provePtyRetirement(row, deps.now?.() ?? Date.now(), deps.isProcessAlive);
  const external = sourceRoot !== undefined && sourceRoot.dbPath !== currentDbPath;
  if (external && yes) {
    const message = json
      ? JSON.stringify({ proof, removed: false, sourceRoot, refusal: 'removal from a different manifest root is not supported' }, null, 2)
      : `${formatPtyRetirementProof(proof, false)}\nsourceRoot name=${sourceRoot.name} dbPath=${sourceRoot.dbPath}\npty retire: removal from a different manifest root is not supported`;
    return { exitCode: 1, message };
  }
  if (yes && !proof.removable) {
    const message = json
      ? JSON.stringify({ proof, removed: false, refusal: 'manifest row is not removable' }, null, 2)
      : `${formatPtyRetirementProof(proof, false)}\npty retire: removal refused; manifest row is not removable`;
    return { exitCode: 1, message };
  }
  let removed = false;
  if (yes) {
    if (!deps.removeManifest) return { exitCode: 1, message: 'pty retire: manifest removal is unavailable' };
    deps.removeManifest(proof.id);
    removed = !deps.listManifestRows().some((candidate) => candidate.id === proof.id);
    if (!removed) {
      const message = json
        ? JSON.stringify({ proof, removed: false, failure: 'manifest row is still present after removal' }, null, 2)
        : `${formatPtyRetirementProof(proof, false)}\npty retire: removal did not take effect; the manifest row is still present`;
      return { exitCode: 1, message };
    }
  }
  const payload = sourceRoot ? { proof, removed, sourceRoot } : { proof, removed };
  const text = `${formatPtyRetirementProof(proof, removed)}${sourceRoot ? `\nsourceRoot name=${sourceRoot.name} dbPath=${sourceRoot.dbPath}` : ''}`;
  return { exitCode: 0, message: json ? JSON.stringify(payload, null, 2) : text };
}

interface PtyReapRootTarget { readonly name: string; readonly dbPath: string }

interface PtyReapRootSelection {
  readonly targets: readonly PtyReapRootTarget[];
  readonly unmatchedNames: readonly string[];
  readonly viewedRootCount: number;
  readonly viewedRootNameRange: string;
}

/** Select registered manifest roots without changing their established default enumeration order. */
function selectPtyReapRoots(targets: readonly PtyReapRootTarget[], requestedNames: readonly string[] = []): PtyReapRootSelection {
  const requested = [...new Set(requestedNames)];
  const requestedSet = new Set(requested);
  const selected = requested.length === 0 ? targets : targets.filter((target) => requestedSet.has(target.name));
  const availableNames = new Set(targets.map((target) => target.name));
  const unmatchedNames = requested.filter((name) => !availableNames.has(name));
  const names = selected.map((target) => target.name);
  return {
    targets: selected,
    unmatchedNames,
    viewedRootCount: selected.length,
    viewedRootNameRange: names.length === 0 ? '-' : names.length === 1 ? names[0]! : `${names[0]}…${names.at(-1)}`,
  };
}

export function runPtyReap(deps: PtyTakeoverCommandDeps = liveDeps, opts: { yes?: boolean; includeTest?: boolean; json?: boolean; instance?: string[] } = {}): PtyTakeoverCommandResult {
  if (!deps.manifestTargets || !deps.reapManifestAt) return { exitCode: 1, message: 'pty reap: manifest targets or reaper is unavailable' };
  const selection = selectPtyReapRoots(deps.manifestTargets({ includeTest: opts.includeTest === true }), opts.instance);
  if (selection.unmatchedNames.length > 0) {
    const error = `pty reap: unregistered root name(s): ${selection.unmatchedNames.join(', ')}`;
    return {
      exitCode: 1,
      message: opts.json ? JSON.stringify({ error, unmatchedNames: selection.unmatchedNames }, null, 2) : error,
    };
  }
  const apply = opts.yes === true;
  const results = selection.targets.map((target) => ({ name: target.name, ...deps.reapManifestAt!(target.dbPath, { apply }) }));
  // Preview reports inaccessible roots without mutating anything; an approved apply must fail closed
  // whenever any target could not be processed, regardless of the output renderer.
  const exitCode: 0 | 1 = apply && results.some((result) => result.status !== 'ok') ? 1 : 0;
  const summary = {
    roots: results.length,
    unprocessedRoots: results.filter((result) => result.status !== 'ok').length,
    removed: results.reduce((sum, result) => sum + result.removed, 0),
    preserved: results.reduce((sum, result) => sum + result.preserved, 0),
    failClosed: exitCode === 1,
    viewedRootCount: selection.viewedRootCount,
    viewedRootNameRange: selection.viewedRootNameRange,
  };
  const payload = { mode: apply ? 'applied' : 'dry-run', summary, roots: results };
  deps.log('reap', { mode: payload.mode, roots: results.length, removed: summary.removed, failed: exitCode === 1 });
  if (opts.json) return { exitCode, message: JSON.stringify(payload, null, 2) };
  const lines = [`pty reap: ${payload.mode}${apply ? '' : ' (pass --yes to remove confirmed dead-owner rows)'}`];
  for (const result of results) {
    lines.push(`root=${result.name} status=${result.status} removed=${result.removed} preserved=${result.preserved}`);
    for (const decision of result.decisions) lines.push(`  ${decision.id}\t${decision.action}\t${decision.reason}\tpid=${decision.livenessPid}`);
  }
  lines.push(
    `pty reap summary: roots=${summary.roots} viewedRoots=${summary.viewedRootCount} viewedRootNameRange=${summary.viewedRootNameRange}`
    + ` unprocessed=${summary.unprocessedRoots} removed=${summary.removed} preserved=${summary.preserved}`
    + (summary.failClosed
      ? ' → exit 1 (fail-closed: 처리하지 못한 루트가 있으면 제거가 성공해도 실패로 낸다)'
      : ' → exit 0'),
  );
  return { exitCode, message: lines.join('\n') };
}

export type RunTermination = boolean | 'no-run-id' | 'ledger-not-found' | 'ledger-indeterminate' | 'ledger-read-failed';
export type RunTerminationSource = 'ledger' | 'run-store' | 'none' | 'unknown';
export type RunStoreIoState = 'not-checked' | 'not-found' | 'read-failed' | 'incomplete' | 'dead-pid' | 'pid-reused' | 'process-start-indistinguishable' | 'process-start-unverifiable' | 'live';

/** `ps -o lstart=` 의 해상도. ⛔ 이 폭 «안»에서는 「같은 프로세스」와 「재사용」을 구별할 수 없다. */
const PROCESS_START_RESOLUTION_MS = 1_000;
export interface RunTerminationResolution {
  readonly termination: RunTermination;
  readonly source: RunTerminationSource;
  readonly runStoreIo: RunStoreIoState;
}
export type PtyOwnerRunUsage = 'terminated-live-owner' | 'running' | 'no-run-id' | 'unknown';

/** Classifies screen usage without changing the independent retirement policy. */
export function classifyPtyOwnerRunUsage(ownerProcessAlive: boolean | undefined, runTerminated: RunTermination): PtyOwnerRunUsage {
  if (ownerProcessAlive !== true) return 'unknown';
  if (runTerminated === true) return 'terminated-live-owner';
  if (runTerminated === false) return 'running';
  if (runTerminated === 'no-run-id') return 'no-run-id';
  return 'unknown';
}

export function runLedgerTermination(entries: readonly RunLedgerEntry[] | null): boolean | 'ledger-indeterminate' {
  if (!entries) return 'ledger-indeterminate';
  const status = [...entries].reverse().find((entry) => entry.event === 'run-status')?.data.runStatus;
  if (isRunStatus(status)) return true;
  if (status === 'running') return false;
  return 'ledger-indeterminate';
}

export function resolveRunTermination(
  runId: string,
  ledgerDirectories: readonly string[],
  load: (runId: string, directory: string) => readonly RunLedgerEntry[] | null = loadRunLedger,
  log: (event: string, data: Record<string, unknown>) => void = () => {},
): RunTermination {
  if (!runId) return logIndeterminate('no-run-id', runId, 0, 0, log);
  let ledgerDirectoriesChecked = 0;
  let unreadableLedgerDirectories = 0;
  let sawIndeterminateLedger = false;
  for (const directory of ledgerDirectories) {
    ledgerDirectoriesChecked += 1;
    let entries: readonly RunLedgerEntry[] | null;
    try {
      entries = load(runId, directory);
    } catch {
      unreadableLedgerDirectories += 1;
      continue;
    }
    if (entries === null) continue;
    const termination = runLedgerTermination(entries);
    if (termination === 'ledger-indeterminate') {
      sawIndeterminateLedger = true;
      continue;
    }
    return termination;
  }
  return logIndeterminate(
    unreadableLedgerDirectories > 0
      ? 'ledger-read-failed'
      : sawIndeterminateLedger
        ? 'ledger-indeterminate'
        : 'ledger-not-found',
    runId,
    ledgerDirectoriesChecked,
    unreadableLedgerDirectories,
    log,
  );
}

function logIndeterminate(
  reason: Exclude<RunTermination, boolean>,
  runId: string,
  ledgerDirectoriesChecked: number,
  unreadableLedgerDirectories: number,
  log: (event: string, data: Record<string, unknown>) => void,
): Exclude<RunTermination, boolean> {
  log('run-termination-indeterminate', { runId, reason, ledgerDirectoriesChecked, unreadableLedgerDirectories });
  return reason;
}

type RunStoreReader = (path: string) => string;
type ProcessStartedAt = (pid: number) => number | null;

const RUN_STORE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** `ps` 를 부를 환경 — 로케일만 C 로 못 박은 «사본». ⛔ 원본 env 는 변형하지 않는다.
 *  ⭐ 순수 함수로 빼 두는 이유: 인라인이면 「고정했다」를 시험이 «물 수 없다»(리뷰 should-fix). */
export function ptyProcessStartEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, LC_ALL: 'C', LANG: 'C' };
}

/** ⭐ 내보내는 이유: 이 «생산 경로»를 안 쓰면 배선 시험이 기본 스텁(`() => null`)만 재고 초록이 된다. */
export function liveProcessStartedAt(pid: number): number | null {
  // ⛔⭐ `ps -o lstart=` 의 «문면»은 로케일에 따라 바뀌고, 바뀌면 `Date.parse` 가 조용히 NaN 을 낸다.
  //   그러면 이 축이 «틀렸다고 말하지 않고» 통째로 `process-start-unverifiable` 로 미끄러진다(리뷰 should-fix).
  //   🪞 오늘 같은 트리에서 git 의 로케일 의존 stderr 로 이미 한 번 데인 형태다.
  //   ⇒ 이 호출만 C 로케일로 못 박는다. 사용자의 셸 환경은 안 바꾼다.
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: ptyProcessStartEnv() });
  if (result.status !== 0) return null;
  const startedAt = Date.parse(result.stdout.trim());
  return Number.isFinite(startedAt) ? startedAt : null;
}

function isRunStoreCheckpoint(value: unknown, runId: string): value is Pick<SelfDevRunState, 'runId' | 'createdAt' | 'pid'> & { readonly pid: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  return checkpoint.runId === runId && Number.isFinite(checkpoint.createdAt)
    && typeof checkpoint.pid === 'number' && Number.isSafeInteger(checkpoint.pid) && checkpoint.pid > 0;
}

function runStoreResolution(
  runId: string,
  ledgerDirectories: readonly string[],
  read: RunStoreReader,
  alive: (pid: number) => boolean,
  processStartedAt: ProcessStartedAt,
): RunTerminationResolution {
  if (!runId) return { termination: 'no-run-id', source: 'none', runStoreIo: 'not-checked' };
  if (!RUN_STORE_ID.test(runId)) return { termination: 'ledger-not-found', source: 'none', runStoreIo: 'incomplete' };
  let sawReadFailure = false;
  let sawIncomplete = false;
  let sawDeadPid = false;
  let sawPidReused = false;
  let sawStartIndistinguishable = false;
  let sawUnverifiableStart = false;
  for (const ledgerDirectory of ledgerDirectories) {
    const path = join(selfDevRunsDir(dirname(ledgerDirectory)), `${runId}.json`);
    let rawCheckpoint: string;
    try {
      rawCheckpoint = read(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      sawReadFailure = true;
      continue;
    }
    let checkpoint: unknown;
    try {
      checkpoint = JSON.parse(rawCheckpoint);
    } catch {
      sawIncomplete = true;
      continue;
    }
    if (!isRunStoreCheckpoint(checkpoint, runId)) {
      sawIncomplete = true;
      continue;
    }
    if (!alive(checkpoint.pid)) {
      sawDeadPid = true;
      continue;
    }
    const startedAt = processStartedAt(checkpoint.pid);
    if (startedAt === null || !Number.isFinite(startedAt)) {
      sawUnverifiableStart = true;
      continue;
    }
    // ⛔⭐ `ps lstart` 는 «초» 해상도다 — 그래서 이 비교는 «세 값»이지 둘이 아니다.
    //   ⓐ 기록보다 «확실히 뒤»(해상도를 넘어)   ⇒ 그 pid 는 남의 것이다 = 재사용
    //   ⓑ 「같은 초」                            ⇒ ***구별할 수 없다***. 「재사용」도 「살아 있다」도 아니다
    //   ⓒ 기록보다 앞                            ⇒ 같은 프로세스
    //   🪞 종전 판은 ⓐ와 ⓑ를 «한 칸»에 넣어 「재사용」이라 단정했다(리뷰가 5라운드 지적한 자리).
    //     ⛔ 「모른다」를 「그렇다」로 접는 것이고, 이 저장소가 반복해 적은 그 형태다.
    //   ⛔⭐ 절단은 «내림»이라 실제 기동은 `[startedAt, startedAt + 해상도)` 안 «어딘가»다.
    //     ⇒ 그 구간이 `createdAt` 을 «가로지르면» 앞뒤를 못 가른다 — 그때는 「살아 있다」로도 단정하지 않는다.
    //     📏 실측(40표본): 간격 715~1569ms · 중앙 1145ms ⇒ 26/40 은 «확실히 앞»으로 남는다.
    if (startedAt >= checkpoint.createdAt) {
      sawPidReused = true;                                   // 실제 기동이 기록과 «같거나 뒤» — 남의 pid 다
      continue;
    }
    if (startedAt + PROCESS_START_RESOLUTION_MS > checkpoint.createdAt) {
      sawStartIndistinguishable = true;                      // 구간이 기록을 가로지른다 — 못 가른다
      continue;
    }
    return { termination: false, source: 'run-store', runStoreIo: 'live' };
  }
  if (sawDeadPid) return { termination: true, source: 'run-store', runStoreIo: 'dead-pid' };
  return {
    termination: 'ledger-not-found', source: 'none', runStoreIo: sawReadFailure ? 'read-failed'
      : sawIncomplete ? 'incomplete'
        : sawPidReused ? 'pid-reused'
          : sawStartIndistinguishable ? 'process-start-indistinguishable'
            : sawUnverifiableStart ? 'process-start-unverifiable'
            : 'not-found',
  };
}

/** `ptyListRunTermination` is the pty-list caller: a definitive ledger answer wins; only an absent ledger queries checkpoints. */
export function ptyListRunTermination(
  runId: string,
  ledgerDirectories: readonly string[],
  loadLedger: (runId: string, directory: string) => readonly RunLedgerEntry[] | null = loadRunLedger,
  readRunStore: RunStoreReader = (path) => readFileSync(path, 'utf8'),
  alive: (pid: number) => boolean = isProcessAlive,
  processStartedAt: ProcessStartedAt = () => null,
  log: (event: string, data: Record<string, unknown>) => void = () => {},
): RunTerminationResolution {
  const ledger = resolveRunTermination(runId, ledgerDirectories, loadLedger, log);
  if (ledger !== 'ledger-not-found') return { termination: ledger, source: ledger === 'no-run-id' ? 'none' : 'ledger', runStoreIo: 'not-checked' };
  return runStoreResolution(runId, ledgerDirectories, readRunStore, alive, processStartedAt);
}

/** 원격 행의 웹 주소 — 우리는 저쪽 PWA 를 «묻지 않았다». 지어내지 않고 «모른다»를 값으로 낸다. */
const REMOTE_WEB_ADDRESS: PtyWebAddress = {
  webUrl: null,
  webUrlSource: null,
  pwaUnavailableReason: 'remote-not-queried',
};

/** PWA 를 «해석하지 않은» 경로(시험 등) — 세 칸을 채워 키 집합을 지킨다. */
const UNRESOLVED_WEB_ADDRESS: PtyWebAddress = {
  webUrl: null,
  webUrlSource: null,
  pwaUnavailableReason: null,
};

interface PtyManifestSourceRoot {
  readonly name: string;
  readonly dbPath: string;
}

type PtyWorktreeProvenanceReason = 'workdir-not-recorded' | 'workdir-missing-path' | 'not-git-worktree' | 'config-not-recorded' | 'git-read-failed' | 'unknown';
export type PtyWorktreeProvenance =
  | { readonly known: true; readonly goalId?: string; readonly goalFile?: string; readonly goalTitle?: string }
  | { readonly known: false; readonly provenanceReason: PtyWorktreeProvenanceReason };

type PtyGitResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error?: Error };
type PtyGitRunner = (args: readonly string[], cwd: string) => PtyGitResult;
type PtyPathInspector = (path: string) => void;
/** 「이 경로 위쪽 어딘가에 `.git` 이 있나」 — 저장소 «부재»와 저장소 «고장»을 가르는 유일한 입력.
 *  ⛔ 세 값이다. 「못 봤다」를 「없다」로 접으면 권한 오류인 «진짜 저장소»가 not-git-worktree 로 둔갑한다. */
type PtyGitEntryProbeResult = 'present' | 'absent' | 'unknown';
type PtyGitEntryProbe = (workdir: string) => PtyGitEntryProbeResult;
const GOAL_PROVENANCE_KEYS = ['elanous.harness.goalId', 'elanous.harness.goalFile', 'elanous.harness.goalTitle'] as const;

/** ⛔⭐ git 의 «탐색 정책»을 바꾸는 환경변수들. 이것들이 상속되면 git 은 이 파일의 probe 와
 *  «다른 규칙»으로 저장소를 찾고, 그 순간 「저장소가 아니다」와 「못 읽었다」의 판정이 어긋난다.
 *  ⇒ 이 명령만큼은 «정규화된» 환경에서 돌린다(리뷰 must-fix). 사용자의 셸 환경은 안 바꾼다. */
const PTY_GIT_DISCOVERY_ENV_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_COMMON_DIR'] as const;

/** 주변 환경에서 탐색 노브만 걷어낸 사본. ⛔ 원본을 «변형하지 않는다». */
export function ptyGitDiscoveryEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of PTY_GIT_DISCOVERY_ENV_KEYS) delete copy[key];
  return copy;
}

function livePtyGitRunner(args: readonly string[], cwd: string): PtyGitResult {
  const result = runGitCommand(cwd, [...args], { encoding: 'utf8', env: ptyGitDiscoveryEnv() });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** ⛔⭐ git 의 stderr «문면»으로 가르지 않는다 — 그 문자열은 로케일과 git 판본에 따라 바뀌고,
 *  바뀌어도 «틀렸다고 말하지 않고» 조용히 「읽기 실패」로 미끄러진다(리뷰가 3라운드 연속 지적한 자리).
 *  ⇒ 대신 파일시스템에 묻는다: 위로 훑어 `.git` 이 하나도 없으면 «저장소가 아니다»이고,
 *    있는데 git 이 실패하면 «저장소인데 못 읽었다»이다. 두 답 모두 언어와 무관하다. */
function livePtyGitEntryProbe(workdir: string): PtyGitEntryProbeResult {
  // ⛔⭐ git 은 «실경로»에서 조상을 훑는다 — 심볼릭 링크 경로의 «어휘상» 부모는 실제 조상이 아니다.
  //   resolve() 만 쓰면 링크로 들어간 워크트리에서 실제 조상의 `.git` 을 «못 보고» not-git-worktree 로
  //   오분류한다(리뷰 must-fix). realpath 를 못 얻으면 「모른다」로 끊는다 — 지어내지 않는다.
  let dir: string;
  let device: number;
  try {
    dir = realpathSync(resolve(workdir));
    device = statSync(dir).dev;
  } catch {
    return 'unknown';
  }
  for (;;) {
    try {
      statSync(join(dir, '.git'));
      return 'present';
    } catch (error) {
      // ⛔ 「이 층엔 없다」는 ENOENT·ENOTDIR «뿐»이다. 권한(EACCES)·I/O 오류는 «못 본 것»이라
      //   위로 더 올라가도 답이 안 나온다 — 그 자리에서 「모른다」로 끊는다(리뷰 must-fix).
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'unknown';
    }
    const parent = dirname(dir);
    if (parent === dir) return 'absent';
    // ⛔⭐ git 은 기본적으로 파일시스템 «경계»에서 탐색을 멈춘다(`GIT_DISCOVERY_ACROSS_FILESYSTEM` 미설정).
    //   경계를 넘어 계속 올라가면, git 이 「저장소가 아니다」라 답한 경로를 우리는 「저장소인데 못 읽었다」로
    //   «다르게» 판정한다 — 그 순간 이 칸이 git 의 답과 어긋난다(리뷰 must-fix).
    let parentDevice: number;
    try {
      parentDevice = statSync(parent).dev;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
    }
    if (parentDevice !== device) return 'absent';
    dir = parent;
  }
}

/** Reads only worktree-scoped producer keys; status 1 is absent config, every other git failure stays diagnostic. */
export function resolvePtyWorktreeProvenance(
  workdir: string | undefined,
  deps: { inspectPath?: PtyPathInspector; runGit?: PtyGitRunner; hasGitEntry?: PtyGitEntryProbe } = {},
): PtyWorktreeProvenance {
  if (!workdir) return { known: false, provenanceReason: 'workdir-not-recorded' };
  try {
    (deps.inspectPath ?? statSync)(workdir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { known: false, provenanceReason: 'workdir-missing-path' }
      : { known: false, provenanceReason: 'git-read-failed' };
  }
  const runGit = deps.runGit ?? livePtyGitRunner;
  const gitWorktree = runGit(['rev-parse', '--is-inside-work-tree'], workdir);
  if (gitWorktree.error || gitWorktree.status !== 0) {
    // ⛔ 실패 «사유»는 git 이 뭐라 «썼는지»가 아니라 `.git` 이 «있는지»로 가른다(위 주석 참조).
    //   ⭐ 「모른다」는 「없다」로 접지 않고 진단 쪽에 둔다 — 없다고 «단정»하지 않는다.
    return (deps.hasGitEntry ?? livePtyGitEntryProbe)(workdir) === 'absent'
      ? { known: false, provenanceReason: 'not-git-worktree' }
      : { known: false, provenanceReason: 'git-read-failed' };
  }
  if (gitWorktree.stdout.trim() !== 'true') return { known: false, provenanceReason: 'not-git-worktree' };
  const values: Partial<Record<'goalId' | 'goalFile' | 'goalTitle', string>> = {};
  for (const [index, key] of GOAL_PROVENANCE_KEYS.entries()) {
    const result = runGit(['config', '--worktree', '--get', key], workdir);
    if (result.error || (result.status !== 0 && result.status !== 1)) return { known: false, provenanceReason: 'git-read-failed' };
    const value = result.status === 0 ? result.stdout.trim() : '';
    if (value) values[['goalId', 'goalFile', 'goalTitle'][index] as keyof typeof values] = value;
  }
  return Object.keys(values).length > 0 ? { known: true, ...values } : { known: false, provenanceReason: 'config-not-recorded' };
}

/** ⛔ 타입은 `{ known: true }` 에 골 칸이 하나도 없는 것을 «허용»한다(주입된 resolver 가 그럴 수 있다).
 *  그 행은 골 칸도 사유도 없어 ***「모든 행이 유래 «또는» 이름 있는 부재 사유를 갖는다」가 깨진다***.
 *  ⇒ 빈 known 을 `config-not-recorded` 로 «정규화»한다 — 조용히 빈 칸을 내보내지 않는다(리뷰 must-fix).
 *  ⭐ JSON·사람 산출·「앎」 계수가 «모두» 이 한 자리를 지난다 — 세 곳이 갈리면 또 어긋난다. */
function normalizePtyWorktreeProvenance(provenance: PtyWorktreeProvenance): PtyWorktreeProvenance {
  if (!provenance.known) return provenance;
  return provenance.goalId || provenance.goalFile || provenance.goalTitle
    ? provenance
    : { known: false, provenanceReason: 'config-not-recorded' };
}

function provenanceFields(raw: PtyWorktreeProvenance): Pick<PtyListJsonRow, 'goalId' | 'goalFile' | 'goalTitle' | 'provenanceReason'> {
  const provenance = normalizePtyWorktreeProvenance(raw);
  return provenance.known
    ? { ...(provenance.goalId ? { goalId: provenance.goalId } : {}), ...(provenance.goalFile ? { goalFile: provenance.goalFile } : {}), ...(provenance.goalTitle ? { goalTitle: provenance.goalTitle } : {}) }
    : { provenanceReason: provenance.provenanceReason };
}

/** ⛔ config 값은 «사람이 쓴 문서»에서 온다 — 탭이나 개행이 들어오면 TSV 행의 칸이 늘거나
 *  행이 하나 «위조»된다. 값을 버리지 않고 한 줄로 접는다(리뷰 should-fix). */
function singleLinePtyCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatPtyWorktreeProvenance(raw: PtyWorktreeProvenance): string {
  const provenance = normalizePtyWorktreeProvenance(raw);
  if (!provenance.known) return `purpose=${provenance.provenanceReason}`;
  return [
    ...(provenance.goalId ? [`goalId=${singleLinePtyCell(provenance.goalId)}`] : []),
    ...(provenance.goalFile ? [`goalFile=${singleLinePtyCell(provenance.goalFile)}`] : []),
    ...(provenance.goalTitle ? [`goalTitle=${singleLinePtyCell(provenance.goalTitle)}`] : []),
  ].join(' ');
}

function terminalOriginFields(row: Pick<PtyManifestRow, 'terminalOriginCategory' | 'terminalOriginReason' | 'externalToolName'>): { readonly terminalOriginCategory: NonNullable<PtyManifestRow['terminalOriginCategory']>; readonly terminalOriginReason: string; readonly externalToolName?: string } {
  const category = row.terminalOriginCategory;
  const reason = row.terminalOriginReason;
  if ((category === 'direct-human' || category === 'elanous' || category === 'external-tool' || category === 'unknown') && reason) {
    return { terminalOriginCategory: category, terminalOriginReason: reason, ...(category === 'external-tool' && row.externalToolName ? { externalToolName: row.externalToolName } : {}) };
  }
  return { terminalOriginCategory: 'unknown', terminalOriginReason: 'legacy-or-malformed-origin-decision' };
}

/** ⛔⭐ **원격 행의 유래 — 「없으면 «모른다»」다.**
 *  🩸 로컬용 `terminalOriginFields` 는 칸이 없으면 `reason='legacy-or-malformed-origin-decision'` 을 낸다.
 *     그건 ***「그 기계의 옛/손상된 결정이었다」는 사실 주장***인데, 원격에서는 그저
 *     ***그 응답이 칸을 «안 실은 것»***일 수 있다(옛 서버는 그 필드를 아예 안 내보낸다).
 *     `workdir`·`provenanceReason` 과 «같은 계급»의 결함이라 리뷰가 잡았다.
 *  ⇒ 칸이 오면 그대로 쓰고, 안 오면 `'remote-origin-not-reported'` 로 «모른다»를 값으로 낸다. */
function remoteTerminalOriginFields(row: RemoteTerminalListItem): {
  readonly terminalOriginCategory: NonNullable<PtyManifestRow['terminalOriginCategory']>;
  readonly terminalOriginReason: string;
  readonly externalToolName?: string;
} {
  const category = row.terminalOriginCategory;
  const reason = row.terminalOriginReason;
  if ((category === 'direct-human' || category === 'elanous' || category === 'external-tool' || category === 'unknown') && reason) {
    return { terminalOriginCategory: category, terminalOriginReason: reason, ...(category === 'external-tool' && row.externalToolName ? { externalToolName: row.externalToolName } : {}) };
  }
  return { terminalOriginCategory: 'unknown', terminalOriginReason: 'remote-origin-not-reported' };
}

function formatRemoteTerminalOrigin(row: RemoteTerminalListItem): string {
  const origin = remoteTerminalOriginFields(row);
  return `origin=${origin.terminalOriginCategory} reason=${singleLinePtyCell(origin.terminalOriginReason)}${origin.externalToolName ? ` tool=${singleLinePtyCell(origin.externalToolName)}` : ''}`;
}

function formatTerminalOrigin(row: Pick<PtyManifestRow, 'terminalOriginCategory' | 'terminalOriginReason' | 'externalToolName'>): string {
  const origin = terminalOriginFields(row);
  return `origin=${origin.terminalOriginCategory} reason=${singleLinePtyCell(origin.terminalOriginReason)}${origin.externalToolName ? ` tool=${singleLinePtyCell(origin.externalToolName)}` : ''}`;
}

interface PtyListJsonRow extends PtyWebAddress {
  readonly id: string;
  readonly kind: string;
  readonly nickname?: string;
  readonly runId?: string;
  readonly instance: string | 'unknown';
  readonly sourceRoot: PtyManifestSourceRoot | 'unknown';
  readonly alive: boolean | 'unknown';
  readonly workdir?: string;
  readonly terminalOriginCategory: NonNullable<PtyManifestRow['terminalOriginCategory']>;
  readonly terminalOriginReason: string;
  readonly externalToolName?: string;
  readonly goalId?: string;
  readonly goalFile?: string;
  readonly goalTitle?: string;
  readonly provenanceReason?: PtyWorktreeProvenanceReason;
  /** ⚠️ 이름과 «재는 것»이 정확히 같지 않다(사후 리뷰 지적 · 2026-08-19):
   *  생존은 ***PTY 자신의 프로세스(`ptyPid`)를 «먼저»*** 보고, 그것이 0(미상)일 때만 `ownerPid` 로
   *  폴백한다(`pty-manifest.ts` 의 reap 규율과 같다 — 띄우고 나가는 래퍼가 등록한 PTY 때문이다).
   *  ⇒ 「이 화면이 살아 있나」로는 옳고, 「등록자가 살아 있나」로 읽으면 «틀린다».
   *  ⛔ 이름을 바꾸는 것은 소비자 계약 변경이라 별건으로 둔다 — 여기 적어 오독을 막는다. */
  /** Local process probe is boolean. Remote HTTP cannot know it — `'unknown'`, never false. */
  readonly ownerProcessAlive: boolean | 'unknown';
  readonly updatedAgeMs: number | 'unknown';
  readonly outputBytesTotal: number | 'unknown';
  readonly lastControlAt?: number;
  readonly runTerminated: RunTermination;
  readonly runTerminationSource: RunTerminationSource;
  readonly runStoreIo: RunStoreIoState;
  readonly ownerRunUsage: PtyOwnerRunUsage;
  /** ⭐ 이 화면이 «생긴 지» 얼마나 됐나. 매니페스트에 이미 있는 `startedAt` 을 나이로 낸다.
   *  ⛔ `updatedAgeMs`(마지막 갱신 이후)와 «다른 축»이다 — 살아 있는 화면은 계속 갱신되므로
   *    그 값은 거의 항상 몇 초이고 「얼마나 오래 있었나」를 못 답한다.
   *  ⚠️ `startedAt` 이 0(미상)이면 이 칸을 «비운다» — 「0분」과 「못 잼」은 다른 값이다. */
  readonly ageMs?: number;
}

function defaultRunTermination(runId: string, opts: { includeTest: boolean }, log: (event: string, data: Record<string, unknown>) => void): RunTermination {
  return resolveRunTermination(runId, resolveFederatedRunLedgerDirectories({ includeTest: opts.includeTest }), loadRunLedger, log);
}

/** ⛔⭐ 리뷰 must-fix (2026-08-19): 종전엔 `Math.max(0, now - startedAt)` 로 «깎았다».
 *  그러면 시계 역전(startedAt > now · 다른 기계·NTP 점프)에서 ***「못 잼」이 「0분 됐다」로 둔갑***한다.
 *  ⇒ 이 창이 하루 종일 쫓은 형태다. 깎지 않고 ***칸을 비운다*** — `startedAt === 0`(미상)과 같은 처리다.
 *  ⚠️ 「나이가 0에 가깝다」와 「나이를 못 잰다」는 다른 값이고, 앞의 것은 «갓 뜬 화면»을 뜻한다. */
function ptyAgeField(startedAt: number, now: number): { ageMs?: number } {
  if (!(startedAt > 0)) return {};
  const ageMs = now - startedAt;
  return ageMs >= 0 ? { ageMs } : {};
}

function ptyListJsonRow(row: PtyManifestRow, instance: string, sourceRoot: PtyManifestSourceRoot, deps: PtyTakeoverCommandDeps, opts: { includeTest: boolean }, pwa?: NexusPwaResolution): PtyListJsonRow {
  // ⛔⭐ 리뷰 should-fix (2026-08-19): 기준 시각을 «한 번만» 읽는다.
  //   종전엔 proof(updatedAgeMs)와 ageMs 가 각각 `deps.now?.()` 를 불러, 한 행의 두 값이
  //   ***«다른 순간»을 가리킬 수 있었다***. 두 값을 나란히 놓고 판정하는 것이 이 축의 용도인데
  //   자가 둘이면 그 비교가 조용히 어긋난다.
  const observedAt = deps.now?.() ?? Date.now();
  const proof = provePtyRetirement(row, observedAt, deps.isProcessAlive ?? isProcessAlive);
  const resolution = deps.runTerminationResolution?.(row.runId, opts);
  const runTerminated = resolution?.termination
    ?? (deps.runTerminated ?? ((runId, resolverOpts) => defaultRunTermination(runId, resolverOpts ?? { includeTest: false }, deps.log)))(row.runId, opts);
  const ownerRunUsage = classifyPtyOwnerRunUsage(proof.liveness.alive, runTerminated);
  const provenance = (deps.resolveWorktreeProvenance ?? resolvePtyWorktreeProvenance)(row.workdir);
  const terminalOrigin = terminalOriginFields(row);
  if (ownerRunUsage === 'terminated-live-owner') deps.log('owner-run-terminated', { ptyId: row.id, runId: row.runId });
  return {
    id: row.id,
    kind: row.kind,
    ...(row.nickname ? { nickname: row.nickname } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    instance,
    sourceRoot,
    alive: row.alive,
    ...(row.workdir !== undefined ? { workdir: row.workdir } : {}),
    ...terminalOrigin,
    // ⭐ 라이브 경로에서 `pwa` 는 «항상» 있다 — `resolveNexusPwa` 가 기본 deps 다(이 파일 상단 liveDeps).
    //   ⛔ 그래도 세 칸은 «언제나» 낸다 — 키 집합이 출처·상태로 갈리면 안 된다(수용기준 ⑤).
    ...(pwa ? ptyWebAddress(row.id, pwa) : UNRESOLVED_WEB_ADDRESS),
    ...provenanceFields(provenance),
    ownerProcessAlive: proof.liveness.alive,
    updatedAgeMs: proof.inactivity.ageMs,
    outputBytesTotal: row.outputBytesTotal ?? 0,
    ...(row.lastControlAt === undefined ? {} : { lastControlAt: row.lastControlAt }),
    ...ptyAgeField(row.startedAt, observedAt),
    runTerminated,
    // ⛔ 관측 «형태»가 주입에 따라 달라지면 안 된다 — 종전엔 해석기를 «안 주입한» 소비자에게서
    //   이 두 칸이 «통째로 사라져» 「출처를 안 냈다」와 「이 빌드엔 그 축이 없다」를 구별할 수 없었다(리뷰 should-fix).
    //   ⇒ 항상 싣되, 해석기가 없으면 «모른다»를 이름으로 말한다.
    runTerminationSource: resolution?.source ?? 'unknown',
    runStoreIo: resolution?.runStoreIo ?? 'not-checked',
    ownerRunUsage,
  };
}

function federatedManifestTargets(
  targets: readonly { name: string; dbPath: string }[],
  currentDbPath: string,
  realpath: (path: string) => string,
): Array<{ name: string; dbPath: string }> {
  const normalizedCurrentDbPath = realpath(currentDbPath);
  const normalizedTargets = targets.map((target) => ({ ...target, dbPath: realpath(target.dbPath) }));
  return normalizedTargets.some((target) => target.dbPath === normalizedCurrentDbPath)
    ? normalizedTargets
    : [...normalizedTargets, { name: 'current', dbPath: normalizedCurrentDbPath }];
}

function ptyListScope(opts: { all?: boolean; includeTest?: boolean }): string {
  if (!opts.all) return 'current instance only';
  return opts.includeTest ? 'all registered instances, including isolated test instances' : 'all registered non-test instances';
}

function ptyListEmptyNotice(opts: { all?: boolean; includeTest?: boolean }): string {
  return `pty list: no PTYs found (scope: ${ptyListScope(opts)})`;
}

/** Bookmark `acp_url` may be `ws(s)://host/v1/acp` or `http(s)://host/v1/acp`.
 *  GET /v1/terminals is origin-scoped — keep the scheme+host, drop the ACP path.
 *  ⛔ Do not append onto pathname (`/v1/acp/v1/terminals`). */
function ptyListRemoteHttpOrigin(host: string): string {
  const raw = host.trim();
  if (!raw) throw new Error('pty list: remote bookmark host is empty');
  const parsed = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`pty list: remote bookmark host has unsupported protocol ${parsed.protocol}`);
  }
  return parsed.origin;
}

function remoteTerminalsUrl(host: string): string {
  return `${ptyListRemoteHttpOrigin(host)}/v1/terminals`;
}

function remoteTerminalControlUrl(host: string, id: string): string {
  return `${remoteTerminalsUrl(host)}/${encodeURIComponent(id)}/control`;
}

async function livePostRemoteTerminalControl(url: string, token: string, body: RemoteTerminalControlBody): Promise<RemoteTerminalControlFetchResult> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (error) {
    return { ok: false, status: 0, reason: (error as Error).message };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    return { ok: false, status: response.status, reason: `invalid JSON: ${(error as Error).message}` };
  }
  // The terminal control endpoint returns a structured PtyControlResult for both
  // successful and mapped non-2xx outcomes (404/409/502/504). JSON is therefore
  // the transport success boundary; `mapResult` owns the control-status outcome.
  return { ok: true, status: response.status, json };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseRemoteTerminalItem(value: unknown): RemoteTerminalListItem | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = stringOrUndefined(row.id);
  if (!id) return null;
  const originCategory = row.terminalOriginCategory;
  const sourceRootRaw = row.sourceRoot;
  const sourceRoot = sourceRootRaw !== null && typeof sourceRootRaw === 'object' && !Array.isArray(sourceRootRaw)
    ? {
      name: stringOrUndefined((sourceRootRaw as Record<string, unknown>).name) ?? '',
      dbPath: stringOrUndefined((sourceRootRaw as Record<string, unknown>).dbPath) ?? '',
    }
    : undefined;
  return {
    id,
    ...(stringOrUndefined(row.kind) ? { kind: stringOrUndefined(row.kind) } : {}),
    ...(stringOrUndefined(row.nickname) ? { nickname: stringOrUndefined(row.nickname) } : {}),
    ...(stringOrUndefined(row.runId) ? { runId: stringOrUndefined(row.runId) } : {}),
    ...(stringOrUndefined(row.instance) ? { instance: stringOrUndefined(row.instance) } : {}),
    ...(typeof row.alive === 'boolean' ? { alive: row.alive } : {}),
    // ⛔⭐ `workdir` 은 «빈 값»을 «생략»으로 접지 않는다 — 그 둘은 다른 사실이다.
    //   🩸 `stringOrUndefined` 는 `''` 를 undefined 로 바꾼다(길이 0 을 «없음»으로 본다).
    //      그러면 저쪽이 «칸을 보냈는데 값이 비었다」와 «칸을 아예 안 보냈다」가 같은 산출이 된다.
    //      리뷰 must-fix 로 잡혔고, 그 전 시험은 이 파서를 «우회»해서 못 잡았다.
    ...(typeof row.workdir === 'string' ? { workdir: row.workdir } : {}),
    ...(originCategory === 'direct-human' || originCategory === 'elanous' || originCategory === 'external-tool' || originCategory === 'unknown'
      ? { terminalOriginCategory: originCategory }
      : {}),
    ...(stringOrUndefined(row.terminalOriginReason) ? { terminalOriginReason: stringOrUndefined(row.terminalOriginReason) } : {}),
    ...(stringOrUndefined(row.externalToolName) ? { externalToolName: stringOrUndefined(row.externalToolName) } : {}),
    ...(numberOrUndefined(row.startedAt) !== undefined ? { startedAt: numberOrUndefined(row.startedAt) } : {}),
    ...((numberOrUndefined(row.outputBytes) ?? numberOrUndefined(row.outputBytesTotal)) !== undefined
      ? { outputBytes: (numberOrUndefined(row.outputBytes) ?? numberOrUndefined(row.outputBytesTotal)) }
      : {}),
    ...(numberOrUndefined(row.lastControlAt) !== undefined ? { lastControlAt: numberOrUndefined(row.lastControlAt) } : {}),
    ...(typeof row.ownerProcessAlive === 'boolean' ? { ownerProcessAlive: row.ownerProcessAlive } : {}),
    ...(sourceRoot && sourceRoot.name && sourceRoot.dbPath ? { sourceRoot } : {}),
  };
}

function parseRemoteTerminalsBody(body: unknown): readonly RemoteTerminalListItem[] {
  const items = Array.isArray(body)
    ? body
    : (body !== null && typeof body === 'object' && Array.isArray((body as { terminals?: unknown }).terminals))
      ? (body as { terminals: unknown[] }).terminals
      : null;
  if (!items) throw new Error('pty list: remote /v1/terminals response is not a terminal list');
  return items.map((value, index) => {
    const row = parseRemoteTerminalItem(value);
    if (!row) throw new Error(`pty list: remote /v1/terminals item ${index} is malformed`);
    return row;
  });
}

async function liveFetchRemoteTerminals(url: string, token: string): Promise<RemoteTerminalsFetchResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    return { ok: false, status: 0, reason: (error as Error).message };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, status: response.status, reason: `invalid JSON: ${(error as Error).message}` };
  }
  try {
    return { ok: true, terminals: parseRemoteTerminalsBody(body) };
  } catch (error) {
    return { ok: false, status: response.status, reason: (error as Error).message };
  }
}

/** ⭐ `label` 은 ***모든 실패 문면이 대야 하는 이름***이다 — 사람이 「어느 북마크가 실패했나」를
 *  묻기 때문이다(리뷰 must-fix). 이름을 명시했으면 그것을, default 면 그 default 의 «이름»을 쓴다.
 *  ⛔ 이름을 못 찾으면 `'<default>'` 로 둔다 — ***호스트로 대체하지 않는다***.
 *  호스트는 「어느 기계」이지 「어느 북마크」가 아니고, 한 기계에 북마크가 여럿일 수 있다. */
function resolvePtyListBookmark(
  remote: string | boolean | undefined,
  store: RemotesStore,
): { entry: ReturnType<RemotesStore['getDefaultRemote']>; named?: string; label: string } {
  const named = typeof remote === 'string' && remote.length > 0 ? remote : undefined;
  const entry = named ? store.getRemote(named) : store.getDefaultRemote();
  const defaultName = named ? undefined : store.listRemotes().find((r) => r.isDefault)?.name;
  return { entry, ...(named ? { named } : {}), label: named ?? defaultName ?? '<default>' };
}

function ptyBookmarkError(command: string | undefined, named: string | undefined): PtyTakeoverCommandResult {
  const prefix = command ? `pty ${command}: ` : '';
  return {
    exitCode: 1,
    message: named
      ? `${prefix}--remote ${named}: unknown bookmark. Run \`elanous nexus list\` to see available remotes.`
      : `${prefix}no default remote bookmark. Run \`elanous nexus connect <host> --default\` to set one.`,
  };
}

function ptyListBookmarkError(named: string | undefined): PtyTakeoverCommandResult {
  return ptyBookmarkError(undefined, named);
}

function ptyListRemoteTokenError(label: string, host: string, tokenFile: string): PtyTakeoverCommandResult {
  return {
    exitCode: 1,
    message: `pty list: remote bookmark ${label} (${host}): token file is missing or empty (${tokenFile})`,
  };
}

function ptyListRemoteFetchError(label: string, url: string, reason: string): PtyTakeoverCommandResult {
  return {
    exitCode: 1,
    message: `pty list: remote bookmark ${label}: lookup failed for ${url}: ${reason}`,
  };
}

function remoteControlFetchError(action: string, label: string, url: string, reason: string): PtyTakeoverCommandResult {
  return { exitCode: 1, message: `pty ${action}: remote bookmark ${label}: control failed for ${url}: ${reason}` };
}

function parseRemoteTerminalControl(body: unknown): PtyControlResult | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const result = body as Record<string, unknown>;
  const status = stringOrUndefined(result.status);
  if (status === undefined || !(['success', 'unknown-pty', 'denied', 'failed', 'write-failed', 'owner-unreachable'] as const).includes(status as 'success')) return null;
  return {
    status: status as PtyControlResult['status'],
    ...(stringOrUndefined(result.reason) ? { reason: stringOrUndefined(result.reason) } : {}),
    ...(stringOrUndefined(result.screen) ? { screen: stringOrUndefined(result.screen) } : {}),
  } as PtyControlResult;
}

async function runPtyRemoteControl(
  action: 'text' | 'key' | 'mouse' | 'snapshot',
  id: string,
  remote: string | boolean,
  body: RemoteTerminalControlBody,
  deps: PtyTakeoverCommandDeps,
): Promise<PtyTakeoverCommandResult> {
  const store = deps.remotesStore?.() ?? new RemotesStore();
  const { entry, named, label } = resolvePtyListBookmark(remote, store);
  if (!entry) return ptyBookmarkError(action, named);
  let defaults: { host: string; tokenFile: string };
  try { defaults = bookmarkAttachDefaults(entry); }
  catch (error) { return { exitCode: 1, message: `pty ${action}: remote bookmark ${label}: ${(error as Error).message}` }; }
  const token = store.readToken(entry)?.trim();
  if (!token) return { exitCode: 1, message: `pty ${action}: remote bookmark ${label} (${entry.host}): token file is missing or empty (${defaults.tokenFile})` };
  let url: string;
  try { url = remoteTerminalControlUrl(defaults.host, id); }
  catch (error) { return { exitCode: 1, message: `pty ${action}: remote bookmark ${label}: ${(error as Error).message}` }; }
  let response: RemoteTerminalControlFetchResult;
  try { response = await (deps.postRemoteTerminalControl ?? livePostRemoteTerminalControl)(url, token, body); }
  catch (error) { return remoteControlFetchError(action, label, url, (error as Error).message); }
  if (!response.ok) return remoteControlFetchError(action, label, url, response.reason);
  const result = parseRemoteTerminalControl(response.json);
  if (!result) return remoteControlFetchError(action, label, url, 'invalid JSON control response');
  return mapResult(action, id, result, deps, { remote: true, url });
}

function remotePtyListJsonRow(row: RemoteTerminalListItem): PtyListJsonRow {
  const origin = remoteTerminalOriginFields(row);
  // ⛔⭐ **원격 행의 «워크트리 유래»(provenance)는 «언제나» unknown 이다.**
  //   ⚠️ 이것은 위 `remoteTerminalOriginFields`(터미널 «출처» origin)와 ***다른 축***이다 —
  //      origin 은 저쪽이 «보고하면 그대로 쓴다». provenance 는 «우리가 git 을 돌려야» 아는 값이라
  //      원격에서는 언제나 모른다. ⛔ 둘을 한 규칙으로 읽지 마라(리뷰 should-fix 로 잡힌 혼동).
  //   🩸 옛 판은 응답에 workdir 이 «없으면» `workdir-not-recorded` 로 적었다. 그것은 저쪽 기계에 대한
  //      ***사실 주장***인데 우리는 그 기계에서 git 을 «돌린 적이 없다». 우리가 아는 것은
  //      「그 응답이 그 칸을 안 실었다」뿐이고, 그것은 «저쪽에 기록이 없다»와 다른 값이다.
  const provenance: PtyWorktreeProvenance = { known: false, provenanceReason: 'unknown' };
  return {
    id: row.id,
    kind: row.kind ?? 'unknown',
    ...(row.nickname ? { nickname: row.nickname } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    instance: row.instance ?? 'unknown',
    sourceRoot: row.sourceRoot ?? 'unknown',
    alive: row.alive ?? 'unknown',
    ...(row.workdir !== undefined ? { workdir: row.workdir } : {}),
    ...origin,
    ...provenanceFields(provenance),
    // ⭐ 로컬 행과 ***정확히 같은 키***를 낸다 — 값으로만 갈린다.
    ...REMOTE_WEB_ADDRESS,
    ownerProcessAlive: row.ownerProcessAlive ?? 'unknown',
    updatedAgeMs: 'unknown',
    outputBytesTotal: row.outputBytes ?? 'unknown',
    ...(row.lastControlAt === undefined ? {} : { lastControlAt: row.lastControlAt }),
    ...(row.startedAt !== undefined ? ptyAgeField(row.startedAt, Date.now()) : {}),
    runTerminated: 'ledger-indeterminate',
    runTerminationSource: 'unknown',
    runStoreIo: 'not-checked',
    ownerRunUsage: 'unknown',
  };
}

function formatRemotePtyListRow(row: RemoteTerminalListItem): string {
  const origin = formatRemoteTerminalOrigin(row);
  const alive = row.alive === undefined ? 'unknown' : row.alive ? 'alive' : 'dead';
  // ⛔⭐ **원격 행의 «워크트리 유래»(provenance)는 «언제나» unknown 이다.**
  //   ⚠️ 이것은 위 `remoteTerminalOriginFields`(터미널 «출처» origin)와 ***다른 축***이다 —
  //      origin 은 저쪽이 «보고하면 그대로 쓴다». provenance 는 «우리가 git 을 돌려야» 아는 값이라
  //      원격에서는 언제나 모른다. ⛔ 둘을 한 규칙으로 읽지 마라(리뷰 should-fix 로 잡힌 혼동).
  //   🩸 옛 판은 응답에 workdir 이 «없으면» `workdir-not-recorded` 로 적었다. 그것은 저쪽 기계에 대한
  //      ***사실 주장***인데 우리는 그 기계에서 git 을 «돌린 적이 없다». 우리가 아는 것은
  //      「그 응답이 그 칸을 안 실었다」뿐이고, 그것은 «저쪽에 기록이 없다»와 다른 값이다.
  const provenance: PtyWorktreeProvenance = { known: false, provenanceReason: 'unknown' };
  return `${row.id}\t${row.kind ?? 'unknown'}\t${row.nickname ?? '-'}\tremote\t${alive}\t?\t${row.workdir ?? '-'}\t${row.runId ?? '-'}\tunknown\t${origin}\t${formatPtyWorktreeProvenance(provenance)}`;
}

async function runPtyListRemote(
  deps: PtyTakeoverCommandDeps,
  opts: { all?: boolean; includeTest?: boolean; json?: boolean; remote?: string | boolean },
): Promise<PtyTakeoverCommandResult> {
  // ⛔⭐ **`--all` / `--include-test` 은 «로컬 연합 스코프»의 축이다 — 원격에는 뜻이 없다.**
  //   🩸 종전엔 «조용히 무시»했고, 그러면 사람은 「전 인스턴스를 봤다」고 믿는다.
  //      그건 이 판이 내내 고쳐 온 형태다 — ***도구가 못 한 것을 «안 말하는 것».***
  //   ⇒ 조용히 넘어가지 않고 이름을 대고 멈춘다.
  const remoteScopeFlags = [
    ...(opts.all === true ? ['--all'] : []),
    ...(opts.includeTest === true ? ['--include-test'] : []),
  ];
  if (remoteScopeFlags.length > 0) {
    return {
      exitCode: 1,
      message: `pty list: ${remoteScopeFlags.join(' / ')} is a local federation scope and has no meaning with --remote; drop it (the remote daemon decides its own scope).`,
    };
  }
  const store = deps.remotesStore?.() ?? new RemotesStore();
  const { entry, named, label } = resolvePtyListBookmark(opts.remote, store);
  if (!entry) return ptyListBookmarkError(named);
  let defaults: { host: string; tokenFile: string };
  try {
    defaults = bookmarkAttachDefaults(entry);
  } catch (error) {
    return { exitCode: 1, message: `pty list: remote bookmark ${label}: ${(error as Error).message}` };
  }
  const token = store.readToken(entry)?.trim();
  if (!token) return ptyListRemoteTokenError(label, entry.host, defaults.tokenFile);
  let url: string;
  try {
    url = remoteTerminalsUrl(defaults.host);
  } catch (error) {
    return { exitCode: 1, message: `pty list: remote bookmark ${label}: ${(error as Error).message}` };
  }
  const fetchRemote = deps.fetchRemoteTerminals ?? liveFetchRemoteTerminals;
  let fetched: RemoteTerminalsFetchResult;
  try {
    fetched = await fetchRemote(url, token);
  } catch (error) {
    return ptyListRemoteFetchError(label, url, (error as Error).message);
  }
  if (!fetched.ok) return ptyListRemoteFetchError(label, url, fetched.reason);
  deps.log('list', { count: fetched.terminals.length, remote: true, json: opts.json === true, url });
  if (opts.json) {
    const payload = fetched.terminals.map((row) => remotePtyListJsonRow(row));
    return {
      exitCode: 0,
      message: JSON.stringify(payload, null, 2),
      ...(payload.length === 0 ? { notice: `pty list: no PTYs found (scope: remote bookmark ${named ?? 'default'})` } : {}),
    };
  }
  if (fetched.terminals.length === 0) {
    return { exitCode: 0, message: `pty list: no PTYs found (scope: remote bookmark ${named ?? 'default'})\npurpose-known rows: 0/0` };
  }
  const rendered = fetched.terminals.map((row) => formatRemotePtyListRow(row));
  return {
    exitCode: 0,
    message: [...rendered, `purpose-known rows: 0/${rendered.length}`].join('\n'),
  };
}

function runPtyListJson(deps: PtyTakeoverCommandDeps, opts: { all?: boolean; includeTest?: boolean }): PtyTakeoverCommandResult {
  // ⛔ 리뷰 must-fix (2026-08-19): 종전엔 여기서 `listManifestRows` 를 «필수»로 요구했는데,
  //   두 분기가 모두 뿌리 지정 리더(`listManifestRowsAt`)로 옮겨 가 «아무도 안 쓴다».
  //   낡은 요구를 남겨 두면 뿌리 리더만 갖춘 «옳은» 구성이 이유 없이 실패한다.
  if (!deps.isProcessAlive) return { exitCode: 1, message: 'pty list --json: process liveness checker is unavailable' };
  const rows: Array<{ row: PtyManifestRow; instance: string; sourceRoot: PtyManifestSourceRoot }> = [];
  if (opts.all) {
    if (!deps.manifestTargets || !deps.listManifestRowsAt) return { exitCode: 1, message: 'pty list --all --json: federated manifest readers are unavailable' };
    const realpath = deps.realpath ?? ((path: string) => { try { return realpathSync(path); } catch { return path; } });
    const currentDbPath = deps.currentManifestDbPath?.();
    const targets = currentDbPath
      ? federatedManifestTargets(deps.manifestTargets({ includeTest: opts.includeTest === true }), currentDbPath, realpath)
      : deps.manifestTargets({ includeTest: opts.includeTest === true });
    for (const target of targets) {
      try { rows.push(...deps.listManifestRowsAt(target.dbPath).map((row) => ({ row, instance: row.instance || target.name, sourceRoot: { name: target.name, dbPath: target.dbPath } }))); }
      catch { return { exitCode: 1, message: `pty list --all --json: could not read instance manifest: ${target.name}` }; }
    }
  } else {
    if (!deps.currentManifestDbPath || !deps.manifestTargets) return { exitCode: 1, message: 'pty list --json: current manifest target is unavailable' };
    // ⛔⭐ 리뷰 must-fix (2026-08-19): 종전엔 «출처»는 currentDbPath 에서 고르고 «행»은 주변
    //   `listManifestRows()` 에서 읽었다. 그 둘이 구조적으로 안 묶여 있어, 다른 저장소를 읽는
    //   리더가 주어지면 ***모든 행에 이 뿌리의 sourceRoot 가 거짓으로 붙는다*** — 이 칸이 막으려던
    //   바로 그 사고(라벨과 뿌리가 어긋난다)를 이 칸 자신이 만들 수 있었다.
    //   ⇒ 「고른 뿌리」에서 «직접» 읽는다. 읽은 경로와 붙이는 출처가 같은 값에서 나온다.
    const currentDbPath = deps.currentManifestDbPath();
    const realpath = deps.realpath ?? ((path: string) => { try { return realpathSync(path); } catch { return path; } });
    // ⛔⭐ 리뷰 should-fix (2026-08-19) — 여기서 `includeTest: true` 는 «의도»다.
    //   이 조회의 목적은 「지금 이 뿌리가 «등록된 것들 중 어느 것인가»」를 식별하는 것이지
    //   「사용자가 무엇을 보고 싶은가」가 아니다. 사용자 필터를 여기 걸면 격리(test) 우주에서
    //   돌 때 «자기 자신»을 못 찾아 단일 뿌리 조회가 통째로 실패한다.
    //   ⇒ 식별은 전 범위에서, «표시»는 호출자의 스코프대로.
    const currentTarget = deps.manifestTargets({ includeTest: true }).find((target) => realpath(target.dbPath) === realpath(currentDbPath));
    // ⛔ 리뷰 should-fix: target 객체를 «그대로» 싣지 않는다 — manifestTargets 에 새 필드가 생기면
    //   JSON 계약이 «조용히» 넓어진다. 필요한 둘만 명시 투영한다.
    const sourceRoot = currentTarget ? { name: currentTarget.name, dbPath: currentTarget.dbPath } : undefined;
    if (!sourceRoot) return { exitCode: 1, message: `pty list --json: current manifest target is unregistered: ${currentDbPath}` };
    // ⛔ 가드는 «미등록» 판정 «뒤»에 온다 — 앞에 두면 그 에러가 이 에러에 가려진다(리뷰 회귀).
    if (!deps.listManifestRowsAt) return { exitCode: 1, message: 'pty list --json: rooted manifest reader is unavailable' };
    try { rows.push(...deps.listManifestRowsAt(sourceRoot.dbPath).map((row) => ({ row, instance: row.instance, sourceRoot }))); }
    catch { return { exitCode: 1, message: `pty list --json: could not read instance manifest: ${sourceRoot.name}` }; }
  }
  // Keep the existing list contract: rows whose selected PTY/owner process is dead are not listable.
  const pwa = deps.resolveNexusPwa?.();
  const payload = rows
    .filter(({ row }) => row.alive && (row.ptyPid > 0 ? deps.isProcessAlive!(row.ptyPid) : deps.isProcessAlive!(row.ownerPid)))
    .map(({ row, instance, sourceRoot }) => ptyListJsonRow(row, instance, sourceRoot, deps, { includeTest: opts.includeTest === true }, pwa));
  deps.log('list', { count: payload.length, federated: opts.all === true, includeTest: opts.includeTest === true, json: true });
  return { exitCode: 0, message: JSON.stringify(payload, null, 2), ...(payload.length === 0 ? { notice: ptyListEmptyNotice(opts) } : {}) };
}

export function runPtyList(
  deps?: PtyTakeoverCommandDeps,
  opts?: { all?: boolean; includeTest?: boolean; json?: boolean; remote?: undefined },
): PtyTakeoverCommandResult;
export function runPtyList(
  deps: PtyTakeoverCommandDeps,
  opts: { all?: boolean; includeTest?: boolean; json?: boolean; remote: string | boolean },
): Promise<PtyTakeoverCommandResult>;
export function runPtyList(
  deps: PtyTakeoverCommandDeps = liveDeps,
  opts: { all?: boolean; includeTest?: boolean; json?: boolean; remote?: string | boolean } = {},
): PtyTakeoverCommandResult | Promise<PtyTakeoverCommandResult> {
  // ⛔⭐ **연합 조회**(2026-07-30 실측) — `pty list` 는 **지금 뿌리 하나**만 본다. 그런데 하니스
  //    자식은 **자기 워크트리에서 파생된 인스턴스**(`test:wt-*`)에 등록되므로 부모 트리에서는
  //    자식 PTY 가 **영영 안 보인다**. 화면은 `fleet screen --all` 로 연합되는데 **ref 목록은
  //    연합이 없어서**, 매뉴얼이 1급 경로로 안내하는 `pty list` → `pty text` 가 자식에 닿지 못했다.
  //    ⇒ `--all` 은 **조회만** 연합한다(제어는 소유 뿌리에서 — 여기서 경계를 넓히지 않는다).
  // ⛔ `--include-test` 는 `--all` 의 수식어다 — 단독으로 주면 **아무 효과 없이 통과**해
  //    사용자가 격리 인스턴스를 봤다고 착각한다(리뷰 should-fix). 명시적으로 거부한다.
  if (opts.includeTest && !opts.all) {
    return { exitCode: 1, message: 'pty list: --include-test only applies with --all' };
  }
  if (opts.remote !== undefined) return runPtyListRemote(deps, opts);
  if (opts.json) return runPtyListJson(deps, opts);
  if (opts.all) {
    if (!deps.listFederatedRefs) return { exitCode: 1, message: 'pty list --all: federated listing is unavailable' };
    const { refs, unreadable } = deps.listFederatedRefs({ includeTest: opts.includeTest === true });
    deps.log('list', { count: refs.length, federated: true, includeTest: opts.includeTest === true, unreadable: unreadable.length });
    // ⛔ 하나도 못 읽었으면 *"없다"* 가 아니라 **못 봤다**로 끝낸다(fail-closed).
    if (refs.length === 0 && unreadable.length > 0) {
      return { exitCode: 1, message: `pty list --all: could not read ${unreadable.length} instance manifest(s): ${unreadable.join(', ')}` };
    }
    if (refs.length === 0) return { exitCode: 0, message: `${ptyListEmptyNotice(opts)}\npurpose-known rows: 0/0` };
    // ⚠️ 일부만 못 읽었으면 **목록은 주되 부분임을 밝힌다** — 조용한 부분 목록이 가장 위험하다.
    const partial = unreadable.length > 0 ? [`⚠️ partial: could not read ${unreadable.join(', ')}`] : [];
    const pwa = deps.resolveNexusPwa?.();
    const rendered = refs.map((ref) => {
      const runTerminated = ref.runId
        ? deps.runTerminated?.(ref.runId, { includeTest: opts.includeTest === true }) ?? 'ledger-indeterminate'
        : 'no-run-id';
      const ownerRunUsage = classifyPtyOwnerRunUsage(ref.ownerProcessAlive, runTerminated);
      const provenance = (deps.resolveWorktreeProvenance ?? resolvePtyWorktreeProvenance)(ref.workdir);
      if (ownerRunUsage === 'terminated-live-owner') deps.log('owner-run-terminated', { ptyId: ref.id, runId: ref.runId ?? '' });
      return { known: normalizePtyWorktreeProvenance(provenance).known, line: `${formatFederatedRef(ref, ownerRunUsage)}\t${formatTerminalOrigin(ref)}\t${formatPtyWorktreeProvenance(provenance)}${pwa ? `\t${formatPtyWebAddress(ptyWebAddress(ref.id, pwa))}` : ''}` };
    });
    return { exitCode: 0, message: [...rendered.map(({ line }) => line), `purpose-known rows: ${rendered.filter(({ known }) => known).length}/${rendered.length}`, ...partial].join('\n') };
  }
  if (!deps.readAddressBook && !deps.listRefs) return { exitCode: 1, message: 'pty list: PTY reference listing is unavailable' };
  const refs = deps.readAddressBook?.().refs ?? deps.listRefs!();
  const ownerRunUsageById = deps.runTerminated && deps.listManifestRows && deps.isProcessAlive
    ? new Map(deps.listManifestRows().map((row) => {
      const proof = provePtyRetirement(row, deps.now?.() ?? Date.now(), deps.isProcessAlive!);
      // ⛔⭐ 사후 리뷰 must-fix (2026-08-19): 여기가 `{ includeTest: false }` 로 «못 박혀» 있었다.
      //   `pty list --all --include-test` 로 «격리 우주까지» 물었는데도 원장은 운영 우주에서만 찾아
      //   ***test 원장의 종료 상태를 못 보고 판정이 틀렸다***. JSON 경로(`ptyListJsonRow`)는 옳게
      //   `opts` 를 넘기고 있었다 — 즉 «같은 물음이 두 표면에서 다른 답»을 냈다.
      const usage = classifyPtyOwnerRunUsage(proof.liveness.alive, deps.runTerminated!(row.runId, { includeTest: opts.includeTest === true }));
      if (usage === 'terminated-live-owner') deps.log('owner-run-terminated', { ptyId: row.id, runId: row.runId });
      return [row.id, usage] as const;
    }))
    : new Map<string, PtyOwnerRunUsage>();
  deps.log('list', { count: refs.length });
  if (refs.length === 0) return { exitCode: 0, message: `${ptyListEmptyNotice(opts)}\npurpose-known rows: 0/0` };
  const pwa = deps.resolveNexusPwa?.();
  const rendered = refs.map((ref) => {
    const provenance = (deps.resolveWorktreeProvenance ?? resolvePtyWorktreeProvenance)(ref.workdir);
    return { known: normalizePtyWorktreeProvenance(provenance).known, line: `${ref.id}\t${ref.kind}\t${ref.nickname ?? '-'}\t${ref.source}\t${ref.alive ? 'alive' : 'dead'}\t${ref.mode ?? '?'}\t${ref.workdir ?? '-'}\t${ref.runId ?? '-'}${ownerRunUsageById.has(ref.id) ? `\t${ownerRunUsageById.get(ref.id)}` : ''}\t${formatTerminalOrigin(ref)}\t${formatPtyWorktreeProvenance(provenance)}${pwa ? `\t${formatPtyWebAddress(ptyWebAddress(ref.id, pwa))}` : ''}` };
  });
  return {
    exitCode: 0,
    message: [...rendered.map(({ line }) => line), `purpose-known rows: ${rendered.filter(({ known }) => known).length}/${rendered.length}`].join('\n'),
  };
}

/** 연합 행 한 줄 — ⭐ **인스턴스를 첫 칸**에 둔다. 어느 뿌리의 것인지 모르면 제어로 못 넘어간다. */
function formatFederatedRef(ref: FederatedPtyRef, ownerRunUsage?: PtyOwnerRunUsage): string {
  return `${ref.instance}\t${terminalTreeLabel(ref.sourceRoot) || '-'}\t${ref.id}\t${ref.kind}\t${ref.nickname ?? '-'}\t${ref.alive ? 'alive' : 'dead'}\t${ref.runId ?? '-'}${ownerRunUsage === undefined ? '' : `\t${ownerRunUsage}`}`;
}

export async function runPtyTakeover(ref: string, deps: PtyTakeoverCommandDeps = liveDeps): Promise<PtyTakeoverCommandResult> {
  const resolved = resolveId(ref, 'takeover', deps); if (typeof resolved !== 'string') return resolved;
  const id = resolved;
  const handle = deps.getPty(id);
  if (!handle) return mapResult('takeover', id, await deps.requestRemote(id, 'takeover'), deps);
  const from = handle.accessMode; const policy = handle.transitionPolicy; const decision = resolveTakeover(from, policy, 'human');
  return mapResult('takeover', id, decision.allow && deps.requestPtyTakeover(id, 'human') ? { status: 'success', from, to: handle.accessMode, policy } : { status: 'denied', from, policy, reason: decision.reason }, deps);
}
export async function runPtyRelease(ref: string, deps: PtyTakeoverCommandDeps = liveDeps): Promise<PtyTakeoverCommandResult> {
  const resolved = resolveId(ref, 'release', deps); if (typeof resolved !== 'string') return resolved;
  const id = resolved;
  // Release restoration is authoritative in the IPC owner: it owns the saved prior mode and transition policy.
  return mapResult('release', id, await deps.requestRemote(id, 'release'), deps);
}
/** 로컬 handle 경로의 actor 인가 — **원격과 같은 pure 판정**을 탄다(창구가 갈려도 규칙은 하나).
 *  ⚠️ `human` 도 예외 없이 태운다 — 조기 반환하면 지금은 결과가 같아도 pure 규칙이 바뀌는 날
 *  **로컬만 옛 규칙에 남는다**(두 창구가 갈리는 그 형태). 같은 판정을 탄다는 말이 참이어야 한다. */
function localActor(id: string, requested: PtyWriteActor, deps: PtyTakeoverCommandDeps): PtyWriteActor | { readonly reason: string } {
  const identity = deps.runIdentity?.(id) ?? { requester: '', target: '' };
  const decision = resolveRemoteControlActor(requested, identity.requester, identity.target);
  return decision.allow ? decision.actor : { reason: decision.reason };
}

async function inject(ref: string, action: 'input-text' | 'input-key', chars: string, safe: Record<string, unknown>, deps: PtyTakeoverCommandDeps, actor: PtyWriteActor): Promise<PtyTakeoverCommandResult> {
  const refResult = resolveId(ref, action, deps); if (typeof refResult !== 'string') return refResult;
  const id = refResult;
  const observed = { ...safe, actor };
  const handle = deps.getPty(id);
  if (!handle) return mapResult(action, id, await deps.requestRemote(id, action, { chars }, { actor }), deps, observed);
  const resolved = localActor(id, actor, deps);
  if (typeof resolved !== 'string') return mapResult(action, id, { status: 'denied', reason: resolved.reason }, deps, observed);
  const outcome = writePtyWithOutcome(handle, chars, resolved);
  return mapResult(action, id, outcome === 'success'
    ? { status: 'success' }
    : outcome === 'denied'
      ? { status: 'denied', reason: 'write-arbiter' }
      : { status: 'write-failed', reason: 'adapter-write' }, deps, observed);
}
interface PtyScreenAcquisition {
  readonly id: string;
  readonly control: PtyControlResult;
  readonly status: 'running' | 'exited';
  readonly local: boolean;
}

async function acquirePtyScreen(ref: string, deps: PtyTakeoverCommandDeps, ansi = false): Promise<PtyScreenAcquisition | PtyTakeoverCommandResult> {
  const refResult = resolveId(ref, 'snapshot', deps); if (typeof refResult !== 'string') return refResult;
  const id = refResult;
  const handle = deps.getPty(id);
  if (!handle) return { id, control: snapshotWithFallback(id, await deps.requestRemote(id, 'snapshot', ansi ? { ansi: true } : undefined), deps), status: 'running', local: false };
  if (!handle.renderScreen) return { id, control: snapshotWithFallback(id, { status: 'failed', reason: 'screen-unavailable' }, deps), status: 'running', local: true };
  try {
    const screen = await handle.renderScreen(ansi ? { ansi: true } : undefined);
    return { id, control: { status: 'success', screen, source: 'live' }, status: handle.isAlive() ? 'running' : 'exited', local: true };
  } catch {
    return { id, control: snapshotWithFallback(id, { status: 'failed', reason: 'screen-render-failed' }, deps), status: 'running', local: true };
  }
}

export async function runPtySnapshot(ref: string, deps: PtyTakeoverCommandDeps = liveDeps, ansi = false): Promise<PtyTakeoverCommandResult> {
  const acquired = await acquirePtyScreen(ref, deps, ansi);
  if ('exitCode' in acquired) return acquired;
  const { id, control } = acquired;
  if (control.status !== 'success') return { exitCode: 1, message: formatSnapshotResult(id, control) };
  const screen = control.screen ?? '';
  const source = control.source ?? 'live';
  if (acquired.local) deps.log('snapshot', { ptyId: id, action: 'snapshot', source: 'live', ...(ansi ? { ansi: true } : {}), ...screenMetadata(screen) });
  else deps.log('snapshot', { ptyId: id, action: 'snapshot', source, ...(source === 'frame' ? { frameAt: control.frameAt ?? 0, fallback: control.diagnostic } : {}), ...screenMetadata(screen), from: control.from, to: control.to });
  return { exitCode: 0, message: formatSnapshotResult(id, control, acquired.status) };
}

const WAITABLE_FRAME_STATES: readonly Exclude<FrameState, 'unknown'>[] = ['idle', 'working', 'blocked', 'waiting', 'done'];

export async function runPtyState(ref: string, deps: PtyTakeoverCommandDeps = liveDeps, json = false): Promise<PtyTakeoverCommandResult> {
  const acquired = await acquirePtyScreen(ref, deps);
  if ('exitCode' in acquired) return acquired;
  if (acquired.control.status !== 'success') return { exitCode: 1, message: formatSnapshotResult(acquired.id, acquired.control) };
  const verdict = classifyFrameState(acquired.control.screen ?? '');
  const at = deps.now?.() ?? Date.now();
  return { exitCode: 0, message: json
    ? JSON.stringify({ id: acquired.id, state: verdict.state, label: verdict.matchedLabel, at })
    : `pty state: ${acquired.id} state=${verdict.state} label=${verdict.matchedLabel ?? '-'}` };
}

export async function runPtyWait(ref: string, until: string, options: { readonly timeoutMs?: number; readonly pollMs?: number } = {}, deps: PtyTakeoverCommandDeps = liveDeps): Promise<PtyTakeoverCommandResult> {
  if (!WAITABLE_FRAME_STATES.includes(until as Exclude<FrameState, 'unknown'>)) return { exitCode: 2, message: `pty wait: --until must be one of ${WAITABLE_FRAME_STATES.join(', ')} (got ${until})` };
  const target = until as Exclude<FrameState, 'unknown'>;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 500;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  while (true) {
    const acquired = await acquirePtyScreen(ref, deps);
    if ('exitCode' in acquired) return acquired;
    if (acquired.control.status !== 'success') return { exitCode: 1, message: formatSnapshotResult(acquired.id, acquired.control) };
    const verdict = classifyFrameState(acquired.control.screen ?? '');
    const elapsed = now() - startedAt;
    if (verdict.state === target) return { exitCode: 0, message: `pty wait: ${acquired.id} reached ${target} after ${elapsed}ms` };
    if (elapsed >= timeoutMs) return { exitCode: 1, message: `pty wait: ${acquired.id} timed out after ${elapsed}ms (last state=${verdict.state} label=${verdict.matchedLabel ?? '-'})` };
    await sleep(pollMs);
  }
}

export function runPtyText(ref: string, text: string, appendEnter = false, deps: PtyTakeoverCommandDeps = liveDeps, actor: PtyWriteActor = 'human'): Promise<PtyTakeoverCommandResult> { return inject(ref, 'input-text', text + (appendEnter ? '\r' : ''), { length: text.length + (appendEnter ? 1 : 0) }, deps, actor); }
export function runPtyKey(ref: string, key: string, repeat = 1, deps: PtyTakeoverCommandDeps = liveDeps, actor: PtyWriteActor = 'human'): Promise<PtyTakeoverCommandResult> {
  if (!Number.isInteger(repeat) || repeat < 1) return Promise.resolve({ exitCode: 1, message: 'pty key: repeat must be a positive integer' });
  try { const normalized = key.trim().toLowerCase(); return inject(ref, 'input-key', resolvePtySpecialKey(normalized).repeat(repeat), { key: normalized, repeat }, deps, actor); } catch (error) { return Promise.resolve({ exitCode: 1, message: `pty key: ${(error as Error).message}` }); }
}
export async function runPtyMouse(ref: string, input: PtyMouseInput, deps: PtyTakeoverCommandDeps = liveDeps, actor: PtyWriteActor = 'human'): Promise<PtyTakeoverCommandResult> {
  let chars: string;
  try { chars = encodeSgrMouse(input); }
  catch (error) { return { exitCode: 1, message: `pty mouse: ${(error as Error).message}` }; }
  const resolvedRef = resolveId(ref, 'mouse', deps);
  if (typeof resolvedRef !== 'string') return resolvedRef;
  const id = resolvedRef;
  const observed = { x: input.x, y: input.y, kind: input.kind, button: input.button ?? 'left', actor };
  const handle = deps.getPty(id);
  if (!handle) return mapResult('mouse', id, await deps.requestRemote(id, 'input-mouse', input, { actor }), deps, observed);
  const resolved = localActor(id, actor, deps);
  if (typeof resolved !== 'string') return mapResult('mouse', id, { status: 'denied', reason: resolved.reason }, deps, observed);
  const off = mouseModeOffReason(handle);
  if (off) return mapResult('mouse', id, { status: 'denied', reason: off }, deps, observed);
  const outcome = writePtyWithOutcome(handle, chars, resolved);
  return mapResult('mouse', id, outcome === 'success' ? { status: 'success' } : outcome === 'denied' ? { status: 'denied', reason: 'write-arbiter' } : { status: 'write-failed', reason: 'adapter-write' }, deps, observed);
}

export async function runPtyResize(ref: string, cols: number, rows: number, deps: PtyTakeoverCommandDeps = liveDeps, actor: PtyWriteActor = 'human'): Promise<PtyTakeoverCommandResult> {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return { exitCode: 1, message: 'pty resize: cols and rows must be positive integers' };
  const refResult = resolveId(ref, 'resize', deps); if (typeof refResult !== 'string') return refResult;
  const id = refResult;
  const observed = { cols, rows, actor };
  const handle = deps.getPty(id); if (!handle) return mapResult('resize', id, await deps.requestRemote(id, 'resize', { cols, rows }, { actor }), deps, observed);
  const resolved = localActor(id, actor, deps);
  if (typeof resolved !== 'string') return mapResult('resize', id, { status: 'denied', reason: resolved.reason }, deps, observed);
  const outcome = resizePtyWithOutcome(handle, cols, rows, resolved);
  return mapResult('resize', id, outcome === 'success'
    ? { status: 'success' }
    : outcome === 'denied'
      ? { status: 'denied', reason: 'write-arbiter' }
      : { status: 'failed', reason: 'resize-error' }, deps, observed);
}
export function registerPtyTakeoverCommands(program: Command, deps: PtyTakeoverCommandDeps = liveDeps, toolInstallDeps: ToolInstallDeps = {}): void {
  const pty = program.command('pty').description(
    // ⭐ `<ref>` = id · nickname · unique prefix — **ref 를 받는 하위명령**이 resolvePtyRef 로 해석한다(`list` 는 인자 없음).
    //   종전 도움말은 `<ptyId>` 라 **실제보다 좁게** 적혀 있었다(구현은 처음부터 ref 를 받았다).
    "PTY control — <ref> is an id, nickname, or unique prefix (see 'pty list')",
  );
  // ⚠️ 명령을 **thunk 로** 받는다 — 미리 만든 Promise 를 받으면 명령이 이미 돌기 시작한 뒤라
  //    sink 등록 前에 나간 로그를 놓친다(짧은 명령일수록 잘 놓친다).
  const run = async <T extends { readonly exitCode: number; readonly message: string; readonly notice?: string }>(start: () => Promise<T>) => {
    await deps.registerObservationSink?.();
    const result = await start(); (result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`); if (result.notice) process.stderr.write(`${result.notice}\n`); process.exitCode = result.exitCode;
  };
  pty.command('list')
    .description('List PTY ids available to other PTY commands')
    // ⭐ 하니스 자식은 **자기 워크트리 인스턴스**에 등록된다 — 부모 뿌리만 보면 안 보인다(실측).
    .option('--all', 'list PTYs across registered instances (isolated test roots excluded by default)')
    .option('--include-test', 'include isolated test instances in --all')
    .option('--json', 'emit structured rows with retirement-observation values')
    // ⛔ `-r` 은 값을 받지 않는다 — default 북마크만. 이름은 `--remote <name>` 으로만 준다.
    .option('-r', 'list PTYs on the default remote bookmark (does not take a value)')
    .option('--remote <name>', 'list PTYs on a named remote bookmark via GET /v1/terminals')
    .action((o: { all?: boolean; includeTest?: boolean; json?: boolean; r?: boolean; remote?: string }) => run(async () => {
      const listOpts = { all: o.all === true, includeTest: o.includeTest === true, json: o.json === true };
      if (o.remote !== undefined) return runPtyList(deps, { ...listOpts, remote: o.remote });
      if (o.r === true) return runPtyList(deps, { ...listOpts, remote: true });
      return runPtyList(deps, listOpts);
    }));
  // ⛔ `--include-test` 단독은 **조용히 무시되지 않는다**(리뷰 should-fix) — 아래 runPtyList 가 거부한다.
  pty.command('reap').option('--yes', 'remove only rows whose owner process is confirmed dead').option('--include-test', 'include isolated test-instance manifests').option('--instance <name...>', 'narrow to one or more registered manifest root names').option('--json', 'emit per-root reap results as JSON')
    .description('Preview dead-owner manifest rows across roots; --yes removes only confirmed dead-owner rows')
    .action((opts: { yes?: boolean; includeTest?: boolean; instance?: string[]; json?: boolean }) => run(async () => runPtyReap(deps, { yes: opts.yes === true, includeTest: opts.includeTest === true, instance: opts.instance, json: opts.json === true })));
  pty.command('lineage <key>').option('--json', 'emit structured lineage JSON')
    .option('--control', 'include manifest control lineage and local read-only inbox snapshots')
    .option('--all', 'union lineage across registered instances (isolated test roots excluded by default)')
    .option('--include-test', 'include isolated test instances in --all')
    .description('Show PTY lineage from the local or federated manifest and lifecycle ledger')
    .action((key: string, opts: { json?: boolean; control?: boolean; all?: boolean; includeTest?: boolean }) => run(async () => runPtyLineage(key, deps, opts.json === true, { all: opts.all === true, includeTest: opts.includeTest === true, control: opts.control === true })));
  pty.command('find <key>').option('--json', 'emit structured find JSON')
    .description('Find local manifest rows by PTY pid, owner pid, PTY id, or run id')
    .action((key: string, opts: { json?: boolean }) => run(async () => runPtyFind(key, deps, opts.json === true)));
  pty.command('retire <ref>').option('--yes', 'remove the local manifest row after printing its retirement proof').option('--json', 'emit structured retirement proof JSON')
    .option('--all', 'prove rows across registered manifest roots without removing foreign rows')
    .option('--include-test', 'include isolated test instances in --all')
    .description('Prove whether a manifest row is removable; --all reads foreign roots but never removes their rows')
    .action((ref: string, opts: { yes?: boolean; json?: boolean; all?: boolean; includeTest?: boolean }) => run(async () => runPtyRetire(ref, deps, opts.yes === true, opts.json === true, { all: opts.all === true, includeTest: opts.includeTest === true })));
  pty.command('takeover <ref>').description('Request human write ownership through the PTY arbiter').action((id: string) => run(() => runPtyTakeover(id, deps)));
  registerPtyAttachDriveCommand(pty, run);
  pty.command('release <ref>').description('Return human-owned PTY control to its prior mode').action((id: string) => run(() => runPtyRelease(id, deps)));
  pty.command('state <ref>').option('--json', 'emit the classified frame state as JSON')
    .description('Classify the current PTY screen state').action((id: string, opts: { json?: boolean }) => run(() => runPtyState(id, deps, opts.json === true)));
  pty.command('wait <ref>').requiredOption('--until <state>', 'wait until idle, working, blocked, waiting, or done')
    .option('--timeout <ms>', 'timeout in milliseconds', '120000').option('--poll-ms <ms>', 'poll interval in milliseconds', '500')
    .description('Wait until the classified PTY screen reaches a state').action((id: string, opts: { until: string; timeout: string; pollMs: string }) => run(() => runPtyWait(id, opts.until, { timeoutMs: Number(opts.timeout), pollMs: Number(opts.pollMs) }, deps)));
  pty.command('install-tool <ref> <tool>')
    .description('Smoke-check a known tool in the PTY shell, install an unprivileged known remedy, and verify it')
    .action((ref: string, tool: string) => run(async () => {
      if (!['gh', 'rg', 'node', 'codex', 'jq', 'ffmpeg'].includes(tool)) {
        return { exitCode: 2 as const, message: `pty install-tool: unsupported tool ${tool}` };
      }
      const inPty: ToolInstallDeps = {
        typeLine: async (ptyRef, line) => {
          const typed = await runPtyText(ptyRef, line, true, deps, 'agent');
          if (typed.exitCode !== 0) throw new Error(typed.message);
        },
        waitIdle: (ptyRef, opts) => waitForPtyCompletion(ptyRef, opts, async (ref) => {
          const snapshot = await runPtySnapshot(ref, deps);
          if (snapshot.exitCode !== 0) throw new Error(snapshot.message);
          return snapshot.message;
        }),
        ...toolInstallDeps,
      };
      const result: ToolInstallResult = await installMissingTool({ tool: tool as 'gh' | 'rg' | 'node' | 'codex' | 'jq' | 'ffmpeg', ptyRef: ref }, inPty);
      return { exitCode: result.outcome === 'already' || result.outcome === 'installed' ? 0 as const : 1 as const,
        message: `pty install-tool: ${result.outcome}: ${result.reason}${result.line ? ` · ${result.line}` : ''}${result.needsLogin && !result.reason.includes('codex authentication not verified') ? ' · codex authentication not verified; run codex login before authenticated work' : ''}` };
    }));
  pty.command('snapshot <ref>').option('--ansi', 'reconstruct xterm cell attributes as terminal SGR sequences')
    .option('-r', 'render the PTY screen on the default remote bookmark (does not take a value)')
    .option('--remote <name>', 'render the PTY screen on a named remote bookmark')
    .description('Render the current PTY screen without requesting write ownership').action((id: string, opts: { ansi?: boolean; r?: boolean; remote?: string }) => run(() => {
      const remote = opts.remote ?? (opts.r === true ? true : undefined);
      return remote === undefined ? runPtySnapshot(id, deps, opts.ansi === true) : runPtyRemoteControl('snapshot', id, remote, { action: 'snapshot', ...(opts.ansi === true ? { ansi: true } : {}) }, deps);
    }));
  // ⭐ `--actor agent` = F3 agent 슬라이스. `human`(기본)은 `auto` 자식에 거부되고(takeover 선행),
  //    `agent` 는 **같은 run 의 감독**만 통과한다 — 자율 자식에 밖에서 넣는 유일한 경로.
  const ACTOR_FLAG = ['--actor <who>', "write actor: human (default) | agent (same-run supervisor into an 'auto' child)"] as const;
  const withActor = (opts: { actor?: string }, next: (actor: PtyWriteActor) => Promise<PtyTakeoverCommandResult>): Promise<PtyTakeoverCommandResult> => {
    const actor = parsePtyWriteActor(opts.actor);
    return actor ? next(actor) : Promise.resolve({ exitCode: 1, message: `pty: --actor must be 'human' or 'agent' (got ${opts.actor})` });
  };
  pty.command('text <ref> <text>').option('--enter', 'append Enter (CR) after the text').option('-r', 'inject text on the default remote bookmark (does not take a value)').option('--remote <name>', 'inject text on a named remote bookmark').option(...ACTOR_FLAG)
    .description('Inject literal text — no newline unless --enter').action((id: string, text: string, opts: { enter?: boolean; actor?: string; r?: boolean; remote?: string }) => run(() => {
      const remote = opts.remote ?? (opts.r === true ? true : undefined);
      return withActor(opts, (actor) => remote === undefined
        ? runPtyText(id, text, Boolean(opts.enter), deps, actor)
        : runPtyRemoteControl('text', id, remote, { action: 'input-text', chars: text + (opts.enter === true ? '\r' : '') }, deps));
    }));
  pty.command('key <ref> <key>').option('-n, --repeat <count>', 'repetitions', '1').option('-r', 'inject a key on the default remote bookmark (does not take a value)').option('--remote <name>', 'inject a key on a named remote bookmark').option(...ACTOR_FLAG)
    .description("Inject a named special key (enter/esc/tab/up/… · see 'pty list' for <ref>)").action((id: string, key: string, opts: { repeat: string; actor?: string; r?: boolean; remote?: string }) => run(() => {
      const remote = opts.remote ?? (opts.r === true ? true : undefined);
      return withActor(opts, (actor) => {
        if (remote === undefined) return runPtyKey(id, key, Number(opts.repeat), deps, actor);
        const repeat = Number(opts.repeat);
        if (!Number.isInteger(repeat) || repeat < 1) return Promise.resolve({ exitCode: 1, message: 'pty key: repeat must be a positive integer' });
        try { return runPtyRemoteControl('key', id, remote, { action: 'input-key', chars: resolvePtySpecialKey(key.trim().toLowerCase()).repeat(repeat) }, deps); }
        catch (error) { return Promise.resolve({ exitCode: 1, message: `pty key: ${(error as Error).message}` }); }
      });
    }));
  pty.command('mouse <ref> <x> <y>').option('--button <button>', 'left, middle, or right', 'left').option('--scroll <direction>', 'up or down').option('-r', 'use default remote bookmark').option('--remote <name>', 'use named remote bookmark').option(...ACTOR_FLAG)
    .description('Click or scroll a mouse-enabled SGR PTY (1-based column and row; disabled mode is refused by the owner)').action((id: string, x: string, y: string, opts: { button: string; scroll?: string; actor?: string; r?: boolean; remote?: string }) => run(() => withActor(opts, async (actor) => {
      if (opts.scroll !== undefined && opts.scroll !== 'up' && opts.scroll !== 'down') return { exitCode: 1, message: 'pty mouse: --scroll must be up or down' };
      if (opts.button !== 'left' && opts.button !== 'middle' && opts.button !== 'right') return { exitCode: 1, message: 'pty mouse: --button must be left, middle or right' };
      const input: PtyMouseInput = { x: Number(x), y: Number(y), button: opts.button, kind: opts.scroll ? `scroll-${opts.scroll}` as 'scroll-up' | 'scroll-down' : 'click' };
      try { encodeSgrMouse(input); } catch (error) { return { exitCode: 1, message: `pty mouse: ${(error as Error).message}` }; }
      const remote = opts.remote ?? (opts.r === true ? true : undefined);
      if (remote !== undefined && actor === 'agent') return { exitCode: 1, message: 'pty mouse: remote HTTP cannot verify same-run agent ownership; use the owner IPC instead' };
      return remote === undefined ? runPtyMouse(id, input, deps, actor) : runPtyRemoteControl('mouse', id, remote, { action: 'input-mouse', ...input }, deps);
    })));
  pty.command('resize <ref> <cols> <rows>').option(...ACTOR_FLAG)
    .description('Resize the PTY (gated by the same access matrix as input)').action((id: string, cols: string, rows: string, opts: { actor?: string }) => run(() => withActor(opts, (actor) => runPtyResize(id, Number(cols), Number(rows), deps, actor))));
}
