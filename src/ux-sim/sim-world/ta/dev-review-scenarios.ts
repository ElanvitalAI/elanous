// SIM-WORLD ta · DEV-REVIEW-COMMON (0.3.40 P0 · 대표 11-28 18:2x «TA 든 손 탭이든 이 로직은 공용화되어야 공회전이 사라진다»).
// The three review units (graphs/review/{cell-review,pre-impl,post-impl}.yaml) replayed on the REAL code: the real claim
// (workNext), the real detached claim door (startCellReviewDetached), the real judge functions (decomposeDoneCriterion ·
// classifyBoardRequirements · assessCriterionForSign) and — engine graph — the real graph runner on the unit YAML. Only the
// outside is faked: the LLM (answers like the live model), the board (an in-memory map) and the CLI entry the claim spawns.
// Engines: legacy = the kit functions composed in TS (the TA's in-process path) · graph = runGraph on the unit files with the
// handler set. Five seeded variants per scene (cell id · title words · edge text) from ctx.seed. Expectations are literals
// built from how the world was made (rule 11: FU ids are computed here with node:crypto, not with the product's edgeFuCell).
// Nothing outside ctx.universeRoot is opened.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { classifyBoardRequirements, decomposeDoneCriterion } from '../../../kit/requirement-judge/index.js';
import { assessCriterionForSign, DEFAULT_SIGN_POLICY } from '../../../kit/requirement-judge/sign-decision.js';
import {
  createDevReviewHandlers, defaultDevReviewPolicy, postImplCheck, preImplSplit, reviewCellCriterion,
  type CellReviewDeps, type DevReviewLedgerRow, type DevReviewPorts, type FuCell,
} from '../../../kit/dev-review/index.js';
import { onWorkClaimed, runReviewUnit, startCellReviewDetached } from '../../../kit/dev-review/live.js';
import { getElanousConfigDirOverride } from '../../../elanous-config-dir.js';
import { workNext, type BoardCell } from '../../../steward/space/work-next.js';
import { loadGraphTemplates } from '../../../self-implement/graph-yaml.js';
import { resolveGraphUnit } from '../../../self-implement/graph-unit-resolver.js';
import { readJourneyEdge } from '../../../self-dev/graph-journey-route.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const REPO = resolve(import.meta.dir, '../../../..');
const AT = Date.parse('2026-11-28T09:30:00.000Z');
const SEEDS = 5;
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const WORDS = ['hold ledger', 'land receipt', 'seat mail', 'goal precheck', 'pool lease', 'butler voice', 'rail watch', 'board roster'] as const;

/** Seeded variant: a cell id, its title words and an edge clause — no Math.random. */
function variant(ctx: SimWorldScenarioContext, i: number): { cell: string; words: string; edge: string } {
  const pick = Math.floor(ctx.random() * 1_000_000) + i;
  const words = WORDS[pick % WORDS.length]!;
  return { cell: `SIM-DR-${(pick % 97).toString(36).toUpperCase()}${i}`, words, edge: `${words} 화면 문구 정리` };
}
const fuId = (cell: string, text: string) => `${cell}-FU-${createHash('sha256').update(text).digest('hex').slice(0, 8).toUpperCase()}`;

