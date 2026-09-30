import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { debug } from '../../debug/log.js';
import { runGraph } from '../../graph-runner/runner.js';
import { parseGraphTemplateYaml } from '../../self-implement/graph-yaml.js';
import { installPlugin } from '../install/plugin-install.js';

const CAPABILITIES = ['fs:workdir', 'proc:bun', 'proc:elanous'];
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export interface MakePluginDeps {
  codex: (dir: string, prompt: string) => Promise<void>;
  install?: typeof installPlugin;
  runGraph?: typeof runGraph;
}
export interface MakePluginOptions {
  request: string;
  name?: string;
  parentDir?: string;
  run?: boolean;
  input?: unknown;
  deps?: MakePluginDeps;
}
export interface MakePluginResult {
  status: 'installed' | 'ran' | 'failed';
  dir: string;
  plugin: string;
  graph: string;
  errors: string[];
  runStatus?: Awaited<ReturnType<typeof runGraph>>['status'];
  timings: { scaffold: number; write: number; validate: number; repair?: number; install: number; run?: number };
}

export async function codexWrite(dir: string, prompt: string): Promise<void> {
  const child = Bun.spawn(['codex', 'exec', '-C', dir, '-s', 'workspace-write', '--skip-git-repo-check', '-o', join(dir, '.codex-last-message.txt'), prompt], {
    cwd: dir, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`codex exec failed (${code}): ${stderr.trim().slice(0, 500)}`);
}

function scaffold(dir: string, slug: string, request: string): void {
  mkdirSync(join(dir, 'graphs'));
  mkdirSync(join(dir, 'examples'));
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: slug, version: '0.1.0', description: request,
    extensions: { 'ai.elanous': { graphs: [`./graphs/${slug}.yaml`], capabilities: CAPABILITIES } } }, null, 2) + '\n');
  writeFileSync(join(dir, 'graphs', `${slug}.yaml`), `graph_id: ${slug}\nversion: 1\nentry_node: main\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: main, kind: agent, recipe: 'cmd:main', max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: main, on: outcome, map: { ok: done, fail: failed } }\n`);
  writeFileSync(join(dir, 'graphs', 'recipes.yaml'), `main:\n  command: 'bun "$ELANOUS_GRAPH_DIR/run-step.ts" main'\n  timeout_ms: 120000\n`);
  writeFileSync(join(dir, 'graphs', 'run-step.ts'), `import { readFileSync } from 'node:fs';\nconst context = JSON.parse(readFileSync(process.env.ELANOUS_GRAPH_CONTEXT!, 'utf8'));\nconsole.log(JSON.stringify({ outcome: 'ok', input: context.input }));\n`);
  writeFileSync(join(dir, 'examples', 'input.json'), '{}\n');
  writeFileSync(join(dir, 'README.md'), `# ${slug}\n\n${request}\n\nRun the installed graph with examples/input.json as input. No messages are sent.\n`);
}

function inside(dir: string, path: string): string | undefined {
  const full = resolve(dir, path);
  return full.startsWith(`${dir}${sep}`) ? full : undefined;
}

function realTarget(path: string): string {
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const next = dirname(ancestor);
    if (next === ancestor) throw new Error(`cannot resolve plugin directory: ${path}`);
    ancestor = next;
  }
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}

function assertLocalParent(parent: string): void {
  const repoPlugins = realpathSync(resolve(import.meta.dir, '../../../plugins'));
  const target = realTarget(parent);
  if (target === repoPlugins || target.startsWith(`${repoPlugins}${sep}`)) {
    throw new Error('repository plugins/ is not a local plugin directory');
  }
}

