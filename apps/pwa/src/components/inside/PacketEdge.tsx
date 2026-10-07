'use client';

import { useEffect, useRef } from 'react';
import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';

/** 간선 위를 한 번 지나가는 꾸러미 — 모양 글자 하나(요청 ● 결정 ◆ 보고 ■ 넘김 ▲ 발사 ★ 판단 ⬟). */
export interface PacketData extends Record<string, unknown> {
  /** null = 이 간선엔 꾸러미가 없다(새 간선 아님 · 움직임 줄이기). */
  packet: { key: string; shape: string; word: string; roundTrip: boolean } | null;
}

export const PACKET_MS = 1_200;

/**
 * SMIL 은 문서 시계 0 에 시작하므로 뒤늦게 붙은 <animateMotion> 은 «이미 끝난» 채로 그려진다 —
 * begin="indefinite" 로 두고 붙은 뒤 beginElement() 로 한 번 시작한다.
 */
export function PacketEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, label, labelStyle, interactionWidth, data }: EdgeProps<Edge<PacketData>>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const motion = useRef<SVGAnimateMotionElement | null>(null);
  const fade = useRef<SVGAnimateElement | null>(null);
  const packet = data?.packet ?? null;
  const packetKey = packet?.key ?? null;
  // 부모가 250ms 마다 다시 그려도 같은 간선이면 다시 시작하지 않는다 — 간선 키가 바뀔 때만 한 번.
  useEffect(() => {
    if (packetKey === null) return;
    try { motion.current?.beginElement?.(); fade.current?.beginElement?.(); } catch { /* SMIL 미지원 — 강조만 남는다. */ }
  }, [packetKey]);
  return <>
    <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} label={label} labelX={labelX} labelY={labelY} labelStyle={labelStyle} interactionWidth={interactionWidth} />
    {packet && <g data-packet={packet.word} aria-hidden="true" opacity={0}>
      <text textAnchor="middle" dominantBaseline="central" fontSize={16} fill="#e0f2fe" stroke="#10243b" strokeWidth={0.6}>{packet.shape}</text>
      <animateMotion ref={motion} begin="indefinite" dur={`${packet.roundTrip ? PACKET_MS * 2 : PACKET_MS}ms`} path={path} fill="freeze"
        {...(packet.roundTrip ? { keyPoints: '0;1;0', keyTimes: '0;0.5;1', calcMode: 'linear' } : {})} />
      <animate ref={fade} attributeName="opacity" begin="indefinite" dur={`${packet.roundTrip ? PACKET_MS * 2 : PACKET_MS}ms`} values="1;1;0" keyTimes="0;0.85;1" fill="freeze" />
    </g>}
  </>;
}
