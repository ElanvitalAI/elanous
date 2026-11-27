// SIM-WORLD supervisors — the platform kits the loop agents stand on (DUPLICATION-MAP-1127 #1 · #2 · release-target),
// each with a normal path, an edge and an injected fault, five seeds per run, expectations as independent literals (rule 11).
//   KIT-ROLE-LLM       — every loop voice (judge-butler · guardian · v2) = one streamLLM call with its usage site; no role → none.
//   KIT-LESSONS        — one lessons format in the shared home: butler rows = shell rows · shell decay keeps the cell · legacy reads.
//   KIT-LAND-LOCK      — land-graph tick lock: dead pid → taken over at once · live pid → held · unreadable pid → 60-min rule.
//   KIT-RELEASE-TARGET — trigger facts follow release.graph.version over «the earliest run»; no target / no run → fallback.
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileMemory } from '../../../judge-butler/memory.js';
import { acquireLock } from '../../../land-graph/land-graph.js';
import { fileAgentMemory, maintainLessons } from '../../../loop-agent/memory.js';
import { roleLlm, type RoleLlmDeps } from '../../../loop-agent/role-llm.js';
import { activeRelease } from '../../../loops/trigger-facts.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const seeds = (s: number): number[] => [s, s + 1, s + 2, s + 3, s + 4];

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'KIT-ROLE-LLM',
    title: 'one role LLM: each loop voice is one streamLLM call carrying its usage site · no configured role → no LLM · stream failure surfaces',
    async run(ctx) {
      const SITES = ['loop-agent:judge-butler', 'loop-agent:guardian', 'loop-agent:run-doctor', 'loop-agent:hand-steward', 'loop-agent:autopsy'];
      for (const seed of seeds(ctx.seed)) {
        const site = SITES[((seed % 5) + 5) % 5]!;
        const calls: Array<Record<string, unknown>> = [];
        const deps: RoleLlmDeps = {
          resolve: (role) => (role === 'coordinator' ? { provider: 'codex', model: `m-${seed}` } : null),
          provider: (name, model) => ({ name, model }),
          stream: async (_m, opts) => { calls.push(opts); return `{"reply":"seed ${seed}"}`; },
        };
        const llm = roleLlm('coordinator', { site }, deps);
        if (!llm) return fail('no-llm', `seed ${seed}: coordinator resolved but roleLlm returned null`);
        const out = await llm.complete('S', 'U');
        if (out.model !== `codex/m-${seed}` || out.text !== `{"reply":"seed ${seed}"}`) return fail('wrong-answer', `seed ${seed}: ${JSON.stringify(out)}`);
        if (calls.length !== 1 || calls[0]!.usageSite !== site || calls[0]!.usageRole !== 'coordinator') return fail('not-one-recorded-call', `seed ${seed}: ${JSON.stringify(calls)}`);
        // edge: a role with no LLM, and a provider that is unavailable → no voice (the agent folds to facts)
        if (roleLlm('review', { site }, deps) !== null) return fail('phantom-llm', `seed ${seed}: review role produced an LLM`);
        if (roleLlm('coordinator', { site }, { ...deps, provider: () => null }) !== null) return fail('phantom-llm', `seed ${seed}: unavailable provider produced an LLM`);
        // fault: the stream throws → the caller sees the error (voiceAgent folds on it; nothing is swallowed here)
        const broken = roleLlm('coordinator', { site }, { ...deps, stream: async () => { throw new Error(`429 seed ${seed}`); } })!;
        let threw = '';
        try { await broken.complete('S', 'U'); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
        if (threw !== `429 seed ${seed}`) return fail('error-swallowed', `seed ${seed}: got «${threw}»`);
      }
      ctx.recorder.event('kit:role-llm', { seeds: 5 });
      return { ok: true };
    },
  },
  {
    id: 'KIT-LESSONS',
    title: 'one lessons format: butler lessons are shell rows · the shell decay rewrite keeps the cell · legacy rows read · a torn line is skipped',
    async run(ctx) {
      for (const seed of seeds(ctx.seed)) {
        const root = join(ctx.universeRoot, `lessons-s${seed}`);
        const home = join(root, 'loop-agents', 'judge-butler');
        mkdirSync(home, { recursive: true });
        appendFileSync(join(home, 'lessons.jsonl'), `${JSON.stringify({ at: '2026-11-26T00:00:00Z', cell: `OLD-${seed}`, text: 'legacy', from: 'JUD' })}\n{"torn":\n`);
        const butler = fileMemory(root);
        butler.appendLesson({ at: '2026-11-27T00:00:00Z', cell: `CELL-${seed}`, text: `veto ${seed}`, from: 'CLI' });
        const shell = fileAgentMemory(root, 'judge-butler', 'JUD');
        const seen = shell.lessons().map(l => `${l.pattern}|${l.status}`);
        if (JSON.stringify(seen) !== JSON.stringify([`OLD-${seed}|active`, `cell:CELL-${seed}|active`])) return fail('shell-misread', `seed ${seed}: ${JSON.stringify(seen)}`);
        maintainLessons(shell, new Date('2026-11-27T01:00:00Z'));
        shell.writeLessons(shell.lessons());
        const back = butler.lessons().map(l => `${l.cell}|${l.text}`);
        if (JSON.stringify(back) !== JSON.stringify([`OLD-${seed}|legacy`, `CELL-${seed}|veto ${seed}`])) return fail('cell-lost', `seed ${seed}: ${JSON.stringify(back)}`);
        // edge: a lesson the shell decays (60 days unused) is no longer a butler lesson
        const rows = shell.lessons(); rows[0]!.status = 'decayed'; shell.writeLessons(rows);
        if (JSON.stringify(butler.lessons().map(l => l.cell)) !== JSON.stringify([`CELL-${seed}`])) return fail('decayed-still-read', `seed ${seed}`);
        const raw = readFileSync(join(home, 'lessons.jsonl'), 'utf8');
        if (raw.includes('"torn"')) return fail('torn-line-kept', `seed ${seed}: the shell rewrite kept a torn line`);
      }
      ctx.recorder.event('kit:lessons', { seeds: 5 });
      return { ok: true };
    },
  },
  {
    id: 'KIT-LAND-LOCK',
    title: 'land-graph tick lock: a dead tick\'s lock is taken over at once · a live one is held · an unreadable pid waits for the 60-min rule',
    async run(ctx) {
      for (const seed of seeds(ctx.seed)) {
        const root = join(ctx.universeRoot, `lock-s${seed}`);
        const home = join(root, 'land-graph'); mkdirSync(home, { recursive: true });
        const lock = join(home, 'tick.lock');
        const t = Date.parse('2026-11-27T10:00:00Z') + seed * 60_000;
        const deadPid = 900_000 + seed;
        writeFileSync(lock, String(deadPid)); utimesSync(lock, new Date(t), new Date(t));
        if (acquireLock(root, t + 60_000, () => true) !== null) return fail('live-lock-stolen', `seed ${seed}: a live holder lost its lock`);
        const took = acquireLock(root, t + 60_000, (pid) => pid !== deadPid);
        if (took === null) return fail('dead-lock-held', `seed ${seed}: dead pid ${deadPid} still holds the lock 1 min later`);
        took();
        // edge: unreadable pid → 10 min held, 61 min taken
        writeFileSync(lock, 'not-a-pid'); utimesSync(lock, new Date(t), new Date(t));
        if (acquireLock(root, t + 10 * 60_000, () => true) !== null) return fail('garbage-lock-stolen', `seed ${seed}: unreadable lock taken at 10 min`);
        const late = acquireLock(root, t + 61 * 60_000, () => true);
        if (late === null) return fail('garbage-lock-stuck', `seed ${seed}: unreadable lock still held at 61 min`);
        late();
      }
      ctx.recorder.event('kit:land-lock', { seeds: 5 });
      return { ok: true };
    },
  },
  {
    id: 'KIT-RELEASE-TARGET',
    title: 'release in play: release.graph.version wins over the earliest unpublished run · unset target / target without a run → the earliest · a run past its tail is not active',
    async run(ctx) {
      for (const seed of seeds(ctx.seed)) {
        const root = join(ctx.universeRoot, `target-s${seed}`);
        const run = (v: string, cutAt: string, publishAt: string) => {
          mkdirSync(join(root, 'release-graph', v), { recursive: true });
          writeFileSync(join(root, 'release-graph', v, 'state.json'), JSON.stringify({ kind: 'release', clock: { cutAt, publishAt }, steps: {} }));
        };
        run('0.3.37', '2026-11-27T19:00:00Z', '2026-11-27T21:00:00Z');
        run('0.3.38', '2026-11-28T04:00:00Z', '2026-11-28T06:00:00Z');
        const now = new Date(Date.parse('2026-11-27T12:00:00Z') + seed * 60_000);
        const pick = (t: string | null) => activeRelease(root, now, t)?.version ?? null;
        if (pick('0.3.38') !== '0.3.38') return fail('earliest-wins', `seed ${seed}: target 0.3.38 → ${pick('0.3.38')}`);
        if (pick(null) !== '0.3.37') return fail('fallback-broken', `seed ${seed}: no target → ${pick(null)}`);
        if (pick('0.3.99') !== '0.3.37') return fail('fallback-broken', `seed ${seed}: target without a run → ${pick('0.3.99')}`);
        // edge: after 0.3.37's publish + tail, the earliest active run is 0.3.38 even with the target unset
        const later = new Date('2026-11-28T03:30:00Z'); // 0.3.37 publish 21:00Z + 6 h tail ended 03:00Z
        if ((activeRelease(root, later, null)?.version ?? null) !== '0.3.38') return fail('stale-run-active', `seed ${seed}: past-tail 0.3.37 still active`);
      }
      ctx.recorder.event('kit:release-target', { seeds: 5 });
      return { ok: true };
    },
  },
];