export async function validatePluginDir(dir: string): Promise<string[]> {
  const errors: string[] = [];
  let manifest: unknown;
  try {
    const file = join(dir, 'plugin.json');
    if (lstatSync(file).isSymbolicLink()) errors.push('안전하지 않은 plugin.json 링크');
    else manifest = JSON.parse(readFileSync(file, 'utf8'));
  }
  catch (error) { errors.push(`plugin.json 파싱 실패: ${String(error)}`); }
  const extension = isRecord(manifest) && isRecord(manifest.extensions) ? manifest.extensions['ai.elanous'] : undefined;
  const graphs = isRecord(extension) ? extension.graphs : undefined;
  if (isRecord(extension) && extension.contributes !== undefined) errors.push('extension contributes 덮어쓰기 금지');
  if (!isRecord(manifest) || typeof manifest.name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(manifest.name) || typeof manifest.version !== 'string') errors.push('plugin.json 이름/버전 오류');
  if (isRecord(manifest) && (manifest.capabilities !== undefined || manifest.contributes !== undefined || manifest.main !== undefined)) errors.push('plugin.json 최상위 권한/기여/main 덮어쓰기 금지');
  if (!isRecord(extension) || !Array.isArray(extension.capabilities) || JSON.stringify(extension.capabilities) !== JSON.stringify(CAPABILITIES)) {
    errors.push('capabilities 는 ["fs:workdir","proc:bun","proc:elanous"] 이어야 한다');
  }
  if (!Array.isArray(graphs) || graphs.length === 0 || !graphs.every(g => typeof g === 'string')) errors.push('plugin.json graphs 경로 없음');
  let recipes: unknown;
  try {
    const file = join(dir, 'graphs', 'recipes.yaml');
    if (lstatSync(file).isSymbolicLink()) errors.push('안전하지 않은 recipes.yaml 링크');
    else recipes = parseYaml(readFileSync(file, 'utf8'));
  }
  catch (error) { errors.push(`recipes.yaml 파싱 실패: ${String(error)}`); }
  if (!isRecord(recipes)) errors.push('recipes.yaml 은 맵이어야 한다');
  else for (const [id, recipe] of Object.entries(recipes)) {
    if (!isRecord(recipe) || typeof recipe.command !== 'string' || !recipe.command.trim() ||
      (recipe.timeout_ms !== undefined && (!Number.isSafeInteger(recipe.timeout_ms) || Number(recipe.timeout_ms) <= 0))) errors.push(`잘못된 recipe: ${id}`);
  }
  for (const graph of Array.isArray(graphs) ? graphs : []) {
    if (typeof graph !== 'string') continue;
    const file = inside(dir, graph);
    if (!file || !/^\.\/graphs\/[a-zA-Z0-9_-]+\.ya?ml$/.test(graph)) { errors.push(`안전하지 않은 graph 경로: ${graph}`); continue; }
    try {
      if (lstatSync(file).isSymbolicLink()) { errors.push(`안전하지 않은 graph 링크: ${graph}`); continue; }
      const parsed = parseGraphTemplateYaml(readFileSync(file, 'utf8'), file);
      errors.push(...parsed.errors.map(issue => `${issue.path}: ${issue.message}`));
      const template = parsed.template;
      if (!template) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(template.graphId)) errors.push(`잘못된 graph_id: ${template.graphId}`);
      if (template.terminalNodes.length !== 2 || !template.terminalNodes.includes('done') || !template.terminalNodes.includes('failed')) errors.push('terminal_nodes 는 done, failed 이어야 한다');
      const executionNodes = template.nodes.filter(node => !template.terminalNodes.includes(node.nodeId));
      if (executionNodes.length < 2 || executionNodes.length > 6) errors.push(`실행 노드는 2~6개여야 한다: ${executionNodes.length}개`);
      for (const node of template.nodes) {
        if (node.recipe.startsWith('cmd:')) {
          const id = node.recipe.slice(4);
          if (!isRecord(recipes) || !isRecord(recipes[id]) || typeof recipes[id].command !== 'string' || !recipes[id].command) errors.push(`recipe ${id} 없음`);
        } else if (node.recipe !== 'none') errors.push(`지원하지 않는 recipe: ${node.recipe}`);
      }
    } catch (error) { errors.push(`${graph} 파싱 실패: ${String(error)}`); }
  }
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) { errors.push(`안전하지 않은 파일: ${file}`); continue; }
      if (entry.isDirectory()) visit(file);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/\b(?:import|export)\s*(?:[\s\S]*?\s+from\s*)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)) {
          const target = match[1] ?? match[2]!;
          if (/(?:^|\/)src\//.test(target) && (target.startsWith('/') || target.startsWith('.'))) errors.push(`src import 금지: ${file}: ${target}`);
        }
      }
    }
  };
  try { visit(dir); } catch (error) { errors.push(`파일 검사 실패: ${String(error)}`); }
  try {
    const example = join(dir, 'examples', 'input.json');
    if (lstatSync(example).isSymbolicLink()) errors.push('안전하지 않은 examples/input.json 링크');
    else JSON.parse(readFileSync(example, 'utf8'));
  } catch (error) { errors.push(`examples/input.json 파싱 실패: ${String(error)}`); }
  const step = join(dir, 'graphs', 'run-step.ts');
  try {
    if (!existsSync(step)) errors.push('run-step.ts 없음');
    else if (errors.some(error => error.startsWith('안전하지 않은 파일:'))) return errors;
    else {
      const build = await Bun.build({ entrypoints: [step], target: 'bun' });
      if (!build.success) errors.push(...build.logs.map(log => `run-step.ts 문법 오류: ${log.message}`));
    }
  } catch (error) { errors.push(`run-step.ts 문법 오류: ${String(error)}`); }
  return errors;
}

