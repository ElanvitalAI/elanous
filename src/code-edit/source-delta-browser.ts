import { C } from '../tui.js';
import { computePopupBounds } from '../status/popups.js';
import { BoxView } from '../ui/view.js';
import { mountViewAsModalSurface, type ViewSurfaceHandle } from '../ui/modal-adapter.js';
import { SelectView, type SelectOption } from '../ui/widgets/select-view.js';
import { resolvePickerChromePresentation } from '../ui/chrome/picker-chrome.js';
import { resolveWidgetChromeBoxViewOptions } from '../ui/declarative/index.js';
import type { ThemeTokens } from '../theme/tokens.js';
import { renderEditBlock } from './diff-render.js';
import type { EditResult } from './types.js';
import type { SourceDeltaFile, SourceDeltaTurnSnapshot } from './source-delta.js';

const TURN_ROW_PREFIX = '__turn__:';

export interface SourceDeltaBrowserOptionValue {
  turnIndex: number;
  filePath: string;
}

export type SourceDeltaBrowserMode = 'all' | 'files' | 'turns';
const SOURCE_DELTA_BROWSER_MODE_HINT = 'A all · F files · T turns';

export interface SourceDeltaBrowserOpts {
  turns: SourceDeltaTurnSnapshot[];
  mode?: SourceDeltaBrowserMode;
  termCols: number;
  termRows: number;
  anchorRow?: number;
  anchorCol?: number;
  theme?: ThemeTokens;
  onCancel?: () => void;
}

export function buildSourceDeltaBrowserOptions(
  turns: readonly SourceDeltaTurnSnapshot[],
  mode: SourceDeltaBrowserMode = 'all',
): SelectOption<SourceDeltaBrowserOptionValue>[] {
  const options: SelectOption<SourceDeltaBrowserOptionValue>[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (mode !== 'files') {
      options.push({
        value: { turnIndex: turn.turnIndex, filePath: `${TURN_ROW_PREFIX}${turn.turnIndex}` },
        label: C.bold(`Turn #${turn.turnIndex}`),
        description: `${turn.stats.filesChanged}f · +${turn.stats.linesAdded} -${turn.stats.linesRemoved}${turn.promptPreview ? ` · ${truncate(turn.promptPreview, 30)}` : ''}`,
        icon: i === 0 ? C.success('●') : C.muted('○'),
      });
    }
    if (mode === 'turns') continue;
    for (const file of turn.files) {
      options.push({
        value: { turnIndex: turn.turnIndex, filePath: file.filePath },
        label: file.filePath,
        description: mode === 'files'
          ? `Turn #${turn.turnIndex} · ${file.isNewFile ? 'created' : 'edited'} · +${file.linesAdded} -${file.linesRemoved}${file.editCount > 1 ? ` · ${file.editCount} edits` : ''}`
          : `${file.isNewFile ? 'created' : 'edited'} · +${file.linesAdded} -${file.linesRemoved}${file.editCount > 1 ? ` · ${file.editCount} edits` : ''}`,
        icon: mode === 'files'
          ? (i === 0 ? C.success('●') : C.muted('○'))
          : undefined,
      });
    }
  }
  return options;
}

export function renderSourceDeltaTurnPreview(turn: SourceDeltaTurnSnapshot, opts: { maxFiles?: number } = {}): string {
  const maxFiles = Math.max(1, opts.maxFiles ?? 8);
  const rows = [
    `Turn #${turn.turnIndex}`,
    `started ${turn.startedAt}`,
    `files ${turn.stats.filesChanged} · edits ${turn.stats.edits} · +${turn.stats.linesAdded} -${turn.stats.linesRemoved}`,
    `prompt ${turn.promptPreview || '(empty prompt preview)'}`,
    '',
  ];
  const visible = turn.files.slice(0, maxFiles);
  for (const file of visible) {
    rows.push(`${file.isNewFile ? 'created' : 'edited'} ${file.filePath} (+${file.linesAdded} -${file.linesRemoved}${file.editCount > 1 ? ` · ${file.editCount} edits` : ''})`);
  }
  if (turn.files.length > visible.length) {
    rows.push(`… ${turn.files.length - visible.length} more files`);
  }
  return rows.join('\n');
}

export function renderSourceDeltaFilePreview(
  file: SourceDeltaFile,
  opts: { cols?: number; maxLines?: number } = {},
): string {
  const rows = renderEditBlock(sourceDeltaFileToEditResult(file), {
    cols: opts.cols ?? 96,
    syntax: false,
    headerStyle: 'edited',
  });
  const maxLines = Math.max(4, opts.maxLines ?? 36);
  if (rows.length <= maxLines) return rows.join('\n');
  const hidden = rows.length - maxLines;
  return [
    ...rows.slice(0, maxLines),
    C.muted(`… ${hidden} more line${hidden === 1 ? '' : 's'}`),
  ].join('\n');
}

