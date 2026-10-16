/**
 * Read-only virtual rebase proof for a reviewed PR head. The merge tree is written
 * into a disposable object directory, never into the repository object store.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { delimiter, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SHA40 = /^[a-f0-9]{40}$/iu;
type Verdict = { ok: true; oldBase: string; patchId: string }
  | { ok: false; reason: string };

type MergeTreeInput = { cwd: string; baseTip: string; head: string };

/** The callback may read the tree while its temporary objects exist. */
function withDisposableMergeTree<T>(input: MergeTreeInput, consume: (mergedTree: string, env: NodeJS.ProcessEnv) => T):
  { ok: true; value: T } | { ok: false; reason: string } {
  const { cwd, baseTip, head } = input;
  const gitObjects = spawnSync('git', ['rev-parse', '--git-path', 'objects'], { cwd, encoding: 'utf8' });
  if (gitObjects.status !== 0 || !gitObjects.stdout.trim()) return { ok: false, reason: 'object-directory-unmeasured' };
  const alternate = resolve(cwd, gitObjects.stdout.trim());
  let temporary: string;
  try { temporary = mkdtempSync(join(tmpdir(), 'elanous-virtual-rebase-')); }
  catch { return { ok: false, reason: 'temporary-object-directory-unmeasured' }; }
  const env = {
    ...process.env,
    GIT_OBJECT_DIRECTORY: temporary,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [alternate, process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter),
  };
  try {
    const result = spawnSync('git', ['merge-tree', '--write-tree', baseTip, head], {
      cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    const mergedTree = result.status === 0 && !result.error ? result.stdout.trim() : '';
    if (!SHA40.test(mergedTree)) return { ok: false, reason: 'merge-tree-conflict-or-unmeasured' };
    return { ok: true, value: consume(mergedTree, env) };
  } catch {
    return { ok: false, reason: 'virtual-rebase-unmeasured' };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function verifyVirtualRebasePatch(input: MergeTreeInput): Verdict {
  const { cwd, baseTip, head } = input;
  if (!SHA40.test(baseTip) || !SHA40.test(head)) return { ok: false, reason: 'invalid-sha' };
  const git = (args: string[], env?: NodeJS.ProcessEnv, stdin?: string) => spawnSync('git', args, {
    cwd, env, input: stdin, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const checked = (args: string[], env?: NodeJS.ProcessEnv) => {
    const result = git(args, env);
    return result.status === 0 && !result.error ? result.stdout.trim() : undefined;
  };
  const oldBase = checked(['merge-base', baseTip, head]);
  if (!oldBase || !SHA40.test(oldBase)) return { ok: false, reason: 'merge-base-unmeasured' };
  if (oldBase === head) return { ok: false, reason: 'head-has-no-patch' };
  const merged = withDisposableMergeTree(input, (mergedTree, env): Verdict => {
    const binaryBlob = (sha: string, inEnv?: NodeJS.ProcessEnv): 'binary' | 'text' | 'unmeasured' => {
      if (/^0+$/u.test(sha)) return 'text';
      const size = checked(['cat-file', '-s', sha], inEnv);
      if (!size || !/^\d+$/u.test(size) || Number(size) > 32 * 1024 * 1024) return 'unmeasured';
      const result = spawnSync('git', ['cat-file', 'blob', sha], {
        cwd, env: inEnv, maxBuffer: 32 * 1024 * 1024,
      });
      if (result.status !== 0 || result.error || !Buffer.isBuffer(result.stdout)) return 'unmeasured';
      const blob = result.stdout;
      if (blob.includes(0) || blob.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) return 'binary';
      try { new TextDecoder('utf-8', { fatal: true }).decode(blob); }
      catch { return 'binary'; }
      return 'text';
    };
    const changed = (from: string, to: string, inEnv?: NodeJS.ProcessEnv) => {
      const names = checked(['diff', '--name-status', '-M', '-C', '--find-copies-harder', from, to], inEnv);
      const numstat = checked(['diff', '--numstat', from, to], inEnv);
      if (names === undefined || numstat === undefined) return { ok: false as const, reason: 'diff-unmeasured' };
      if (!names) return { ok: false as const, reason: 'empty-patch' };
      if (names.split('\n').some((line) => /^[RC][0-9]*\t/u.test(line))) return { ok: false as const, reason: 'rename-or-copy' };
      if (numstat.split('\n').some((line) => /^-\t-\t/u.test(line))) return { ok: false as const, reason: 'binary-patch' };
      const raw = checked(['diff', '--raw', '--no-abbrev', '-z', from, to], inEnv);
      if (raw === undefined) return { ok: false as const, reason: 'diff-unmeasured' };
      const fields = raw.split('\0').filter(Boolean);
      if (fields.length === 0 || fields.length % 2 !== 0) return { ok: false as const, reason: 'diff-blob-unmeasured' };
      for (let i = 0; i < fields.length; i += 2) {
        const entry = /^:[0-7]{6} [0-7]{6} ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) [A-Z][0-9]*$/iu.exec(fields[i]!);
        if (!entry) return { ok: false as const, reason: 'diff-blob-unmeasured' };
        for (const sha of [entry[1]!, entry[2]!]) {
          const kind = binaryBlob(sha, inEnv);
          if (kind !== 'text') return { ok: false as const, reason: kind === 'binary' ? 'binary-patch' : 'diff-blob-unmeasured' };
        }
      }
      const diff = checked(['diff', '--no-ext-diff', '--no-renames', '--binary', from, to], inEnv);
      if (!diff) return { ok: false as const, reason: 'diff-unmeasured' };
      const patched = git(['patch-id', '--stable'], inEnv, `${diff}\n`);
      const patchId = patched.status === 0 && !patched.error ? patched.stdout.trim().split(/\s+/u)[0] : undefined;
      return patchId && SHA40.test(patchId)
        ? { ok: true as const, patchId }
        : { ok: false as const, reason: 'patch-id-unmeasured' };
    };
    const original = changed(oldBase, head);
    if (!original.ok) return original;
    const virtual = changed(baseTip, mergedTree, env);
    if (!virtual.ok) return virtual;
    if (original.patchId !== virtual.patchId) return { ok: false, reason: 'patch-id-different' };
    return { ok: true, oldBase, patchId: original.patchId };
  });
  return merged.ok ? merged.value : merged;
}
