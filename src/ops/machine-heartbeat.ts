import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CardStore } from '../task-cards/card-store.js';
import { debug, redactSecretText } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { recordRunExit, readRunExits } from '../harness/harness-incidents.js';
import { notifyOwners } from '../loops/checker.js';
import { bunVersion, cliFingerprint, gcTools, orphanCandidates, type FenceGcDeps } from '../hq/fence.js';

export interface MachineHeartbeatDeps extends FenceGcDeps {
  root?: string;
  now?: Date;
  record?: typeof recordRunExit;
  log?: typeof debug.log;
  publish?: typeof notifyOwners;
  card?: (command: string, day: string, evidencePaths: string[], root: string) => void;
  version?: (pid: number, run: (binary: string, args: string[]) => string) => string;
  /** How long the same tree must stay at the same CPU across guardian ticks before it is called stalled. */
  stallMs?: number;
  /** off = collect nothing · shadow (default) = candidates, evidence file and observation only · on = evidence, then SIGTERM. */
  mode?: OrphanGcMode;
}

export type OrphanGcMode = 'off' | 'shadow' | 'on';

/** A tree is «stalled» only when an earlier tick saw the very same tree at the very same CPU this long ago.
 *  One in-tick second is not enough: Linux `ps time` has whole-second resolution and I/O waits burn no CPU. */
export const ORPHAN_STALL_MS = 10 * 60_000;
/** `shadowEvidenced`: shadow already wrote this tree's evidence once — later shadow ticks skip it (no lsof/sample, no new file). */
type StallWatch = Record<string, { since: string; cpu: number; tree: string; shadowEvidenced?: true }>;

function readStallWatch(path: string): StallWatch {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StallWatch : {};
}

/** One cause card per command/day, with incident files as attachments in the incidents section. */
export function publishOrphanCauseCard(command: string, day: string, paths: string[], root: string): void {
  const store = new CardStore(root);
  try {
    const hash = createHash('sha256').update(command).digest('hex').slice(0, 24);
    const card = store.createCard({ goalId: `orphan-cli-${day}-${hash}`, title: `TC 원인 조사: ${redactSecretText(command)}` });
    for (const path of paths) store.appendSection(card.id, { key: `incidents:${basename(path).replaceAll('.', '-')}`, owner: 'TC',
      content: `증거: incidents/${basename(path)}\n가설(미확정): bun fs.watch 등 상주 핸들이 CLI 종료를 막음` });
  } finally { store.close(); }
}