export function createSourceDeltaBrowserPopup(opts: SourceDeltaBrowserOpts): ViewSurfaceHandle | null {
  const turns = opts.turns.filter((turn) => turn.files.length > 0);
  if (turns.length === 0) return null;
  const mode = opts.mode ?? 'all';
  const filesByKey = new Map<string, SourceDeltaFile>();
  const turnsByIndex = new Map<number, SourceDeltaTurnSnapshot>();
  for (const turn of turns) {
    turnsByIndex.set(turn.turnIndex, turn);
    for (const file of turn.files) {
      filesByKey.set(`${turn.turnIndex}:${file.filePath}`, file);
    }
  }
  const options = buildSourceDeltaBrowserOptions(turns, mode);
  let handle: ViewSurfaceHandle | null = null;
  const previewCols = Math.max(48, Math.min(96, Math.floor(opts.termCols * 0.55)));
  const previewRows = Math.max(12, Math.min(36, opts.termRows - 8));
  const latest = turns[0]!;
  const titleBase = mode === 'files'
    ? 'File review'
    : mode === 'turns'
      ? 'Turn review'
      : 'Turn review';
  const title = turns.length > 1 ? `${titleBase} (${turns.length})` : `Turn diff #${latest.turnIndex}`;
  const presentation = resolvePickerChromePresentation({
    title,
    primaryAction: 'open',
    browseMode: true,
    filterable: options.length > 8,
    chromeSpec: {
      titleAlign: 'center',
    },
  });
  const select = new SelectView<SourceDeltaBrowserOptionValue>({
    options,
    searchable: options.length > 8,
    browseMode: true,
    visibleRows: Math.min(Math.max(options.length, 1), Math.max(8, Math.min(12, opts.termRows - 8))),
    previewMinWidth: 48,
    preview: (focused) => {
      if (isTurnRowValue(focused.value)) {
        const turn = turnsByIndex.get(focused.value.turnIndex);
        return turn ? renderSourceDeltaTurnPreview(turn) : C.muted('(missing turn)');
      }
      const file = filesByKey.get(`${focused.value.turnIndex}:${focused.value.filePath}`);
      return file ? renderSourceDeltaFilePreview(file, { cols: previewCols, maxLines: previewRows }) : C.muted('Pick a file row to preview its diff');
    },
    footerHint: (options.length > 8 ? presentation.footerHint.replace('open', 'close') : '') + (options.length > 8 ? ` · ${SOURCE_DELTA_BROWSER_MODE_HINT}` : ''),
    onSubmit: (picked) => {
      if (isTurnRowValue(picked as SourceDeltaBrowserOptionValue)) return;
      handle?.dispose();
    },
    onCancel: () => {
      opts.onCancel?.();
      handle?.dispose();
    },
  });
  const view = new BoxView(select, {
    ...resolveWidgetChromeBoxViewOptions(
      opts.theme,
      presentation.chromeSpec,
      title,
    ),
    titleRight: `${mode} · ${latest.stats.filesChanged}f +${latest.stats.linesAdded} -${latest.stats.linesRemoved}`,
  });
  const bounds = computePopupBounds(
    {
      anchorStartCol: Math.max(0, (opts.anchorCol ?? Math.floor(opts.termCols / 2)) - 1),
      anchorEndCol: Math.max(1, opts.anchorCol ?? Math.floor(opts.termCols / 2)),
      statusRow: opts.anchorRow ?? Math.floor(opts.termRows / 2),
      termCols: opts.termCols,
      termRows: opts.termRows,
    },
    {
      width: Math.max(72, Math.min(140, Math.floor(opts.termCols * 0.9))),
      height: Math.max(16, Math.min(opts.termRows - 2, 18)),
    },
  );
  handle = mountViewAsModalSurface({
    id: `source-delta-browser:${latest.turnIndex}:${Date.now().toString(36)}`,
    bounds,
    view,
    priority: 270,
    tier: 'popup',
  });
  return handle;
}

function sourceDeltaFileToEditResult(file: SourceDeltaFile): EditResult {
  return {
    ok: true,
    file_path: file.filePath,
    structuredPatch: file.hunks.map((hunk) => ({
      ...hunk,
      lines: [...hunk.lines],
    })),
    originalContent: file.originalContent,
    newContent: file.newContent,
    edits: [],
    linesAdded: file.linesAdded,
    linesRemoved: file.linesRemoved,
  };
}

function isTurnRowValue(value: SourceDeltaBrowserOptionValue): boolean {
  return value.filePath.startsWith(TURN_ROW_PREFIX);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
