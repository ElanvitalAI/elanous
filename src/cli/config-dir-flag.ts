// `--config-dir <dir>` global CLI flag (2026-05-12).
//
// Both forms are accepted at any position in argv:
//   elanous --config-dir /tmp/x nexus run
//   elanous nexus run --config-dir /tmp/x
//   elanous wf validate --config-dir=/tmp/x ./flow.yaml
//
// The flag is extracted *before* Commander parses, so it never
// counts as an unknown subcommand argument and there is no need
// to thread an option through every nested .command(). When set,
// it routes through `setElanousConfigDir()` in src/elanous-config-dir.ts
// — the single source of truth that every consumer now imports.
//
// Empty / whitespace-only values are silently dropped.
//
// Returns the resolved directory (or undefined when no flag).
// Caller is responsible for invoking the setter — see
// `applyConfigDirFlagFromArgv` for the side-effecting wrapper
// that index.ts mounts at startup.

export interface ConfigDirFlagResult {
  /** The directory the user passed, or undefined when the flag was absent. */
  dir: string | undefined;
  /** A new argv array with the `--config-dir <dir>` / `--config-dir=<dir>`
   *  tokens removed. Same array identity as the input when no flag was found. */
  argv: string[];
}

/** Pure extractor — does not mutate the input array. Last occurrence wins. */
export function extractConfigDirFlag(argv: readonly string[]): ConfigDirFlagResult {
  const out: string[] = [];
  let found: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (tok === '--config-dir') {
      const next = argv[i + 1];
      if (typeof next === 'string' && next.trim().length > 0) {
        found = next.trim();
        i += 2;
        continue;
      }
      // Missing / blank value — skip the bare flag and continue parsing.
      i += 1;
      continue;
    }
    const eqMatch = /^--config-dir=(.*)$/.exec(tok);
    if (eqMatch) {
      const v = eqMatch[1]!.trim();
      if (v.length > 0) found = v;
      i += 1;
      continue;
    }
    out.push(tok);
    i += 1;
  }
  return { dir: found, argv: out };
}

/** Removes the flag from `process.argv` + routes the value through
 *  `setElanousConfigDir()`. Spawned children inherit the override via
 *  `--config-dir <dir>` re-appended to argv (see `bg-launch.ts` —
 *  2026-05-13 config-dir-unify removed the previous env-var
 *  inheritance path). Idempotent — repeated calls with no flag are
 *  no-ops. */
export function applyConfigDirFlagFromArgv(): string | undefined {
  const { dir, argv } = extractConfigDirFlag(process.argv);
  if (dir === undefined) return undefined;
  // Lazy import — avoids a circular dep when this module is pulled
  // in by tooling that itself imports the resolver.
  const { setElanousConfigDir } = require('../elanous-config-dir.js') as typeof import('../elanous-config-dir.js');
  setElanousConfigDir(dir, 'flag');
  process.argv = argv;
  return dir;
}
