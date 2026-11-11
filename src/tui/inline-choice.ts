import { debug } from '../debug/log.js';

/**
 * Non-modal, chat-input choice prompt. The caller renders `lines` in the chat
 * transcript and forwards submitted input to `handleInput`; this keeps the
 * normal input row visible and allows external PTY text injection to answer.
 */
export interface InlineChoiceOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface InlineChoiceSpec {
  readonly id: string;
  readonly question: string;
  readonly options: readonly InlineChoiceOption[];
  readonly multiSelect?: boolean;
  /** Two-option confirmation: y selects option 0; n and empty Enter select option 1. */
  readonly yesNo?: boolean;
  readonly includeOther?: boolean;
  /** Maximum option rows rendered at once; selection movement scrolls the window. */
  readonly maxVisibleOptions?: number;
  /** Omit for an interactive prompt with no deadline. */
  readonly timeoutMs?: number;
}

export type InlineChoiceResult =
  | { readonly selected: readonly string[]; readonly otherText?: string }
  | { readonly selected: readonly []; readonly cancelled: true; readonly reason: 'cancelled' | 'timeout' };

export type InlineChoiceEvent =
  | { readonly id: string; readonly outcome: 'answered'; readonly selectedCount: number; readonly elapsedMs: number }
  | { readonly id: string; readonly outcome: 'cancelled' | 'timeout'; readonly elapsedMs: number };

export type InlineChoiceInputResult = 'accepted' | 'rejected' | 'ignored';

export interface InlineChoiceStreamingKey {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
}

/** Remove the composer text that existed when a prompt opened from its submitted answer. */
export function splitInlineChoiceComposerInput(
  submittedText: string,
  draftPrefix: string,
): { readonly answer: string | null; readonly restoreText: string } {
  const explicitChoice = /^(?:y|yes|n|no|cancel|esc|escape|\d+(?:\s*,\s*\d+)*)$/i.test(submittedText.trim());
  // The draft is independently owned state. Only a suffix typed after the
  // unchanged draft (or an explicit short choice) is an answer; edits to the
  // draft are retained and become the next baseline instead of being misread.
  if (draftPrefix && !submittedText.startsWith(draftPrefix) && !explicitChoice) {
    return { answer: null, restoreText: submittedText };
  }
  return {
    answer: (draftPrefix && submittedText.startsWith(draftPrefix)
      ? submittedText.slice(draftPrefix.length)
      : submittedText).trim(),
    restoreText: draftPrefix,
  };
}

export interface InlineChoiceDeps {
  readonly appendLines: (lines: readonly string[]) => void;
  /** If present, owns a transient composer panel instead of adding prompt text to chat history. */
  readonly renderPanel?: (lines: readonly string[]) => void;
  readonly observe?: (event: InlineChoiceEvent) => void;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface InlineChoiceHandle {
  readonly promise: Promise<InlineChoiceResult>;
  /** Returns true only when this input was consumed by the prompt. */
  handleInput(input: string): boolean;
  /** Distinguishes a rejected answer from an accepted prompt response. */
  handleInputResult(input: string): InlineChoiceInputResult;
  handleKey(key: string): boolean;
  /** Consume explicit y/n keys while the TUI is streaming through typeahead. */
  handleStreamingKey(key: string | InlineChoiceStreamingKey): boolean;
  cancel(): void;
}

export interface InlineChoiceBrokerDeps extends InlineChoiceDeps {
  readonly onPromptStart?: () => void;
  readonly onPromptEnd?: () => void;
}

/** One prompt slot shared by clarification and confirmation requests in a TUI turn. */
export class InlineChoiceBroker {
  private active: InlineChoiceHandle | null = null;
  private activeIdValue: string | null = null;

  constructor(private readonly deps: InlineChoiceBrokerDeps) {}

  get activeId(): string | null { return this.activeIdValue; }

  ask(spec: InlineChoiceSpec): Promise<InlineChoiceResult> {
    if (this.active) throw new Error('another inline choice is already active');
    this.deps.onPromptStart?.();
    const handle = createInlineChoice(spec, this.deps);
    this.active = handle;
    this.activeIdValue = spec.id;
    void handle.promise.finally(() => {
      if (this.active !== handle) return;
      this.active = null;
      this.activeIdValue = null;
      this.deps.onPromptEnd?.();
    });
    return handle.promise;
  }

