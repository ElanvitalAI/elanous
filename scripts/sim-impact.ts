#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildClosureGraph, gitClosureTree, type ClosureTree } from './release-loop/gate-closure.js';
import { goalTargetPaths, hasCodeTarget, simulationProofFromGoal, unresolvedGoalTargets } from '../src/self-dev/sim-impact-wording.js';

export interface PullRequestFile {
  filename: string;
  status?: string;
  patch?: string;
}

export interface PullRequestSnapshot {
  number: number;
  title: string;
  baseSha: string;
  headSha: string;
  files: PullRequestFile[];
}

export interface GraphPathEvidence {
  scenarioId: string;
  runId: string;
  entryPoint: string;
  events: Array<{ event: string; path?: string[]; from?: string; taken?: string; guardId?: string }>;
}

export interface SimImpactReport {
  pullRequest: { number: number; title: string; baseSha: string; headSha: string };
  changedFiles: string[];
  reverseImportClosure: string[];
  entryPoints: string[];
  graphCallers: string[];
  guards: Array<{ id: string; file: string; description: string }>;
  scenarioDefinitions: Array<{ id: string; file: string; references: string[] }>;
  verifiedScenarios: Array<{ id: string; runId: string; entryPoint: string; guardId: string }>;
  gaps: string[];
}

export interface SimImpactDependencies {
  repositoryRoot: string;
  loadPullRequest(number: number): Promise<PullRequestSnapshot>;
  loadTree(commit: string): ClosureTree;
  readFileAtCommit(commit: string, path: string): string | undefined;
  loadPathEvidence(path?: string): GraphPathEvidence[];
}

export interface GoalImpactReport {
  goalPath: string;
  targets: string[];
  unresolvedTargets: string[];
  reverseImportClosure: string[];
  entryPoints: string[];
  graphCallers: string[];
  guardTargets: string[];
  proofScenario?: string;
  scenarioDefinitions: Array<{ id: string; file: string }>;
  gaps: string[];
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SCENARIO_FILE = /^scenarios\/ux-sim\/.*\.ya?ml$/;
const MISSING_SCENARIO_GAP = '공백: 게이트 진입 가드 · 밟는 시나리오 없음';

function requireSuccess(result: ReturnType<typeof spawnSync>, command: string): string {
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? result.error ?? '').trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout);
}

