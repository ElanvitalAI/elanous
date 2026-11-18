// RAIL-STALE-TUI-HEAD — «이 프로세스는 옛 판인가». A rail update swaps `<prefix>/current` and
// restarts nexus; a TUI started earlier keeps running `<prefix>/versions/<old>` with its old pinned
// head, and app_build then fails at the local bridge (11-17 MVP-B incident). This module compares the
// running head to (1) the installed `current` version's install.json commit and (2) the head nexus
// published in runtime.json — file metadata only, never git. Pure apart from injected reads.
// The classic dashboard has its own installed-commit poll (src/pty-shell/stale-install-check.ts);
// this one serves the next TUI and adds the nexus head, the side the app-build bridge enforces.
import { readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { readNexusRuntimeAt } from '../nexus/runtime.js';
import { nexusRuntimePath } from '../nexus/paths.js';
import { shortSourceHead, staleSideOf, type StaleSide } from '../nexus/apps/app-build-head-mismatch.js';

const PACKAGE_ROOT = resolve(import.meta.dir, '..', '..');
const HEAD = /^[0-9a-f]{40}$/u;

export interface StaleInstallVerdict {
  readonly stale: boolean;
  readonly runningHead?: string;
  /** Commit of `<prefix>/current/install.json` when this process runs from an installed version dir. */
  readonly installedHead?: string;
  /** Head nexus pinned at start (runtime.json `sourceHead`). */
  readonly nexusHead?: string;
  /** The head the marker names: installed when this process is behind it, else the differing nexus head. */
  readonly newHead?: string;
  /** Which side to restart (present when stale): never `tui` unless the installed version proves it. */
  readonly side?: StaleSide;
}

export interface StaleInstallProbe {
  readonly runningHead: string | undefined;
  /** This package's root (…/versions/<v>/node_modules/elanous when installed). */
  readonly packageRoot?: string;
  readonly runtimePath?: string;
  readonly readText?: (path: string) => string;
  readonly readRuntimeHead?: (path: string) => string | undefined;
}

/** `<prefix>` for the installer layout `<prefix>/versions/<v>/node_modules/elanous`; undefined for a checkout. */
export function installPrefixOf(packageRoot: string): string | undefined {
  const root = resolve(packageRoot);
  if (basename(root) !== 'elanous') return undefined;
  const nodeModules = resolve(root, '..');
  if (basename(nodeModules) !== 'node_modules') return undefined;
  const versions = resolve(nodeModules, '..', '..');
  // A process started through `<prefix>/current/...` resolves to the version dir via realpath.
  if (basename(versions) === 'versions') return resolve(versions, '..');
  if (basename(resolve(nodeModules, '..')) === 'current') return resolve(nodeModules, '..', '..');
  return undefined;
}

function commitOf(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const commit = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { commit?: unknown }).commit : undefined;
    return typeof commit === 'string' && HEAD.test(commit.trim()) ? commit.trim() : undefined;
  } catch { return undefined; }
}

function defaultRuntimeHead(path: string): string | undefined {
  const head = readNexusRuntimeAt(path)?.sourceHead;
  return typeof head === 'string' && HEAD.test(head) ? head : undefined;
}

export function detectStaleInstall(probe: StaleInstallProbe): StaleInstallVerdict {
  const running = probe.runningHead && HEAD.test(probe.runningHead) ? probe.runningHead : undefined;
  if (!running) return { stale: false };
  const prefix = runningInstallPrefix(probe.packageRoot);
  // A checkout (test universe, dev tree) moves its HEAD by design and may share a nexus with another
  // tree; only an installed version dir has a «current» to fall behind. Its 409 still names the cause.
  if (!prefix) return { stale: false, runningHead: running };
  const installedHead = currentInstallHead(prefix, probe.readText);
  let nexusHead: string | undefined;
  try { nexusHead = (probe.readRuntimeHead ?? defaultRuntimeHead)(probe.runtimePath ?? nexusRuntimePath()); } catch { /* unknown */ }
  const installedDiffers = !!installedHead && installedHead !== running;
  const nexusDiffers = !!nexusHead && nexusHead !== running;
  return {
    stale: installedDiffers || nexusDiffers, runningHead: running,
    ...(installedHead ? { installedHead } : {}), ...(nexusHead ? { nexusHead } : {}),
    ...(installedDiffers ? { newHead: installedHead, side: 'tui' as const }
      : nexusDiffers ? { newHead: nexusHead, side: staleSideOf(running, nexusHead, installedHead) } : {}),
  };
}

function runningInstallPrefix(packageRoot?: string): string | undefined {
  let root = packageRoot ?? PACKAGE_ROOT;
  if (!packageRoot) { try { root = realpathSync(root); } catch { /* keep the literal path */ } }
  return installPrefixOf(root);
}

function currentInstallHead(prefix: string, readText: (path: string) => string = path => readFileSync(path, 'utf8')): string | undefined {
  try { return commitOf(readText(join(prefix, 'current', 'install.json'))); } catch { return undefined; }
}

/** Installed `current` commit for this process's install prefix; undefined for a checkout.
 * The app-build clients use it to tell which side of a head mismatch must restart. */
export function installedCurrentHead(packageRoot?: string, readText?: (path: string) => string): string | undefined {
  const prefix = runningInstallPrefix(packageRoot);
  return prefix ? currentInstallHead(prefix, readText) : undefined;
}

/** Status-line segment; null when the process is current (or nothing is known). */
export function staleInstallMarker(verdict: StaleInstallVerdict): string | null {
  if (!verdict.stale) return null;
  const head = shortSourceHead(verdict.newHead);
  if (verdict.side === 'tui') return `⟳ 재기동 필요 (새 판 ${head})`;
  if (verdict.side === 'nexus') return `⟳ nexus 재기동 필요 (nexus 옛 판 ${head})`;
  return `⟳ 판 불일치 (nexus ${head}) · 설치본과 다른 쪽 재기동`;
}

/** Check at boot and on turn start (no own timer). Logs `tui.stale-install` once per running→new pair. */
export function createStaleInstallWatch(options: {
  readonly detect: () => StaleInstallVerdict;
  readonly log?: (data: Record<string, unknown>) => void;
}) {
  const log = options.log ?? (data => debug.log('tui', 'stale-install', data, { level: 'warn' }));
  let marker: string | null = null;
  let logged: string | null = null;
  return {
    check(): string | null {
      let verdict: StaleInstallVerdict;
      try { verdict = options.detect(); } catch { return marker; }
      marker = staleInstallMarker(verdict);
      const key = verdict.stale ? `${verdict.side}:${verdict.runningHead}>${verdict.newHead}` : null;
      if (key && key !== logged) {
        logged = key;
        try {
          log({ runningHead: shortSourceHead(verdict.runningHead), installedHead: shortSourceHead(verdict.installedHead),
            nexusHead: shortSourceHead(verdict.nexusHead), side: verdict.side, marker });
        } catch { /* observation is best effort */ }
      }
      return marker;
    },
    marker: (): string | null => marker,
  };
}
