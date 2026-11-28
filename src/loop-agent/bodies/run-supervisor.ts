// run-supervisor (런 슈퍼바이저 · L0 TC) — LOOP-AGENT v2 body. Stage 1 of the run lifecycle (detect → diagnose → autopsy).
//
// 세 얼굴:
//   관측 = live pregate launchers (RES inflight locks `<head12>-<light|full>.lock` = `<pid> <host> <token>` · the pid is the
//          local launcher) ⊕ open harness/graph runs (run-ledger with a `start` and no terminal line). KPI zombie_runs =
//          pregate launchers alive past pregate_zombie_min ⊕ open runs silent past run_zombie_min (null when either source
//          cannot be read). Stalled-but-not-zombie runs are subjects only (watch).
//   판단 근거 = thresholds from the evidence (GREEN p99 ≈ 18 min · max 47 · changed-tsc self-timeout ≈ 28 min → 90 min is
//          beyond any real pregate) ⊕ T-cell no-progress rule (30 min stalled) ⊕ the card's rights/cooldown.
//   수복과 인계 = least invasive real action first: an open run is closed with one `stop` line (append-only, STOP-AUTOHEAL
//          reads it); a zombie pregate launcher is ended by EXACT PID only after re-reading its command line (pregate.py ⊕
//          head12) and age — never by pattern; its argv is kept so `relaunch-pregate` restores it once (undo = relaunch).
//          What the body cannot close stays a KPI breach → one card to TC.
import { join } from 'node:path';
import type { BodyEnv } from '../registry.js';
import type { ActionResult, AgentBody, BodyCtx, Observation, PlannedAction, Subject } from '../runtime.js';
import { agentHome } from '../memory.js';
import { readJsonlFile, readProcess, scanRunLedgers, seatStateRoot } from './run-lifecycle-shared.js';
import { pn } from '../policy-context.js';

/** RUN-SUP-STALE-RECORD-CLOSE: a pregate record (inflight lock) at least this old whose pid is gone, <defunct> or no longer
 *  the launcher is a dead record — closed (moved aside), never killed, never retried. */

export interface PregateJob { readonly id: string; readonly pid: number; readonly host: string; readonly ageMin: number; readonly alive: boolean }
export interface OpenRun { readonly runId: string; readonly graphId: string; readonly startedAt: string; readonly lastAt: string; readonly idleMin: number; readonly stage: string | null }
export interface KilledPregate { readonly id: string; readonly pid: number; readonly host: string; readonly argv: readonly string[]; readonly at: string; readonly relaunched?: string }

export interface RunSupervisorDeps {
  /** Pregate launchers by inflight lock (null = unknown). */
  pregateJobs(now: Date): PregateJob[] | null;
  /** Runs with a start and no terminal line, touched inside run_window_h (null = unknown). */
  openRuns(now: Date): OpenRun[] | null;
  /** Re-read one exact process (command line ⊕ elapsed seconds) — null = gone. */
  proc(pid: number): { cmd: string; elapsedSec: number } | null;
  /** SIGTERM one exact pid. */
  kill(pid: number): boolean;
  /** Append one `stop` line to a run ledger (append-only · once per run). */
  closeRun(runId: string, cause: string, evidenceRef: string): { ok: boolean; line: string };
  /** Start a detached pregate with this argv (argv[0] = the pregate launcher). */
  relaunch(argv: readonly string[]): { ok: boolean; pid?: number; line: string };
  killed(): KilledPregate[];
  recordKilled(k: KilledPregate): void;
  markRelaunched(id: string, at: string): void;
  /** RUN-SUP-STALE-RECORD-CLOSE: close a dead pregate record (move its inflight lock aside · undo = move it back). */
  closeRecord(id: string, why: string): { ok: boolean; line: string; undo?: string };
}

