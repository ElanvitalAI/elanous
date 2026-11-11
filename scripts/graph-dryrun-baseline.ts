#!/usr/bin/env bun
/**
 * Measure the five GRAPH-RUNNER-V2 v1 zero-regression contracts.
 * Usage: bun scripts/graph-dryrun-baseline.ts [--root <checkout>] [--only-graph <path>] [--output <json>] [--compare <baseline.json>]
 * Tests are read-only: graph runs use dryRun with a fresh temporary state root.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface DeclarationRow { path: string; kind: 'unit' | 'graph' | 'unclassified'; kinds: string[]; exits: string[]; errors: unknown[]; canonical: string | null; hash: string | null }
interface GraphRunRow { path: string; kind: 'graph'; rc: number; terminal: string; runPath: string[]; failureReason: string | null }
interface WorkflowRow { path: string; rc: number; valid: boolean; errors: unknown[] }
const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1] ?? fallback;
}
const root = resolve(option('--root', process.cwd()));
const output = option('--output', '');
const compare = option('--compare', '');
const onlyGraph = option('--only-graph', '');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [relative(root, path)] : [];
  });
}
const tracked = walk(root).sort();
const graphPaths = tracked.filter(path =>
  /\.ya?ml$/i.test(path) && (/^graphs\//.test(path) || /^plugins\/[^/]+\/(?:graphs|graph)\//.test(path)));
const selectedGraphPaths = onlyGraph ? graphPaths.filter(path => path === onlyGraph) : graphPaths;
if (onlyGraph && selectedGraphPaths.length !== 1) {
  throw new Error(`--only-graph must select exactly one inventoried graph path: ${onlyGraph}`);
}
const workflowPaths = tracked.filter(path => /\.(?:ya?ml|json)$/i.test(path)
  && (/^samples\/workflows\//.test(path) || /^workflows\//.test(path)));

const moduleAt = async <T>(path: string): Promise<T> => import(pathToFileURL(join(root, path)).href) as Promise<T>;
const graphYaml = await moduleAt<typeof import('../src/self-implement/graph-yaml.js')>('src/self-implement/graph-yaml.ts');
const { runGraph } = await moduleAt<typeof import('../src/graph-runner/runner.js')>('src/graph-runner/runner.ts');
const { listLoops } = await moduleAt<typeof import('../src/loops/registry.js')>('src/loops/registry.ts');
const workflow = await moduleAt<typeof import('../src/workflow-runtime/parser.js')>('src/workflow-runtime/parser.ts');

const tempState = mkdtempSync(join(tmpdir(), 'graph-dryrun-baseline-'));
function normalize(value: unknown): Json {
  const aliases = (path: string) => [path, path.startsWith('/private/') ? path.slice('/private'.length) : `/private${path}`]
    .sort((a, b) => b.length - a.length);
  if (typeof value === 'string') {
    const rooted = aliases(root).reduce((text, path) => text.replaceAll(path, '<ROOT>'), value);
    return aliases(tempState).reduce((text, path) => text.replaceAll(path, '<STATE>'), rooted);
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  return value as Json;
}
function firstDifference(a: unknown, b: unknown, path = '$'): { path: string; base: unknown; head: unknown } | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const difference = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (difference) return difference;
    }
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const difference = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (difference) return difference;
    }
  }
  return { path, base: a, head: b };
}
try {
  const declarations: DeclarationRow[] = [];
  const runs: GraphRunRow[] = [];
  for (const path of selectedGraphPaths) {
    const source = readFileSync(join(root, path), 'utf8');
    let raw: Record<string, unknown> | null = null;
    let yamlError: string | null = null;
    try {
      const parsedYaml = Bun.YAML.parse(source) as unknown;
      if (parsedYaml && typeof parsedYaml === 'object' && !Array.isArray(parsedYaml)) raw = parsedYaml as Record<string, unknown>;
    } catch (error) {
      yamlError = error instanceof Error ? error.message : String(error);
    }
    const unit = !!raw && typeof raw === 'object' && !!raw.unit;
    // Preserve declaration intent even when required fields have invalid types: the
    // parser must report those errors instead of silently excluding the file.
    const entry = !unit && (!!raw && ('graph_id' in raw || 'nodes' in raw) || yamlError !== null);
    // Recipes, catalogues and fixtures are inventory inputs, not graph declarations.
    const parsed = unit || entry
      ? graphYaml.parseGraphTemplateYaml(source, path.split('/').at(-1)!)
      : { errors: yamlError ? [{ path, message: yamlError }] : [], template: null };
    const kinds = [...new Set(parsed.template?.nodes.map(node => node.kind) ?? [])].sort();
    const exits = [...new Set([...(parsed.template?.unit?.exits ?? []), ...(parsed.template?.terminalNodes ?? [])])].sort();
    declarations.push({ path, kind: unit ? 'unit' : entry ? 'graph' : 'unclassified', kinds, exits,
      errors: [...(parsed.errors ?? [])], canonical: parsed.template ? graphYaml.canonicalGraphJson(parsed.template) : null,
      hash: parsed.template ? graphYaml.graphVersionHash(parsed.template) : null });
    if (entry && !unit) {
      try {
        const state = await runGraph(join(root, path), { dryRun: true, quiet: true, deps: { root: tempState } });
        runs.push({ path, kind: 'graph', rc: state.status === 'done' || state.status === 'awaiting-approval' ? 0 : 1, terminal: state.status,
          runPath: state.path, failureReason: state.reason ?? state.nodes.find(n => n.error)?.error ?? null });
      } catch (error) {
        runs.push({ path, kind: 'graph', rc: 1, terminal: 'threw', runPath: [], failureReason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const workflows: WorkflowRow[] = [];
  for (const path of workflowPaths) {
    const source = readFileSync(join(root, path), 'utf8');
    try {
      const result = workflow.parseWorkflowYaml(source);
      workflows.push({ path, rc: result.ok ? 0 : 1, valid: result.ok, errors: result.issues });
    } catch (error) {
      workflows.push({ path, rc: 1, valid: false, errors: [error instanceof Error ? error.message : String(error)] });
    }
  }

  const loopRows = listLoops({ root, stateRoot: tempState, schedules: [], config: {} as never });
  const loops = loopRows.map(row => ({ id: row.id, trigger: row.trigger, file: row.file })).sort((a, b) => a.id.localeCompare(b.id));
  const declarationsOnly = declarations.filter(row => row.kind !== 'unclassified' || row.errors.length > 0);
  const gitStatus = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
  const workingTreeStatus = gitStatus.status === 0 ? gitStatus.stdout.trim() : 'unavailable';
  const result = {
    schema: 'graph-dryrun-baseline/v1',
    revision: option('--revision', spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'unknown'),
    workingTree: { dirty: workingTreeStatus !== '' && workingTreeStatus !== 'unavailable', status: workingTreeStatus },
    ...(workingTreeStatus === 'unavailable' ? { warning: 'working-tree status unavailable' }
      : workingTreeStatus ? { warning: 'working tree is dirty; status is recorded' } : {}),
    measuredAt: new Date().toISOString(),
    measurement: 'bun scripts/graph-dryrun-baseline.ts --root <checkout> [--output <json>]',
    fiveConditions: normalize({
      declarationErrors: declarationsOnly.map(({ path, errors }) => ({ path, errors })),
      canonicalAndHash: declarationsOnly.map(({ path, canonical, hash }) => ({ path, canonical, hash })),
      dryRun: runs,
      loops,
      workflowValidation: workflows,
    }),
    inventory: normalize({ graphs: declarations, graphRuns: runs, workflows, loops }),
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (output) await Bun.write(resolve(root, output), json);
  else process.stdout.write(json);
  if (compare) {
    const baseline = JSON.parse(readFileSync(resolve(compare), 'utf8')) as { fiveConditions?: unknown };
    const baselineConditions = baseline.fiveConditions as Record<string, unknown> | undefined;
    const currentConditions = result.fiveConditions as Record<string, unknown>;
    const changed = Object.keys(currentConditions).filter(key => JSON.stringify(baselineConditions?.[key]) !== JSON.stringify(currentConditions[key]));
    const same = changed.length === 0;
    const brief = (value: unknown) => JSON.stringify(value)?.slice(0, 1400) ?? String(value);
    const detail = changed.map(key => {
      const difference = firstDifference(baselineConditions?.[key], currentConditions[key]);
      return `${key}@${difference?.path} base=${brief(difference?.base)} head=${brief(difference?.head)}`;
    }).join('; ');
    console.log(`GRAPH-DRYRUN-BASELINE ${same ? 'same' : `changed: ${detail}`} · ${compare}`);
    if (!same) process.exitCode = 1;
  }
} finally {
  rmSync(tempState, { recursive: true, force: true });
}
