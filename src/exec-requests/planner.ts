import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { defaultGraphsDir } from '../self-implement/graph-templates.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import type { ExecAttachment } from './store.js';
import { debug } from '../debug/log.js';
import { peerEditRunGate } from '../nexus/api/graph-peer-edit.js';
import { OUTPUT_KINDS, pickDefaultOutput, type OutputKind } from './default-outputs.js';

export interface InstalledGraph {
  id: string;
  title: string;
  description: string;
  path: string;
  /** 코어 loop.inputs 또는 플러그인 examples/*.json 표본의 입력 키. */
  inputKeys?: string[];
}
export interface ExecPlanItem {
  seat: string;
  title: string;
  graphId: string;
  inputs: Record<string, unknown>;
  /** Planner fills this for every returned row; older injected plan fixtures may omit it. */
  output?: OutputKind;
  reason?: string;
  /** A5b — indexes of earlier items whose results this item needs (it starts after they finish). */
  after?: number[];
}

/** 설치된 플러그인의 실행 그래프 — `<state>/plugins/<market>/<name>/<version>/graphs/{recipes.yaml, <id>.yaml}`
 *  (`src/plugins/install/plugin-install.ts` 설치 경로). 이름마다 가장 새 버전 하나 · 제목·설명은 그래프 `loop` 가 없으면
 *  `plugin.json` 의 name·description(COO 가 «무엇을 하는 그래프인지» 알게). 2026-10-01 실측: 이것을 안 봐서
 *  한 줄이 자리로 나뉘어도 «맞는 설치 그래프 없음»이었다. */
