// Pure argument rewrite used by test/preload-child-env.ts (kept apart so importing it has no side effects).

/** Insert `{ env }` as the options argument when the caller gave none or gave options without env. */
export function withEnv(args: readonly unknown[], env: Record<string, string | undefined>): unknown[] {
  const out = [...args];
  // (cmd, options?, cb?) or (file, args[], options?, cb?)
  const at = Array.isArray(out[1]) ? 2 : 1;
  const current = out[at];
  if (current === undefined || current === null || typeof current === 'function') {
    out.splice(Math.min(at, out.length), current === undefined || current === null ? 1 : 0, { env });
  } else if (typeof current === 'object' && (current as { env?: unknown }).env === undefined) {
    out[at] = { ...(current as object), env };
  }
  return out;
}

/** The env a child should get when the caller passed none: Bun's own default (the startup env) —
 *  except PATH, which follows the current process.env.PATH when a test changed it. Returns null when
 *  PATH is unchanged, meaning «leave the call exactly as it was». */
export function pathOnlyEnv(startup: Readonly<Record<string, string | undefined>>, current: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> | null {
  if (current.PATH === startup.PATH) return null;
  return { ...startup, PATH: current.PATH };
}
