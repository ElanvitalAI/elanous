import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { DecisionLedger, type DecisionLedgerOptions } from '../../decisions/decision-ledger.js';
import { invokeResearch } from '../../research-bridge/invoke.js';
import { installPlugin, type InstallOptions, type InstalledPlugin } from './plugin-install.js';
import { syncInstalledPluginNodes, type InstalledPluginNodeSyncResult } from '../../graph-kinds/installed-plugin-nodes.js';

export type PluginAgent = 'claude' | 'codex';

/** Package paths come from a host's installed-package inventory, never from search output. */
export interface GroundablePlugin {
  id: string;
  agent: PluginAgent;
  name: string;
  marketplace: string;
  source: string;
  packagePath: string;
  capabilities: string[];
  argNodePaths: string[];
}

export interface GroundedMatch {
  candidateId: string;
  rationale: string;
  sources: string[];
}

export interface PluginGroundingJourneyDeps {
  stateDir?: string;
  ledger?: DecisionLedger;
  ledgerOptions?: DecisionLedgerOptions;
  research?: (query: string) => Promise<{ ok: boolean; output: string; error?: string }>;
  install?: (candidate: GroundablePlugin, options: InstallOptions) => Promise<InstalledPlugin>;
  syncNodes?: (root: string) => InstalledPluginNodeSyncResult;
  consent?: InstallOptions['consent'];
  now?: () => Date;
}

export type PreparePluginGroundingResult =
  | { status: 'already-covered'; missing: [] }
  | { status: 'no-candidates'; missing: string[]; reason: string }
  | { status: 'no-grounded-candidate'; missing: string[]; reason: string }
  | { status: 'approval-required'; missing: string[]; decisionId: string; candidateIds: string[]; sources: string[] };

export type CompletePluginGroundingResult =
  | { status: 'pending'; decisionId: string }
  | { status: 'cancelled'; decisionId: string }
  | { status: 'installed'; decisionId: string; plugin: InstalledPlugin; graph: InstalledPluginNodeSyncResult };

interface PersistedPlan {
  version: 1;
  decisionId: string;
  capability: string;
  candidates: GroundablePlugin[];
  optionToCandidate: Record<string, string>;
  sources: string[];
  packageFingerprints: Record<string, string>;
}

function planPath(stateDir: string, decisionId: string): string {
  if (!/^D-\d{8}-\d{2,}$/.test(decisionId)) throw new Error('invalid plugin grounding decision id');
  return join(stateDir, 'plugins', 'grounding-plans', `${decisionId}.json`);
}

export function missingPluginCapabilities(required: readonly string[], available: readonly string[]): string[] {
  const have = new Set(available.map(value => value.trim()).filter(Boolean));
  return [...new Set(required.map(value => value.trim()).filter(Boolean))].filter(value => !have.has(value));
}

/** Parse the strict JSON contract requested from omni-crawl. Search text cannot provide or alter package paths. */
export function parseGroundedPluginMatches(output: string, inventory: readonly GroundablePlugin[]): GroundedMatch[] {
  const trimmed = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { return []; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const rows = (value as { matches?: unknown }).matches;
  if (!Array.isArray(rows)) return [];
  const known = new Set(inventory.map(candidate => candidate.id));
  const seen = new Set<string>();
  const matches: GroundedMatch[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.candidateId !== 'string' || !known.has(row.candidateId) || seen.has(row.candidateId)
      || typeof row.rationale !== 'string' || !row.rationale.trim() || !Array.isArray(row.sources)) continue;
    const sources = row.sources.filter((source): source is string => {
      if (typeof source !== 'string') return false;
      try { const url = new URL(source); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
    }).slice(0, 3);
    if (!sources.length) continue;
    seen.add(row.candidateId);
    matches.push({ candidateId: row.candidateId, rationale: row.rationale.trim().slice(0, 500), sources });
  }
  return matches.slice(0, 3);
}

async function fingerprintPackage(packagePath: string): Promise<string> {
  const root = resolve(packagePath);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('host plugin package path is not a regular directory');
  const canonicalRoot = realpathSync(root);
  const hash = createHash('sha256');
  const visit = async (directory: string): Promise<void> => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      const rel = relative(canonicalRoot, path).split(sep).join('/');
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('host plugin package contains an unsafe entry');
      hash.update(JSON.stringify({ path: rel, type: stat.isDirectory() ? 'directory' : 'file', mode: stat.mode & 0o777, size: stat.isFile() ? stat.size : null })).update('\n');
      if (stat.isDirectory()) await visit(path);
      else for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    }
  };
  await visit(canonicalRoot);
  return hash.digest('hex');
}

