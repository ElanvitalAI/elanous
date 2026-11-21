import { expect, test } from 'bun:test';
import { Terminal } from '@xterm/headless';
import { createNewTabPrompt, NEW_TAB_NAME_MAX_CELLS } from './new-tab-prompt.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
function prompt() {
  const saved: string[] = [];
  let repaints = 0;
  const p = createNewTabPrompt({ save: (name) => { saved.push(name); }, changed: () => { repaints++; } });
  p.openPrompt();
  return { p, saved, repaints: () => repaints };
}

test('type, backspace, left/right edit at the caret; Enter saves the typed name and closes', () => {
  const { p, saved } = prompt();
  p.feed('abd'); p.feed('\u001b[D'); p.feed('c');                 // abcd (caret moved left once, then c inserted)
  expect(p.value()).toBe('abcd');
  p.feed('\u007f'); expect(p.value()).toBe('abd');
  p.feed('\u001b[H'); p.feed('\u001b[3~'); expect(p.value()).toBe('bd');   // Home, Delete
  p.feed('\u001b[F'); p.feed('x\r');
  expect(saved).toEqual(['bdx']);
  expect(p.isOpen()).toBe(false);
});

test('Ctrl+C clears the buffer and keeps the prompt open; Esc cancels without saving; empty Enter saves the empty (default) name', () => {
  const { p, saved } = prompt();
  p.feed('hello'); p.feed('\u0003');
  expect(p.value()).toBe('');
  expect(p.isOpen()).toBe(true);
  p.feed('abc'); p.feed('\u001b');
  expect(p.isOpen()).toBe(false);
  expect(saved).toEqual([]);
  p.openPrompt(); expect(p.value()).toBe('');                    // reopened empty
  p.feed('\r');
  expect(saved).toEqual(['']);
});

test('whitespace-only Enter saves the default name', () => {
  const { p, saved } = prompt();
  p.feed('   \r');
  expect(saved).toEqual(['']);
  expect(p.isOpen()).toBe(false);
});

test('Korean and wide glyphs: one cursor step each, two cells each; the cap is in cells', () => {
  const { p } = prompt();
  p.feed('한국어'); p.feed('\u001b[D'); p.feed('\u007f');
  expect(p.value()).toBe('한어');                                 // backspace removed exactly one glyph
  p.feed('가'.repeat(30));
  expect(Bun.stringWidth(p.value())).toBe(NEW_TAB_NAME_MAX_CELLS);   // 20 wide glyphs fill it; the rest was dropped
  p.feed('a');
  expect(Bun.stringWidth(p.value())).toBe(NEW_TAB_NAME_MAX_CELLS);
});

test('combining marks and emoji remain intact when moving and deleting by grapheme', () => {
  const { p } = prompt();
  p.feed('Ae\u0301👩‍💻Z');
  expect(p.value()).toBe('Ae\u0301👩‍💻Z');
  p.feed('\u001b[D'); p.feed('\u007f');
  expect(p.value()).toBe('Ae\u0301Z');
  p.feed('\u007f');
  expect(p.value()).toBe('AZ');
});

test('control bytes are never name text: they are dropped, and an unknown escape sequence is swallowed whole', () => {
  const { p, saved } = prompt();
  p.feed('a\u0000\u0007\u0015\tb\u009bc\u001b[1;5Zd');
  expect(p.value()).toBe('abcd');
  p.feed('\u001b[200~'); expect(p.isOpen()).toBe(true);
  p.feed('\r');
  expect(saved).toEqual(['abcd']);
});

test('the row reads «new tab [name] ↵ save ^c clear esc cancel», one terminal row, and a narrow row drops the hint', () => {
  const { p } = prompt();
  p.feed('work');
  expect(strip(p.line(100))).toContain(' new tab [work ');
  expect(strip(p.line(100))).toContain('↵ save  ^c clear  esc cancel');
  expect(strip(p.line(20))).not.toContain('save');
});

test('dialog is centered in the full viewport at 80 and 200 columns', () => {
  const { p } = prompt();
  for (const cols of [40, 59, 60, 79, 80, 99, 100, 200]) {
    const output = p.dialog(cols, 24);
    const first = /^\x1b\[(\d+);(\d+)H/.exec(output)!;
    expect(Number(first[1])).toBe(9);
    expect(Number(first[2])).toBe(Math.floor((cols - Math.min(48, cols - 2)) / 2) + 1);
    expect(strip(output)).toContain('새 탭 이름');
    expect(strip(output)).toContain('Name');
  }
});

test('80-column dialog preserves the 28-column sidebar and shows the requested Korean title', () => {
  const { p } = prompt();
  const output = p.dialog(80, 24, 29);
  const first = /^\x1b\[(\d+);(\d+)H/.exec(output)!;
  expect(Number(first[2])).toBe(31);
  expect(strip(output)).toContain('새 탭 이름');
});

test('dialog renders complete Unicode graphemes and caret before the following character', async () => {
  const { p } = prompt();
  p.feed('가👩‍💻나'); p.feed('\u001b[D');
  expect(p.value()).toBe('가👩‍💻나');
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => terminal.write(p.dialog(80, 24), resolve));
    expect(terminal.buffer.active.getLine(10)!.translateToString(true)).toContain('가👩‍💻▎나');
  } finally { terminal.dispose(); }
});

