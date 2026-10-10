import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { buildCapabilityMatrix } from '../agent-mission/capability-matrix.js';
import { createCapabilityReaders } from '../agent-mission/capability-readers.js';
import type { CapabilityEntry } from '../agent-mission/capability-types.js';
import { readCodexPluginsFromAppServer, type CodexPluginObservation } from '../acp/codex-plugins.js';
import { kgsDefaultDbPath } from '../knowledge/kgs/sqlite-store.js';
import { OFFICIAL_INDEX_KEYS } from '../market/official-keys.js';
import { verifyIndex, type MarketplaceIndex } from '../market/signed-index.js';
import { readClaudePackageLedger, type ClaudePackageLedger } from '../plugins/adapters/claude-package.js';
import { ELANOUS_MARKET_URL } from '../plugins/install/market-fetch.js';
import { buildSkillIndex, skillIndexProblems, type SkillIndexEntry } from '../skills/index.js';
import { defaultSkillDirs } from '../user-config.js';

export type CapabilitySource = 'skills' | 'plugins' | 'knowledge' | 'codex' | 'claude' | 'market';
export type CapabilityAuth = 'subscription' | 'free' | 'api-key' | 'paid' | 'unknown';
export interface IndexedCapability {
  readonly id: string;
  readonly kind: 'skill' | 'plugin' | 'knowledge' | 'connector';
  readonly source: CapabilitySource;
  readonly provenance: string;
  readonly auth: CapabilityAuth;
  readonly state: 'installed' | 'candidate' | 'ready' | 'unavailable' | 'unknown';
  readonly capabilities: readonly string[];
}
export interface CapabilityIndex {
  readonly sources: Record<CapabilitySource, 'ok' | 'unknown'>;
  readonly entries: readonly IndexedCapability[];
}

export interface CapabilityIndexReaders {
  skills?: () => readonly SkillIndexEntry[];
  skillProblems?: () => readonly { name: string; dir: string }[];
  plugins?: () => readonly { name: string; market: string }[];
  knowledge?: () => readonly { name: string; provenance: string }[];
  codex?: () => Promise<CodexPluginObservation>;
  claude?: () => ClaudePackageLedger;
  /** Production verifies fetched bytes; tests may inject a checked fixture. */
  market?: () => Promise<MarketplaceIndex>;
  matrix?: () => readonly CapabilityEntry[];
  /** Default-path observations (used only when `skills` / `plugins` are not injected). */
  localSkills?: () => LocalSkillsObservation;
  localPlugins?: () => LocalPluginsObservation;
  /** Already verified by the caller (never accepts unverified JSON). */
  verifiedMarket?: MarketplaceIndex;
}

export interface LocalSkillsObservation {
  readonly entries: readonly SkillIndexEntry[];
  /** Roots that exist (or could not be proven absent) but could not be read. */
  readonly unreadableRoots: readonly string[];
}

