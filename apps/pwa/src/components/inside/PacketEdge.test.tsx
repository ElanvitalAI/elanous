import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position } from '@xyflow/react';
import { PacketEdge, PACKET_MS } from './PacketEdge';

const draw = (packet: { key: string; shape: string; word: string; roundTrip: boolean } | null) => renderToStaticMarkup(<svg>
  <PacketEdge id="e" source="a" target="b" sourceX={0} sourceY={0} targetX={120} targetY={30} sourcePosition={Position.Right} targetPosition={Position.Left}
    label="넘김" data={{ packet }} />
</svg>);

test('one shaped packet moves once along the edge path, starts on demand, and is absent without a packet', () => {
  const once = draw({ key: 'k', shape: '▲', word: '넘김', roundTrip: false });
  expect(once.split('<animateMotion').length - 1).toBe(1);
  expect(once).toContain('begin="indefinite"');
  expect(once).toContain(`dur="${PACKET_MS}ms"`);
  expect(once).toContain('▲');
  expect(once).toContain('aria-hidden="true"');
  const round = draw({ key: 'k', shape: '●', word: '요청', roundTrip: true });
  expect(round).toContain('keyPoints="0;1;0"');
  expect(round).toContain(`dur="${PACKET_MS * 2}ms"`);
  const none = draw(null);
  expect(none.split('<animateMotion').length - 1).toBe(0);
  expect(none).toContain('넘김');
});