function ghJson<T>(args: string[], repositoryRoot: string): T {
  const result = spawnSync('gh', ['api', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  return JSON.parse(requireSuccess(result, 'gh api')) as T;
}

function systemDependencies(repositoryRoot = process.cwd()): SimImpactDependencies {
  return {
    repositoryRoot,
    async loadPullRequest(number) {
      const base = ghJson<{ title: string; base: { sha: string }; head: { sha: string } }>(
        [`repos/ElanvitalAI/elanous/pulls/${number}`], repositoryRoot,
      );
      const pages = ghJson<PullRequestFile[][]>(
        ['--paginate', '--slurp', `repos/ElanvitalAI/elanous/pulls/${number}/files?per_page=100`], repositoryRoot,
      );
      return { number, title: base.title, baseSha: base.base.sha, headSha: base.head.sha, files: pages.flat() };
    },
    loadTree: (commit) => gitClosureTree(repositoryRoot, commit),
    readFileAtCommit(commit, path) {
      const result = spawnSync('git', ['show', `${commit}:${path}`], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 15_000,
      });
      if (result.status !== 0 || result.error) return undefined;
      return String(result.stdout);
    },
    loadPathEvidence(path) {
      if (!path) return [];
      const parsed: unknown = JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('graph path evidence must be a JSON array');
      return parsed as GraphPathEvidence[];
    },
  };
}

export function parseArgs(args: string[]): { pullRequest: number; json: boolean; evidencePath?: string } {
  let pullRequest: number | undefined;
  let json = false;
  let evidencePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json') { json = true; continue; }
    if (arg !== '--pr' && arg !== '--event-evidence') throw new Error(`unknown argument: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
    if (arg === '--pr') {
      if (pullRequest !== undefined) throw new Error('--pr may be supplied once');
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error('--pr must be a positive PR number');
      pullRequest = Number(value);
    } else {
      if (evidencePath !== undefined) throw new Error('--event-evidence may be supplied once');
      evidencePath = value;
    }
    index += 1;
  }
  if (pullRequest === undefined) throw new Error('--pr <number> is required');
  return { pullRequest, json, ...(evidencePath ? { evidencePath } : {}) };
}

function reverseClosure(changedFiles: readonly string[], tree: ClosureTree): string[] {
  const { staticImports } = buildClosureGraph(tree);
  const reverse = new Map<string, string[]>();
  for (const [importer, dependencies] of staticImports) {
    for (const dependency of dependencies) {
      const importers = reverse.get(dependency) ?? [];
      importers.push(importer);
      reverse.set(dependency, importers);
    }
  }
  const reached = new Set<string>();
  const pending = changedFiles.filter((file) => tree.files.includes(file));
  while (pending.length) {
    const file = pending.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    pending.push(...(reverse.get(file) ?? []));
  }
  return [...reached].sort();
}

function addedLines(patch: string | undefined): string[] {
  return (patch ?? '').split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
}

function guardsIn(file: PullRequestFile): SimImpactReport['guards'] {
  const additions = addedLines(file.patch).join('\n');
  if (!CODE_FILE.test(file.filename) || file.filename.endsWith('.test.ts')) return [];
  // A missing patch is not evidence that the file contains no guard. Report the uncertainty.
  if (!file.patch) return [{ id: `unknown:${file.filename}`, file: file.filename, description: 'guard analysis unavailable: PR patch is missing' }];
  const imagePinGuard = file.filename === 'scripts/release-loop/gate-node.ts'
    && additions.includes('image-pin-unscoped') && additions.includes('fail-closed');
  const failClosedGuard = /(?:throw\s+new\s+Error|return\s+(?:false|null)|process\.exit\s*\()/.test(additions)
    && /(?:guard|reject|refus|fail|deny|invalid|unscoped|missing|required|unavailable)/i.test(additions);
  const hasFailureBranch = /(?:throw\s+new\s+Error|return\s+(?:false|null)|process\.exit\s*\()/.test(additions);
  if (!imagePinGuard && !failClosedGuard && !hasFailureBranch) return [];
  return [{
    id: imagePinGuard ? 'release-loop.gate.image-pin-unscoped' : `changed-guard:${file.filename}`,
    file: file.filename,
    description: imagePinGuard
      ? 'production Pod gate requires graph or rehearsal scope and a cut-commit image pin before pool probes'
      : 'changed fail-closed branch requires simulator-path coverage',
  }];
}

function scenarioDefinitions(tree: ClosureTree, changedFiles: readonly string[]): SimImpactReport['scenarioDefinitions'] {
  const code = changedFiles.filter((file) => CODE_FILE.test(file));
  return tree.files.filter((file) => SCENARIO_FILE.test(file)).flatMap((file) => {
    const text = tree.read(file);
    if (text === undefined) return [];
    const references = code.filter((changed) => text.includes(changed));
    if (!references.length) return [];
    const id = /^\s*id:\s*([^\s#]+)/m.exec(text)?.[1]
      ?? /^\s*kind:\s*([^\s#]+)/m.exec(text)?.[1]
      ?? file;
    return [{ id, file, references }];
  }).sort((left, right) => left.file.localeCompare(right.file));
}

export function analyzeGoalImpact(goalPath: string, text: string, tree: ClosureTree): GoalImpactReport {
  const targets = goalTargetPaths(text, tree.files);
  const unresolvedTargets = unresolvedGoalTargets(text, tree.files);
  const reverseImportClosure = reverseClosure(targets, tree);
  const affected = new Set([...targets, ...reverseImportClosure]);
  const entryPoints = reverseImportClosure.filter((file) => {
    const source = tree.read(file) ?? '';
    return /\bimport\.meta\.main\b/.test(source) || /^#!.*\bbun\b/m.test(source);
  }).sort();
  const graphCallers = tree.files.filter((file) => file.startsWith('graphs/') && /\.ya?ml$/.test(file))
    .filter((file) => [...affected].some((path) => (tree.read(file) ?? '').includes(path))).sort();
  const guardTargets = /(?:가드|guard|진입점|entrypoint)/i.test(text) ? targets : [];
  const proofScenario = simulationProofFromGoal(text);
  const definitions = scenarioDefinitions(tree, targets).map(({ id, file }) => ({ id, file }));
  const proofFound = proofScenario && definitions.some((scenario) => scenario.id === proofScenario || scenario.file === proofScenario);
  const newDevice = proofScenario?.startsWith('신설 장치:') ?? false;
  const hasCodeImpact = hasCodeTarget([...targets, ...unresolvedTargets]);
  const gaps = [
    ...unresolvedTargets.map((path) => `공백: 대상 경로를 저장소에서 찾을 수 없음 · ${path}`),
    ...(!targets.length && !unresolvedTargets.length && !newDevice
      ? ['공백: 대상 코드 경로 없음 · 시뮬 영향 판정 불가']
      : []),
    ...(hasCodeImpact && !proofScenario && !newDevice
      ? ['공백: 시뮬 월드 미고려 · 증명 시나리오 없음']
      : []),
    ...(hasCodeImpact && proofScenario && !proofFound && !newDevice
      ? [`공백: 증명 시나리오를 찾을 수 없음 · ${proofScenario}`]
      : []),
  ];
  return {
    goalPath,
    targets,
    unresolvedTargets,
    reverseImportClosure,
    entryPoints,
    graphCallers,
    guardTargets,
    ...(proofScenario ? { proofScenario } : {}),
    scenarioDefinitions: definitions,
    gaps,
  };
}

export function formatGoalImpact(report: GoalImpactReport, json = false): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  return [
    `골: ${report.goalPath}`,
    `대상 코드: ${report.targets.join(', ') || '없음'}`,
    `import 역폐쇄: ${report.reverseImportClosure.join(', ') || '없음'}`,
    `진입점: ${report.entryPoints.join(', ') || '없음'}`,
    `그래프 호출자: ${report.graphCallers.join(', ') || '없음'}`,
    `가드 대상: ${report.guardTargets.join(', ') || '없음'}`,
    `증명 시나리오: ${report.proofScenario ?? '없음'}`,
    ...report.gaps,
  ].join('\n') + '\n';
}

export function runSimImpactGoalCli(
  args: string[],
  dependencies: { repositoryRoot: string; readGoal(path: string): string; loadTree(): ClosureTree },
  write: (text: string) => void = (text) => process.stdout.write(text),
): GoalImpactReport {
  let goalPath: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json') { json = true; continue; }
    if (arg !== '--goal' || goalPath !== undefined) throw new Error(`unknown or repeated argument: ${arg}`);
    goalPath = args[index + 1];
    if (!goalPath || goalPath.startsWith('-')) throw new Error('--goal requires a file path');
    index += 1;
  }
  if (!goalPath) throw new Error('--goal <path> is required');
  const absolutePath = resolve(dependencies.repositoryRoot, goalPath);
  const report = analyzeGoalImpact(goalPath, dependencies.readGoal(absolutePath), dependencies.loadTree());
  write(formatGoalImpact(report, json));
  return report;
}

function verifiedScenarios(
  guards: SimImpactReport['guards'],
  graphNodeIdsByGuard: ReadonlyMap<string, ReadonlySet<string>>,
  scenarios: SimImpactReport['scenarioDefinitions'],
  evidence: readonly GraphPathEvidence[],
): SimImpactReport['verifiedScenarios'] {
  if (guards.length === 0) return [];
  const scenarioIds = new Set(scenarios.map((scenario) => scenario.id));
  return evidence.filter((entry) => entry.entryPoint === 'graph'
    && scenarioIds.has(entry.scenarioId)
    && typeof entry.scenarioId === 'string'
    && typeof entry.runId === 'string'
    && entry.events.some((event) => event.event === 'graph.path'
      && typeof event.guardId === 'string'
      && guards.some((guard) => guard.id === event.guardId
        && [event.from, event.taken, ...(event.path ?? [])].some((node) => node !== undefined
          && graphNodeIdsByGuard.get(guard.id)?.has(node))))
  )
    .flatMap((entry) => entry.events.filter((event) => event.event === 'graph.path'
      && typeof event.guardId === 'string' && guards.some((guard) => guard.id === event.guardId
        && [event.from, event.taken, ...(event.path ?? [])].some((node) => node !== undefined
          && graphNodeIdsByGuard.get(guard.id)?.has(node))))
      .map((event) => ({ id: entry.scenarioId, runId: entry.runId, entryPoint: entry.entryPoint, guardId: event.guardId! })))
    .sort((left, right) => left.id.localeCompare(right.id) || left.runId.localeCompare(right.runId));
}

function graphNodesForFiles(tree: ClosureTree, guards: SimImpactReport['guards']): Map<string, Set<string>> {
  const nodes = new Map(guards.map((guard) => [guard.id, new Set<string>()]));
  for (const file of tree.files.filter((path) => path.startsWith('graphs/') && /\.ya?ml$/.test(path))) {
    const lines = (tree.read(file) ?? '').split(/\r?\n/);
    let current: string | undefined;
    for (const line of lines) {
      const id = /^([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (id) current = id[1];
      if (current) for (const guard of guards) if (line.includes(guard.file)) nodes.get(guard.id)!.add(current);
    }
  }
  return nodes;
}

export function analyzeSimImpact(
  pr: PullRequestSnapshot,
  tree: ClosureTree,
  evidence: readonly GraphPathEvidence[] = [],
): SimImpactReport {
  const changedFiles = [...new Set(pr.files.map((file) => file.filename))].sort();
  const reverseImportClosure = reverseClosure(changedFiles.filter((file) => CODE_FILE.test(file)), tree);
  const entryPoints = reverseImportClosure.filter((file) => {
    const source = tree.read(file) ?? '';
    return /\bimport\.meta\.main\b/.test(source) || /^#!.*\bbun\b/m.test(source);
  }).sort();
  const affectedFiles = new Set([...changedFiles, ...reverseImportClosure, ...entryPoints]);
  const graphCallers = tree.files.filter((file) => file.startsWith('graphs/') && /\.ya?ml$/.test(file))
    .filter((file) => [...affectedFiles].some((affected) => (tree.read(file) ?? '').includes(affected)))
    .sort();
  const guards = pr.files.flatMap(guardsIn);
  const definitions = scenarioDefinitions(tree, changedFiles);
  const graphNodeIds = graphNodesForFiles(tree, guards);
  const verified = verifiedScenarios(guards, graphNodeIds, definitions, evidence);
  const uncoveredGuards = guards.filter((guard) => !verified.some((scenario) => scenario.guardId === guard.id
    && definitions.some((definition) => definition.id === scenario.id && definition.references.includes(guard.file))));
  const gaps = uncoveredGuards.map((guard) => uncoveredGuards.length === 1
    ? MISSING_SCENARIO_GAP
    : `${MISSING_SCENARIO_GAP} [${guard.id}]`);
  return {
    pullRequest: { number: pr.number, title: pr.title, baseSha: pr.baseSha, headSha: pr.headSha },
    changedFiles,
    reverseImportClosure,
    entryPoints,
    graphCallers,
    guards,
    scenarioDefinitions: definitions,
    verifiedScenarios: verified,
    gaps,
  };
}

function humanReport(report: SimImpactReport): string {
  const lines = [
    `PR #${report.pullRequest.number}: ${report.pullRequest.title}`,
    `변경 파일: ${report.changedFiles.length} · import 역폐쇄: ${report.reverseImportClosure.length}`,
    `진입점: ${report.entryPoints.join(', ') || '없음'}`,
    `그래프 호출자: ${report.graphCallers.join(', ') || '없음'}`,
    `가드: ${report.guards.map((guard) => `${guard.id} (${guard.file})`).join(', ') || '없음'}`,
    `시나리오 정의: ${report.scenarioDefinitions.map((scenario) => `${scenario.id} (${scenario.file}; 참조만 확인)`).join(', ') || '없음'}`,
    `graph.path 증거 시나리오: ${report.verifiedScenarios.map((scenario) => `${scenario.id} [${scenario.runId}]`).join(', ') || '없음'}`,
    ...report.gaps,
  ];
  return `${lines.join('\n')}\n`;
}

export async function runSimImpactCli(
  args: string[],
  dependencies: SimImpactDependencies = systemDependencies(),
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<SimImpactReport> {
  const options = parseArgs(args);
  const pr = await dependencies.loadPullRequest(options.pullRequest);
  if (pr.number !== options.pullRequest) throw new Error(`PR source returned #${pr.number} for #${options.pullRequest}`);
  let tree: ClosureTree;
  try {
    tree = dependencies.loadTree(pr.headSha);
  } catch (error) {
    throw new Error(`cannot read PR head ${pr.headSha}; fetch the PR head into this checkout and retry (${String(error)})`);
  }
  const analysisTree: ClosureTree = {
    ...tree,
    read: (path) => tree.read(path) ?? dependencies.readFileAtCommit(pr.headSha, path),
  };
  const evidence = dependencies.loadPathEvidence(options.evidencePath);
  const report = analyzeSimImpact(pr, analysisTree, evidence);
  write(options.json ? `${JSON.stringify(report, null, 2)}\n` : humanReport(report));
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const repositoryRoot = process.cwd();
  const run = args.includes('--goal')
    ? Promise.resolve().then(() => runSimImpactGoalCli(args, {
      repositoryRoot,
      readGoal: (path) => readFileSync(path, 'utf8'),
      loadTree: () => {
        const commit = requireSuccess(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }), 'git rev-parse HEAD').trim();
        return gitClosureTree(repositoryRoot, commit);
      },
    }))
    : runSimImpactCli(args);
  run.catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
