import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { debug, redactSecretText, redactSecrets } from '../../debug/log.js';
import { dispatchOmniSearch } from '../../skills/tools/omni-search.js';
import { runGraph } from '../../graph-runner/runner.js';
import { parseGraphTemplateYaml } from '../../self-implement/graph-yaml.js';
import { installPlugin } from '../install/plugin-install.js';
import { inspectPluginSecurity } from '../core/capability-policy.js';
import { generateWizardFiles, type WizardResearchDraft } from './wizard-generate.js';
import { bundleInstalledWizardPlugin, type MarketBundleResult } from './market-bundle.js';

const CAPABILITIES = ['fs:workdir', 'proc:bun', 'proc:elanous'];
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export interface WizardStepEvent {
  ts: string;
  wizardId: string;
  step: 'request' | 'research' | 'draft' | 'validate' | 'install' | 'done';
  text: string;
  detail?: unknown;
}

export interface ResearchSource { title: string; url: string; snippet: string; source: 'omni-crawl' | 'aside' }
export interface PluginDraft {
  connectors: Array<{ name: string; use: string; evidence: string[]; missingCredentials: string[] }>;
  skills: Array<{ name: string; use: string; evidence: string[] }>;
  graph: { use: string; nodes: string[]; evidence: string[] };
  research: { sources: ResearchSource[]; unavailable: string[] };
}

export interface MakePluginDeps {
  codex: (dir: string, prompt: string) => Promise<void>;
  install?: typeof installPlugin;
  bundle?: typeof bundleInstalledWizardPlugin;
  runGraph?: typeof runGraph;
  webSearch?: (query: string) => Promise<{ sources: ResearchSource[]; errors?: string[] }>;
  memorySearch?: (query: string) => Promise<ResearchSource[]>;
  asideBin?: string;
  onEvent?: (event: WizardStepEvent) => void;
}
export interface MakePluginOptions {
  request: string;
  draftFile?: string;
  name?: string;
  parentDir?: string;
  run?: boolean;
  /** Optional local output directory for a reviewable, unpublished market bundle. */
  marketBundleDir?: string;
  input?: unknown;
  deps?: MakePluginDeps;
}
export interface MakePluginResult {
  status: 'draft' | 'installed' | 'ran' | 'failed';
  dir: string;
  plugin: string;
  graph: string;
  errors: string[];
  runStatus?: Awaited<ReturnType<typeof runGraph>>['status'];
  marketBundle?: MarketBundleResult;
  draft: PluginDraft;
  timings: { scaffold: number; write: number; validate: number; repair?: number; install: number; run?: number };
}

/** Run codex in the plugin folder without leaving run debris there: the last message goes to a temp file, and a
 *  `.elanous/` that the run created (debug logs and a `latest` symlink from elanous processes codex starts in that
 *  folder) is removed — the installer refuses symlinks, so the debris made every freshly written plugin uninstallable
 *  (10-01 live `plugin node add`). A `.elanous/` that existed before the run is left alone. */
