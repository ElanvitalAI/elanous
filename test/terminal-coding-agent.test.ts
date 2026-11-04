import { describe, expect, test, beforeAll } from 'bun:test';

import {
  spawnCodingAgent,
  CodingAgentBinaryMissing,
} from '../src/terminal/coding-agent.js';
import {
  TerminalSessionRegistry,
  type TerminalSession,
} from '../src/terminal/session-registry.js';
import { DisplayCoordinator } from '../src/display/coordinator.js';
import type { PreviewTerminalOpts, PreviewTerminal } from '../src/preview/terminal.js';

// Skip the runPrintenvCapture path under bun:test — getCapturedEnv()
// will return process.env (which already has HOME/USER/PATH on any
// dev machine running the tests) instead of trying to spawn the
// user's login shell.
beforeAll(() => {
  process.env.ELANOUS_SKIP_LOGIN_ENV = '1';
});

function fakePreview(opts: PreviewTerminalOpts): PreviewTerminal {
  let alive = false;
  return {
    start: () => { alive = true; },
    stop: () => { alive = false; },
    write: () => {},
    resize: () => {},
    render: () => '',
    cursorPosition: () => alive ? ({ row: 0, col: 0 }) : null,
    get isAlive(): boolean { return alive; },
    get cols(): number { return opts.cols; },
    get rows(): number { return opts.rows; },
    get pid(): number { return 1; },
    get isScrolledBack(): boolean { return false; },
    get scrollbackOffset(): number { return 0; },
    get wantsMouse(): boolean { return false; },
    scrollUp: () => 0,
    scrollDown: () => 0,
    scrollToTop: () => {},
    scrollToTail: () => {},
    forwardMouse: () => {},
  } as unknown as PreviewTerminal;
}

function makeRegistry() {
  const coord = new DisplayCoordinator({ frameMs: 0 });
  return new TerminalSessionRegistry({
    coordinator: coord,
    terminalFactory: fakePreview,
  });
}

describe('spawnCodingAgent', () => {
  test('throws when binary missing', () => {
    const registry = makeRegistry();
    expect(() => spawnCodingAgent(
      { brand: 'claude-code', cwd: '/tmp/proj' },
      { registry, termCols: 100, termRows: 30, whichBinary: () => null },
    )).toThrow(CodingAgentBinaryMissing);
  });

  test('spawns session with kind=coding-agent + correct command', () => {
    const registry = makeRegistry();
    const session = spawnCodingAgent(
      { brand: 'claude-code', cwd: '/tmp/my-project' },
      { registry, termCols: 100, termRows: 30, whichBinary: () => '/usr/bin/claude', wrapCommand: (c) => c },
    );
    expect(session.kind).toBe('coding-agent');
    expect(session.agentBrand).toBe('claude-code');
    expect(session.command).toBe('claude');
    expect(session.title).toContain('claude-code');
    expect(session.title).toContain('my-project');
    expect(session.termName).toBe('xterm-ghostty');
  });

  test('extraArgs append to command', () => {
    const registry = makeRegistry();
    const session = spawnCodingAgent(
      { brand: 'codex', cwd: '/tmp/p', extraArgs: ['--resume', 'abc123'] },
      { registry, termCols: 100, termRows: 30, whichBinary: () => '/usr/bin/codex' },
    );
    expect(session.command).toBe('codex -c \'projects."/tmp/p".trust_level="trusted"\' --resume abc123');
  });

  test('onSpawned hook fires post-spawn', () => {
    const registry = makeRegistry();
    let seen: TerminalSession | null = null;
    const session = spawnCodingAgent(
      { brand: 'codex', cwd: '/tmp/p' },
      {
        registry,
        termCols: 100, termRows: 30,
        whichBinary: () => '/usr/bin/codex',
        onSpawned: (s) => { seen = s; },
      },
    );
    expect(seen).not.toBeNull();
    expect(seen!.id).toBe(session.id);
  });

  test('custom title override', () => {
    const registry = makeRegistry();
    const session = spawnCodingAgent(
      { brand: 'claude-code', cwd: '/x', title: 'my-agent' },
      { registry, termCols: 100, termRows: 30, whichBinary: () => '/usr/bin/claude', wrapCommand: (c) => c },
    );
    expect(session.title).toBe('my-agent');
  });

  test('brand=claude-code applies wrapCommand', () => {
    const registry = makeRegistry();
    const session = spawnCodingAgent(
      { brand: 'claude-code', cwd: '/x' },
      {
        registry, termCols: 100, termRows: 30,
        whichBinary: () => '/usr/bin/claude',
        wrapCommand: (c) => `SH:${c}`,
      },
    );
    expect(session.command).toBe('SH:claude');
  });

  test('brand=codex skips wrapCommand (codex does not use keychain)', () => {
    const registry = makeRegistry();
    const session = spawnCodingAgent(
      { brand: 'codex', cwd: '/x' },
      {
        registry, termCols: 100, termRows: 30,
        whichBinary: () => '/usr/bin/codex',
        wrapCommand: (c) => `SH:${c}`,
      },
    );
    expect(session.command).toBe('codex -c \'projects."/x".trust_level="trusted"\'');
  });

  test('brand=gemini spawns gemini binary + skips wrapCommand', () => {
    const registry = makeRegistry();
    const session = spawnCodingAgent(
      { brand: 'gemini', cwd: '/tmp/g' },
      {
        registry, termCols: 100, termRows: 30,
        whichBinary: () => '/usr/local/bin/gemini',
        wrapCommand: (c) => `SH:${c}`,
      },
    );
    expect(session.kind).toBe('coding-agent');
    expect(session.agentBrand).toBe('gemini');
    // gemini does not read the macOS keychain, so the wrap is
    // skipped just like codex (only claude-code applies it).
    expect(session.command).toBe('gemini');
    expect(session.title).toContain('gemini');
  });

  // Regression: an earlier version passed only 4 vars
  // (ELANOUS_AGENT_BRAND/TERM/CLICOLOR/CLICOLOR_FORCE) as the spawn
  // env. PreviewTerminal replaces (not merges) when opts.env is
  // provided, so the child PTY ended up without HOME — and the
  // SSH keychain wrap's `$HOME/Library/Keychains/login.keychain-db`
  // expanded to "/Library/...", silently failing the unlock and
  // leaving claude with not-logged-in state.
  test('spawned env merges captured login env (HOME present) (regression)', () => {
    const captured: PreviewTerminalOpts[] = [];
    const coord = new DisplayCoordinator({ frameMs: 0 });
    const registry = new TerminalSessionRegistry({
      coordinator: coord,
      terminalFactory: (opts) => { captured.push(opts); return fakePreview(opts); },
    });
    spawnCodingAgent(
      { brand: 'claude-code', cwd: '/tmp/x' },
      {
        registry, termCols: 100, termRows: 30,
        whichBinary: () => '/usr/bin/claude',
        wrapCommand: (c) => c,
      },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].env).toBeDefined();
    // HOME comes from process.env via getCapturedEnv() (with
    // ELANOUS_SKIP_LOGIN_ENV=1 set in beforeAll). Any dev machine has it.
    expect(captured[0].env!.HOME).toBeTruthy();
    // The brand-specific overrides still win.
    expect(captured[0].env!.ELANOUS_AGENT_BRAND).toBe('claude-code');
    expect(captured[0].env!.TERM).toBe('xterm-ghostty');
  });
});
