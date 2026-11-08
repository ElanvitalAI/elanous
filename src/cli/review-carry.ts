/** Prove that a PR's new head is exactly a clean merge of main into its reviewed head. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SHA = /^[0-9a-f]{40}$/i;
const MAX = 32 * 1024 * 1024;
const SCOPE_TOTAL_MAX = 12000;

function boundedSection(text: string, max = SCOPE_TOTAL_MAX): string {
  return text.length <= max ? text
    : `${text.slice(0, max)}\n...[scope/evidence section truncated; ${text.length - max} chars omitted]`;
}

function renderSections(sections: MarkdownSection[]): string {
  const headers = sections.map(({ heading }) => `### ${heading}\n`);
  const separators = Math.max(0, sections.length - 1) * 2;
  const bodyBudget = Math.max(0, SCOPE_TOTAL_MAX - separators - headers.reduce((sum, header) => sum + header.length, 0));
  const budgets = sections.map(() => 0);
  let pending = sections.map((_, index) => index);
  let remaining = bodyBudget;
  while (pending.length) {
    const share = Math.floor(remaining / pending.length);
    const complete = pending.filter((index) => sections[index]!.body.length <= share);
    if (complete.length === 0) {
      for (const index of pending) budgets[index] = share;
      break;
    }
    for (const index of complete) {
      budgets[index] = sections[index]!.body.length;
      remaining -= budgets[index]!;
      pending = pending.filter((candidate) => candidate !== index);
    }
  }
  return sections.map(({ body }, index) => `${headers[index]}${boundedSection(body, budgets[index]!)}`).join('\n\n');
}

function outermostMatchingSections(sections: MarkdownSection[], predicate: (heading: string) => boolean): MarkdownSection[] {
  const matching = new Set(sections.filter(({ heading }) => predicate(heading)).map(({ index }) => index));
  return sections.filter((section) => matching.has(section.index)
    && !section.ancestors.some((ancestor) => matching.has(ancestor)));
}

export function buildReviewScopeContractContext(input: {
  prBody?: string;
  previouslyFixedFindings?: readonly string[];
}): string {
  const body = input.prBody?.trim() ?? '';
  const sections = markdownSections(body);
  const scope = outermostMatchingSections(sections, (heading) => /(?:scope boundary|intentional scope|out of scope|범위 경계|범위 밖|범위 제외|의도적 범위)/i.test(heading));
  const declaredScope = scope.length ? scope : outermostMatchingSections(sections, (heading) =>
    /^(?:summary|change|answer)(?:\b|\s|[:：—-]|$)/i.test(heading)
      || /^(?:변경|요약|답변)(?:\s|[:：—-]|$)/.test(heading));
  const evidence = outermostMatchingSections(sections, (heading) => /(?:evidence|proof|test reach|verification|validation|tests?|증거|검증 근거|검증 결과|시험)/i.test(heading));
  const stale = [...new Set((input.previouslyFixedFindings ?? []).map((finding) => finding.trim()).filter(Boolean))];
  return [
    '## Intentional scope boundary',
    declaredScope.length ? `${renderSections(declaredScope)}${scope.length ? '' : '\n\nNo explicit exclusions were stated; do not infer additional scope boundaries.'}`
      : 'No intentional scope boundary or summary was stated in the PR body. Do not invent one; review the declared intent and diff.',
    'Review declared exclusions. Do not require out-of-scope work unless the current diff contains a concrete correctness, safety, or data-loss defect.',
    '## PR body evidence',
    evidence.length ? renderSections(evidence)
      : `No explicit evidence section was found. Treat the PR body as context, not proof.\n\n## PR body (verbatim)\n${boundedSection(body || '(PR body unavailable)')}`,
    '## Previously closed findings',
    stale.length
      ? `${stale.map((finding) => `[STALE — previously closed with evidence] ${finding}`).join('\n')}\nDo not re-raise these findings unless the current diff supplies concrete contrary evidence.`
      : 'No evidence-closed finding from the immediately preceding review is available.',
  ].join('\n\n');
}

interface MarkdownSection { heading: string; body: string; level: number; index: number; ancestors: number[] }

function markdownSections(markdown: string): MarkdownSection[] {
  const matches = [...markdown.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map((match) => ({
    level: match[1]!.length,
    heading: match[2]!.trim(),
    start: match.index! + match[0].length,
    index: match.index!,
  }));
  const stack: Array<{ index: number; level: number }> = [];
  return matches.map((section, index) => {
    while (stack.at(-1) && stack.at(-1)!.level >= section.level) stack.pop();
    const ancestors = stack.map(({ index: ancestorIndex }) => ancestorIndex);
    stack.push({ index: section.index, level: section.level });
    const next = matches.slice(index + 1).find((candidate) => candidate.level <= section.level);
    return { heading: section.heading, body: markdown.slice(section.start, next?.index ?? markdown.length).trim(),
      level: section.level, index: section.index, ancestors };
  });
}

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
