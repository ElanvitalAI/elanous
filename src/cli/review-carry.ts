/** Prove that a PR's new head is exactly a clean merge of main into its reviewed head. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SHA = /^[0-9a-f]{40}$/i;
const MAX = 32 * 1024 * 1024;

export type ReviewCarryProof = { ok: true; oldBase: string; newBase: string; patchId: string; pathsModesHash: string }
  | { ok: false; reason: string };

/** No refs, index, or worktree are changed. merge-tree objects live in a disposable directory. */
export function proveReviewCarry(cwd: string, oldHead: string, newHead: string, remote = 'origin', branch = 'main'): ReviewCarryProof {
  if (!SHA.test(oldHead) || !SHA.test(newHead) || oldHead === newHead) return { ok: false, reason: 'carry-invalid-head' };
  const run = (args: string[], env?: NodeJS.ProcessEnv, input?: string) => spawnSync('git', args,
    { cwd, env, input, encoding: 'utf8', maxBuffer: MAX });
  const read = (args: string[], env?: NodeJS.ProcessEnv): string | null => {
    const result = run(args, env);
    return result.status === 0 && !result.error ? result.stdout.trim() : null;
  };
  const parents = read(['rev-list', '--parents', '-n', '1', newHead])?.split(/\s+/);
  if (!parents || parents.length !== 3 || parents[0]?.toLowerCase() !== newHead.toLowerCase()
    || parents[1]?.toLowerCase() !== oldHead.toLowerCase() || !SHA.test(parents[2] ?? '')) {
    return { ok: false, reason: 'carry-not-direct-main-merge' };
  }
  const newBase = parents[2]!.toLowerCase();
  const main = read(['rev-parse', '--verify', `refs/remotes/${remote}/${branch}`]);
  if (!main || !SHA.test(main) || run(['merge-base', '--is-ancestor', newBase, main]).status !== 0) {
    return { ok: false, reason: 'carry-main-parent-unmeasured' };
  }
  const oldBase = read(['merge-base', oldHead, newBase]);
  if (!oldBase || !SHA.test(oldBase)) return { ok: false, reason: 'carry-old-base-unmeasured' };
  if (oldBase.toLowerCase() === oldHead.toLowerCase()) return { ok: false, reason: 'carry-no-pr-patch' };
  const objects = read(['rev-parse', '--git-path', 'objects']);
  if (!objects) return { ok: false, reason: 'carry-object-directory-unmeasured' };
  let temporary: string;
  try { temporary = mkdtempSync(join(tmpdir(), 'elanous-review-carry-')); }
  catch { return { ok: false, reason: 'carry-temp-directory-unmeasured' }; }
  const env = { ...process.env, GIT_OBJECT_DIRECTORY: temporary,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [resolve(cwd, objects), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter) };
  try {
    const mergedTree = read(['merge-tree', '--write-tree', oldHead, newBase], env);
    if (!mergedTree || !SHA.test(mergedTree)) return { ok: false, reason: 'carry-merge-conflict-or-unmeasured' };
    const actualTree = read(['rev-parse', '--verify', `${newHead}^{tree}`]);
    if (!actualTree || actualTree.toLowerCase() !== mergedTree.toLowerCase()) {
      return { ok: false, reason: 'carry-merge-tree-changed' };
    }
    const changed = (from: string, to: string, objectEnv?: NodeJS.ProcessEnv) => {
      const raw = run(['diff', '--raw', '--no-renames', '--no-abbrev', '-z', from, to], objectEnv);
      const numstat = read(['diff', '--numstat', from, to], objectEnv);
      const diff = read(['diff', '--no-ext-diff', '--no-renames', '--binary', from, to], objectEnv);
      if (raw.status !== 0 || raw.error || numstat === null || !diff) return null;
      if (numstat.split('\n').some((line) => /^-\t-\t/.test(line))) return null;
      const fields = raw.stdout.split('\0').filter(Boolean);
      if (!fields.length || fields.length % 2 !== 0) return null;
      const pathsModes: string[] = [];
      for (let i = 0; i < fields.length; i += 2) {
        const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} ([A-Z])$/i.exec(fields[i]!);
        if (!match || !fields[i + 1] || !['A', 'M', 'D', 'T'].includes(match[3]!)) return null;
        pathsModes.push(`${match[3]}\0${match[1]}\0${match[2]}\0${fields[i + 1]}`);
      }
      const patched = run(['patch-id', '--stable'], objectEnv, `${diff}\n`);
      const patchId = patched.status === 0 && !patched.error ? patched.stdout.trim().split(/\s+/)[0] : null;
      return patchId && SHA.test(patchId) ? { patchId: patchId.toLowerCase(), pathsModes: pathsModes.sort() } : null;
    };
    const before = changed(oldBase, oldHead);
    const after = changed(newBase, newHead);
    if (!before || !after) return { ok: false, reason: 'carry-patch-unmeasured' };
    if (before.patchId !== after.patchId || JSON.stringify(before.pathsModes) !== JSON.stringify(after.pathsModes)) {
      return { ok: false, reason: 'carry-patch-or-path-mode-changed' };
    }
    return { ok: true, oldBase: oldBase.toLowerCase(), newBase, patchId: before.patchId,
      pathsModesHash: createHash('sha256').update(JSON.stringify(before.pathsModes)).digest('hex') };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