export async function codexWrite(dir: string, prompt: string, bin = 'codex'): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'elanous-codex-'));
  const stateDirExisted = existsSync(join(dir, '.elanous'));
  try {
    const child = Bun.spawn([bin, 'exec', '-C', dir, '-s', 'workspace-write', '--skip-git-repo-check', '-o', join(scratch, 'last-message.txt'), prompt], {
      cwd: dir, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`codex exec failed (${code}): ${stderr.trim().slice(0, 500)}`);
  } finally {
    if (!stateDirExisted) rmSync(join(dir, '.elanous'), { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
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
  catch { errors.push('plugin.json 파싱 실패'); }
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
  catch { errors.push('recipes.yaml 파싱 실패'); }
  if (!isRecord(recipes)) errors.push('recipes.yaml 은 맵이어야 한다');
  else for (const [id, recipe] of Object.entries(recipes)) {
    if (!isRecord(recipe) ||
      (!(typeof recipe.command === 'string' && recipe.command.trim()) && !(typeof recipe.approval === 'string' && recipe.approval.trim())) ||
      (recipe.command !== undefined && (typeof recipe.command !== 'string' || !recipe.command.trim())) ||
      (recipe.approval !== undefined && (typeof recipe.approval !== 'string' || !recipe.approval.trim())) ||
      (recipe.timeout_ms !== undefined && (!Number.isSafeInteger(recipe.timeout_ms) || Number(recipe.timeout_ms) <= 0))) errors.push(`잘못된 recipe: ${/^[a-zA-Z0-9_-]+$/.test(id) ? id : 'invalid'}`);
  }
  for (const graph of Array.isArray(graphs) ? graphs : []) {
    if (typeof graph !== 'string') continue;
    const file = inside(dir, graph);
    if (!file || !/^\.\/graphs\/[a-zA-Z0-9_-]+\.ya?ml$/.test(graph)) { errors.push('안전하지 않은 graph 경로'); continue; }
    try {
      if (lstatSync(file).isSymbolicLink()) { errors.push('안전하지 않은 graph 링크'); continue; }
      const parsed = parseGraphTemplateYaml(readFileSync(file, 'utf8'), file);
      errors.push(...parsed.errors.map(() => 'graph 정의 오류'));
      const template = parsed.template;
      if (!template) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(template.graphId)) errors.push('잘못된 graph_id');
      if (template.terminalNodes.length !== 2 || !template.terminalNodes.includes('done') || !template.terminalNodes.includes('failed')) errors.push('terminal_nodes 는 done, failed 이어야 한다');
      const executionNodes = template.nodes.filter(node => !template.terminalNodes.includes(node.nodeId));
      if (executionNodes.length < 2) errors.push(`실행 노드는 2개 이상이어야 한다: ${executionNodes.length}개`);
      for (const node of template.nodes) {
        if (node.recipe.startsWith('cmd:')) {
          const id = node.recipe.slice(4);
          if (!isRecord(recipes) || !isRecord(recipes[id]) || recipes[id].approval !== undefined || typeof recipes[id].command !== 'string' || !recipes[id].command.trim()) errors.push(`recipe ${/^[a-zA-Z0-9_-]+$/.test(id) ? id : 'invalid'} 없음`);
        } else if (node.recipe.startsWith('approval:')) {
          const id = node.recipe.slice(9);
          if (!isRecord(recipes) || !isRecord(recipes[id]) || typeof recipes[id].approval !== 'string' || !recipes[id].approval.trim()) errors.push(`approval recipe ${/^[a-zA-Z0-9_-]+$/.test(id) ? id : 'invalid'} 없음`);
        } else if (node.recipe !== 'none') errors.push(`지원하지 않는 recipe: ${/^[a-zA-Z0-9_:-]+$/.test(node.recipe) ? node.recipe : 'invalid'}`);
      }
    } catch { errors.push('graph 파싱 실패'); }
  }
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) { errors.push('안전하지 않은 파일'); continue; }
      if (entry.isDirectory()) visit(file);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/\b(?:import|export)\s*(?:[\s\S]*?\s+from\s*)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)) {
          const target = match[1] ?? match[2]!;
          if (/(?:^|\/)src\//.test(target) && (target.startsWith('/') || target.startsWith('.'))) errors.push('src import 금지');
        }
      }
    }
  };
  try { visit(dir); } catch { errors.push('파일 검사 실패'); }
  try {
    const example = join(dir, 'examples', 'input.json');
    if (lstatSync(example).isSymbolicLink()) errors.push('안전하지 않은 examples/input.json 링크');
    else JSON.parse(readFileSync(example, 'utf8'));
  } catch { errors.push('examples/input.json 파싱 실패'); }
  let security: ReturnType<typeof inspectPluginSecurity>;
  try { security = inspectPluginSecurity(dir); }
  catch { errors.push('보안 검사 실패'); return errors; }
  if (security.scan === 'dangerous') errors.push(...security.findings.filter(f => f.level === 'dangerous').map(f => `보안 검사 차단: ${f.code}`));
  const step = join(dir, 'graphs', 'run-step.ts');
  try {
    if (!existsSync(step)) errors.push('run-step.ts 없음');
    else if (errors.some(error => error.startsWith('안전하지 않은 파일'))) return errors;
    else {
      const build = await Bun.build({ entrypoints: [step], target: 'bun' });
      if (!build.success) errors.push('run-step.ts 문법 오류');
    }
  } catch { errors.push('run-step.ts 문법 오류'); }
  return errors;
}

