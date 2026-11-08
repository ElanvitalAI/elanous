// ── ANSI escape sequences ──
const CSI = '\x1b[';

export const ansi = {
  clear:       `${CSI}2J${CSI}H`,
  clearLine:   `${CSI}2K`,
  hideCursor:  `${CSI}?25l`,
  showCursor:  `${CSI}?25h`,
  altOn:       `${CSI}?1049h`,
  altOff:      `${CSI}?1049l`,
  eraseDown:   `${CSI}J`,
  moveTo:      (r: number, c: number) => `${CSI}${r};${c}H`,
  // SGR mouse enable. Modes activated:
  //   1000 — basic button press/release
  //   1002 — button-event (drag while button held)
  //   1003 — any-event (motion without button) — opt-in via env
  //          ELANOUS_MOUSE_HOVER=1. Required for IDX-5 hover-stable +
  //          Tooltip auto-show. Default off because 1003 floods the
  //          input pipe on every pixel of mouse motion; users who
  //          don't want hover can keep the light mode.
  //   1006 — SGR extended coordinate encoding (required for > 223 cols)
  get mouseOn() {
    const hover = process.env.ELANOUS_MOUSE_HOVER === '1';
    const motionMode = hover ? '1003' : '1002';
    return `${CSI}?1000h${CSI}?${motionMode}h${CSI}?1006h`;
  },
  get mouseOff() {
    const hover = process.env.ELANOUS_MOUSE_HOVER === '1';
    const motionMode = hover ? '1003' : '1002';
    return `${CSI}?${motionMode}l${CSI}?1000l${CSI}?1006l`;
  },
  // Kitty keyboard protocol: enables Shift+Enter as CSI 13;2 u
  kittyKbOn:   `${CSI}>1u`,
  kittyKbOff:  `${CSI}<u`,
  // PR-S1V.4 — Voice mode level upgrade. `>3u` enables release/repeat
  // events (bit 0x01 disambiguate + bit 0x02 report event types). Used
  // by voice-mode.ts only when entering voice mode; restored to `>1u`
  // on exit. Crash safety: on `'exit'`/'SIGINT'/'SIGTERM' we always
  // write `kittyKbOff` (`<u`) which pops the stack to baseline.
  kittyKbVoiceOn:  `${CSI}>3u`,
  kittyKbVoiceOff: `${CSI}>1u`,
  // xterm modifyOtherKeys v2: fallback for tmux/ssh
  modKeysOn:   `${CSI}>4;2m`,
  modKeysOff:  `${CSI}>4;0m`,
  // Bracketed paste: terminal wraps pastes with CSI 200~ ... CSI 201~ so
  // we can distinguish a paste from fast typing and tokenize file paths
  // in-place. See claude-code-fork's PromptInput for the reference UX.
  pasteOn:     `${CSI}?2004h`,
  pasteOff:    `${CSI}?2004l`,
};

export function termSize(): { rows: number; cols: number } {
  return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 };
}
