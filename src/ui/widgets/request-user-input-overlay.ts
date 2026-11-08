// LC9 — RequestUserInputOverlay: multi-question queue.
//
// Direct port of codex's `RequestUserInputOverlay` (codex-rs/tui/
// src/bottom_pane/request_user_input/mod.rs:122-175). Wraps a
// VecDeque-like queue of questions and lets the user answer them
// in sequence, with optional back-navigation to revisit earlier
// answers. Each question is either a SelectView choice or a free-
// text input, plus optional notes (Tab toggles focus between the
// main answer area and the notes field).
//
// Matches workflow PLAN §7.3 "multi-question back-nav" without
// creating multiple modals.

import type { KeyEvent } from '../../plugins/core/types.js';
import type { WidgetChromeSpec } from '../declarative/spec.js';
import { resolveWidgetChromeBoxViewOptions } from '../declarative/presentation.js';
import { resolveModalDialogChromeSpec } from '../chrome/dialog-chrome.js';
import { BoxView, TextView, Consumed, Ignored, type EventResult, type FocusSource, type Size, type View } from '../view.js';
import type { Printer } from '../printer.js';
import { C } from '../../tui.js';
import { SelectView, type SelectOption } from './select-view.js';
import { EditView } from './edit-view.js';

export interface Question<T = unknown> {
  id: string;
  title: string;
  /** Provide one of: options (multiple choice) or inputType (free text). */
  options?: SelectOption<T>[];
  inputType?: { placeholder?: string; initialValue?: string };
  /** If true, Tab toggles between the answer area and a notes field. */
  allowNotes?: boolean;
  notesPlaceholder?: string;
}

export interface QuestionAnswer {
  questionId: string;
  value: unknown;
  notes?: string;
}

export interface RequestUserInputOverlaySpec {
  questions: Question[];
  allowBackNav?: boolean;
  onSubmit: (answers: QuestionAnswer[]) => void;
  onCancel?: () => void;
  chromeSpec?: WidgetChromeSpec;
}

type Focus = 'answer' | 'notes';

export class RequestUserInputOverlay implements View {
  private idx = 0;
  private answers: QuestionAnswer[] = [];
  private answerView!: View;
  private notesView: EditView | null = null;
  private notesText = '';
  private focus: Focus = 'answer';
  private root!: View;
  private currentValue: unknown = undefined;

  constructor(private spec: RequestUserInputOverlaySpec) {
    this.build();
  }

  private build(): void {
    const q = this.spec.questions[this.idx]!;
    const saved = this.answers[this.idx];
    this.currentValue = saved?.value;
    this.notesView = q.allowNotes
      ? new EditView({
          initialValue: typeof saved?.notes === 'string' ? saved.notes : '',
          placeholder: q.notesPlaceholder ?? 'notes (optional)',
          onChange: s => { this.notesText = s; },
        })
      : null;
    this.notesText = typeof saved?.notes === 'string' ? saved.notes : '';

    if (q.options) {
      const sel = new SelectView<unknown>({
        options: q.options,
        initialValue: saved?.value,
        onChange: v => { this.currentValue = v; },
        onSubmit: v => this.commitAnswer(v as unknown),
        onCancel: () => this.cancelOrBack(),
      });
      this.answerView = sel;
    } else {
      const edit = new EditView({
        placeholder: q.inputType?.placeholder,
        initialValue: typeof saved?.value === 'string'
          ? saved.value
          : q.inputType?.initialValue,
        onChange: s => { this.currentValue = s; },
        onSubmit: s => this.commitAnswer(s),
        onCancel: () => this.cancelOrBack(),
      });
      this.answerView = edit;
    }

    const header = new TextView(
      this.spec.questions.length > 1
        ? `${q.title}  ${C.muted(`(${this.idx + 1}/${this.spec.questions.length})`)}`
        : q.title,
    );

    const parts: View[] = [header, this.answerView];
    if (this.notesView) parts.push(this.notesView);
    const stack = new QuestionStack(parts);
    this.root = new BoxView(
      stack,
      resolveWidgetChromeBoxViewOptions(
        undefined,
        resolveModalDialogChromeSpec(q.title, this.spec.chromeSpec, 'center'),
        q.title,
      ),
    );
    this.focus = 'answer';
    this.answerView.takeFocus('front');
  }

  private commitAnswer(value: unknown): void {
    const q = this.spec.questions[this.idx]!;
    this.answers[this.idx] = {
      questionId: q.id,
      value,
      notes: this.notesText || undefined,
    };
    if (this.idx + 1 < this.spec.questions.length) {
      this.idx++;
      this.build();
      return;
    }
    this.spec.onSubmit(this.answers);
  }

  private cancelOrBack(): void {
    if (this.spec.allowBackNav && this.idx > 0) {
      this.idx--;
      this.answers.splice(this.idx + 1);
      this.build();
      return;
    }
    this.spec.onCancel?.();
  }

  draw(p: Printer): void { this.root.draw(p); }

  onEvent(ev: KeyEvent): EventResult {
    if (ev.name === 'tab' && this.notesView) {
      this.focus = this.focus === 'answer' ? 'notes' : 'answer';
      if (this.focus === 'answer') { this.notesView.blur(); this.answerView.takeFocus('front'); }
      else { (this.answerView as { blur?: () => void }).blur?.(); this.notesView.takeFocus('front'); }
      return Consumed();
    }
    if (this.focus === 'notes' && this.notesView) {
      return this.notesView.onEvent(ev);
    }
    return this.answerView.onEvent(ev);
  }

  layout(s: Size): void { this.root.layout(s); }
  requiredSize(c: Size): Size { return this.root.requiredSize(c); }
  takeFocus(src?: FocusSource): boolean { return this.root.takeFocus(src); }

  /** @internal */
  _state() {
    return {
      idx: this.idx,
      total: this.spec.questions.length,
      focus: this.focus,
      answers: [...this.answers],
      currentValue: this.currentValue,
    };
  }
}

// Tiny vertical stacker — we can't reuse LinearLayout here because
// we need to give the main answer view flex height while pinning
// the header (1 row) and notes (1 row).
class QuestionStack implements View {
  constructor(private children: View[]) {}

  draw(p: Printer): void {
    const hasNotes = this.children.length === 3;
    const headerH = 1;
    const notesH = hasNotes ? 1 : 0;
    const answerH = Math.max(0, p.height - headerH - notesH);
    let y = 0;
    this.children[0]!.draw(p.sub(0, y, p.width, headerH));
    y += headerH;
    this.children[1]!.draw(p.sub(0, y, p.width, answerH, { focused: p.focused }));
    y += answerH;
    if (hasNotes) this.children[2]!.draw(p.sub(0, y, p.width, notesH));
  }

  onEvent(ev: KeyEvent): EventResult { return this.children[1]!.onEvent(ev); }
  layout(s: Size): void { for (const c of this.children) c.layout(s); }
  requiredSize(c: Size): Size { return { width: c.width, height: Math.min(c.height, 10) }; }
  takeFocus(src?: FocusSource): boolean { return this.children[1]!.takeFocus(src); }
}
