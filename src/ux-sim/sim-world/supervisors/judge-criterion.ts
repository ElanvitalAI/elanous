// SIM-WORLD supervisors — JUDGE-NOT-OVERSTRICT (11-28 · greens 13/h → 1/h after #40661 put a doneCriterion LLM judgment in
// front of every butler sign: YAML-DEF-LOADER refused ×5 in 15 min «분해 불확실» ×2 · «필수 미충족» ×3 · a 48-cell replay of the
// day's signs through that gate signed 3). Each scene drives the REAL judge-butler wake (wakeButler → runTick → the shared kit
// assessCriterionForSign → the REAL decomposeDoneCriterion / classifyBoardRequirements) over facts from the REAL collector.
// Only the outside is faked: the LLM (a callLLM that answers like the live model did, or fails like a 429), gh pr view, the
// receipt reader, the checklist write and the FU ledger. Five seeds per scene, both engines (legacy v2 wake · graph v3 wake).
// Seed 1..5 replay live criterion texts (YAML-DEF-LOADER · LAND10-AUTOFIX-LANE · FED-ANALYST-LOOP-AGENT · JEV-MEMORY-RECALL · GOAL-AUTHORING-VERIFY-PLAN). Expectations are independent literals (rule 11).
import { classifyBoardRequirements, decomposeDoneCriterion } from '../../../kit/requirement-judge/index.js';
import type { CellIn } from '../../../judge-butler/done-when.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';
import { fail, row, same, wake, yellow, type CriterionSide, type FuLedger, type SimPr } from './judge-binding.js';

/** Per seed (1..5): the live doneCriterion of a cell signed or refused on 11-28 (copied from the 0.3.39 board). */
const LIVE_CRITERIA: readonly string[] = [
  'eln def lint 가 모르는 키·없는 사실 참조·박힌 호스트 이름을 file:line 오류 rc=1 로 거부 · 깨진 정의 설치 시 L0 한 줄 · 시험 리터럴',
  '합성 PR 4종(각 RED 꼴) → 자동 수리 커밋 → light pregate GREEN → 착지 줄 · 손 개입 0 · 시간당 자동 수리 수 KPI',
  // (JUDGE-SIM-RECEIPT: COND-WATCH's «시험 우주에서 합성 주입» now needs its E4 receipt — scene JB-SIM-E4 · this slot: FED-ANALYST-LOOP-AGENT)
  '30분마다 fed-ontology 6줄 산출이 루프 에이전트로 · Claude 분석과 3회 대조 일치 · eln OP 가 결과를 세계 카드로 받음 · @fed-analyst 대화 답',
  '그림자 24h 일치율 ≥ 90% · 전환 뒤 턴 앞 대기 중앙 1.5s → ≤ 0.5s · 하루 luna 회상 호출 0',
  '병합 #40390·#40391 영수 대조 · 골 저작 틀 lint 가 필수 절 3(판정식·필수/엣지·우주) 누락 골을 거부하고 갖춘 골은 통과(시험 원문 2건) · JUD 서명',
];
const criterionOf = (seed: number): string => LIVE_CRITERIA[((seed - 1) % 5 + 5) % 5]!;
const seeds = (s: number): number[] => [s, s + 1, s + 2, s + 3, s + 4];

type Judge = (requirements: ReadonlyArray<{ id: string; text: string }>, evidenceIds: readonly string[]) => unknown[];
interface FakeLlm { decompose: 'one-must' | 'review-rejects'; judge: Judge | 'throw'; down?: string }
/** The outside: an LLM answering the kit's three prompts (decompose · its review · the judgment) — or failing. */
function fakeLlm(f: FakeLlm, calls: { n: number }) {
  return async (prompt: string): Promise<string> => {
    calls.n++;
    if (f.down) throw new Error(f.down);
    const line = (tag: string) => prompt.split('\n').find(l => l.startsWith(tag))!.slice(tag.length);
    if (prompt.startsWith('Split the criterion')) return JSON.stringify({ segments: [{ text: JSON.parse(line('Criterion: ')) as string, classification: 'must' }] });
    if (prompt.startsWith('Independently audit')) return JSON.stringify(f.decompose === 'review-rejects' ? { approved: false, reason: 'the segment bundles several independent obligations; cannot confirm none is lost' } : { approved: true, reason: 'one must, meaning kept' });
    const input = JSON.parse(line('Input: ')) as { requirements: Array<{ id: string; text: string }>; evidence: Array<{ id: string }> };
    if (f.judge === 'throw') throw new Error('judge model overloaded');
    return JSON.stringify({ requirements: f.judge(input.requirements, input.evidence.map(e => e.id)) });
  };
}
function side(f: FakeLlm, calls: { n: number }, fus: FuLedger): CriterionSide {
  const callLLM = fakeLlm(f, calls);
  return {
    decomposeCriterion: (id, c) => decomposeDoneCriterion(id, c, { callLLM }),
    judgeCriterion: input => classifyBoardRequirements(input, { callLLM }),
    fus,
  };
}
const declared = (pr: number, cell: string): SimPr => ({ pr, title: `fix(x): ${cell.toLowerCase()}`, body: `칸: ${cell} (0.3.39 P0 · owner TC)`, headRef: `fix/${cell.toLowerCase()}` });
/** The cell with this doneCriterion — null = the key absent (the live «no criterion» shape). */
const withCriterion = (c: CellIn, criterion: string | null): CellIn =>
  Object.fromEntries(Object.entries({ ...c, doneCriterion: criterion }).filter(([, v]) => v !== null)) as unknown as CellIn;
