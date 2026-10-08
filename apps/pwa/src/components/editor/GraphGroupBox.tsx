'use client';

// GRAPH-GROUPS — the labelled box drawn around one expanded «묶음» (React Flow node of type `groupBox`, drawn under
// the member cards). Header = unit name ⊕ state; border tinted by state; the header button folds the unit.

import type { NodeProps } from '@xyflow/react';
import type { GroupState } from './graph-groups';

export interface GroupBoxData extends Record<string, unknown> {
  group: string;
  state: GroupState;
  memberCount: number;
  /** Finished run that never entered any member — «기록 없음» rather than «대기». */
  unrecorded?: boolean;
  width: number;
  height: number;
  onCollapse?: (group: string) => void;
}

const TINT: Record<GroupState, string> = {
  pending: 'var(--border, #94a3b8)', running: '#f59e0b', passed: 'var(--chart-2, #16a34a)', failed: 'var(--destructive, #ef4444)',
};
const WORD: Record<GroupState, string> = { pending: '대기', running: '도는 중', passed: '통과', failed: '실패' };

export function GraphGroupBox({ data }: NodeProps) {
  const box = data as GroupBoxData;
  const tint = TINT[box.state];
  return (
    <div data-testid={`group-box-${box.group}`} data-state={box.state}
      className={`pointer-events-none rounded-xl border-2 border-dashed ${box.unrecorded ? 'opacity-60' : ''}`}
      style={{ width: box.width, height: box.height, borderColor: tint, background: `color-mix(in srgb, ${tint} 6%, transparent)` }}>
      <div className="pointer-events-auto flex items-center gap-2 px-2.5 py-1 text-xs">
        <span className="font-mono font-semibold text-text-primary">{box.group}</span>
        <span className="text-[11px]" style={{ color: tint }}>{box.unrecorded ? '기록 없음' : WORD[box.state]}</span>
        <span className="text-[11px] text-text-tertiary">노드 {box.memberCount}</span>
        {box.onCollapse && (
          <button type="button" onClick={(event) => { event.stopPropagation(); box.onCollapse?.(box.group); }}
            className="nodrag ml-auto rounded border border-border bg-background px-1.5 text-[11px] text-text-secondary">접기</button>
        )}
      </div>
    </div>
  );
}

export const GROUP_BOX_NODE_TYPES = { groupBox: GraphGroupBox };
