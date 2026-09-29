import { describe, expect, test } from 'bun:test';

import { DisplayCoordinator } from '../src/display/coordinator.js';
import {
  createPreviewPaneModalChrome,
  createPreviewPaneModalWidgetId,
  disposePreviewPaneModalWidgetInstance,
  openPreviewPaneModal,
  replacePreviewPaneModalWidgetInstance,
  resolvePreviewPaneModalChromeAction,
  syncPreviewPaneWidgetFromModel,
} from '../src/preview-pane/mount.js';
import { DEFAULT_THEME_TOKENS } from '../src/theme/tokens.js';

describe('preview pane mount', () => {
  test('creates canonical modal widget id from source preview widget id', () => {
    expect(createPreviewPaneModalWidgetId('wd-preview')).toBe('wd-preview::preview-pane-modal');
  });

  test('creates chrome spec with live/snapshot status text', () => {
    expect(createPreviewPaneModalChrome(DEFAULT_THEME_TOKENS, true).bottomStatus).toBe('preview · live');
    expect(createPreviewPaneModalChrome(DEFAULT_THEME_TOKENS, false).bottomStatus).toBe('preview · snapshot');
  });

  test('syncs preview widget state from preview model', () => {
    const widget = {
      state: { text: '', scroll: 99, focused: true, preformatted: false },
      character: 'old',
    };
    const host = {
      get() { return widget; },
    };
    const synced = syncPreviewPaneWidgetFromModel(host, 'wd-preview::preview-pane-modal', {
      id: 'wd-preview',
      mode: 'docked',
      followCursor: true,
      pinned: false,
      sourceMode: 'smart',
      lastBrowserFocus: 'browser',
      previewPath: '/tmp/a.md',
      previewLines: ['a', 'b'],
      previewOffset: 3,
    });
    expect(synced).toBe(true);
    expect(widget.state.text).toBe('a\nb');
    expect(widget.state.scroll).toBe(3);
    expect(widget.state.focused).toBe(false);
    expect(widget.state.preformatted).toBe(true);
    expect(widget.character).toBe('Preview');
  });

  test('replaces and disposes modal preview widget with fallback path', () => {
    const disposed: string[] = [];
    const spawned: string[] = [];
    const host = {
      get(id: string) {
        if (id === 'wd-preview') return { type: 'markdown', character: 'Preview', config: { text: '' } };
        return null;
      },
      spawn(widget: { id: string }) { spawned.push(widget.id); },
      dispose(id: string) { disposed.push(`fallback:${id}`); },
      disposeById(id: string) {
        if (id === 'wd-preview::preview-pane-modal') disposed.push(id);
        else throw new Error('missing');
      },
    };
    expect(replacePreviewPaneModalWidgetInstance(host, 'wd-preview', 'wd-preview::preview-pane-modal')).toBe(true);
    disposePreviewPaneModalWidgetInstance(host, 'other', 'close');
    expect(spawned).toEqual(['wd-preview::preview-pane-modal']);
    expect(disposed).toEqual(['wd-preview::preview-pane-modal', 'fallback:other']);
  });

  test('close chrome action routes to explicit callback', () => {
    let close = 0;
    expect(resolvePreviewPaneModalChromeAction(
      { controlId: 'close', area: 'title-control', anchorStartCol: 0, anchorEndCol: 0, anchorRow: 0, bounds: { row: 0, col: 0, width: 0, height: 0 } },
      { onClose: () => { close += 1; } },
    )).toBe(true);
    expect(resolvePreviewPaneModalChromeAction(
      { controlId: 'noop', area: 'title-control', anchorStartCol: 0, anchorEndCol: 0, anchorRow: 0, bounds: { row: 0, col: 0, width: 0, height: 0 } },
      { onClose: () => { close += 1; } },
    )).toBe(false);
    expect(close).toBe(1);
  });

  test('snapshot modal uses captured preview text when live mode is off', () => {
    const coordinator = new DisplayCoordinator({ frameMs: 0 });
    const handle = openPreviewPaneModal({
      preview: {
        id: 'wd-preview',
        mode: 'docked',
        followCursor: true,
        pinned: false,
        sourceMode: 'smart',
        lastBrowserFocus: 'browser',
        previewPath: null,
        previewLines: ['ignored'],
        previewOffset: 0,
      },
      previewWidgetInstanceId: 'wd-preview',
      liveMode: false,
      widgetHost: {
        get() { return null; },
        spawn() {},
        dispose() {},
        disposeById() {},
        defFor() { return null; },
      },
      coordinator,
      termCols: 120,
      termRows: 40,
      captureSnapshot: () => 'line 1\nline 2',
      theme: DEFAULT_THEME_TOKENS,
    });
    expect(handle.columnCount).toBe(1);
    handle.dispose();
  });

});