export function installedPluginGraphs(pluginsRoot = join(elanousStateRoot(), 'plugins')): { graphs: InstalledGraph[]; errors: string[] } {
  const graphs: InstalledGraph[] = [];
  const errors: string[] = [];
  const dirs = (path: string): string[] => {
    try { return readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name); }
    catch { return []; }
  };
  for (const market of dirs(pluginsRoot)) {
    for (const name of dirs(join(pluginsRoot, market))) {
      const versions = dirs(join(pluginsRoot, market, name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      const version = versions[0];
      if (!version) continue;
      const root = join(pluginsRoot, market, name, version);
      const graphsDir = join(root, 'graphs');
      if (!existsSync(join(graphsDir, 'recipes.yaml'))) continue;
      let meta: { name?: string; description?: string } = {};
      try { meta = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')) as typeof meta; } catch { errors.push(`${market}/${name}@${version}: plugin.json unreadable`); }
      // 입력 키 — 플러그인이 입력 스키마를 따로 선언하지 않아 `examples/*.json` 첫 표본의 키를 쓴다(값은 가상이라 안 싣는다).
      // 2026-10-01 실측: 키를 몰라 COO 가 `inputs:{}` 로 맡겼고 geo-check 가 «brand is required» 로 첫 노드에서 떨어졌다.
      let inputKeys: string[] | undefined;
      try {
        const sample = readdirSync(join(root, 'examples')).filter(f => f.endsWith('.json')).sort()[0];
        if (sample) {
          const parsed = JSON.parse(readFileSync(join(root, 'examples', sample), 'utf8')) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) inputKeys = Object.keys(parsed);
        }
      } catch { /* 표본 없음 · 망가짐 = 키 모름 */ }
      let files: string[] = [];
      try { files = readdirSync(graphsDir).filter(f => /\.ya?ml$/.test(f) && f !== 'recipes.yaml'); } catch { errors.push(`${market}/${name}@${version}: graphs unreadable`); }
      for (const file of files) {
        const path = join(graphsDir, file);
        try {
          const doc = parseYaml(readFileSync(path, 'utf8')) as { graph_id?: string; loop?: { title?: string; description?: string } };
          const id = doc?.graph_id;
          if (!id || !/^[a-z0-9-]+$/.test(id)) continue;
          graphs.push({ id, title: doc.loop?.title ?? meta.name ?? id, description: doc.loop?.description ?? meta.description ?? '', path, ...(inputKeys ? { inputKeys } : {}) });
        } catch { errors.push(`${market}/${name}@${version}: ${file} malformed`); }
      }
    }
  }
  return { graphs, errors };
}

export async function installedGraphs(coreDir = defaultGraphsDir(), mineDir = join(elanousStateRoot(), 'graphs')): Promise<InstalledGraph[]> {
  const base = await coreAndMineGraphs(coreDir, mineDir);
  // 플러그인은 mine 과 같은 상태 뿌리 아래(<root>/graphs ↔ <root>/plugins) — 시험의 임시 mine 은 운영 플러그인을 안 본다.
  const plugins = installedPluginGraphs(join(dirname(mineDir), 'plugins'));
  const seen = new Set(base.map(g => g.id));
  const extra = plugins.graphs.filter(g => !seen.has(g.id));
  debug.log('exec-requests', 'catalog', { coreAndMine: base.length, plugins: extra.length, pluginErrors: plugins.errors.slice(0, 5) });
  return [...base, ...extra];
}

async function coreAndMineGraphs(coreDir: string, mineDir: string): Promise<InstalledGraph[]> {
  const graphs: InstalledGraph[] = [];
  const seen = new Set<string>();
  const scan = (dir: string, core: boolean): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    if (!core || dir === coreDir || entries.some(entry => entry.isFile() && entry.name === 'recipes.yaml')) {
      for (const entry of entries) {
        if (!entry.isFile() || !/\.ya?ml$/.test(entry.name) || entry.name === 'recipes.yaml') continue;
        const path = join(dir, entry.name);
        try {
          const doc = parseYaml(readFileSync(path, 'utf8')) as {
            graph_id?: unknown;
            loop?: { title?: string; description?: string; exec_request?: unknown; inputs?: unknown };
          } | null;
          const id = doc?.graph_id;
          if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id) || seen.has(id)) continue;
          if (core && doc?.loop?.exec_request !== true) continue;
          // W9c — a «mine» graph a peer changed is not runnable until the owner approves it (fail closed).
          if (!core) {
            const gate = peerEditRunGate(dir, id);
            if (!gate.ok) { debug.log('exec-requests', 'skipped-peer-edit', { id, error: gate.error }); continue; }
          }
          const inputs = doc?.loop?.inputs;
          const inputKeys = core && Array.isArray(inputs)
            ? inputs.filter((key): key is string => typeof key === 'string')
            : core && inputs && typeof inputs === 'object' ? Object.keys(inputs) : undefined;
          graphs.push({ id, title: doc?.loop?.title ?? id, description: doc?.loop?.description ?? '', path,
            ...(inputKeys ? { inputKeys } : {}) });
          seen.add(id);
        } catch { /* A malformed file is not an executable graph. */ }
      }
    }
    if (core) for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) scan(join(dir, entry.name), true);
    }
  };
  scan(coreDir, true);
  scan(mineDir, false);
  return graphs;
}

export function seatTitles(path = fileURLToPath(new URL('../../scripts/coord-tracks.json', import.meta.url))): string[] {
  const data = JSON.parse(readFileSync(path, 'utf8')) as { tracks: Array<{ title?: string }> };
  return data.tracks.flatMap(track => track.title ? [track.title] : []);
}

export function latestFieldFolder(configRoot = getElanousConfigDir()): string | null {
  const root = join(configRoot, 'field');
  let latest: { path: string; time: number } | null = null;
  try {
    for (const event of readdirSync(root, { withFileTypes: true })) {
      if (!event.isDirectory() || event.name.startsWith('.')) continue;
      const path = join(root, event.name);
      try {
        const photos = readdirSync(path, { withFileTypes: true }).filter(file => file.isFile() && /\.(?:png|jpe?g|webp|heic)$/i.test(file.name));
        for (const photo of photos) {
          const time = statSync(join(path, photo.name)).mtimeMs;
          if (!latest || time > latest.time || (time === latest.time && path.localeCompare(latest.path) > 0)) latest = { path, time };
        }
      } catch { /* Unreadable event does not supply photos. */ }
    }
  } catch { /* No field directory. */ }
  return latest?.path ?? null;
}

