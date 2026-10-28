import { debug } from '../debug/log.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { discoverCapability, type CapabilityCandidate } from '../agent-mission/discover-capability.js';
import { ensureMarketIndex, type MarketIndex } from '../plugins/install/market-fetch.js';
import { installPlugin, type InstalledPlugin } from '../plugins/install/plugin-install.js';
import { getUserConfig } from '../user-config.js';

const MAX_CANDIDATES = 5;
const MAX_GAP_LENGTH = 240;
const DEFAULT_GITHUB_STARS = 1_000;

export type PluginDiscoverySource = 'signed-market' | 'official-external' | 'github' | 'other';
export interface PluginDiscoveryCandidate {
  name: string;
  url: string;
  source: PluginDiscoverySource;
  description: string;
  license?: string;
  permissions: string[];
  stars?: number;
  trusted: boolean;
  /** Only a verified signed-index entry is accepted by the built-in installer. */
  installSpec?: string;
}

export interface PluginDiscoveryResult {
  candidates: PluginDiscoveryCandidate[];
  installed?: { name: string; path: string; notice: string; undo: string };
  card: string;
  outcome: 'installed' | 'proposed' | 'create-suggestion' | 'invalid-gap';
}

export interface PluginDiscoveryDeps {
  signal?: AbortSignal;
  market?: () => Promise<MarketIndex>;
  search?: (gap: string, signal?: AbortSignal) => Promise<CapabilityCandidate[]>;
  githubPackage?: (url: string, signal?: AbortSignal) => Promise<{ stars: number; sha?: string; license?: string; permissions?: string[] } | undefined>;
  install?: (spec: string) => Promise<InstalledPlugin>;
  /** Config seam; an invalid value fails closed to the default threshold. */
  githubStarThreshold?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

function safeGap(text: string): string | null {
  const gap = text.normalize('NFKC').trim();
  if (!gap || gap.length > MAX_GAP_LENGTH || /(?:api[_-]?key|password|secret|token|authorization|bearer|sk-[\w-]+|gh[pousr]_[\w-]+)/i.test(gap)) return null;
  return gap.replace(/https?:\/\/\S+/g, '[url]');
}

function configuredStarThreshold(): number {
  const raw = getUserConfig().raw as Record<string, unknown>;
  const discovery = raw.pluginDiscovery;
  const value = discovery && typeof discovery === 'object' && !Array.isArray(discovery)
    ? (discovery as Record<string, unknown>).githubStarThreshold : undefined;
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : DEFAULT_GITHUB_STARS;
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter(word => !['missing', 'evidence', 'data', 'plugin', 'skill', 'tool', 'research', 'unavailable'].includes(word));
}

function relevance(gap: string, text: string): number {
  const terms = new Set(words(gap));
  if (terms.size === 0) return 0;
  const haystack = new Set(words(text));
  return [...terms].filter(term => haystack.has(term)).length / terms.size;
}

function officialExternal(url: URL): boolean {
  return url.hostname === 'docs.anthropic.com' || url.hostname === 'code.claude.com'
    || url.hostname === 'developers.openai.com' || url.hostname === 'openai.com'
    || url.hostname === 'docs.x.ai' || url.hostname === 'x.ai';
}

function githubRepo(url: URL): { owner: string; repo: string } | null {
  if (url.hostname !== 'github.com') return null;
  const [owner, repo, ...rest] = url.pathname.split('/').filter(Boolean);
  return owner && repo && rest.length === 0 && /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo)
    ? { owner, repo } : null;
}

