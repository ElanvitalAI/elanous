// Full-screen wizard IO — Phase 5 (PR δ).
//
// Backs `WizardIO` with a single-screen, box-rendering UX that
// `console.clear()`s + redraws on every key event. Does NOT enter
// altscreen — RESEARCH-tui-installer §5.A1 explicitly warns altscreen
// breaks redirect / scrollback / IDE integration.
//
// Lifecycle:
//   - `fullScreenIO()` returns the `WizardIO` immediately. The first
//     `choose` / `ask` / `askSecret` call enters raw mode + hides the
//     cursor + clears the screen. `close()` restores raw mode + cursor
//     + flushes any unflushed message buffer.
//   - `print()` calls during raw mode are buffered (banner / SGR rule
//     lines auto-skipped) and shown above the next prompt's box body.
//   - `showStep(spec)` only stores the current step header — actual
//     paint waits for the next prompt.
//   - `showError` / `showHelp` / `showSuccess` push into the message
//     buffer with appropriate styling.
//
// Tests rely on the same pure renderer (`screen-renderer.ts`) — this
// file is the I/O layer, the renderer is the math.
//
// Falls back to `realIO` automatically when stdin is not a TTY (CI /
// pipe / test) — `defaultIO()` in `onboarding.ts` makes that decision.

import { stdin, stdout } from 'node:process';
import type { WizardIO } from '../onboarding.js';
import type { StepSpec, ChoiceOption, ChooseOpts } from './io-extended.js';
import { fuzzyFilter } from './io-extended.js';
import {
  composeFullPaint,
  ANSI_CLEAR_HOME,
  ANSI_HIDE_CURSOR,
  ANSI_SHOW_CURSOR,
  type ScreenSpec,
  type ScreenOption,
} from './screen-renderer.js';
import { debug } from '../debug/log.js';

const DEFAULT_FOOTER_PICKER = '↑/↓ pick · 1-9 quick · Enter ↵ confirm · Ctrl-C cancel';
const DEFAULT_FOOTER_PICKER_FUZZY = '↑/↓ pick · 1-9 quick · type filter · ESC clear/cancel · Enter ↵';
const DEFAULT_FOOTER_INPUT = 'Enter ↵ confirm · Ctrl-C cancel';

const DEFAULT_FUZZY_THRESHOLD = 10;

interface BufferedMessage {
  text: string;
  kind: 'plain' | 'error' | 'help' | 'success';
}

interface PendingStep {
  index: number;
  total: number;
  title: string;
  excerpt?: string;
  severity?: 'required' | 'optional' | 'advanced';
  skipBehavior?: string;
}

/** Internal raw-key descriptor — minimal subset of `tui.ts`'s `Key`. */
interface MiniKey {
  name: string; // 'up' | 'down' | 'left' | 'right' | 'enter' | 'backspace' | 'esc' | 'tab' | char
  ctrl: boolean;
  raw: string;
}

export interface FullScreenIOOpts {
  /** Override stdin/stdout for tests. Defaults to process streams. */
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Skip raw-mode entry — useful when the host already owns raw mode
   *  (dashboard `/setup` overlay, future). */
  skipRawMode?: boolean;
}

