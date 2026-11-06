import { StringDecoder } from 'node:string_decoder';

// ── Key parsing ──
export interface Key {
  name: string;
  ctrl: boolean;
  shift: boolean;
  alt?: boolean;
  /** meta(⌘/super) 모디파이어 — alt 와 동형 optional. 일부 키 라우터(log-pane
   *  copy-action 등)가 modifier-free 판정에 참조. 미설정이면 undefined. */
  meta?: boolean;
  mouse?: { row: number; col: number; type: 'click' | 'double-click' | 'right-click' | 'scroll-up' | 'scroll-down' | 'drag' | 'release' | 'motion' };
  /** Original stdin bytes that produced this key. Set by splitKeys()
   *  so callers that need to forward the exact sequence (e.g. the
   *  preview terminal's PTY passthrough) can do so without losing
   *  modifier / Kitty-protocol information in the parse/reverse step. */
  raw?: string;
  /** Semantic body of one bracketed paste envelope, without its markers. */
  paste?: string;
  /** Kitty CSI u event type (PR-S1V.4): `1` press · `2` repeat · `3` release.
   *  Only emitted when kitty level `>3u` is active (voice mode). When the
   *  field is undefined it implies a press (legacy callers stay correct).
   *  Dispatchers that only care about presses should ignore non-`press`
   *  events with `if (key.kind && key.kind !== 'press') return;`. */
  kind?: 'press' | 'repeat' | 'release';
}

// ── MD1 — Double-click detector (AppCUI-rs 300ms threshold convention) ──
// SGR 1006 only reports press/release per-event; there is no native
// "double-click" variant in the protocol. We synthesize one by tracking
// the last same-cell primary press timestamp and emitting a
// `double-click` when a second press arrives within DOUBLE_CLICK_MS at
// the exact same (row, col). Widgets receive both the first `click` and
// the follow-up `double-click` — the first is never suppressed so
// select-then-decide UX stays predictable.

interface LastPress { row: number; col: number; at: number }
let lastPrimaryPress: LastPress | null = null;

function doubleClickThresholdMs(): number {
  const raw = process.env.ELANOUS_DOUBLE_CLICK_MS;
  if (!raw) return 300;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

/** Test helper — wipe the detector's memory between scenarios. */
export function __resetDoubleClickState(): void {
  lastPrimaryPress = null;
}

// Map keycode → name (shared between CSI u and modifyOtherKeys)
function keycodeToName(code: number): string | undefined {
  switch (code) {
    case 9:  return 'tab';
    case 13: return 'enter';
    case 27: return 'escape';
    case 32: return 'space';
    case 127: return 'backspace';
    default: return undefined;
  }
}

// Decode modifier bitmask (xterm / kitty convention: modifier = bits + 1
// where bit0=shift, bit1=alt, bit2=ctrl). Previously this dropped the
// alt bit entirely, so Alt-modified keys arriving via kitty CSI-u or
// modifyOtherKeys ended up with `alt=undefined` on the Key — invisible
// to downstream routing and to the popup-terminal byte encoder.
function decodeModifier(mod: number): { shift: boolean; ctrl: boolean; alt: boolean } {
  const m = mod - 1;
  return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) };
}

