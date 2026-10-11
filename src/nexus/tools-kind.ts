import { readUserConfig, readSwitchValue } from './config/user-config.js';
import type { DaemonToolSurfaceKind } from '../boot/daemon-tools/types.js';

/** Resolve the active daemon tool surface kind for runNexus.
 *
 *  Resolution order (parity with `deriveChildEnv` for daemon tab spawn —
 *  the same switch fed into a daemon child env should govern the in-
 *  process path too):
 *
 *    1. CLI flag (`opts.tools`)                                     ← 1회 boot
 *    2. `ELANOUS_TOOLS` env                                           ← shell session
 *    3. UserConfig switch `global.tools` (PWA Settings 토글이 여기) ← 영구
 *    4. switch default = `'webterm'` (`builtins/global.ts:12`)       ← fallback
 *
 *  Pre-fix the in-process branch fell back to `'none'` while
 *  `deriveChildEnv` fell back to the switch default `'webterm'`. That
 *  meant a clean-machine `elanous nexus` (no flag/env) gave the in-process
 *  LLM call an empty tool catalog while a separately-launched
 *  `elanous serve` daemon honored the switch default's full surface —
 *  surprising divergence the user had no way to discover.
 *
 *  `'all'` is in the switch enum but has no `toolSurface()` impl yet;
 *  fall back to `'webterm'` (the most-capable wired surface). */
const daemonToolSurfaceKinds: Record<DaemonToolSurfaceKind, true> = {
  none: true,
  readonly: true,
  chat: true,
  webterm: true,
};

function resolveKnownToolsKind(raw: string): DaemonToolSurfaceKind | undefined {
  return Object.hasOwn(daemonToolSurfaceKinds, raw)
    ? raw as DaemonToolSurfaceKind
    : undefined;
}

export function resolveToolsKind(opts: { tools?: string }): DaemonToolSurfaceKind {
  let raw: string | undefined = opts.tools;
  if (!raw) raw = process.env.ELANOUS_TOOLS?.trim();
  if (!raw) {
    try {
      const cfg = readUserConfig();
      const v = readSwitchValue(cfg, 'global.tools');
      if (typeof v === 'string') raw = v;
    } catch { /* swallow — boot must not fail on a malformed config */ }
  }
  if (!raw) raw = 'webterm';
  return resolveKnownToolsKind(raw) ?? 'webterm';
}

/** Resolve the `:agent` (통합 모드 webterm dock) tool surface kind.
 *
 *  Distinct from {@link resolveToolsKind} because the integrated
 *  webterm-dock chat is **defined by** its PTY surface — WebTerminal*
 *  tools (Snapshot · Input · Screenshot) are what make `:agent`
 *  meaningful next to a live terminal. If the user has narrowed their
 *  user-config (`global.tools chat` / `readonly`) to keep the
 *  standalone `/chat` lighter, that preference must NOT bleed into the
 *  integrated dock — otherwise the `:agent` LLM loses access to the
 *  very terminal it's supposed to drive.
 *
 *  Resolution order:
 *    1. CLI flag (`opts.tools`)         ← explicit operator intent wins
 *    2. **`'webterm'`** (hardcoded)     ← env + global.tools intentionally
 *                                         skipped vs. resolveToolsKind
 *
 *  CLI flag is honored so a developer debugging tool selection
 *  (`elanous nexus run --tools readonly`) still sees a readonly `:agent`;
 *  but a clean-machine boot or a config-narrowed boot always gets
 *  webterm for the integrated dock. */
export function resolveAgentTurnToolsKind(opts: { tools?: string }): DaemonToolSurfaceKind {
  const raw = opts.tools?.trim();
  if (!raw) return 'webterm';
  // 'all' (or any unrecognized string) → webterm fallback, same as
  // resolveToolsKind so the two resolvers stay consistent for valid
  // CLI input.
  return resolveKnownToolsKind(raw) ?? 'webterm';
}