// ── the outside: an LLM answering the judge kit's prompts and the criterion author ─────────────────────────────────────
type Judge = (reqs: ReadonlyArray<{ id: string; text: string; classification?: string }>, evidenceIds: readonly string[]) => unknown[];
/** decompose: «엣지(FU): …» up to the next « · » is the one edge segment; the rest is must (exact source cover). */
function fakeLlm(judge: Judge, calls: { n: number }) {
  return async (prompt: string): Promise<string> => {
    calls.n++;
    const line = (tag: string) => prompt.split('\n').find(l => l.startsWith(tag))!.slice(tag.length);
    if (prompt.startsWith('Split the criterion')) {
      const c = JSON.parse(line('Criterion: ')) as string;
      const i = c.indexOf('엣지(FU):');
      if (i < 0) return JSON.stringify({ segments: [{ text: c, classification: 'must' }] });
      const j = c.indexOf(' · ', i) < 0 ? c.length : c.indexOf(' · ', i);
      const segs = [{ text: c.slice(0, i), classification: 'must' }, { text: c.slice(i, j), classification: 'edge' }, ...(j < c.length ? [{ text: c.slice(j), classification: 'must' }] : [])].filter(s => s.text);
      return JSON.stringify({ segments: segs });
    }
    if (prompt.startsWith('Independently audit')) return JSON.stringify({ approved: true, reason: 'segments keep their meaning' });
    const input = JSON.parse(line('Input: ')) as { requirements: Array<{ id: string; text: string; classification?: string }>; evidence: Array<{ id: string }> };
    return JSON.stringify({ requirements: judge(input.requirements, input.evidence.map(e => e.id)) });
  };
}
const writtenFor = (words: string, edge: string) =>
  `판정식: 시뮬 월드에서 ${words} 사건 주입 → 원장 한 줄이 관측되면 PASS (eln --test sim world run ta --only TA-DR1) · 필수: ${words} 동작이 원장에 남는다 · 엣지(FU): ${edge} · 실패 경로: 원장 쓰기 실패 → 거부 줄 한 개(필수)`;
/** The author: write = the literal three-section line · strengthen = original verbatim + missing sections · rewrite = a bad author. */
function fakeAuthor(mode: 'good' | 'rewrites', calls: { n: number }) {
  return async (prompt: string): Promise<string> => {
    calls.n++;
    const cell = JSON.parse(prompt.split('\n').find(l => l.startsWith('Cell: '))!.slice('Cell: '.length)) as { title: string; criterion?: string };
    const words = cell.title.split(' — ')[1] ?? cell.title;
    if (!cell.criterion) return JSON.stringify({ criterion: writtenFor(words, `${words} 화면 문구 정리`) });
    if (mode === 'rewrites') return JSON.stringify({ criterion: `판정식: 시뮬 에서 ${words} 확인 · 필수: 동작 · 실패 경로: 거부` });
    return JSON.stringify({ criterion: `${cell.criterion} · 판정식: 시뮬 월드에서 ${words} 주입 → 원장 한 줄 · 실패 경로: 쓰기 실패 → 거부 줄(필수)` });
  };
}

// ── the board: an in-memory checklist behind the kit's ports ───────────────────────────────────────────────────────────
interface Board { cells: Map<string, BoardCell & { owner?: string; status: string; evidence?: string }>; writes: Array<{ cell: string; after: string }>; fus: Map<string, string>; lines: Array<{ cell: string; line: string }>; ledger: DevReviewLedgerRow[] }
function boardPorts(b: Board): DevReviewPorts {
  return {
    write: true, now: () => new Date(AT),
    writeCriterion: (cell, before, after) => {
      const c = b.cells.get(cell);
      if (!c || (c.doneCriterion ?? '').trim() !== before.trim()) return false;
      b.cells.set(cell, { ...c, doneCriterion: after }); b.writes.push({ cell, after }); return true;
    },
    addFollowUp: (fu: FuCell) => { if (b.fus.has(fu.id) || b.cells.has(fu.id)) return 'exists'; b.fus.set(fu.id, fu.title); return 'added'; },
    appendEvidence: (cell, line) => { if (b.lines.some(l => l.cell === cell && l.line === line)) return true; b.lines.push({ cell, line }); return true; },
    record: (row) => { b.ledger.push(row); },
  };
}
const newBoard = (): Board => ({ cells: new Map(), writes: [], fus: new Map(), lines: [], ledger: [] });

