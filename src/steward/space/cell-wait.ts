// PULL-CLAIMABLE-WAITING (live 11-25 18:2x · rail 30: hands idle again right after waking, 0 `eln work next` in 15 min) —
// when is a yellow cell «waiting» (no own move possible) rather than «active work»? Structured facts only, never prose:
//   the cell's open non-draft PR (title or branch names the cell id) on its CURRENT head is
//     · HOLD verdict                         → 'hold'
//     · PASS verdict (train lands it)        → 'awaiting-land'
//     · green receipt, no verdict yet (JUD)  → 'awaiting-verdict'
//     · no receipt yet (RES pregate slot)    → 'awaiting-receipt'
//   A red receipt or a FAIL verdict is NOT waiting — the owner has work (fix and push). A draft PR is the owner's own work.
// Consumers: `eln work next` (a waiting cell does not count toward WIP 1, and is never offered as READY) · the 행정관 R1
// (a hand whose every cell waits is woken with «take work next», not on its own cell) · the hand drive (goal-drive.ts).
//
// 세 얼굴: 관측 = the reason string rides on the work-next ledger row and the R1 row · 판단 근거 = PR ⊕ receipt ⊕ verdict
// (same sources the steward already reads) · 수복과 인계 = when the verdict/receipt lands the cell is active again and
// `eln work next` hands it back first (exit 4 = continue your own cell).

export type CellWait = 'hold' | 'awaiting-land' | 'awaiting-verdict' | 'awaiting-receipt';

export interface WaitPr { readonly number: number; readonly head: string; readonly branch: string; readonly title: string; readonly draft: boolean }
export interface WaitReceipt { readonly pr: number; readonly head12: string; readonly status: string }
export interface WaitVerdict { readonly pr: number; readonly head12: string; readonly kind: string; readonly verdict: string }
export interface WaitFacts { readonly prs: readonly WaitPr[]; readonly receipts: readonly WaitReceipt[]; readonly verdicts: readonly WaitVerdict[] }

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does this PR carry this cell? The cell id as a whole token (case-insensitive) in the title or the branch. */
export function prNamesCell(pr: Pick<WaitPr, 'title' | 'branch'>, cellId: string): boolean {
  const token = new RegExp(`(^|[^A-Za-z0-9-])${escape(cellId)}($|[^A-Za-z0-9-])`, 'i');
  return token.test(pr.title) || token.test(pr.branch);
}

/** Why the cell waits on someone else, or null (the owner can move it / no PR facts). */
export function cellWaitOf(cellId: string, facts: WaitFacts): CellWait | null {
  const prs = facts.prs.filter((pr) => !pr.draft && prNamesCell(pr, cellId));
  if (!prs.length) return null;
  const waits = prs.map((pr): CellWait | null => {
    const head12 = pr.head.slice(0, 12);
    const verdicts = facts.verdicts.filter((v) => v.pr === pr.number && v.head12 === head12);
    if (verdicts.some((v) => v.kind === 'hold' || v.verdict.toLowerCase() === 'hold')) return 'hold';
    if (verdicts.some((v) => v.verdict.toLowerCase() === 'pass')) return 'awaiting-land';
    if (verdicts.length) return null; // FAIL / changes requested on this head → the owner fixes
    const receipts = facts.receipts.filter((r) => r.pr === pr.number && r.head12 === head12);
    if (!receipts.length) return 'awaiting-receipt';
    return receipts.some((r) => /PASS/.test(r.status)) ? 'awaiting-verdict' : null;
  });
  // Any PR of the cell with owner work left (red) makes the cell active.
  if (waits.some((w) => w === null)) return null;
  return waits[0]!;
}

// PR-DONE (CEO 11-27 07:3x · revised 07:5x OPS-RULES «처리량 정책 개정 11-27» ①②): the land line owns the receipt and the
// main merge. A hand's «done» is the PR handed off — its branch pushed and its worktree clean (pregate's AUTHOR_TREE_DIRTY
// rule: an author tree with uncommitted changes means the pushed head is not the author's tree). That is the hand's only
// closing duty: `eln work next` answers exit 4 with «commit/push or clean» until it holds; a missing receipt or a branch
// behind main never blocks — the cell is «handed to the land line».
export interface AuthorTree { readonly path: string; readonly dirty: boolean; readonly unpushed: number }

/** The hand's closing move for this cell, or null (every PR of the cell is pushed from a clean tree — handed off).
 *  `treeOf(branch)` = the author's local worktree of the PR branch (null = none here / unknown → never blocks). */
export function prDoneTodo(cellId: string, facts: Pick<WaitFacts, 'prs'>, treeOf: (branch: string) => AuthorTree | null): { readonly pr: number; readonly why: 'dirty' | 'unpushed'; readonly line: string } | null {
  for (const pr of facts.prs.filter((p) => !p.draft && prNamesCell(p, cellId))) {
    let tree: AuthorTree | null = null;
    try { tree = treeOf(pr.branch); } catch { tree = null; }
    if (!tree) continue;
    if (tree.dirty) return { pr: pr.number, why: 'dirty', line: `PR #${pr.number}: your worktree ${tree.path} has uncommitted changes — commit and push (or clean it)` };
    if (tree.unpushed > 0) return { pr: pr.number, why: 'unpushed', line: `PR #${pr.number}: ${tree.unpushed} commit(s) on ${pr.branch} not pushed — git push` };
  }
  return null;
}
