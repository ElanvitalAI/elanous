import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { launchRelations, ResourceFlowPanel } from './ResourceFlowPanel';
import type { ActivityEdge } from '@/components/inside/loop-activity-map';

const at = (minute: number) => `2026-10-16T03:${String(minute).padStart(2, '0')}:00.000Z`;

const SNAPSHOT: ActivityEdge[] = [
  { at: at(1), kind: 'run', from: 'OP', to: 'loop:run-abc123', ref: 'run-abc123' },
  { at: at(2), kind: 'run', from: 'OP', to: 'pr:4484', ref: 'run-abc123' },
  { at: at(3), kind: 'run', from: 'TC', to: 'loop:run-def456', ref: 'run-def456' },
  { at: at(4), kind: 'launch', from: 'UX', to: 'agent:task-agent', ref: 'card-9' },
  { at: at(5), kind: 'hand', from: 'OP', to: 'agent:task-agent', ref: 'card-9', mode: 'live' },
];

describe('launchRelations', () => {
  test('run 간선 중 자리(HQ)→런 노드만 실제 발사 관계로 친다', () => {
    expect(launchRelations(SNAPSHOT)).toEqual([
      { seat: 'OP', runs: [{ runId: 'run-abc123', at: at(1) }] },
      { seat: 'TC', runs: [{ runId: 'run-def456', at: at(3) }] },
    ]);
  });

  test('런→PR 간선과 자리 밖 출발 간선은 치지 않는다', () => {
    const flows = launchRelations(SNAPSHOT);
    expect(flows.some(flow => flow.runs.some(run => run.runId.includes('4484')))).toBe(false);
    expect(flows.some(flow => flow.seat === 'UX')).toBe(false);
  });

  test('seatIds 로 자리를 가르면 그 자리의 발사만 남는다', () => {
    expect(launchRelations(SNAPSHOT, ['TC'])).toEqual([
      { seat: 'TC', runs: [{ runId: 'run-def456', at: at(3) }] },
    ]);
  });

  test('자리 목록이 없으면 현재 스냅숏의 새 자리 발사를 누락하지 않는다', () => {
    const edges: ActivityEdge[] = [
      { at: at(6), kind: 'run', from: 'NEW_SEAT', to: 'loop:run-new789', ref: 'run-new789' },
    ];
    expect(launchRelations(edges)).toEqual([
      { seat: 'NEW_SEAT', runs: [{ runId: 'run-new789', at: at(6) }] },
    ]);
    expect(renderToStaticMarkup(<ResourceFlowPanel edges={edges} />)).toContain('NEW_SEAT → 런 · run-new789');
  });

  test('자리 목록이 중복돼도 한 발사 흐름만 그린다', () => {
    expect(launchRelations(SNAPSHOT, ['OP', 'OP'])).toEqual([
      { seat: 'OP', runs: [{ runId: 'run-abc123', at: at(1) }] },
    ]);
  });

  test('같은 간선이 두 번 오면 하나로 묶고, 발사 순서로 정렬한다', () => {
    const edges: ActivityEdge[] = [
      { at: at(9), kind: 'run', from: 'MK', to: 'loop:run-later', ref: 'run-later' },
      { at: at(7), kind: 'run', from: 'MK', to: 'loop:run-earlier', ref: 'run-earlier' },
      { at: at(7), kind: 'run', from: 'MK', to: 'loop:run-earlier', ref: 'run-earlier' },
    ];
    expect(launchRelations(edges)).toEqual([
      { seat: 'MK', runs: [{ runId: 'run-earlier', at: at(7) }, { runId: 'run-later', at: at(9) }] },
    ]);
  });
});

describe('ResourceFlowPanel', () => {
  test('HQ→노드 간선을 그리고 자원 발사 간선 목록을 함께 내보낸다', () => {
    const html = renderToStaticMarkup(<ResourceFlowPanel edges={SNAPSHOT} />);
    expect(html).toContain('aria-label="자원 발사 흐름"');
    expect(html).toContain('<svg');
    expect(html).toContain('COO → 런 · run-abc123');
    expect(html).toContain('CTO → 런 · run-def456');
    expect(html).toContain('/trace?level=L2&' + 'amp;run=run-abc123');
    expect(html).toContain('<time');
  });

  test('런→PR 후속 관계와 발사 간선은 패널에 안 그린다', () => {
    const html = renderToStaticMarkup(<ResourceFlowPanel edges={SNAPSHOT} />);
    expect(html).not.toContain('4484');
    expect(html).not.toContain('CXO →');
  });

  test('실제 발사 관계가 없으면 빈 상태를 내보낸다', () => {
    const html = renderToStaticMarkup(<ResourceFlowPanel edges={[]} />);
    expect(html).toContain('실제 발사 관계가 아직 없습니다');
    expect(html).not.toContain('<svg');
  });
});
