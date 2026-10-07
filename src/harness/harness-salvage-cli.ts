/**
 * `elanous harness salvage <runId...> [--json]` — 런마다 «PR #n | 수확 가지 <branch> (+a/-b · N files) | 없음 | 모름(<이유>)».
 * SALVAGE-VISIBLE(0.2.19) — 판정은 `src/self-implement/salvage-branches.ts`, 여기는 배선·출력·관측만.
 */
import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { normalizeRunId } from './harness-space.js';
import { loadFederatedRunLedger } from '../self-implement/run-ledger.js';
import {
  decideRunSalvage,
  findRunSalvageBranches,
  gitSalvageRunner,
  listRemoteSalvageRefs,
  prStateFromLedger,
  type RunPrState,
  type RunSalvageVerdict,
  type SalvageGitRunner,
} from '../self-implement/salvage-branches.js';

export interface HarnessSalvageDeps {
  git?: SalvageGitRunner;
  readPr?: (runId: string) => RunPrState;
  print?: (line: string) => void;
}

function defaultReadPr(runId: string): RunPrState {
  try {
    return prStateFromLedger(loadFederatedRunLedger(runId, { includeTest: true }));
  } catch (error) {
    return { status: 'unknown', reason: `원장 읽기 실패 · ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 여러 런을 ls-remote «한 번»으로 판정한다. PR 이 있는 런은 git 을 더 부르지 않는다. */
export function runHarnessSalvage(runIds: readonly string[], deps: HarnessSalvageDeps = {}): RunSalvageVerdict[] {
  const git = deps.git ?? gitSalvageRunner(process.cwd());
  const readPr = deps.readPr ?? defaultReadPr;
  let listing: ReturnType<typeof listRemoteSalvageRefs> | undefined;
  const verdicts: RunSalvageVerdict[] = [];
  for (const raw of runIds) {
    const runId = normalizeRunId(raw);
    const pr = readPr(runId);
    let verdict: RunSalvageVerdict;
    if (pr.status === 'pr') {
      verdict = decideRunSalvage(runId, pr, { status: 'not-checked' });
    } else {
      listing ??= listRemoteSalvageRefs(git);
      verdict = decideRunSalvage(runId, pr, findRunSalvageBranches(runId, git, { listing }));
    }
    const top = verdict.salvage.status === 'found' ? verdict.salvage.branches[0] : undefined;
    debug.log('harness.salvage', 'visible', {
      runId,
      outcome: verdict.outcome,
      branch: top?.branch ?? null,
      files: top?.diffstat.files ?? null,
      ...(verdict.pr.status === 'pr' ? { prNumber: verdict.pr.number } : {}),
      ...(verdict.salvage.status === 'unknown' ? { reason: verdict.salvage.reason } : {}),
      ...(verdict.pr.status === 'unknown' ? { prReason: verdict.pr.reason } : {}),
    });
    verdicts.push(verdict);
  }
  return verdicts;
}

export function installHarnessSalvageCommand(harnessCmd: Command, deps: HarnessSalvageDeps = {}): Command {
  return harnessCmd
    .command('salvage')
    .description('런 → PR | 수확 가지(salvage/*) | 없음 | 모름 — Pod 런이 멈추며 남긴 가지를 보인다')
    .argument('<runIds...>', '런 id (run-xxxxxxxx-…)')
    .option('--json', '런마다 { runId, outcome, pr, salvage } 를 JSON 배열로')
    .action((runIds: string[], opts: { json?: boolean }) => {
      const print = deps.print ?? ((line: string) => console.log(line));
      const verdicts = runHarnessSalvage(runIds, deps);
      if (opts.json) print(JSON.stringify(verdicts.map(({ line: _line, ...rest }) => rest)));
      else for (const verdict of verdicts) print(verdict.line);
      if (verdicts.some((verdict) => verdict.outcome === 'unknown')) process.exitCode = 1;
    });
}
