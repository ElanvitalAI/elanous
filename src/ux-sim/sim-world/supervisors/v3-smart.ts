// SIM-WORLD supervisors · LOOP-AGENT-V3-SMART-2 (대표 11-27 «v3 스마트 피처가 빨리 필요» · «회고도 되고, 영혼 있고, 더 발전할 수
// 있는 형태») — the agent.yaml hook nodes on the real shell (supervisorTick — what `eln loop agent <id> tick` runs), one
// shipped supervisor package copied into a temp tree and run against a fake world:
//   SUP-V3-SMART-LEARN — a bad-policy world (stale_record_min 90 → 120 in the copy): end-zombie-pregate fails 3× on <defunct>
//                        records with the same cause → ONE knowhow line with that cause → the next tick's plan reads it and
//                        runs the agent.yaml fallback close-stale-record on a NEW record (no failure first · no kill) · a
//                        human «기억해» knowhow row and a human lesson are cited in the plan output · no second knowhow line.
//   SUP-V3-RETRO-SOUL  — 6 h later the retro hook writes one entry (what worked · what failed and why · one change to try) and
//                        the voice quotes it with the soul block in its prompt · the soul's do_not (edited to name the
//                        fallback) refuses the swap · all 11 shipped agent.yaml carry a soul and a package without one is refused.
// Expectations are independent literals (rule 11).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cardsRoot, loadCard } from '../../../loop-agent/card.js';
import { addLesson, fileAgentMemory } from '../../../loop-agent/memory.js';
import { voiceAgent, type AgentPorts } from '../../../loop-agent/runtime.js';
import { lintSupervisor, supervisorDef, supervisorTick } from '../../../loop-agent/v3/supervisor.js';
import { lintAgentDir } from '../../../loop-agent/v3/agent-yaml.js';
import { createBody as createRunSupervisor, type PregateJob, type RunSupervisorDeps } from '../../../loop-agent/bodies/run-supervisor.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const T0 = Date.parse('2026-11-27T12:00:00Z');
const MIN = 60_000;
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const seedsOf = (ctx: SimWorldScenarioContext): number[] => [ctx.seed, ctx.seed + 1, ctx.seed + 2];
const REPO = resolve(import.meta.dir, '../../../..');
const ELEVEN = ['autopsy', 'hand-steward', 'judge-butler', 'land-steward', 'macrophage', 'release-rocket', 'run-doctor', 'run-supervisor', 'silence-watch', 'train-manager', 'watchers-check'];

/** graphs/loop-agents/run-supervisor ⊕ graphs/triggers copied into a temp tree, agent.yaml edited (the repo is never touched). */
function pkg(base: string, edit: (y: string) => string): string {
  const root = mkdtempSync(join(base, 'v3s2-'));
  mkdirSync(join(root, 'loop-agents'), { recursive: true });
  cpSync(join(cardsRoot(), 'run-supervisor'), join(root, 'loop-agents', 'run-supervisor'), { recursive: true });
  cpSync(join(REPO, 'graphs', 'triggers'), join(root, 'triggers'), { recursive: true });
  const p = join(root, 'loop-agents', 'run-supervisor', 'agent.yaml');
  writeFileSync(p, edit(readFileSync(p, 'utf8')));
  return join(root, 'loop-agents');
}
const badPolicy = (y: string): string => y.replace(/^  stale_record_min: 90/mu, '  stale_record_min: 120');

