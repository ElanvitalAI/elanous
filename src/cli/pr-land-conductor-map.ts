import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MAP = 'docs/conductor/CONDUCTOR.md';
const CELLS = 'docs/conductor/cells/';

type CommandResult = { status: number | null; stdout: string; stderr: string };
type Runner = (command: string, args: readonly string[], cwd: string) => CommandResult;

const runCommand: Runner = (command, args, cwd) => {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: `${result.stderr ?? ''}${result.error?.message ?? ''}` };
};

export function needsConductorMapRefresh(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) => file.startsWith(CELLS) && file.endsWith('.md')) && !changedFiles.includes(MAP);
}

function requireOk(result: CommandResult, label: string): string {
  if (result.status !== 0) throw new Error(`${label}: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  return result.stdout.trim();
}

/** After a fragment-only PR lands, open a generated-only follow-up from the fresh main tree. */
export async function openConductorMapRefreshPr(sourcePr: number, cwd: string, runner: Runner = runCommand): Promise<string | undefined> {
  if (!Number.isSafeInteger(sourcePr) || sourcePr < 1) throw new Error('source PR number must be positive');
  const viewed = JSON.parse(requireOk(runner('gh', ['pr', 'view', String(sourcePr), '--json', 'state,mergeCommit'], cwd), 'read source PR')) as {
    state?: string; mergeCommit?: { oid?: string } | null;
  };
  const mergeSha = viewed.mergeCommit?.oid;
  if (viewed.state !== 'MERGED' || !mergeSha || !/^[0-9a-f]{40,64}$/i.test(mergeSha)) throw new Error(`source PR #${sourcePr} merge receipt unavailable`);
  const branch = `docs/conductor-map-after-${sourcePr}-${mergeSha.slice(0, 8)}`;
  requireOk(runner('git', ['fetch', '--quiet', 'origin', 'main'], cwd), 'fetch main');
  const existing = runner('gh', ['pr', 'list', '--state', 'open', '--head', branch, '--json', 'url'], cwd);
  const existingUrl = existing.status === 0
    ? (JSON.parse(existing.stdout || '[]') as Array<{ url?: string }>)[0]?.url
    : undefined;
  if (existing.status !== 0 && existing.status !== null) throw new Error(`find existing conductor-map PR: ${existing.stderr || existing.stdout}`);
  if (existing.status === null) throw new Error(`find existing conductor-map PR: ${existing.stderr || existing.stdout}`);

  const tempRoot = mkdtempSync(join(tmpdir(), 'conductor-map-refresh-'));
  const worktree = join(tempRoot, 'tree');
  let worktreeAdded = false;
  let branchCreated = false;
  try {
    if (existingUrl) {
      requireOk(runner('git', ['fetch', '--quiet', 'origin', branch], cwd), 'fetch existing generated-map branch');
      requireOk(runner('git', ['worktree', 'add', '-b', branch, worktree, `origin/${branch}`], cwd), 'open existing generated-map worktree');
    } else {
      requireOk(runner('git', ['worktree', 'add', '-b', branch, worktree, 'origin/main'], cwd), 'create main worktree');
    }
    worktreeAdded = true;
    branchCreated = true;
    let url = existingUrl;
    if (!url) {
      requireOk(runner('bun', ['scripts/generate-conductor-cell-map.ts'], worktree), 'generate conductor cell map');
      requireOk(runner('bun', ['scripts/generate-conductor-cell-map.ts', '--check'], worktree), 'check conductor cell map');
      const diff = runner('git', ['diff', '--quiet', '--', MAP], worktree);
      if (diff.status === 0) return undefined;
      if (diff.status !== 1) throw new Error(`inspect generated map diff: ${diff.stderr || diff.stdout}`);
      requireOk(runner('git', ['add', '--', MAP], worktree), 'stage generated map');
      requireOk(runner('git', ['-c', 'user.name=elanous docs', '-c', 'user.email=docs@localhost', 'commit', '-m', `docs: refresh conductor map after #${sourcePr}`], worktree), 'commit generated map');
      requireOk(runner('git', ['push', 'origin', `HEAD:${branch}`], worktree), 'push generated-map branch');
      const bodyPath = join(tempRoot, 'body.md');
      writeFileSync(bodyPath, `## Situation\nPR #${sourcePr} landed new conductor cell fragments.\n\n## Complication\nThe shared §8 view is generated after source-only PRs land to keep their diffs independent.\n\n## Question\nHow does the published map catch up with the merged fragments?\n\n## Answer\nThis generated-only PR refreshes ${MAP} from current main. It receives a Terra review and is registered on the serialized land queue only when must-fix findings are zero.\n\n## Evidence\nThe generator and read-only --check passed in a fresh main worktree.\n`);
      url = requireOk(runner('gh', ['pr', 'create', '--base', 'main', '--head', branch,
        '--title', `docs: refresh conductor map after #${sourcePr}`, '--body-file', bodyPath], cwd), 'open generated-map PR');
    }

    const prNumber = /\/pull\/(\d+)(?:\D|$)/.exec(url ?? '')?.[1];
    if (!prNumber) throw new Error(`generated-map PR URL has no number: ${url ?? ''}`);
    const pr = JSON.parse(requireOk(runner('gh', ['pr', 'view', prNumber, '--json', 'state,headRefName,headRefOid'], cwd), 'read generated-map PR')) as {
      state?: string; headRefName?: string; headRefOid?: string;
    };
    const head = pr.headRefOid?.toLowerCase();
    if (pr.state !== 'OPEN' || pr.headRefName !== branch || !head || !/^[0-9a-f]{40}$/.test(head))
      throw new Error(`generated-map PR identity mismatch: #${prNumber} state=${pr.state} branch=${pr.headRefName} head=${pr.headRefOid}`);
    const worktreeHead = requireOk(runner('git', ['rev-parse', 'HEAD'], worktree), 'read generated-map worktree head').toLowerCase();
    if (worktreeHead !== head) throw new Error(`generated-map worktree head differs from PR #${prNumber}`);
    if (!existsSync(join(worktree, 'node_modules')) && existsSync(join(cwd, 'node_modules')))
      symlinkSync(join(cwd, 'node_modules'), join(worktree, 'node_modules'), 'dir');
    const reviewOutput = requireOk(runner('bun', ['bin/elanous.mjs', 'self', 'review', prNumber,
      '--model', 'gpt-6.1-terra', '--json', '--save', `conductor-map-refresh-${prNumber}`], worktree), 'review generated-map PR');
    const review = JSON.parse(reviewOutput) as { verdict?: string; mustFix?: unknown[]; headCommit?: string };
    if (!['pass', 'warn'].includes(review.verdict ?? '') || !Array.isArray(review.mustFix) || review.mustFix.length !== 0 || review.headCommit?.toLowerCase() !== head)
      throw new Error(`generated-map PR review is not enqueueable: verdict=${review.verdict} mustFix=${review.mustFix?.length ?? 'missing'} head=${review.headCommit ?? 'missing'}`);
    const enqueueScript = join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'tools', 'land-enqueue.sh');
    const enqueue = requireOk(runner(enqueueScript, [prNumber, worktree, '--expected-head', head], cwd), 'enqueue generated-map PR');
    if (!enqueue.split(/\r?\n/).some((line) => line.startsWith(`OK #${prNumber} head=${head.slice(0, 12)} headFull=${head}`)))
      throw new Error(`land-enqueue did not confirm generated-map PR #${prNumber} head`);
    return url;
  } finally {
    if (worktreeAdded) runner('git', ['worktree', 'remove', '--force', worktree], cwd);
    if (branchCreated) runner('git', ['branch', '-D', branch], cwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
