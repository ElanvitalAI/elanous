import type { DaemonClient } from './daemon-client';

export type OpsResult<T> = { kind: 'ready'; data: T } | { kind: 'forbidden' } | { kind: 'error'; status: number };
// startedAt/endedAt 은 GRAPH-NODE-TIMES(0.2.19 TC) 가 원장에 넣는다 — 그 전엔 없다(화면은 «시각 미기록»).
export interface ReleaseNode { nodeId: string; ok: boolean | null; summary: string; startedAt?: string | null; endedAt?: string | null }
export interface ReleaseRun {
  runId: string;
  status: string;
  startedAt: string;
  version: string | null;
  path: string[];
  nodes: ReleaseNode[];
}
// 모르는 상태값(예: 앞으로 생길 blocked)은 버리지 않고 그대로 싣는다 — 칸 하나 때문에 화면 전체가 오류가 되지 않게.
export type ChecklistStatus = 'green' | 'yellow' | 'red' | 'done' | (string & {});
export interface OpsChecklistItem {
  id: string;
  title: string;
  status: ChecklistStatus;
  owner?: string;
  updatedAt: string;
  evidence?: string;
}
export interface OpsSeat {
  seat: 'OP' | 'MK' | 'TC' | 'UX';
  role?: string;
  now: { text: string; at: string } | null;
  landed: Array<{ pr: number; title: string; at: string; checklistId: string | null }> | null;
  blocked: Array<{ id: string; title: string; status: 'red' }> | null;
  pendingDecisions: number | null;
  checklist: { green: number; yellow: number; red: number; done: number } | null;
  subSeats?: Array<{ id: string; title: string; open: number | null; landed: number | null; blocked: Array<{ id: string; title: string }> | null }> | null;
}
export interface OpsSeats { date: string; seats: OpsSeat[] }