/** A pregate world of <defunct> records at 100 min (kill -0 says alive · the launcher is gone). Records appear by tick. */
function world(seed: number) {
  const jobs: PregateJob[] = [];
  const kills: number[] = []; const closed: string[] = [];
  const add = (id: string, pid: number) => jobs.push({ id, pid, host: seed % 2 ? 'node-b' : 'minim5', ageMin: 100, alive: true });
  const deps: RunSupervisorDeps = {
    pregateJobs: () => jobs.filter(j => !closed.includes(j.id)),
    closeRecord: id => { closed.push(id); return { ok: true, line: `${id} closed`, undo: 'mv back' }; },
    openRuns: () => [],
    proc: () => ({ cmd: '[python3] <defunct>', elapsedSec: 100 * 60 }),
    kill: pid => { kills.push(pid); return true; },
    closeRun: () => ({ ok: true, line: 'x' }),
    relaunch: () => ({ ok: true, pid: 9001, line: 'relaunched' }),
    killed: () => [], recordKilled: () => {}, markRelaunched: () => {},
  };
  return { deps, add, kills, closed };
}
function rig(stateRoot: string) {
  mkdirSync(stateRoot, { recursive: true });
  const memory = fileAgentMemory(stateRoot, 'run-supervisor', 'TC');
  memory.setLevel('live', 'TC', 'sim: live');
  const posts: Array<{ key: string; to: string }> = [];
  const ports: AgentPorts = { memory, post(key, to) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to }); return 700 + posts.length; }, beat() {}, speak() {}, llm: null };
  return { memory, ports, posts };
}
/** `<agentHome>/knowhow/learned.md` headings (agentHome = <stateRoot>/loop-agents/<id> · memory.root). */
const learnedLines = (home: string): string[] => { try { return readFileSync(join(home, 'knowhow', 'learned.md'), 'utf8').split('\n').filter(l => l.startsWith('## K-')); } catch { return []; } };

