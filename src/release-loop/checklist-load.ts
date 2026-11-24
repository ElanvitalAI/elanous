import { elanousStateRoot } from '../autopilot/state-paths.js';
import { requestEls } from '../els/client.js';
import { createFederation } from '../els/federation.js';
import { withHerdrHost } from '../els/herdr-host.js';
import { elsHostsPath, fetchHostJson, loadHostRegistry } from '../els/hosts.js';
import { elsHostName, elsSocketPath } from '../els/server.js';
import { parsePaneSeatStatus } from '../els/seat-status.js';
import { parseTargetPathHintLine, type Checklist, type ChecklistItem } from './checklist.js';

export interface LoadPane { seat?: unknown; status?: unknown; model?: unknown; state?: unknown; activityState?: unknown }
export interface LoadObservation { panes: LoadPane[]; complete: boolean; problem?: string }

/** Read the same federated listing as els; a partial listing cannot establish availability. */
export async function observeLoadPanes(): Promise<LoadObservation> {
  try {
    const registry = loadHostRegistry(elsHostsPath(elanousStateRoot()));
    const hosts = withHerdrHost({ registry, fetchJson: (host, path) => fetchHostJson(host, path, 2_000) });
    const result = await createFederation({ localHost: elsHostName(), askLocal: request => requestEls(elsSocketPath(), request), ...hosts }).list();
    if (result.exitCode !== 0) return { panes: [], complete: false, problem: result.message };
    const body = JSON.parse(result.message) as { panes?: LoadPane[]; hosts?: { reach?: string }[]; rejectedHosts?: string[]; hostsProblem?: string };
    if (!Array.isArray(body.panes) || !Array.isArray(body.hosts)) return { panes: [], complete: false, problem: 'ELS 응답 형식 오류' };
    const complete = !body.hostsProblem && !body.rejectedHosts?.length && body.hosts.every(host => host.reach !== 'down');
    return { panes: body.panes, complete, ...(complete ? {} : { problem: 'ELS 호스트 관측 불완전' }) };
  } catch (error) { return { panes: [], complete: false, problem: `ELS 조회 실패: ${error instanceof Error ? error.message : String(error)}` }; }
}

const ownerSeat = (owner?: string): string | null => {
  const seat = owner?.trim().split('/')[0] ?? '';
  return /^[A-Z][A-Z0-9_-]{0,63}$/.test(seat) ? seat : null;
};
const paths = (item: ChecklistItem): string[] => {
  const parsed = parseTargetPathHintLine(item.title);
  const values = parsed.fragments.map(p => p.trim().replace(/^`+|`+$/g, '').replace(/\/$/, ''));
  // Globs, traversal, absolute paths and empty fragments cannot establish non-overlap.
  return values.length && values.every(p => p && !p.startsWith('/') && !/[?*\[\]{}\\]/.test(p) && p.split('/').every(part => part !== '.' && part !== '..' && part !== '')) ? values : [];
};
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
// A syntactically valid seat is not necessarily an individual hand (e.g. POOL-4, OP, TC).
// Until a roster supplies explicit roles, only the established numbered hand IDs qualify.
const isHandSeat = (seat: string): boolean => /^TC-H-[A-Z0-9]+-\d+$/.test(seat);

/** Read-only proposal. Unknown paths, incomplete observations and multiple panes are not treated as safe. */
export function buildChecklistLoad(checklist: Checklist, observation: LoadObservation, now = Date.now()) {
  const yellow = checklist.items.filter(item => item.status === 'yellow');
  const relevant = yellow.filter(item => item.priority === 'P0' || item.priority === 'P1');
  const names = new Set<string>();
  for (const item of relevant) { const seat = ownerSeat(item.owner); if (seat) names.add(seat); }
  for (const pane of observation.panes) if (typeof pane.seat === 'string' && ownerSeat(pane.seat) === pane.seat) names.add(pane.seat);
  const rows = [...names].sort().map(seat => {
    const items = relevant.filter(item => ownerSeat(item.owner) === seat);
    const panes = observation.panes.filter(pane => pane.seat === seat);
    const states = panes.map(pane => parsePaneSeatStatus(pane.status)?.state ?? (typeof pane.activityState === 'string' ? pane.activityState.toUpperCase() : typeof pane.state === 'string' ? pane.state.toUpperCase() : 'UNKNOWN'));
    return { seat, p0: items.filter(i => i.priority === 'P0').length, p1: items.filter(i => i.priority === 'P1').length,
      updated2h: items.filter(i => { const at = Date.parse(i.updatedAt); return Number.isFinite(at) && at <= now && now - at <= 2 * 60 * 60 * 1000; }).map(i => ({ id: i.id, updatedAt: i.updatedAt })),
      states, models: panes.map(p => typeof p.model === 'string' && p.model ? p.model : null),
      ownerStatus: panes.length === 0 ? (observation.complete ? 'closed-or-unobserved' : 'unknown') : states.every(s => s === 'EXITED') ? 'closed' : states.length > 1 ? 'ambiguous' : 'observed' };
  });
  const ambiguousOwners = yellow.filter(item => !ownerSeat(item.owner) || !isHandSeat(ownerSeat(item.owner)!)).map(item => ({ id: item.id, owner: item.owner ?? null }));
  const proposals: { id: string; from: string; to: string; paths: string[] }[] = [];
  const idle = rows.filter(row => isHandSeat(row.seat) && !yellow.some(item => ownerSeat(item.owner) === row.seat) && row.states.length === 1 && row.states[0] === 'IDLE');
  if (observation.complete && ambiguousOwners.length === 0 && yellow.every(item => paths(item).length > 0)) {
    for (const row of rows.filter(r => r.p0 + r.p1 >= 2 || (r.ownerStatus === 'closed' && r.p0 + r.p1 > 0))) {
      for (const item of relevant.filter(i => ownerSeat(i.owner) === row.seat)) {
        if (!idle.length) break;
        const target = paths(item);
        if (yellow.some(other => other.id !== item.id && paths(other).some(p => target.some(t => overlaps(p, t))))) continue;
        // Suggestions are queued, not concurrent claims. Round-robin spreads the queue
        // over observed idle hands while allowing more items than hands.
        const dest = idle[proposals.length % idle.length]!;
        proposals.push({ id: item.id, from: row.seat, to: dest.seat, paths: target });
      }
    }
  }
  return { version: checklist.version, observedAt: new Date(now).toISOString(), els: { complete: observation.complete, problem: observation.problem ?? null }, rows, ambiguousOwners, proposals,
    proposalNote: '읽기 전용 제안 · 자동 apply 미구현 · 경로 또는 ELS 관측 불완전 시 제안 생략' };
}

export function renderChecklistLoad(board: ReturnType<typeof buildChecklistLoad>): string {
  return [`판 ${board.version} · ELS ${board.els.complete ? '관측' : `불완전: ${board.els.problem}`}`,
    ...board.rows.map(row => `${row.seat} · P0 ${row.p0} · P1 ${row.p1} · 2h ${row.updated2h.map(i => `${i.id}@${i.updatedAt}`).join(', ') || '-'} · ELS ${row.states.join('/') || '?'} · 모델 ${row.models.map(m => m ?? '?').join('/') || '?'} · 소유 ${row.ownerStatus}`),
    `막연한 소유: ${board.ambiguousOwners.map(i => `${i.id}(${i.owner ?? '?'})`).join(', ') || '-'}`,
    ...(board.proposals.length ? board.proposals.map(p => `배분 제안: ${p.id} ${p.from} → ${p.to} [${p.paths.join(', ')}]`) : ['배분 제안: -']), board.proposalNote].join('\n');
}
