// 대식세포 (macrophage) — v2 supervisor card that DELEGATES to the guardian's reaper (decision 11-27 «3 planes: guardian = infra»).
// One body only: src/guardian-agent/reaper.ts (planReap · killExact · audit) is the reaper. This card keeps the supervisor's
// subject · KPI · voice · L0 (RES) and reaps through the same functions; an orphan the guardian already reaped (its audit row,
// any actor) is never reaped again — one reaper action per target.
//
// 세 얼굴: 관측 = planReap over each host's `ps` ⊕ reaper registry (registered groups past TTL · unregistered test-universe
// orphans > 2 h) — unreadable host = KPI unknown / 판단 근거 = the guardian's pure plan ⊕ the shared audit (recent reaps) /
// 수복과 인계 = killExact (exact PID, command re-verified) ⊕ one audit row `by: MACROPHAGE` · undo = the command line.
import { hostname } from 'node:os';
import type { BodyEnv } from '../registry.js';
import type { AgentBody, Observation } from '../runtime.js';
import type { Proc, ReapCandidate, Registration } from '../../guardian-agent/reaper.js';
import { liveScrapDeps, scrapFacts, type ScrapDeps } from './macrophage-scrap.js';
import { pn } from '../policy-context.js';


export interface MacrophageDeps {
  hosts(): string[];
  procs(host: string): Proc[] | null;
  registry(host: string): Registration[];
  /** pids never to touch on this host (this process and its parents) */
  self(host: string): ReadonlySet<number>;
  plan(procs: readonly Proc[], registry: readonly Registration[], nowMs: number, self: ReadonlySet<number>): ReapCandidate[];
  /** `${host}:${pid}` reaped within policy recent_reap_min (shared reaper audit · any actor) */
  recentReaps(nowMs: number): ReadonlySet<string>;
  kill(host: string, cand: ReapCandidate): { killed: number[]; skipped: number[] };
  audit(row: Record<string, unknown>): void;
  /** the shared reaper lock (guardian-agent/reaper.ts withReapLock) — recent-check → kill → audit run inside it */
  lock<T>(fn: () => T): T;
  /** report-only scrap readers (launchd one-shots · past cron · stale worktrees · old stashes) — absent = not observed */
  scrap?: ScrapDeps | null;
}

const key = (host: string, pid: number): string => `${host}:${pid}`;

export function createBody(env: BodyEnv, deps: MacrophageDeps = liveDeps(env.stateRoot)): AgentBody {
  const candidates = (now: Date): { list: Array<{ host: string; c: ReapCandidate }>; unread: string[] } => {
    const list: Array<{ host: string; c: ReapCandidate }> = []; const unread: string[] = [];
    for (const host of deps.hosts()) {
      const procs = deps.procs(host);
      if (!procs) { unread.push(host); continue; }
      for (const c of deps.plan(procs, deps.registry(host), now.getTime(), deps.self(host))) list.push({ host, c });
    }
    return { list, unread };
  };
  return {
    observe(ctx): Observation {
      const { list, unread } = candidates(ctx.now);
      const recent = deps.recentReaps(ctx.now.getTime());
      const open = list.filter(x => !recent.has(key(x.host, x.c.pid)));
      return {
        // any unreadable host = KPI unknown (Terra #40447 must-fix 5): a count from the readable hosts would read the unseen one as clean
        kpi: unread.length ? null : open.length,
        subjects: open.map(x => ({ id: key(x.host, x.c.pid), kind: 'orphan', summary: `${x.c.why} · ${x.c.command.slice(0, 80)}`, ageMin: x.c.ageMs / 60_000 })),
        facts: [`reaper plan ${list.length} · already reaped ${list.length - open.length}${unread.length ? ` · unreadable ${unread.join(',')} → KPI 모름` : ''} · body = guardian reaper`,
          ...(deps.scrap ? scrapFacts(deps.scrap, ctx.now.getTime()) : [])],
        patterns: open.length >= 3 ? [{ key: `orphans@${open[0]!.host}`, lesson: `${open[0]!.host} 에서 고아 ${open.length} — 띄운 쪽(시험 우주 런처)이 reaper 등록(registerTestUniverse)을 하는지 본다.` }] : [],
      };
    },
    plan: (obs) => obs.subjects.map(s => ({ action: 'reap', target: s.id, why: s.summary })),
    actions: {
      reap: {
        describe: '수호자 reaper 로 고아 하나를 정확 PID 로 거둔다(명령 재확인 · 감사 한 줄) · 되돌림 = 원 명령 재실행',
        run(target, ctx) {
          const [host, pidText] = [target.slice(0, target.lastIndexOf(':')), target.slice(target.lastIndexOf(':') + 1)];
          const pid = Number(pidText);
          // one reaper action per target: the guardian takes the same lock around its kill ⊕ audit
          return deps.lock(() => {
            if (deps.recentReaps(ctx.now.getTime()).has(key(host, pid))) return { ok: true, line: `${target} 이미 거둠(수호자 감사) — 다시 하지 않는다` };
            const found = candidates(ctx.now).list.find(x => x.host === host && x.c.pid === pid);
            if (!found) return { ok: false, line: `${target} 은 더 이상 reaper 대상이 아니다(사라짐 · 바뀜)` };
            const r = deps.kill(host, found.c);
            if (!r.killed.includes(pid)) return { ok: false, line: `${target} 안 거둠(명령 불일치 · 이미 없음)` };
            deps.audit({ at: ctx.now.toISOString(), host, pid, pgid: found.c.pgid, why: found.c.why, command: found.c.command.slice(0, 120), by: env.card.address });
            return { ok: true, line: `${target} 거둠 (${found.c.why})`, ref: `reap:${target}`, undo: found.c.command.slice(0, 200) };
          });
        },
      },
    },
  };
}

export function liveDeps(stateRoot: string): MacrophageDeps {
  const reaper = (): typeof import('../../guardian-agent/reaper.js') => require('../../guardian-agent/reaper.js') as typeof import('../../guardian-agent/reaper.js');
  const local = hostname().split('.')[0]!.toLowerCase();
  return {
    hosts: () => [local],
    procs: (host) => { try { return reaper().listProcs(host); } catch { return null; } },
    registry: (host) => { try { return host === local ? reaper().readLocalRegistry(stateRoot) : reaper().remoteRegistry(host); } catch { return []; } },
    self: () => new Set([process.pid, process.ppid]),
    plan: (procs, registry, nowMs, self) => reaper().planReap(procs, registry, nowMs, { self }),
    // the whole time window (not a line count): every audit row newer than recent_reap_min, whoever wrote it
    recentReaps: (nowMs) => reaper().recentReaps(stateRoot, nowMs, pn('recent_reap_min') * 60_000),
    kill: (host, cand) => reaper().killExact(host, [cand]),
    audit: (row) => reaper().auditReap(stateRoot, row),
    lock: (fn) => reaper().withReapLock(stateRoot, fn),
    scrap: liveScrapDeps(),
  };
}
