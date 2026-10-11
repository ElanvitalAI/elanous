import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { launchBindingRunIds, launchRegistryDir, readLaunchBinding } from '../harness/launch-registry.js';
import { launchStampFromLedger } from '../harness/launch-stamp.js';
import { normalizeRunId } from '../harness/harness-space.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { TASK_SEATS, updateTaskCard, type TaskCard, type TaskSeat } from './task-hand.js';

export interface RunBirth {
  runId: string;
  goalPath?: string;
  cwd: string;
  runsDir?: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface RunAdoptDeps {
  /** 카드 상태 파일(시험 주입). 없으면 우주 뿌리(`instanceRoot`) 아래 `task-agent-actions.json` = `taskAgentStatePath()`. */
  statePath?: string;
  /** 우주 뿌리 해석 seam — 기본 `effectiveInstanceRoot()`(state·runsDir 를 만드는 같은 공용 해석). */
  instanceRoot?: () => string;
  registryDir?: string;
  knownChecklistIds?: ReadonlySet<string>;
  now?: () => Date;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

export type RunAdoptSkipReason = 'handed' | 'already-carded' | 'pod-child' | 'other-universe' | 'universe-mismatch';
export type RunAdoptResult = { card: TaskCard; adopted: true } | { adopted: false; reason: RunAdoptSkipReason };

function seatFromGoal(path: string | undefined): TaskSeat | undefined {
  const seat = path?.replaceAll('\\', '/').match(/\/(?:seat-state|seats)\/(OP|TC|MK|UX)\//)?.[1];
  return seat as TaskSeat | undefined;
}

function goalText(path: string | undefined, cwd: string): string {
  if (!path) return '';
  try {
    const fullPath = isAbsolute(path) ? path : resolve(cwd, path);
    return readFileSync(fullPath, 'utf8');
  } catch { return ''; }
}

function checklistFromText(text: string, known: ReadonlySet<string>): string | undefined {
  const explicit = /칸\s+([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(text)?.[1];
  if (explicit) return explicit;
  const title = /(?:^|\n)제목:\s*([A-Za-z0-9][A-Za-z0-9_-]*?)-\d+\s+—/m.exec(text)?.[1];
  return title && known.has(title) ? title : undefined;
}

/** 경로 정규화 — 심볼릭 링크(`/var`↔`/private/var` 등)·상대·후행 슬래시를 같은 값으로. 없는 꼬리는 있는 조상의 실경로에 붙인다. */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let head = absolute;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return absolute;
    tail.unshift(basename(head));
    head = parent;
  }
  try { return join(realpathSync(head), ...tail); } catch { return absolute; }
}

/** Adopt only a run belonging to this universe. The universe root is resolved once (`effectiveInstanceRoot()` unless a
 *  state path is injected) and both the card state file and the run's `runsDir` are compared against it after canonical
 *  path resolution. The runId check and write share updateTaskCard's lock.
 *  A birth without `runsDir` cannot prove its universe and is skipped as `other-universe` (conservative); a `runsDir` that is
 *  not `<root>/self-dev-runs` is skipped as `universe-mismatch` with both paths observed — never silently. */
export function adoptRunCard(birth: RunBirth, deps: RunAdoptDeps = {}): RunAdoptResult {
  const root = deps.statePath ? dirname(deps.statePath) : (deps.instanceRoot ?? effectiveInstanceRoot)();
  const statePath = deps.statePath ?? join(root, 'task-agent-actions.json');
  const log = deps.log ?? ((category: string, event: string, data: Record<string, unknown>) => debug.log(category, event, data));
  const skip = (reason: RunAdoptSkipReason, extra: Record<string, unknown> = {}): RunAdoptResult => {
    log('task-agent', 'run-adopt-skipped', { runId: birth.runId, reason, ...extra });
    return { adopted: false, reason };
  };
  if (birth.env.ELANOUS_TASK_CARD_ID) return skip('handed');
  if (birth.env.ELANOUS_POD_NAME) return skip('pod-child');
  if (!birth.runsDir) return skip('other-universe', { statePath, runsDir: null });
  const expectedRunsDir = canonicalPath(join(root, 'self-dev-runs'));
  const runsDir = canonicalPath(birth.runsDir);
  if (runsDir !== expectedRunsDir) return skip('universe-mismatch', { statePath, runsDir: birth.runsDir, expectedRunsDir, canonicalRunsDir: runsDir });
  if (!birth.runId || birth.runId !== normalizeRunId(birth.runId) || birth.runId.includes(sep)) throw new Error(`invalid runId: ${birth.runId}`);
  const text = goalText(birth.goalPath, birth.cwd);
  const firstLine = text.split(/\r?\n/).find(line => line.trim())?.trim() ?? `harness run ${birth.runId}`;
  let stamp = launchStampFromLedger(null);
  try { stamp = launchStampFromLedger(loadRunLedger(birth.runId, runLedgerDir(root))); } catch { /* unreadable stamp is unknown */ }
  const origin = stamp.entrance;
  const actor = stamp.actor;
  const seat = TASK_SEATS.find(candidate => candidate === actor) ?? seatFromGoal(birth.goalPath);
  const checklistId = checklistFromText(text, deps.knownChecklistIds ?? new Set());
  const id = `ta-${birth.runId}`;
  let adopted = false;
  const card = updateTaskCard(statePath, id, (current, tasks) => {
    if (current || Object.values(tasks).some(candidate => candidate.runId === birth.runId)) return undefined;
    adopted = true;
    const at = (deps.now ?? (() => new Date()))().toISOString();
    return {
      id, text: firstLine, status: 'launched', runId: birth.runId,
      ...(birth.goalPath ? { goal: birth.goalPath } : {}),
      ...(seat ? { seat } : {}),
      ...(checklistId ? { checklistId } : {}),
      createdAt: at, history: [{ at, event: 'adopted', detail: origin }],
    };
  });
  if (!adopted || !card) return skip('already-carded');
  log('task-agent', 'run-adopted', { card: card.id, runId: birth.runId, origin, seat: seat ?? null, checklistId: checklistId ?? null });
  return { card, adopted: true };
}

/** Explicit backfill for old launch bindings (`elanous tasks adopt-runs`); not part of the launch-time path.
 *  The binding's launch-time `podName`/`taskCardId` stand in for the env, so Pod children and handed runs are skipped.
 *  Bindings written before those fields existed carry no marker — the host registry is per-host `$TMPDIR`, and a Pod
 *  child writes its binding inside its Pod, so such legacy rows are host-launched runs. */
export function adoptUncardedRuns(deps: RunAdoptDeps = {}): { scanned: number; adopted: number; skipped: Partial<Record<RunAdoptSkipReason, number>> } {
  const dir = deps.registryDir ?? launchRegistryDir();
  const skipped: Partial<Record<RunAdoptSkipReason, number>> = {};
  let scanned = 0;
  let adopted = 0;
  for (const runId of launchBindingRunIds(dir)) {
    scanned++;
    const binding = readLaunchBinding(runId, dir);
    if (!binding?.runsDir) {
      skipped['other-universe'] = (skipped['other-universe'] ?? 0) + 1;
      (deps.log ?? ((category, event, data) => debug.log(category, event, data)))('task-agent', 'run-adopt-skipped', { runId, reason: 'other-universe' });
      continue;
    }
    const result = adoptRunCard({ runId, cwd: binding.cwd, goalPath: binding.goalPath, runsDir: binding.runsDir, env: { ELANOUS_POD_NAME: binding.podName, ELANOUS_TASK_CARD_ID: binding.taskCardId } }, deps);
    if (result.adopted) adopted++;
    else skipped[result.reason] = (skipped[result.reason] ?? 0) + 1;
  }
  return { scanned, adopted, skipped };
}