/** Run on the local guardian tick; an observation failure never authorizes termination. */
export async function runMachineHeartbeat(schedules: readonly { command: string; cron: string }[], deps: MachineHeartbeatDeps = {}): Promise<{ collected: number; terminated: number; cards: number }> {
  const mode = deps.mode ?? 'shadow';
  if (mode === 'off') return { collected: 0, terminated: 0, cards: 0 };
  const tools = gcTools(deps);
  const now = deps.now ?? new Date();
  const root = deps.root ?? effectiveInstanceRoot();
  const timeZone = deps.timeZone;
  const stallMs = deps.stallMs ?? ORPHAN_STALL_MS;
  const watchPath = join(root, 'ops', 'orphan-cli-watch.json');
  // An unreadable watch never authorizes termination: start over and only observe this tick.
  let watch: StallWatch;
  try { watch = readStallWatch(watchPath); } catch { watch = {}; }
  const nextWatch: StallWatch = {};
  const stalled: ReturnType<typeof orphanCandidates> = [];
  const first = tools.snapshot();
  await tools.sleep(1_000);
  const second = tools.snapshot();
  let collected = 0;
  let terminated = 0;
  let cards = 0;
  let alreadyEvidenced = 0;
  const logDecision = (): void => {
    try { (deps.log ?? debug.log.bind(debug))('ops.orphan-cli', 'decision', { mode, candidates: stalled.length, collected, alreadyEvidenced, killed: terminated }); } catch { /* observe only */ }
  };
  for (const candidate of orphanCandidates(first, second, schedules, now, timeZone)) {
    const key = `${candidate.process.pid}:${candidate.process.ppid}:${candidate.process.command}`;
    const cpu = Math.round(candidate.tree.reduce((total, row) => total + row.cpuSeconds, 0) * 100) / 100;
    const tree = candidate.tree.map(row => `${row.pid}:${row.cpuSeconds}`).join(',');
    const seen = watch[key];
    const elapsed = seen ? now.getTime() - Date.parse(seen.since) : NaN;
    // Same tree, same CPU, and the process is at least as old as the watch (not a reused PID).
    if (!seen || seen.cpu !== cpu || seen.tree !== tree || !(elapsed >= 0) || candidate.process.ageSeconds * 1000 + 2_000 < elapsed) {
      nextWatch[key] = { since: now.toISOString(), cpu, tree };
      continue;
    }
    nextWatch[key] = seen;
    if (elapsed < stallMs) continue;
    // Shadow never ends the tree, so the same hang stays stalled: evidence it once, not on every tick.
    if (mode !== 'on' && seen.shadowEvidenced) { alreadyEvidenced++; continue; }
    stalled.push(candidate);
  }
  try {
    mkdirSync(join(root, 'ops'), { recursive: true });
    const tmp = `${watchPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(nextWatch), { mode: 0o600 });
    renameSync(tmp, watchPath);
  } catch (error) {
    // Without a durable watch the next tick cannot prove a stall either — observe only.
    try { (deps.log ?? debug.log.bind(debug))('ops.orphan-cli', 'observation-failed', { stage: 'stall-watch', error: redactSecretText(String(error)) }); } catch { /* observe only */ }
    logDecision();
    return { collected, terminated, cards };
  }
  const writeWatch = (): void => {
    mkdirSync(join(root, 'ops'), { recursive: true });
    const tmp = `${watchPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(nextWatch), { mode: 0o600 });
    renameSync(tmp, watchPath);
  };
  let shadowMarked = false;
  for (const candidate of stalled) {
    // Recheck the whole tree after slow diagnostics. A new child or CPU progress invalidates the decision.
    let evidence: { command: string; ageSeconds: number; periodMinutes: number; pid: number; tree: number[]; lsof: string; sample: string; bunVersion: string; at: string };
    try {
      evidence = {
        command: candidate.process.command, ageSeconds: candidate.process.ageSeconds, periodMinutes: candidate.periodMinutes, pid: candidate.process.pid,
        tree: candidate.tree.map(row => row.pid),
        lsof: tools.run('lsof', ['-p', candidate.tree.map(row => row.pid).join(',')]),
        sample: tools.run('sample', [String(candidate.process.pid), '1']),
        bunVersion: (deps.version ?? bunVersion)(candidate.process.pid, tools.run), at: now.toISOString(),
      };
      const latest = tools.snapshot();
      const found = orphanCandidates(second, latest, schedules, now, timeZone).find(row => row.process.pid === candidate.process.pid);
      if (!found || found.tree.length !== candidate.tree.length || found.tree.some(row => !candidate.tree.some(old => old.pid === row.pid))) continue;
      // File + existing incident ledger + logs are committed before any signal is delivered.
      const path = join(root, 'incidents', `orphan-cli-${now.getTime()}-${candidate.process.pid}-${randomUUID().slice(0, 8)}.json`);
      mkdirSync(join(root, 'incidents'), { recursive: true });
      const safe = JSON.stringify(evidence, (_key, value) => typeof value === 'string' ? redactSecretText(value) : value);
      writeFileSync(path, safe, { flag: 'wx', mode: 0o600 });
      const fingerprint = redactSecretText(cliFingerprint(candidate.process.command));
      (deps.log ?? debug.log.bind(debug))('ops.orphan-cli', mode === 'on' ? 'evidence-before-termination' : 'shadow-evidence', {
        path, command: redactSecretText(evidence.command), ageSeconds: evidence.ageSeconds, periodMinutes: evidence.periodMinutes, pid: evidence.pid,
        tree: evidence.tree, lsof: redactSecretText(evidence.lsof), sample: redactSecretText(evidence.sample), bunVersion: evidence.bunVersion,
      });
      collected++;
      if (mode !== 'on') {
        const key = `${candidate.process.pid}:${candidate.process.ppid}:${candidate.process.command}`;
        if (nextWatch[key]) { nextWatch[key] = { ...nextWatch[key]!, shadowEvidenced: true }; shadowMarked = true; }
        continue;
      }
      // Children first: do not leave the stuck parent holding resources while descendants outlive it.
      const signalFailures: Array<{ pid: number; error: string }> = [];
      for (const row of [...found.tree].reverse()) {
        try { tools.kill(row.pid); } catch (error) { signalFailures.push({ pid: row.pid, error: redactSecretText(String(error)) }); }
      }
      // The run-exit row records what the signals actually did, written after they were sent: SIGTERM only when every
      // signal landed, otherwise no signal and the failures beside the evidence path. The evidence file and log above
      // were committed before any signal. Either way the hang counts toward the cause card below.
      (deps.record ?? recordRunExit)({ runId: `orphan-cli-${candidate.process.pid}-${randomUUID()}`, reason: `orphan-cli:${fingerprint}`, status: null,
        signal: signalFailures.length === 0 ? 'SIGTERM' : null, at: now.toISOString(), pid: candidate.process.pid, entrance: 'guardian-tick',
        lastLines: [path, ...signalFailures.map((failure) => `termination-failed pid=${failure.pid}: ${failure.error}`)] }, root);
      if (signalFailures.length > 0) {
        (deps.log ?? debug.log.bind(debug))('ops.orphan-cli', 'termination-failed', { path, pid: candidate.process.pid, failures: signalFailures });
      } else terminated++;
      const day = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
      // One hang is one process: the same PID recorded on several ticks (its SIGTERM did not take) counts once.
      const byPid = new Map<number, ReturnType<typeof readRunExits>[number]>();
      for (const row of readRunExits(root)) {
        if (row.reason !== `orphan-cli:${fingerprint}` || typeof row.pid !== 'number') continue;
        if (new Date(Date.parse(row.at) + 9 * 3_600_000).toISOString().slice(0, 10) !== day) continue;
        if (!byPid.has(row.pid)) byPid.set(row.pid, row);
      }
      const same = [...byPid.values()];
      if (same.length >= 3) {
        const paths = same.flatMap(row => row.lastLines ?? []).filter(file => existsSync(file));
        if (paths.length < 3) {
          (deps.log ?? debug.log.bind(debug))('ops.orphan-cli', 'cause-card-evidence-missing', { command: redactSecretText(candidate.process.command), count: same.length, evidence: paths.length });
          continue;
        }
        const reason = `원인 카드: ${fingerprint} · 하루 ${same.length}회 매달림 · 증거 ${paths.join(' , ')} · 가설(미확정): bun fs.watch 등 상주 핸들이 CLI 종료를 막음`;
        (deps.card ?? publishOrphanCauseCard)(fingerprint, day, paths, root);
        cards += (deps.publish ?? notifyOwners)([{ id: `orphan-cli:${fingerprint}`, owner: 'TC', enabled: true, registered: true, state: 'failing', reason }], { root, now });
      }
    } catch (error) {
      try { (deps.log ?? debug.log.bind(debug))('ops.orphan-cli', 'observation-failed', { pid: candidate.process.pid, error: redactSecretText(String(error)) }); } catch { /* log failure must not kill a process */ }
    }
  }
  if (shadowMarked) {
    // A lost mark only means one more evidence file next tick — never a signal.
    try { writeWatch(); } catch (error) {
      try { (deps.log ?? debug.log.bind(debug))('ops.orphan-cli', 'observation-failed', { stage: 'shadow-mark', error: redactSecretText(String(error)) }); } catch { /* observe only */ }
    }
  }
  logDecision();
  return { collected, terminated, cards };
}