async function defaultGithubPackage(raw: string, signal?: AbortSignal): Promise<{ stars: number; sha?: string; license?: string; permissions?: string[] } | undefined> {
  const repo = githubRepo(new URL(raw));
  if (!repo) return undefined;
  const api = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const options = {
    headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]),
  };
  const response = await fetch(api, options);
  if (!response.ok) return undefined;
  const body = await response.json() as { stargazers_count?: unknown; default_branch?: unknown; size?: unknown;
    archived?: unknown; license?: { spdx_id?: unknown } };
  if (!Number.isSafeInteger(body.stargazers_count)) return undefined;
  const metadata = { stars: body.stargazers_count as number,
    ...(typeof body.license?.spdx_id === 'string' ? { license: body.license.spdx_id } : {}) };
  if (body.archived === true || !Number.isSafeInteger(body.size) || (body.size as number) > 10_000
    || typeof body.default_branch !== 'string') return metadata;
  const commit = await fetch(`${api}/commits/${encodeURIComponent(body.default_branch)}`, options);
  if (!commit.ok) return metadata;
  const sha = (await commit.json() as { sha?: unknown }).sha;
  if (typeof sha !== 'string' || !/^[a-fA-F0-9]{40}$/.test(sha)) return metadata;
  const manifest = await fetch(`${api}/contents/plugin.json?ref=${sha}`, options);
  if (!manifest.ok) return metadata;
  const file = await manifest.json() as { type?: unknown; size?: unknown; content?: unknown; encoding?: unknown };
  if (file.type !== 'file' || file.encoding !== 'base64' || !Number.isSafeInteger(file.size)
    || (file.size as number) > 64_000 || typeof file.content !== 'string') return metadata;
  try {
    const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as { capabilities?: unknown };
    const permissions = Array.isArray(parsed.capabilities)
      ? parsed.capabilities.flatMap(value => value && typeof value === 'object'
        && typeof value.kind === 'string' ? [value.kind as string] : []) : [];
    return { ...metadata, sha, permissions };
  } catch { return metadata; }
}

function defaultInstall(spec: string): Promise<InstalledPlugin> {
  // The installer stages, verifies signature/hash and scans before moving into the plugin root.
  // Capabilities and credentials require a separate user decision; no blanket --yes.
  return installPlugin(spec, { consent: () => false, allowUnsigned: false });
}

function card(gap: string, candidates: readonly PluginDiscoveryCandidate[], installed?: PluginDiscoveryResult['installed']): string {
  const lines = [`Plugin discovery · ${gap}`];
  if (installed) lines.push(`Installed ${installed.name}. ${installed.notice} Undo: ${installed.undo}`);
  for (const candidate of candidates) {
    lines.push(`- ${candidate.name} · ${candidate.source} · ${candidate.trusted ? 'trusted source' : 'proposal only'} · ${candidate.url}`);
    lines.push(`  ${candidate.description || 'No description'} · license: ${candidate.license ?? 'unknown'} · permissions: ${candidate.permissions.join(', ') || 'none declared'}${candidate.stars === undefined ? '' : ` · stars: ${candidate.stars}`}`);
  }
  if (candidates.filter(candidate => candidate.trusted && candidate.installSpec).length > 1)
    lines.push('Several verified packages match. Choose one before installation.');
  if (!candidates.length) lines.push('No matching plugin found. Suggest creating a skill or plugin draft for approval.');
  return lines.join('\n');
}

