import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawnElanousSync } from '../instance/spawn-elanous.js';
import { lastJsonObject } from '../graph-runner/runner.js';
import { boundaryMappingHash } from './boundary-proof-mapping.js';
import { parseGreenCloseEvidenceCommand, runGreenCloseEvidenceTest } from './green-close-recipe.js';

type Assertion = { path: string; equals: string | number | boolean };
type TestRun = { kind: 'test-run'; command: string };
type GraphRun = { kind: 'graph-run'; graphId: string; runId: string; nodeId: string; assertion: Assertion };
type CliJson = { kind: 'cli-json'; argv: string[]; assertion: Assertion };
export type BoundaryCheck = TestRun | GraphRun | CliJson;
export interface BoundaryProofInput {
  title: string; cellId: string; mainSha: string; mapRunId: string; cardId: string;
  graphRunId: string; stateRoot: string; repoRoot: string;
}
export interface BoundaryProofResult { outcome: 'pass' | 'hold'; reason: string; evidence: string[]; proofRef?: string }

const safeId = /^[A-Za-z0-9_-]{1,160}$/;
const sha = /^[a-f0-9]{40}$/i;
const safePath = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const safeGraphId = /^[A-Za-z0-9_-]+$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function assertion(value: unknown): Assertion | null {
  const raw = object(value);
  if (!raw || typeof raw.path !== 'string' || !safePath.test(raw.path)
    || !['string', 'number', 'boolean'].includes(typeof raw.equals)) return null;
  return { path: raw.path, equals: raw.equals as Assertion['equals'] };
}
function atPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) =>
    Array.isArray(current) && /^\d+$/.test(key) ? current[Number(key)] : object(current)?.[key], value);
}

/** Explicit finite mapping; prose alone never becomes executable shell. */
export function parseBoundaryChecks(title: string): BoundaryCheck[] | null {
  const line = /^\s*-?\s*완료 경계 실물 검증:\s*(.+)$/gm;
  const matches = [...title.matchAll(line)];
  if (matches.length !== 1) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(matches[0]![1]!); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) return null;
  const checks: BoundaryCheck[] = [];
  for (const value of parsed) {
    const check = object(value);
    if (!check) return null;
    if (check.kind === 'test-run' && typeof check.command === 'string'
      && parseGreenCloseEvidenceCommand(check.command).ok) {
      checks.push({ kind: 'test-run', command: check.command });
    } else if (check.kind === 'graph-run' && typeof check.graphId === 'string'
      && safeGraphId.test(check.graphId) && typeof check.runId === 'string' && safeId.test(check.runId)
      && typeof check.nodeId === 'string' && safeId.test(check.nodeId) && assertion(check.assertion)) {
      checks.push({ kind: 'graph-run', graphId: check.graphId, runId: check.runId,
        nodeId: check.nodeId, assertion: assertion(check.assertion)! });
    } else if (check.kind === 'cli-json' && Array.isArray(check.argv)
      && check.argv.every((arg) => typeof arg === 'string') && assertion(check.assertion)
      && allowedReadOnlyCli(check.argv as string[])) {
      checks.push({ kind: 'cli-json', argv: check.argv as string[], assertion: assertion(check.assertion)! });
    } else return null;
  }
  return checks;
}

/** A deliberately small set of read-only production CLI calls. */
export function allowedReadOnlyCli(argv: readonly string[]): boolean {
  if (argv.length !== 7 || argv[0] !== 'bun' || argv[1] !== 'bin/elanous.mjs'
    || argv[2] !== 'release' || argv[3] !== 'checklist' || argv[4] !== 'status'
    || argv[5] !== '--version' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(argv[6] ?? '')) return false;
  return true;
}

function checkGraphRun(input: BoundaryProofInput, check: GraphRun): boolean {
  const path = resolve(input.stateRoot, 'graph-runs', check.graphId, `${check.runId}.json`);
  const root = realpathSync(input.stateRoot);
  if (!realpathSync(path).startsWith(root + '/')) return false;
  const run = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const runInput = object(run.input);
  const main = object(runInput?.main);
  const node = Array.isArray(run.nodes) ? run.nodes.find((entry) => object(entry)?.nodeId === check.nodeId) : null;
  const output = object(node)?.output;
  const parsedOutput = typeof output === 'string' ? lastJsonObject(output) : output;
  return run.graphId === check.graphId && run.runId === check.runId && run.status === 'done'
    && runInput?.cellId === input.cellId && (runInput?.mainSha === input.mainSha || main?.sha === input.mainSha)
    && object(node)?.ok === true && object(node)?.exit === 0
    && atPath(parsedOutput, check.assertion.path) === check.assertion.equals;
}