/** Run cell-review then pre-impl on one engine; the answer is the two exits. */
async function reviewOnEngine(engine: SimWorldEngine, ctx: SimWorldScenarioContext, b: Board, cellId: string, deps: { decompose: CellReviewDeps['decompose']; author?: (p: string) => Promise<string> }, tag: string): Promise<{ cell: string; pre: string }> {
  const c = b.cells.get(cellId)!;
  const input = { id: c.id, title: c.title, ...(c.doneCriterion ? { doneCriterion: c.doneCriterion } : {}) };
  const ports = boardPorts(b);
  if (engine === 'legacy') {
    // the kit functions composed in TS — the TA's in-process path; the handlers' record step is the same port calls
    const handlers = createDevReviewHandlers({ ports, policy: defaultDevReviewPolicy, ...deps });
    const r = await reviewCellCriterion(input, { ...deps, policy: defaultDevReviewPolicy });
    const rec = await handlers['dev-review-record-cell']!({ input: {}, outputs: { criterion: { result: r } } } as never);
    const reqs = r.requirements;
    if (!reqs.length) return { cell: rec.outcome, pre: 'hold' };
    const s = preImplSplit({ cell: cellId, requirements: reqs }, defaultDevReviewPolicy);
    const open = await handlers['dev-review-open-fu']!({ input: {}, outputs: { 'core-edge': { result: s } } } as never);
    return { cell: rec.outcome, pre: open.outcome };
  }
  const saved = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = ctx.universeRoot;
  try {
    const cr = await runReviewUnit('cell-review', { cell: input, version: '9.9.9' }, { ports, policy: defaultDevReviewPolicy, root: ctx.universeRoot, runId: `${tag}-cell`, ...deps });
    const reqs = (cr.result as { requirements?: unknown[] } | undefined)?.requirements ?? [];
    if (!reqs.length) return { cell: String(cr.exit), pre: 'hold' };
    const pre = await runReviewUnit('pre-impl', { cell: cellId, requirements: reqs }, { ports, policy: defaultDevReviewPolicy, root: ctx.universeRoot, runId: `${tag}-pre` });
    return { cell: String(cr.exit), pre: String(pre.exit) };
  } finally { if (saved === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = saved; }
}
const allMust: Judge = (reqs, ev) => reqs.map(r => ({ id: r.id, classification: r.classification ?? 'must', fulfilled: true, evidenceIds: [ev[0]], reason: 'shown', gap: 'none', clause: '' }));

/** TA-DR1 · a hand claims a criterion-less cell → the claim spawns the review detached (≤ max_block_ms) → criterion written 1 → the edge FU opened now. */
const dr1: SimWorldScenario = {
  id: 'TA-DR1',
  title: 'work next claims a cell with no doneCriterion → detached cell-review (claim never waits) → criterion written once with 판정식·필수/엣지·실패 경로 → pre-impl opens the edge FU with the judge id',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS; i += 1) {
      const v = variant(ctx, i);
      const b = newBoard();
      b.cells.set(v.cell, { id: v.cell, title: `${v.cell} — ${v.words}`, status: 'yellow', updatedAt: new Date(AT - 3_600_000).toISOString(), priority: 'P0' });
      // the REAL claim (an unowned P0 cell · the live coordinator-held shape: 173 of 274 yellow 0.3.40 cells had no criterion)
      const claim = workNext('TC-H-SIM', { now: () => AT, version: '9.9.9', cells: () => [...b.cells.values()], scopeOf: () => 'TC', lastActiveMs: () => undefined,
        isCoordinator: (s) => s === 'TC', isJudge: () => false, requireDoneWhen: () => false,
        swap: (id, input) => { const c = b.cells.get(id); if (!c) return { outcome: 'missing' }; if ((c.owner ?? null) !== input.expectedOwner) return { outcome: 'lost' }; b.cells.set(id, { ...c, owner: input.to }); return { outcome: 'swapped' }; } });
      if (claim.code !== 0 || claim.cell.id !== v.cell) { misses.push(`${v.cell}: claim ${claim.code}`); continue; }
      if (i === 0) {
        // the claim door: a detached spawn of «work review cell <id> --version <v>» on the CLI entry (here a recorder script)
        const rec = join(ctx.universeRoot, 'spawn-argv.json');
        const script = join(ctx.universeRoot, 'entry.js');
        mkdirSync(ctx.universeRoot, { recursive: true });
        writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(rec)}, JSON.stringify(process.argv.slice(2)));\n`);
        // the hook `eln work next` runs on its result (work-next-cli.ts calls onWorkClaimed) — fed the REAL claim result
        const src = readFileSync(join(REPO, 'src/steward/space/work-next-cli.ts'), 'utf8');
        if (!/onWorkClaimed\(result, deps\.version\)/u.test(src)) misses.push('work-next-cli.ts no longer calls onWorkClaimed(result, deps.version)');
        if (onWorkClaimed({ code: 3 }, '9.9.9', () => ({ started: true, why: 'must not start' })) !== null) misses.push('exit 3 started a review');
        const t0 = performance.now();
        const door = onWorkClaimed(claim, '9.9.9', (id, ver) => startCellReviewDetached(id, ver, [process.execPath, script])) ?? { started: false, why: 'hook returned null on a claim' };
        const ms = performance.now() - t0;
        if (!door.started || ms > 1500) misses.push(`${v.cell}: claim door started=${door.started} in ${Math.round(ms)}ms (${door.why})`);
        for (let w = 0; w < 50 && !existsSync(rec); w += 1) await Bun.sleep(40);
        const argv = existsSync(rec) ? (JSON.parse(readFileSync(rec, 'utf8')) as string[]) : null;
        const universe = getElanousConfigDirOverride(); // an explicit test universe rides along with the spawn
        if (JSON.stringify(argv) !== JSON.stringify([...(universe ? ['--config-dir', universe] : []), 'work', 'review', 'cell', v.cell, '--version', '9.9.9'])) misses.push(`${v.cell}: spawned argv ${JSON.stringify(argv)}`);
      }
      const llm = { n: 0 }; const authored = { n: 0 };
      const callLLM = fakeLlm(allMust, llm);
      const out = await reviewOnEngine(ctx.engine, ctx, b, v.cell, { decompose: (id, c) => decomposeDoneCriterion(id, c, { callLLM }), author: fakeAuthor('good', authored) }, `dr1-${i}`);
      const want = writtenFor(v.words, v.edge);
      if (out.cell !== 'written') misses.push(`${v.cell}: cell-review → ${out.cell} (want written)`);
      if (b.writes.length !== 1 || b.writes[0]!.after !== want) misses.push(`${v.cell}: writes ${JSON.stringify(b.writes)} (want 1 × ${want})`);
      if (b.cells.get(v.cell)!.doneCriterion !== want) misses.push(`${v.cell}: board criterion ${b.cells.get(v.cell)!.doneCriterion}`);
      if (out.pre !== 'split') misses.push(`${v.cell}: pre-impl → ${out.pre} (want split)`);
      const edgeText = `엣지(FU): ${v.edge}`;
      const wantFu = { [fuId(v.cell, edgeText)]: `${v.cell} — ${edgeText}` };
      if (JSON.stringify(Object.fromEntries(b.fus)) !== JSON.stringify(wantFu)) misses.push(`${v.cell}: FU ${JSON.stringify(Object.fromEntries(b.fus))} (want ${JSON.stringify(wantFu)})`);
      // empty criterion: no split before the author · the written text is split + audited once (2 judge calls) · 1 author call
      if (llm.n !== 2 || authored.n !== 1) misses.push(`${v.cell}: llm ${llm.n} (want 2: decompose+review of the written text) · author ${authored.n} (want 1)`);
      if (!b.ledger.some(r => r.unit === 'cell-review' && r.outcome === 'written' && r.cell === v.cell)) misses.push(`${v.cell}: no written ledger row`);
    }
    ctx.recorder.event('ta-dr1', { engine: ctx.engine, seeds: SEEDS, misses: misses.length });
    return misses.length ? fail('criterion-less claim not reviewed', misses.join(' · ')) : { ok: true };
  },
};

/** TA-DR2 · a weak criterion (no 판정식/실패 경로) → strengthened append-only · an author that rewrites the words → untrusted, nothing written. */
const dr2: SimWorldScenario = {
  id: 'TA-DR2',
  title: 'weak criterion (sections missing) → strengthened: the old words stay verbatim first · an author that rewrites them → untrusted, the board keeps v1',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS; i += 1) {
      const v = variant(ctx, i);
      // odd variants carry a double space and a line break — append-only keeps them byte-for-byte
      const old = i % 2 ? `필수:  ${v.words} 가\n거부 줄을 남긴다` : `필수: ${v.words} 가 거부 줄을 남긴다`;
      for (const mode of ['good', 'rewrites'] as const) {
        const b = newBoard();
        b.cells.set(v.cell, { id: v.cell, title: `${v.cell} — ${v.words}`, status: 'yellow', updatedAt: new Date(AT).toISOString(), doneCriterion: old });
        const callLLM = fakeLlm(allMust, { n: 0 });
        const out = await reviewOnEngine(ctx.engine, ctx, b, v.cell, { decompose: (id, c) => decomposeDoneCriterion(id, c, { callLLM }), author: fakeAuthor(mode, { n: 0 }) }, `dr2-${mode}-${i}`);
        const after = b.cells.get(v.cell)!.doneCriterion;
        if (mode === 'good') {
          const want = `${old} · 판정식: 시뮬 월드에서 ${v.words} 주입 → 원장 한 줄 · 실패 경로: 쓰기 실패 → 거부 줄(필수)`;
          if (out.cell !== 'strengthened' || after !== want) misses.push(`${v.cell} good: ${out.cell} · ${after}`);
        } else if (out.cell !== 'untrusted' || after !== old || b.writes.length !== 0) misses.push(`${v.cell} rewrites: ${out.cell} · ${after} · writes ${b.writes.length}`);
      }
    }
    ctx.recorder.event('ta-dr2', { engine: ctx.engine, seeds: SEEDS, misses: misses.length });
    return misses.length ? fail('weak criterion not strengthened append-only', misses.join(' · ')) : { ok: true };
  },
};

/** TA-DR3 · first pregate: a PR whose diff misses the must → post-impl flags it (one cell line) BEFORE the judge; the judge's
 *  own sign decision on the same facts refuses with the same clause · a PR that meets the must but not the edge → edge FU now,
 *  and the judge's later sign names the same FU id (nothing new). */
const dr3: SimWorldScenario = {
  id: 'TA-DR3',
  title: 'post-impl on the first pregate: must missed by the diff → flagged before the judge (judge refuses with the same clause) · edge unmet → FU opened with the judge id (the sign adds none)',
  async run(ctx) {
    const misses: string[] = [];
    for (let i = 0; i < SEEDS; i += 1) {
      const v = variant(ctx, i);
      const criterion = writtenFor(v.words, v.edge);
      const mustClause = `${v.words} 동작이 원장에 남는다`;
      const edgeText = `엣지(FU): ${v.edge}`;
      const pr = 41_000 + i; const head = `${(i + 10).toString(16).repeat(6)}`.slice(0, 12).padEnd(40, 'a');
      // PR A touches only docs (the diff never reaches the ledger code) → the must is contradicted by PR-<n>
      const missJudge: Judge = (reqs, ev) => reqs.map(r => r.classification === 'must' && r.text.includes(mustClause)
        ? { id: r.id, classification: 'must', fulfilled: false, evidenceIds: [ev[0]], reason: 'the PR files never touch the ledger writer', gap: 'contradicted', clause: mustClause }
        : { id: r.id, classification: r.classification ?? 'must', fulfilled: r.classification !== 'edge', evidenceIds: r.classification === 'edge' ? [] : [ev[0]], reason: 'x', gap: r.classification === 'edge' ? 'not-shown' : 'none', clause: '' });
      // PR B meets every must, leaves the edge
      const edgeJudge: Judge = (reqs, ev) => reqs.map(r => ({ id: r.id, classification: r.classification ?? 'must', fulfilled: r.classification !== 'edge', evidenceIds: r.classification === 'edge' ? [] : [ev[0]], reason: 'x', gap: r.classification === 'edge' ? 'not-shown' : 'none', clause: '' }));
      for (const [name, judge, files] of [['miss', missJudge, ['docs/x.md']], ['edge', edgeJudge, [`src/${v.words.replace(/ /gu, '-')}.ts`]]] as const) {
        const b = newBoard();
        b.cells.set(v.cell, { id: v.cell, title: `${v.cell} — ${v.words}`, status: 'yellow', updatedAt: new Date(AT).toISOString(), doneCriterion: criterion });
        const callLLM = fakeLlm(judge, { n: 0 });
        const deps = { decompose: (id: string, c: string) => decomposeDoneCriterion(id, c, { callLLM }), judge: (inp: Parameters<typeof classifyBoardRequirements>[0]) => classifyBoardRequirements(inp, { callLLM }), signPolicy: DEFAULT_SIGN_POLICY };
        const facts = { merged: false, head, files, body: `칸: ${v.cell}` };
        let exit: string;
        // variant 0 also replays a board that refuses the FU write: the PR is not reviewed (incomplete → the scan retries it)
        if (name === 'edge' && i === 0) {
          const refusing = { ...boardPorts(b), addFollowUp: () => 'failed' as const };
          const r = await postImplCheck({ cell: v.cell, criterion, pr, head, facts }, { ...deps, policy: defaultDevReviewPolicy });
          const out = await createDevReviewHandlers({ ports: refusing, policy: defaultDevReviewPolicy })['dev-review-record-post']!({ input: {}, outputs: { check: { result: r } } } as never);
          const row = b.ledger.at(-1);
          if (out.outcome !== 'untrusted' || row?.outcome !== 'write-failed' || row?.incomplete !== true) misses.push(`${v.cell} edge refused FU: ${out.outcome} · row ${JSON.stringify(row).slice(0, 160)}`);
          b.ledger.length = 0; b.lines.length = 0;
        }
        if (ctx.engine === 'legacy') {
          const r = await postImplCheck({ cell: v.cell, criterion, pr, head, facts }, { ...deps, policy: defaultDevReviewPolicy });
          const handlers = createDevReviewHandlers({ ports: boardPorts(b), policy: defaultDevReviewPolicy });
          exit = (await handlers['dev-review-record-post']!({ input: {}, outputs: { check: { result: r } } } as never)).outcome;
        } else {
          const saved = process.env.ELANOUS_STATE_DIR; process.env.ELANOUS_STATE_DIR = ctx.universeRoot;
          try { exit = String((await runReviewUnit('post-impl', { cell: v.cell, criterion, pr, head, facts }, { ports: boardPorts(b), policy: defaultDevReviewPolicy, root: ctx.universeRoot, runId: `dr3-${name}-${i}`, ...deps })).exit); }
          finally { if (saved === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = saved; }
        }
        // the judge itself, later, on the same facts (body.ts evidence shape «PR-<n>» = JSON of the PR facts)
        const judged = await assessCriterionForSign({ cellId: v.cell, criterion, evidence: [{ id: `PR-${pr}`, text: JSON.stringify({ pr, ...facts }) }] }, { ...deps, policy: DEFAULT_SIGN_POLICY });
        if (name === 'miss') {
          const line = b.lines.find(l => l.cell === v.cell)?.line ?? '';
          if (exit !== 'flagged') misses.push(`${v.cell} miss: post-impl → ${exit} (want flagged)`);
          if (b.lines.length !== 1 || !line.startsWith(`[post-impl@1 · PR ${pr}@${head.slice(0, 12)}] 판정 예측 = 거절 — 필수 미충족 — «${mustClause}»`)) misses.push(`${v.cell} miss: lines ${JSON.stringify(b.lines)}`);
          if (judged.sign !== false || !judged.cited.some(c => c.clause === mustClause)) misses.push(`${v.cell} miss: judge ${JSON.stringify(judged).slice(0, 200)} (want refuse citing «${mustClause}»)`);
          if (b.fus.size !== 0) misses.push(`${v.cell} miss: FU ${JSON.stringify([...b.fus.keys()])} (want none — the must comes first)`);
        } else {
          const want = fuId(v.cell, edgeText);
          if (exit !== 'fu') misses.push(`${v.cell} edge: post-impl → ${exit} (want fu)`);
          if (JSON.stringify([...b.fus.keys()]) !== JSON.stringify([want])) misses.push(`${v.cell} edge: FU ${JSON.stringify([...b.fus.keys()])} (want [${want}])`);
          if (!judged.sign || judged.followUps.map(f => f.id).join(',') !== want) misses.push(`${v.cell} edge: judge FU ${judged.sign ? judged.followUps.map(f => f.id).join(',') : 'refused'} (want ${want} — the same cell, nothing new)`);
        }
      }
    }
    ctx.recorder.event('ta-dr3', { engine: ctx.engine, seeds: SEEDS, misses: misses.length });
    return misses.length ? fail('post-impl did not predict the judge', misses.join(' · ')) : { ok: true };
  },
};

/** TA-DR4 · the TA journey is unchanged: every existing exit routes where it did · the three review units resolve from
 *  implement-loop and every unit exit is mapped (engine legacy = the journey reader · engine graph = the unit resolver). */
const dr4: SimWorldScenario = {
  id: 'TA-DR4',
  title: 'TA journey unchanged — author ok → plan · decompose local → implement · gate pass → review · review fail → rework (as before) · cell-review@1 / pre-impl@1 / post-impl@1 resolve and every exit is mapped',
  async run(ctx) {
    const misses: string[] = [];
    const loaded = loadGraphTemplates(join(REPO, 'graphs'));
    const spec = loaded.templates['self-implement'];
    if (!spec) return fail('implement-loop unreadable', JSON.stringify(loaded.errors).slice(0, 300));
    const routes: Array<[string, string, string]> = [['author', 'ok', 'plan'], ['author', 're-authored', 'plan'], ['author', 'not-grounded', 're-ground'], ['author', 'fail', 'needs-human'],
      ['decompose', 'local', 'implement'], ['decompose', 'pod', 'pool-admit'], ['gate', 'pass', 'review'], ['gate', 'fail', 'rework'], ['review', 'fail', 'rework'], ['review', 'pass', 'main-sync']];
    const units: Array<[string, string, string[]]> = [['cell-review', 'cell-review@1', ['pass', 'written', 'strengthened', 'untrusted']], ['pre-impl', 'pre-impl@1', ['core', 'split', 'hold']], ['post-impl', 'post-impl@1', ['clean', 'fu', 'flagged', 'untrusted']]];
    for (let i = 0; i < SEEDS; i += 1) {
      const [from, label, to] = routes[Math.floor(ctx.random() * routes.length)]!;
      if (ctx.engine === 'legacy') {
        for (const [f, l, t] of [[from, label, to], ...routes.slice(i * 2, i * 2 + 2)] as Array<[string, string, string]>) {
          const r = readJourneyEdge(f, l, {}, { base: spec, overlays: [], profiles: [] });
          if (r.to !== t) misses.push(`${f} --${l}--> ${String(r.to)} (want ${t})`);
        }
        const [node, , exits] = units[i % 3]!;
        const r = readJourneyEdge(node, exits[0]!, {}, { base: spec, overlays: [], profiles: [] });
        if (!r.to) misses.push(`${node} exit ${exits[0]} unrouted`);
      } else {
        const [node, call, exits] = units[i % 3]!;
        const declared = spec.nodes.find(n => n.call === call);
        if (!declared) { misses.push(`${node}: no implement-loop node calls ${call}`); continue; }
        const unit = resolveGraphUnit(call, join(REPO, 'graphs', 'implement-loop.yaml'));
        if (JSON.stringify(unit.template.unit?.exits) !== JSON.stringify(exits)) misses.push(`${call}: exits ${JSON.stringify(unit.template.unit?.exits)}`);
        const out = spec.edges.find(e => e.from === node && e.on === 'outcome');
        const unmapped = exits.filter(x => !out?.map || !Object.hasOwn(out.map, x));
        if (unmapped.length) misses.push(`${node}: unmapped exits ${unmapped.join(',')}`);
      }
    }
    ctx.recorder.event('ta-dr4', { engine: ctx.engine, seeds: SEEDS, misses: misses.length });
    return misses.length ? fail('TA journey changed or units unresolved', misses.join(' · ')) : { ok: true };
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [dr1, dr2, dr3, dr4];
