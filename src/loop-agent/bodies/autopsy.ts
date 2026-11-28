// autopsy (부검반 · L0 OP) — LOOP-AGENT v2 body. Stage 3 of the run lifecycle (detect → diagnose → autopsy).
//
// 세 얼굴:
//   관측 = deaths in the last 24h from three ledgers: land refusals (land-graph ledger `refused` ⊕ live `decision refuse`,
//          src/land-graph/land-graph.ts readLedger), closed-unmerged PRs (gh), discarded runs (run-ledger stop / run-status
//          failed). KPI unclassified_deaths = deaths with no row in the autopsy ledger ⊕ rows whose class is still
//          `unclassified` (null when any source cannot be read — never «0»).
//   판단 근거 = structured causes first: the land refusal class (RefusalClass · classifyLandExit on the refusal line), the
//          run stop class / last node outcome, the PR's own last land refusal; only a closed PR with none of these falls
//          back to its closing text (supersede / split / duplicate), else it stays `unclassified` and counts.
//          RFC-run-doctor-and-postmortem §4 E3: «같은 원인 ≥3» → a cell, so the class turns into structure.
//   수복과 인계 = `classify` writes up to classify_batch rows into its own ledger (<home>/autopsy.jsonl · undo = removal
//          rows); `open-cell` opens one release-checklist cell per class seen ≥ cell_repeat times in 7 days (one cell per
//          class ever · ≤ cells_per_day a day · undo = `eln release checklist rm <id>`). Deaths it cannot classify stay a
//          KPI breach → one card to OP.
//   DETECT-TO-ACTION (11-28 · KPI ≥ 1 for 18 h with «행동 0/0»): the five «unclassified» closed PRs of 11-27 (#40363 #40415
//          #40430 #40438 #40475) all carried their cause in the CLOSING COMMENT («Superseded by #40441» · «중복이라 닫는다» ·
//          «분할로 대체» …) — the reader took only the PR body. The text now includes the last comments, and a death whose row says
//          `unclassified` but whose fresh evidence classifies gets `reclassify` (a newer row for the same id — the ladder step
//          that was missing; a death with still no evidence stays unclassified and goes to OP, never a guess).
import { join } from 'node:path';
import type { BodyEnv } from '../registry.js';
import type { ActionResult, AgentBody, BodyCtx, Observation, PlannedAction, Subject } from '../runtime.js';
import { agentHome } from '../memory.js';
import { readJsonlFile, scanRunLedgers } from './run-lifecycle-shared.js';
import { pn } from '../policy-context.js';


export type DeathKind = 'land-refused' | 'pr-closed' | 'run-died';
export interface Death {
  readonly id: string; readonly kind: DeathKind; readonly ref: string; readonly at: string;
  /** Structured cause when the source has one (RefusalClass · stop class · node outcome · prior refusal of the PR). */
  readonly cls: string | null;
  /** Bounded free text (refusal line · closing comment) — used only when cls is null. */
  readonly text: string;
}
export interface AutopsyRow { readonly id: string; readonly at: string; readonly kind: DeathKind; readonly ref: string; readonly cls: string; readonly basis: 'structured' | 'text' | 'none'; readonly removed?: boolean }
export interface CellRow { readonly cls: string; readonly cellId: string; readonly at: string; readonly removed?: boolean }

export interface AutopsyDeps {
  /** Deaths in the window, and the names of sources that could not be read (any → KPI unknown). */
  deaths(now: Date): { deaths: Death[]; unknown: string[] };
  rows(): AutopsyRow[];
  record(rows: readonly AutopsyRow[]): void;
  cells(): CellRow[];
  openCell(cellId: string, title: string, body: string, source: string): { ok: boolean; line: string };
  recordCell(c: CellRow): void;
}

