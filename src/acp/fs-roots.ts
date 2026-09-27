// PLAN-ipad-server-side-file-browser §3.1 + §4.3 (F1) — root resolver
// shared by elanous/fs/list · elanous/fs/read · elanous/fs/stat ·
// elanous/obsidian/info.
//
// Two roots:
//   - cwd       — daemon process.cwd() (the repo the daemon was launched in)
//   - obsidian  — Obsidian vault, resolved through the fallback chain below.
//
// All paths under either root are clamped — `..` cannot escape. The cwd
// root accepts any directory under the daemon's launch cwd (PLAN §4.3
// "cwd root = process.cwd() 위만 허용"); the obsidian root is similarly
// clamped to the resolved vault path.
//
// Obsidian resolution chain (config wipe-resilient — see user feedback
// 2026-05-16): live user config → env vars → ~/.elanous backup chain →
// default ~/Documents/Obsidian → ~/Obsidian/* auto-discovery via
// .obsidian/ signature → unavailable. The first **existsSync** hit
// wins; result is cached at process scope so a mid-session config.json
// wipe (test harness, restoration) cannot strand a running daemon.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { getUserConfig } from '../user-config.js';
import { fallbackObsidianVault } from '../obsidian/default-vault.js';

export type FsRootKind = 'cwd' | 'obsidian';

export type ObsidianSource =
  | 'config'      // live ~/.elanous/config.json
  | 'env'         // OBSIDIAN_VAULT or ELANOUS_OBSIDIAN_VAULT
  | 'backup'      // ~/.elanous/config.json.{bak,backup-*,PRESERVED-*,*.json}
  | 'default'     // ~/Documents/Obsidian present on disk
  | 'discovery'   // ~/Obsidian/* containing a .obsidian/ subdirectory
  | 'none';       // nothing found — `available: false`

export interface ObsidianResolution {
  root: string;
  available: boolean;
  source: ObsidianSource;
}

let cachedObsidian: ObsidianResolution | null = null;

/** Read a config.json-shaped file and pull out `obsidian.vault` if
 *  present. Tolerates malformed JSON / missing keys silently — the
 *  caller skips this candidate and tries the next one. */
function readObsidianVaultFromConfigFile(p: string): string | null {
  try {
    const raw = readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    const v = obj?.obsidian?.vault;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Walk ~/.elanous for any config.json* file and return the vault path
 *  from the newest one whose vault still exists on disk. Order:
 *  newest mtime first, so the most recent wipe-survivor wins. */
function discoverObsidianFromBackups(home: string): string | null {
  const candidates: Array<{ path: string; mtime: number }> = [];
  const elanousDir = join(home, '.elanous');
  const collect = (dir: string) => {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith('config') || !name.includes('json')) continue;
        const p = join(dir, name);
        try {
          const st = statSync(p);
          if (st.isFile()) candidates.push({ path: p, mtime: st.mtimeMs });
        } catch {
          // entry vanished between readdir + stat — ignore
        }
      }
    } catch {
      // directory missing or unreadable — skip silently
    }
  };
  collect(elanousDir);
  collect(join(elanousDir, 'backups'));
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    const v = readObsidianVaultFromConfigFile(c.path);
    if (v && existsSync(v)) return v;
  }
  return null;
}

/** Look under ~/Obsidian/* for any directory containing a `.obsidian/`
 *  subdirectory — Obsidian's per-vault config marker. Returns the
 *  first match (alphabetical readdir order). */