function checkCliJson(input: BoundaryProofInput, check: CliJson): boolean {
  const run = spawnElanousSync(['--config-dir', input.stateRoot, ...check.argv.slice(2), '--json'], {
    bin: resolve(input.repoRoot, 'bin/elanous.mjs'), stateDir: input.stateRoot, cwd: input.repoRoot,
    timeout: 30_000, maxBuffer: 2_000_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.status !== 0) return false;
  return atPath(JSON.parse(String(run.stdout)), check.assertion.path) === check.assertion.equals;
}

function checkTestRun(input: BoundaryProofInput, check: TestRun): boolean {
  const command = parseGreenCloseEvidenceCommand(check.command);
  if (!command.ok) return false;
  const result = runGreenCloseEvidenceTest(input.repoRoot, input.mainSha, command.args);
  return result.reason === 'completion-command-passed' && result.exitCode === 0;
}

/** Produce one immutable receipt for this map card's current graph run. */
export function produceBoundaryProof(input: BoundaryProofInput): BoundaryProofResult {
  const hold = (detail: string): BoundaryProofResult => ({ outcome: 'hold', reason: 'boundary-unproven', evidence: [detail] });
  if (![input.cellId, input.mapRunId, input.cardId, input.graphRunId].every((id) => safeId.test(id))
    || !sha.test(input.mainSha) || !input.title.includes('완료 경계 실물:')
    || !isAbsolute(input.stateRoot) || !isAbsolute(input.repoRoot))
    return hold('Boundary identity, absolute state root, or live clause missing');
  const checks = parseBoundaryChecks(input.title);
  const mappingHash = boundaryMappingHash(input.title);
  if (!checks || !mappingHash) return hold('Live boundary has no supported, unambiguous verifier mapping');
  try {
    for (const check of checks) {
      const pass = check.kind === 'test-run' ? checkTestRun(input, check)
        : check.kind === 'graph-run' ? checkGraphRun(input, check) : checkCliJson(input, check);
      if (!pass) return hold(`${check.kind} did not prove the live boundary`);
    }
    const live = /^\s*-?\s*완료 경계 실물:\s*(.+)$/m.exec(input.title)?.[1]?.trim();
    if (!live) return hold('Live boundary line missing');
    const proofRef = `boundary-proofs/${input.cellId}/${input.graphRunId}.json`;
    const destination = resolve(input.stateRoot, proofRef);
    if (existsSync(destination)) return hold('Existing boundary proof cannot be reused');
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const stateRoot = realpathSync(input.stateRoot);
    if (!realpathSync(dirname(destination)).startsWith(stateRoot + '/'))
      return hold('Boundary proof directory escapes the state root');
    const temporary = `${destination}.${process.pid}.tmp`;
    const proof = { schema: 'green-close-boundary-proof/v1', producer: 'green-close-boundary-producer/v1',
      cellId: input.cellId, mainSha: input.mainSha, mapRunId: input.mapRunId, cardId: input.cardId,
      graphRunId: input.graphRunId, runId: input.graphRunId, liveBoundary: live,
      mappingHash,
      outcome: 'pass', exitCode: 0, checks: checks.map((check) => ({ kind: check.kind, outcome: 'pass' })) };
    try {
      writeFileSync(temporary, `${JSON.stringify(proof)}\n`, { flag: 'wx', mode: 0o600 });
      linkSync(temporary, destination); // atomic create; never replaces an existing receipt
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return { outcome: 'pass', reason: 'boundary-proof-produced', proofRef,
      evidence: [`${checks.length} live boundary verifier(s) passed for ${input.graphRunId}`] };
  } catch {
    return hold('Live verifier failed or immutable proof could not be written');
  }
}