function validCandidate(candidate: GroundablePlugin): boolean {
  return /^[a-z0-9][a-z0-9-]{1,39}$/.test(candidate.id)
    && /^[a-z0-9][a-z0-9-]{1,39}$/.test(candidate.name)
    && /^[a-z0-9][a-z0-9-]{1,39}$/.test(candidate.marketplace)
    && (candidate.agent === 'claude' || candidate.agent === 'codex')
    && typeof candidate.packagePath === 'string' && candidate.packagePath.length > 0
    && existsSync(candidate.packagePath) && candidate.argNodePaths.length > 0;
}

/** Capability gap → omni-crawl grounding → durable decision card. This stage never installs. */
export async function preparePluginGroundingInstall(
  input: { requiredCapabilities: readonly string[]; availableCapabilities: readonly string[]; inventory: readonly GroundablePlugin[] },
  deps: PluginGroundingJourneyDeps = {},
): Promise<PreparePluginGroundingResult> {
  const missing = missingPluginCapabilities(input.requiredCapabilities, input.availableCapabilities);
  if (!missing.length) return { status: 'already-covered', missing: [] };
  const capability = missing[0]!;
  const inventory = input.inventory.filter(validCandidate);
  if (!inventory.length) return { status: 'no-candidates', missing, reason: 'no installed Claude/Codex package with an ARG node declares this capability' };
  const query = [
    `Use omni-crawl to find which installed Claude/Codex marketplace plugin best supplies this missing capability: ${capability}.`,
    'Return only JSON: {"matches":[{"candidateId":"<exact id below>","rationale":"one sentence","sources":["https://..."]}]}.',
    'Only use these installed candidate IDs; do not invent packages or installation paths:',
    ...inventory.map(candidate => `candidateId=${candidate.id} | plugin=${candidate.name} | agent=${candidate.agent} | marketplace=${candidate.marketplace} | capabilities=${candidate.capabilities.join(', ')} | source=${candidate.source}`),
  ].join('\n');
  const research = deps.research ?? (async topic => {
    const result = await invokeResearch(topic, { skill: 'omni-crawl' });
    return { ok: result.ok, output: result.output, ...(result.error ? { error: result.error } : {}) };
  });
  const grounded = await research(query);
  if (!grounded.ok) return { status: 'no-grounded-candidate', missing, reason: grounded.error ?? 'omni-crawl returned no evidence' };
  const matches = parseGroundedPluginMatches(grounded.output, inventory);
  if (!matches.length) return { status: 'no-grounded-candidate', missing, reason: 'omni-crawl did not return a cited match from the installed-package inventory' };
  const ledger = deps.ledger ?? new DecisionLedger(deps.ledgerOptions ?? (deps.stateDir ? { stateDir: deps.stateDir } : {}));
  const candidates = matches.map(match => inventory.find(candidate => candidate.id === match.candidateId)!);
  const matchById = new Map(matches.map(match => [match.candidateId, match]));
  const optionToCandidate = Object.fromEntries(candidates.map((candidate, index) => [String.fromCharCode(97 + index), candidate.id]));
  const options = candidates.map((candidate, index) => ({
    key: String.fromCharCode(97 + index),
    label: `${candidate.agent} · ${candidate.name}@${candidate.marketplace}`,
    consequence: `${matchById.get(candidate.id)!.rationale} · 근거 ${matchById.get(candidate.id)!.sources.join(', ')} · 설치 후 ARG node 정의 ${candidate.argNodePaths.join(', ')}`,
  }));
  options.push({ key: 'd', label: '취소', consequence: '설치하지 않음' });
  optionToCandidate.d = '';
  const sources = [...new Set(matches.flatMap(match => match.sources))];
  const packageFingerprints = Object.fromEntries(await Promise.all(candidates.map(async candidate => [candidate.id, await fingerprintPackage(candidate.packagePath)] as const)));
  const entry = ledger.raise({
    title: `ARG capability 플러그인 설치 승인: ${capability}`,
    category: 'security',
    scqa: {
      s: `ARG에 필요한 ${capability} 능력이 아직 없습니다.`,
      c: 'omni-crawl이 설치된 Claude/Codex 마켓 패키지 중 근거가 있는 후보를 찾았습니다.',
      q: '후보 하나를 Elanous에 설치하고 ARG 노드를 등록할까요?',
      a: '승인 뒤 기존 플러그인 보안 검사와 capability 동의를 거쳐 한 패키지만 설치합니다.',
    },
    pendingQuestion: `근거: ${sources.join(' · ')} · 무엇이 바뀌나: ${capability} 후보 하나가 설치되고 ARG 노드가 등록됩니다 · 기본값: 취소하면 아무것도 설치하지 않습니다.`,
    options,
    recommendation: { option: 'a', why: matches[0]!.rationale.slice(0, 120) },
    raisedBy: { agent: 'harness' },
    refs: sources,
  });
  const stateDir = resolve(deps.stateDir ?? ledger.path.replace(/\/decisions\/decisions\.jsonl$/, ''));
  const path = planPath(stateDir, entry.id);
  mkdirSync(join(stateDir, 'plugins', 'grounding-plans'), { recursive: true, mode: 0o700 });
  const plan: PersistedPlan = { version: 1, decisionId: entry.id, capability, candidates, optionToCandidate, sources, packageFingerprints };
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  return { status: 'approval-required', missing, decisionId: entry.id, candidateIds: candidates.map(candidate => candidate.id), sources };
}