/** argv after `pregate.py` in a launcher command line → a relaunch argv through the stable `pregate` wrapper. */
export function relaunchArgv(cmd: string, pregateBin: string): string[] | null {
  const parts = cmd.split(/\s+/u).filter(Boolean);
  const i = parts.findIndex(p => /(^|\/)pregate(\.py)?$/u.test(p));
  if (i < 0) return null;
  const rest = parts.slice(i + 1);
  if (!rest.length || rest.includes('--worker')) return null; // worker processes are remote halves, never relaunched from here
  return [pregateBin, ...rest];
}

export function liveDeps(stateRoot: string): RunSupervisorDeps {
  const seat = seatStateRoot();
  const inflight = process.env.RES_INFLIGHT_DIR ?? join(seat, 'RES', 'inflight');
  const home = agentHome(stateRoot, 'run-supervisor');
  const killedPath = join(home, 'killed.jsonl');
  const fs = require('node:fs') as typeof import('node:fs');
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
  return {
    pregateJobs(now) {
      let names: string[];
      try { names = fs.readdirSync(inflight).filter(n => n.endsWith('.lock')); } catch { return null; }
      const out: PregateJob[] = [];
      for (const name of names) {
        try {
          const p = join(inflight, name);
          const [pidText, host] = fs.readFileSync(p, 'utf8').trim().split(/\s+/u);
          const pid = Number(pidText);
          if (!Number.isSafeInteger(pid) || pid <= 1) continue;
          out.push({ id: name.slice(0, -'.lock'.length), pid, host: host ?? '-', ageMin: (now.getTime() - fs.statSync(p).mtimeMs) / 60_000, alive: alive(pid) });
        } catch { /* raced with the launcher's own release */ }
      }
      return out;
    },
    openRuns(now) {
      const runs = scanRunLedgers(join(stateRoot, 'run-ledger'), now.getTime() - pn('run_window_h') * 3_600_000);
      if (!runs) return null;
      return runs.filter(r => r.startedAt && !r.terminal).map(r => ({ runId: r.runId, graphId: r.graphId, startedAt: r.startedAt!, lastAt: r.lastAt,
        idleMin: (now.getTime() - Date.parse(r.lastAt)) / 60_000, stage: r.stage }));
    },
    proc: readProcess,
    kill(pid) { try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; } },
    closeRun(runId, cause, evidenceRef) {
      try {
        const { recordRunStop, appendRunStopEntryOnce } = require('../../self-implement/run-stop.js') as typeof import('../../self-implement/run-stop.js');
        const dir = join(stateRoot, 'run-ledger');
        const e = recordRunStop({ runId, class: 'unclassified', site: 'run-supervisor:no-progress', cause, evidenceRef,
          nextMove: 'Read the ledger tail; relaunch the card (eln tasks doctor) or harvest what it left' }, entry => appendRunStopEntryOnce(entry, dir));
        return { ok: true, line: `${runId} stop 줄 (${String(e.data.cause ?? cause)})` };
      } catch (err) { return { ok: false, line: `${runId} stop 쓰기 실패 — ${err instanceof Error ? err.message : String(err)}` }; }
    },
    relaunch(argv) {
      try {
        const { spawn } = require('node:child_process') as typeof import('node:child_process');
        const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' });
        child.unref();
        return child.pid ? { ok: true, pid: child.pid, line: `재발사 pid ${child.pid}: ${argv.slice(1).join(' ')}` } : { ok: false, line: 'spawn 이 pid 를 주지 않음' };
      } catch (err) { return { ok: false, line: `재발사 실패 — ${err instanceof Error ? err.message : String(err)}` }; }
    },
    killed() {
      const rows = readJsonlFile<KilledPregate & { relaunchOf?: string }>(killedPath);
      const relaunched = new Map(rows.filter(r => r.relaunchOf).map(r => [r.relaunchOf!, r.at] as const));
      return rows.filter(r => !r.relaunchOf).map(r => (relaunched.has(r.id) ? { ...r, relaunched: relaunched.get(r.id)! } : r));
    },
    recordKilled(k) { fs.mkdirSync(home, { recursive: true }); fs.appendFileSync(killedPath, `${JSON.stringify(k)}\n`); },
    markRelaunched(id, at) { fs.mkdirSync(home, { recursive: true }); fs.appendFileSync(killedPath, `${JSON.stringify({ relaunchOf: id, at })}\n`); },
    closeRecord(id, why) {
      const src = join(inflight, `${id}.lock`);
      const dst = join(inflight, 'closed-stale', `${id}.lock`);
      try {
        if (!fs.existsSync(src)) return { ok: false, line: `${id}: 기록 파일이 이미 없다` };
        fs.mkdirSync(join(inflight, 'closed-stale'), { recursive: true });
        fs.renameSync(src, dst);
        fs.mkdirSync(home, { recursive: true });
        fs.appendFileSync(join(home, 'closed-records.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), id, why, from: src, to: dst })}\n`);
        return { ok: true, line: `${id} 기록 닫음 → ${dst}`, undo: `mv '${dst}' '${src}'` };
      } catch (err) { return { ok: false, line: `${id}: 기록 닫기 실패 — ${err instanceof Error ? err.message : String(err)}` }; }
    },
  };
}

const head12 = (jobId: string): string => jobId.split('-')[0] ?? jobId;

/** A live pregate launcher's command line: `pregate[.py] …`, not a remote worker half, not a reaped-later `<defunct>` entry.
 *  SUPERVISOR-JOURNAL-DEFECTS (11-27): stale inflight locks pointed at `<defunct>` pids (children an eln session never
 *  reaped) — `kill -0` says alive, the launcher is long gone; end-zombie-pregate refused them 21× («명령줄이 pregate 런처가
 *  아니다»). Such a lock is dead, not a zombie run. */
export const isDefunct = (cmd: string): boolean => /<defunct>|\(defunct\)/u.test(cmd);
export function isPregateLauncher(cmd: string): boolean {
  return /pregate(\.py)?\b/u.test(cmd) && !cmd.includes('--worker') && !isDefunct(cmd);
}

export function createBody(env: BodyEnv, deps: RunSupervisorDeps = liveDeps(env.stateRoot)): AgentBody {
  const pregateBin = join(seatStateRoot(), 'RES', 'tools', 'pregate');
  const observe = (ctx: BodyCtx): Observation => {
    const now = ctx.now;
    const jobs = deps.pregateJobs(now);
    const runs = deps.openRuns(now);
    const subjects: Subject[] = []; const facts: string[] = []; const patterns: { key: string; lesson: string }[] = [];
    let zombies = 0;
    if (jobs) {
      // RUN-SUP-STALE-RECORD-CLOSE: a record past stale_record_min whose pid is gone, <defunct> or no longer the launcher
      // (pid reused) is a DEAD RECORD — not a zombie run; it is closed once (moved aside, no kill) and never retried.
      const staleMin = pn('stale_record_min');
      const zombieMin = pn('pregate_zombie_min');
      const why = (j: PregateJob): string | null => {
        if (j.ageMin < staleMin) return null;
        if (!j.alive) return 'pid 없음';
        const p = deps.proc(j.pid);
        if (!p) return 'pid 사라짐';
        if (isDefunct(p.cmd)) return 'pid <defunct>';
        return isPregateLauncher(p.cmd) ? null : 'pid 재사용(명령줄이 런처 아님)';
      };
      const stale: Array<{ j: PregateJob; why: string }> = [];
      for (const j of jobs) { const w = why(j); if (w) stale.push({ j, why: w }); }
      const staleIds = new Set(stale.map(x => x.j.id));
      const live = jobs.filter(j => j.alive && !staleIds.has(j.id));
      facts.push(`pregate 도는 중 ${live.length} · 죽은 pid 잠금 ${jobs.filter(j => !j.alive).length}(pregate 가 다음 획득 때 회수)${stale.length ? ` · 닫을 낡은 기록 ${stale.length}(${stale.slice(0, 3).map(x => `${head12(x.j.id)} ${x.why}`).join(' · ')}) — 좀비 런으로 세지 않음` : ''}`);
      for (const { j, why: w } of stale) subjects.push({ id: `pregate:${j.id}`, kind: 'pregate-stale-record', summary: `${w} · pid ${j.pid} @${j.host} ${Math.round(j.ageMin)}분 된 기록`, ageMin: j.ageMin });
      for (const j of live) {
        if (j.ageMin >= zombieMin) {
          zombies += 1;
          subjects.push({ id: `pregate:${j.id}`, kind: 'pregate-zombie', summary: `pid ${j.pid} @${j.host} ${Math.round(j.ageMin)}분 (상한 ${zombieMin})`, ageMin: j.ageMin });
          if (!ctx.state.acted[`end-zombie-pregate:pregate:${j.id}`]) patterns.push({ key: `pregate-zombie@${j.host}`, lesson: `${j.host} 의 pregate 가 ${zombieMin}분 넘게 끝나지 않는 일이 반복된다 — 그 호스트 부하·heavy-slot 대기를 먼저 보고 배정을 줄인다.` });
        }
      }
    } else facts.push('pregate 잠금 읽기 실패(모름)');
    if (runs) {
      facts.push(`열린 런 ${runs.length} (창 ${pn('run_window_h')}h)`);
      for (const r of runs) {
        if (r.idleMin >= pn('run_zombie_min')) {
          zombies += 1;
          subjects.push({ id: `run:${r.runId}`, kind: 'run-zombie', summary: `${r.graphId}${r.stage ? `/${r.stage}` : ''} 마지막 사건 ${Math.round(r.idleMin)}분 전 · 종결 줄 없음`, ageMin: r.idleMin });
          if (!ctx.state.acted[`close-zombie-run:run:${r.runId}`]) patterns.push({ key: `run-zombie@${r.graphId}`, lesson: `${r.graphId} 런이 종결 줄 없이 멈추는 일이 반복된다 — 그 그래프의 종료 경로(stop/run-status 기록)를 고치는 칸이 필요하다.` });
        } else if (r.idleMin >= pn('run_stall_min')) {
          subjects.push({ id: `run:${r.runId}`, kind: 'run-stalled', summary: `${r.graphId} ${Math.round(r.idleMin)}분 진전 없음 (좀비 판정 ${pn('run_zombie_min')}분)`, ageMin: r.idleMin });
        }
      }
    } else facts.push('런 원장 읽기 실패(모름)');
    for (const k of deps.killed()) {
      if (k.relaunched) continue;
      subjects.push({ id: `relaunch:${k.id}`, kind: 'pregate-relaunch', summary: `${k.at.slice(5, 16)} 종료한 pregate ${k.id}@${k.host} 재발사 대기`, ageMin: (now.getTime() - Date.parse(k.at)) / 60_000 });
    }
    return { kpi: jobs && runs ? zombies : null, subjects, facts, patterns };
  };

  const plan = (obs: Observation): PlannedAction[] => {
    const out: PlannedAction[] = [];
    for (const s of obs.subjects) {
      if (s.kind === 'run-zombie') out.push({ action: 'close-zombie-run', target: s.id, why: `${s.summary} — 원장을 닫아 수확·재발사로 넘긴다` });
      else if (s.kind === 'pregate-zombie') out.push({ action: 'end-zombie-pregate', target: s.id, why: s.summary });
      else if (s.kind === 'pregate-stale-record') out.push({ action: 'end-zombie-pregate', target: s.id, why: `낡은 기록 닫기 — ${s.summary}` });
      else if (s.kind === 'pregate-relaunch') out.push({ action: 'relaunch-pregate', target: s.id, why: s.summary });
    }
    // least invasive first: ledger close → relaunch (restores) → kill
    const rank: Record<string, number> = { 'close-zombie-run': 0, 'relaunch-pregate': 1, 'end-zombie-pregate': 2 };
    return out.sort((a, b) => (rank[a.action] ?? 9) - (rank[b.action] ?? 9));
  };

  const actions: AgentBody['actions'] = {
    'close-zombie-run': {
      describe: `종결 줄 없이 ‹run_zombie_min›분 넘게 멈춘 런 원장에 stop 한 줄(class unclassified · site run-supervisor:no-progress)을 더한다 — 되돌림: 카드 재발사`,
      run(target, ctx): ActionResult {
        const runId = target.replace(/^run:/u, '');
        const runs = deps.openRuns(ctx.now);
        const r = runs?.find(x => x.runId === runId);
        if (!r) return { ok: false, line: `${runId}: 다시 읽으니 열린 런이 아니다(이미 종결 또는 모름)` };
        if (r.idleMin < pn('run_zombie_min')) return { ok: false, line: `${runId}: 다시 읽으니 ${Math.round(r.idleMin)}분 전 사건 — 좀비 아님` };
        const res = deps.closeRun(runId, `no progress ${Math.round(r.idleMin)}m · no terminal line`, `run-ledger:${runId}:${r.lastAt}`);
        return { ...res, ref: `run:${runId}`, undo: `카드 재발사(eln tasks doctor <card> → relaunch) — stop 줄은 append-only` };
      },
    },
    'end-zombie-pregate': {
      describe: `‹pregate_zombie_min›분 넘게 끝나지 않은 pregate 런처를 정확 PID 로 끝낸다(명령줄 pregate.py ⊕ head12 ⊕ 나이 재확인 뒤 SIGTERM) — 되돌림: 같은 argv 재발사 · 뒤에 런처가 없는 낡은 기록(pid 없음·defunct·재사용)은 kill 없이 기록만 닫는다(closed-stale-record · 되돌림: 기록을 제자리로)`,
      run(target, ctx): ActionResult {
        const id = target.replace(/^pregate:/u, '');
        const job = deps.pregateJobs(ctx.now)?.find(j => j.id === id);
        if (!job) return { ok: false, line: `${id}: 다시 읽으니 기록이 없다(이미 회수·닫힘)` };
        const p = job.alive ? deps.proc(job.pid) : null;
        // RUN-SUP-STALE-RECORD-CLOSE: no launcher behind an old record (pid gone · <defunct> · reused) → close the record
        // (moved aside · no kill) — an action, not a failure, and the record is gone so it is never retried
        if (!p || !isPregateLauncher(p.cmd)) {
          const what = !job.alive ? 'pid 없음' : !p ? 'pid 사라짐' : isDefunct(p.cmd) ? 'pid <defunct>' : 'pid 재사용(명령줄이 런처 아님)';
          if (job.ageMin < pn('stale_record_min')) return { ok: false, line: `${id}: ${what} · 기록 ${Math.round(job.ageMin)}분 — 아직 닫을 나이 아님(${pn('stale_record_min')}분)` };
          const r = deps.closeRecord(id, `${what} · ${Math.round(job.ageMin)}분`);
          if (!r.ok) return { ok: false, line: r.line };
          return { ok: true, line: `closed-stale-record ${head12(id)} @${job.host}: ${what} · ${Math.round(job.ageMin)}분 된 기록을 닫음(kill 없음)`, ref: `record:${id}`, after: 'closed-stale-record', ...(r.undo ? { undo: r.undo } : {}) };
        }
        if (p.elapsedSec / 60 < pn('pregate_zombie_min')) return { ok: false, line: `${id}: pid ${job.pid} 나이 ${Math.round(p.elapsedSec / 60)}분 — 좀비 아님(pid 재사용 의심)` };
        const argv = relaunchArgv(p.cmd, pregateBin);
        if (!argv) return { ok: false, line: `${id}: 재발사 argv 를 만들 수 없어 끝내지 않는다(되돌림 없는 종료 금지)` };
        // last re-check immediately before the signal: same pid, same command line
        const again = deps.proc(job.pid);
        if (!again || again.cmd !== p.cmd) return { ok: false, line: `${id}: 직전 재확인에서 pid ${job.pid} 가 바뀌었다` };
        if (!deps.kill(job.pid)) return { ok: false, line: `${id}: pid ${job.pid} SIGTERM 실패` };
        // one relaunch per head: a second zombie of an already-relaunched pregate is ended but not relaunched again
        const second = deps.killed().some(x => x.id === id && x.relaunched);
        deps.recordKilled({ id, pid: job.pid, host: job.host, argv, at: ctx.now.toISOString(), ...(second ? { relaunched: 'second-zombie-no-relaunch' } : {}) });
        return { ok: true, line: `pregate ${head12(id)} @${job.host} pid ${job.pid} 종료(${Math.round(p.elapsedSec / 60)}분)`, ref: `pid:${job.pid}`, undo: `재발사: ${argv.join(' ')}` };
      },
    },
    // LOOP-AGENT-V3-SMART-2: the plan's fallback for end-zombie-pregate once a knowhow line says it keeps failing on a kind of
    // record (agent.yaml actions[].fallback) — close the record only (no kill · no retry) when no live launcher is behind it.
    'close-stale-record': {
      describe: `런처가 뒤에 없는 pregate 기록(pid 없음·defunct·재사용)을 kill 없이 닫는다 — ‹pregate_zombie_min›분 넘은 기록만 · 런처가 살아 있으면 닫지 않는다 · 되돌림: 기록을 제자리로`,
      run(target, ctx): ActionResult {
        const id = target.replace(/^pregate:/u, '');
        const job = deps.pregateJobs(ctx.now)?.find(j => j.id === id);
        if (!job) return { ok: false, line: `${id}: 다시 읽으니 기록이 없다(이미 회수·닫힘)` };
        const p = job.alive ? deps.proc(job.pid) : null;
        if (p && isPregateLauncher(p.cmd)) return { ok: false, line: `${id}: pid ${job.pid} 런처가 살아 있다 — 낡은 기록이 아니다(닫지 않음)` };
        if (job.ageMin < pn('pregate_zombie_min')) return { ok: false, line: `${id}: 기록 ${Math.round(job.ageMin)}분 — 아직 좀비 나이 아님(${pn('pregate_zombie_min')}분)` };
        const what = !job.alive ? 'pid 없음' : !p ? 'pid 사라짐' : isDefunct(p.cmd) ? 'pid <defunct>' : 'pid 재사용(명령줄이 런처 아님)';
        const r = deps.closeRecord(id, `${what} · ${Math.round(job.ageMin)}분 · v3 fallback`);
        if (!r.ok) return { ok: false, line: r.line };
        return { ok: true, line: `closed-stale-record ${head12(id)} @${job.host}: ${what} · ${Math.round(job.ageMin)}분 된 기록을 닫음(kill 없음)`, ref: `record:${id}`, after: 'closed-stale-record', ...(r.undo ? { undo: r.undo } : {}) };
      },
    },
    'relaunch-pregate': {
      describe: '내가 끝낸 pregate 를 같은 argv 로 한 번 재발사한다(기록당 1회) — 되돌림: 새 pid 를 재확인 뒤 정확 PID 종료',
      run(target, ctx): ActionResult {
        const id = target.replace(/^relaunch:/u, '');
        const k = deps.killed().find(x => x.id === id);
        if (!k) return { ok: false, line: `${id}: 내가 끝낸 기록이 없다` };
        if (k.relaunched) return { ok: false, line: `${id}: 이미 ${k.relaunched.slice(5, 16)} 재발사함(1회 한도)` };
        if (deps.pregateJobs(ctx.now)?.some(j => j.id === id && j.alive)) { deps.markRelaunched(id, ctx.now.toISOString()); return { ok: true, line: `${id}: 다른 손이 이미 다시 돌리는 중 — 재발사 생략` }; }
        const r = deps.relaunch(k.argv);
        if (r.ok) deps.markRelaunched(id, ctx.now.toISOString());
        return { ok: r.ok, line: r.line, ...(r.pid ? { ref: `pid:${r.pid}`, undo: `pid ${r.pid} 명령줄 재확인 뒤 정확 PID 종료` } : {}) };
      },
    },
  };
  return { observe, plan, actions };
}