async function searchWebForPlugin(query: string): Promise<{ sources: ResearchSource[]; errors?: string[] }> {
  const sources: ResearchSource[] = [];
  const errors: string[] = [];
  try {
    const found = await dispatchOmniSearch({ query, limit: 5 }, { onSource: hit => {
      sources.push({ title: hit.title, url: hit.url, snippet: hit.snippet ?? '', source: 'omni-crawl' });
    } });
    errors.push(...Object.entries(found.metadata.perEngine).flatMap(([engine, status]) => status.error ? [`${engine}: ${status.error}`] : []));
    if (!Object.keys(found.metadata.perEngine).length) errors.push('omni-crawl: 검색 제공자 없음');
  } catch (error) { errors.push(`웹 검색: ${String(error)}`); }
  try {
    const script = resolve(dirname(import.meta.path), '../../../skills/omni-crawl/scripts/main.ts');
    if (existsSync(script)) {
      const stdout = await new Promise<string>((resolveOutput, rejectOutput) => {
        const child = spawn(process.execPath, [script, query, '--engine', 'firecrawl', '--json', '--no-save'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        const timer = setTimeout(() => { child.kill(); rejectOutput(new Error('크롤 시간 초과')); }, 20_000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 1_000_000) child.kill(); });
        child.on('error', error => { clearTimeout(timer); rejectOutput(error); });
        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) rejectOutput(new Error(`크롤 종료 코드 ${code}`));
          else resolveOutput(output);
        });
      });
      const match = stdout.match(/---BEGIN_OMNI_CRAWL_JSON---\s*([\s\S]*?)\s*---END_OMNI_CRAWL_JSON---/);
      if (!match) throw new Error('크롤 JSON 결과 없음');
      const payload: unknown = JSON.parse(match[1]);
      const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
      let count = 0;
      for (const result of results) {
        if (!isRecord(result) || !Array.isArray(result.items)) continue;
        for (const item of result.items) {
          if (!isRecord(item) || typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) continue;
          count++;
          const source = sources.find(source => source.url === item.url);
          const text = typeof item.text === 'string' ? item.text.slice(0, 1800) : '';
          if (source) source.snippet = text || source.snippet;
          else sources.push({ title: typeof item.title === 'string' ? item.title : item.url, url: item.url, snippet: text, source: 'omni-crawl' });
        }
      }
      if (!count) errors.push('omni-crawl: 크롤 결과 없음 또는 검색 실패');
    } else errors.push('omni-crawl: 실행 스크립트 없음');
  } catch (error) { errors.push(`omni-crawl: ${String(error)}`); }
  return { sources, errors };
}

async function searchLocalMemory(query: string, bin = 'aside'): Promise<ResearchSource[]> {
  const prompt = `Search your local memory for the following plugin request (do not search the web): ${JSON.stringify(query)}. Return ONLY JSON: {"sources":[{"title":"note title","url":"local note URI or path","snippet":"relevant excerpt"}]}. Include at most 5 actual matching notes with their real reference URI or path; if none, return {"sources":[]}. Do not invent notes or references.`;
  const stdout = await new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn(bin, ['exec', '--effort', 'low', prompt], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) rejectOutput(error);
      else resolveOutput(output);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('검색 시간 초과')); }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 100_000) { child.kill(); finish(new Error('검색 결과 크기 초과')); }
    });
    child.stderr.on('data', (chunk: string) => { errorOutput = (errorOutput + chunk).slice(-500); });
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? undefined : new Error(`검색 종료 코드 ${code}: ${errorOutput.trim()}`)));
  });
  const parsed: unknown = JSON.parse(stdout.trim());
  if (!isRecord(parsed) || !Array.isArray(parsed.sources)) throw new Error('검색 결과 JSON 에 sources 배열 없음');
  return parsed.sources.slice(0, 5).filter((source): source is Record<string, string> =>
    isRecord(source) && typeof source.title === 'string' && typeof source.url === 'string' && !!source.url.trim() && typeof source.snippet === 'string')
    .map(source => ({ title: source.title.slice(0, 200), url: source.url.slice(0, 1000), snippet: source.snippet.slice(0, 800), source: 'aside' }));
}

