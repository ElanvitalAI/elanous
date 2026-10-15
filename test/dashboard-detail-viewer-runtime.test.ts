import { describe, expect, test } from 'bun:test';

import { createDashboardDetailViewerRuntime } from '../src/dashboard/detail-viewer-runtime.js';
import { createDashboardCompanionWidgetRuntime } from '../src/dashboard/companion-widget-runtime.js';

describe('createDashboardDetailViewerRuntime', () => {
  test('sets, clears, closes, and snapshots detail state', () => {
    const calls: string[] = [];
    const runtime = createDashboardDetailViewerRuntime({
      setOpen: (open) => { calls.push(`open:${open}`); },
      requestRender: () => { calls.push('render'); },
    });

    expect(runtime.snapshot()).toEqual({ title: '', lines: [] });

    runtime.set('Title', ['a', 'b']);
    expect(runtime.snapshot()).toEqual({ title: 'Title', lines: ['a', 'b'] });
    expect(calls).toEqual(['open:true', 'render']);

    calls.length = 0;
    runtime.clear();
    expect(runtime.snapshot()).toEqual({ title: '', lines: [] });
    expect(calls).toEqual(['render']);

    calls.length = 0;
    runtime.close();
    expect(calls).toEqual(['open:false']);
  });

  test('stage replaces content without opening the popup', () => {
    const calls: string[] = [];
    const runtime = createDashboardDetailViewerRuntime({
      setOpen: (open) => { calls.push(`open:${open}`); },
      requestRender: () => { calls.push('render'); },
    });
    runtime.stage('turn error', ['Codex API 400']);
    expect(runtime.snapshot()).toEqual({ title: 'turn error', lines: ['Codex API 400'] });
    expect(calls).toEqual(['render']);
  });

  test('stage 한 원문이 그리기 전에 wd-detail 위젯에 실린다(채팅 단독 화면 /detail open 회귀)', () => {
    const widget = { state: {} as Record<string, unknown>, character: 'Detail' };
    const companion = createDashboardCompanionWidgetRuntime();
    const order: string[] = [];
    const runtime = createDashboardDetailViewerRuntime({
      setOpen: (open) => { order.push(`open:${open}`); },
      requestRender: () => { order.push(`render:${JSON.stringify(widget.state.previewLines)}`); },
      project: (snapshot) => { companion.projectDetailWidget(widget, snapshot); },
    });
    runtime.stage('turn error', ['LLM API 400: {"detail":"Bad Request"}']);
    expect(widget.state.previewLines).toEqual(['LLM API 400: {"detail":"Bad Request"}']);
    expect(widget.character).toBe('Detail · turn error');
    // 그려질 때 이미 실려 있다 — 투영이 그리기보다 앞.
    expect(order).toEqual(['render:["LLM API 400: {\\"detail\\":\\"Bad Request\\"}"]']);
  });
});
