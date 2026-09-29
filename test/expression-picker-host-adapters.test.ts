// Picker family a11y integration — Pick A PR-S2.
//
// Each picker host (session / ssh / transfer / finder) now
// exports a pure `buildXxxPickerSpec(...)` helper that wraps the
// existing SearchItem build logic with `searchItemsToPickerSpec`.
// Tests exercise:
//   - shape of the returned spec (kind, id, title, items.length)
//   - ANSI strip on labels (regression — the visual labels carry chalk)
//   - description preserved (the new SR-friendly second-line)
//   - describeForScreenReader yields a clean, locale-aware utterance
//     when piped through the spec
//
// The pickers' own UX (createSearchModal wiring, query filter, accept)
// stays out of scope here — those are covered in their dedicated tests
// (session-picker-modal.test.ts, etc.).

import { describe, expect, test, beforeEach } from 'bun:test';

import { buildSessionPickerSpec } from '../src/session/picker-modal.js';
import { buildSshPickerSpec } from '../src/ssh/ssh-picker-modal.js';
import { buildTransferPickerSpec } from '../src/transfer/transfer-picker-modal.js';
import { buildFinderPickerSpec } from '../src/finder/finder-modal.js';
import {
  describeForScreenReader,
  type PickerSpec,
} from '../src/expression/index.js';
import type { TerminalSession, TerminalSessionRegistry } from '../src/terminal/session-registry.js';
import {
  _resetSshHostsForTesting,
  setSshHostsPathForTesting,
  touchSshHost,
  setSshHostsForTesting,
} from '../src/ssh/ssh-hosts.js';
import { TEST_FLEET } from './fixtures/ssh-fleet.js';
import type { TransferTarget } from '../src/transfer/transfer-targets.js';
import type { FinderItem } from '../src/finder/finder-modal.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[\d;]*m/g, '');

// ── Shared invariant helpers ─────────────────────────────────────────

function expectCleanSpec(spec: PickerSpec, expectedTitle: string) {
  expect(spec.kind).toBe('picker');
  expect(spec.title).toBe(expectedTitle);
  for (const item of spec.items) {
    // adapter strips ANSI
    expect(item.label).not.toContain('\x1b[');
  }
}

// ── 1. session-picker ────────────────────────────────────────────────

describe('buildSessionPickerSpec (PR-S2)', () => {
  function fakeSession(over: Partial<TerminalSession> = {}): TerminalSession {
    return {
      id: 'sess-1',
      title: 'alpha',
      cwd: '/tmp/a',
      kind: 'shell',
      startedAt: 1700000000_000,
      state: 'foreground',
      lastFocusedAt: 1700000000_000,
      exitCode: null,
      attentionLevel: 0,
      preview: {} as TerminalSession['preview'],
      modal: null,
      ...over,
    } as TerminalSession;
  }

  function fakeRegistry(sessions: TerminalSession[]): TerminalSessionRegistry {
    return { list: () => sessions } as unknown as TerminalSessionRegistry;
  }

  test('empty registry → empty spec with title', () => {
    const spec = buildSessionPickerSpec(fakeRegistry([]));
    expectCleanSpec(spec, 'Terminal sessions');
    expect(spec.items).toEqual([]);
  });

  test('lists non-exited sessions only', () => {
    const live = fakeSession({ id: 'live', title: 'alpha', state: 'foreground' });
    const dead = fakeSession({ id: 'dead', title: 'beta',  state: 'exited' });
    const spec = buildSessionPickerSpec(fakeRegistry([live, dead]));
    expect(spec.items.length).toBe(1);
    expect(spec.items[0]!.id).toBe('live');
  });

  test('description carries cwd + kind + state', () => {
    const sess = fakeSession({ id: 's1', cwd: '/var/work', kind: 'coding-agent' });
    const spec = buildSessionPickerSpec(fakeRegistry([sess]));
    expect(spec.items[0]!.description).toContain('/var/work');
    expect(spec.items[0]!.description).toContain('coding-agent');
    expect(spec.items[0]!.description).toContain('foreground');
  });

  test('describeForScreenReader prefixes title + count (en)', () => {
    const spec = buildSessionPickerSpec(
      fakeRegistry([
        fakeSession({ id: 'a', title: 'one' }),
        fakeSession({ id: 'b', title: 'two' }),
      ]),
    );
    const out = describeForScreenReader(spec, { locale: 'en' });
    expect(out).toContain('Terminal sessions');
    expect(out).toContain('Choose one of 2 options');
  });
});

// ── 2. ssh-picker ────────────────────────────────────────────────────

describe('buildSshPickerSpec (PR-S2)', () => {
  beforeEach(() => {
    _resetSshHostsForTesting();
    setSshHostsForTesting(TEST_FLEET);
    // Force the default-hosts path (no on-disk override).
    setSshHostsPathForTesting('/non-existent-path');
  });

  test('default hosts populate spec', () => {
    const spec = buildSshPickerSpec(null, 1700000000_000);
    expectCleanSpec(spec, 'SSH hosts');
    expect(spec.items.length).toBeGreaterThan(0);
  });

  test('active host description annotates "active"', () => {
    const spec = buildSshPickerSpec('mba', 1700000000_000);
    const mba = spec.items.find((i) => i.id === 'mba');
    expect(mba).toBeDefined();
    expect(mba!.description).toContain('active');
  });

  test('inactive hosts described as "idle"', () => {
    const spec = buildSshPickerSpec('mba', 1700000000_000);
    const idle = spec.items.find((i) => i.id !== 'mba')!;
    expect(idle.description).toContain('idle');
  });

  test('last-used reflected in description', () => {
    touchSshHost('mbp', 1700000000_000 - 5_000);
    const spec = buildSshPickerSpec(null, 1700000000_000);
    const mbp = spec.items.find((i) => i.id === 'mbp')!;
    expect(mbp.description).toContain('5s ago');
  });

  test('never-used hosts described as "never used"', () => {
    const spec = buildSshPickerSpec(null, 1700000000_000);
    const untouched = spec.items.find((i) => !i.description!.includes('ago'))!;
    expect(untouched.description).toContain('never used');
  });
});