export async function makePlugin({ request, name, parentDir, run, input, deps }: MakePluginOptions): Promise<MakePluginResult> {
  const slug = (name ?? request).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32).replace(/-$/, '') || `plugin-${Date.now()}`;
  if (!request.trim() || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug)) throw new Error(`invalid plugin request or name: ${slug}`);
  if (name !== undefined && !/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) throw new Error(`invalid --name slug: ${name}`);
  const root = elanousStateRoot();
  const parent = resolve(parentDir ?? join(root, 'plugins-local'));
  assertLocalParent(parent);
  const dir = join(parent, slug);
  if (existsSync(dir)) throw new Error(`plugin directory already exists: ${dir}`);
  const timings: MakePluginResult['timings'] = { scaffold: 0, write: 0, validate: 0, install: 0 };
  const result: MakePluginResult = { status: 'failed', dir, plugin: slug, graph: join(dir, 'graphs', `${slug}.yaml`), errors: [], timings };
  const step = async (stage: keyof MakePluginResult['timings'], action: () => void | Promise<void>): Promise<void> => {
    const start = performance.now();
    try { await action(); }
    finally { const ms = Math.round(performance.now() - start); timings[stage] = ms; debug.log('plugin.maker', stage, { ms, errors: result.errors }); }
  };
  try {
    await step('scaffold', () => { mkdirSync(parent, { recursive: true }); mkdirSync(dir); scaffold(dir, slug, request); });
    const codex = deps?.codex ?? codexWrite;
    const prompt = `요청 원문:\n${request}\n\n이 폴더의 뼈대를 수정해 작동하는 로컬 그래프 플러그인을 작성하라. plugin.json extensions["ai.elanous"].graphs 와 capabilities 는 유지하고, graphs/<id>.yaml 은 entry_node, terminal_nodes: [done, failed], nodes 의 recipe: 'cmd:<id>', edges 의 on: outcome, map: { ok, fail } 을 써라. graphs/recipes.yaml 에 모든 cmd:<id> 의 command: 'bun "$ELANOUS_GRAPH_DIR/run-step.ts" <id>' 와 timeout_ms 를 선언하라. graphs/run-step.ts 의 각 단계 stdout 마지막 줄은 JSON {outcome, ...} 이며 이전 출력은 ELANOUS_GRAPH_CONTEXT JSON 의 outputs 에 있다. src/ import 금지. 엘라누스 기능은 CLI elanous ask --json 또는 elanous research --json 로만 사용. 아무것도 보내지 말 것. 실행 노드는 2~6개. examples/input.json 에 실제로 돌릴 입력을 넣을 것. 폴더 밖에는 쓰지 말 것.`;
    await step('write', () => codex(dir, prompt));
    await step('validate', async () => { result.errors = await validatePluginDir(dir); });
    if (result.errors.length) {
      await step('repair', () => codex(dir, `${prompt}\n\n아래 오류를 모두 수리하라:\n${result.errors.join('\n')}`));
      await step('validate', async () => { result.errors = await validatePluginDir(dir); });
    }
    if (result.errors.length) return result;
    let installedPath = '';
    await step('install', async () => { installedPath = (await (deps?.install ?? installPlugin)(dir, { yes: true, root })).path; });
    result.status = 'installed';
    const graph = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')).extensions['ai.elanous'].graphs[0] as string;
    result.graph = resolve(installedPath, graph);
    if (run) {
      await step('run', async () => {
        const value = input === undefined ? JSON.parse(readFileSync(join(dir, 'examples', 'input.json'), 'utf8')) : input;
        result.runStatus = (await (deps?.runGraph ?? runGraph)(result.graph, { input: value })).status;
      });
      result.status = result.runStatus === 'done' ? 'ran' : 'failed';
      if (result.status === 'failed') result.errors.push(`graph run: ${result.runStatus}`);
    }
  } catch (error) {
    result.status = 'failed';
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}