/** Cause class of one death — structured first, closing text second, else `unclassified`. */
export function classifyDeath(d: Death): { cls: string; basis: AutopsyRow['basis'] } {
  const prefix = d.kind === 'land-refused' ? 'land' : d.kind === 'pr-closed' ? 'pr' : 'run';
  if (d.cls) return { cls: `${prefix}:${d.cls}`, basis: 'structured' };
  if (d.kind === 'pr-closed') {
    const t = d.text;
    if (/supersed|replaced by|대체|→\s*#\d+/iu.test(t)) return { cls: 'pr:superseded', basis: 'text' };
    if (/duplicate|중복/iu.test(t)) return { cls: 'pr:duplicate', basis: 'text' };
    if (/abandon|수확하지 않|폐기/iu.test(t)) return { cls: 'pr:abandoned', basis: 'text' };
    if (/\bsplit\b|쪼개|쪼갬|나눠|분할/iu.test(t)) return { cls: 'pr:split', basis: 'text' };
    if (/24h|stale|오래된/iu.test(t)) return { cls: 'pr:stale-24h', basis: 'text' };
    // the harness close-triage line is a structured marker of our own producer («멈춘 사유 <reason>») — last resort
    const stop = /멈춘 사유 ([a-z][a-z0-9-]*)/u.exec(t)?.[1];
    if (stop) return { cls: `pr:harness-stop:${stop}`, basis: 'text' };
  }
  return { cls: 'unclassified', basis: 'none' };
}

/** The deaths in `ids` whose LATEST row still says `unclassified` (a newer row for the same id wins · reclassify). */
export function stuckRows(rows: readonly AutopsyRow[], ids: ReadonlySet<string>): AutopsyRow[] {
  const latest = new Map<string, AutopsyRow>();
  for (const r of rows) latest.set(r.id, r);
  return [...latest.values()].filter(r => r.cls === 'unclassified' && ids.has(r.id));
}

/** Cells this agent opened in the last 24 h (the cells_per_day budget). */
export const cellsToday = (cells: readonly CellRow[], now: Date): number => cells.filter(c => !c.removed && now.getTime() - Date.parse(c.at) < 86_400_000).length; // 출처: cells_per_day = 하루(24h) 창 · RFC-run-doctor-and-postmortem §4 E3
export const cellIdFor = (cls: string): string => `AUTOPSY-${cls.toUpperCase().replace(/[^A-Z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48)}`;

export function liveDeps(stateRoot: string): AutopsyDeps {
  const home = agentHome(stateRoot, 'autopsy');
  const rowsPath = join(home, 'autopsy.jsonl');
  const cellsPath = join(home, 'cells.jsonl');
  const fs = require('node:fs') as typeof import('node:fs');
  const { homedir } = require('node:os') as typeof import('node:os');
  const append = (p: string, rows: readonly unknown[]): void => { if (!rows.length) return; fs.mkdirSync(home, { recursive: true }); fs.appendFileSync(p, rows.map(r => `${JSON.stringify(r)}\n`).join('')); };
  const fold = <T extends { removed?: boolean }>(rows: T[], key: (r: T) => string): T[] => {
    const gone = new Set(rows.filter(r => r.removed).map(key));
    return rows.filter(r => !r.removed && !gone.has(key(r)));
  };
  const gh = (args: string[]): string | null => {
    try {
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
      const repo = (process.env.GH_REPO ?? '').trim();
      const cwd = join(homedir(), 'elanous-hq', 'repo.git');
      const r = spawnSync('gh', [...args, ...(repo ? ['--repo', repo] : [])], { encoding: 'utf8', timeout: 30_000, ...(repo || !fs.existsSync(cwd) ? {} : { cwd }) });
      return r.status === 0 ? r.stdout : null;
    } catch { return null; }
  };
  return {
    deaths(now) {
      const since = now.getTime() - pn('window_h') * 3_600_000;
      const deaths: Death[] = []; const unknown: string[] = [];
      // land refusals (+ last refusal per PR, used to explain closed PRs)
      const lastRefusal = new Map<number, string>();
      try {
        const lg = require('../../land-graph/land-graph.js') as typeof import('../../land-graph/land-graph.js');
        if (!fs.existsSync(join(lg.landHome(stateRoot), 'ledger.jsonl'))) unknown.push('land-graph');
        else {
          const seen = new Set<string>();
          for (const r of lg.readLedger(stateRoot)) {
            const isRefusal = r.event === 'refused' || (r.event === 'decision' && r.action === 'refuse');
            if (!isRefusal || r.synthetic || r.mode !== 'live') continue;
            const cls = r.cls ?? lg.classifyLandExit(1, r.why ?? '') ?? null;
            if (cls) lastRefusal.set(r.pr, cls);
            if (Date.parse(r.at) < since) continue;
            const id = `land:${r.pr}:${String(r.head).slice(0, 12)}:${cls ?? '?'}`;
            if (seen.has(id)) continue;
            seen.add(id);
            deaths.push({ id, kind: 'land-refused', ref: `pr:${r.pr}`, at: r.at, cls, text: String(r.why ?? '').slice(0, 300) });
          }
        }
      } catch { unknown.push('land-graph'); }
      // closed-unmerged PRs
      const out = gh(['pr', 'list', '--state', 'closed', '--limit', '80', '--json', 'number,closedAt,mergedAt,title,body,comments']);
      if (out === null) unknown.push('gh');
      else {
        try {
          for (const p of JSON.parse(out) as Array<{ number: number; closedAt?: string; mergedAt?: string | null; title?: string; body?: string; comments?: Array<{ body?: string }> }>) {
            if (p.mergedAt || !p.closedAt || Date.parse(p.closedAt) < since) continue;
            const prior = lastRefusal.get(p.number);
            deaths.push({ id: `pr:${p.number}`, kind: 'pr-closed', ref: `pr:${p.number}`, at: p.closedAt, cls: prior ? `refused-then-closed:${prior}` : null,
              // the closing comment comes FIRST (the closer's own reason · 11-27 all five «unclassified» had it there), then the body tail
              text: `${(p.comments ?? []).slice(-2).reverse().map(c => (c.body ?? '').slice(0, 400)).join('\n')}\n${p.title ?? ''}\n${(p.body ?? '').slice(-600)}` });
          }
        } catch { unknown.push('gh'); }
      }
      // discarded runs
      const runs = scanRunLedgers(join(stateRoot, 'run-ledger'), since);
      if (!runs) unknown.push('run-ledger');
      else for (const r of runs) {
        if (!r.terminal?.failed || Date.parse(r.terminal.at) < since) continue;
        const cls = r.terminal.kind === 'stop' ? r.terminal.cls : r.lastNodeOutcome ? `${r.graphId}:${r.lastNodeOutcome}` : r.stage ? `${r.graphId}@${r.stage}` : null;
        deaths.push({ id: `run:${r.runId}`, kind: 'run-died', ref: `run:${r.runId}`, at: r.terminal.at, cls, text: '' });
      }
      return { deaths, unknown };
    },
    rows: () => fold(readJsonlFile<AutopsyRow>(rowsPath), r => r.id),
    record: rows => append(rowsPath, rows),
    cells: () => fold(readJsonlFile<CellRow>(cellsPath), c => c.cellId),
    openCell(cellId, title, body, source) {
      try {
        // the same universe as this process (spawnElanousSync stamps the state root) — never a hard-coded binary
        const { spawnElanousSync } = require('../../instance/spawn-elanous.js') as typeof import('../../instance/spawn-elanous.js');
        const r = spawnElanousSync(['release', 'checklist', 'add', cellId, title, '--owner', 'OP', '--kind', 'code', '--priority', 'P2', '--body', body, '--source', source],
          { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELANOUS_TRACK: 'OP' } });
        const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-1)[0] ?? '';
        return r.status === 0 ? { ok: true, line: `칸 ${cellId} 추가` } : { ok: false, line: `칸 ${cellId} 추가 실패 rc=${r.status} ${tail.slice(0, 160)}` };
      } catch (e) { return { ok: false, line: `칸 추가 실패 — ${e instanceof Error ? e.message : String(e)}` }; }
    },
    recordCell: c => append(cellsPath, [c]),
  };
}