/** The learn story on one seed: ticks 0..2 fail on record A · tick 3 = a new record B with the knowhow in force. */
async function learnStory(ctx: SimWorldScenarioContext, seed: number, root: string, tag: string) {
  const card = loadCard('run-supervisor');
  const home = join(ctx.universeRoot, `${tag}-s${seed}`);
  const r = rig(home);
  const w = world(seed);
  const a = `${(0xa0000 + seed).toString(16)}aaaaaa0-light`; const b = `${(0xb0000 + seed).toString(16)}bbbbbb0-full`;
  w.add(a, 40100 + seed);
  const body = createRunSupervisor({ stateRoot: home, card }, w.deps);
  const at = (i: number) => new Date(T0 + seed * MIN + i * 21 * MIN);
  const reps = [];
  for (let i = 0; i < 3; i++) reps.push((await supervisorTick(card, body, r.ports, at(i), root)).report);
  // a person told the agent something («기억해» → knowhow row · and an L0 lesson naming the fallback action)
  r.memory.addKnowhow({ title: 'defunct pid 기록은 kill 하지 말고 닫는다', situation: '11-27 journal', prescription: '명령줄을 다시 읽고 런처가 없으면 기록만 닫는다' }, 'CEO', at(2));
  addLesson(r.memory, 'close-stale-record 전에 pid 명령줄을 한 번 더 읽는다', 'chat', 'CEO', at(2));
  w.add(b, 40200 + seed);
  reps.push((await supervisorTick(card, body, r.ports, at(3), root)).report);
  return { card, home, r, w, a, b, reps, at };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-V3-SMART-LEARN',
    title: 'run-supervisor (agent.yaml hooks): the same action fails 3× with one cause → ONE knowhow line with the cause → next tick the plan reads it and runs the fallback close-stale-record on a new record (no kill · no failure first) · human memory rows cited in the plan',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const root = pkg(ctx.universeRoot, badPolicy);
        const def = supervisorDef(loadCard('run-supervisor'), root);
        if (!def.smart || def.refused) return fail('no-smart', `seed ${seed}: agent.yaml hooks not compiled (${def.refused?.body.slice(0, 160) ?? 'smart null'})`);
        const s = await learnStory(ctx, seed, root, 'learn');
        const [t0, t1, t2, t3] = s.reps;
        // before: the body's plan as is (end-zombie-pregate) · fails with the same cause every tick
        const before = t0!.plan?.lines[0];
        if (!before || before.action !== 'end-zombie-pregate' || before.from || before.by !== 'body') return fail('plan-before', `seed ${seed}: ${JSON.stringify(before)}`);
        if ([t0, t1, t2].some(t => t!.failed.length !== 1 || t!.failed[0] !== `end-zombie-pregate:pregate:${s.a}`)) return fail('fails', `seed ${seed}: ${JSON.stringify([t0!.failed, t1!.failed, t2!.failed])}`);
        // ONE knowhow line, learned on the 3rd failure, with the cause from the failure line
        const lines = learnedLines(s.r.memory.root).filter(l => l.includes('[v3:'));
        if (lines.length !== 1 || !lines[0]!.includes('end-zombie-pregate 반복 실패')) return fail('knowhow-line', `seed ${seed}: ${JSON.stringify(lines)}`);
        const text = readFileSync(join(s.r.memory.root, 'knowhow', 'learned.md'), 'utf8');
        if (!text.includes('아직 닫을 나이 아님(120분)') || !text.includes('close-stale-record')) return fail('knowhow-cause', `seed ${seed}: ${text.slice(0, 400)}`);
        if (!t2!.learned?.promoted.length || t1!.learned?.promoted.length) return fail('learned-when', `seed ${seed}: tick1 ${JSON.stringify(t1!.learned)} tick2 ${JSON.stringify(t2!.learned)} (want the line on the 3rd failure)`);
        // after: the plan reads the knowhow → the fallback on the NEW record B (and on A) · no kill · no failure
        const onB = t3!.plan?.lines.find(l => l.target === `pregate:${s.b}`);
        if (!onB || onB.action !== 'close-stale-record' || onB.from !== 'end-zombie-pregate' || onB.by !== 'knowhow') return fail('plan-after', `seed ${seed}: ${JSON.stringify(onB)}`);
        const kid = /^## (K-RUN-SUPERVISOR-\d{3})/u.exec(lines[0]!)?.[1];
        if (!kid || !onB.why.startsWith(`${kid}:`) || !onB.cites.some(c => c.startsWith(kid))) return fail('plan-cite-knowhow', `seed ${seed}: ${kid} · ${JSON.stringify(onB)}`);
        if (!t3!.acted.includes(`close-stale-record:pregate:${s.b}`) || t3!.failed.length) return fail('fallback-acted', `seed ${seed}: acted ${JSON.stringify(t3!.acted)} failed ${JSON.stringify(t3!.failed)}`);
        if (s.w.kills.length || !s.w.closed.includes(s.b)) return fail('no-kill', `seed ${seed}: kills ${JSON.stringify(s.w.kills)} closed ${JSON.stringify(s.w.closed)}`);
        // human rows: the lesson naming close-stale-record is cited on that line · the «기억해» knowhow row is in the plan memory
        if (!onB.cites.some(c => c.includes('(CEO)') && c.includes('pid 명령줄을 한 번 더'))) return fail('human-lesson-cite', `seed ${seed}: ${JSON.stringify(onB.cites)}`);
        if (!t3!.plan!.memory.some(m => m.includes('(CEO)') && m.includes('defunct pid 기록은 kill 하지 말고 닫는다'))) return fail('human-knowhow-cite', `seed ${seed}: ${JSON.stringify(t3!.plan!.memory)}`);
        if (!t3!.plan!.purpose.startsWith('TA 스프린트·하니스 런과 착지 줄 pregate')) return fail('plan-purpose', `seed ${seed}: ${t3!.plan!.purpose}`);
        // no second knowhow line on later ticks
        await supervisorTick(s.card, createRunSupervisor({ stateRoot: s.home, card: s.card }, s.w.deps), s.r.ports, s.at(5), root);
        if (learnedLines(s.r.memory.root).filter(l => l.includes('[v3:')).length !== 1) return fail('knowhow-dup', `seed ${seed}`);
        ctx.recorder.event('sup:v3-smart-learn', { seed, before: `${before.action} ${before.target}`, after: `${onB.action} ${onB.target} ← ${onB.from}`, kid });
      }
      return { ok: true };
    },
  },
  {
    id: 'SUP-V3-RETRO-SOUL',
    title: 'retro every retro_every_h: one entry (worked · failed and why · one change to try) the voice quotes with the soul block · soul do_not refuses the fallback · all 11 agent.yaml carry a soul, a package without one is refused',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const root = pkg(ctx.universeRoot, badPolicy);
        const s = await learnStory(ctx, seed, root, 'retro');
        if (s.reps.some(r => r.retro)) return fail('retro-early', `seed ${seed}: a retro inside the first 6 h`);
        const late = (await supervisorTick(s.card, createRunSupervisor({ stateRoot: s.home, card: s.card }, s.w.deps), s.r.ports, new Date(T0 + seed * MIN + 6 * 60 * MIN), root)).report;
        if (!late.retro || !late.retro.includes('end-zombie-pregate×3') || !late.retro.includes('아직 닫을 나이 아님') || !late.retro.includes('close-stale-record')) return fail('retro', `seed ${seed}: ${late.retro ?? 'none'}`);
        if (!s.r.memory.cases(500).some(c => c.kind === 'retro')) return fail('retro-case', `seed ${seed}`);
        // the voice: soul block in the system prompt · the latest retro quoted in the user prompt
        const def = supervisorDef(s.card, root);
        let sys = ''; let usr = '';
        const llm = { complete: async (system: string, user: string) => { sys = system; usr = user; return { text: '{"reply":"회고를 인용한다","actions":[]}', model: 'sim' }; } };
        await voiceAgent({ card: def.card, body: createRunSupervisor({ stateRoot: s.home, card: s.card }, s.w.deps), ports: { ...s.r.ports, llm }, now: new Date(T0 + 7 * 60 * MIN), ...(def.soul ? { soul: def.soul } : {}) },
          { id: 1, from: 'CEO', body: '최근 회고 알려줘', at: new Date(T0).toISOString(), channel: 'loop:run-supervisor' });
        if (!sys.includes('## 영혼 (agent.yaml soul)') || !sys.includes('목적: TA 스프린트·하니스 런과 착지 줄 pregate') || !sys.includes('섬기는 이: TC (L0 · landing)')) return fail('voice-soul', `seed ${seed}: ${sys.slice(0, 300)}`);
        if (!usr.includes('## 최근 회고') || !usr.includes('다음에 해 볼 것')) return fail('voice-retro', `seed ${seed}: ${usr.slice(0, 300)}`);
        // soul do_not naming the fallback → the plan keeps the body's action and says why
        const vetoed = pkg(ctx.universeRoot, y => badPolicy(y).replace('  - "원장 줄 삭제·수정"\n', '  - "원장 줄 삭제·수정"\n  - "close-stale-record (사람이 직접)"\n'));
        const v = await learnStory(ctx, seed, vetoed, 'veto');
        const onB = v.reps[3]!.plan?.lines.find(l => l.target === `pregate:${v.b}`);
        if (!onB || onB.action !== 'end-zombie-pregate' || !onB.cites.some(c => c.startsWith('soul.do_not'))) return fail('soul-veto', `seed ${seed}: ${JSON.stringify(onB)}`);
        if (v.w.closed.length) return fail('soul-veto-acted', `seed ${seed}: closed ${JSON.stringify(v.w.closed)}`);
        ctx.recorder.event('sup:v3-retro-soul', { seed, retro: late.retro.slice(0, 160) });
      }
      // all 11 shipped packages: lint clean with a soul · without the block → refused by name
      for (const id of ELEVEN) {
        const r = lintSupervisor(id);
        if (!r.ok || !r.compiled?.soul.purpose || !r.compiled.soul.doNot.length || !r.compiled.soul.serves.length) return fail('soul-shipped', `${id}: ${r.errors.join(' · ').slice(0, 200)}`);
      }
      const bare = pkg(ctx.universeRoot, y => y.replace(/^soul:.*\n(?: {2}.*\n|\s+- .*\n)+/mu, ''));
      const lr = lintAgentDir(join(bare, 'run-supervisor'));
      if (lr.ok || !lr.errors.some(e => e.startsWith('soul: block is required'))) return fail('soul-required', JSON.stringify(lr.errors).slice(0, 200));
      return { ok: true };
    },
  },
];