export function fullScreenIO(opts: FullScreenIOOpts = {}): WizardIO {
  const inp = opts.input ?? stdin;
  const out = opts.output ?? stdout;

  let rawEntered = false;
  let messages: BufferedMessage[] = [];
  let currentStep: PendingStep | null = null;

  const enterRaw = (): void => {
    if (rawEntered || opts.skipRawMode) return;
    if (!inp.isTTY) return;
    inp.setRawMode(true);
    inp.setEncoding('utf8');
    inp.resume();
    out.write(ANSI_HIDE_CURSOR);
    rawEntered = true;
    if (debug.enabled) {
      debug.log('onboarding.fullScreenIO.enterRaw', 'raw mode + hide cursor', {});
    }
  };

  const exitRaw = (): void => {
    if (!rawEntered) return;
    out.write(ANSI_SHOW_CURSOR);
    if (inp.isTTY) {
      inp.setRawMode(false);
      inp.pause();
    }
    rawEntered = false;
    if (debug.enabled) {
      debug.log('onboarding.fullScreenIO.exitRaw', 'raw mode off + cursor restored', {});
    }
  };

  const handleSigInt = (): void => {
    exitRaw();
    out.write(ANSI_CLEAR_HOME);
    out.write('Setup cancelled.\n');
    process.exit(130);
  };

  const composeMessageLines = (): string[] => {
    if (messages.length === 0) return [];
    return messages.map((m) => {
      if (m.kind === 'error') return '! ' + m.text;
      if (m.kind === 'help') return '↳ ' + m.text;
      if (m.kind === 'success') return '✓ ' + m.text;
      return m.text;
    });
  };

  const buildScreenSpec = (
    body: ScreenSpec['body'],
    footer?: string,
  ): ScreenSpec => {
    const step = currentStep ?? { index: 1, total: 6, title: 'Setup' };
    const messageLines = composeMessageLines();
    const excerpt = [...messageLines, step.excerpt ?? ''].filter(Boolean).join('\n').trim();
    return {
      stepIndex: step.index,
      stepTotal: step.total,
      title: step.title,
      severity: step.severity,
      excerpt: excerpt.length > 0 ? excerpt : undefined,
      skipBehavior: step.skipBehavior,
      body,
      footer,
    };
  };

  const paint = (spec: ScreenSpec): void => {
    out.write(composeFullPaint(spec));
  };

  // OB4(2026-10-01 · 0.2.6 실물): print() 는 «다음 질문 화면»에 묻어 그린다 — 그런데 기기 코드 로그인처럼
  //   질문 없이 오래 기다리는 구간에선 다음 화면이 오지 않아 코드·URL 이 끝내 안 보이고, 원시 모드라 Ctrl-C 도
  //   신호가 안 돼 «멈춤»이 됐다. 질문이 없을 때 print 는 곧바로 메시지 화면을 그리고 Ctrl-C 감시를 붙인다.
  let questionDepth = 0;
  let idleWatcher: ((chunk: string | Buffer) => void) | null = null;
  const detachIdleWatcher = (): void => {
    if (idleWatcher) { inp.off('data', idleWatcher); idleWatcher = null; }
  };
  const attachIdleWatcher = (): void => {
    if (idleWatcher || !inp.isTTY) return;
    idleWatcher = (chunk) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (s.includes('\x03')) handleSigInt();
    };
    inp.on('data', idleWatcher);
  };
  const inQuestion = async <R>(fn: () => Promise<R>): Promise<R> => {
    detachIdleWatcher();
    questionDepth++;
    try { return await fn(); } finally { questionDepth--; }
  };

  // ── Raw key reader ──────────────────────────────────────────────
  const readKey = (): Promise<MiniKey> =>
    new Promise((resolve) => {
      const onData = (chunk: string | Buffer): void => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        inp.off('data', onData);
        resolve(parseMiniKey(s));
      };
      inp.on('data', onData);
    });

  // ── choose ─────────────────────────────────────────────────────
  const choose = <T>(
    prompt: string,
    options: ChoiceOption<T>[],
    opts: ChooseOpts = {},
  ): Promise<T> => inQuestion(() => chooseInner(prompt, options, opts));
  const chooseInner = async <T>(
    prompt: string,
    options: ChoiceOption<T>[],
    opts: ChooseOpts = {},
  ): Promise<T> => {
    if (options.length === 0) {
      throw new Error('fullScreenIO.choose: options array must not be empty.');
    }
    enterRaw();
    // PR-Δ23b (Sprint 18 · 2026-04-30) — fuzzy typing buffer mode.
    // When options.length ≥ threshold (default 10, matches Δ23
    // chooseFrom fallback), the picker activates a typing buffer:
    // printable chars narrow the visible list via fuzzyFilter, ↑/↓
    // navigates the filtered subset, 1-9 picks from the filtered
    // subset, ESC with non-empty buffer clears the filter (ESC with
    // empty buffer cancels). Letter quick-pick is intentionally
    // disabled in fuzzy mode — letters feed the buffer instead.
    const fuzzyThreshold = opts.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
    const fuzzyEnabled = options.length >= fuzzyThreshold;
    const defaultIdx = clampIdx(opts.defaultIndex ?? 0, options.length);
    let typingBuffer = '';
    let filtered: ChoiceOption<T>[] = options;
    let selected = defaultIdx;

    const recomputeFiltered = (): void => {
      filtered = fuzzyFilter(options, typingBuffer);
      selected = filtered.length > 0
        ? Math.min(Math.max(0, selected), filtered.length - 1)
        : 0;
    };

    // PR-Δ18 (Sprint 15 · 2026-04-28) — Sprint 12 의 yesno horizontal
    // radio body 폐기. 사용자 피드백: 라벨이 글자 (예 "Yes — keep them")
    // 일 때 박스 frame 이 라벨과 overlap. 모든 picker (y/n 포함) 가
    // vertical numbered list — ↑/↓ keypad 만으로 충분 + y/n quick
    // 유지 (Sprint 9b 한글 jamo 도 그대로).
    const buildBody = (): ScreenSpec['body'] => {
      const screenOptions: ScreenOption[] = filtered.map((o, i) => ({
        numeric: i + 1,
        label: o.label,
        hint: o.description,
      }));
      return {
        kind: 'options' as const,
        options: screenOptions,
        selected,
        help: opts.help ?? prompt,
        filter: fuzzyEnabled ? typingBuffer : undefined,
        fullCount: fuzzyEnabled ? options.length : undefined,
      };
    };
    const footer = fuzzyEnabled ? DEFAULT_FOOTER_PICKER_FUZZY : DEFAULT_FOOTER_PICKER;

    if (debug.enabled) {
      debug.log('onboarding.fullScreenIO.choose.enter', prompt, {
        optionsCount: options.length,
        defaultIndex: selected,
        helpText: opts.help,
        fuzzyEnabled,
        fuzzyThreshold,
      });
    }

    while (true) {
      paint(buildScreenSpec(buildBody(), footer));
      const k = await readKey();
      if (k.ctrl && k.name === 'c') {
        handleSigInt();
        return options[0].value; // unreachable
      }
      if (k.name === 'esc') {
        // PR-Δ23b — ESC with non-empty buffer = clear filter (rewind
        // to full list). ESC with empty buffer = cancel (legacy).
        if (fuzzyEnabled && typingBuffer.length > 0) {
          if (debug.enabled) {
            debug.log('onboarding.fullScreenIO.fuzzy.clear', 'ESC clear buffer', {
              wasBuffer: typingBuffer,
            });
          }
          typingBuffer = '';
          selected = defaultIdx;
          recomputeFiltered();
          continue;
        }
        handleSigInt();
        return options[0].value;
      }
      if (k.name === 'up' || k.name === 'k') {
        if (filtered.length > 0) {
          selected = (selected - 1 + filtered.length) % filtered.length;
        }
        continue;
      }
      if (k.name === 'down' || k.name === 'j') {
        if (filtered.length > 0) {
          selected = (selected + 1) % filtered.length;
        }
        continue;
      }
      if (k.name === 'enter') {
        if (filtered.length === 0) continue;
        messages = [];
        if (debug.enabled) {
          debug.log('onboarding.fullScreenIO.choose.confirm', `pick ${selected}`, {
            picked: filtered[selected].label,
            fuzzyActive: fuzzyEnabled && typingBuffer.length > 0,
            buffer: typingBuffer,
          });
        }
        return filtered[selected].value;
      }
      if (k.name === 'backspace') {
        // PR-Δ23b — Backspace pops one char from the typing buffer
        // when fuzzy is active. No-op otherwise (keeps legacy parity).
        if (fuzzyEnabled && typingBuffer.length > 0) {
          typingBuffer = typingBuffer.slice(0, -1);
          recomputeFiltered();
          if (debug.enabled) {
            debug.log('onboarding.fullScreenIO.fuzzy.backspace', '', {
              buffer: typingBuffer,
              matches: filtered.length,
            });
          }
        }
        continue;
      }
      // numeric quick-pick (1-9 → idx 0-8). In fuzzy mode the index
      // resolves against the FILTERED list so `1` = filtered[0]; in
      // legacy mode it resolves against the original options array.
      const num = parseInt(k.name, 10);
      if (Number.isFinite(num) && num >= 1 && num <= 9) {
        const list = fuzzyEnabled ? filtered : options;
        if (num <= list.length) {
          selected = num - 1;
          paint(buildScreenSpec(buildBody(), footer));
          messages = [];
          if (debug.enabled) {
            debug.log('onboarding.fullScreenIO.choose.confirm', `quick ${num}`, {
              picked: list[selected].label,
              fuzzyActive: fuzzyEnabled && typingBuffer.length > 0,
            });
          }
          return list[selected].value;
        }
        continue; // digit out of range — ignore
      }
      // PR-Δ23b — fuzzy mode: any printable char feeds the typing
      // buffer (replaces letter quick-pick path). Backspace + ESC
      // are handled above. yesno picker (length 2) never enters
      // fuzzy mode because length < threshold, so the y/n quick-pick
      // path stays intact.
      if (fuzzyEnabled && k.raw.length > 0 && !isControlChar(k.raw)) {
        typingBuffer += k.raw;
        recomputeFiltered();
        if (debug.enabled) {
          debug.log('onboarding.fullScreenIO.fuzzy.type', k.raw, {
            buffer: typingBuffer,
            matches: filtered.length,
          });
        }
        continue;
      }
      // letter quick-pick — case-insensitive ChoiceOption.key match.
      // Critical for Yes/No prompts where users expect 'y'/'Y' to confirm
      // immediately (PR #957's original implementation only honored 1-9).
      // Sprint 9b — also accept Hangul jamo emitted by the Korean IME so
      // 한/영 toggle is not required to answer y/n.
      // Disabled in fuzzy mode (handled by the printable-char branch above).
      if (!fuzzyEnabled) {
        const keyChar = normalizeKeyForMatch(k.name);
        const byKey = options.findIndex((o) => o.key.toLowerCase() === keyChar);
        if (byKey >= 0) {
          selected = byKey;
          paint(buildScreenSpec(buildBody(), footer));
          messages = [];
          return options[selected].value;
        }
      }
      // unknown key → ignore (no flicker; loop redraws on next event)
    }
  };

  // ── ask ────────────────────────────────────────────────────────
  const ask = async (prompt: string): Promise<string> => {
    return inQuestion(() => askInternal(prompt, false));
  };

  const askSecret = async (prompt: string): Promise<string> => {
    return inQuestion(() => askInternal(prompt, true));
  };

  const askInternal = async (prompt: string, mask: boolean): Promise<string> => {
    enterRaw();
    let buffer = '';
    if (debug.enabled) {
      debug.log('onboarding.fullScreenIO.ask.enter', prompt, { mask });
    }
    while (true) {
      paint(
        buildScreenSpec(
          {
            kind: 'input',
            field: { label: stripPromptPunctuation(prompt), value: buffer, mask },
          },
          DEFAULT_FOOTER_INPUT,
        ),
      );
      const k = await readKey();
      if (k.ctrl && k.name === 'c') {
        handleSigInt();
        return '';
      }
      if (k.name === 'enter') {
        messages = [];
        if (debug.enabled) {
          debug.log('onboarding.fullScreenIO.ask.confirm', prompt, {
            length: buffer.length,
            mask,
          });
        }
        return buffer.trim();
      }
      if (k.name === 'backspace') {
        buffer = buffer.slice(0, -1);
        continue;
      }
      if (k.name === 'esc') {
        handleSigInt();
        return '';
      }
      // Append printable chars (single-byte ASCII or any non-control sequence)
      if (k.raw.length > 0 && !isControlChar(k.raw)) {
        buffer += k.raw;
      }
    }
  };

  // ── print + status helpers ─────────────────────────────────────
  const print = (text: string): void => {
    if (!rawEntered) {
      // Outside raw mode (very early or after close) — direct write.
      out.write(text + '\n');
      return;
    }
    // Skip the top-level banner rule + intro lines while inside the
    // box — the wizard frame already contains the same info.
    if (isBannerLine(text)) return;
    messages.push({ text, kind: 'plain' });
    if (questionDepth === 0) {
      paint(buildScreenSpec({ kind: 'message', lines: [] }, 'Ctrl-C cancel'));
      attachIdleWatcher();
    }
  };

  return {
    ask,
    askSecret,
    print,
    close: () => {
      detachIdleWatcher();
      exitRaw();
      // Final clear so any leftover screen does not interfere with
      // the post-wizard CLI banner / dashboard.
      out.write(ANSI_CLEAR_HOME);
      // Flush any unprinted messages so the user sees the closing
      // confirmation.
      if (messages.length > 0) {
        for (const m of composeMessageLines()) out.write(m + '\n');
        messages = [];
      }
    },
    choose,
    showStep: (spec: StepSpec) => {
      currentStep = {
        index: spec.index,
        total: spec.total,
        title: spec.title,
        excerpt: spec.excerpt,
        severity: spec.severity,
        skipBehavior: spec.skipBehavior,
      };
      // No paint here — the next choose/ask renders with this step.
      if (debug.enabled) {
        debug.log('onboarding.fullScreenIO.showStep', `step ${spec.index}/${spec.total}`, {
          index: spec.index,
          total: spec.total,
          title: spec.title,
        });
      }
    },
    showError: (field, message) => {
      messages.push({ text: `${field}: ${message}`, kind: 'error' });
    },
    showHelp: (field, message) => {
      messages.push({ text: `${field}: ${message}`, kind: 'help' });
    },
    showSuccess: (message) => {
      messages.push({ text: message, kind: 'success' });
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function clampIdx(n: number, len: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n >= len) return len - 1;
  return n;
}

/** Strip the trailing `:` + spaces + leading whitespace the legacy
 *  step functions append (e.g. `"Bot Token: "` → `"Bot Token"`). */
function stripPromptPunctuation(prompt: string): string {
  return prompt.trimEnd().replace(/\s*:\s*$/, '').replace(/^\s+/, '');
}

/** Lines we suppress while inside the box — the box frame already
 *  contains the same info. */
function isBannerLine(text: string): boolean {
  if (text.length === 0) return true;
  if (text.startsWith('━━━')) return true; // banner rule
  if (text.startsWith('  elanous — setup wizard')) return true;
  if (text.startsWith('  Writing to:')) return true;
  return false;
}

/** Korean IME (한글) emits Hangul jamo when a user presses ASCII-letter
 *  keys with the IME on. Map them back to qwerty positions so the
 *  wizard's letter quick-pick (`y` / `n`) keeps working without forcing
 *  the user to toggle 한/영. Sprint 9b (2026-04-28). */
const HANGUL_JAMO_TO_QWERTY: Record<string, string> = {
  'ㅂ': 'q', 'ㅈ': 'w', 'ㄷ': 'e', 'ㄱ': 'r', 'ㅅ': 't',
  'ㅛ': 'y', 'ㅕ': 'u', 'ㅑ': 'i', 'ㅐ': 'o', 'ㅔ': 'p',
  'ㅁ': 'a', 'ㄴ': 's', 'ㅇ': 'd', 'ㄹ': 'f', 'ㅎ': 'g',
  'ㅗ': 'h', 'ㅓ': 'j', 'ㅏ': 'k', 'ㅣ': 'l',
  'ㅋ': 'z', 'ㅌ': 'x', 'ㅊ': 'c', 'ㅍ': 'v', 'ㅠ': 'b',
  'ㅜ': 'n', 'ㅡ': 'm',
  // Shift variants — same qwerty letter (case-insensitive match later).
  'ㅃ': 'q', 'ㅉ': 'w', 'ㄸ': 'e', 'ㄲ': 'r', 'ㅆ': 't',
  'ㅒ': 'o', 'ㅖ': 'p',
};

/** Normalize a key name for case-insensitive ChoiceOption.key match.
 *  Lowercases ASCII + maps Korean IME jamo back to qwerty position. */
export function normalizeKeyForMatch(name: string): string {
  if (HANGUL_JAMO_TO_QWERTY[name]) return HANGUL_JAMO_TO_QWERTY[name];
  return name.toLowerCase();
}

function isControlChar(ch: string): boolean {
  if (ch.length === 0) return true;
  const code = ch.charCodeAt(0);
  // C0 controls (0x00-0x1F) plus DEL (0x7F)
  return code < 0x20 || code === 0x7f;
}

/** Minimal stdin chunk → MiniKey parser. Handles the small subset
 *  the wizard cares about: arrows / Enter / Backspace / Esc / Ctrl-C
 *  / printable chars. Unknown sequences fall through to the leading
 *  byte's char so we never deadlock. */
export function parseMiniKey(s: string): MiniKey {
  // Ctrl-C
  if (s === '\x03') return { name: 'c', ctrl: true, raw: s };
  // Enter (\r on most TTYs, \n on some)
  if (s === '\r' || s === '\n') return { name: 'enter', ctrl: false, raw: s };
  // Backspace (\x7f DEL is the modern convention; \b is older terminals)
  if (s === '\x7f' || s === '\b') return { name: 'backspace', ctrl: false, raw: s };
  // Tab
  if (s === '\t') return { name: 'tab', ctrl: false, raw: s };
  // Escape sequences
  if (s.startsWith('\x1b')) {
    if (s === '\x1b') return { name: 'esc', ctrl: false, raw: s };
    // CSI sequences: ESC [ ...
    if (s.startsWith('\x1b[')) {
      const tail = s.slice(2);
      if (tail === 'A') return { name: 'up', ctrl: false, raw: s };
      if (tail === 'B') return { name: 'down', ctrl: false, raw: s };
      if (tail === 'C') return { name: 'right', ctrl: false, raw: s };
      if (tail === 'D') return { name: 'left', ctrl: false, raw: s };
    }
    // SS3 sequences (some terminals): ESC O ...
    if (s.startsWith('\x1bO')) {
      const tail = s.slice(2);
      if (tail === 'A') return { name: 'up', ctrl: false, raw: s };
      if (tail === 'B') return { name: 'down', ctrl: false, raw: s };
      if (tail === 'C') return { name: 'right', ctrl: false, raw: s };
      if (tail === 'D') return { name: 'left', ctrl: false, raw: s };
    }
    // Unknown ESC sequence — surface as 'esc' so user can cancel
    return { name: 'esc', ctrl: false, raw: s };
  }
  // Single printable char (or multi-byte UTF-8) — name = the char
  return { name: s[0] ?? '', ctrl: false, raw: s };
}
