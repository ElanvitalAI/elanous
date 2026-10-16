import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tuiSourceText } from './helpers/dashboard-source.js';

const ROOT = join(import.meta.dir, '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function widgetFiles(): string[] {
  const dir = join(ROOT, 'widgets');
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(dir, entry.name, 'widget.ts'))
    .filter(path => {
      try {
        readFileSync(path, 'utf8');
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

describe('ui foundation · R10 metric green source truth', () => {
  test('mouse dispatch converges on unified input-core choke points', () => {
    const dashboard = tuiSourceText();
    const dispatcher = read('src/input-core/dispatcher.ts');

    expect(dispatcher.match(/export function routeInputEvent\(/g)?.length ?? 0).toBe(1);
    expect(dispatcher.match(/export async function routeInputEventAsync\(/g)?.length ?? 0).toBe(1);

    expect(dashboard).toContain('const runStreamingMouseUnifiedDispatch = (');
    expect(dashboard).toContain('const runMxMouseUnifiedDispatch = (');
    expect(dashboard).toContain('const runTextInputOnMouseUnifiedDispatch = (m: DisplayMouseEvent): void => {');
    expect(dashboard).toContain('const runStreamingKeyUnifiedDispatch = async (key: TuiKey): Promise<void> => {');
    expect(dashboard).toContain('inputCoreRouteInputEvent(ev, ctx);');
    expect(dashboard).toContain('await inputCoreRouteInputEventAsync(ev, ctx);');
  });

  test('wd-log owns log click hit resolution and dashboard no longer calls legacy helpers directly', () => {
    const dashboard = tuiSourceText();
    const logWidget = read('widgets/log/widget.ts');

    expect(dashboard).toContain('direct imports of tryAttachmentHitAtBodyRow /');
    expect(dashboard).not.toContain("import { tryAttachmentHitAtBodyRow");
    expect(dashboard).not.toContain("import { tryHandleLogAreaClick");
    // 2026-07-07 · the widget import gained tryAttachmentHitAtBodyRow
    // (body-row fallback when no viewport line map is present) and
    // became a multi-line import — assert the full combined block.
    expect(logWidget).toContain(
      "import {\n  tryAttachmentHitAtBodyRow,\n  tryAttachmentHitAtLineIndex,\n} from '../../src/log-pane/click-dispatch.js';",
    );
    expect(logWidget).toContain('onMouse(ev, state, _ctx) {');
    expect(logWidget).toContain('tryAttachmentHitAtLineIndex(mappedLineIdx, { row: absRow, col: absCol }, deps, {');
  });

  test('active widget modules all implement concrete onMouse handlers', () => {
    const files = widgetFiles();
    // 2026-07-07 · 18 → 19: the conversation widget landed after this
    // test was written. The invariant (every active widget module
    // implements a concrete onMouse handler) is unchanged.
    expect(files).toHaveLength(19);
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src.includes('onMouse('), file).toBe(true);
    }
  });

  test('view mode, widget focus api, and target-mount boundary are explicit', () => {
    const viewMode = read('src/input-core/view-mode.ts');
    // 2026-07-07 · dashboard decomposition: src/widget-host.ts moved
    // to src/widgets/host.ts (same WidgetHost class + focus api).
    const widgetHost = read('src/widgets/host.ts');
    const targetMount = read('src/tool-runtime/scenario-target-mount.ts');

    expect(viewMode).toContain('export type ViewModeKind =');
    expect(viewMode).toContain('export function deriveViewMode(s: ViewModeSignals): ViewMode {');
    expect(widgetHost).toContain('focus(id: string, reason: string): boolean {');
    expect(widgetHost).toContain('disposeById(id: string, reason: string): boolean {');
    expect(widgetHost).toContain('onFocusChange(cb: WidgetFocusChangeSubscriber): () => void {');
    expect(targetMount).toContain('RUN_SCENARIO_MOUNT_TARGET_KINDS');
    expect(targetMount).toContain("'window'");
    expect(targetMount).toContain("'pane'");
    expect(targetMount).toContain("'modal'");
    expect(targetMount).toContain("'widget'");
  });
});