test('unknown outcome persists across close until explicit checked-tabs acknowledgement', async () => {
  const saved: string[] = [];
  const p = createNewTabPrompt({ save: async (name) => { saved.push(name); return 'unknown' as const; }, changed: () => {} });
  p.openPrompt(); p.feed('work\r');
  await Promise.resolve();
  p.feed('\u001b');
  expect(p.isOpen()).toBe(false);
  p.openPrompt();
  expect(p.dialog(80, 24)).toContain('Outcome unknown');
  p.feed('\r');
  expect(saved).toEqual(['work']);
  p.feed('r');
  expect(p.value()).toBe('work');
  p.feed('\r');
  expect(saved).toEqual(['work', 'work']);
});

test('closing after selecting risky retry retains the unknown guard and name', async () => {
  const saved: string[] = [];
  const p = createNewTabPrompt({ save: async (name) => { saved.push(name); return 'unknown' as const; }, changed: () => {} });
  p.openPrompt(); p.feed('work\r'); await Promise.resolve();
  p.feed('r'); p.feed('\u001b');
  p.openPrompt();
  expect(p.value()).toBe('work');
  expect(p.dialog(80, 24)).toContain('Outcome unknown');
  p.feed('\r');
  expect(saved).toEqual(['work']);
});

test('risky retry cannot change the unresolved request name', async () => {
  const saved: string[] = [];
  const p = createNewTabPrompt({ save: async (name) => { saved.push(name); return 'unknown' as const; }, changed: () => {} });
  p.openPrompt(); p.feed('work\r'); await Promise.resolve();
  p.feed('r'); p.feed('\u0003other'); p.feed('\u001b'); p.openPrompt();
  expect(p.value()).toBe('work');
  expect(p.dialog(80, 24)).toContain('Outcome unknown');
  p.feed('\r'); expect(saved).toEqual(['work']);
});

test('hidden retry choice cannot be selected on a too-small screen', async () => {
  const saved: string[] = [];
  const p = createNewTabPrompt({ save: async (name) => { saved.push(name); return 'unknown' as const; }, changed: () => {} });
  p.openPrompt(); p.feed('work\r'); await Promise.resolve();
  p.dialog(23, 6); p.feed('r'); p.dialog(80, 24); p.feed('\r');
  expect(saved).toEqual(['work']);
  expect(p.dialog(80, 24)).toContain('Outcome unknown');
});

test('a refused risky retry does not clear the original unknown on close', async () => {
  let calls = 0;
  const p = createNewTabPrompt({ save: async () => ++calls === 1 ? 'unknown' as const : false, changed: () => {} });
  p.openPrompt(); p.feed('work\r'); await Promise.resolve();
  p.feed('r'); p.feed('\r'); await Promise.resolve();
  p.feed('\u001b'); p.openPrompt();
  expect(p.value()).toBe('work');
  expect(p.dialog(80, 24)).toContain('Outcome unknown');
  p.feed('\r'); expect(calls).toBe(2);
});

test('successful explicitly acknowledged retry clears the retained guard and name', async () => {
  let calls = 0;
  const p = createNewTabPrompt({ save: async () => ++calls === 1 ? 'unknown' as const : true, changed: () => {} });
  p.openPrompt(); p.feed('work\r'); await Promise.resolve();
  p.feed('r'); p.feed('\r'); await Promise.resolve();
  expect(p.isOpen()).toBe(false);
  p.openPrompt();
  expect(p.value()).toBe('');
  expect(p.dialog(80, 24)).not.toContain('Outcome unknown');
});

test('unknown acknowledgement accepts a coalesced chunk but never submits its trailing Enter', async () => {
  const saved: string[] = [];
  const p = createNewTabPrompt({ save: async (name) => { saved.push(name); return 'unknown' as const; }, changed: () => {} });
  p.openPrompt(); p.feed('work\r'); await Promise.resolve();
  p.feed('r\r');
  expect(saved).toEqual(['work']);
  expect(p.dialog(80, 24)).not.toContain('Outcome unknown');
  p.feed('\r');
  expect(saved).toEqual(['work', 'work']);
});

test('unknown outcome warns of duplicate risk before retry is enabled', async () => {
  const saved: string[] = [];
  const p = createNewTabPrompt({ save: async (name) => { saved.push(name); return 'unknown' as const; }, changed: () => {} });
  p.openPrompt(); p.feed('work\r'); await Promise.resolve();
  expect(p.dialog(80, 24)).toMatch(/duplicate|already exist/i);
  expect(p.dialog(24, 7)).toMatch(/duplicate|already exist/i);
  p.feed('\r');
  expect(saved).toEqual(['work']);
  p.feed('r');
  expect(p.dialog(80, 24)).toMatch(/duplicate|already exist/i);
  expect(p.dialog(24, 7)).toMatch(/duplicate|already exist/i);
  expect(p.value()).toBe('work');
  expect(saved).toEqual(['work']);
});

test('too small prevents creation while retaining the input until resize', () => {
  const { p, saved } = prompt();
  p.feed('hello');
  expect(p.dialog(23, 6)).toContain('Screen too small');
  p.feed('\r');
  expect(saved).toEqual([]);
  expect(p.value()).toBe('hello');
  p.dialog(80, 24); p.feed('\r');
  expect(saved).toEqual(['hello']);
});
