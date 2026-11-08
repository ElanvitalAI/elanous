// LC10 — FileDialog: directory-aware picker.
//
// A SelectView whose options are directory entries. Enter on a
// directory navigates into it; Enter on a file picks it (open mode)
// or returns its name (save mode); dir mode picks the CURRENT path.
// A breadcrumb of the current path paints above the list.
//
// Directory reading is injected (readDir callback) so the widget
// itself doesn't depend on Node's fs — hosts that want SWD-aware
// paths pass a readDir that scopes under the session working dir.

import type { KeyEvent } from '../../plugins/core/types.js';
import { C } from '../../tui.js';
import type { WidgetChromeSpec } from '../declarative/spec.js';
import { resolveWidgetChromeBoxViewOptions } from '../declarative/presentation.js';
import {
  buildPickerFooterHint,
  resolvePickerChromePresentation,
  resolvePickerChromeSpec,
} from '../chrome/picker-chrome.js';
import type { Printer } from '../printer.js';
import { BoxView, type EventResult, type FocusSource, type Size, type View, Consumed } from '../view.js';
import { SelectView, type SelectOption } from './select-view.js';

export type FileDialogMode = 'open' | 'save' | 'dir';

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  hidden?: boolean;
}

export interface FileDialogSpec {
  startDir: string;
  mode: FileDialogMode;
  readDir: (path: string) => FileEntry[] | Promise<FileEntry[]>;
  showHidden?: boolean;
  defaultName?: string;
  onSubmit: (path: string) => void;
  onCancel?: () => void;
  /** MD4 — forwards to the internal SelectView. When true, a single
   *  click only highlights a row; double-click navigates into a
   *  directory or opens the file. Classic desktop convention. Default
   *  false keeps the MX-era "click == submit" behaviour so existing
   *  call sites don't change. */
  browseMode?: boolean;
  chromeSpec?: WidgetChromeSpec;
}

export class FileDialog implements View {
  private cwd: string;
  private entries: FileEntry[] = [];
  private select: SelectView<string>;
  private root: View;
  private loading = false;
  private focused = false;

  constructor(private spec: FileDialogSpec) {
    this.cwd = normalizePath(spec.startDir);
    this.select = this.buildSelect();
    this.root = this.buildRoot(this.select);
    void this.load();
  }

  private titleLine(): string {
    const crumb = this.cwd;
    const modeTag =
      this.spec.mode === 'open' ? 'Open' :
      this.spec.mode === 'save' ? 'Save' : 'Pick dir';
    return `${modeTag} — ${crumb}`;
  }

  private async load(): Promise<void> {
    this.loading = true;
    const got = await this.spec.readDir(this.cwd);
    const visible = (this.spec.showHidden ?? false) ? got : got.filter(e => !e.hidden && !e.name.startsWith('.'));
    visible.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    this.entries = visible;
    this.select = this.buildSelect();
    this.root = this.buildRoot(this.select);
    if (this.focused) this.select.takeFocus('front');
    this.loading = false;
  }

  private buildRoot(view: View): View {
    return new BoxView(view, resolveWidgetChromeBoxViewOptions(
      undefined,
      resolvePickerChromeSpec(this.chromeSpec()),
      this.titleLine(),
    ));
  }

  private chromeSpec() {
    return {
      title: this.titleLine(),
      primaryAction: this.spec.mode === 'save'
        ? 'save here'
        : this.spec.mode === 'dir'
          ? 'enter dir'
          : 'open',
      browseMode: this.spec.browseMode,
      filterable: true,
      chromeSpec: {
        titleAlign: 'center',
        ...this.spec.chromeSpec,
      },
    } as const;
  }

  private buildSelect(): SelectView<string> {
    const options: SelectOption<string>[] = [
      { value: '..', label: '..', description: 'Parent directory' },
      ...this.entries.map(e => ({
        value: e.name,
        label: e.isDirectory ? `${e.name}/` : e.name,
        description: e.isDirectory ? 'dir' : undefined,
      })),
    ];
    const footer = this.spec.mode === 'dir'
      ? buildPickerFooterHint({
          title: this.titleLine(),
          primaryAction: 'enter dir',
          browseMode: this.spec.browseMode,
          secondaryAction: 'Ctrl+Enter pick THIS dir',
        })
      : resolvePickerChromePresentation(this.chromeSpec()).footerHint;
    return new SelectView<string>({
      options,
      searchable: true,
      visibleRows: 10,
      footerHint: footer,
      browseMode: this.spec.browseMode,
      onSubmit: v => this.handlePick(v as string),
      onCancel: () => this.spec.onCancel?.(),
    });
  }

  private handlePick(name: string): void {
    if (name === '..') {
      this.cwd = parentOf(this.cwd);
      void this.load();
      return;
    }
    const entry = this.entries.find(e => e.name === name);
    if (entry?.isDirectory && this.spec.mode !== 'dir') {
      this.cwd = joinPath(this.cwd, name);
      void this.load();
      return;
    }
    const fullPath = entry ? joinPath(this.cwd, name) : joinPath(this.cwd, this.spec.defaultName ?? name);
    this.spec.onSubmit(fullPath);
  }

  draw(p: Printer): void {
    this.root.draw(p);
    if (this.loading && p.height > 1) p.text(1, 1, C.muted('loading…'));
  }

  onEvent(ev: KeyEvent): EventResult {
    // Ctrl+Enter in dir mode picks the CURRENT cwd
    if (this.spec.mode === 'dir' && ev.ctrl && ev.name === 'enter') {
      this.spec.onSubmit(this.cwd);
      return Consumed();
    }
    return this.root.onEvent(ev);
  }

  layout(s: Size): void { this.root.layout(s); }
  requiredSize(c: Size): Size { return this.root.requiredSize(c); }
  takeFocus(src?: FocusSource): boolean { this.focused = true; return this.root.takeFocus(src); }

  /** @internal */ _state() { return { cwd: this.cwd, entryCount: this.entries.length, loading: this.loading }; }
}

function normalizePath(p: string): string {
  if (!p) return '/';
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}

function parentOf(p: string): string {
  if (p === '/' || p === '') return '/';
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
}

function joinPath(a: string, b: string): string {
  if (a === '/' || a === '') return '/' + b;
  return `${a}/${b}`;
}