function parseKey(data: string | Buffer): Key {
  const s = typeof data === 'string' ? data : data.toString();
  const K = (name: string, ctrl = false, shift = false, alt = false): Key => ({ name, ctrl, shift, alt });

  // ── Bracketed paste markers (enabled via ansi.pasteOn / CSI ?2004h) ──
  // Terminal emits CSI 200~ before a paste and CSI 201~ after. textInput
  // catches these to collect the paste as a single unit and tokenize it.
  if (s === '\x1b[200~') return K('paste-start');
  if (s === '\x1b[201~') return K('paste-end');

  // ── Kitty keyboard protocol: CSI codepoint[;modifier[:event_type]] u ──
  // Level 1 (`>1u`): only disambiguate — no `:event_type` segment.
  // Level 3 (`>3u`): adds press/repeat/release events. PR-S1V.4 enters
  // level 3 on voice-mode entry and restores level 1 on exit; the
  // `:event_type` segment is only present for releases/repeats since
  // level-3 terminals omit it for the implicit `1` (press).
  const csiU = s.match(/^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?u/);
  if (csiU) {
    const code = parseInt(csiU[1]!);
    const mod = csiU[2] ? parseInt(csiU[2]!) : 1;
    const eventType = csiU[3] ? parseInt(csiU[3]!) : 1;
    const { shift, alt, ctrl } = decodeModifier(mod);
    const name = keycodeToName(code);
    const kind: 'press' | 'repeat' | 'release' =
      eventType === 3 ? 'release' : eventType === 2 ? 'repeat' : 'press';
    const out: Key = name
      ? K(name, ctrl, shift, alt)
      : code >= 32
        ? K(String.fromCodePoint(code), ctrl, shift, alt)
        : K('', ctrl, shift, alt);
    // Only annotate non-press events so legacy paths see `kind === undefined`
    // and stay correct (the key is still treated as a press via fall-through).
    if (kind !== 'press') out.kind = kind;
    return out;
  }

  // ── xterm modifyOtherKeys: CSI 27;modifier;keycode ~ ──
  const modKeys = s.match(/^\x1b\[27;(\d+);(\d+)~/);
  if (modKeys) {
    const mod = parseInt(modKeys[1]!);
    const code = parseInt(modKeys[2]!);
    const { shift, alt, ctrl } = decodeModifier(mod);
    const name = keycodeToName(code);
    if (name) return K(name, ctrl, shift, alt);
    if (code >= 32) return K(String.fromCodePoint(code), ctrl, shift, alt);
    return K('', ctrl, shift, alt);
  }

  // xterm modified arrows (including legacy Shift+arrow)
  const arrowMod = s.match(/^\x1b\[1;(\d+)([ABCD])$/);
  if (arrowMod) {
    const { shift, alt, ctrl } = decodeModifier(parseInt(arrowMod[1]!, 10));
    const name = { A: 'up', B: 'down', C: 'right', D: 'left' }[arrowMod[2]! as 'A' | 'B' | 'C' | 'D'];
    return K(name, ctrl, shift, alt);
  }
  if (s === '\x1bOM')     return K('enter', false, true); // legacy Shift+Enter (SS3)
  if (s === '\x1b\r' || s === '\x1b\n') return K('enter', false, true); // ESC+CR = Shift/Alt+Enter
  if (s === '\x1b[Z')     return K('tab', false, true);   // Shift+Tab (backtab)

  // Modified function keys: CSI <code>;<modifier>~
  // modifier bitmask per xterm: mod-1 bits → 1=shift 2=alt 4=ctrl.
  // Codes: 1,7=Home  2=Insert  3=Delete  4,8=End  5=PgUp  6=PgDn.
  const funcMod = s.match(/^\x1b\[(\d+);(\d+)~$/);
  if (funcMod) {
    const code = parseInt(funcMod[1]!, 10);
    const { shift, alt, ctrl } = decodeModifier(parseInt(funcMod[2]!, 10));
    const map: Record<number, string> = {
      1: 'home', 7: 'home',
      4: 'end',  8: 'end',
      5: 'pageup',
      6: 'pagedown',
      2: 'insert',
      3: 'delete',
    };
    const name = map[code];
    if (name) return K(name, ctrl, shift, alt);
  }

  // ── Alt-as-ESC-prefix (legacy / ghostty `macos-option-as-alt`) ──
  // ghostty in alt-esc-prefix mode (default macOS layout, or with
  // `macos-option-as-alt = left|right|true`) emits Alt+<char> as a
  // 2-byte ESC+<char> sequence (see ghostty src/input/key_encode.zig
  // legacyAltPrefix). splitKeys() above bundles ESC + next-char into
  // one slice when the next byte isn't `[` or `O`, so by the time we
  // reach here a 2-char `\x1b<printable>` is guaranteed to be Alt+char.
  // Reject control bytes (\x1b\x01 etc — would be Ctrl+Alt+letter
  // which ghostty encodes via CSI-u, not legacy prefix), and the
  // already-handled \x1b\r / \x1b\n / \x1b[ / \x1bO cases.
  if (s.length === 2 && s[0] === '\x1b') {
    const ch = s[1]!;
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      if (ch === ' ') return K('space', false, false, true);
      // Uppercase letter → name is lowercased, shift bit set.
      if (code >= 0x41 && code <= 0x5a) {
        return K(ch.toLowerCase(), false, true, true);
      }
      // Lowercase letter / digit / symbol — literal name, no shift.
      return K(ch, false, false, true);
    }
  }

  // Arrow / nav keys
  if (s === '\x1b[A' || s === '\x1bOA') return K('up');
  if (s === '\x1b[B' || s === '\x1bOB') return K('down');
  if (s === '\x1b[C' || s === '\x1bOC') return K('right');
  if (s === '\x1b[D' || s === '\x1bOD') return K('left');
  if (s === '\x1b[H' || s === '\x1b[1~') return K('home');
  if (s === '\x1b[F' || s === '\x1b[4~') return K('end');
  if (s === '\x1b[5~') return K('pageup');
  if (s === '\x1b[6~') return K('pagedown');
  if (s === '\x1b[3~') return K('delete');

  // Special keys
  if (s === '\r')                 return K('enter');
  if (s === '\n')                 return K('j', true); // Ctrl+J → LF
  if (s === ' ')                  return K('space');
  if (s === '\x1b')               return K('escape');
  if (s === '\t')                 return K('tab');
  if (s === '\x7f' || s === '\b') return K('backspace');

  // Ctrl+key
  if (s.length === 1 && s.charCodeAt(0) === 3) return K('c', true);
  if (s.length === 1 && s.charCodeAt(0) === 0x1f) return K('/', true); // Ctrl+/ → \x1f
  // Ctrl+digit normalization for the few digits that yield clean
  // control chars on a bare xterm. Kitty / modifyOtherKeys paths
  // already produce `K('<digit>', ctrl=true)` higher up; this is the
  // fallback for plain terminals. Ctrl+1 has no distinct wire form;
  // Ctrl+3 collides with Escape — so those must come via modKeys.
  if (s === '\x00')  return K('2', true); // Ctrl+2 → NUL
  if (s === '\x1c')  return K('\\', true); // Ctrl+\\ → FS; Ctrl+4 shares this byte, so requires kitty/modifyOtherKeys
  if (s === '\x1d')  return K('5', true); // Ctrl+5 → GS
  if (s.length === 1 && s.charCodeAt(0) < 32) {
    return K(String.fromCharCode(s.charCodeAt(0) + 96), true);
  }

  // SGR mouse: \x1b[<button;col;rowM (press) or \x1b[<button;col;rowm (release)
  const mouseMatch = s.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (mouseMatch) {
    const btn = parseInt(mouseMatch[1]!);
    const col = parseInt(mouseMatch[2]!);
    const row = parseInt(mouseMatch[3]!);
    const pressed = mouseMatch[4] === 'M';
    // SGR button encoding: bits 0-1 = button, bit 2 = shift, bit 3 = meta, bit 4 = ctrl, bit 5 = motion
    const hasShift = !!(btn & 4);
    const hasAlt = !!(btn & 8);
    const hasCtrl = !!(btn & 16);
    const baseBtn = btn & ~(4 | 8 | 16); // strip modifier bits
    if (baseBtn === 0 && pressed) {
      const now = Date.now();
      const thr = doubleClickThresholdMs();
      const isDbl =
        lastPrimaryPress !== null
        && now - lastPrimaryPress.at <= thr
        && lastPrimaryPress.row === row
        && lastPrimaryPress.col === col;
      if (isDbl) {
        // Consume the pair so a third quick press does NOT cascade into
        // another double. Triple-click is explicitly out of scope.
        lastPrimaryPress = null;
        return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'double-click' } };
      }
      lastPrimaryPress = { row, col, at: now };
      return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'click' } };
    }
    if (baseBtn === 0 && !pressed) return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'release' } };
    if (baseBtn === 2 && pressed)  return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'right-click' } };
    if (baseBtn === 32 && pressed) return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'drag' } };
    // IDX-5 — SGR any-event motion (1003 mode). btn 35 = motion bit (32) |
    // button-3 (no-button) = 35. Requires ELANOUS_MOUSE_HOVER=1; terminals
    // that don't know 1003 never emit this code so the branch is a no-op
    // for the default 1002 pipeline.
    if (baseBtn === 35 && pressed) return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'motion' } };
    if (baseBtn === 64 && pressed) return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'scroll-up' } };
    if (baseBtn === 65 && pressed) return { name: 'mouse', ctrl: hasCtrl, shift: hasShift, alt: hasAlt, mouse: { row, col, type: 'scroll-down' } };
    // Ignore other events
    return K('');
  }

  // ── Korean jamo → English key mapping ──
  // When Korean IME is active in raw mode, keystrokes arrive as
  // Hangul Compatibility Jamo (U+3131–U+3163). Map them to the
  // English key on the same physical position so hotkeys work
  // regardless of IME state.
  const KOREAN_TO_EN: Record<string, string> = {
    'ㅂ': 'q', 'ㅈ': 'w', 'ㄷ': 'e', 'ㄱ': 'r', 'ㅅ': 't',
    'ㅛ': 'y', 'ㅕ': 'u', 'ㅑ': 'i', 'ㅐ': 'o', 'ㅔ': 'p',
    'ㅁ': 'a', 'ㄴ': 's', 'ㅇ': 'd', 'ㄹ': 'f', 'ㅎ': 'g',
    'ㅗ': 'h', 'ㅓ': 'j', 'ㅏ': 'k', 'ㅣ': 'l',
    'ㅋ': 'z', 'ㅌ': 'x', 'ㅊ': 'c', 'ㅍ': 'v', 'ㅠ': 'b',
    'ㅜ': 'n', 'ㅡ': 'm',
    // Shifted
    'ㅃ': 'Q', 'ㅉ': 'W', 'ㄸ': 'E', 'ㄲ': 'R', 'ㅆ': 'T',
  };
  if (s.length === 1 || (s.length <= 3 && [...s].length === 1)) {
    const ch = [...s][0]!;
    const mapped = KOREAN_TO_EN[ch];
    if (mapped) {
      const isUpper = mapped !== mapped.toLowerCase();
      return K(isUpper ? mapped.toLowerCase() : mapped, false, isUpper);
    }
  }

  // Regular text (including multi-byte: Korean, CJK, emoji)
  return K(s);
}