export function execPlanPrompt(text: string, graphs: readonly InstalledGraph[], seats: readonly string[], attachments: readonly ExecAttachment[] = [], fieldFolder: string | null = latestFieldFolder()): string {
  const supplied = attachments.map(({ name, path }) => `첨부: ${name} (${/\.(?:png|jpe?g|webp|gif|heic)$/i.test(name) ? '이미지' : '파일'}) — ${path}`).join('\n');
  return `COO 역할. 요청을 실행 가능한 자리별 그래프로 나눠 맡겨라. JSON 배열만 출력: [{"seat":"자리","title":"할 일","graphId":"설치된 그래프 ID 또는 빈 문자열","inputs":{},"after":[]}]. 각 행에는 선택 칸 "output":"report|slides|research|post|video|answer"를 쓸 수 있다: ${Object.entries(OUTPUT_KINDS).map(([kind, entry]) => `${entry.guidance} = ${kind}${entry.fileName ? ` (${entry.fileName})` : ''}`).join(', ')}; 그 외 일은 report로 둔다. 앞 항목의 결과가 있어야 할 수 있는 일(예: 점검·조사 «결과로» 쓰는 한 장 · 보고)은 after 에 그 앞 항목 번호(0부터)를 적는다 — 그 항목은 앞 항목이 끝난 뒤 그 결과를 받아 시작한다. 서로 기다릴 필요가 없으면 after 는 빈 배열. 자리 이름은 주어진 목록에서만, 그래프 ID는 설치된 목록에서만 고른다. 맞는 그래프가 없으면 graphId=""로 표시한다. 그래프에 inputKeys 가 있으면 inputs 를 그 키로만 채우되 한 줄과 아래 알려진 값에서 얻을 수 있는 값만 넣는다(모르는 값은 넣지 않는다). image/photo/file 입력에는 알맞은 첨부 경로를 쓸 수 있다. folder 입력에는 첨부가 없거나 첨부 사진이 그 현장 폴더 안에 있을 때만 오늘 현장 폴더를 쓸 수 있다. 다른 현장 사진이나 출처를 모르는 업로드 사진이 있으면 폴더를 추측하지 마라. 그 그래프가 꼭 받아야 할 값(예: 브랜드 이름 · 사진 파일)을 알 수 없으면 graphId=""로 두고 title 끝에 « — <무엇> 필요»를 적는다. 단순히 묻는 말에는 없는 그래프를 지어내지 말고 graphId=""로 표시한다. 없는 그래프나 산출을 지어내지 마라. 바깥 게시·발행·광고·결제는 승인 노드를 거치기 전 실행하면 안 된다.\n자리: ${JSON.stringify(seats)}\n실행 가능한 그래프: ${JSON.stringify(graphs.map(({ id, title, description, inputKeys }) => ({ id, title, description, ...(inputKeys ? { inputKeys } : {}) })))}\n${fieldFolder ? `알려진 값: 오늘 현장 폴더 = ${fieldFolder}\n` : ''}${supplied ? `${supplied}\n` : ''}한 줄: ${JSON.stringify(text)}`;
}

export async function judgeExecPlan(text: string, graphs: readonly InstalledGraph[], seats: readonly string[], attachments: readonly ExecAttachment[] = [], fieldFolder: string | null = latestFieldFolder()): Promise<unknown> {
  const prompt = execPlanPrompt(text, graphs, seats, attachments, fieldFolder);
  const { streamLLM } = await import('../llm.js');
  const { tierModel } = await import('../llm/model-defaults.js');
  const raw = await streamLLM([{ role: 'user', content: prompt }], () => {}, { model: tierModel('best') });
  return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) as unknown;
}