/** Per-root read: an unreadable root is reported, readable roots keep their candidates. */
export function readLocalSkills(dirs: readonly string[] = defaultSkillDirs()): LocalSkillsObservation {
  // A missing root is optional; any other stat/read failure must remain unknown.
  const readable: string[] = [];
  const unreadableRoots: string[] = [];
  for (const dir of dirs) {
    try {
      if (!statSync(dir).isDirectory()) throw new Error('skill root is not a directory');
      readdirSync(dir);
      readable.push(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      unreadableRoots.push(dir);
    }
  }
  return { entries: readable.length ? buildSkillIndex(readable) : [], unreadableRoots };
}

/** Strict form: throws when any root is unreadable. */
export function listLocalSkills(dirs: readonly string[] = defaultSkillDirs()): readonly SkillIndexEntry[] {
  const observed = readLocalSkills(dirs);
  if (observed.unreadableRoots.length) throw new Error(`unreadable skill roots: ${observed.unreadableRoots.join(', ')}`);
  return observed.entries;
}

export interface LocalPluginsObservation {
  readonly plugins: readonly { name: string; market: string }[];
  /** `absent` = ENOENT (no installs recorded); `unreadable` = exists but stat/read/parse failed. */
  readonly ledger: 'ok' | 'absent' | 'unreadable';
  /** Plugin directories that exist (or could not be proven absent) but could not be listed. */
  readonly unreadableDirs: readonly string[];
}

/** ENOENT → absent; every other failure is a read failure, never "no candidates". */
function statKind(path: string, want: 'any' | 'file' = 'any'): 'present' | 'absent' | 'unreadable' {
  try { const stat = statSync(path); return want === 'file' && !stat.isFile() ? 'absent' : 'present'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'; }
}

export function readLocalPlugins(
  ledgerPath: string = join(elanousStateRoot(), 'plugins', 'installed.json'),
  localDirs: readonly string[] = [resolve(import.meta.dir, '../../plugins')],
): LocalPluginsObservation {
  const plugins: { name: string; market: string }[] = [];
  let ledger: LocalPluginsObservation['ledger'] = 'absent';
  const ledgerKind = statKind(ledgerPath);
  if (ledgerKind === 'unreadable') ledger = 'unreadable';
  else if (ledgerKind === 'present') {
    try {
      const rows: unknown = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      if (!Array.isArray(rows) || !rows.every(row => row && typeof row.name === 'string' && typeof row.market === 'string')) throw new Error('invalid installed plugin ledger');
      plugins.push(...rows.map(row => ({ name: row.name as string, market: row.market as string })));
      ledger = 'ok';
    } catch { ledger = 'unreadable'; }
  }
  const unreadableDirs: string[] = [];
  for (const dir of localDirs) {
    const kind = statKind(dir);
    if (kind === 'absent') continue;
    const found: { name: string; market: string }[] = [];
    try {
      if (kind === 'unreadable') throw new Error('plugin directory unreadable');
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        const path = join(dir, item.name);
        const manifests = [statKind(join(path, 'plugin.ts'), 'file'), statKind(join(path, 'plugin.json'), 'file')];
        if (manifests.includes('present')) found.push({ name: item.name, market: dir });
        else if (manifests.includes('unreadable')) unreadableDirs.push(path);
      }
      plugins.push(...found);
    } catch { unreadableDirs.push(dir); }
  }
  return { plugins, ledger, unreadableDirs };
}

function listLocalKnowledge(): readonly { name: string; provenance: string }[] {
  const path = kgsDefaultDbPath();
  if (!existsSync(path)) throw new Error('knowledge store unavailable');
  const db = new Database(path, { readonly: true, create: false });
  try {
    return (db.query('SELECT slug, version FROM kgs_pack ORDER BY slug, version').all() as Array<{ slug: string; version: string }>)
      .map(row => ({ name: `${row.slug}@${row.version}`, provenance: path }));
  } finally { db.close(); }
}

async function readOfficialMarket(): Promise<MarketplaceIndex> {
  const url = new URL('marketplace.json', ELANOUS_MARKET_URL);
  const [raw, sig] = await Promise.all([fetch(url), fetch(new URL('index.sig', url))]);
  if (!raw.ok || !sig.ok) throw new Error('official index unavailable');
  const checked = verifyIndex({ marketplaceBytes: new Uint8Array(await raw.arrayBuffer()), signatureText: await sig.text(), trustedKeys: OFFICIAL_INDEX_KEYS });
  if (!checked.ok || checked.index.name !== 'elanous') throw new Error('official index unverified');
  return checked.index;
}

function marketAuth(entry: MarketplaceIndex['plugins'][number]): CapabilityAuth {
  const policy = entry.policy?.authentication?.toLowerCase();
  if (policy === 'api-key' || policy === 'api_key') return 'api-key';
  if (policy === 'subscription') return 'subscription';
  if (policy === 'paid') return 'paid';
  if (policy === 'none' || policy === 'free') return 'free';
  return 'unknown';
}

/** Read-only, per-source index. No source failure is interpreted as an empty inventory. */
export async function buildCapabilityIndex(readers: CapabilityIndexReaders = {}): Promise<CapabilityIndex> {
  const sources: CapabilityIndex['sources'] = { skills: 'ok', plugins: 'ok', knowledge: 'ok', codex: 'ok', claude: 'ok', market: 'ok' };
  const entries: IndexedCapability[] = [];
  const attempt = async (source: CapabilitySource, read: () => Promise<void> | void): Promise<void> => {
    const start = entries.length;
    try { await read(); } catch { sources[source] = 'unknown'; entries.splice(start); }
  };
  await attempt('skills', () => {
    const observed: LocalSkillsObservation = readers.skills
      ? { entries: readers.skills(), unreadableRoots: [] }
      : (readers.localSkills ?? readLocalSkills)();
    for (const skill of observed.entries) entries.push({ id: skill.name, kind: 'skill', source: 'skills', provenance: skill.rootDir, auth: 'unknown', state: 'installed', capabilities: [skill.name] });
    if (observed.unreadableRoots.length) {
      sources.skills = 'unknown';
      for (const dir of observed.unreadableRoots) entries.push({ id: dir, kind: 'skill', source: 'skills', provenance: dir, auth: 'unknown', state: 'unknown', capabilities: [] });
    }
    const problems = (readers.skillProblems ?? skillIndexProblems)();
    if (problems.length) {
      sources.skills = 'unknown';
      for (const problem of problems) entries.push({ id: problem.name, kind: 'skill', source: 'skills', provenance: problem.dir, auth: 'unknown', state: 'unknown', capabilities: [problem.name] });
    }
  });
  let installed: readonly { name: string; market: string }[] | undefined;
  await attempt('plugins', () => {
    if (readers.plugins) installed = readers.plugins();
    else {
      const observed = (readers.localPlugins ?? readLocalPlugins)();
      installed = observed.plugins;
      // Absent ledger keeps the earlier contract (unknown); unreadable ledger/dirs never read as "no installs".
      if (observed.ledger !== 'ok' || observed.unreadableDirs.length) sources.plugins = 'unknown';
      for (const dir of observed.unreadableDirs) entries.push({ id: dir, kind: 'plugin', source: 'plugins', provenance: dir, auth: 'unknown', state: 'unknown', capabilities: [] });
    }
    for (const plugin of installed) entries.push({ id: plugin.name, kind: 'plugin', source: 'plugins', provenance: plugin.market, auth: 'unknown', state: 'installed', capabilities: [plugin.name] });
  });
  await attempt('knowledge', () => {
    for (const pack of (readers.knowledge ?? listLocalKnowledge)()) entries.push({ id: pack.name, kind: 'knowledge', source: 'knowledge', provenance: pack.provenance, auth: 'unknown', state: 'installed', capabilities: [pack.name] });
  });
  await attempt('codex', async () => {
    const observation = await (readers.codex ?? readCodexPluginsFromAppServer)();
    if (observation.status === 'unknown') { sources.codex = 'unknown'; return; }
    for (const plugin of observation.plugins) entries.push({ id: plugin.name, kind: 'plugin', source: 'codex', provenance: plugin.marketplace, auth: 'unknown', state: plugin.enabled ? 'installed' : 'unavailable', capabilities: [plugin.name] });
  });
  await attempt('claude', () => {
    const ledger = (readers.claude ?? readClaudePackageLedger)();
    if (ledger.status !== 'ok') sources.claude = 'unknown';
    for (const pkg of ledger.packages) entries.push({ id: pkg.plugin, kind: 'plugin', source: 'claude', provenance: `${pkg.marketplace}:${pkg.source}`, auth: 'unknown', state: 'installed', capabilities: [pkg.plugin] });
  });
  await attempt('market', async () => {
    const index = readers.verifiedMarket ?? await (readers.market ?? readOfficialMarket)();
    if (index.name !== 'elanous') throw new Error('not official market');
    for (const plugin of index.plugins) {
      entries.push({ id: plugin.name, kind: 'plugin', source: 'market', provenance: `${index.name}:${plugin.source.source}`, auth: marketAuth(plugin),
        state: sources.plugins === 'unknown' ? 'unknown' : installed?.some(row => row.name === plugin.name && row.market === index.name) ? 'installed' : 'candidate',
        capabilities: [plugin.name, ...plugin['ai.elanous'].capabilities, ...(plugin['ai.elanous'].vocab ?? [])] });
      for (const connector of plugin['ai.elanous'].connectors) entries.push({ id: connector.id, kind: 'connector', source: 'market', provenance: `${index.name}:${plugin.name}`, auth: marketAuth(plugin), state: sources.plugins === 'unknown' ? 'unknown' : 'candidate', capabilities: [connector.id] });
    }
    for (const pack of index.knowledgePacks ?? []) {
      if (pack.visibility !== 'public') continue;
      entries.push({ id: pack.name, kind: 'knowledge', source: 'market', provenance: index.name, auth: 'unknown', state: 'candidate', capabilities: [pack.name] });
    }
  });
  // Matrix is an additional service observation, not proof of plugin installation.
  let matrix: readonly CapabilityEntry[] = [];
  try { matrix = (readers.matrix ?? (() => buildCapabilityMatrix(createCapabilityReaders())))(); }
  catch { /* Matrix is supplementary; plugin inventories keep their own observation status. */ }
  for (const service of matrix) {
    // Only backends that are index sources are attributed; grok has no source row here, so it is not relabelled.
    if (!service.service || service.service === '*' || (service.backend !== 'codex' && service.backend !== 'claude')) continue;
    entries.push({ id: service.service, kind: 'connector', source: service.backend, provenance: `${service.backend}:mcp`, auth: 'unknown', state: service.state, capabilities: [service.service] });
  }
  return { sources, entries };
}
