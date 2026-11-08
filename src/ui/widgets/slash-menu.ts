// LC9 — SlashMenu: searchable slash-command picker.
//
// Thin SelectView wrapper. The user presses '/' (or Ctrl-R for
// reverse-search, whatever the host wires up) and sees a list of
// known commands, each with a shortcut description. Typing filters
// the list in place (codex style). Enter runs the command.

import type { Printer } from '../printer.js';
import type { KeyEvent } from '../../plugins/core/types.js';
import type { WidgetChromeSpec } from '../declarative/spec.js';
import { resolveWidgetChromeBoxViewOptions } from '../declarative/presentation.js';
import { resolvePickerChromePresentation } from '../chrome/picker-chrome.js';
import type { EventResult, FocusSource, Size, View } from '../view.js';
import { BoxView } from '../view.js';
import { SelectView, type SelectOption } from './select-view.js';

export interface SlashCommand {
  /** "/switch", "/status" — shown to the user verbatim. */
  name: string;
  description: string;
  /** If omitted, onRun is invoked with the command name alone. */
  category?: string;
  onRun: () => void;
}

export interface SlashMenuSpec {
  commands: SlashCommand[];
  title?: string;
  onCancel?: () => void;
  chromeSpec?: WidgetChromeSpec;
}

export class SlashMenu implements View {
  private root: View;

  constructor(spec: SlashMenuSpec) {
    const presentation = resolvePickerChromePresentation({
      title: spec.title ?? 'Commands',
      primaryAction: 'run',
      browseMode: true,
      filterable: true,
      chromeSpec: {
        titleAlign: 'center',
        ...spec.chromeSpec,
      },
    });
    const options: SelectOption<string>[] = spec.commands.map(c => ({
      value: c.name,
      label: c.name,
      description: c.category ? `${c.category}  ·  ${c.description}` : c.description,
      action: c.onRun,
    }));
    const select = new SelectView<string>({
      title: spec.title,
      options,
      searchable: true,
      browseMode: true,
      visibleRows: Math.min(options.length, 10),
      footerHint: presentation.footerHint,
      onSubmit: () => {},       // action closure runs inside SelectView
      onCancel: spec.onCancel,
    });
    this.root = new BoxView(select, resolveWidgetChromeBoxViewOptions(
      undefined,
      presentation.chromeSpec,
      spec.title ?? 'Commands',
    ));
  }

  draw(p: Printer): void { this.root.draw(p); }
  onEvent(ev: KeyEvent): EventResult { return this.root.onEvent(ev); }
  layout(s: Size): void { this.root.layout(s); }
  requiredSize(c: Size): Size { return this.root.requiredSize(c); }
  takeFocus(src?: FocusSource): boolean { return this.root.takeFocus(src); }
}