function validResearchSource(source: ResearchSource): boolean {
  if (!source.url.trim()) return false;
  if (source.source === 'aside' && !/^https?:\/\//i.test(source.url)) return true;
  try {
    const url = new URL(source.url);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname;
  } catch { return false; }
}

function wizardDraftFromResearch(request: string, draft: PluginDraft): WizardResearchDraft {
  const used = new Set<string>();
  const connectors = draft.connectors.filter(connector => connector.name !== '미확인').map(connector => {
    const base = connector.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24).replace(/-$/, '') || 'connector';
    let id = base;
    for (let index = 2; used.has(id); index++) id = `${base}-${index}`;
    used.add(id);
    return { id, credentials: connector.missingCredentials
      .filter(name => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name))
      .map(name => ({ name })) };
  });
  const citedSkills = draft.skills.filter(skill => skill.name !== '미확인');
  return { description: request, connectors,
    skill: { description: request, instructions: request + (citedSkills.length
      ? `\n\nResearch sources:\n${citedSkills.map(skill => skill.evidence.join(', ')).join('\n')}` : ''), requires: [] } };
}

function buildDraft(request: string, sources: ResearchSource[], unavailable: string[]): PluginDraft {
  const evidence = [...new Set(sources.map(source => source.url).filter(Boolean))];
  const connectors = sources.filter(source => /api|oauth|webhook|integration|connector|연동|인증/i.test(`${source.title} ${source.snippet}`))
    .slice(0, 3).map(source => {
    const name = /^https?:\/\//.test(source.url) ? new URL(source.url).hostname : source.title;
    const fields = [...new Set((`${source.title} ${source.snippet}`.match(/\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|CLIENT_ID|CLIENT_SECRET)\b/g) ?? []))];
    return { name, use: source.title, evidence: [source.url], missingCredentials: fields.length ? fields : ['자격 확인 필요'] };
  });
  const skills = sources.filter(source => /skill|스킬|workflow|작업/i.test(`${source.title} ${source.snippet}`))
    .slice(0, 3).map(source => ({ name: source.title, use: source.snippet.slice(0, 200) || request, evidence: [source.url] }));
  const graphSource = sources.find(source => /graph|workflow|pipeline|그래프|흐름/i.test(`${source.title} ${source.snippet}`));
  const graphNodes = [...new Set((graphSource?.snippet.match(/\b(?:fetch|collect|extract|transform|process|analy[sz]e|report|publish)\b|수집|가공|분석|보고|발행/gi) ?? [])
    .map(node => node.toLowerCase()))].slice(0, 3);
  if (graphNodes.length < 2) graphNodes.push(...['fetch', 'process', 'report'].filter(node => !graphNodes.includes(node)).slice(0, 3 - graphNodes.length));
  return {
    connectors: connectors.length ? connectors : [{ name: '미확인', use: `요청에 필요한 커넥터 조사: ${request}`, evidence, missingCredentials: ['자격 확인 필요'] }],
    skills: skills.length ? skills : [{ name: '미확인', use: `요청에 필요한 스킬 조사: ${request}`, evidence }],
    graph: { use: request, nodes: graphNodes, evidence },
    research: { sources, unavailable },
  };
}