export function createBody(env: BodyEnv, deps: AutopsyDeps = liveDeps(env.stateRoot)): AgentBody {
  const pending = (deaths: readonly Death[], rows: readonly AutopsyRow[]): Death[] => {
    const have = new Map(rows.map(r => [r.id, r] as const));
    return deaths.filter(d => !have.has(d.id));
  };
  const repeatedClasses = (rows: readonly AutopsyRow[], nowMs: number): Map<string, AutopsyRow[]> => {
    const by = new Map<string, AutopsyRow[]>();
    for (const r of rows) {
      if (r.cls === 'unclassified' || nowMs - Date.parse(r.at) > pn('cell_window_days') * 86_400_000) continue;
      by.set(r.cls, [...(by.get(r.cls) ?? []), r]);
    }
    return new Map([...by].filter(([, v]) => v.length >= pn('cell_repeat')));
  };

  const observe = (ctx: BodyCtx): Observation => {
    const nowMs = ctx.now.getTime();
    const { deaths, unknown } = deps.deaths(ctx.now);
    const rows = deps.rows();
    const ids = new Set(deaths.map(d => d.id));
    const todo = pending(deaths, rows);
    const stuck = stuckRows(rows, ids);
    const byId = new Map(deaths.map(d => [d.id, d] as const));
    const fixable = stuck.filter(r => { const d = byId.get(r.id); return !!d && classifyDeath(d).cls !== 'unclassified'; });
    const subjects: Subject[] = [];
    for (const d of todo.slice(0, 30)) subjects.push({ id: d.id, kind: `death-${d.kind}`, summary: `${d.ref} 미분류 (${d.cls ?? '구조 원인 없음'})`, ageMin: (nowMs - Date.parse(d.at)) / 60_000 });
    for (const r of stuck.slice(0, 10)) {
      const fix = fixable.includes(r);
      subjects.push({ id: r.id, kind: fix ? 'death-reclassifiable' : 'death-unclassified', summary: fix ? `${r.ref} 미분류 행 — 새 근거로 분류 가능(${classifyDeath(byId.get(r.id)!).cls})` : `${r.ref} 원인 근거 없음 — 사람 판정 필요`, ageMin: (nowMs - Date.parse(r.at)) / 60_000 });
    }
    const cells = new Set(deps.cells().map(c => c.cls));
    const repeated = repeatedClasses(rows, nowMs);
    for (const [cls, rs] of repeated) if (!cells.has(cls)) subjects.push({ id: `cls:${cls}`, kind: 'repeat-class', summary: `${cls} ${rs.length}회/${pn('cell_window_days')}일 — 칸 없음`, ageMin: 0 });
    const today = cellsToday(deps.cells(), ctx.now);
    const counts = new Map<string, number>();
    for (const d of deaths) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
    const facts = [`사망 ${deaths.length} (창 ${pn('window_h')}h · ${[...counts].map(([k, v]) => `${k} ${v}`).join(' · ') || '없음'})`, `미분류 대기 ${todo.length} · 근거 없음 ${stuck.length - fixable.length} · 새 근거로 재분류 가능 ${fixable.length}`,
      `반복 꼴 ${repeated.size} · 칸 연 꼴 ${cells.size} · 오늘 연 칸 ${today}/${pn('cells_per_day')}${today >= pn('cells_per_day') ? ' — 나머지 꼴은 내일' : ''}`, ...(unknown.length ? [`읽기 실패: ${unknown.join(', ')} — KPI 모름`] : [])];
    // patterns: one per class among deaths not yet classified (each death counted once)
    const pseen = new Set<string>(); const patterns: { key: string; lesson: string }[] = [];
    for (const d of todo) {
      const c = classifyDeath(d).cls;
      if (c === 'unclassified' || pseen.has(c)) continue;
      pseen.add(c); patterns.push({ key: `death:${c}`, lesson: `${c} 사망이 반복된다 — 같은 꼴 ${pn('cell_repeat')}회면 구조 칸으로 옮긴다(부검 E3).` });
    }
    return { kpi: unknown.length ? null : todo.length + stuck.length, subjects, facts, patterns };
  };

  const plan = (obs: Observation, ctx: { now: Date }): PlannedAction[] => {
    const out: PlannedAction[] = [];
    if (obs.subjects.some(s => s.kind.startsWith('death-') && s.kind !== 'death-unclassified' && s.kind !== 'death-reclassifiable')) out.push({ action: 'classify', target: 'pending', why: `미분류 사망 — 최대 ${pn('classify_batch')}건 분류` });
    const re = obs.subjects.filter(s => s.kind === 'death-reclassifiable');
    if (re.length) out.push({ action: 'reclassify', target: 'stuck', why: `미분류 행 ${re.length}건에 새 근거(닫는 댓글 등) — ${re.slice(0, 3).map(s => s.id).join(' ')}` });
    // SUPERVISOR-JOURNAL-DEFECTS (11-27 journal: open-cell failed 29× on «오늘 칸 2개 — 하루 한도 2»): the daily cap is a plan
    // input, not an action failure — plan only as many cells as today's budget leaves; the rest wait (a fact line, no row).
    const left = Math.max(0, pn('cells_per_day') - cellsToday(deps.cells(), ctx.now));
    for (const s of obs.subjects.filter(x => x.kind === 'repeat-class').slice(0, left)) out.push({ action: 'open-cell', target: s.id, why: s.summary });
    return out;
  };

  const actions: AgentBody['actions'] = {
    classify: {
      describe: `미분류 사망을 최대 ‹classify_batch›건 원인 분류해 부검 원장(autopsy.jsonl)에 쓴다 — 구조 원인(거부 꼴·stop 꼴) 먼저 · 되돌림: 같은 id 의 removed 행`,
      run(_target, ctx): ActionResult {
        const { deaths } = deps.deaths(ctx.now);
        const todo = pending(deaths, deps.rows()).slice(0, pn('classify_batch'));
        if (!todo.length) return { ok: true, line: '분류할 사망 없음' };
        const at = ctx.now.toISOString();
        const rows = todo.map(d => { const c = classifyDeath(d); return { id: d.id, at, kind: d.kind, ref: d.ref, cls: c.cls, basis: c.basis } satisfies AutopsyRow; });
        deps.record(rows);
        const un = rows.filter(r => r.cls === 'unclassified').length;
        const top = [...rows.reduce((m, r) => m.set(r.cls, (m.get(r.cls) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${c}×${n}`).join(' · ');
        return { ok: true, line: `부검 ${rows.length}건 분류(근거 없음 ${un}) — ${top}`, ref: `autopsy:${rows[0]!.id}`, undo: `autopsy.jsonl 에 {id, removed:true} 행: ${rows.map(r => r.id).slice(0, 5).join(', ')}${rows.length > 5 ? ` 외 ${rows.length - 5}` : ''}` };
      },
    },
    reclassify: {
      describe: '원장에 «미분류»로 남은 사망 중 새 근거(닫는 댓글·구조 꼴)로 이제 분류되는 것에 새 행을 쓴다(같은 id · 최신 행이 이긴다) — 근거가 여전히 없으면 건드리지 않는다 · 되돌림: 같은 id 의 removed 행',
      run(_target, ctx): ActionResult {
        const { deaths } = deps.deaths(ctx.now);
        const byId = new Map(deaths.map(d => [d.id, d] as const));
        const at = ctx.now.toISOString();
        const rows = stuckRows(deps.rows(), new Set(byId.keys())).flatMap(r => {
          const d = byId.get(r.id)!; const c = classifyDeath(d);
          return c.cls === 'unclassified' ? [] : [{ id: d.id, at, kind: d.kind, ref: d.ref, cls: c.cls, basis: c.basis } satisfies AutopsyRow];
        });
        if (!rows.length) return { ok: false, line: '재분류할 미분류 행 없음(새 근거 없음)' };
        deps.record(rows);
        return { ok: true, line: `미분류 ${rows.length}건 재분류 — ${rows.slice(0, 5).map(r => `${r.ref}→${r.cls}`).join(' · ')}${rows.length > 5 ? ` 외 ${rows.length - 5}` : ''}`, ref: `autopsy:${rows[0]!.id}`,
          undo: `autopsy.jsonl 에 {id, removed:true} 행: ${rows.map(r => r.id).slice(0, 5).join(', ')}` };
      },
    },
    'open-cell': {
      describe: `같은 원인 꼴이 ‹cell_window_days›일에 ‹cell_repeat›회 넘으면 그 꼴의 구조 칸 하나를 연다(꼴당 평생 1칸 · 하루 ‹cells_per_day›칸) — 되돌림: eln release checklist rm <칸>`,
      run(target, ctx): ActionResult {
        const cls = target.replace(/^cls:/u, '');
        const cells = deps.cells();
        if (cells.some(c => c.cls === cls)) return { ok: false, line: `${cls}: 이미 칸이 있다` };
        const today = cellsToday(cells, ctx.now);
        if (today >= pn('cells_per_day')) return { ok: false, line: `${cls}: 오늘 칸 ${today}개 — 하루 한도 ${pn('cells_per_day')}` };
        const rs = repeatedClasses(deps.rows(), ctx.now.getTime()).get(cls);
        if (!rs) return { ok: false, line: `${cls}: 다시 세니 ${pn('cell_repeat')}회 미만` };
        const cellId = cellIdFor(cls);
        const refs = rs.slice(-6).map(r => r.ref).join(' ');
        const r = deps.openCell(cellId, `[부검] ${cls} 반복 ${rs.length}회 — 구조 수리`,
          `부검반: ${pn('cell_window_days')}일 안 같은 원인 꼴 ${cls} ${rs.length}회. 사례 ${refs}. 처방을 반복하지 말고 이 꼴이 생기는 구조를 고친다.`, `loop:autopsy ${refs}`);
        if (r.ok) deps.recordCell({ cls, cellId, at: ctx.now.toISOString() });
        return { ok: r.ok, line: r.line, ref: `cell:${cellId}`, ...(r.ok ? { undo: `eln release checklist rm ${cellId}` } : {}) };
      },
    },
  };
  return { observe, plan, actions };
}