export async function planExecRequest(text: string, deps: {
  graphs?: () => Promise<InstalledGraph[]>;
  seats?: () => string[];
  judge?: typeof judgeExecPlan;
  attachments?: readonly ExecAttachment[];
  fieldFolder?: () => string | null;
} = {}): Promise<ExecPlanItem[]> {
  const graphs = await (deps.graphs ?? installedGraphs)();
  const seats = (deps.seats ?? seatTitles)();
  const attachments = deps.attachments ?? [];
  const fieldFolder = (deps.fieldFolder ?? latestFieldFolder)();
  const raw = await (deps.judge ?? judgeExecPlan)(text, graphs, seats, attachments, fieldFolder);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('COO 계획이 비었거나 배열이 아닙니다');
  const known = new Map(graphs.map(graph => [graph.id, graph]));
  const plans: ExecPlanItem[] = raw.map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('COO 계획 항목 형식 오류');
    const row = item as Record<string, unknown>;
    if (typeof row.seat !== 'string' || !seats.includes(row.seat) || typeof row.title !== 'string' || !row.title.trim()
      || typeof row.graphId !== 'string' || !row.inputs || typeof row.inputs !== 'object' || Array.isArray(row.inputs)) {
      throw new Error('COO 계획 항목 형식 오류');
    }
    const after = Array.isArray(row.after)
      ? [...new Set(row.after.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < index))]
      : [];
    const graph = known.get(row.graphId);
    const modelOutput = typeof row.output === 'string' && Object.hasOwn(OUTPUT_KINDS, row.output)
      ? row.output as OutputKind : undefined;
    const picked = modelOutput ?? pickDefaultOutput(row.title).kind;
    const output = picked === 'video' && !graph ? 'report' : picked;
    debug.log('exec.plan', 'default-output', { kind: output, source: modelOutput === output ? 'model' : 'rule' });
    const inputs = { ...row.inputs as Record<string, unknown> };
    let folderReason: string | undefined;
    if (graph) {
      for (const key of graph.inputKeys ?? []) {
        if (key === 'folder') {
          // A folder input must contain every attached photo — never guess it from «the latest event» (review r1).
          const photos = attachments.filter(a => /\.(?:png|jpe?g|webp|gif|heic)$/i.test(a.name)).map(a => resolve(a.path));
          const holds = (folder: string) => photos.every(photo => photo.startsWith(`${resolve(folder)}${sep}`));
          const given = typeof inputs.folder === 'string' ? inputs.folder : undefined;
          if (given !== undefined) {
            if (!holds(given)) { delete inputs.folder; folderReason = `${row.seat}: folder 필요 — 첨부 사진이 그 현장 폴더 안에 없습니다`; }
          } else if (fieldFolder && holds(fieldFolder)) inputs.folder = fieldFolder;
          else if (photos.length) folderReason = `${row.seat}: folder 필요 — 첨부 사진의 현장 폴더를 알 수 없습니다`;
          continue;
        }
        if (inputs[key] !== undefined) continue;
        if (['image', 'photo', 'file'].includes(key)) {
          const attachment = attachments.find(a => key === 'file' || /\.(?:png|jpe?g|webp|gif|heic)$/i.test(a.name));
          if (attachment) inputs[key] = attachment.path;
        }
      }
    }
    return {
      seat: row.seat, title: row.title.trim(), graphId: row.graphId, inputs, output,
      ...(after.length ? { after } : {}),
      ...(!graph ? { reason: `${row.seat}: 요청에 맞는 설치된 실행 그래프가 없습니다` } : folderReason ? { reason: folderReason } : {}),
    };
  });
  for (const plan of plans) debug.log('exec.planner', 'select', { seat: plan.seat, chosen: plan.graphId, candidates: graphs.slice(0, 10).map(graph => graph.id) });
  return plans;
}
