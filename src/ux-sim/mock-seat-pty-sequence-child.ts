// N03 key-sequence probe. The real TUI lifecycle, key parser and renderer; one frame per key,
// Ctrl+Q exits. The parent drives it through mockSeatPtySequence (src/ux-sim/mock-seat-pty-sequence.ts).
import { closeTui, initTui, readKey, render } from '../tui.js';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('N03 sequence probe requires a real PTY\n');
  process.exit(2);
}
initTui();
try {
  render([`N03 seq ready home=${process.env.HOME ?? ''} skipLogin=${process.env.ELANOUS_SKIP_LOGIN_ENV ?? ''}`]);
  let count = 0;
  for (;;) {
    const key = await readKey('main');
    if (key.ctrl && key.name === 'q') break;
    count += 1;
    render([`N03 seq count=${count} last=${key.name}`]);
  }
} finally {
  closeTui();
}
