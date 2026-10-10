import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Explicit stand-in when a ledger field is absent. */
export const CLAUDE_PACKAGE_MISSING = '없다';

export const INSTALLED_PLUGINS_FILENAME = 'installed_plugins.json';
export const KNOWN_MARKETPLACES_FILENAME = 'known_marketplaces.json';

export type ClaudePackageLedgerStatus =
  | 'ok'
  | 'installed-plugins-unreadable'
  | 'known-marketplaces-unreadable';

export interface ClaudeInstalledPackage {
  /** Compound ledger key `<plugin>@<market>`. */
  name: string;
  plugin: string;
  marketplace: string;
  installPath: string;
  scope: string;
  /** Marketplace origin, or `없다` when the market has no source. */
  source: string;
  /** Ledger `version`, or `없다` when that field is absent. */
  revision: string;
}

export interface ClaudePackageLedger {
  status: ClaudePackageLedgerStatus;
  packages: ClaudeInstalledPackage[];
}

export interface ReadClaudePackageLedgerOptions {
  /** Override `~/.claude/plugins`. Tests pass a temp root; production omits this. */
  pluginsRoot?: string;
}

export function defaultClaudePluginsRoot(): string {
  return join(homedir(), '.claude', 'plugins');
}

/**
 * Split an `installed_plugins.json` compound key at the last `@`.
 * Plugin names do not include the market; the market is the suffix after that `@`.
 */
export function splitClaudePluginKey(key: string): { plugin: string; marketplace: string } {
  const at = key.lastIndexOf('@');
  if (at <= 0 || at === key.length - 1) {
    return { plugin: key, marketplace: CLAUDE_PACKAGE_MISSING };
  }
  return {
    plugin: key.slice(0, at),
    marketplace: key.slice(at + 1),
  };
}

/**
 * Read-only Claude plugin ledger reader.
 * Reads `installed_plugins.json` and `known_marketplaces.json` only.
 * Does not scan install directories, spawn processes, or write files.
 */
export function readClaudePackageLedger(
  options: ReadClaudePackageLedgerOptions = {},
): ClaudePackageLedger {
  const root = options.pluginsRoot ?? defaultClaudePluginsRoot();
  const installedPath = join(root, INSTALLED_PLUGINS_FILENAME);
  const marketplacesPath = join(root, KNOWN_MARKETPLACES_FILENAME);

  const installedRaw = readJsonFile(installedPath);
  if (installedRaw === undefined) {
    return { status: 'installed-plugins-unreadable', packages: [] };
  }

  const plugins = asPluginMap(installedRaw);
  if (plugins === undefined) {
    return { status: 'installed-plugins-unreadable', packages: [] };
  }

  const marketplaces = asMarketplaceMap(readJsonFile(marketplacesPath));
  const status: ClaudePackageLedgerStatus = marketplaces === undefined ? 'known-marketplaces-unreadable' : 'ok';
  const packages: ClaudeInstalledPackage[] = [];
  for (const [key, records] of Object.entries(plugins)) {
    const { plugin, marketplace } = splitClaudePluginKey(key);
    const source = formatMarketplaceSource(marketplaces?.[marketplace]);
    for (const record of records) {
      packages.push({
        name: key,
        plugin,
        marketplace,
        installPath: presentString(record.installPath),
        scope: presentString(record.scope),
        source,
        revision: presentString(record.version),
      });
    }
  }

  return { status, packages };
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function asPluginMap(
  raw: unknown,
): Record<string, Array<Record<string, unknown>>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const plugins = (raw as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return undefined;
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    out[key] = value.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item),
    );
  }
  return out;
}

function asMarketplaceMap(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function formatMarketplaceSource(entry: unknown): string {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return CLAUDE_PACKAGE_MISSING;
  const source = (entry as { source?: unknown }).source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return CLAUDE_PACKAGE_MISSING;
  const fields = source as Record<string, unknown>;
  const kind = typeof fields.source === 'string' ? fields.source : '';
  const repo = typeof fields.repo === 'string' ? fields.repo : '';
  const url = typeof fields.url === 'string' ? fields.url : '';
  if (kind && repo) return `${kind}:${repo}`;
  if (kind && url) return `${kind}:${url}`;
  if (repo) return repo;
  if (url) return url;
  if (kind) return kind;
  return CLAUDE_PACKAGE_MISSING;
}

function presentString(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : CLAUDE_PACKAGE_MISSING;
}