/** One bounded, fail-soft discovery attempt for a research capability gap. */
export async function discoverResearchPlugin(gapText: string, deps: PluginDiscoveryDeps = {}): Promise<PluginDiscoveryResult> {
  const gap = safeGap(gapText);
  if (!gap) return { candidates: [], card: 'Plugin discovery skipped: unsafe or empty gap.', outcome: 'invalid-gap' };
  const aborted = (): PluginDiscoveryResult => ({ candidates: [], card: 'Plugin discovery skipped: time budget exhausted.', outcome: 'create-suggestion' });
  if (deps.signal?.aborted) return aborted();
  const log = deps.log ?? ((event: string, data: Record<string, unknown>) => debug.log('research.plugin-discovery', event, data));
  const threshold = Number.isSafeInteger(deps.githubStarThreshold) && (deps.githubStarThreshold as number) > 0
    ? deps.githubStarThreshold as number : configuredStarThreshold();
  const candidates: PluginDiscoveryCandidate[] = [];

  try {
    const market = await (deps.market ?? (() => ensureMarketIndex('elanous')))();
    // A signed index is the only built-in source with a verifiable install spec.
    if (market.signature === 'ok' && market.index.name === 'elanous') {
      for (const entry of market.index.plugins) {
        const labels = [entry.name, entry.description ?? '', ...entry['ai.elanous'].capabilities,
          ...(entry['ai.elanous'].vocab ?? [])].join(' ');
        if (relevance(gap, labels) < 0.5) continue;
        candidates.push({ name: entry.name, url: market.market.url, source: 'signed-market',
          description: (entry.description ?? '').slice(0, 180), license: undefined,
          permissions: [...entry['ai.elanous'].capabilities], trusted: true,
          installSpec: `${entry.name}@elanous` });
      }
    }
  } catch { log('market-unavailable', { gap: gap.slice(0, 80) }); }
  if (deps.signal?.aborted) return aborted();

  try {
    const found = await (deps.search ?? ((query: string, signal?: AbortSignal) => discoverCapability(query,
      { layer: 'skill', limit: MAX_CANDIDATES, community: false, signal })))(gap, deps.signal);
    if (deps.signal?.aborted) return aborted();
    for (const hit of found.slice(0, MAX_CANDIDATES)) {
      if (deps.signal?.aborted) return aborted();
      let url: URL;
      try { url = new URL(hit.url); } catch { continue; }
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      const repo = githubRepo(url);
      const source: PluginDiscoverySource = repo ? 'github' : officialExternal(url) ? 'official-external' : 'other';
      let github: Awaited<ReturnType<NonNullable<PluginDiscoveryDeps['githubPackage']>>>;
      if (repo) {
        try { github = await (deps.githubPackage ?? defaultGithubPackage)(url.href, deps.signal); } catch { /* metadata unavailable */ }
      }
      if (relevance(gap, `${hit.title} ${hit.snippet}`) === 0) continue;
      candidates.push({ name: hit.title.slice(0, 100), url: url.href, source,
        description: hit.snippet.slice(0, 180), permissions: github?.permissions ?? [],
        stars: github?.stars, license: github?.license,
        trusted: source === 'official-external' || (source === 'github' && github !== undefined && github.stars >= threshold),
        ...(source === 'github' && github?.sha && github.stars >= threshold
          ? { installSpec: `https://github.com/${repo!.owner}/${repo!.repo}.git#${github.sha}` } : {}),
      });
    }
  } catch { log('search-unavailable', { gap: gap.slice(0, 80) }); }
  if (deps.signal?.aborted) return aborted();

  const deduped = candidates.filter((item, index) => candidates.findIndex(other => other.url === item.url && other.name === item.name) === index)
    .slice(0, MAX_CANDIDATES);
  const installable = deduped.filter(item => item.trusted && item.installSpec);
  let installed: PluginDiscoveryResult['installed'];
  // Ambiguous matches require a choice. Search-result URLs and stars alone never become install specs.
  if (installable.length === 1) {
    const candidate = installable[0]!;
    try {
      if (deps.signal?.aborted) return aborted();
      const item = await (deps.install ?? defaultInstall)(candidate.installSpec!);
      const undo = `eln plugin remove ${item.name}`;
      installed = { name: item.name, path: item.path,
        notice: `Reason: missing research capability ${gap}; source: ${candidate.source}; permissions: ${candidate.permissions.join(', ') || 'none declared'}.`, undo };
      log('installed', { name: item.name, source: candidate.source, undo });
    } catch (error) {
      log('install-refused', { name: candidate.name, reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown' });
    }
  }
  const outcome: PluginDiscoveryResult['outcome'] = installed ? 'installed' : deduped.length ? 'proposed' : 'create-suggestion';
  const result = { candidates: deduped, installed, card: card(gap, deduped, installed), outcome };
  log(outcome, { gap: gap.slice(0, 80), count: deduped.length, installed: installed?.name });
  return result;
}

/** Re-query through exactly one installed, declared read-only skill with no local-file or shell tools. */
export async function rerunInstalledPluginResearch(
  gap: string, installation: NonNullable<PluginDiscoveryResult['installed']>, signal: AbortSignal,
): Promise<{ ok: boolean; output: string; error?: string }> {
  if (!safeGap(gap) || signal.aborted) return { ok: false, output: '', error: 'unsafe gap or expired budget' };
  const root = join(installation.path, 'skills');
  let names: string[];
  try { names = readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name); }
  catch { return { ok: false, output: '', error: 'installed package has no skill directory' }; }
  const { parseSkillMd, executeSkill } = await import('../skills/runner.js');
  const safe = names.flatMap(name => {
    const manifest = parseSkillMd(name, root);
    return manifest?.sideEffects === 'none' ? [manifest] : [];
  });
  if (safe.length !== 1) return { ok: false, output: '', error: 'installed package has no unique declared read-only skill' };
  const manifest = safe[0]!;
  try {
    const run = await executeSkill({ ...manifest,
      allowedTools: ['WebSearch', 'WebFetch'],
      deniedTools: [...new Set([...(manifest.deniedTools ?? []), 'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit'])],
    }, gap, () => {}, { signal });
    const output = run.finalResponse.trim();
    return { ok: output.length > 0, output, ...(output ? {} : { error: 'installed skill returned no research output' }) };
  } catch (error) {
    return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) };
  }
}
