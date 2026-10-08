'use client';

import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import { EDGE_FAMILY_COLOR, type RoutedEdge } from '@/lib/graph-edge-route';

/** GRAPH-EDGE-TIDY — draws a pre-routed edge (graph-edge-route.ts). React Flow's own source/target coordinates are
 *  ignored on purpose: the route was computed for all edges together (lanes, fanned ports, label collisions). */
export interface TidyEdgeData extends Record<string, unknown> {
  route: RoutedEdge;
}

export function TidyEdge({ id, data, selected, markerEnd, style, interactionWidth }: EdgeProps) {
  const route = (data as TidyEdgeData | undefined)?.route;
  if (!route) return null;
  const color = EDGE_FAMILY_COLOR[route.family];
  const dashed = route.kind === 'back';
  return (
    <>
      <BaseEdge id={id} path={route.path} markerEnd={markerEnd} interactionWidth={interactionWidth ?? 16}
        style={{ stroke: color, strokeWidth: selected ? 3 : 2, ...(dashed ? { strokeDasharray: '6 4' } : {}), ...style }} />
      {route.label && (
        <EdgeLabelRenderer>
          <div data-testid={`edge-label-${route.from}-${route.to}`} data-edge-family={route.family}
            className="nodrag nopan pointer-events-none absolute whitespace-nowrap rounded-full border px-1.5 font-mono text-[12px] leading-[18px]"
            style={{
              transform: `translate(-50%, -50%) translate(${route.label.x}px, ${route.label.y}px)`,
              width: route.label.width,
              textAlign: 'center',
              borderColor: color,
              color,
              background: 'var(--background, #fff)',
              fontWeight: route.family === 'neutral' ? 500 : 600,
              ...(selected ? { boxShadow: `0 0 0 1px ${color}` } : {}),
            }}>
            {route.label.text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const TIDY_EDGE_TYPES = { tidy: TidyEdge };
