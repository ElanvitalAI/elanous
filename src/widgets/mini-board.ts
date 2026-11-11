import type { WidgetDef } from './types.js';
import {
  projectTuiMiniBoard,
  renderTuiMiniBoard,
  type TuiMiniBoardProjection,
} from '../tui-client/mini-board-projection.js';
import type { TaskCardEntry } from '../../apps/pwa/src/lib/task-card-model.js';

export interface MiniBoardWidgetState {
  projection: TuiMiniBoardProjection;
  scrollOffset: number;
}

export interface MiniBoardWidgetConfig {
  /** Supplied by the operator-board host; never persisted by the widget. */
  events?: TaskCardEntry[];
  updatedAt?: number;
}

const miniBoardWidget: WidgetDef<MiniBoardWidgetState, MiniBoardWidgetConfig> = {
  type: 'mini-board',
  description: 'Operator-only, read-only projection of task cards into five board columns.',
  defaultCharacter: '미니 보드',

  initialState(config) {
    return { projection: projectTuiMiniBoard(config?.events ?? [], config?.updatedAt), scrollOffset: 0 };
  },

  render(state, ctx) {
    const allLines = renderTuiMiniBoard(state.projection, ctx.width);
    const viewport = Math.max(1, ctx.height - (allLines.length > ctx.height ? 1 : 0));
    const maxOffset = Math.max(0, allLines.length - viewport);
    const scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxOffset));
    const visible = allLines.slice(scrollOffset, scrollOffset + viewport);
    if (maxOffset > 0 && ctx.height > 1) {
      visible.push(`↑/↓ j/k ${scrollOffset + 1}-${Math.min(allLines.length, scrollOffset + viewport)}/${allLines.length}`);
    }
    return visible;
  },

  onKey(ev, state, ctx) {
    const allLines = renderTuiMiniBoard(state.projection, ctx.width ?? 0);
    const height = Math.max(1, ctx.height ?? 1);
    const viewport = Math.max(1, height - (allLines.length > height ? 1 : 0));
    const maxOffset = Math.max(0, allLines.length - viewport);
    const page = Math.max(1, viewport - 1);
    switch (ev.name) {
      case 'j': case 'down':
        state.scrollOffset = Math.min(maxOffset, state.scrollOffset + 1);
        return { type: 'refresh' };
      case 'k': case 'up':
        state.scrollOffset = Math.max(0, state.scrollOffset - 1);
        return { type: 'refresh' };
      case 'pagedown':
        state.scrollOffset = Math.min(maxOffset, state.scrollOffset + page);
        return { type: 'refresh' };
      case 'pageup':
        state.scrollOffset = Math.max(0, state.scrollOffset - page);
        return { type: 'refresh' };
      case 'g': case 'home':
        state.scrollOffset = 0;
        return { type: 'refresh' };
      case 'G': case 'end':
        state.scrollOffset = maxOffset;
        return { type: 'refresh' };
      default:
        return { type: 'none' };
    }
  },
};

export default miniBoardWidget;
