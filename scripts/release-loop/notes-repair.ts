import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, statSync, chmodSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { getProviderForConfig, type LLMMessage } from '../../src/llm.js';
import { getUserConfig } from '../../src/user-config.js';
import type { GraphContext } from './node-verdict.js';

export const REPAIR_MODEL = 'openrouter/z-ai/glm-5.3';
export type Translator = (line: string, model: string) => Promise<string>;
export type RepairResult = { text: string; translatedLines: number[]; error?: string };

function koreanProseLines(text: string): Array<{ index: number; line: string }> {
  let fence: { char: string; length: number } | undefined;
  return text.split(/\r?\n/).flatMap((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0]!, length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = undefined;
      return [];
    }
    if (fence || !/[가-힣]/.test(line.replace(/(`+)[^`]*?\1/g, ''))) return [];
    return [{ index, line }];
  });
}

export async function repairKoreanMarkdown(text: string, translate: Translator, onlyLines?: ReadonlySet<number>): Promise<RepairResult> {
  const lines = text.split(/\r?\n/);
  const translatedLines: number[] = [];
  for (const item of koreanProseLines(text).filter(({ index }) => !onlyLines || onlyLines.has(index + 1))) {
    try {
      // Keep inline code out of the model's editable surface and restore it byte-for-byte.
      const code: string[] = [];
      const protectedLine = item.line.replace(/(`+)[^`]*?\1/g, (match) => `⟦CODE${code.push(match) - 1}⟧`);
      const value = (await translate(protectedLine, REPAIR_MODEL)).trim();
      if (!value) throw new Error('translator returned empty text');
      for (const [index] of code.entries()) {
        const token = `⟦CODE${index}⟧`;
        if (value.split(token).length !== 2) throw new Error('translator changed protected inline code');
      }
      const restored = value.replace(/⟦CODE(\d+)⟧/g, (_match, rawIndex: string) => {
        const original = code[Number(rawIndex)];
        if (original === undefined) throw new Error('translator changed protected inline code');
        return original;
      });
      if (/[가-힣]/.test(restored.replace(/(`+)[^`]*?\1/g, ''))) throw new Error('translation still contains Korean prose');
      lines[item.index] = restored;
      translatedLines.push(item.index + 1);
    } catch (error) {
      return { text, translatedLines: [], error: `line ${item.index + 1}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { text: lines.join('\n'), translatedLines };
}

export const glmTranslator: Translator = async (line, model) => {
  if (model !== REPAIR_MODEL) throw new Error(`unexpected translator model: ${model}`);
  const config = getUserConfig();
  const llmConfig = { ...config, llm: { ...config.llm, provider: 'openrouter' as const, model } };
  const provider = getProviderForConfig(llmConfig, model);
  if (provider.name !== 'openrouter' || !provider.available()) throw new Error('OpenRouter credentials unavailable for openrouter/z-ai/glm-5.3');
  const messages: LLMMessage[] = [
    { role: 'system', content: 'Translate the supplied single public release-note line into concise idiomatic English. Return only the translation. Preserve markdown structure, meaning, punctuation, and every placeholder exactly.' },
    { role: 'user', content: line },
  ];
  let result = '';
  for await (const chunk of provider.chat(messages, { model, temperature: 0, maxTokens: 512, remainingFallbacks: 0, promptCache: false })) result += chunk;
  return result;
};

export function atomicallyRepairFiles(targets: Array<{ path: string; lines: number[] }>, translate: Translator = glmTranslator): Promise<{ files: string[]; translatedLines: number[]; error?: string }> {
  return (async () => {
    const changed: string[] = [];
    const translatedLines: number[] = [];
    const staged: Array<{ path: string; text: string }> = [];
    for (const { path, lines: selectedLines } of targets) {
      const original = readFileSync(path, 'utf8');
      const result = await repairKoreanMarkdown(original, translate, new Set(selectedLines));
      if (result.error) return { files: changed, translatedLines, error: `${path}: ${result.error}` };
      if (result.text !== original) {
        staged.push({ path, text: result.text });
        changed.push(path);
        translatedLines.push(...result.translatedLines);
      }
    }
    for (const { path, text } of staged) {
      const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
      try { writeFileSync(temp, text); chmodSync(temp, statSync(path).mode); renameSync(temp, path); }
      finally { if (existsSync(temp)) unlinkSync(temp); }
    }
    return { files: changed, translatedLines };
  })();
}

type DocsReceipt = {
  owner: { runId: string; attempt: number };
  branch: string;
  worktree: string;
  outcome: 'pushed';
  head: string;
  result: Record<string, unknown>;
};

function git(tree: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: tree, encoding: 'utf8', timeout: 30_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (result.status !== 0) throw new Error(`docs repair git ${args[0]} failed: ${(result.stderr || result.error || '').toString().trim()}`);
  return result.stdout.trim();
}

function remoteHead(tree: string, branch: string): string {
  const line = git(tree, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
  const match = /^([0-9a-f]{40})\s+refs\/heads\/[^\s]+$/i.exec(line);
  if (!match) throw new Error(`docs repair remote head missing or invalid: ${branch}`);
  return match[1]!;
}

function publishReceipt(path: string, receipt: DocsReceipt): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(receipt) + '\n'); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}

function ownedDocsReceipt(context: GraphContext, docs: Record<string, unknown>, tree: string, stateRoot: string,
  approvedPaths: string[]): { path: string; receipt: DocsReceipt } {
  const runId = context.runId;
  const owner = docs.artifactOwner as { runId?: unknown; attempt?: unknown } | undefined;
  const branch = `release-docs/${context.input.version}`;
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)
    || !owner || owner.runId !== runId || !Number.isSafeInteger(owner.attempt) || docs.branch !== branch)
    throw new Error('docs repair requires same-run docs branch ownership');
  const path = join(stateRoot, 'release', context.input.version, 'docs-branch-owner.json');
  let receipt = JSON.parse(readFileSync(path, 'utf8')) as DocsReceipt;
  if (receipt?.outcome !== 'pushed' || receipt.owner?.runId !== runId || receipt.owner.attempt !== owner.attempt
    || receipt.branch !== branch || realpathSync(receipt.worktree) !== tree || !/^[0-9a-f]{40}$/i.test(receipt.head)
    || receipt.result?.outcome !== 'ok') throw new Error('docs repair ownership receipt does not match this run and attempt');
  if (git(tree, 'branch', '--show-current') !== branch) throw new Error('docs repair branch differs from ownership receipt');
  if (git(tree, 'status', '--porcelain')) throw new Error('docs repair worktree is not clean');
  const local = git(tree, 'rev-parse', 'HEAD');
  const remote = remoteHead(tree, branch);
  if (local !== receipt.head) {
    const parents = git(tree, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
    const message = git(tree, 'log', '-1', '--format=%B', 'HEAD');
    const changed = git(tree, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').filter(Boolean);
    const approved = approvedPaths.map((file) => relative(tree, realpathSync(file)));
    if (parents.length !== 2 || parents[0] !== local || parents[1] !== receipt.head
      || !message.split('\n').includes(`Release-Notes-Repair-Run: ${runId}`)
      || !message.split('\n').includes(`Release-Notes-Repair-Attempt: ${owner.attempt}`)
      || !changed.length || changed.some((name) => !approved.includes(name))
      || (remote !== receipt.head && remote !== local))
      throw new Error('docs repair local/remote head differs from ownership receipt');
    if (remote === receipt.head) git(tree, 'push', 'origin', `HEAD:refs/heads/${branch}`);
    if (remoteHead(tree, branch) !== local) throw new Error('docs repair recovery remote head verification failed');
    receipt = { ...receipt, head: local };
    publishReceipt(path, receipt);
  } else if (remote !== receipt.head) throw new Error('docs repair local/remote head differs from ownership receipt');
  return { path, receipt };
}

function publishDocsRepair(tree: string, files: string[], path: string, receipt: DocsReceipt): string {
  const names = files.map((file) => relative(tree, realpathSync(file)));
  git(tree, 'add', '--', ...names);
  const staged = git(tree, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (staged.some((name) => !names.includes(name))) throw new Error('docs repair staged a file outside approved B11 targets');
  if (!staged.length) return receipt.head;
  git(tree, 'commit', '-m', `docs: repair release ${receipt.branch.split('/').at(-1)} notes`,
    '-m', `Release-Notes-Repair-Run: ${receipt.owner.runId}\nRelease-Notes-Repair-Attempt: ${receipt.owner.attempt}`);
  const head = git(tree, 'rev-parse', 'HEAD');
  git(tree, 'push', 'origin', `HEAD:refs/heads/${receipt.branch}`);
  if (remoteHead(tree, receipt.branch) !== head) throw new Error('docs repair remote head verification failed');
  publishReceipt(path, { ...receipt, head });
  return head;
}

export async function runNotesRepair(context: GraphContext, translate: Translator = glmTranslator,
  deps: { stateRoot?: string } = {}): Promise<{
  outcome: 'ok' | 'fail'; version: string; summary: string; files?: string[]; translatedLines?: number[]; head?: string; error?: string;
}> {
  try {
    if (context.outputs['notes-repair']) throw new Error('B11 remains after the single permitted translation attempt');
    const docs = context.outputs.docs;
    if (docs?.outcome !== 'ok' || typeof docs.notes !== 'string' || typeof docs.worktree !== 'string') throw new Error('docs output required');
    const findings = context.outputs['notes-check']?.findings;
    if (!Array.isArray(findings)) throw new Error('notes-check findings required');
    const allowed = new Set([docs.notes, ...(Array.isArray(docs.flipped) ? docs.flipped : [])]
      .filter((path): path is string => typeof path === 'string').map((path) => realpathSync(resolve(path))));
    const worktree = realpathSync(resolve(docs.worktree));
    const targets = new Map<string, Set<number>>();
    for (const raw of findings) {
      if (!raw || typeof raw !== 'object') continue;
      const finding = raw as { rule?: unknown; file?: unknown; line?: unknown };
      if (finding.rule !== 'B11' || typeof finding.file !== 'string' || typeof finding.line !== 'number'
        || !Number.isSafeInteger(finding.line) || finding.line < 1) continue;
      const file = realpathSync(resolve(finding.file));
      if (!file.startsWith(`${worktree}${sep}`) || !allowed.has(file)) throw new Error(`B11 target outside docs output: ${finding.file}`);
      const lines = targets.get(finding.file) ?? new Set<number>();
      lines.add(finding.line);
      targets.set(finding.file, lines);
    }
    if (findings.some((finding) => !finding || typeof finding !== 'object' || (finding as { rule?: string }).rule !== 'B11'))
      throw new Error('notes-check has non-B11 findings; translation cannot repair them');
    if (!targets.size) throw new Error('notes-check failed without repairable B11 findings');
    const files = [...targets].map(([path, lines]) => ({ path, lines: [...lines] }));
    const { path: receiptPath, receipt } = ownedDocsReceipt(context, docs, worktree,
      deps.stateRoot ?? effectiveInstanceRoot(), files.map((file) => file.path));
    const result = await atomicallyRepairFiles(files, translate);
    if (result.error) return { outcome: 'fail', version: context.input.version, summary: result.error, ...result };
    const head = result.files.length ? publishDocsRepair(worktree, result.files, receiptPath, receipt) : receipt.head;
    return { outcome: 'ok', version: context.input.version,
      summary: `translated ${result.translatedLines.length} line(s)`, ...result, head };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: 'fail', version: context.input.version, summary: message, error: message };
  }
}
