/**
 * Receipt rules shared by the land graph (decide · land-time) and the judge-butler (judgeCell · green-time).
 *
 * S: BUTLER-SIGN-MERGED-PATCHID (11-27): green-triage listed 26 cells «merged + receipt» and the butler signed 0 — it judged
 *    the receipt by its own older copy of the land rule: an L0 doc-only receipt (pregate skipped the focused stage but still
 *    listed one focused file) read as «focused unreadable», and a focused failure that also fails on main
 *    (BASELINE-FAIL-NONBLOCK · 대표 11-27) read as «1 fail». The land graph had already landed those PRs on the same receipts.
 * A: one definition, imported by both — no copy may drift again. Pure, no imports (land-graph.ts ↔ done-when.ts cycle-free).
 */

/** Every file is markdown or under docs/. */
export const isDocOnly = (files: readonly string[]): boolean => files.length > 0 && files.every(f => /\.md$/i.test(f) || f.startsWith('docs/'));

/** The receipt ran no focused stage: an empty focused set, or pregate graded it L0 and skipped the stage. */
export const noFocusedStage = (r: { readonly focusedCount: number; readonly grade?: string | undefined; readonly focusedExit?: number | null | undefined }): boolean =>
  r.focusedCount === 0 || (r.grade === 'L0' && r.focusedExit == null);

/** pregate A244 ③ same-host focused-vs-main: the head has failures, and every one of them also fails on main (0 head-only names). */
export const preexistingOnly = (fb: { readonly mine: number; readonly newFailures: readonly string[] } | null | undefined): boolean =>
  !!fb && fb.mine > 0 && fb.newFailures.length === 0;
