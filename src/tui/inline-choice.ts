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
  readonly includeOther?: boolean;
  /** Omit for an interactive prompt with no deadline. */
  readonly timeoutMs?: number;
}

export type InlineChoiceResult =
  | { readonly selected: readonly string[]; readonly otherText?: string }
  | { readonly selected: readonly []; readonly cancelled: true; readonly reason: 'cancelled' | 'timeout' };

export type InlineChoiceEvent =
  | { readonly id: string; readonly outcome: 'answered'; readonly selectedCount: number; readonly elapsedMs: number }
  | { readonly id: string; readonly outcome: 'cancelled' | 'timeout'; readonly elapsedMs: number };

export interface InlineChoiceDeps {
  readonly appendLines: (lines: readonly string[]) => void;
  readonly observe?: (event: InlineChoiceEvent) => void;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface InlineChoiceHandle {
  readonly promise: Promise<InlineChoiceResult>;
  /** Returns true only when this input was consumed by the prompt. */
  handleInput(input: string): boolean;
  cancel(): void;
}

export interface InlineChoiceBrokerDeps extends InlineChoiceDeps {}

/** One prompt slot shared by clarification and confirmation requests in a TUI turn. */
export class InlineChoiceBroker {
  private active: InlineChoiceHandle | null = null;
  private activeIdValue: string | null = null;

  constructor(private readonly deps: InlineChoiceBrokerDeps) {}

  get activeId(): string | null { return this.activeIdValue; }

  ask(spec: InlineChoiceSpec): Promise<InlineChoiceResult> {
    if (this.active) throw new Error('another inline choice is already active');
    const handle = createInlineChoice(spec, this.deps);
    this.active = handle;
    this.activeIdValue = spec.id;
    void handle.promise.finally(() => {
      if (this.active !== handle) return;
      this.active = null;
      this.activeIdValue = null;
    });
    return handle.promise;
  }

  /** Feed submitted text (including numeric replies injected through a PTY) to the active prompt. */
  handleInput(input: string): boolean {
    return this.active?.handleInput(input) ?? false;
  }

  cancel(): void { this.active?.cancel(); }
}

/** Cancel the prompt owned by a turn when that turn's streaming UI tears down. */
export function createInlineChoiceTurnEndCleanup(broker: InlineChoiceBroker): () => void {
  return () => broker.cancel();
}

export function formatInlineChoiceLines(spec: InlineChoiceSpec): string[] {
  const lines = ['', `  ${spec.question}`];
  spec.options.forEach((option, index) => {
    lines.push(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`);
  });
  if (spec.includeOther !== false) lines.push(`  ${spec.options.length + 1}. Other`);
  lines.push(spec.multiSelect ? '  여러 선택은 번호를 쉼표로 입력하세요. 취소: cancel' : '  번호 또는 Other 답을 입력하세요. 취소: cancel');
  return lines;
}

/** Start one inline prompt. A timed-out prompt resolves as cancelled, never as a guessed answer. */
export function createInlineChoice(
  spec: InlineChoiceSpec,
  deps: InlineChoiceDeps,
): InlineChoiceHandle {
  if (!spec.id.trim() || !spec.question.trim() || spec.options.length === 0) {
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
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolvePromise!: (result: InlineChoiceResult) => void;
  const promise = new Promise<InlineChoiceResult>((resolve) => { resolvePromise = resolve; });

  const finish = (result: InlineChoiceResult, outcome: InlineChoiceEvent['outcome']): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) cancelSchedule(timer);
    timer = null;
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

  deps.appendLines(formatInlineChoiceLines(spec));
  if (typeof spec.timeoutMs === 'number' && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) {
    timer = schedule(() => finish({ selected: [], cancelled: true, reason: 'timeout' }, 'timeout'), spec.timeoutMs);
  }

  return {
    promise,
    handleInput(input) {
      if (settled) return false;
      const value = input.trim();
      if (!value) return true;
      if (awaitingOtherText) {
        finish({ selected: [], otherText: value }, 'answered');
        return true;
      }
      if (/^(?:cancel|esc|escape)$/i.test(value)) {
        finish({ selected: [], cancelled: true, reason: 'cancelled' }, 'cancelled');
        return true;
      }

      const selectedIndexes = value.split(',').map((part) => part.trim());
      const numeric = selectedIndexes.every((part) => /^\d+$/.test(part));
      if (numeric) {
        const indexes = selectedIndexes.map(Number);
        const otherIndex = spec.options.length + 1;
        if (indexes.some((index) => index < 1 || index > otherIndex)
          || (!spec.multiSelect && indexes.length !== 1)) {
          deps.appendLines(['  선택한 번호를 확인해 다시 입력하세요.']);
          return true;
        }
        if (indexes.includes(otherIndex)) {
          if (indexes.length !== 1 || spec.includeOther === false) {
            deps.appendLines(['  Other는 단독으로 선택해야 합니다.']);
            return true;
          }
          awaitingOtherText = true;
          deps.appendLines(['  기타 답을 입력하세요.']);
          return true;
        }
        const selected = [...new Set(indexes)].map((index) => spec.options[index - 1]!.value);
        finish({ selected }, 'answered');
        return true;
      }

      if (spec.includeOther !== false) {
        finish({ selected: [], otherText: value }, 'answered');
        return true;
      }
      deps.appendLines(['  번호로 답하세요.']);
      return true;
    },
    cancel() {
      finish({ selected: [], cancelled: true, reason: 'cancelled' }, 'cancelled');
    },
  };
}