export async function makePlugin({ request, draftFile, name, parentDir, run, marketBundleDir, input, deps }: MakePluginOptions): Promise<MakePluginResult> {
  const slug = (name ?? request).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 31).replace(/-$/, '') || `plugin-${Date.now()}`;
  if (!request.trim() || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug)) throw new Error(`invalid plugin request or name: ${slug}`);
  if (name !== undefined && !/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) throw new Error(`invalid --name slug: ${name}`);
  const root = elanousStateRoot();
  const parent = resolve(parentDir ?? join(root, 'plugins-local'));
  assertLocalParent(parent);
  const dir = join(parent, slug);
  if (existsSync(dir)) throw new Error(`plugin directory already exists: ${dir}`);
  const timings: MakePluginResult['timings'] = { scaffold: 0, write: 0, validate: 0, install: 0 };
  const wizardId = randomUUID();
  const result: MakePluginResult = { status: 'failed', dir, plugin: slug, graph: join(dir, 'graphs', `${slug}.yaml`), errors: [], timings,
    draft: buildDraft(request, [], []) };
  const emit = (stage: WizardStepEvent['step'], text: string, detail?: unknown): void => {
    const event: WizardStepEvent = { ts: new Date().toISOString(), wizardId, step: stage, text: redactSecretText(text.slice(0, 500)),
      ...(detail === undefined ? {} : { detail: redactSecrets(detail) }) };
    try { debug.log('wizard.step', 'wizard.step', event); } catch { /* Logging cannot stop make. */ }
    try { deps?.onEvent?.(event); } catch { /* An observation sink must not stop installation. */ }
  };
  const step = async (stage: keyof MakePluginResult['timings'], action: () => void | Promise<void>): Promise<void> => {
    const start = performance.now();
    try { await action(); }
    finally { const ms = Math.round(performance.now() - start); timings[stage] = ms; debug.log('plugin.maker', stage, { ms, errors: redactSecrets(result.errors) }); }
  };
  try {
    emit('request', request);
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => (deps?.webSearch ?? (process.env.NODE_ENV === 'test' ? async () => ({ sources: [], errors: ['omni-crawl: 시험 모드'] }) : searchWebForPlugin))(request)),
      Promise.resolve().then(() => (deps?.memorySearch ?? (process.env.NODE_ENV === 'test' && !deps?.asideBin ? async () => [] : (query: string) => searchLocalMemory(query, deps?.asideBin)))(request)),
    ]);
    const unavailable: string[] = [];
    const sources: ResearchSource[] = [];
    if (settled[0].status === 'fulfilled') {
      sources.push(...settled[0].value.sources);
      unavailable.push(...(settled[0].value.errors ?? []));
      if (!settled[0].value.sources.length) unavailable.push('omni-crawl: 검색 결과 없음');
    } else unavailable.push(`omni-crawl: ${String(settled[0].reason)}`);
    if (settled[1].status === 'fulfilled') {
      sources.push(...settled[1].value);
      if (!settled[1].value.length) unavailable.push('aside: 검색 결과 없음');
    } else unavailable.push(`aside: ${String(settled[1].reason)}`);
    for (let i = sources.length - 1; i >= 0; i--) {
      if (!validResearchSource(sources[i])) {
        unavailable.push(`${sources[i].source}: 잘못된 출처 URL: ${sources[i].url}`);
        sources.splice(i, 1);
      }
    }
    emit('research', sources.length ? `${sources.length}건 조사` : `조사 없음 · ${unavailable.join('; ')}`, { sources, unavailable });
    result.draft = buildDraft(request, sources, unavailable);
    emit('draft', '커넥터·스킬·그래프 초안', result.draft);
    await step('scaffold', () => { mkdirSync(parent, { recursive: true }); mkdirSync(dir); if (draftFile === undefined) scaffold(dir, slug, request); });
    const codex = deps?.codex ?? codexWrite;
    const prompt = `요청 원문:\n${request}\n\n이 폴더의 뼈대를 수정해 작동하는 로컬 그래프 플러그인을 작성하라. plugin.json extensions["ai.elanous"].graphs 와 capabilities 는 유지하고, graphs/<id>.yaml 은 entry_node, terminal_nodes: [done, failed], nodes 의 recipe: 'cmd:<id>', edges 의 on: outcome, map: { ok, fail } 을 써라. graphs/recipes.yaml 에 모든 cmd:<id> 의 command: 'bun "$ELANOUS_GRAPH_DIR/run-step.ts" <id>' 와 timeout_ms 를 선언하라. graphs/run-step.ts 의 각 단계 stdout 마지막 줄은 JSON {outcome, ...} 이며 이전 출력은 ELANOUS_GRAPH_CONTEXT JSON 의 outputs 에 있다. src/ import 금지. 엘라누스 기능은 CLI elanous ask --json 또는 elanous research --json 로만 사용. 아무것도 보내지 말 것. 실행 노드는 2~6개. examples/input.json 에 실제로 돌릴 입력을 넣을 것. 폴더 밖에는 쓰지 말 것.`;
    const researchedPrompt = `${prompt}\n\n조사 기반 초안 (확인되지 않은 자격을 지어내지 말 것):\n${JSON.stringify(result.draft, null, 2)}`;
    if (draftFile !== undefined) {
      await step('write', () => {
        const draft = JSON.parse(readFileSync(resolve(draftFile), 'utf8')) as WizardResearchDraft;
        generateWizardFiles(dir, slug, draft);
      });
    } else {
      await step('write', async () => {
        generateWizardFiles(dir, slug, wizardDraftFromResearch(request, result.draft));
        await codex(dir, `${researchedPrompt}\n\n생성된 커넥터 선언과 skills/${slug}/SKILL.md 를 보존하고, researchDraft 그래프의 실패 단계는 실제 요청 처리로 구현하라. 설치 전에 실행 예제로 그래프를 검증하며, 실패하면 플러그인을 설치하지 않는다.`);
      });
    }
    emit('validate', '플러그인 검사 시작');
    const validate = async (): Promise<void> => {
      if (draftFile === undefined) {
        const manifestPath = join(dir, 'plugin.json');
        const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const extension = isRecord(raw) && isRecord(raw.extensions) ? raw.extensions['ai.elanous'] : undefined;
        if (isRecord(extension)) {
          extension.researchDraft = true;
          writeFileSync(manifestPath, JSON.stringify(raw, null, 2) + '\n');
        }
      }
      result.errors = await validatePluginDir(dir);
      if (draftFile === undefined && !result.errors.length) {
        const probeRoot = mkdtempSync(join(tmpdir(), 'elanous-wizard-probe-'));
        try {
          const example = JSON.parse(readFileSync(join(dir, 'examples', 'input.json'), 'utf8')) as unknown;
          const probe = await runGraph(result.graph, { input: example, deps: { root: probeRoot } });
          if (probe.status !== 'done' || probe.nodes.some(node => !node.ok)) {
            result.errors.push(`research graph validation failed: ${probe.status}`);
          }
        } finally { rmSync(probeRoot, { recursive: true, force: true }); }
        if (!result.errors.length) {
          const manifestPath = join(dir, 'plugin.json');
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { extensions: { 'ai.elanous': { researchDraft?: boolean } } };
          delete manifest.extensions['ai.elanous'].researchDraft;
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
        }
      }
    };
    await step('validate', validate);
    if (result.errors.length && draftFile === undefined) {
      await step('repair', () => codex(dir, `${researchedPrompt}\n\n아래 오류를 모두 수리하라:\n${result.errors.join('\n')}`));
      await step('validate', validate);
    }
    if (result.errors.length) return result;
    if (draftFile !== undefined) {
      result.status = run ? 'failed' : 'draft';
      if (run) result.errors.push('research draft only: implement graph steps before --run; no plugin was installed');
      return result;
    }
    let installedPath = '';
    emit('install', '플러그인 설치 시작');
    await step('install', async () => { installedPath = (await (deps?.install ?? installPlugin)(dir, { yes: true, root })).path; });
    result.status = 'installed';
    if (marketBundleDir !== undefined) {
      result.marketBundle = (deps?.bundle ?? bundleInstalledWizardPlugin)(installedPath, marketBundleDir);
    }
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
    result.errors.push(redactSecretText(error instanceof Error ? error.message : String(error)));
  } finally {
    emit('done', result.status, { errors: result.errors });
  }
  return result;
}
