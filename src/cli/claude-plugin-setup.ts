import { spawnSync } from 'node:child_process';

const MARKETPLACE = 'elanous';
const PLUGIN = 'elanous@elanous';
const DEFAULT_SOURCE = 'ElanvitalAI/elanous';

export interface ClaudePluginCommandResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

export interface ClaudePluginSetupDeps {
  /** Executes an argv vector directly, without a shell. */
  run?: (binary: string, args: string[]) => ClaudePluginCommandResult | Promise<ClaudePluginCommandResult>;
  /** Tests whether a binary is on PATH. */
  has?: (binary: string) => boolean | Promise<boolean>;
}

export interface ClaudePluginSetupStep {
  command: string[];
  needed: boolean;
}

export interface ClaudePluginSetupPlan {
  source: string;
  claudeCode: boolean;
  node: boolean;
  elanous: boolean;
  marketplaceInstalled: boolean;
  pluginInstalled: boolean;
  steps: ClaudePluginSetupStep[];
  ready: boolean;
}

export interface ClaudePluginSetupResult {
  verification: ClaudePluginSetupPlan;
  mcpVerified: boolean;
  executed: string[][];
  ok: boolean;
}

function runBinary(binary: string, args: string[]): ClaudePluginCommandResult {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30_000 });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function hasBinary(binary: string): boolean {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return result.error === undefined && result.status === 0;
}

function entries(text: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['marketplaces', 'plugins', 'installed']) {
        if (Array.isArray(obj[key])) return obj[key];
      }
    }
  } catch { /* Older Claude versions print a human-readable list. */ }
  return null;
}

function marketplaceSource(entry: Record<string, unknown>): string | undefined {
  for (const key of ['source', 'url', 'repository']) {
    const value = entry[key];
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object') {
      for (const nested of ['repo', 'url', 'path']) {
        const source = (value as Record<string, unknown>)[nested];
        if (typeof source === 'string') return source;
      }
    }
  }
  return undefined;
}

function normalizeSource(source: string): string {
  const trimmed = source.trim();
  const displayed = trimmed.match(/^(GitHub|Directory)\s*\((.*)\)$/i);
  const value = displayed ? displayed[2]!.trim() : trimmed;
  const github = value.replace(/^https?:\/\/github\.com\//i, '').replace(/^github:/i, '')
    .replace(/\.git$/i, '').replace(/\/$/, '');
  return /^[^/\s]+\/[^/\s]+$/.test(github) ? github.toLowerCase() : value;
}

/** A named marketplace with an unknown source is not safe to reuse for --source. */
function marketplacePresent(text: string, source: string): boolean {
  const list = entries(text);
  if (list !== null) {
    for (const entry of list) {
      const item = typeof entry === 'string' ? { name: entry } : entry;
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.name !== MARKETPLACE && record.id !== MARKETPLACE) continue;
      const existing = marketplaceSource(record);
      if (!existing || normalizeSource(existing) !== normalizeSource(source)) {
        throw new Error(`Claude marketplace ${MARKETPLACE} source is unknown or differs from requested source: ${source}`);
      }
      return true;
    }
    return false;
  }
  // The human-readable CLI prints the source under the marketplace heading.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:[❯*]\s*)?elanous(?:\s*[:(].*)?\s*$/.test(lines[i]!)) continue;
    const inline = lines[i]!.match(/^\s*(?:[❯*]\s*)?elanous\s*:\s*(.+)$/)?.[1];
    const next = lines[i + 1]?.match(/^\s+Source:\s*(.+)$/i)?.[1];
    const existing = next ?? inline;
    if (!existing || normalizeSource(existing) !== normalizeSource(source)) {
      throw new Error(`Claude marketplace ${MARKETPLACE} source is unknown or differs from requested source: ${source}`);
    }
    return true;
  }
  // Unparsed output that still names the marketplace may be an installed entry in a format we do not know:
  // «unreadable» is not «absent», so stop before `marketplace add` writes a duplicate.
  if (new RegExp(`(^|[^\\w@-])${MARKETPLACE}(?=$|[^\\w@-])`, 'm').test(text)) {
    throw new Error(`Claude marketplace list mentions ${MARKETPLACE} in an unrecognized format — refusing to add it again`);
  }
  return false;
}