/** Install only a candidate selected on the decision card; package paths remain those from host inventory. */
export async function completePluginGroundingInstall(
  decisionId: string,
  opts: InstallOptions & { stateDir: string; inventory: readonly GroundablePlugin[]; ledger?: DecisionLedger; ledgerOptions?: DecisionLedgerOptions; syncNodes?: PluginGroundingJourneyDeps['syncNodes']; install?: PluginGroundingJourneyDeps['install'] },
): Promise<CompletePluginGroundingResult> {
  const stateDir = resolve(opts.stateDir);
  const ledger = opts.ledger ?? new DecisionLedger(opts.ledgerOptions ?? { stateDir });
  const entry = ledger.show(decisionId);
  const path = planPath(stateDir, decisionId);
  if (!existsSync(path)) throw new Error(`plugin grounding plan not found: ${decisionId}`);
  const plan = JSON.parse(readFileSync(path, 'utf8')) as PersistedPlan;
  if (plan.version !== 1 || plan.decisionId !== decisionId || !Array.isArray(plan.candidates) || !plan.optionToCandidate) {
    throw new Error(`invalid plugin grounding plan: ${decisionId}`);
  }
  if (entry.status === 'open') return { status: 'pending', decisionId };
  const candidateId = entry.choice ? plan.optionToCandidate[entry.choice] : undefined;
  if (!candidateId) return { status: 'cancelled', decisionId };
  const planned = plan.candidates.find(item => item.id === candidateId);
  const candidate = opts.inventory.find(item => item.id === candidateId);
  if (!planned || !candidate || !validCandidate(candidate)
    || candidate.agent !== planned.agent || candidate.name !== planned.name || candidate.marketplace !== planned.marketplace
    || resolve(candidate.packagePath) !== resolve(planned.packagePath)) {
    throw new Error('approved candidate is no longer present at the same host-inventory package path');
  }
  const expectedFingerprint = plan.packageFingerprints?.[candidateId];
  if (!expectedFingerprint || await fingerprintPackage(candidate.packagePath) !== expectedFingerprint) {
    throw new Error('approved host plugin package changed after the decision card was raised');
  }
  const root = resolve(opts.root ?? stateDir);
  const stageRoot = join(stateDir, 'plugins');
  mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(stageRoot, '.grounding-'));
  const snapshot = join(stage, 'package');
  try {
    cpSync(candidate.packagePath, snapshot, { recursive: true, dereference: false, errorOnExist: true, force: false });
    if (await fingerprintPackage(snapshot) !== expectedFingerprint) throw new Error('approved host plugin changed while creating the install snapshot');
    const installOptions: InstallOptions = { ...opts, root, consent: opts.consent };
    const installed = opts.install
      ? await opts.install(candidate, installOptions)
      : await installPlugin(snapshot, installOptions);
    const graph = (opts.syncNodes ?? syncInstalledPluginNodes)(root);
    return { status: 'installed', decisionId, plugin: installed, graph };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