function trailingUtf8Carry(data: Buffer): Buffer {
  let continuations = 0;
  for (let index = data.length - 1; index >= 0 && continuations < 3; index -= 1) {
    const byte = data[index]!;
    if ((byte & 0xC0) === 0x80) {
      continuations += 1;
      continue;
    }
    const width = byte >= 0xC0 && byte <= 0xDF ? 2
      : byte >= 0xE0 && byte <= 0xEF ? 3
        : byte >= 0xF0 && byte <= 0xF7 ? 4
          : 0;
    return width > continuations + 1 ? data.subarray(index) : Buffer.alloc(0);
  }
  return Buffer.alloc(0);
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
/** 한 붙여넣기 봉투의 최대 크기. ⛔ 이 상한이 없으면 **끝 표식이 안 오는 스트림**(터미널 버그·
 *  잘린 연결·악의)에서 `pasteBody` 가 무한히 자라고, 그 동안 TUI 는 **모든 입력을 삼킨 채** 응답하지
 *  않는다(붙여넣기 모드에서 영영 못 나온다). ⇒ 상한을 넘으면 **모은 것을 그대로 내보내고 모드를 빠져나간다**
 *  — 잘라서 버리는 것보다 사용자가 본 것을 주는 쪽이 낫고, 입력이 다시 흐른다.
 *  ⭐ 값의 출처: `#5865`(같은 결함을 다른 구현으로 다룬 PR)가 정한 1MiB 를 그대로 쓴다(재발명 0). */
const PASTE_MAX_BYTES = 1024 * 1024;

export class KeyStreamParser {
  private pending = '';
  private pasting = false;
  private pasteBody = '';
  /** `pasteBody` 의 **누적 바이트 수**. ⛔ 매 청크마다 `Buffer.byteLength(pasteBody)` 를 다시 재면
   *  작은 청크가 많이 올 때 **O(n²)** 가 되어 CPU 를 태운다(리뷰 must-fix). ⇒ 더할 때만 누적한다. */
  private pasteBodyBytes = 0;
  private readonly decoder = new StringDecoder('utf8');
  private decoderCarry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private decoderHasPendingBytes = false;

  /** 붙여넣기 본문에 이어 붙인다. **상한을 넘으면 상한까지만 담고 봉투를 닫은 뒤 `true`** 를 준다.
   *  ⛔⭐ 세 가지를 한 곳에서 지킨다(리뷰 must-fix ×3) —
   *   ① **두 경로 모두**(끝 표식이 같은 청크에 있든 없든) 같은 상한을 거친다.
   *   ② **바이트로 자른다** — `Buffer` 로 재고 잘라 다중바이트 본문이 상한을 넘지 않게 한다
   *      (UTF-16 `slice` 로 자르면 한글·이모지 본문이 상한을 크게 넘는다).
   *   ③ **남는 것은 버리지 않고 `pending` 으로 되돌린다** — 그래야 *"모드를 빠져나가 입력이
   *      다시 흐른다"* 가 실제로 성립한다(버리면 그 입력은 영영 사라진다). */
  private appendPasteBody(chunk: string, keys: Key[]): boolean {
    const room = PASTE_MAX_BYTES - this.pasteBodyBytes;
    const chunkBytes = Buffer.byteLength(chunk);
    if (chunkBytes <= room) {
      this.pasteBody += chunk;
      this.pasteBodyBytes += chunkBytes;
      return false;
    }
    const buf = Buffer.from(chunk, 'utf8');
    // ⚠️ 바이트 경계가 문자 중간을 자를 수 있다 ⇒ **유효 UTF-8 경계를 직접 계산**한다.
    //    ⛔ 잘라서 디코드한 뒤 `\uFFFD` 를 지우는 방식은 쓰지 않는다(리뷰 must-fix) —
    //      **본문에 원래 있던 U+FFFD** 까지 지워 그 문자를 붙여넣기 밖으로 밀어낸다.
    //    ⭐ UTF-8 연속 바이트는 `10xxxxxx`(0x80~0xBF)다. 그 바이트에서 시작하면 문자 중간이므로
    //      선두 바이트를 만날 때까지 뒤로 물러난다(최대 3바이트).
    let cut = Math.max(room, 0);
    while (cut > 0 && (buf[cut]! & 0xC0) === 0x80) cut -= 1;
    const head = buf.subarray(0, cut).toString('utf8');
    this.pasteBody += head;
    this.pasteBodyBytes += cut;
    this.pending = chunk.slice(head.length) + this.pending;
    keys.push(this.closePaste(this.pasteBody));
    return true;
  }

  /** 붙여넣기 봉투를 닫고 키 하나로 만든다 — **정상 종료와 상한 초과가 같은 형태**로 나가야
   *  소비자가 두 경로를 다르게 다루지 않는다(상한 초과도 사용자에겐 "붙여넣기"다). */
  private closePaste(paste: string): Key {
    this.pasteBody = '';
    this.pasteBodyBytes = 0;
    this.pasting = false;
    return {
      name: 'paste',
      ctrl: false,
      shift: false,
      raw: BRACKETED_PASTE_START + paste + BRACKETED_PASTE_END,
      paste: paste.replace(/\r\n?|\n/g, '\n'),
    };
  }

  push(data: string | Buffer): Key[] {
    const keys: Key[] = [];
    if (typeof data === 'string') {
      this.pending += data;
    } else {
      const decoded = this.decoder.write(data);
      if (data.length > 0) {
        const input = Buffer.concat([this.decoderCarry, data]);
        this.decoderCarry = trailingUtf8Carry(input);
        this.decoderHasPendingBytes = this.decoderCarry.length > 0;
      }
      this.pending += decoded;
    }

    while (this.pending.length > 0) {
      if (this.pasting) {
        const end = this.pending.indexOf(BRACKETED_PASTE_END);
        if (end < 0) {
          let suffixLength = 0;
          for (let length = Math.min(BRACKETED_PASTE_END.length - 1, this.pending.length); length > 0; length--) {
            if (this.pending.endsWith(BRACKETED_PASTE_END.slice(0, length))) {
              suffixLength = length;
              break;
            }
          }
          const carried = this.pending.slice(0, this.pending.length - suffixLength);
          this.pending = this.pending.slice(this.pending.length - suffixLength);
          if (this.appendPasteBody(carried, keys)) continue;   // 상한 초과 ⇒ 봉투를 닫고 나머지는 pending 에 남는다
          break;
        }
        const carried = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + BRACKETED_PASTE_END.length);
        if (this.appendPasteBody(carried, keys)) continue;     // 상한 초과면 여기서 이미 닫혔다
        keys.push(this.closePaste(this.pasteBody));
        continue;
      }

      if (this.pending.startsWith(BRACKETED_PASTE_START)) {
        this.pending = this.pending.slice(BRACKETED_PASTE_START.length);
        this.pasting = true;
        continue;
      }

      const slice = this.nextSlice();
      if (slice === null) break;
      this.pending = this.pending.slice(slice.length);
      const key = parseKey(slice);
      key.raw = slice;
      keys.push(key);
    }

    return keys;
  }

  flush(): Key[] {
    this.pending += this.decoder.end();
    this.decoderCarry = Buffer.alloc(0);
    this.decoderHasPendingBytes = false;
    if (this.pasting || !this.pending) return [];
    if (this.pending === '\x1b') {
      this.pending = '';
      return [{ name: 'escape', ctrl: false, shift: false, raw: '\x1b' }];
    }
    return this.push('');
  }

  flushEscape(): Key[] {
    // ⛔⭐ **붙여넣기 중에는 절대 방출하지 않는다**(리뷰 must-fix · 2026-07-30) —
    //    봉투 안에서 청크가 `…\x1b` 로 끝나면 그 ESC 는 **끝 표식 `\x1b[201~` 의 앞 한 글자**다.
    //    25ms 조용창 flush 가 그것을 Escape 키로 **소비**하면 종료 표식이 깨지고 붙여넣기가
    //    영영 안 닫힌다(그 뒤 입력이 전부 본문으로 삼켜진다). `flush()` 는 이미 이 가드를 갖고 있었다.
    if (this.pasting) return [];
    if (this.pending !== '\x1b') return [];
    this.pending = '';
    return [{ name: 'escape', ctrl: false, shift: false, raw: '\x1b' }];
  }

  /** True while the parser holds an incomplete escape sequence — a lone
   *  ESC awaiting either a quiet-window flush (→ Escape) or a following
   *  byte (→ Alt combo / CSI), or a CSI/SS3 split across stdin chunks.
   *  `readKey` uses this to decide whether to keep waiting instead of
   *  resolving with an empty key (which would swallow the ESC and let the
   *  next byte mis-combine into a phantom Alt chord). */
  hasPendingEscape(): boolean {
    return this.pending.length > 0 && this.pending[0] === '\x1b';
  }

  /** True while a bracketed-paste envelope is open — body bytes have arrived
   *  but the end marker has not. ⛔ Callers that detach on "no keys yet" MUST
   *  check this: a paste body produces **zero keys per chunk**, so a reader that
   *  resolves empty and re-attaches can lose the next chunk in the gap
   *  (리뷰 must-fix · 2026-07-30). `hasPendingEscape()` does not cover this —
   *  mid-body `pending` is usually empty, and the envelope state lives in
   *  `pasting`, not in `pending`. */
  hasPendingPaste(): boolean {
    return this.pasting;
  }

  /** True while StringDecoder has retained an incomplete UTF-8 sequence. */
  hasPendingDecoderBytes(): boolean {
    return this.decoderHasPendingBytes;
  }

  /** Discard incomplete stream state when its owner is torn down. */
  reset(): void {
    this.pending = '';
    this.pasting = false;
    this.pasteBody = '';
    this.pasteBodyBytes = 0;
    this.decoder.end();
    this.decoderCarry = Buffer.alloc(0);
    this.decoderHasPendingBytes = false;
  }

  private nextSlice(): string | null {
    if (this.pending[0] !== '\x1b') {
      const cp = this.pending.codePointAt(0)!;
      return this.pending.slice(0, cp > 0xFFFF ? 2 : 1);
    }
    if (this.pending.length === 1) return null;
    if (this.pending[1] === '\x1b') return '\x1b';
    if (this.pending[1] === '[') {
      for (let end = 2; end < this.pending.length; end++) {
        const code = this.pending.charCodeAt(end);
        if (code >= 0x40 && code <= 0x7E) return this.pending.slice(0, end + 1);
      }
      return null;
    }
    if (this.pending[1] === 'O') return this.pending.length >= 3 ? this.pending.slice(0, 3) : null;
    return this.pending.slice(0, 2);
  }
}


