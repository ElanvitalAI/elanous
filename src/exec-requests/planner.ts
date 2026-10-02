import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { defaultGraphsDir } from '../self-implement/graph-templates.js';
import { handleGraphsGet } from '../nexus/api/graphs-api.js';
import { debug } from '../debug/log.js';

export interface InstalledGraph {
  id: string;
  title: string;
  description: string;
  path: string;
  /** 플러그인 그래프가 받는 입력 키(`examples/*.json` 표본에서) — COO 가 inputs 를 채울 수 있게. */
  inputKeys?: string[];
}
export interface ExecPlanItem {
  seat: string;
  title: string;
  graphId: string;
  inputs: Record<string, unknown>;
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
  const catalog = handleGraphsGet('/v1/graphs', coreDir, { coreDir, mineDir });
  if (!catalog.ok) throw new Error('installed graph catalog unavailable');
  const { graphs } = await catalog.json() as { graphs: Array<{ id: string; source: 'core' | 'mine' }> };
  return graphs.flatMap(({ id, source }) => {
    const dir = source === 'core' ? coreDir : mineDir;
    if (!/^[a-z0-9-]+$/.test(id) || !existsSync(join(dir, 'recipes.yaml'))) return [];
    let names: string[];
    try { names = readdirSync(dir).filter(name => /\.ya?ml$/.test(name)); }
    catch { return []; }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const doc = parseYaml(readFileSync(path, 'utf8')) as { graph_id?: string; loop?: { title?: string; description?: string } };
        if (doc?.graph_id === id) return [{ id, title: doc.loop?.title ?? id, description: doc.loop?.description ?? '', path }];
      } catch { /* A malformed file is not an executable graph. */ }
    }
    return [];
  });
}

export function seatTitles(path = fileURLToPath(new URL('../../scripts/coord-tracks.json', import.meta.url))): string[] {
  const data = JSON.parse(readFileSync(path, 'utf8')) as { tracks: Array<{ title?: string }> };
  return data.tracks.flatMap(track => track.title ? [track.title] : []);
}

export async function judgeExecPlan(text: string, graphs: readonly InstalledGraph[], seats: readonly string[]): Promise<unknown> {
  const prompt = `COO 역할. 요청을 실행 가능한 자리별 그래프로 나눠 맡겨라. JSON 배열만 출력: [{"seat":"자리","title":"할 일","graphId":"설치된 그래프 ID 또는 빈 문자열","inputs":{},"after":[]}]. 앞 항목의 결과가 있어야 할 수 있는 일(예: 점검·조사 «결과로» 쓰는 한 장 · 보고)은 after 에 그 앞 항목 번호(0부터)를 적는다 — 그 항목은 앞 항목이 끝난 뒤 그 결과를 받아 시작한다. 서로 기다릴 필요가 없으면 after 는 빈 배열. 자리 이름은 주어진 목록에서만, 그래프 ID는 설치된 목록에서만 고른다. 맞는 그래프가 없으면 graphId=""로 표시한다. 그래프에 inputKeys 가 있으면 inputs 를 그 키로만 채우되 한 줄에서 알 수 있는 값만 넣는다(모르는 값은 넣지 않는다). 그 그래프가 꼭 받아야 할 값(예: 브랜드 이름 · 사진 파일)을 한 줄에서 얻을 수 없으면 graphId=""로 두고 title 끝에 « — <무엇> 필요»를 적는다. 없는 그래프나 산출을 지어내지 마라. 바깥 게시·발행·광고·결제는 승인 노드를 거치기 전 실행하면 안 된다.\n자리: ${JSON.stringify(seats)}\n실행 가능한 그래프: ${JSON.stringify(graphs.map(({ id, title, description, inputKeys }) => ({ id, title, description, ...(inputKeys ? { inputKeys } : {}) })))}\n한 줄: ${JSON.stringify(text)}`;
  const { streamLLM } = await import('../llm.js');
  const { tierModel } = await import('../llm/model-defaults.js');
  const raw = await streamLLM([{ role: 'user', content: prompt }], () => {}, { model: tierModel('best') });
  return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) as unknown;
}

export async function planExecRequest(text: string, deps: {
  graphs?: () => Promise<InstalledGraph[]>;
  seats?: () => string[];
  judge?: typeof judgeExecPlan;
} = {}): Promise<ExecPlanItem[]> {
  const graphs = await (deps.graphs ?? installedGraphs)();
  const seats = (deps.seats ?? seatTitles)();
  const raw = await (deps.judge ?? judgeExecPlan)(text, graphs, seats);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('COO 계획이 비었거나 배열이 아닙니다');
  const known = new Map(graphs.map(graph => [graph.id, graph]));
  return raw.map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('COO 계획 항목 형식 오류');
    const row = item as Record<string, unknown>;
    if (typeof row.seat !== 'string' || !seats.includes(row.seat) || typeof row.title !== 'string' || !row.title.trim()
      || typeof row.graphId !== 'string' || !row.inputs || typeof row.inputs !== 'object' || Array.isArray(row.inputs)) {
      throw new Error('COO 계획 항목 형식 오류');
    }
    const after = Array.isArray(row.after)
      ? [...new Set(row.after.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < index))]
      : [];
    return {
      seat: row.seat, title: row.title.trim(), graphId: row.graphId,
      inputs: row.inputs as Record<string, unknown>,
      ...(after.length ? { after } : {}),
      ...(!known.has(row.graphId) ? { reason: `${row.seat}: 요청에 맞는 설치된 실행 그래프가 없습니다` } : {}),
    };
  });
}