function mcpConnected(text: string): boolean {
  // Claude prints one server per line; a listed but disconnected server is not verified.
  return text.split(/\r?\n/).some((line) =>
    /^\s*elanous:\s*(?:.*?\s[-–]\s)?(?:[✓✔]\s*)?connected\s*$/i.test(line));
}

function containsEntry(text: string, name: string, keys: string[]): boolean {
  const list = entries(text);
  if (list !== null) {
    return list.some((entry) => typeof entry === 'string' ? entry === name
      : entry !== null && typeof entry === 'object'
        && keys.some((key) => (entry as Record<string, unknown>)[key] === name));
  }
  // Match a whole identifier rather than accepting substrings like elanous-staging.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w@-])${escaped}(?=$|[^\\w@-])`, 'm').test(text);
}

/** Read-only discovery: only checks PATH and invokes Claude's list subcommands. */
export async function planClaudePluginSetup(
  options: { source?: string } = {},
  deps: ClaudePluginSetupDeps = {},
): Promise<ClaudePluginSetupPlan> {
  const source = options.source ?? DEFAULT_SOURCE;
  if (!source.trim()) throw new Error('Claude plugin marketplace source cannot be empty');
  const has = deps.has ?? hasBinary;
  const run = deps.run ?? runBinary;
  const [claudeCode, node, elanous] = await Promise.all([
    has('claude'), has('node'), has('elanous'),
  ]);
  let marketplaceInstalled = false;
  let pluginInstalled = false;
  if (claudeCode) {
    const marketplaces = await run('claude', ['plugin', 'marketplace', 'list']);
    if (marketplaces.exitCode !== 0) throw new Error('Could not list Claude Code plugin marketplaces');
    marketplaceInstalled = marketplacePresent(marketplaces.stdout, source);
    const plugins = await run('claude', ['plugin', 'list']);
    if (plugins.exitCode !== 0) throw new Error('Could not list Claude Code plugins');
    pluginInstalled = containsEntry(plugins.stdout, PLUGIN, ['id', 'name']);
  }
  return {
    source, claudeCode, node, elanous, marketplaceInstalled, pluginInstalled,
    steps: [
      { command: ['claude', 'plugin', 'marketplace', 'add', source], needed: !marketplaceInstalled },
      { command: ['claude', 'plugin', 'install', PLUGIN], needed: !pluginInstalled },
    ],
    ready: claudeCode && node && elanous && marketplaceInstalled && pluginInstalled,
  };
}

/** Apply only the missing steps, in dependency order, then independently verify current state. */
export async function applyClaudePluginSetup(
  plan: ClaudePluginSetupPlan,
  deps: ClaudePluginSetupDeps = {},
): Promise<ClaudePluginSetupResult> {
  const run = deps.run ?? runBinary;
  const executed: string[][] = [];
  // Refresh the plan: an earlier dry-run may have become stale.
  const current = await planClaudePluginSetup({ source: plan.source }, deps);
  if (!current.claudeCode) throw new Error('Claude Code is not installed; install `claude` first');
  if (!current.node || !current.elanous) throw new Error('Both `node` and `elanous` must be on PATH before installing the plugin');
  for (const step of current.steps) {
    if (!step.needed) continue;
    const [binary, ...args] = step.command;
    const result = await run(binary!, args);
    if (result.exitCode !== 0) throw new Error(`Claude plugin setup failed: ${step.command.join(' ')}`);
    executed.push(step.command);
  }
  const verification = await planClaudePluginSetup({ source: plan.source }, deps);
  const mcp = await run('claude', ['mcp', 'list']);
  const mcpVerified = mcp.exitCode === 0 && mcpConnected(mcp.stdout);
  return { verification, mcpVerified, executed, ok: verification.ready && mcpVerified };
}