export interface OpsChecklist {
  version: string;
  codename?: string;
  schedule?: { cutAt: string; landBy: string | null } | null;
  items: OpsChecklistItem[];
  green: number;
  yellow: number;
  red: number;
  done: number;
  blocked?: string[];
  byOwner?: Record<string, number>;
  history?: unknown[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function string(value: unknown): value is string { return typeof value === 'string'; }
function utcIso(value: unknown): value is string {
  return string(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function node(value: unknown): value is ReleaseNode {
  return record(value) && string(value.nodeId) && (value.ok === null || typeof value.ok === 'boolean') && string(value.summary)
    && (value.startedAt === undefined || value.startedAt === null || string(value.startedAt))
    && (value.endedAt === undefined || value.endedAt === null || string(value.endedAt));
}
function run(value: unknown): value is ReleaseRun {
  return record(value) && string(value.runId) && string(value.status) && string(value.startedAt)
    && (value.version === null || string(value.version))
    && Array.isArray(value.path) && value.path.every(string)
    && Array.isArray(value.nodes) && value.nodes.every(node);
}
function item(value: unknown): value is OpsChecklistItem {
  return record(value) && string(value.id) && string(value.title)
    && string(value.status)
    && (value.owner === undefined || string(value.owner)) && string(value.updatedAt)
    && (value.evidence === undefined || string(value.evidence));
}
function checklist(value: unknown): value is OpsChecklist {
  return record(value) && string(value.version) && (value.codename === undefined || string(value.codename))
    && Array.isArray(value.items) && value.items.every(item)
    && (['green', 'yellow', 'red', 'done'] as const).every((key) => value[key] === undefined || (Number.isInteger(value[key]) && (value[key] as number) >= 0))
    && (value.blocked === undefined || (Array.isArray(value.blocked) && value.blocked.every(string)))
    && (value.byOwner === undefined || (record(value.byOwner) && Object.values(value.byOwner).every((count) => Number.isInteger(count) && (count as number) >= 0)))
    && (value.history === undefined || Array.isArray(value.history));
}

const count = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
function subSeat(value: unknown): boolean {
  return record(value) && string(value.id) && string(value.title)
    && (value.open === null || count(value.open)) && (value.landed === null || count(value.landed))
    && (value.blocked === null || (Array.isArray(value.blocked) && value.blocked.every((row: unknown) =>
      record(row) && string(row.id) && string(row.title))));
}
function seat(value: unknown): value is OpsSeat {
  return record(value) && ['OP', 'MK', 'TC', 'UX'].includes(value.seat as string)
    && (value.role === undefined || string(value.role))
    && (value.now === null || (record(value.now) && string(value.now.text) && string(value.now.at)))
    && (value.landed === null || (Array.isArray(value.landed) && value.landed.every((row: unknown) =>
      record(row) && count(row.pr) && string(row.title) && string(row.at) && (row.checklistId === null || string(row.checklistId)))))
    && (value.blocked === null || (Array.isArray(value.blocked) && value.blocked.every((row: unknown) =>
      record(row) && string(row.id) && string(row.title) && row.status === 'red')))
    && (value.pendingDecisions === null || count(value.pendingDecisions))
    && (value.checklist === null || (record(value.checklist) && (['green', 'yellow', 'red', 'done'] as const).every((key) => count((value.checklist as Record<string, unknown>)[key]))))
    && (value.subSeats === undefined || value.subSeats === null || (Array.isArray(value.subSeats) && value.subSeats.every(subSeat)));
}

async function get<T>(client: DaemonClient, path: string, parse: (value: unknown) => T | null): Promise<OpsResult<T>> {
  try {
    const response = await client.fetchResponse(path, { method: 'GET' });
    if (response.status === 403) return { kind: 'forbidden' };
    if (!response.ok) return { kind: 'error', status: response.status };
    const data = parse(await response.json());
    return data === null ? { kind: 'error', status: response.status } : { kind: 'ready', data };
  } catch {
    return { kind: 'error', status: 0 };
  }
}

export function getSeats(client: DaemonClient, date?: string): Promise<OpsResult<OpsSeats>> {
  return get(client, `/v1/ops/seats${date ? `?date=${encodeURIComponent(date)}` : ''}`,
    (value) => record(value) && string(value.date) && Array.isArray(value.seats) && value.seats.every(seat)
      && new Set(value.seats.map((row: OpsSeat) => row.seat)).size === value.seats.length ? { date: value.date, seats: value.seats } : null);
}

export function getReleaseRuns(client: DaemonClient, version?: string): Promise<OpsResult<ReleaseRun[]>> {
  return get(client, `/v1/ops/release/runs${version ? `?version=${encodeURIComponent(version)}` : ''}`,
    (value) => Array.isArray(value) && value.every(run) ? value : null);
}
export function getReleaseNodeLog(client: DaemonClient, runId: string, nodeId: string): Promise<OpsResult<{ log: string }>> {
  return get(client, `/v1/ops/release/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/log`,
    (value) => record(value) && string(value.log) ? { log: value.log } : null);
}
export function getOpsChecklist(client: DaemonClient, version: string): Promise<OpsResult<OpsChecklist>> {
  return get(client, `/v1/ops/checklist?version=${encodeURIComponent(version)}`, (value) => {
    if (!checklist(value)) return null;
    const counts = { green: 0, yellow: 0, red: 0, done: 0 };
    for (const entry of value.items) if (entry.status in counts) counts[entry.status as keyof typeof counts]++;
    return {
      version: value.version, ...(value.codename !== undefined ? { codename: value.codename } : {}),
      schedule: record(value.schedule) && utcIso(value.schedule.cutAt)
        && (value.schedule.landBy === null || utcIso(value.schedule.landBy))
        ? { cutAt: value.schedule.cutAt, landBy: value.schedule.landBy } : null,
      items: value.items,
      green: value.green ?? counts.green, yellow: value.yellow ?? counts.yellow,
      red: value.red ?? counts.red, done: value.done ?? counts.done,
      ...(value.blocked !== undefined ? { blocked: value.blocked } : {}),
      ...(value.byOwner !== undefined ? { byOwner: value.byOwner } : {}),
      ...(value.history !== undefined ? { history: value.history } : {}),
    };
  });
}
