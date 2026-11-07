import { spawnSync } from 'node:child_process';
import type { GateReceipt, GateReceiptRegistry } from '../self-implement/gate-receipt-registry.js';
import { debug } from '../debug/log.js';

export interface TscError {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  symbols: string[];
  raw: string;
}

export type TypecheckDriftVerdict = 'drift' | 'drift-unmeasured' | 'drift-unrelated';
export interface TypecheckDriftResult {
  verdict: TypecheckDriftVerdict;
  receipt?: GateReceipt;
  receiptBase?: string;
  failBase: string;
  errors: TscError[];
  symbols: string[];
  changedFiles: string[];
  reason?: string;
}

export type DriftGitResult = { status: number | null; stdout: string; stderr: string };
export type DriftGit = (args: readonly string[], repo: string) => DriftGitResult;
export interface TypecheckDriftDependencies {
  git: DriftGit;
  loadGateReceipts: (path: string) => GateReceiptRegistry;
}

export interface ClassifyTypecheckDriftInput {
  repo: string;
  headCommit: string;
  failBase: string;
  tscOutput: string;
  receiptPath: string;
}

export type DriftDeps = TypecheckDriftDependencies;
export interface RepairAttempt {
  pr: number;
  head: string;
  failedBase: string;
  output: string;
  result: TypecheckDriftResult;
  prFiles: readonly string[];
  attemptsByHead: number;
  attemptsByPr: number;
}
export type RepairPlan = { action: 'launch'; goal: string; boundaryFiles: string[] }
  | { action: 'escalate'; mail: string; reason: string }
  | { action: 'skip'; reason: string };
export type DriftLaunch = (goal: string, boundaryFiles: readonly string[]) => void | Promise<void>;
export type DriftEscalate = (mail: string) => void;

/** Live repair is an explicit opt-in; missing or invalid configuration stays observational. */
export function resolveDriftAutorepairMode(value: unknown): 'off' | 'shadow' | 'live' {
  if (value === 'off') return 'off';
  if (value === 'live') return 'live';
  return 'shadow';
}

