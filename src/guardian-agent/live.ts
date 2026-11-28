// 수호자 — live I/O: probes and process lists over ssh (one call each, bounded), the reaper registry, the ready supply and the
// hand rows from the latest fed snapshot, and the ports onto msg / route file / audit. Every reader fails open into «unknown».
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { appendOnce } from '../msg/hand-raise-ladder.js';
import { defaultMsgStorePath, openMsgStore, type MsgStore } from '../msg/msg-store.js';
import { fileMemory } from '../judge-butler/memory.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SEAT, GUARDIAN_SUPERVISOR, type GuardianPorts, type GuardianView, type HandIn } from './body.js';
import { LOCAL_HOSTS, probeHost, type HostProbe } from './hosts.js';
import { auditReap, killExact, recentReaps, withReapLock, listProcs, readLocalRegistry, remoteRegistry, type Proc, type Registration } from './reaper.js';

/** Hosts the guardian sanitizes (HQ included — it is never a routing target, but its orphans are reaped too). */
export const SANITIZE_HOSTS = [...LOCAL_HOSTS, 'mshq'] as const;
export const routePath = (stateRoot: string): string => join(stateRoot, 'res', 'route.json');
export const ROUTE_FRESH_MS = 15 * 60_000;

/** The guardian's last routing decision when fresh (≤ 15 min) — pregate / self gate --remote read this. */
export function readRoute(stateRoot: string = effectiveInstanceRoot(), nowMs = Date.now()): string | null {
  try {
    const r = JSON.parse(readFileSync(routePath(stateRoot), 'utf8')) as { host?: string | null; at?: string };
    return r.host && r.at && nowMs - Date.parse(r.at) <= ROUTE_FRESH_MS ? r.host : null;
  } catch { return null; }
}

export interface GuardianLive { readonly view: GuardianView; readonly ports: GuardianPorts; readonly store: MsgStore; readonly stateRoot: string; close(): void }

export function guardianLive(now: Date = new Date()): GuardianLive {
  const stateRoot = effectiveInstanceRoot();
  const me = hostname().split('.')[0]!.toLowerCase();
  const probes: HostProbe[] = LOCAL_HOSTS.map(h => probeHost(h));
  const procs = new Map<string, readonly Proc[] | null>();
  const registry = new Map<string, readonly Registration[]>();
  for (const h of SANITIZE_HOSTS) {
    procs.set(h, listProcs(h));
    registry.set(h, h === me ? readLocalRegistry(stateRoot) : remoteRegistry(h));
  }
  const self = new Map<string, ReadonlySet<number>>([[me, new Set([process.pid, process.ppid])]]);
  // ready supply — yellow, unowned cells of the current board (current-board record → release.graph.version)
  let ready: GuardianView['ready'] = null;
  try {
    const { readBoardPointer } = require('../ops-dashboard/current-version.js') as typeof import('../ops-dashboard/current-version.js');
    const v = readBoardPointer();
    if (v) {
      const { listChecklist } = require('../release-loop/checklist.js') as typeof import('../release-loop/checklist.js');
      const free = listChecklist(v).items.filter(i => i.status === 'yellow' && !i.owner);
      ready = { total: free.length, p0: free.filter(i => i.priority === 'P0').length };
    }
  } catch { ready = null; }
  // hands — the latest fed snapshot's hand rows
  let hands: HandIn[] | null = null;
  try {
    const p = join(stateRoot, 'fed-state', 'snapshots', 'latest.json');
    if (existsSync(p)) {
      const snap = JSON.parse(readFileSync(p, 'utf8')) as { seats?: Array<{ seat: string; since?: string | null; hand?: { state?: string } | null }> };
      hands = (snap.seats ?? []).filter(s => s.hand).map(s => ({ seat: s.seat, host: null, state: (s.hand!.state === 'working' ? 'working' : s.hand!.state === 'idle' || s.hand!.state === 'holding' ? 'idle' : 'no-pane') as HandIn['state'],
        idleMs: s.since ? Math.max(0, now.getTime() - Date.parse(s.since)) : 0 }));
    }
  } catch { hands = null; }
  const store = openMsgStore(defaultMsgStorePath());
  const memory = fileMemory(stateRoot, { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS });
  const ports: GuardianPorts = {
    memory,
    kill: (host, cands) => killExact(host, cands),
    writeRoute: (route) => { try { mkdirSync(dirname(routePath(stateRoot)), { recursive: true }); writeFileSync(routePath(stateRoot), JSON.stringify(route)); } catch { /* fail-open */ } },
    // CONTEXT-BUS-FEDERATION ③ — graphs/loop-agents/guardian/agent.yaml declares `bus-post` (notices: status): the 30-min
    // status digest goes to the L0's bus space as one status item (kit/bus-post); proposals and escalations stay mail.
    post: (require('../kit/bus-post/index.js') as typeof import('../kit/bus-post/index.js')).liveBusNoticePort(GUARDIAN_ID, GUARDIAN_SEAT, (key: string, to: string, body: string, kind = 'request'): number | null => {
      try { const w = appendOnce(store, key, () => ({ from: GUARDIAN_SEAT, to, body, kind, intent: kind === 'status' ? 'info' : 'decision', refs: [key] })); return w.fresh ? w.mail.id : 0; }
      catch { return null; }
    }, { stateRoot, mailHas: (key) => { try { return store.findByProvenanceKey(key) !== null; } catch { return false; } } }),
    audit: (row) => auditReap(stateRoot, row),
    reapLock: (fn) => withReapLock(stateRoot, fn),
    recentReaps: (nowMs) => recentReaps(stateRoot, nowMs),
  };
  // DETECT-TO-ACTION: «미정상화 사건» from kit/case-ledger (every domain · target 0)
  const cases = (() => { try { const u = (require('../kit/case-ledger/index.js') as typeof import('../kit/case-ledger/index.js')).unnormalizedCases(stateRoot, now); return u ? { open: u.open, overdue: u.overdue } : null; } catch { return null; } })();
  return { view: { now, probes, procs, registry, ready, hands, self, cases }, ports, store, stateRoot, close: () => store.close() };
}