// ── 3. transfer-picker ───────────────────────────────────────────────

describe('buildTransferPickerSpec (PR-S2)', () => {
  const sshTarget: TransferTarget = {
    kind: 'ssh',
    name: 'backup',
    host: { name: 'mba', host: 'mba', description: 'MacBook Air' },
    remoteDir: '~/Transfers/',
  };
  const iphoneTarget: TransferTarget = {
    kind: 'iphone',
    name: 'My iPhone',
    pushcutName: 'elanous-file-received',
  };

  test('empty targets → empty spec', () => {
    const spec = buildTransferPickerSpec([]);
    expectCleanSpec(spec, 'Transfer destination');
    expect(spec.items).toEqual([]);
  });

  test('ssh target description carries host + remoteDir', () => {
    const spec = buildTransferPickerSpec([sshTarget]);
    expect(spec.items[0]!.description).toContain('ssh');
    expect(spec.items[0]!.description).toContain('mba');
    expect(spec.items[0]!.description).toContain('~/Transfers/');
  });

  test('iphone target description carries transport summary', () => {
    const spec = buildTransferPickerSpec([iphoneTarget]);
    expect(spec.items[0]!.description).toContain('iphone');
    expect(spec.items[0]!.description).toContain('pushcut');
    expect(spec.items[0]!.description).toContain('elanous-file-received');
  });

  test('summary appended to title', () => {
    const spec = buildTransferPickerSpec([sshTarget], '3 files (842 KB)');
    expect(spec.title).toBe('Transfer destination · 3 files (842 KB)');
  });

  test('iphone with no transport → "no transport" hint', () => {
    const empty: TransferTarget = { kind: 'iphone', name: 'noTransport' };
    const spec = buildTransferPickerSpec([empty]);
    expect(spec.items[0]!.description).toContain('no transport');
  });
});

// ── 4. finder-picker ─────────────────────────────────────────────────

describe('buildFinderPickerSpec (PR-S2)', () => {
  const sample: FinderItem[] = [
    { relPath: 'src/index.ts', absPath: '/proj/src/index.ts' },
    { relPath: 'README.md',    absPath: '/proj/README.md' },
    { relPath: 'src/util/x.ts', absPath: '/proj/src/util/x.ts' },
  ];

  test('default title + items count', () => {
    const spec = buildFinderPickerSpec(sample);
    expectCleanSpec(spec, 'Find file');
    expect(spec.items.length).toBe(3);
  });

  test('description = absolute path (visual label is relative)', () => {
    const spec = buildFinderPickerSpec(sample);
    const ix = spec.items.find((i) => i.label.includes('index.ts'))!;
    expect(ix.description).toBe('/proj/src/index.ts');
  });

  test('truncated flag annotates title', () => {
    const spec = buildFinderPickerSpec(sample, { truncated: true });
    expect(spec.title).toContain('truncated');
  });

  test('custom title carried through', () => {
    const spec = buildFinderPickerSpec(sample, { title: 'Pick file from src/' });
    expect(spec.title).toBe('Pick file from src/');
  });

  test('maxItems caps at 500 by default', () => {
    const big: FinderItem[] = Array.from({ length: 600 }, (_, i) => ({
      relPath: `f${i}.ts`,
      absPath: `/proj/f${i}.ts`,
    }));
    const spec = buildFinderPickerSpec(big);
    expect(spec.items.length).toBe(500);
  });

  test('describeForScreenReader announces the title + count', () => {
    const spec = buildFinderPickerSpec(sample);
    const out = describeForScreenReader(spec, { locale: 'en' });
    expect(out).toContain('Find file');
    expect(out).toContain('Choose one of 3 options');
  });
});

// ── Cross-host invariants ────────────────────────────────────────────

describe('PR-S2 cross-host invariants', () => {
  test('all 4 specs share kind="picker"', () => {
    const specs: PickerSpec[] = [
      buildSessionPickerSpec({ list: () => [] } as unknown as TerminalSessionRegistry),
      buildSshPickerSpec(null, 0),
      buildTransferPickerSpec([]),
      buildFinderPickerSpec([]),
    ];
    for (const s of specs) {
      expect(s.kind).toBe('picker');
    }
  });

  test('each helper returns a stable id (not random)', () => {
    const empty = buildTransferPickerSpec([]);
    expect(empty.id).toBe('transfer-picker');
    const finder = buildFinderPickerSpec([]);
    expect(finder.id).toBe('finder-picker');
  });

  test('describeForScreenReader on every spec is ANSI-free', () => {
    const specs: PickerSpec[] = [
      buildTransferPickerSpec([
        { kind: 'ssh', name: 't', host: { name: 'h', host: 'h' }, remoteDir: '~' },
      ]),
      buildFinderPickerSpec([{ relPath: 'a.ts', absPath: '/a.ts' }]),
    ];
    for (const s of specs) {
      const utt = describeForScreenReader(s, { locale: 'en' });
      expect(utt).not.toContain('\x1b[');
      expect(stripAnsi(utt)).toBe(utt);
    }
  });
});