const unverified = (cell: string, why: string) => `${cell} — 판정 미확인 부분 검증: ${why} (서명 근거 = 같은 head 영수 + focused exit 0 · 미재현 추론 = FU)`;
/** FU-FLOOD: the folded kinds' E4 cell (title · the one evidence line) — literal forms. */
const e4Title = (cell: string) => `${cell} — E4 sim/test-universe evidence (green signed on same-head receipt + focused exit 0; 판정 미확인 부분 = 근거 줄)`;
// a line written on another cell never cites a PR («#40586» would bind / judge that cell) — it reads «PR 40586»
const e4Line = (why: string) => `판정 미확인 — ${why} (서명 근거 = same-head receipt + focused exit 0 · 미재현 추론 = FU)`.replace(/#(\d)/gu, 'PR $1');
/** The body's own post-sign E4 FU (GREEN-DEFINITION-ONE · unchanged) — a cell signed with no E4 line gets it. */
const bodyE4 = (cell: string) => `${cell} — E4 sim/test-universe evidence (green signed on same-head receipt + focused exit 0; E4 not run: no «완료 경계 증거 명령» in the title)`;
const board = (fus: FuLedger) => Object.fromEntries([...fus].map(([id, f]) => [id, f.evidence ? { title: f.title, evidence: f.evidence } : { title: f.title }]));
const uncited = (quoted: string, words: string) => `필수 미충족 주장에 기준 구절·반대 근거 인용 없음 (${quoted}: ${words})`;
const quote = (criterion: string) => `«${criterion.length > 80 ? `${criterion.slice(0, 79)}…` : criterion}»`;
const vagueJudge: Judge = reqs => reqs.map(r => ({ id: r.id, classification: 'must', fulfilled: false, evidenceIds: [], reason: 'the evidence does not establish this behaviour', gap: 'not-shown', clause: '' }));

async function scene(ctx: SimWorldScenarioContext, tag: string, body: (seed: number, engine: SimWorldEngine) => Promise<SimWorldScenarioOutcome | null>): Promise<SimWorldScenarioOutcome> {
  for (const seed of seeds(ctx.seed)) { const out = await body(seed, ctx.engine); if (out) return out; }
  ctx.recorder.event('judge-criterion:scene', { scenario: ctx.scenarioId, engine: ctx.engine, seeds: 5, tag });
  return { ok: true };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'JB-CRIT-UNCERTAIN',
    title: 'decomposition uncertain (its own review rejects) → green on same-head receipt + focused exit 0 · one line on «<cell>-E4» (the 11-28 04:34Z YAML-DEF-LOADER refusal) · no «-FU» cell',
    async run(ctx) {
      return scene(ctx, 'uncertain', async (seed, engine) => {
        const { stem, pr } = row(seed); const cell = `${stem}-UNSURE`;
        const fus: FuLedger = new Map(); const calls = { n: 0 };
        const out = await wake(ctx, `crit-uncertain-${engine}-s${seed}`, engine, [withCriterion(yellow(cell, `#${pr}`), criterionOf(seed))], [declared(pr, cell)], [], undefined,
          side({ decompose: 'review-rejects', judge: () => [] }, calls, fus));
        const why = 'doneCriterion 분해 불확실 (decomposition review rejected or uncertain)';
        if (!same(out.signed, [cell])) return fail('uncertain-not-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} refused ${JSON.stringify(out.refused)} (want [${cell}])`);
        const want = { [`${cell}-E4`]: { title: e4Title(cell), evidence: e4Line(why) } };
        if (!same(board(fus), want)) return fail('fu', `seed ${seed} ${engine}: ${JSON.stringify(board(fus))} (want ${JSON.stringify(want)})`);
        if (!out.evidence[cell]!.includes(`doneCriterion policy 1: baseline (same-head receipt + focused exit 0) · ${why} → E4 칸 ${cell}-E4 근거 한 줄`)) return fail('sign-line', `seed ${seed} ${engine}: ${out.evidence[cell]}`);
        if (calls.n !== 2) return fail('llm-calls', `seed ${seed} ${engine}: ${calls.n} (want 2: decompose + review)`);
        ctx.recorder.event('judge-criterion:uncertain', { seed, engine, signed: out.signed });
        return null;
      });
    },
  },
  {
    id: 'JB-CRIT-LLM-DOWN',
    title: 'judge LLM down (429 · usage limit) or the judgment step failing → green on the baseline + «<cell>-FU» carrying the provider error · never a silent refusal',
    async run(ctx) {
      return scene(ctx, 'llm-down', async (seed, engine) => {
        const { stem, pr } = row(seed); const [down, judgeFail] = [`${stem}-DOWN`, `${stem}-JFAIL`];
        const fus: FuLedger = new Map(); const calls = { n: 0 };
        const a = await wake(ctx, `crit-down-${engine}-s${seed}`, engine, [withCriterion(yellow(down, `#${pr}`), criterionOf(seed))], [declared(pr, down)], [], undefined,
          side({ decompose: 'one-must', judge: () => [], down: 'codex 429 usage_limit_reached (resets 11:30)' }, calls, fus));
        const b = await wake(ctx, `crit-jfail-${engine}-s${seed}`, engine, [withCriterion(yellow(judgeFail, `#${pr + 1}`), criterionOf(seed + 1))], [declared(pr + 1, judgeFail)], [], undefined,
          side({ decompose: 'one-must', judge: 'throw' }, { n: 0 }, fus));
        const whyA = '판정 LLM 불가 (decomposition unavailable or malformed: codex 429 usage_limit_reached (resets 11:30))';
        const whyB = '판정 LLM 불가 (judging unavailable or malformed: judge model overloaded)';
        if (!same([...a.signed, ...b.signed], [down, judgeFail])) return fail('down-not-signed', `seed ${seed} ${engine}: ${JSON.stringify([a.signed, b.signed, a.refused, b.refused])}`);
        const want = { [`${down}-FU`]: { title: unverified(down, whyA) }, [`${down}-E4`]: { title: bodyE4(down) }, [`${judgeFail}-FU`]: { title: unverified(judgeFail, whyB) }, [`${judgeFail}-E4`]: { title: bodyE4(judgeFail) } };
        if (!same(board(fus), want)) return fail('fu', `seed ${seed} ${engine}: ${JSON.stringify(board(fus))} (want ${JSON.stringify(want)})`);
        if (calls.n !== 1) return fail('llm-calls', `seed ${seed} ${engine}: ${calls.n} (want 1 — the first failing call ends the LLM layer)`);
        ctx.recorder.event('judge-criterion:llm-down', { seed, engine, signed: [...a.signed, ...b.signed] });
        return null;
      });
    },
  },
  {
    id: 'JB-CRIT-MUST-UNMET',
    title: 'a must unmet WITH the cited clause ⊕ contradicting evidence → not green, the refusal quotes both · «unmet» without citation (the 04:40Z «필수 미충족» kind) → green + one line on «<cell>-E4»',
    async run(ctx) {
      return scene(ctx, 'must-unmet', async (seed, engine) => {
        const { stem, pr } = row(seed); const [cited, vague, fake] = [`${stem}-CITED`, `${stem}-VAGUE`, `${stem}-FAKECITE`];
        const criterion = criterionOf(seed);
        const clause = criterion.split(' · ')[0]!.slice(0, 24).trim(); // a verbatim piece of the live criterion
        const fus: FuLedger = new Map(); const calls = { n: 0 };
        const judgeBy: Record<string, Judge> = {
          [cited]: (reqs, ev) => reqs.map(r => ({ id: r.id, classification: 'must', fulfilled: false, evidenceIds: [ev[0]], reason: 'the PR files touch only docs/ — no code path implements it', gap: 'contradicted', clause })),
          [vague]: vagueJudge,
          [fake]: (reqs, ev) => reqs.map(r => ({ id: r.id, classification: 'must', fulfilled: false, evidenceIds: [ev[0]], reason: 'not implemented', gap: 'contradicted', clause: 'a clause the criterion never says' })),
        };
        const one = (cell: string, n: number) => wake(ctx, `crit-unmet-${cell.toLowerCase()}-${engine}-s${seed}`, engine, [withCriterion(yellow(cell, `#${pr + n}`), criterion)], [declared(pr + n, cell)], [], undefined,
          side({ decompose: 'one-must', judge: judgeBy[cell]! }, calls, fus));
        const [c, v, x] = [await one(cited, 0), await one(vague, 1), await one(fake, 2)];
        if (c.signed.length) return fail('cited-must-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(c.signed)} (want [])`);
        const refusal = `필수 미충족 — «${clause}» · 반대 근거 PR-${pr}: the PR files touch only docs/ — no code path implements it`;
        if (c.refused[cited] !== refusal) return fail('refusal-line', `seed ${seed} ${engine}: ${c.refused[cited] ?? 'no refusal'} (want ${refusal})`);
        if (!same([...v.signed, ...x.signed], [vague, fake])) return fail('uncited-not-signed', `seed ${seed} ${engine}: ${JSON.stringify([v.signed, x.signed, v.refused, x.refused])}`);
        const want = {
          [`${vague}-E4`]: { title: e4Title(vague), evidence: e4Line(uncited(quote(criterion), 'the evidence does not establish this behaviour')) },
          [`${fake}-E4`]: { title: e4Title(fake), evidence: e4Line(uncited(quote(criterion), 'not implemented')) },
        };
        if (!same(board(fus), want)) return fail('fu', `seed ${seed} ${engine}: ${JSON.stringify(board(fus))} (want ${JSON.stringify(want)})`);
        ctx.recorder.event('judge-criterion:must-unmet', { seed, engine, refused: [cited], signed: [vague, fake] });
        return null;
      });
    },
  },
  {
    id: 'JB-CRIT-EMPTY',
    title: 'a cell with no doneCriterion (53 of 137 yellow on the 11-28 board) → green on the baseline + «<cell>-FU» «doneCriterion 채우기» · no LLM call',
    async run(ctx) {
      return scene(ctx, 'empty', async (seed, engine) => {
        const { stem, pr } = row(seed); const cell = `${stem}-NOCRIT`;
        const fus: FuLedger = new Map(); const calls = { n: 0 };
        const out = await wake(ctx, `crit-empty-${engine}-s${seed}`, engine, [withCriterion(yellow(cell, `#${pr}`), seed % 2 ? null : '   ')], [declared(pr, cell)], [], undefined,
          side({ decompose: 'one-must', judge: () => [] }, calls, fus));
        if (!same(out.signed, [cell])) return fail('empty-not-signed', `seed ${seed} ${engine}: signed ${JSON.stringify(out.signed)} refused ${JSON.stringify(out.refused)}`);
        const want = { [`${cell}-FU`]: { title: `${cell} — doneCriterion 채우기 (판정 집사가 같은 head 영수 + focused exit 0 으로 서명 · 기준이 비어 있었다)` }, [`${cell}-E4`]: { title: bodyE4(cell) } };
        if (!same(board(fus), want)) return fail('fu', `seed ${seed} ${engine}: ${JSON.stringify(board(fus))} (want ${JSON.stringify(want)})`);
        if (calls.n !== 0) return fail('llm-called', `seed ${seed} ${engine}: ${calls.n} LLM calls on an empty criterion (want 0)`);
        ctx.recorder.event('judge-criterion:empty', { seed, engine, signed: out.signed });
        return null;
      });
    },
  },
  {
    id: 'JB-CRIT-RESIGN-NO-FU',
    title: 'FU-FLOOD: the same cell re-signed (uncited «unmet» again) adds 0 FU cells and 0 duplicate lines · an existing «<cell>-E4» gets the line appended · ≤ follow_up.max_new_per_tick (3) new FU cells per tick, the rest wait a tick',
    async run(ctx) {
      return scene(ctx, 'resign', async (seed, engine) => {
        const { stem, pr } = row(seed); const criterion = criterionOf(seed);
        const line = e4Line(uncited(quote(criterion), 'the evidence does not establish this behaviour'));
        // ① re-sign: sign → (JUD sets it back · a new wake on the same board) → sign again
        const cell = `${stem}-RESIGN`; const fus: FuLedger = new Map();
        const s1 = await wake(ctx, `crit-resign1-${engine}-s${seed}`, engine, [withCriterion(yellow(cell, `#${pr}`), criterion)], [declared(pr, cell)], [], undefined, side({ decompose: 'one-must', judge: vagueJudge }, { n: 0 }, fus));
        const after1 = JSON.stringify(board(fus));
        const s2 = await wake(ctx, `crit-resign2-${engine}-s${seed}`, engine, [withCriterion(yellow(cell, `#${pr}`), criterion)], [declared(pr, cell)], [], undefined, side({ decompose: 'one-must', judge: vagueJudge }, { n: 0 }, fus));
        const want1 = { [`${cell}-E4`]: { title: e4Title(cell), evidence: line } };
        if (!same([...s1.signed, ...s2.signed], [cell, cell])) return fail('resign-not-signed', `seed ${seed} ${engine}: ${JSON.stringify([s1.signed, s2.signed, s1.refused, s2.refused])}`);
        if (after1 !== JSON.stringify(want1) || !same(board(fus), want1)) return fail('resign-fu-added', `seed ${seed} ${engine}: after 1st ${after1} · after 2nd ${JSON.stringify(board(fus))} (want ${JSON.stringify(want1)} both)`);
        // ② an «-E4» already on the board (GREEN-DEFINITION-ONE filed it earlier) → the line is appended, no new cell
        const old = `${stem}-OLDFU`; const fusOld: FuLedger = new Map([[`${old}-E4`, { title: `${old} — E4 sim/test-universe evidence (filed earlier)`, evidence: 'E4 pending' }]]);
        const s3 = await wake(ctx, `crit-resign3-${engine}-s${seed}`, engine, [withCriterion(yellow(old, `#${pr + 1}`), criterion)], [declared(pr + 1, old)], [], undefined, side({ decompose: 'one-must', judge: vagueJudge }, { n: 0 }, fusOld));
        const want3 = { [`${old}-E4`]: { title: `${old} — E4 sim/test-universe evidence (filed earlier)`, evidence: `E4 pending\n${line}` } };
        if (!same(s3.signed, [old]) || !same(board(fusOld), want3)) return fail('existing-e4', `seed ${seed} ${engine}: ${JSON.stringify([s3.signed, board(fusOld)])} (want ${JSON.stringify(want3)})`);
        // ③ cap: five uncited cells in one tick → 3 signed (3 new «-E4») · 2 wait with the reason · the next tick signs them
        const five = [1, 2, 3, 4, 5].map(i => `${stem}-CAP${i}`); const fusCap: FuLedger = new Map();
        const t1 = await wake(ctx, `crit-cap1-${engine}-s${seed}`, engine, five.map((id, i) => withCriterion(yellow(id, `#${pr + 10 + i}`), criterion)), five.map((id, i) => declared(pr + 10 + i, id)), [], undefined, side({ decompose: 'one-must', judge: vagueJudge }, { n: 0 }, fusCap));
        const wait = 'FU 상한 3/틱 도달 — 다음 틱에 서명(새 FU 1)';
        if (!same(t1.signed, five.slice(0, 3).sort()) || !same(t1.refused, { [five[3]!]: wait, [five[4]!]: wait }) || fusCap.size !== 3)
          return fail('cap', `seed ${seed} ${engine}: signed ${JSON.stringify(t1.signed)} refused ${JSON.stringify(t1.refused)} fus ${fusCap.size} (want 3 · ${wait} ×2 · 3)`);
        const t2 = await wake(ctx, `crit-cap2-${engine}-s${seed}`, engine, five.slice(3).map((id, i) => withCriterion(yellow(id, `#${pr + 13 + i}`), criterion)), five.map((id, i) => declared(pr + 10 + i, id)), [], undefined, side({ decompose: 'one-must', judge: vagueJudge }, { n: 0 }, fusCap));
        const cellsNow = (m: FuLedger): number => m.size; // re-read after the second wake (no narrowing from the first check)
        if (!same(t2.signed, five.slice(3).sort()) || cellsNow(fusCap) !== 5) return fail('cap-next-tick', `seed ${seed} ${engine}: signed ${JSON.stringify(t2.signed)} fus ${fusCap.size} (want 2 · 5)`);
        ctx.recorder.event('judge-criterion:resign', { seed, engine, signed: [...s1.signed, ...s2.signed, ...s3.signed, ...t1.signed, ...t2.signed].length });
        return null;
      });
    },
  },
];
