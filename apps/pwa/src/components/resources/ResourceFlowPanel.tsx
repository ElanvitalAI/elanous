'use client';

import { SEAT_NAMES, type ActivityEdge } from '@/components/inside/loop-activity-map';
import { toPublicText } from '@/components/inside/public-text';

export interface ResourceFlowRun { runId: string; at: string }
export interface ResourceFlow { seat: string; runs: ResourceFlowRun[] }

const RUN_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const ROW_H = 34;
const PAD_Y = 10;
const WIDTH = 320;
const HQ_X = 44;
const SPINE_X = 68;
const RUN_X = 272;

/**
 * 자원 지도의 HQ→노드 간선 — 현재 스냅숏의 실제 발사 관계.
 * 서버 `src/nexus/api/loop-edges.ts` 가 런 원장 `start` 사건에서 만드는 run 간선만 친다
 * (출발 = 자리(HQ) · 도착 = `loop:<runId>` 런 노드). 런→PR 간선은 발사 관계가 아니라 후속 관계라 치지 않는다.
 * 자리 목록이 있으면 그것으로 가른다. 목록이 없는 화면은 서버가 자리로 검증해 낸
 * run→loop 간선의 출발지를 사용해 새 자리의 발사를 누락하지 않는다.
 * 같은 간선이 두 번 오면 하나로 묶는다.
 */
export function launchRelations(edges: readonly ActivityEdge[], seatIds?: readonly string[]): ResourceFlow[] {
  const selectedSeats = [...new Set(seatIds ?? edges
    .filter(edge => edge.kind === 'run' && edge.to.startsWith('loop:') && RUN_ID.test(edge.from))
    .map(edge => edge.from))];
  if (seatIds === undefined) selectedSeats.sort();
  const seats = new Set(selectedSeats);
  const runs = new Map<string, ResourceFlowRun[]>();
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== 'run' || !seats.has(edge.from) || !edge.to.startsWith('loop:')) continue;
    const runId = edge.to.slice('loop:'.length);
    if (!RUN_ID.test(runId)) continue;
    const key = `${edge.at}|${edge.from}|${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = runs.get(edge.from) ?? [];
    list.push({ runId, at: edge.at });
    runs.set(edge.from, list);
  }
  return selectedSeats.filter(seat => runs.has(seat)).map(seat => ({
    seat,
    runs: (runs.get(seat) ?? []).sort((a, b) => a.at.localeCompare(b.at)),
  }));
}

/** 간선 그림 — 자리(HQ) 원이 왼쪽, 런 노드 점이 오른쪽, 오른쪽을 향한 화살표 간선으로 잇는다. */
function FlowDiagram({ flows }: { flows: readonly ResourceFlow[] }) {
  const rows: Array<{ seat: string; run: ResourceFlowRun; y: number }> = [];
  let cursor = 0;
  for (const flow of flows) for (const run of flow.runs) rows.push({ seat: flow.seat, run, y: PAD_Y + ROW_H / 2 + cursor++ * ROW_H });
  const height = PAD_Y * 2 + rows.length * ROW_H;
  return <svg viewBox={`0 0 ${WIDTH} ${height}`} className="h-auto w-full max-w-md" aria-hidden="true" focusable="false">
    {flows.map(flow => {
      const mine = rows.filter(row => row.seat === flow.seat);
      const center = (mine[0]!.y + mine[mine.length - 1]!.y) / 2;
      const seatLabel = SEAT_NAMES[flow.seat] ?? toPublicText(flow.seat);
      return <g key={flow.seat}>
        <line x1={HQ_X + 16} y1={center} x2={SPINE_X} y2={center} stroke="#7492a8" strokeWidth={2} />
        {mine.length > 1 && <line x1={SPINE_X} y1={mine[0]!.y} x2={SPINE_X} y2={mine[mine.length - 1]!.y} stroke="#7492a8" strokeWidth={2} />}
        {mine.map(row => <g key={`${row.run.runId}-${row.run.at}`}>
          <line x1={SPINE_X} y1={row.y} x2={RUN_X - 16} y2={row.y} stroke="#7492a8" strokeWidth={2} />
          <polygon points={`${RUN_X - 8},${row.y} ${RUN_X - 16},${row.y - 4} ${RUN_X - 16},${row.y + 4}`} fill="#7492a8" />
          <circle cx={RUN_X} cy={row.y} r={8} fill="#173556" stroke="#38bdf8" strokeWidth={2} />
          <text x={(SPINE_X + RUN_X - 16) / 2} y={row.y - 5} textAnchor="middle" fontSize={10} fill="#cbd5e1">
            {row.run.runId.length > 16 ? `${row.run.runId.slice(0, 15)}…` : row.run.runId}
          </text>
        </g>)}
        <circle cx={HQ_X} cy={center} r={16} fill="#173556" stroke="#38bdf8" strokeWidth={2} />
        <text x={HQ_X} y={center + 3.5} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#e0f2fe">{seatLabel}</text>
      </g>;
    })}
  </svg>;
}

/** 자원 발사 흐름 패널 — 자원 지도에서 HQ→노드 간선을 현재 스냅숏의 실제 발사 관계로 그린다. */
export function ResourceFlowPanel({ edges, seatIds }: { edges: readonly ActivityEdge[]; seatIds?: readonly string[] }) {
  const flows = launchRelations(edges, seatIds);
  return <section aria-label="자원 발사 흐름" className="rounded-xl border border-slate-600 p-3">
    <h3 className="font-semibold">자원 흐름 · 자리 → 런</h3>
    <p className="mt-1 text-xs text-slate-400">현재 스냅숏의 실제 발사 관계(런 원장)로 자리 → 런 간선을 그립니다.</p>
    {flows.length === 0
      ? <p role="status" className="mt-2 text-sm text-slate-300">실제 발사 관계가 아직 없습니다</p>
      : <div className="mt-2 grid gap-3 lg:grid-cols-[auto_1fr] lg:items-start">
        <FlowDiagram flows={flows} />
        <ol aria-label="자원 발사 간선" className="space-y-2">
          {flows.map(flow => flow.runs.map(run => <li key={`${flow.seat}-${run.runId}-${run.at}`}>
            <a href={`/trace?level=L2&run=${encodeURIComponent(run.runId)}`}
              className="block w-full min-w-0 break-words rounded-lg border border-slate-600 px-3 py-2 text-left text-sm text-slate-300 focus-visible:outline-2 focus-visible:outline-sky-400">
              {SEAT_NAMES[flow.seat] ?? toPublicText(flow.seat)} → 런 · {toPublicText(run.runId)}
              {' · '}<time dateTime={run.at}>{new Date(run.at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}</time>
            </a>
          </li>))}
        </ol>
      </div>}
  </section>;
}