export function splitKeys(data: string | Buffer): Key[] {
  const s = typeof data === 'string' ? data : data.toString();
  const keys: Key[] = [];
  let i = 0;
  while (i < s.length) {
    let slice: string;
    if (s[i] === '\x1b' && i + 1 < s.length) {
      // Find end of escape sequence
      let end = i + 1;
      if (s[end] === '\x1b') {
        slice = '\x1b';
        i++;
        const key = parseKey(slice);
        key.raw = slice;
        keys.push(key);
        continue;
      }
      // CSI sequence: ESC [ ... letter
      if (s[end] === '[') {
        end++;
        while (end < s.length && !(s.charCodeAt(end) >= 0x40 && s.charCodeAt(end) <= 0x7E)) end++;
        if (end < s.length) end++; // include terminator
      } else if (s[end] === 'O') {
        end += 2; // SS3 sequence: ESC O letter
      } else {
        end++; // alt+key: ESC + char
      }
      slice = s.slice(i, end);
      i = end;
    } else {
      // Single character (including multi-byte UTF-8 — already decoded as string)
      const cp = s.codePointAt(i)!;
      const len = cp > 0xFFFF ? 2 : 1;
      slice = s.slice(i, i + len);
      i += len;
    }
    const key = parseKey(slice);
    // Attach the original bytes so forwarders (preview terminal PTY
    // passthrough) can write them verbatim without reverse-encoding
    // from the parsed struct. Safe even for Key fields we fabricate
    // (paste-start/paste-end) — the slice is still what the terminal
    // emitted, which is what downstream consumers expect.
    key.raw = slice;
    keys.push(key);
  }
  return keys;
}

