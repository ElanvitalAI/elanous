// LC7 — PermissionPrompt widget.
//
// A SelectView preset for approval-style choices with an optional
// feedback-text phase on denial (the claude-code-fork pattern).
// Internally it is literally a SelectView — PermissionPrompt only
// wires the defaults (shortcut letters, feedbackPrompt with
// optionalFor, footer hint). Wrapper stays under 80 LOC.
//
// Motivation: elanous's `approval-modal.ts` is the canonical use —
// when the agent proposes an edit, the user picks Allow / Deny /
// Always, and on Deny we collect a one-line reason to feed back
// to the LLM. SelectView's feedbackPrompt already handles that;
// this wrapper just gives it a tidy constructor.

import { BoxView, type View } from '../view.js';
import type { Printer } from '../printer.js';
import type { KeyEvent } from '../../plugins/core/types.js';
import type { WidgetChromeSpec } from '../declarative/spec.js';
import { resolveWidgetChromeBoxViewOptions } from '../declarative/presentation.js';
import { resolvePickerChromePresentation } from '../chrome/picker-chrome.js';
import { SelectView, type SelectOption, type SelectViewSpec } from './select-view.js';
import type { EventResult, FocusSource, Size } from '../view.js';

export interface PermissionChoice<T> {
  value: T;
  label: string;
  /** Defaults to the first char of label. */
  shortcut?: string;
  description?: string;
  /** Positive choices skip the feedback prompt. */
  positive?: boolean;
}

export interface PermissionPromptSpec<T> {
  title: string;
  body?: string;
  choices: PermissionChoice<T>[];
  /** Defaults: placeholder 'Why?', maxLength 1000. */
  feedbackPlaceholder?: string;
  feedbackMaxLength?: number;
  chromeSpec?: WidgetChromeSpec;
  onSubmit: (value: T, feedback?: string) => void;
  onCancel?: () => void;
}

export class PermissionPrompt<T> implements View {
  private root: View;

  constructor(spec: PermissionPromptSpec<T>) {
    const presentation = resolvePickerChromePresentation({
      title: spec.title,
      primaryAction: 'confirm',
      browseMode: false,
      filterable: false,
      shortcutHint: 'shortcut letters pick directly',
      defaultVariant: 'dialog',
      chromeSpec: {
        titleAlign: 'center',
        ...spec.chromeSpec,
      },
    });
    const positives = spec.choices.filter(c => c.positive).map(c => c.value);

    const options: SelectOption<T>[] = spec.choices.map(c => ({
      value: c.value,
      label: c.label,
      description: c.description,
      shortcut: c.shortcut ?? c.label.charAt(0).toLowerCase(),
    }));

    const selectSpec: SelectViewSpec<T> = {
      title: spec.body ? `${spec.title}\n\n${spec.body}` : spec.title,
      options,
      feedbackPrompt: {
        placeholder: spec.feedbackPlaceholder ?? 'Why?',
        maxLength: spec.feedbackMaxLength ?? 1000,
        optionalFor: positives,
      },
      footerHint: presentation.footerHint,
      onSubmit: (picked, feedback) => spec.onSubmit(picked as T, feedback),
      onCancel: spec.onCancel,
    };

    const select = new SelectView<T>(selectSpec);
    this.root = new BoxView(
      select,
      resolveWidgetChromeBoxViewOptions(
        undefined,
        presentation.chromeSpec,
        spec.title,
      ),
    );
  }

  draw(p: Printer): void { this.root.draw(p); }
  onEvent(ev: KeyEvent): EventResult { return this.root.onEvent(ev); }
  layout(size: Size): void { this.root.layout(size); }
  requiredSize(c: Size): Size { return this.root.requiredSize(c); }
  takeFocus(src?: FocusSource): boolean { return this.root.takeFocus(src); }
}
