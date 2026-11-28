// kit/supervisor-index — one redundancy index over every supervisor unit (LOOP-AGENTS-AS-PLUGINS · 대표 11-28 07:5x «bm25·vector·
// ontology·rdb 이용해서 확인 · 인접 루프 에이전트 포함» · 08:1x «국면·테마·범위만 다르면 공용화» · 08:2x «4종 DB 근거로 통합»).
//
// S: «what supervises what» lived in five places — graphs/loop-agents (agent.yaml), loop graphs (graphs/**/ loop:), trigger shims,
//    TS supervisors (guardian subs · steward · judge-butler · supervision/*) and ~4,200 ops scripts — with no single table.
// C: retiring a duplicate is only safe when the evidence says which copy is alive and which copies do the same job.
// Q: what is the smallest index that answers «same target + same action», «only the phase/kingdom/threshold differs» and «dead»?
// A: one SQLite snapshot (RDB: units · detectors · actions · kpis · triggers · prompts · policies · code_paths · edges) ⊕ an FTS5
//    trigram table (BM25) ⊕ a deterministic hashed-n-gram vector (the search bench's offline embedding — no model, no API) ⊕
//    ontology edges (watches → target · acts → action · measures → KPI · fires · absorbs) tagged by ontology.yaml. analyze()
//    reads only that snapshot and returns duplicate clusters (with the four numbers each), commonization families, dead units
//    and edge-only policy keys. Read-only: it never writes to a ledger, a registry or a seat.
//
// 세 얼굴: 관측 = `eln loop index build|report` (the snapshot DB is the observation) · 판단 근거 = the four scores per pair
//          (rdb · bm25 · cos · onto) ⊕ ticks/acts from the trigger registry and the agents' own case ledgers ·
//          수복과 인계 = the report names keep/retire per cluster; retirement itself is a PR (never automatic).
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parse } from 'yaml';

type Dict = Record<string, unknown>;
const isObj = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x : isObj(x) && typeof x.id === 'string' ? x.id : str(x))) : []);
const DAY_MS = 86_400_000;

export interface Ontology {
  readonly targets: Record<string, string[]>; readonly actions: Record<string, string[]>;
  readonly phases: string[]; readonly scopes: string[]; readonly script_name: string; readonly adjacent_code: string[];
  readonly stages: Record<string, string[]>; readonly functions: Record<string, string[]>;
  readonly concept_weight?: number; readonly function_kits?: Record<string, string>;
  readonly thresholds?: { readonly onto?: number; readonly cos?: number; readonly bm25?: number; readonly near?: number };
  readonly families?: Record<string, string[]>; readonly confirmed?: ReadonlyArray<{ match: string; verdict: string }>;
}
export const loadOntology = (path = join(import.meta.dir, 'ontology.yaml')): Ontology => parse(readFileSync(path, 'utf8')) as Ontology;

export type UnitKind = 'agent' | 'graph' | 'shim' | 'code' | 'script' | 'schedule';
export interface Unit {
  id: string; kind: UnitKind; name: string; path: string; owner: string; lines: number;
  detectors: string[]; actions: string[]; kpis: string[]; triggers: Array<{ id: string; kind: string; spec: string }>;
  prompts: Array<{ kind: string; text: string }>; policies: Record<string, string>; codePaths: Array<{ path: string; lines: number }>;
  absorbs: string[]; fromAgent?: string; recipes: string[]; signature: string;
  ticks7d: number | null; acts7d: number | null; kpiDistinct7d: number | null; lastAt: string | null; mtimeMs: number;
}
export interface Sources {
  readonly repoRoot: string; readonly seatStateRoot?: string; readonly stateRoot?: string;
  /** crontab text and launchd plists (dir) — absent = not read (tests). */
  readonly crontab?: string; readonly launchdDir?: string; readonly now?: Date;
}

