// Phase 5 (PLAN-config-unification-elanous-root-2026-05-10) — Consumer audit:
//   regression guard against re-introducing `~/.config/elanous/{config.json,
//   policy, budget}` literals in production code outside the legacy
//   migrate helpers.
//
// Phase 6 (same PLAN) — XDG_CONFIG_HOME deprecation:
//   userConfigPath() emits a one-time stderr warning when the legacy XDG
//   path is in use · suppressible via ELANOUS_SUPPRESS_XDG_WARNING=1 ·
//   silent inside the test harness (ELANOUS_TEST_HOME).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  userConfigPath, __resetXdgDeprecationWarningForTests,
} from '../src/user-config';

const SRC_ROOT = join(import.meta.dir, '..', 'src');

// Files where the legacy `~/.config/elanous/{...}` literal is intentional
// — they are the migrate helpers that need to read FROM the old location.
const LEGACY_LITERAL_ALLOWLIST = new Set([
  'src/storage/legacy-elanous-config-migrate.ts',
  'src/storage/legacy-elanous-dir-migrate.ts',
]);

const LEGACY_PATTERNS: RegExp[] = [
  // join(homedir(), '.config', 'elanous', ...)
  /join\([^)]*,\s*['"`]\.config['"`]\s*,\s*['"`]elanous['"`]/,
  // ~/.config/elanous/{config,policy,budget}
  /['"`]~\/\.config\/elanous\/(config|policy|budget)/,
  // FU2 Tier 2/3: monad-agent legacy roots.
  /join\(\s*['"`]\.config['"`]\s*,\s*['"`]monad-agent['"`]/,
  /joinPath\([^)]*,\s*['"`]\.config['"`]\s*,\s*['"`]monad-agent['"`]/,
  /join\([^)]*,\s*['"`]\.monad-agent['"`]/,
];

// Lines inside `migrateLegacyHome*({ legacyHomeRel: ... })` are
// intentional legacy references — recognise them via the option name.
const INTENT_LEGACY_HINTS = ['legacyHomeRel', 'migrateLegacyHomeDir', 'migrateLegacyHomeFile'];

function* walkTs(dir: string, base: string): Iterable<{ rel: string; abs: string }> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const abs = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    const s = statSync(abs);
    if (s.isDirectory()) {
      yield* walkTs(abs, rel);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
      yield { rel: `src/${rel}`, abs };
    }
  }
}

describe('Phase 5 · consumer audit · grep guard', () => {
  test('scans production TypeScript but not test fixtures containing legacy paths', () => {
    const scanned = [...walkTs(SRC_ROOT, '')].map(({ rel }) => rel);
    expect(scanned).toContain('src/user-config.ts');
    expect(scanned).not.toContain('src/version/code-revision.test.ts');
    expect(scanned.every((rel) => !rel.endsWith('.test.ts'))).toBe(true);
  });

  test('production code has no `~/.config/elanous/{config,policy,budget}` literals outside legacy migrate helpers', () => {
    const offenders: string[] = [];
    for (const { rel, abs } of walkTs(SRC_ROOT, '')) {
      if (LEGACY_LITERAL_ALLOWLIST.has(rel)) continue;
      const content = readFileSync(abs, 'utf-8');
      // Multi-line scan window so `legacyHomeRel:` on the previous line
      // is recognised when the literal sits on its own continuation.
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        // skip line comments and block-comment lines (heuristic) ·
        // covers `//`, ` * ...`, `/* ...`, and `/** ...` JSDoc styles.
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//')) continue;
        if (trimmed.startsWith('*')) continue;
        if (trimmed.startsWith('/*')) continue;
        // Skip intentional legacy references inside migrate calls — the
        // hint keyword may appear on this line OR up to 3 lines above
        // (multi-line `migrateLegacyHomeFile({ legacyHomeRel: ... })`).
        const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        if (INTENT_LEGACY_HINTS.some((h) => window.includes(h))) continue;
        for (const pat of LEGACY_PATTERNS) {
          if (pat.test(line)) {
            offenders.push(`${rel}: ${line.trim()}`);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('legacy migrate helpers ARE in the allowlist (sanity)', () => {
    for (const path of LEGACY_LITERAL_ALLOWLIST) {
      const abs = join(import.meta.dir, '..', path);
      // statSync throws if missing → fail with a clear message.
      const s = statSync(abs);
      expect(s.isFile()).toBe(true);
    }
  });
});

describe('Phase 6 · XDG_CONFIG_HOME deprecation warning', () => {
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevForce = process.env.ELANOUS_TEST_FORCE_XDG_WARNING;
  const prevSuppress = process.env.ELANOUS_SUPPRESS_XDG_WARNING;
  const prevWrite = process.stderr.write;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    // Capture stderr without polluting test output. Cast through unknown
    // to bypass Node's overloaded write signature (we only need the
    // string-form invocation that emitXdgDeprecationWarningOnce uses).
    process.stderr.write = ((chunk: unknown) => {
      if (typeof chunk === 'string') captured.push(chunk);
      return true;
    }) as unknown as typeof process.stderr.write;
    __resetXdgDeprecationWarningForTests();
    // Test runtime is silent by default · opt in for warning assertions.
    process.env.ELANOUS_TEST_FORCE_XDG_WARNING = '1';
    delete process.env.ELANOUS_SUPPRESS_XDG_WARNING;
  });

  afterEach(() => {
    process.stderr.write = prevWrite;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevForce === undefined) delete process.env.ELANOUS_TEST_FORCE_XDG_WARNING;
    else process.env.ELANOUS_TEST_FORCE_XDG_WARNING = prevForce;
    if (prevSuppress === undefined) delete process.env.ELANOUS_SUPPRESS_XDG_WARNING;
    else process.env.ELANOUS_SUPPRESS_XDG_WARNING = prevSuppress;
    __resetXdgDeprecationWarningForTests();
  });

  test('XDG_CONFIG_HOME unset → no warning', () => {
    delete process.env.XDG_CONFIG_HOME;
    userConfigPath();
    userConfigPath();
    expect(captured.join('')).toBe('');
  });

  test('XDG_CONFIG_HOME set → one-time warning to stderr', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-fake';
    const path1 = userConfigPath();
    const path2 = userConfigPath();
    expect(path1).toBe('/tmp/xdg-fake/elanous/config.json');
    expect(path1).toBe(path2);

    const merged = captured.join('');
    expect(merged).toContain('XDG_CONFIG_HOME is set');
    expect(merged).toContain('/tmp/xdg-fake/elanous/config.json');
    expect(merged).toContain('~/.elanous/config.json');
    // Only emitted once even across repeated calls.
    expect(merged.match(/XDG_CONFIG_HOME is set/g)?.length).toBe(1);
  });

  test('ELANOUS_SUPPRESS_XDG_WARNING=1 silences warning', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-fake';
    process.env.ELANOUS_SUPPRESS_XDG_WARNING = '1';
    userConfigPath();
    expect(captured.join('')).toBe('');
  });

  test('test-runtime default: silent unless ELANOUS_TEST_FORCE_XDG_WARNING=1 set', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-fake';
    delete process.env.ELANOUS_TEST_FORCE_XDG_WARNING;
    userConfigPath();
    expect(captured.join('')).toBe('');
  });
});