  /** Feed submitted text (including numeric replies injected through a PTY) to the active prompt. */
  handleInput(input: string): boolean {
    return this.handleInputResult(input) !== 'ignored';
  }

  handleInputResult(input: string): InlineChoiceInputResult {
    return this.active?.handleInputResult(input) ?? 'ignored';
  }

  handleKey(key: string): boolean { return this.active?.handleKey(key) ?? false; }

  handleStreamingKey(key: string | InlineChoiceStreamingKey): boolean { return this.active?.handleStreamingKey(key) ?? false; }

  cancel(): void { this.active?.cancel(); }
}

/** Cancel the prompt owned by a turn when that turn's streaming UI tears down. */
export function createInlineChoiceTurnEndCleanup(broker: InlineChoiceBroker): () => void {
  return () => broker.cancel();
}

export function formatInlineChoiceLines(spec: InlineChoiceSpec, selected = 0): string[] {
  const options = [
    ...spec.options.map((option, index) => ({
      index,
      label: `${spec.yesNo ? (index === 0 ? 'y' : 'n') : String(index + 1)}. ${option.label}${option.description ? ` — ${option.description}` : ''}`,
    })),
    ...(spec.includeOther !== false && !spec.yesNo ? [{ index: spec.options.length, label: `${spec.options.length + 1}. Other` }] : []),
  ];
  const maxVisible = Math.max(1, Math.min(6, Math.floor(spec.maxVisibleOptions ?? 4)));
  const visibleCount = Math.min(options.length, maxVisible);
  const start = Math.max(0, Math.min(selected - visibleCount + 1, options.length - visibleCount));
  const end = start + visibleCount;
  const lines = ['', `  ${spec.question}`];
  if (start > 0) lines.push(`  ↑ ${start}개 이전 선택지`);
  for (const option of options.slice(start, end)) {
    lines.push(`  ${option.index === selected ? '▸' : ' '} ${option.label}`);
  }
  if (end < options.length) lines.push(`  ↓ ${options.length - end}개 다음 선택지`);
  lines.push(spec.yesNo ? '  y/n · 기본 n · Esc 취소' : spec.multiSelect ? '  여러 선택은 번호를 쉼표로 입력하세요. Other 입력 · Esc 취소' : '  번호 또는 Other 답을 입력하세요. Esc 취소');
  return lines;
}

/** Start one inline prompt. A timed-out prompt resolves as cancelled, never as a guessed answer. */
export function createInlineChoice(
  spec: InlineChoiceSpec,
  deps: InlineChoiceDeps,
): InlineChoiceHandle {
  if (!spec.id.trim() || !spec.question.trim() || spec.options.length === 0 || (spec.yesNo && spec.options.length !== 2)) {
    throw new Error('inline choice requires an id, question, and at least one option');
  }
  const now = deps.now ?? Date.now;
  const observe = deps.observe ?? ((event: InlineChoiceEvent) => {
    debug.log('tui.inline-choice', 'settled', event);
  });
  const schedule = deps.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = deps.cancelSchedule ?? clearTimeout;
  const startedAt = now();
  let settled = false;
  let awaitingOtherText = false;
  let keyboardSelectionReady = false;
  let selectedIndex = spec.yesNo ? 1 : 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolvePromise!: (result: InlineChoiceResult) => void;
  const promise = new Promise<InlineChoiceResult>((resolve) => { resolvePromise = resolve; });
  let legacyInitialRendered = false;

  const finish = (result: InlineChoiceResult, outcome: InlineChoiceEvent['outcome']): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) cancelSchedule(timer);
    timer = null;
    deps.renderPanel?.([]);
    const elapsedMs = Math.max(0, now() - startedAt);
    try {
      if (outcome === 'answered') {
        const hasOtherText = 'otherText' in result && Boolean(result.otherText);
        observe({ id: spec.id, outcome, selectedCount: result.selected.length + (hasOtherText ? 1 : 0), elapsedMs });
      } else {
        observe({ id: spec.id, outcome, elapsedMs });
      }
    } catch { /* logging must never strand an interactive turn */ }
    resolvePromise(result);
  };

  const renderPanel = (feedback?: string): void => {
    const lines = formatInlineChoiceLines(spec, selectedIndex);
    if (deps.renderPanel) deps.renderPanel(feedback ? [...lines, `  ${feedback}`] : lines);
    else if (feedback) deps.appendLines([`  ${feedback}`]);
    else if (!legacyInitialRendered) {
      deps.appendLines(lines);
      legacyInitialRendered = true;
    }
  };
  renderPanel();
  if (typeof spec.timeoutMs === 'number' && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) {
    timer = schedule(() => finish({ selected: [], cancelled: true, reason: 'timeout' }, 'timeout'), spec.timeoutMs);
  }

  const handleInputResult = (input: string): InlineChoiceInputResult => {
    if (settled) return 'ignored';
    const value = input.trim();
    if (!value) {
      if (spec.yesNo || keyboardSelectionReady) {
        if (spec.includeOther !== false && selectedIndex === spec.options.length) {
          awaitingOtherText = true;
          renderPanel('기타 답을 입력하세요.');
        } else finish({ selected: [spec.options[selectedIndex]!.value] }, 'answered');
      }
      return 'accepted';
    }
    if (awaitingOtherText) {
      finish({ selected: [], otherText: value }, 'answered');
      return 'accepted';
    }
    if (/^(?:cancel|esc|escape)$/i.test(value)) {
      finish({ selected: [], cancelled: true, reason: 'cancelled' }, 'cancelled');
      return 'accepted';
    }
    if (spec.yesNo && /^(?:y|yes|n|no)$/i.test(value)) {
      const index = value.toLowerCase().startsWith('y') ? 0 : 1;
      finish({ selected: [spec.options[index]!.value] }, 'answered');
      return 'accepted';
    }

    const selectedIndexes = value.split(',').map((part) => part.trim());
    const numeric = selectedIndexes.every((part) => /^\d+$/.test(part));
    if (numeric) {
      const indexes = selectedIndexes.map(Number);
      const otherIndex = spec.options.length + 1;
      if (indexes.some((index) => index < 1 || index > otherIndex)
        || (!spec.multiSelect && indexes.length !== 1)) {
        renderPanel('선택한 번호를 확인해 다시 입력하세요.');
        return 'rejected';
      }
      if (indexes.includes(otherIndex)) {
        if (indexes.length !== 1 || spec.includeOther === false) {
          renderPanel('Other는 단독으로 선택해야 합니다.');
          return 'rejected';
        }
        awaitingOtherText = true;
        renderPanel('기타 답을 입력하세요.');
        return 'accepted';
      }
      const selected = [...new Set(indexes)].map((index) => spec.options[index - 1]!.value);
      finish({ selected }, 'answered');
      return 'accepted';
    }

    if (spec.includeOther !== false) {
      finish({ selected: [], otherText: value }, 'answered');
      return 'accepted';
    }
    renderPanel('번호로 답하세요.');
    return 'rejected';
  };

  return {
    promise,
    handleInput: (input) => handleInputResult(input) !== 'ignored',
    handleInputResult,
    handleKey(key) {
      if (settled) return false;
      if (key === 'escape') {
        finish({ selected: [], cancelled: true, reason: 'cancelled' }, 'cancelled');
        return true;
      }
      if (key === 'up' || key === 'down') {
        const count = spec.options.length + (spec.includeOther === false ? 0 : 1);
        selectedIndex = (selectedIndex + (key === 'up' ? -1 : 1) + count) % count;
        keyboardSelectionReady = true;
        renderPanel();
        return true;
      }
      return false;
    },
    handleStreamingKey(key) {
      if (typeof key !== 'string' && (key.ctrl || key.alt || key.shift || key.meta)) return false;
      const name = typeof key === 'string' ? key : key.name ?? '';
      if (!spec.yesNo || !/^(?:y|yes|n|no)$/i.test(name)) return false;
      return this.handleInput(name);
    },
    cancel() {
      finish({ selected: [], cancelled: true, reason: 'cancelled' }, 'cancelled');
    },
  };
}