function discoverObsidianFromHome(home: string): string | null {
  const obsidianHome = join(home, 'Obsidian');
  if (!existsSync(obsidianHome)) return null;
  try {
    for (const name of readdirSync(obsidianHome)) {
      const p = join(obsidianHome, name);
      try {
        if (!statSync(p).isDirectory()) continue;
        if (existsSync(join(p, '.obsidian'))) return p;
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // Obsidian home unreadable — skip
  }
  return null;
}

function computeObsidianResolution(): ObsidianResolution {
  const home = process.env.HOME ?? '';
  // 1. Live user config — primary source the user is expected to edit.
  try {
    const cfg = getUserConfig();
    const v = cfg.obsidian?.vault;
    if (v && existsSync(v)) return { root: resolvePath(v), available: true, source: 'config' };
  } catch {
    // getUserConfig guards malformed config.json itself; ignore here.
  }
  // 2. Env override — supports both legacy OBSIDIAN_VAULT and the
  //    auto-research bridge's ELANOUS_OBSIDIAN_VAULT.
  const envVault = (process.env.OBSIDIAN_VAULT?.trim() || process.env.ELANOUS_OBSIDIAN_VAULT?.trim());
  if (envVault && existsSync(envVault)) {
    return { root: resolvePath(envVault), available: true, source: 'env' };
  }
  // 3. Backup chain — wipe-resilient. Picks newest backup whose stored
  //    vault still resolves on disk.
  const fromBackup = discoverObsidianFromBackups(home);
  if (fromBackup) return { root: resolvePath(fromBackup), available: true, source: 'backup' };
  // 4. Conventional default — old elanous installs and the obsidianDefaults()
  //    fallback both pin this path.
  const def = fallbackObsidianVault(home);
  if (existsSync(def)) return { root: resolvePath(def), available: true, source: 'default' };
  // 5. Auto-discovery — last-resort scan for any vault-shaped sibling.
  const discovered = discoverObsidianFromHome(home);
  if (discovered) return { root: resolvePath(discovered), available: true, source: 'discovery' };
  // 6. Nothing — surface `available: false` so the iPad hides the chip.
  return { root: def, available: false, source: 'none' };
}

/** Resolve the Obsidian vault using the chain in
 *  `computeObsidianResolution`. The result is cached at process scope
 *  so a mid-session config wipe doesn't strand a running daemon. Pass
 *  `forceRefresh: true` to re-run the chain (used by tests + future
 *  `/reload-config` slash). */
export function resolveObsidianRoot(opts?: { forceRefresh?: boolean }): ObsidianResolution {
  if (cachedObsidian && !opts?.forceRefresh) return cachedObsidian;
  const result = computeObsidianResolution();
  // Only cache successful resolutions — an `available: false` result
  // should re-attempt next call in case the user just created the vault.
  if (result.available) cachedObsidian = result;
  return result;
}

/** Test-only — drop the cached resolution so a follow-up call re-runs
 *  the chain. Production code should use `forceRefresh: true` instead. */
export function _resetObsidianCacheForTests(): void {
  cachedObsidian = null;
}

/** Resolve the base directory for a given root kind. Throws when an
 *  obsidian root is requested but no vault is available — callers
 *  should `elanous/obsidian/info` first to gate the UI. */
export function resolveFsRoot(kind: FsRootKind): string {
  if (kind === 'obsidian') {
    const r = resolveObsidianRoot();
    if (!r.available) throw new Error('obsidian-vault-unavailable');
    return r.root;
  }
  return resolvePath(process.cwd());
}

/** Resolve a possibly-relative `requested` path against `baseRoot` and
 *  refuse to escape it. Returns the absolute resolved path on success
 *  or `null` when the resolved path falls outside `baseRoot`. The
 *  `path.startsWith(baseRoot)` guard intentionally treats `baseRoot`
 *  as the inclusive lower bound (the root itself is allowed). */
export function clampToRoot(baseRoot: string, requested: string): string | null {
  const abs = resolvePath(requested);
  const base = resolvePath(baseRoot);
  if (abs !== base && !abs.startsWith(base + '/')) return null;
  return abs;
}

const HIDDEN_DENYLIST = new Set(['node_modules']);

/** Filter applied to readdir entries before they reach the iPad. PLAN
 *  §4.3 calls out `.git`, `.env*`, `node_modules` explicitly — the
 *  dotfile prefix already covers `.git`/`.env*`/`.DS_Store`/etc., and
 *  `node_modules` is added explicitly because it isn't a dotfile but
 *  produces unhelpful list noise on every Node project. F5 polish can
 *  surface a "show hidden" toggle. */
export function isHiddenForBrowser(name: string): boolean {
  if (HIDDEN_DENYLIST.has(name)) return true;
  return name.startsWith('.');
}
