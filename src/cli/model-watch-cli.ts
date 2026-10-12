import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { applyApprovedCandidates, mergeCandidates, type ApplyResult } from '../intelligence-map/catalog-merge.js';
import { loadCatalog, type CatalogIoOpts } from '../intelligence-map/model-catalog.js';
import { getModelWatchProposalPath, runModelIntelligenceWatch, type ModelWatchDeps } from '../intelligence-map/model-watch-mission.js';
import { fetchProviderModelPages, type ModelWatchFetchResult } from '../intelligence-map/model-watch-fetch.js';
import type { ModelCandidate } from '../intelligence-map/model-classifier.js';
import { detectPriceChanges, formatPriceChange, type PriceChange, type WatchIntakeResult } from '../intelligence-map/model-watch-intake.js';
import type { LlmRunner } from '../model-tier/preset-suggest-llm.js';

export interface ModelWatchCliResult {
  status: 'ok' | 'partial-failure' | 'no-pages';
  fetched: number;
  failures: ModelWatchFetchResult['failures'];
  proposal: Pick<WatchIntakeResult['proposal'], 'added' | 'updated'>;
  candidates: WatchIntakeResult['candidates'];
  priceChanges: PriceChange[];
  perSource: WatchIntakeResult['perSource'];
}

export interface ModelWatchCliDeps {
  fetchPages?: () => Promise<ModelWatchFetchResult>;
  runWatch?: (deps: ModelWatchDeps) => Promise<WatchIntakeResult>;
  runLlm?: LlmRunner;
  readProposalLedger?: () => string;
  applyApprovedCandidates?: (candidates: readonly ModelCandidate[]) => Promise<ApplyResult>;
  loadCatalog?: () => ReturnType<typeof loadCatalog>;
  mergeCandidates?: typeof mergeCandidates;
  catalogIo?: CatalogIoOpts;
  out?: { log: (value: string) => void };
  err?: { error: (value: string) => void };
  setExitCode?: (code: number) => void;
}

interface ModelWatchProposalRecord {
  candidates: ModelCandidate[];
}

function readLastProposal(deps: ModelWatchCliDeps): ModelWatchProposalRecord | undefined {
  const text = (deps.readProposalLedger ?? (() => readFileSync(getModelWatchProposalPath(), 'utf8')))();
  const line = text.trim().split('\n').at(-1);
  return line ? JSON.parse(line) as ModelWatchProposalRecord : undefined;
}

export async function applyModelWatchCandidates(
  ids: readonly string[],
  opts: { dryRun?: boolean } = {},
  deps: ModelWatchCliDeps = {},
): Promise<void> {
  const out = deps.out ?? { log: (value: string) => console.log(value) };
  const err = deps.err ?? { error: (value: string) => console.error(value) };
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  if (ids.length === 0) {
    out.log('Usage: model-watch apply [--dry-run] <candidate-id...>');
    return;
  }

  let proposal: ModelWatchProposalRecord | undefined;
  try { proposal = readLastProposal(deps); } catch (cause) {
    err.error(`Could not read model-watch proposal ledger: ${cause instanceof Error ? cause.message : String(cause)}`);
    setExitCode(1);
    return;
  }
  const candidates = proposal?.candidates ?? [];
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    err.error(`Candidate(s) not found in the latest proposal: ${missing.join(', ')}`);
    setExitCode(1);
    return;
  }
  const selected = ids.map((id) => byId.get(id)!);
  if (opts.dryRun) {
    const catalog = (deps.loadCatalog ?? (() => loadCatalog(deps.catalogIo)))().catalog;
    const result = (deps.mergeCandidates ?? mergeCandidates)(catalog, selected);
    out.log(`Dry run: would add ${result.added.join(', ') || 'none'}; would update ${result.updated.join(', ') || 'none'}; no file written.`);
    return;
  }
  const result = await (deps.applyApprovedCandidates ?? ((approved) => applyApprovedCandidates(approved, deps.catalogIo)))(selected);
  out.log(`Applied: added ${result.added.join(', ') || 'none'}; updated ${result.updated.join(', ') || 'none'}; saved ${result.path}`);
  setExitCode(0);
}

export async function runModelWatchCli(deps: ModelWatchCliDeps = {}): Promise<ModelWatchCliResult> {
  const fetched = await (deps.fetchPages ?? fetchProviderModelPages)();
  const watch = deps.runWatch ?? runModelIntelligenceWatch;
  const intake = await watch({
    fetchPages: async () => fetched.pages,
    ...(deps.runLlm ? { runLlm: deps.runLlm } : {}),
  });
  return {
    status: fetched.pages.length === 0 ? 'no-pages' : fetched.failures.length > 0 ? 'partial-failure' : 'ok',
    fetched: fetched.pages.length,
    failures: fetched.failures,
    proposal: { added: intake.proposal.added, updated: intake.proposal.updated },
    candidates: intake.candidates,
    priceChanges: detectPriceChanges(intake),
    perSource: intake.perSource,
  };
}

export function formatModelWatchResult(result: ModelWatchCliResult): string {
  const lines = [
    `Model watch: ${result.status}; fetched ${result.fetched}, failed ${result.failures.length}.`,
    `Proposal: ${result.proposal.added.length} added, ${result.proposal.updated.length} updated (not applied).`,
  ];
  if (result.candidates.length > 0) lines.push(`Candidates: ${result.candidates.map((candidate) => candidate.id).join(', ')}`);
  if (result.priceChanges.length > 0) lines.push(`Price changes: ${result.priceChanges.map(formatPriceChange).join('; ')}`);
  const abnormalEmptySources = Object.entries(result.perSource)
    .filter(([, source]) => source.candidateCount === 0 && source.status !== 'completed')
    .map(([source]) => source);
  if (abnormalEmptySources.length > 0) {
    lines.push(`Classification incomplete for zero-candidate sources: ${abnormalEmptySources.join(', ')}`);
  }
  return lines.join('\n');
}

export function registerModelWatchCommand(program: Command, deps: ModelWatchCliDeps = {}): void {
  const out = deps.out ?? { log: (value: string) => console.log(value) };
  const err = deps.err ?? { error: (value: string) => console.error(value) };
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const command = program
    .command('model-watch')
    .description('제공자 문서에서 카탈로그 변경 제안을 만든다; 자동 적용하지 않는다')
    .option('--json', '구조화된 제안과 출처별 수집 결과를 출력한다')
    .action(async (opts: { json?: boolean }) => {
      const result = await runModelWatchCli(deps);
      if (opts.json) out.log(JSON.stringify(result, null, 2));
      else out.log(formatModelWatchResult(result));
      for (const failure of result.failures) err.error(`Fetch failed [${failure.id}]: ${failure.error}`);
      if (result.status === 'no-pages') setExitCode(1);
    });
  command
    .command('apply [candidateIds...]')
    .description('마지막 제안 원장에서 사람이 고른 후보만 카탈로그에 반영한다')
    .option('--dry-run', '파일을 쓰지 않고 변경 예정만 출력한다')
    .action(async (candidateIds: string[], opts: { dryRun?: boolean }) => {
      await applyModelWatchCandidates(candidateIds, opts, deps);
    });
}