const defaultGit: DriftGit = (args, repo) => {
  const result = spawnSync('git', [...args], { cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: (result.stderr ?? '') + (result.error?.message ?? '') };
};
const SHA = /^[0-9a-f]{40,64}$/i;
const TSC_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/;
const TSC_DIAGNOSTIC_ALT = /^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s*(.*)$/;
const IDENTIFIER = /\b[$A-Z_a-z][$\w]*\b/g;

function diagnosticSymbols(message: string): string[] {
  const symbols = new Set<string>();
  const targetPatterns = [
    /Cannot find name ['"`]([$A-Z_a-z][$\w]*)['"`]/i,
    /(?:Property|parameter|type) ['"`]([$A-Z_a-z][$\w]*)['"`]/i,
    /\bon type ['"`]?([$A-Z_a-z][$\w]*)/i,
    /has no exported member ['"`]([$A-Z_a-z][$\w]*)['"`]/i,
    /has no member ['"`]([$A-Z_a-z][$\w]*)['"`]/i,
  ];
  for (const pattern of targetPatterns) {
    const match = pattern.exec(message);
    if (match) symbols.add(match[1]);
  }
  const property = /\bProperty\s+([$A-Z_a-z][$\w]*)\b/i.exec(message)?.[1];
  if (property) symbols.add(property);
  const requiredType = /\bbut required in type\s+['"`]([^'"`]+)['"`]/i.exec(message)?.[1];
  if (requiredType) {
    const typeName = /[$A-Z_a-z][$\w]*/.exec(requiredType)?.[0];
    if (typeName) symbols.add(typeName);
  }
  return [...symbols];
}

function exportedIdentifiers(declaration: string): string[] {
  const names: string[] = [];
  const declarationMatch = /\bexport\s+(?:(?:declare|abstract)\s+)*(?:default\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([$A-Z_a-z][$\w]*)/.exec(declaration);
  if (declarationMatch) names.push(declarationMatch[1]);
  for (const match of declaration.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const specifier of match[1].split(',')) {
      const identifiers = specifier.trim().match(IDENTIFIER) ?? [];
      if (identifiers.length) names.push(identifiers[identifiers.length - 1]);
    }
  }
  return names;
}

function exportedDeclarations(source: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!/\bexport\b/.test(lines[index])) continue;
    let declaration = lines[index];
    let depth = (lines[index].match(/[{}]/g) ?? []).reduce((total, brace) => total + (brace === '{' ? 1 : -1), 0);
    const typeAlias = /^\s*export\s+type\s+[$A-Z_a-z][$\w]*\s*=\s*(.*)$/.exec(lines[index]);
    const nextLineContinuesType = /^\s*[|&]/.test(lines[index + 1] ?? '');
    const multilineTypeAlias = !!typeAlias && (!typeAlias[1].trim() || /^[{[(]/.test(typeAlias[1].trim())
      || /[|&]\s*$/.test(typeAlias[1]) || nextLineContinuesType);
    while (index + 1 < lines.length && (depth > 0 || multilineTypeAlias && !/[;}](?:\s*\/\/.*)?\s*$/.test(declaration.trimEnd()))) {
      const next = lines[index + 1]!;
      if (depth === 0 && /^\s*export\b/.test(next)) break;
      const line = lines[++index];
      declaration += `\n${line}`;
      depth += (line.match(/[{}]/g) ?? []).reduce((total, brace) => total + (brace === '{' ? 1 : -1), 0);
    }
    for (const name of exportedIdentifiers(declaration)) declarations.set(name, declaration);
  }
  return declarations;
}

/** Preserve merge-train attribution while routing tangled pairs back to the existing ordering path. */
export function planCulpritDriftRepair<T extends { culprits: readonly number[] }>(
  observation: T,
  tangledPairs: readonly { first: number; then: number; failures: number }[],
  classify: (pr: number) => RepairPlan,
): { pr: number; plan: RepairPlan | { action: 'reorder'; with: number } }[] {
  return observation.culprits.map((pr) => {
    const tangled = tangledPairs.find((pair) => pair.first === pr || pair.then === pr);
    if (!tangled) return { pr, plan: classify(pr) };
    return { pr, plan: { action: 'reorder', with: tangled.first === pr ? tangled.then : tangled.first } };
  });
}

/** Parse canonical tsc diagnostics without altering or discarding their source line. */
export function parseTscErrors(text: string): TscError[] {
  const errors: TscError[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = TSC_DIAGNOSTIC.exec(raw) ?? TSC_DIAGNOSTIC_ALT.exec(raw);
    if (!match) continue;
    const message = match[5].trim();
    const symbols = diagnosticSymbols(message);
    errors.push({ file: match[1], line: Number(match[2]), column: Number(match[3]), code: match[4], message, symbols, raw });
  }
  return errors;
}

/** Classify only when a same-head changed-file typecheck receipt and measurable base movement exist. */
export function classifyTypecheckDrift(
  input: ClassifyTypecheckDriftInput,
  deps: Partial<TypecheckDriftDependencies> = {},
): TypecheckDriftResult {
  const failBase = input.failBase;
  const unmeasured = (reason: string, receipt?: GateReceipt): TypecheckDriftResult => ({
    verdict: 'drift-unmeasured', failBase, errors, symbols, changedFiles: [], reason, ...(receipt ? { receipt, receiptBase: receipt.baseCommit } : {}),
  });
  const errors = parseTscErrors(input.tscOutput);
  const symbols = [...new Set(errors.flatMap((error) => error.symbols))].sort();
  if (errors.length === 0) return unmeasured('tsc output contains no parseable diagnostics');
  if (!SHA.test(input.headCommit) || !SHA.test(failBase)) return unmeasured('head or failed base is not a commit SHA');

  let registry: GateReceiptRegistry;
  try {
    registry = (deps.loadGateReceipts ?? (() => ({})))(input.receiptPath);
  } catch {
    return unmeasured('gate receipt registry could not be read');
  }
  const candidates = Object.values(registry).filter((entry) => entry.headCommit.toLowerCase() === input.headCommit.toLowerCase()
    && entry.verdict === 'passed'
    && entry.checks.some((check) => /typecheck/i.test(check) && /changed/i.test(check)));
  if (!candidates.length) return unmeasured('no same-head changed-file typecheck PASS receipt');

  const git = deps.git ?? defaultGit;
  let receipt: GateReceipt | undefined;
  let hasUnmeasurableBase = false;
  for (const candidate of candidates) {
    if (!SHA.test(candidate.baseCommit) || candidate.baseCommit.toLowerCase() === failBase.toLowerCase()) continue;
    try {
      const ancestry = git(['merge-base', '--is-ancestor', candidate.baseCommit, failBase], input.repo);
      if (ancestry.status === null || ancestry.status > 1) {
        hasUnmeasurableBase = true;
        continue;
      }
      if (ancestry.status !== 0) continue;
      const range = git(['rev-list', '--count', `${candidate.baseCommit}..${failBase}`], input.repo);
      if (range.status !== 0 || !/^\d+\s*$/.test(range.stdout)) {
        hasUnmeasurableBase = true;
        continue;
      }
      if (Number(range.stdout.trim()) < 1) continue;
      receipt = candidate;
      break;
    } catch {
      hasUnmeasurableBase = true;
    }
  }
  if (!receipt) {
    if (hasUnmeasurableBase) return unmeasured('base range has no measurable commits');
    if (candidates.every((candidate) => !SHA.test(candidate.baseCommit))) return unmeasured('receipt base is not a commit SHA', candidates[0]);
    if (candidates.every((candidate) => candidate.baseCommit.toLowerCase() === failBase.toLowerCase())) {
      return unmeasured('receipt base equals failed base', candidates[0]);
    }
    return unmeasured('no receipt has a measurable earlier base');
  }
  const common = { receipt, receiptBase: receipt.baseCommit, failBase, errors, symbols };

  let changed: DriftGitResult;
  let diff: DriftGitResult;
  try {
    changed = git(['diff', '--name-only', `${receipt.baseCommit}..${failBase}`], input.repo);
    diff = git(['diff', '--unified=0', `${receipt.baseCommit}..${failBase}`], input.repo);
  } catch {
    return { ...unmeasured('git could not measure the base range', receipt), ...common };
  }
  if (changed.status !== 0 || diff.status !== 0) return { ...unmeasured('git could not read the base diff', receipt), ...common };
  const changedFiles = [...new Set(changed.stdout.split(/\r?\n/).filter(Boolean))].sort();
  if (!changedFiles.length) return { ...unmeasured('base range has commits but no measurable changed files', receipt), ...common };

  const touchedExports = new Set<string>();
  for (const file of changedFiles) {
    let oldTree: DriftGitResult;
    let newTree: DriftGitResult;
    try {
      oldTree = git(['ls-tree', '-z', '--full-tree', receipt.baseCommit, '--', file], input.repo);
      newTree = git(['ls-tree', '-z', '--full-tree', failBase, '--', file], input.repo);
    } catch {
      return { ...unmeasured('git could not inspect changed-file presence', receipt), ...common };
    }
    if (oldTree.status !== 0 || newTree.status !== 0) {
      return { ...unmeasured('git could not inspect changed-file presence', receipt), ...common };
    }
    let before = '';
    let after = '';
    try {
      if (oldTree.stdout.length > 0) {
        const content = git(['show', `${receipt.baseCommit}:${file}`], input.repo);
        if (content.status !== 0) return { ...unmeasured('git could not read changed-file declarations', receipt), ...common };
        before = content.stdout;
      }
      if (newTree.stdout.length > 0) {
        const content = git(['show', `${failBase}:${file}`], input.repo);
        if (content.status !== 0) return { ...unmeasured('git could not read changed-file declarations', receipt), ...common };
        after = content.stdout;
      }
    } catch {
      return { ...unmeasured('git could not read changed-file declarations', receipt), ...common };
    }
    const oldDeclarations = exportedDeclarations(before);
    const newDeclarations = exportedDeclarations(after);
    for (const name of new Set([...oldDeclarations.keys(), ...newDeclarations.keys()])) {
      if (oldDeclarations.get(name) !== newDeclarations.get(name)) touchedExports.add(name);
    }
  }
  const errorFiles = new Set(errors.map((error) => error.file.replace(/^\.\//, '')));
  const fileTouched = changedFiles.some((file) => errorFiles.has(file.replace(/^\.\//, '')));
  const symbolTouched = errors.some((error) => error.symbols.some((symbol) => touchedExports.has(symbol)));
  const result: TypecheckDriftResult = { ...common, changedFiles, verdict: fileTouched || symbolTouched ? 'drift' : 'drift-unrelated' };
  if (result.verdict === 'drift-unrelated') result.reason = 'typecheck errors do not touch changed files or changed exports';
  return result;
}

export function planDriftRepair(input: RepairAttempt): RepairPlan {
  if (input.attemptsByHead >= 1 || input.attemptsByPr >= 2) {
    const reason = 'drift repair attempt limit reached';
    return { action: 'escalate', reason, mail: `오류 원문:\n${input.output}\n시도 머리: ${input.head}\n실패 base: ${input.failedBase}\n사유: ${reason}` };
  }
  if (input.result.verdict !== 'drift' || !input.result.receiptBase) return { action: 'skip', reason: input.result.reason ?? input.result.verdict };
  const boundaryFiles = [...new Set([...input.prFiles, ...input.result.errors.map((error) => error.file)])].sort();
  if (boundaryFiles.length === 0) return { action: 'skip', reason: 'repair boundary is empty' };
  const symbols = input.result.symbols.join(', ') || '(없음)';
  const goal = `대상 경로: ${boundaryFiles.join(' · ')}\n경계: ${boundaryFiles.join(' · ')}만 수정 · 오류 줄 ±20 · 시험 기대값 변경 금지 · 새 export 금지\n\n오류 원문:\n${input.output}\n바뀐 심볼: ${symbols}\n기준 main sha: ${input.failedBase}\n영수증 base sha: ${input.result.receiptBase}`;
  return { action: 'launch', goal, boundaryFiles };
}

export async function executeDriftPlan(plan: RepairPlan, mode: 'off' | 'shadow' | 'live', launch: DriftLaunch, escalate: DriftEscalate): Promise<void> {
  if (plan.action === 'launch' && mode === 'live') {
    await launch(plan.goal, plan.boundaryFiles);
    debug.log('pr.land', 'drift-repair-launched', { goalLength: plan.goal.length, boundaryFiles: plan.boundaryFiles });
  } else if (plan.action === 'launch') {
    debug.log('pr.land', mode === 'off' ? 'drift-repair-disabled' : 'drift-repair-planned', {
      goal: mode === 'shadow' ? plan.goal : undefined, goalLength: plan.goal.length, boundaryFiles: plan.boundaryFiles,
    });
  }
  if (plan.action === 'escalate') {
    escalate(plan.mail);
    debug.log('pr.land', 'drift-repair-escalated', { reason: plan.reason, mailLength: plan.mail.length });
  }
}
