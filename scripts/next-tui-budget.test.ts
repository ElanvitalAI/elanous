import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { collectNextTuiRuntimeClosure, isNextTuiReadyScreen, NEXT_TUI_READY_SCREEN_TCL_REGEX } from './lib/next-tui-budget.js';
import { mockSeatPtySequence } from '../src/ux-sim/mock-seat-pty-sequence.js';

function put(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

test('next TUI runtime closure omits named type-only edges and follows the most-specific tsconfig path', () => {
  const root = mkdtempSync(join(tmpdir(), 'next-tui-budget-fixture-'));
  try {
    put(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', baseUrl: '.',
        // Intentionally broad-first: TypeScript chooses the longest matching prefix.
        paths: { '@*': ['src/fallback/*'], '@core/*': ['src/core/*'] },
      },
    }));
    put(root, 'src/tui/entry.ts', [
      "import { type OnlyType } from './only-type.js';",
      "export { type ExportOnly } from './export-only.js';",
      "import { value } from '@core/value';",
      'console.log(value);',
      '',
    ].join('\n'));
    put(root, 'src/tui/only-type.ts', 'export type OnlyType = string;\n');
    put(root, 'src/tui/export-only.ts', 'export type ExportOnly = number;\n');
    put(root, 'src/core/value.ts', "import './runtime-dep.js';\nexport const value = 1;\n");
    put(root, 'src/core/runtime-dep.ts', 'export const runtime = true;\n');
    put(root, 'src/fallback/core/value.ts', "import './wrong-target-dep.js';\nexport const value = 2;\n");
    put(root, 'src/fallback/core/wrong-target-dep.ts', 'export const wrong = true;\n');

    const closure = collectNextTuiRuntimeClosure(root, 'src/tui/entry.ts');
    const paths = closure.files.map((file) => relative(root, file)).sort();
    expect(paths).toEqual(['src/core/runtime-dep.ts', 'src/core/value.ts', 'src/tui/entry.ts']);
    // Source: #35260 fixture above contains these three runtime files and seven non-empty lines.
    expect(closure.metric).toEqual({ files: 3, lines: 7 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a default runtime import keeps its edge even with named type-only bindings', () => {
  const root = mkdtempSync(join(tmpdir(), 'next-tui-mixed-import-'));
  try {
    put(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler' } }));
    put(root, 'src/tui/entry.ts', "import Default, { type T } from './mixed.js';\nconsole.log(Default);\n");
    put(root, 'src/tui/mixed.ts', "import './runtime.js';\nexport type T = string;\nexport default 'live';\n");
    put(root, 'src/tui/runtime.ts', "export const live = true;\n");
    const paths = collectNextTuiRuntimeClosure(root).files.map((file) => relative(root, file)).sort();
    expect(paths).toEqual(['src/tui/entry.ts', 'src/tui/mixed.ts', 'src/tui/runtime.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the actual Tcl readiness regex requires every marker in one cleared frame', () => {
  const clear = '\x1b[H\x1b[2J';
  const complete = `${clear}Enter 전송 · Esc 취소 · Ctrl+Q 종료\n❯`;
  const split = `${clear}Enter 전송 · Esc 취소${clear}Ctrl+Q 종료\n❯`;
  const matches = (screen: string) => {
    const encoded = Buffer.from(screen).toString('hex');
    const script = `set sample [encoding convertfrom utf-8 [binary format H* {${encoded}}]]\nif {[regexp {${NEXT_TUI_READY_SCREEN_TCL_REGEX}} $sample]} {exit 0} else {exit 1}`;
    const result = spawnSync('expect', ['-c', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    return result.status;
  };
  expect(matches(complete)).toBe(0);
  expect(matches(split)).toBe(1);
});

test('ready-screen recognition matches a captured next TUI screen through the PTY simulator', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-tui-ready-screen-'));
  try {
    const capturedScreen = [
      'elanous next · 새 대화',
      '────────────────────────────────────────────────────────────────────────────────',
      '대화 기록 없음',
      'Enter 전송 · Esc 취소 · Ctrl+Q 종료',
      '❯ ',
    ].join('\r\n');
    put(root, 'ready-screen-child.ts', [
      'if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(2);',
      'process.stdin.setRawMode(true);',
      `const screen = ${JSON.stringify(capturedScreen)};`,
      'const paint = () => process.stdout.write("\\x1b[H\\x1b[2J" + screen);',
      'paint();',
      'process.stdin.on("data", (key) => { if (key.includes(17)) process.exit(0); paint(); });',
      '',
    ].join('\n'));
    const ready = isNextTuiReadyScreen;
    const run = await mockSeatPtySequence({
      root,
      args: ['{root}/ready-screen-child.ts'],
      // Source: #35260 PTY fixture timeout allows the fake child process to start and paint its ready screen.
      ready: { label: 'input-ready screen', until: ready, timeoutMs: 5_000 },
      // Escape re-renders the captured idle screen; Ctrl+Q is sent by the simulator for clean exit.
      // Source: #35260 PTY fixture uses the same five-second bound for its Escape repaint step.
      steps: [{ label: 'idle Escape', keys: '\x1b', until: ready, timeoutMs: 5_000 }],
    });
    expect(run.exitCode).toBe(0);
    expect(ready(run.frames[0]?.screen ?? '')).toBe(true);
    expect(ready('startup log: press Enter to continue')).toBe(false);
    expect(ready('Enter 전송 · Esc 취소 · Ctrl+Q 종료')).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route probe measures the production next TUI registry p99', () => {
  const result = spawnSync('bun', ['scripts/next-tui-budget.ts', '--route'], {
    cwd: join(import.meta.dir, '..'), encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as { route?: { status: string; p99Ms: number; routeId: string } };
  expect(report.route?.status).toBe('measured');
  expect(report.route?.routeId).toBe('help.next');
  expect(Number.isFinite(report.route?.p99Ms)).toBe(true);
  // Source: #35260 elapsed route durations cannot be negative; zero is valid at timer resolution.
  expect(report.route!.p99Ms).toBeGreaterThanOrEqual(0);
});