const lineCount = (p: string): number => { try { return readFileSync(p, 'utf8').split('\n').length; } catch { return 0; } };
const readSafe = (p: string, max = 200_000): string => { try { const s = statSync(p); return s.isFile() && s.size <= max ? readFileSync(p, 'utf8') : ''; } catch { return ''; } };
function walk(dir: string, out: string[] = [], skip = (n: string) => n.startsWith('.') || n === 'node_modules' || n === '_archive'): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, skip); else out.push(p);
  }
  return out;
}
const blank = (id: string, kind: UnitKind, name: string, path: string): Unit => ({ id, kind, name, path, owner: '', lines: 0, detectors: [], actions: [], kpis: [], triggers: [], prompts: [], policies: {}, codePaths: [], absorbs: [], recipes: [], signature: '', ticks7d: null, acts7d: null, kpiDistinct7d: null, lastAt: null, mtimeMs: 0 });
/** The leading comment block of a source file (its own description). */
export const headerComment = (text: string): string => {
  const out: string[] = [];
  for (const l of text.split('\n').slice(0, 40)) { const m = /^\s*(?:\/\/|#(?!!)|\*|\/\*\*?)\s?(.*)$/u.exec(l); if (m) out.push(m[1]!); else if (out.length || l.trim()) break; }
  return out.join(' ').trim();
};
/** Strip meta (numbers · seat/kingdom names · phase words · quoted text · the unit's own id) → the shape two variants share. */
export function metaStrip(text: string, onto: Ontology, ownId = ''): string {
  let s = text.replace(/^\s*(#|\/\/).*$/gmu, '');
  if (ownId) s = s.split(ownId).join('<ID>');
  s = s.replace(/(['"])(?:(?!\1).){0,200}\1/gu, '<STR>').replace(/\b\d+(?:\.\d+)?\b/gu, '<N>');
  for (const k of onto.scopes) s = s.replace(new RegExp(`\\b${k}\\b`, 'gu'), '<KINGDOM>');
  for (const p of onto.phases) s = s.split(p).join('<PHASE>');
  return s.replace(/\s+/gu, ' ').trim();
}

function recipesOf(repo: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of walk(join(repo, 'graphs')).filter(p => basename(p) === 'recipes.yaml')) {
    try { const d = parse(readFileSync(f, 'utf8')); if (isObj(d)) for (const [k, v] of Object.entries(d)) m.set(k, isObj(v) ? str(v.command) : str(v)); } catch { /* broken recipes file = no recipes */ }
  }
  return m;
}

function collectAgents(repo: string, onto: Ontology): Unit[] {
  const root = join(repo, 'graphs', 'loop-agents');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(id => existsSync(join(root, id, 'agent.yaml')) || existsSync(join(root, id, 'goal.yaml'))).map(id => {
    const dir = join(root, id);
    const file = existsSync(join(dir, 'agent.yaml')) ? 'agent.yaml' : 'goal.yaml';
    const d = (parse(readFileSync(join(dir, file), 'utf8')) ?? {}) as Dict;
    const u = blank(`agent:${id}`, 'agent', id, relative(repo, join(dir, file)));
    const card = isObj(d.card) ? d.card : isObj(d.soul) ? { ...d.soul, subject: d.subject } as Dict : {};
    u.owner = str(isObj(d.supervisor) ? d.supervisor.duty : d.supervisor);
    u.lines = readdirSync(dir).reduce((n, f) => n + lineCount(join(dir, f)), 0);
    u.detectors = [str(card.subject), ...strs(card.wake_events)].flatMap(s => s.split(/\s+·\s+/u)).filter(Boolean);
    u.actions = [...new Set([...strs(card.actions), ...strs(d.actions)])];
    u.kpis = Array.isArray(d.kpis) ? d.kpis.map(k => str(isObj(k) ? k.name : k)) : isObj(d.kpi) ? [str(d.kpi.name)] : [];
    const wake = isObj(d.wake) ? d.wake : {};
    const trig = isObj(wake.trigger) ? wake.trigger : {};
    if (wake.registered_as) u.triggers.push({ id: str(wake.registered_as), kind: trig.cron ? 'cron' : 'condition', spec: str(trig.cron ?? trig.condition) });
    for (const f of ['soul.md', 'knowhow.md']) if (existsSync(join(dir, f))) u.prompts.push({ kind: f.replace('.md', ''), text: readFileSync(join(dir, f), 'utf8') });
    u.prompts.push({ kind: 'card', text: [card.role, card.temperament, ...strs(card.values), d.goal, ...strs(d.done_when)].map(str).join('\n') });
    if (isObj(d.policies)) for (const [k, v] of Object.entries(d.policies)) u.policies[k] = str(v);
    const body = join(repo, 'src', 'loop-agent', 'bodies', `${id}.ts`);
    if (existsSync(body)) u.codePaths.push({ path: relative(repo, body), lines: lineCount(body) });
    const b = isObj(d.body) ? d.body : {};
    u.signature = metaStrip(JSON.stringify([(Array.isArray(b.nodes) ? b.nodes : []).map(n => (isObj(n) ? n.kind : n)), b.edges]), onto, id);
    u.mtimeMs = statSync(join(dir, file)).mtimeMs;
    return u;
  });
}

function collectGraphs(repo: string, onto: Ontology, recipes: Map<string, string>): Unit[] {
  const out: Unit[] = [];
  for (const f of walk(join(repo, 'graphs')).filter(p => p.endsWith('.yaml') && !p.includes('/loop-agents/') && !p.includes('/policies/') && basename(p) !== 'recipes.yaml')) {
    let d: unknown; try { d = parse(readFileSync(f, 'utf8')); } catch { continue; }
    if (!isObj(d) || typeof d.graph_id !== 'string' || !isObj(d.loop)) continue;
    const loop = d.loop; const gid = d.graph_id;
    const u = blank(`graph:${gid}`, loop.from_agent ? 'shim' : 'graph', gid, relative(repo, f));
    u.owner = str(loop.owner); u.lines = lineCount(f); u.mtimeMs = statSync(f).mtimeMs;
    if (loop.from_agent) u.fromAgent = str(loop.from_agent);
    u.absorbs = strs(loop.absorbs);
    const trig = isObj(loop.trigger) ? loop.trigger : {};
    u.triggers.push({ id: gid, kind: trig.cron ? 'cron' : trig.condition ? 'condition' : 'manual', spec: str(trig.cron ?? trig.condition ?? trig.events) });
    const desc = [str(loop.title), str(loop.description), headerComment(readFileSync(f, 'utf8'))].join('\n');
    u.prompts.push({ kind: 'description', text: desc });
    u.detectors = [str(loop.title)].filter(Boolean);
    const nodes = Array.isArray(d.nodes) ? d.nodes.filter(isObj) : [];
    u.recipes = nodes.map(n => str(n.recipe)).filter(Boolean);
    u.actions = u.recipes.map(r => r.replace(/^cmd:/u, ''));
    const cmds = u.recipes.map(r => recipes.get(r.replace(/^cmd:/u, '')) ?? r);
    u.signature = metaStrip(JSON.stringify([nodes.map(n => n.kind), d.edges, cmds]), onto, u.fromAgent ?? gid);
    out.push(u);
  }
  return out;
}

async function collectCode(repo: string, onto: Ontology): Promise<Unit[]> {
  const out: Unit[] = [];
  for (const rel of onto.adjacent_code) {
    const p = join(repo, rel);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const u = blank(`code:${rel}`, 'code', rel.replace(/^src\//u, '').replace(/\.ts$/u, ''), rel);
    u.lines = text.split('\n').length; u.codePaths.push({ path: rel, lines: u.lines }); u.mtimeMs = statSync(p).mtimeMs;
    u.prompts.push({ kind: 'header', text: headerComment(text) });
    u.signature = metaStrip(text.replace(/\/\/.*$/gmu, ''), onto);
    out.push(u);
  }
  // Guardian sub-agents are data (SUB_AGENTS) — each is its own unit with its declared `absorbs`.
  const subs = join(repo, 'src', 'guardian-agent', 'subagents.ts');
  if (existsSync(subs)) {
    const { SUB_AGENTS } = (await import(subs)) as { SUB_AGENTS: ReadonlyArray<{ id: string; name: string; duty: string; absorbs: readonly string[]; kpi: string; rights: readonly string[]; everyMin: number | null }> };
    for (const s of SUB_AGENTS) {
      const u = blank(`code:guardian/${s.id}`, 'code', `guardian/${s.id}`, 'src/guardian-agent/subagents.ts');
      u.owner = 'RES'; u.detectors = [s.duty]; u.actions = [...s.rights]; u.kpis = [s.kpi]; u.absorbs = [...s.absorbs];
      u.prompts.push({ kind: 'description', text: `${s.name} ${s.duty} ${s.kpi} ${s.rights.join(' ')}` });
      u.triggers.push({ id: `guardian/${s.id}`, kind: 'cadence', spec: s.everyMin === null ? 'event' : `${s.everyMin}m` });
      out.push(u);
    }
  }
  return out;
}

function collectScripts(seatState: string, onto: Ontology): { units: Unit[]; allText: string } {
  const re = new RegExp(onto.script_name, 'iu');
  const units: Unit[] = []; const texts: string[] = [];
  if (!existsSync(seatState)) return { units, allText: '' };
  for (const seat of readdirSync(seatState)) {
    const tools = join(seatState, seat, 'tools');
    if (!existsSync(tools)) continue;
    for (const p of walk(tools, [], n => n.startsWith('.') || n === '_archive' || n === 'logs' || n === 'evidence' || /\.bak/u.test(n))) {
      if (!/\.(sh|ts|py|mjs|js|zsh)$/u.test(p) && !/^[^.]+$/u.test(basename(p))) continue;
      const text = readSafe(p);
      if (!text) continue;
      texts.push(text);
      if (!re.test(basename(p))) continue;
      const rel = `${seat}/${relative(tools, p)}`;
      const u = blank(`script:${rel}`, 'script', basename(p), relative(seatState, p));
      u.owner = seat; u.lines = text.split('\n').length; u.mtimeMs = statSync(p).mtimeMs;
      u.prompts.push({ kind: 'header', text: headerComment(text.replace(/^#!.*\n/u, '')) || basename(p) });
      u.signature = metaStrip(text, onto, basename(p).replace(/\.\w+$/u, ''));
      units.push(u);
    }
  }
  return { units, allText: texts.join('\n') };
}

/** crontab lines and launchd plists → trigger rows on the unit they run (matched by script basename · graph id · agent id). */
function attachSchedules(units: Unit[], src: Sources): Unit[] {
  const lines: Array<{ id: string; kind: string; spec: string }> = [];
  for (const l of (src.crontab ?? '').split('\n')) if (l.trim() && !l.trim().startsWith('#')) lines.push({ id: `cron:${lines.length}`, kind: 'crontab', spec: l.trim() });
  if (src.launchdDir && existsSync(src.launchdDir))
    for (const f of readdirSync(src.launchdDir).filter(f => f.endsWith('.plist') && /elanous/iu.test(f))) {
      const t = readSafe(join(src.launchdDir, f));
      if (!/<key>(StartInterval|StartCalendarInterval|KeepAlive)<\/key>/u.test(t)) continue;
      lines.push({ id: `launchd:${f.replace(/\.plist$/u, '')}`, kind: 'launchd', spec: t.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim() });
    }
  const extra: Unit[] = [];
  for (const s of lines) {
    const hits = units.filter(u => {
      const key = u.kind === 'script' ? basename(u.path) : u.kind === 'agent' ? `agent ${u.name} ` : u.kind === 'graph' ? ` ${u.name}` : '';
      return key && (s.spec + ' ').includes(key);
    });
    for (const u of hits) u.triggers.push(s);
    if (!hits.length) { const u = blank(`schedule:${s.id}`, 'schedule', s.id, s.kind); u.prompts.push({ kind: 'description', text: s.spec }); u.triggers.push(s); extra.push(u); }
  }
  return extra;
}

/** Ticks/acts/KPI movement in the last 7 days: trigger registry fires ⊕ each agent's own case ledger (tick rows). */
function attachLiveness(units: Unit[], src: Sources): void {
  const now = (src.now ?? new Date()).getTime();
  const since = new Date(now - 7 * DAY_MS).toISOString();
  const reg = src.stateRoot ? join(src.stateRoot, 'graph-trigger-registry.db') : '';
  if (reg && existsSync(reg)) {
    const db = new Database(reg, { readonly: true });
    try {
      const rows = db.query('SELECT graph_id AS g, COUNT(*) AS n, MAX(dispatched_at) AS last FROM graph_trigger_fires WHERE window >= ? GROUP BY graph_id').all(since) as Array<{ g: string; n: number; last: string | null }>;
      const fires = new Map(rows.map(r => [r.g, r]));
      const registered = new Set((db.query('SELECT graph_id AS g FROM graph_trigger_registry').all() as Array<{ g: string }>).map(r => r.g));
      for (const u of units) {
        const ids = u.kind === 'agent' ? (u.triggers.length ? u.triggers.map(t => t.id) : [u.name]) : u.kind === 'graph' || u.kind === 'shim' ? [u.name] : [];
        if (!ids.length || !ids.some(i => registered.has(i))) continue;
        u.ticks7d = ids.reduce((n, i) => n + (fires.get(i)?.n ?? 0), 0);
        u.lastAt = ids.map(i => fires.get(i)?.last ?? '').sort().pop() || null;
      }
    } finally { db.close(); }
  }
  for (const u of units.filter(x => x.kind === 'agent')) {
    const f = src.stateRoot ? join(src.stateRoot, 'loop-agents', u.name, 'cases.jsonl') : '';
    if (!f || !existsSync(f)) continue;
    let ticks = 0, acts = 0, actRows = 0; const vals = new Set<string>();
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (!l.includes('"kind":"tick"')) continue;
      let r: Dict; try { r = JSON.parse(l) as Dict; } catch { continue; }
      if (str(r.at) < since) continue;
      ticks += 1;
      const why = str(r.why);
      const a = /행동 (\d+)\//u.exec(why); if (a) { acts += Number(a[1]); actRows += 1; }
      const k = /^\S+ (-?[\d.]+)/u.exec(why); if (k) vals.add(k[1]!);
    }
    u.ticks7d = Math.max(u.ticks7d ?? 0, ticks); u.acts7d = actRows ? acts : null; u.kpiDistinct7d = actRows ? vals.size : null;
  }
}

/** Tag watches / acts edges from the ontology (word lists) over the unit's detectors · description · actions. */
export function ontologyEdges(u: Unit, onto: Ontology): Array<[string, string, string]> {
  const e: Array<[string, string, string]> = [];
  const low = (s: string) => s.toLowerCase();
  const watchText = low([u.name, ...u.detectors, ...u.kpis, ...u.prompts.filter(p => p.kind !== 'knowhow').map(p => p.text.slice(0, 1500))].join(' '));
  const actText = low([...u.actions, ...u.recipes].join(' ') || watchText);
  for (const [t, words] of Object.entries(onto.targets)) if (words.some(w => watchText.includes(low(w)))) e.push([u.id, 'watches', t]);
  for (const [a, words] of Object.entries(onto.actions)) if (words.some(w => actText.includes(low(w)))) e.push([u.id, 'acts', a]);
  for (const k of u.kpis) e.push([u.id, 'measures', k]);
  for (const t of u.triggers) e.push([t.id, 'fires', u.id]);
  for (const a of u.absorbs) e.push([u.id, 'absorbs', a]);
  if (u.fromAgent) e.push([u.id, 'shim_of', `agent:${u.fromAgent}`]);
  return e;
}

export async function collectUnits(src: Sources, onto = loadOntology()): Promise<{ units: Unit[]; scriptText: string }> {
  const recipes = recipesOf(src.repoRoot);
  const units = [...collectAgents(src.repoRoot, onto), ...collectGraphs(src.repoRoot, onto, recipes), ...(await collectCode(src.repoRoot, onto))];
  const scripts = src.seatStateRoot ? collectScripts(src.seatStateRoot, onto) : { units: [], allText: '' };
  units.push(...scripts.units);
  units.push(...attachSchedules(units, src));
  attachLiveness(units, src);
  // One id defined twice (e.g. the same graph_id in two files) = two definitions of one job: keep both rows, tagged `@path`.
  const seen = new Map<string, number>();
  for (const u of units) { const n = seen.get(u.id) ?? 0; seen.set(u.id, n + 1); if (n) { u.absorbs.push(u.id); u.id = `${u.id}@${u.path}`; } }
  return { units, scriptText: scripts.allText };
}

export interface StageCopy { family: string; stage: string; file: string; line: number; name: string; lines: number; body: string }
const FN_RE = /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>)/u;
/** Stage copies: every named function whose name carries a family word, in a file under a stage's dirs (non-test). */
export function collectStageCopies(repo: string, onto: Ontology): StageCopy[] {
  const out: StageCopy[] = [];
  for (const [stage, dirs] of Object.entries(onto.stages ?? {})) for (const d of dirs) for (const f of walk(join(repo, d)).filter(p => p.endsWith('.ts') && !/\.(test|sim\.test)\.ts$/u.test(p) && !p.endsWith('.d.ts'))) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      const m = FN_RE.exec(l); const name = m?.[1] ?? m?.[2];
      if (!name) return;
      const low = name.toLowerCase();
      const family = Object.entries(onto.functions ?? {}).find(([, ws]) => ws.some(w => low.includes(w)))?.[0];
      if (!family) return;
      let depth = 0, end = i, seen = false;
      for (let j = i; j < Math.min(lines.length, i + 200); j += 1) {
        for (const ch of lines[j]!.replace(/(['"`])(?:\\.|(?!\1).)*\1/gu, '')) { if (ch === '{') { depth += 1; seen = true; } else if (ch === '}') depth -= 1; }
        end = j; if (seen && depth <= 0) break; if (!seen && j > i && /;\s*$/u.test(lines[j]!)) break;
      }
      out.push({ family, stage, file: relative(repo, f), line: i + 1, name, lines: end - i + 1, body: lines.slice(i, end + 1).join('\n') });
    });
  }
  return out;
}

const SCHEMA = `
CREATE TABLE units(id TEXT PRIMARY KEY, kind TEXT, name TEXT, path TEXT, owner TEXT, lines INT, ticks7d INT, acts7d INT, kpi_distinct7d INT, last_at TEXT, mtime TEXT, signature TEXT);
CREATE TABLE detectors(unit TEXT, detector TEXT); CREATE TABLE actions(unit TEXT, action TEXT); CREATE TABLE kpis(unit TEXT, kpi TEXT);
CREATE TABLE triggers(unit TEXT, trigger_id TEXT, kind TEXT, spec TEXT); CREATE TABLE prompts(unit TEXT, kind TEXT, text TEXT);
CREATE TABLE policies(unit TEXT, key TEXT, value TEXT); CREATE TABLE code_paths(unit TEXT, path TEXT, lines INT);
CREATE TABLE edges(src TEXT, rel TEXT, dst TEXT);
CREATE TABLE stage_copies(family TEXT, stage TEXT, file TEXT, line INT, name TEXT, lines INT, body TEXT);
CREATE VIRTUAL TABLE docs USING fts5(unit UNINDEXED, text, tokenize = 'trigram');`;

/** Write the snapshot (RDB ⊕ FTS5). `path` = ':memory:' in tests. */
export function writeIndex(path: string, units: readonly Unit[], onto = loadOntology(), copies: readonly StageCopy[] = []): Database {
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = MEMORY;');
  for (const t of ['stage_copies', 'units', 'detectors', 'actions', 'kpis', 'triggers', 'prompts', 'policies', 'code_paths', 'edges', 'docs']) db.exec(`DROP TABLE IF EXISTS ${t};`);
  db.exec(SCHEMA);
  const ins = (sql: string) => db.prepare(sql);
  const iu = ins('INSERT INTO units VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'), id_ = ins('INSERT INTO detectors VALUES (?,?)'), ia = ins('INSERT INTO actions VALUES (?,?)'),
    ik = ins('INSERT INTO kpis VALUES (?,?)'), it = ins('INSERT INTO triggers VALUES (?,?,?,?)'), ip = ins('INSERT INTO prompts VALUES (?,?,?)'),
    ipo = ins('INSERT INTO policies VALUES (?,?,?)'), ic = ins('INSERT INTO code_paths VALUES (?,?,?)'), ie = ins('INSERT INTO edges VALUES (?,?,?)'), idoc = ins('INSERT INTO docs VALUES (?,?)');
  db.transaction(() => {
    for (const u of units) {
      iu.run(u.id, u.kind, u.name, u.path, u.owner, u.lines, u.ticks7d, u.acts7d, u.kpiDistinct7d, u.lastAt, u.mtimeMs ? new Date(u.mtimeMs).toISOString() : null, u.signature);
      for (const x of u.detectors) id_.run(u.id, x);
      for (const x of u.actions) ia.run(u.id, x);
      for (const x of u.kpis) ik.run(u.id, x);
      for (const t of u.triggers) it.run(u.id, t.id, t.kind, t.spec);
      for (const p of u.prompts) ip.run(u.id, p.kind, p.text);
      for (const [k, v] of Object.entries(u.policies)) ipo.run(u.id, k, v);
      for (const c of u.codePaths) ic.run(u.id, c.path, c.lines);
      const es = ontologyEdges(u, onto);
      for (const e of es) ie.run(...e);
      idoc.run(u.id, docText(u, es, onto.concept_weight ?? 0));
    }
    const isc = ins('INSERT INTO stage_copies VALUES (?,?,?,?,?,?,?)');
    for (const c of copies) isc.run(c.family, c.stage, c.file, c.line, c.name, c.lines, c.body);
  })();
  return db;
}
/** The BM25/vector document: the unit's own words ⊕ (④ «same job, different words») its watched/acted concepts as tokens. */
const docText = (u: Unit, es: ReadonlyArray<[string, string, string]> = [], weight = 0): string => {
  const concepts = es.filter(e => e[0] === u.id && (e[1] === 'watches' || e[1] === 'acts')).map(e => `concept_${e[1]}_${e[2]}`);
  const own = [u.name, ...u.detectors, ...u.actions, ...u.kpis, ...u.prompts.map(p => p.text)].join('\n').slice(0, 20_000);
  return weight > 0 && concepts.length ? `${own}\n${concepts.flatMap(c => Array<string>(weight).fill(c)).join(' ')}` : own;
};

export interface PairScore { a: string; b: string; rdb: number; bm25: number; cos: number; onto: number }
export interface Cluster { id: number; target: string; units: string[]; keep: string; retire: string[]; pairs: PairScore[]; why: string; confirmed: string | null }
export interface Family { signature: string; units: string[]; axes: string[]; lines: number }
export interface StageFamily { family: string; stages: Record<string, number>; copies: number; lines: number; nearPairs: Array<{ a: string; b: string; cos: number }>; kit: string | null }
export interface FamilyScore { family: string; units: string[]; missing: string[]; rdb: number; bm25: number; cos: number; onto: number; lines: number }
export interface UnitRow { id: string; kind: string; owner: string; ticks7d: number | null; acts7d: number | null; cluster: number | null; variant: number | null; family: string | null; verdict: string }
export interface Analysis {
  stageFamilies: StageFamily[]; copies: Array<Omit<StageCopy, 'body'>>; familyScores: FamilyScore[]; rows: UnitRow[]; confirmed: number;
  units: number; byKind: Record<string, number>; clusters: Cluster[]; families: Family[];
  dead: Array<{ unit: string; why: string }>; edgePolicies: Array<{ key: string; agents: number; value: string; readByCode: boolean }>;
}

const jac = (a: Set<string>, b: Set<string>): number => { if (!a.size && !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i += 1; return i / (a.size + b.size - i); };
const KIND_RANK: Record<UnitKind, number> = { agent: 5, code: 4, graph: 3, shim: 1, script: 2, schedule: 0 };

/** BM25 neighbours: each unit's 12 rarest words as an OR query over the FTS5 table → normalized [0,1] by the best hit. */
export function bm25Scores(db: Database, ids: readonly string[]): Map<string, Map<string, number>> {
  const docs = new Map((db.query('SELECT unit, text FROM docs').all() as Array<{ unit: string; text: string }>).map(r => [r.unit, r.text]));
  const df = new Map<string, number>();
  const words = new Map<string, Set<string>>();
  for (const [u, t] of docs) { const w = new Set(t.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(x => x.length >= 3)); words.set(u, w); for (const x of w) df.set(x, (df.get(x) ?? 0) + 1); }
  const out = new Map<string, Map<string, number>>();
  const q = db.query('SELECT unit, bm25(docs) AS s FROM docs WHERE docs MATCH ? ORDER BY s LIMIT 40');
  for (const u of ids) {
    const own = [...(words.get(u) ?? [])];
    // ④ the unit's concept tokens always join its 12 rarest words (common by design — rarity alone would drop them)
    const terms = [...new Set([...own.filter(w => (df.get(w) ?? 0) > 1 && !w.startsWith('concept_')).sort((x, y) => (df.get(x)! - df.get(y)!) || x.localeCompare(y)).slice(0, 12), ...own.filter(w => w.startsWith('concept_'))])];
    const m = new Map<string, number>();
    if (terms.length) {
      let rows: Array<{ unit: string; s: number }> = [];
      try { rows = q.all(terms.map(t => `"${t.replace(/"/gu, '')}"`).join(' OR ')) as typeof rows; } catch { rows = []; }
      const best = Math.min(...rows.map(r => r.s), -1e-9);
      for (const r of rows) if (r.unit !== u) m.set(r.unit, Math.round((r.s / best) * 100) / 100);
    }
    out.set(u, m);
  }
  return out;
}

export async function analyze(db: Database, opts: { now?: Date; codeText?: string; srcText?: string; deadDays?: number } = {}): Promise<Analysis> {
  const { hashEmbed } = await import('../../ux-sim/search-bench/docs-index.js');
  const onto0 = loadOntology();
  const th = onto0.thresholds ?? {};
  const units = db.query('SELECT * FROM units').all() as Array<{ id: string; kind: UnitKind; name: string; owner: string; lines: number; ticks7d: number | null; acts7d: number | null; kpi_distinct7d: number | null; mtime: string | null; signature: string }>;
  const edges = db.query('SELECT src, rel, dst FROM edges').all() as Array<{ src: string; rel: string; dst: string }>;
  const set = (u: string, rel: string) => new Set(edges.filter(e => e.src === u && e.rel === rel).map(e => e.dst));
  const rows = (t: string, col: string) => { const m = new Map<string, Set<string>>(); for (const r of db.query(`SELECT unit, ${col} AS v FROM ${t}`).all() as Array<{ unit: string; v: string }>) { const s = m.get(r.unit) ?? new Set(); s.add(r.v.toLowerCase()); m.set(r.unit, s); } return m; };
  const acts = rows('actions', 'action'), kpis = rows('kpis', 'kpi'), trigs = rows('triggers', 'spec');
  // RDB facts = the rows two units can literally share: a watched file in a trigger predicate · a KPI · an action id · a recipe.
  const FILE_RE = /\{(?:stateroot|seatstate)\}\/[\w./-]+/giu;
  // ④ action ids are also normalized to their ontology class (two units «restart» / «wake-peer» share the row act:nudge).
  const facts = (u: string) => new Set([...(trigs.get(u) ?? [])].flatMap(t => t.match(FILE_RE) ?? []).concat([...(kpis.get(u) ?? [])].map(k => `kpi:${k}`), [...(acts.get(u) ?? [])].map(a => `act:${a}`), [...set(u, 'acts')].map(a => `act:${a}`)));
  const docs = new Map((db.query('SELECT unit, text FROM docs').all() as Array<{ unit: string; text: string }>).map(r => [r.unit, r.text]));
  const vec = new Map([...docs].map(([u, t]) => [u, hashEmbed(t)]));
  const cos = (a: string, b: string) => { const x = vec.get(a)!, y = vec.get(b)!; let s = 0; for (let i = 0; i < x.length; i += 1) s += x[i]! * y[i]!; return Math.round(s * 100) / 100; };
  const supervisorIds = units.filter(u => u.kind !== 'schedule').map(u => u.id);
  const bm = bm25Scores(db, supervisorIds);
  const absorbs = edges.filter(e => e.rel === 'absorbs');
  const absorbed = (a: string, b: string) => absorbs.some(e => (e.src === a && b.endsWith(e.dst)) || (e.src === b && a.endsWith(e.dst)));
  const shimPair = (a: string, b: string) => edges.some(e => e.rel === 'shim_of' && ((e.src === a && e.dst === b) || (e.src === b && e.dst === a)));
  // Pairs: share a watched target and an action class (RDB/ontology) and agree by words or meaning — or are near-identical text,
  // or one declares it absorbs the other (two owners for one job).
  const pairs: PairScore[] = [];
  const ids = supervisorIds.filter(u => !u.startsWith('graph:') || units.find(x => x.id === u)?.kind !== 'shim');
  // ④ edge weight: a shared watched target AND a shared action class is the strong signal (0.5 + overlap/2); one alone is weak.
  const score = (a: string, b: string): PairScore => {
    const wa = set(a, 'watches'), wb = set(b, 'watches'), aa = set(a, 'acts'), ab = set(b, 'acts');
    const both = jac(wa, wb) > 0 && jac(aa, ab) > 0;
    const onto = Math.round(((both ? 0.5 : 0) + (jac(wa, wb) + jac(aa, ab)) / 4) * 100) / 100;
    return { a, b, rdb: Math.round(jac(facts(a), facts(b)) * 100) / 100, bm25: Math.max(bm.get(a)?.get(b) ?? 0, bm.get(b)?.get(a) ?? 0), cos: cos(a, b), onto };
  };
  for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
    const a = ids[i]!, b = ids[j]!;
    const p = score(a, b);
    const sameJob = p.onto >= (th.onto ?? 0.75) && (p.cos >= (th.cos ?? 0.7) || p.bm25 >= (th.bm25 ?? 0.6));
    if (sameJob || p.cos >= (th.near ?? 0.95) || absorbed(a, b) || shimPair(a, b)) {
      pairs.push(p);
    }
  }
  // Average linkage (no chaining): strongest pairs first; a unit joins a cluster only when it pairs with ≥ half its members ·
  // a declared absorb / shim pair always joins (two owners of one job).
  const linked = new Set(pairs.map(p => `${p.a}|${p.b}`)); const has = (x: string, y: string) => linked.has(`${x}|${y}`) || linked.has(`${y}|${x}`);
  const forced = (x: string, y: string) => absorbed(x, y) || shimPair(x, y);
  const where = new Map<string, string[]>(); const groupsList: string[][] = [];
  for (const p of [...pairs].sort((x, y) => (y.cos + y.bm25 + y.onto) - (x.cos + x.bm25 + x.onto) || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))) {
    const ga = where.get(p.a), gb = where.get(p.b);
    if (!ga && !gb) { const g = [p.a, p.b]; groupsList.push(g); where.set(p.a, g); where.set(p.b, g); continue; }
    if (ga && gb) continue;
    const g = (ga ?? gb)!; const x = ga ? p.b : p.a;
    if (forced(p.a, p.b) || g.filter(m => has(m, x)).length * 2 >= g.length) { g.push(x); where.set(x, g); }
  }
  const groups = new Map(groupsList.map((g, i) => [String(i), g]));
  const unit = (id: string) => units.find(u => u.id === id)!;
  const alive = (id: string) => { const u = unit(id); return KIND_RANK[u.kind] * 10 + Math.log10(1 + (u.ticks7d ?? 0)) * 3 + Math.log10(1 + (u.acts7d ?? 0)) * 5 + ((kpis.get(id)?.size ?? 0) ? 5 : 0); };
  const clusters: Cluster[] = [...groups.values()].filter(g => g.length > 1).map((g, n) => {
    const sorted = [...g].sort((x, y) => alive(y) - alive(x) || x.localeCompare(y));
    const t = new Map<string, number>(); for (const u of g) for (const w of set(u, 'watches')) t.set(w, (t.get(w) ?? 0) + 1);
    const target = [...t].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '—';
    const fam = Object.entries(onto0.families ?? {}).find(([, us]) => g.some(u => us.includes(u)))?.[0];
    const conf = fam ? `family ${fam}` : (onto0.confirmed ?? []).find(c => g.some(u => u.startsWith(c.match)))?.verdict ?? null;
    return { id: n + 1, target, units: sorted, keep: sorted[0]!, retire: sorted.slice(1), pairs: pairs.filter(p => g.includes(p.a)), why: `keep = most alive (kind · ticks · acts · KPI)`, confirmed: conf };
  }).sort((x, y) => Number(y.units.some(u => !u.startsWith('script:'))) - Number(x.units.some(u => !u.startsWith('script:'))) || y.units.length - x.units.length || x.target.localeCompare(y.target));
  clusters.forEach((c, i) => { c.id = i + 1; });
  // Commonization families: the same shape once meta (numbers · kingdom · phase · quoted text · own id) is stripped.
  const fam = new Map<string, string[]>();
  for (const u of units) if (u.signature && u.kind !== 'schedule') fam.set(`${u.kind}|${u.signature}`, [...(fam.get(`${u.kind}|${u.signature}`) ?? []), u.id]);
  const families: Family[] = [...fam].filter(([, g]) => g.length > 1).map(([sig, g]) => ({ signature: sig.slice(0, 120), units: g, axes: axesOf(db, g), lines: g.reduce((n, u) => n + unit(u).lines, 0) }))
    .sort((x, y) => y.lines - x.lines);
  // Dead: registered/scheduled but 0 ticks in 7d · agents whose KPI never moved and never acted · scripts nobody runs or names.
  const now = (opts.now ?? new Date()).getTime();
  const deadDays = opts.deadDays ?? 14;
  const trig = rows('triggers', 'kind');
  const dead: Analysis['dead'] = [];
  for (const u of units) {
    if (u.ticks7d === 0) dead.push({ unit: u.id, why: '0 fires/ticks in 7d (registered)' });
    else if (u.kind === 'agent' && (u.ticks7d ?? 0) > 0 && u.acts7d === 0 && (u.kpi_distinct7d ?? 0) <= 1) dead.push({ unit: u.id, why: `ticks ${u.ticks7d} · acts 0 · KPI one value in 7d` });
    else if (u.kind === 'graph' && u.ticks7d === null && !(trig.get(u.id) ?? new Set()).has('crontab')) dead.push({ unit: u.id, why: 'loop graph not in the trigger registry nor crontab' });
    else if (u.kind === 'script' && !trig.get(u.id)?.has('crontab') && !trig.get(u.id)?.has('launchd') && u.mtime && now - Date.parse(u.mtime) > deadDays * DAY_MS
      && (opts.codeText ?? '').split(u.name).length - 1 <= 1) dead.push({ unit: u.id, why: `unscheduled · unreferenced · untouched ${deadDays}d+` });
  }
  // Edge-only / boilerplate policy keys: same value in every agent (an executor default) or never read by any code.
  const pol = db.query("SELECT key, value, COUNT(*) AS n FROM policies WHERE unit LIKE 'agent:%' GROUP BY key, value").all() as Array<{ key: string; value: string; n: number }>;
  const nAgents = units.filter(u => u.kind === 'agent').length;
  const edgePolicies = pol.filter(p => p.n >= Math.max(3, nAgents - 3)).map(p => ({ key: p.key, agents: p.n, value: p.value, readByCode: (opts.srcText ?? '').includes(p.key) }));
  const byKind: Record<string, number> = {}; for (const u of units) byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
  // Stage axis: one function family copied per stage — near-identical bodies across DIFFERENT stages are the kit candidates.
  const copies = db.query('SELECT family, stage, file, line, name, lines, body FROM stage_copies').all() as Array<StageCopy>;
  const stageFamilies: StageFamily[] = [...new Set(copies.map(c => c.family))].map(family => {
    const cs = copies.filter(c => c.family === family);
    const stages: Record<string, number> = {}; for (const c of cs) stages[c.stage] = (stages[c.stage] ?? 0) + 1;
    const v = cs.map(c => hashEmbed(metaStrip(c.body.replace(c.name, '<FN>'), loadOntology())));
    const nearPairs: StageFamily['nearPairs'] = [];
    for (let i = 0; i < cs.length; i += 1) for (let j = i + 1; j < cs.length; j += 1) {
      if (cs[i]!.stage === cs[j]!.stage || cs[i]!.lines < 4 || cs[j]!.lines < 4) continue;
      let d = 0; for (let k = 0; k < v[i]!.length; k += 1) d += v[i]![k]! * v[j]![k]!;
      if (d >= 0.6) nearPairs.push({ a: `${cs[i]!.file}:${cs[i]!.line} ${cs[i]!.name}`, b: `${cs[j]!.file}:${cs[j]!.line} ${cs[j]!.name}`, cos: Math.round(d * 100) / 100 });
    }
    const kitCopy = cs.find(c => c.stage === 'kit');
    return { family, stages, copies: cs.length, lines: cs.reduce((n, c) => n + c.lines, 0), nearPairs: nearPairs.sort((x, y) => y.cos - x.cos), kit: kitCopy ? `${kitCopy.file}:${kitCopy.line}` : null };
  }).sort((x, y) => Object.keys(y.stages).length - Object.keys(x.stages).length || y.copies - x.copies);
  // ② declared families: the four numbers over every pair inside the family (units missing from this snapshot are listed).
  const known = new Set(units.map(u => u.id));
  const familyScores: FamilyScore[] = Object.entries(onto0.families ?? {}).map(([family, us]) => {
    const ok = us.filter(u => known.has(u) && docs.has(u)); const ps: PairScore[] = [];
    for (let i = 0; i < ok.length; i += 1) for (let j = i + 1; j < ok.length; j += 1) ps.push(score(ok[i]!, ok[j]!));
    const avg = (k: 'rdb' | 'bm25' | 'cos' | 'onto') => (ps.length ? Math.round((ps.reduce((n, p) => n + p[k], 0) / ps.length) * 100) / 100 : 0);
    return { family, units: ok, missing: us.filter(u => !known.has(u)), rdb: avg('rdb'), bm25: avg('bm25'), cos: avg('cos'), onto: avg('onto'), lines: ok.reduce((n, u) => n + unit(u).lines, 0) };
  });
  // ① every unit, one row: cluster · commonization variant · declared family · verdict.
  const deadSet = new Set(dead.map(d => d.unit));
  const rowsOut: UnitRow[] = units.map(u => {
    const c = clusters.find(x => x.units.includes(u.id)); const v = families.findIndex(f => f.units.includes(u.id));
    const fam = Object.entries(onto0.families ?? {}).find(([, us]) => us.includes(u.id))?.[0] ?? null;
    const verdict = deadSet.has(u.id) ? 'dead' : c?.keep === u.id ? 'keep' : c ? 'retire' : v >= 0 ? 'variant' : '—';
    return { id: u.id, kind: u.kind, owner: u.owner, ticks7d: u.ticks7d, acts7d: u.acts7d, cluster: c?.id ?? null, variant: v >= 0 ? v + 1 : null, family: fam, verdict };
  }).sort((x, y) => x.kind.localeCompare(y.kind) || x.id.localeCompare(y.id));
  return { units: units.length, byKind, clusters, families, dead, edgePolicies, stageFamilies, familyScores, rows: rowsOut,
    copies: copies.map(({ body: _b, ...c }) => c).sort((x, y) => x.family.localeCompare(y.family) || x.stage.localeCompare(y.stage) || x.file.localeCompare(y.file) || x.line - y.line),
    confirmed: clusters.filter(c => c.confirmed).length };
}

/** Which meta axes differ inside a family (threshold · kingdom · phase · text · target name) — the instance YAML parameters. */
function axesOf(db: Database, ids: readonly string[]): string[] {
  const onto = loadOntology();
  const texts = ids.map(id => (db.query('SELECT group_concat(text, char(10)) AS t FROM prompts WHERE unit = ?').get(id) as { t: string | null }).t ?? '');
  const axes = new Set<string>(['target']);
  const differs = (re: RegExp) => new Set(texts.map(t => (t.match(re) ?? []).sort().join(','))).size > 1;
  if (differs(/\b\d+(?:\.\d+)?\b/gu)) axes.add('threshold');
  if (differs(new RegExp(`\\b(${onto.scopes.join('|')})\\b`, 'gu'))) axes.add('kingdom');
  if (differs(new RegExp(onto.phases.join('|'), 'gu'))) axes.add('phase');
  if (new Set(texts).size > 1) axes.add('text');
  return [...axes];
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
/** Markdown report (SCQA head + tables) from one analysis. */
export function renderReport(a: Analysis, meta: { db: string; at: string; top?: number; rows?: boolean }): string {
  const top = meta.top ?? 10;
  const L: string[] = [];
  L.push(`# LOOP-AGENT 중복 색인 — ${meta.at}`, '', `> 칸: LOOP-AGENTS-AS-PLUGINS · 색인 DB \`${meta.db}\` · 단위 ${a.units}개 (${Object.entries(a.byKind).map(([k, v]) => `${k} ${v}`).join(' · ')}) · 생성 \`eln loop index\``, '',
    `진척: 확정 군집 ${a.confirmed}/${a.clusters.length} (${pct(a.confirmed, a.clusters.length)})`, '');
  L.push('## 가족 점수 (ontology.yaml families · 가족 안 쌍 평균)', '', '| 가족 | 단위 | RDB | BM25 | 벡터 | 온톨로지 | 줄 | 스냅샷에 없음 |', '|---|---|---|---|---|---|---|---|');
  for (const f of a.familyScores) L.push(`| ${f.family} | ${f.units.length} | ${f.rdb.toFixed(2)} | ${f.bm25.toFixed(2)} | ${f.cos.toFixed(2)} | ${f.onto.toFixed(2)} | ${f.lines} | ${f.missing.join(' ') || '—'} |`);
  L.push('');
  const shown = meta.rows ? a.clusters : a.clusters.slice(0, top);
  L.push(`## 중복 군집 (${a.clusters.length})${meta.rows ? '' : ` — 상위 ${top}`}`, '', '| # | 대상 | 단위 수 | 남김 | 은퇴 후보 | RDB | BM25 | 벡터 | 온톨로지 | 확정 |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const c of shown) {
    const avg = (k: keyof PairScore) => (c.pairs.length ? (c.pairs.reduce((n, p) => n + (p[k] as number), 0) / c.pairs.length).toFixed(2) : '—');
    L.push(`| ${c.id} | ${c.target} | ${c.units.length} | \`${c.keep}\` | ${c.retire.map(r => `\`${r}\``).join(' ')} | ${avg('rdb')} | ${avg('bm25')} | ${avg('cos')} | ${avg('onto')} | ${c.confirmed ?? '—'} |`);
  }
  L.push('', `## 공용화 군집 (${a.families.length}) — 메타만 다른 변종`, '', '| 단위 수 | 줄 | 파라미터 축 | 단위 |', '|---|---|---|---|');
  for (const f of a.families.slice(0, top)) L.push(`| ${f.units.length} | ${f.lines} | ${f.axes.join('·')} | ${f.units.slice(0, 12).map(u => `\`${u}\``).join(' ')}${f.units.length > 12 ? ` …+${f.units.length - 12}` : ''} |`);
  const scripts = a.byKind.script ?? 0, deadScripts = a.dead.filter(d => d.unit.startsWith('script:')).length;
  L.push('', `## 죽은 단위 (${a.dead.length}) — 운영 스크립트 감시 ${deadScripts}/${scripts} (${pct(deadScripts, scripts)})`, '', '| 단위 | 근거 |', '|---|---|');
  for (const d of a.dead.filter(x => !x.unit.startsWith('script:'))) L.push(`| \`${d.unit}\` | ${d.why} |`);
  if (deadScripts) L.push(`| (스크립트 ${deadScripts}개) | ${a.dead.filter(d => d.unit.startsWith('script:')).slice(0, 15).map(d => `\`${d.unit.replace('script:', '')}\``).join(' ')}${deadScripts > 15 ? ' …' : ''} |`);
  L.push('', `## 엣지·상용구 정책 키 (${a.edgePolicies.length}) — 모든 에이전트가 같은 값`, '', '| 키 | 값 | 에이전트 수 | 코드가 읽음 |', '|---|---|---|---|');
  for (const p of a.edgePolicies) L.push(`| ${p.key} | ${p.value} | ${p.agents} | ${p.readByCode ? '예' : '아니오'} |`);
  L.push('', `## 단계(stage) 축 — 단계 안에 박힌 같은 로직 (${a.stageFamilies.length} 가족)`, '', '| 기능 가족 | 단계별 사본 | 사본 · 줄 | 키트 정본 | 단계 넘어 닮은 본문(cos ≥ 0.6 · 사람 확인) |', '|---|---|---|---|---|');
  for (const f of a.stageFamilies) L.push(`| ${f.family} | ${Object.entries(f.stages).map(([k, v]) => `${k} ${v}`).join(' · ')} | ${f.copies} · ${f.lines} | ${f.kit ?? '없음'} | ${f.nearPairs.length} 쌍${f.nearPairs.slice(0, 3).map(p => `<br>\`${p.a}\` ≈ \`${p.b}\` (${p.cos})`).join('')} |`);
  if (meta.rows) {
    const kits = loadOntology().function_kits ?? {};
    L.push('', `## 부록 A — 단계 축 사본 전수 (${a.copies.length})`, '', '| 가족 | 단계 | file:line | 함수 | 줄 | 키트 후보 |', '|---|---|---|---|---|---|');
    for (const c of a.copies) L.push(`| ${c.family} | ${c.stage} | \`${c.file}:${c.line}\` | ${c.name} | ${c.lines} | ${kits[c.family] ?? '—'} |`);
    L.push('', `## 부록 B — 감독 단위 전수 (${a.rows.length})`, '', '| 단위 | 종류 | 주인 | fires·ticks/7d | 행동/7d | 군집 | 변종 | 가족 | 판정 |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of a.rows) L.push(`| \`${r.id}\` | ${r.kind} | ${r.owner || '—'} | ${r.ticks7d ?? '—'} | ${r.acts7d ?? '—'} | ${r.cluster ?? '—'} | ${r.variant ?? '—'} | ${r.family ?? '—'} | ${r.verdict} |`);
  }
  return `${L.join('\n')}\n`;
}
