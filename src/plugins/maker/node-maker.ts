import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../../debug/log.js';
import { getNodeKindRegistration, listNodeKinds, unregisterPluginNodeKind } from '../../graph-kinds/registry.js';
import { loadPluginNodes } from '../../graph-kinds/plugin-nodes.js';
import { loadPluginManifestFromDir } from '../core/manifest.js';
import { codexWrite } from './plugin-maker.js';

export interface AddNodeOptions {
  dir: string;
  request: string;
  kind?: string;
  deps?: { codex: (dir: string, prompt: string) => Promise<void> };
}

export interface AddNodeResult {
  status: 'added' | 'failed';
  dir: string;
  kind: string;
  node: string;
  errors: string[];
  timings: { write: number; validate: number; repair?: number };
  version?: string;
}

const KIND = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function nodeErrors(dir: string, path: string, kind: string, manifest: ReturnType<typeof loadPluginManifestFromDir>['manifest']): string[] {
  const errors: string[] = [];
  let node: unknown;
  try {
    if (lstatSync(path).isSymbolicLink() || !realpathSync(path).startsWith(`${realpathSync(dir)}${sep}`)) {
      return ['unsafe node path'];
    }
    node = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) { return [`node YAML read/parse failed: ${String(error)}`]; }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return ['node must be an object'];
  const spec = node as Record<string, unknown>;
  if (spec.kind !== kind) errors.push(`node kind must be ${kind}`);
  if (spec.graph !== 'workflow') errors.push('node graph must be workflow');
  if (errors.length) return errors;
  // The loader is the same validation path used by plugin installation. Register under a
  // temporary identity so installed kinds cannot collide with this inspection.
  const inspectionId = `inspect-${randomUUID().replaceAll('-', '')}`;
  try {
    errors.push(...loadPluginNodes(dir, { ...manifest, id: inspectionId,
      contributes: { ...manifest.contributes, nodes: [`./nodes/${kind}.yaml`] } }).errors);
  } finally {
    for (const entry of listNodeKinds()) {
      if (entry.plugin !== inspectionId) continue;
      const registered = getNodeKindRegistration(entry.graph, entry.kind);
      if (registered) unregisterPluginNodeKind(entry.graph, entry.kind, inspectionId, registered);
    }
  }
  return errors;
}

export async function addNode({ dir: inputDir, request, kind: requestedKind, deps }: AddNodeOptions): Promise<AddNodeResult> {
  const dir = resolve(inputDir);
  const kind = requestedKind ?? request.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!request.trim() || !KIND.test(kind)) throw new Error(`invalid node request or kind: ${kind}`);
  const manifestFile = join(dir, 'plugin.json');
  if (!existsSync(manifestFile) || lstatSync(manifestFile).isSymbolicLink()) throw new Error(`plugin.json missing or unsafe: ${manifestFile}`);
  const { manifest } = loadPluginManifestFromDir(dir, { id: 'local-plugin' });
  const original = readFileSync(manifestFile);
  const raw: unknown = JSON.parse(original.toString('utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as Record<string, unknown>).version !== 'string'
    || !VERSION.test((raw as Record<string, unknown>).version as string)) throw new Error('plugin.json requires a numeric major.minor.patch version');
  const nodesDir = join(dir, 'nodes');
  const nodesEntry = lstatSync(nodesDir, { throwIfNoEntry: false });
  if (nodesEntry && !nodesEntry.isDirectory()) throw new Error(`unsafe nodes directory: ${nodesDir}`);
  const path = join(nodesDir, `${kind}.yaml`);
  if (lstatSync(path, { throwIfNoEntry: false }) || manifest.contributes.nodes?.some(node => node === `./nodes/${kind}.yaml`)) throw new Error(`node already exists: ${kind}`);
  const root = realpathSync(dir);
  for (const declared of manifest.contributes.nodes ?? []) {
    const declaredPath = resolve(dir, declared);
    const entry = lstatSync(declaredPath, { throwIfNoEntry: false });
    if (!entry) continue;
    if (!entry.isFile() || !realpathSync(declaredPath).startsWith(`${root}${sep}`)) {
      throw new Error(`unsafe declared node path: ${declared}`);
    }
    const spec: unknown = parseYaml(readFileSync(declaredPath, 'utf8'));
    if (spec && typeof spec === 'object' && !Array.isArray(spec)
      && (spec as Record<string, unknown>).kind === kind) throw new Error(`node already exists: ${kind}`);
  }
  const timings: AddNodeResult['timings'] = { write: 0, validate: 0 };
  const result: AddNodeResult = { status: 'failed', dir, kind, node: path, errors: [], timings };
  const step = async (stage: keyof typeof timings, action: () => void | Promise<void>): Promise<void> => {
    const start = performance.now();
    try { await action(); }
    finally { timings[stage] = Math.round(performance.now() - start); debug.log('plugin.node-maker', stage, { ms: timings[stage], errors: result.errors }); }
  };
  const prompt = `요청 원문:\n${request}\n\n이 플러그인에 workflow 노드 종류 ${kind} 하나만 작성하라. nodes/${kind}.yaml 파일만 작성하고 plugin.json 및 다른 파일은 변경하지 말 것. graph: workflow, kind: ${kind}, inputs: { type: object }, run: 의 bash/http/skill/mcp 중 정확히 하나를 정의하라. harness 노드 및 코드 실행기/다른 플러그인 파일은 만들지 말 것. 폴더 밖에는 쓰지 말 것.`;
  try {
    mkdirSync(nodesDir, { recursive: true });
    await step('write', () => (deps?.codex ?? codexWrite)(dir, prompt));
    const validate = () => {
      const entry = lstatSync(manifestFile, { throwIfNoEntry: false });
      if (!entry) { result.errors = ['plugin.json was deleted — restore it unchanged']; return; }
      result.errors = !entry.isSymbolicLink() && readFileSync(manifestFile).equals(original)
        ? nodeErrors(dir, path, kind, manifest) : ['plugin.json was modified'];
    };
    await step('validate', validate);
    if (result.errors.length) {
      await step('repair', () => (deps?.codex ?? codexWrite)(dir, `${prompt}\n\n아래 오류를 모두 수리하라:\n${result.errors.join('\n')}`));
      await step('validate', validate);
    }
    if (result.errors.length) return result;
    const data = raw as Record<string, unknown>;
    const [, major, minor, patch] = (data.version as string).match(VERSION)!;
    data.version = `${major}.${minor}.${BigInt(patch!) + 1n}`;
    const extension = (data.extensions as Record<string, unknown> | undefined)?.['ai.elanous'];
    if (extension && typeof extension === 'object' && !Array.isArray(extension)) {
      const entry = extension as Record<string, unknown>;
      entry.nodes = [...(manifest.contributes.nodes ?? []), `./nodes/${kind}.yaml`];
    } else {
      const contributes = (data.contributes ??= {}) as Record<string, unknown>;
      contributes.nodes = [...(manifest.contributes.nodes ?? []), `./nodes/${kind}.yaml`];
    }
    writeFileSync(manifestFile, JSON.stringify(data, null, 2) + '\n');
    result.version = data.version as string;
    result.status = 'added';
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (result.status === 'failed') {
      try {
        if (lstatSync(manifestFile, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(manifestFile);
        if (!existsSync(manifestFile) || !readFileSync(manifestFile).equals(original)) writeFileSync(manifestFile, original);
      } catch (error) {
        result.errors.push(`plugin.json restoration failed: ${String(error)}`);
      }
    }
  }
  return result;
}
