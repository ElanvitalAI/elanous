// JUDGE-BUTLER-V3-LISTED — the shared v3 door `eln loop agent <id> tick` for an agent whose body is one node kind (agent.yaml
// body.entry_node). A kind binds an EXISTING body (node-kinds.ts names it · this table runs it); the bespoke CLI door stays an
// alias of the same runner (`eln loop butler tick` = `eln loop agent judge-butler tick`), so no caller changes behaviour.
//
// 세 얼굴: 관측 = the body's own tick report → <stateRoot>/loop-agents/<id>/last-tick.json (the trigger's goal file) ⊕ the
//   heartbeat / 판단 근거 = the body (unchanged) / 수복과 인계 = a kind without a runner refuses with its own door named · a
//   failed tick beats with err (watchers-check · the registry's goal deadline → exception card to the trigger owner).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface KindRunResult { readonly summary: unknown; readonly text: string }
export type KindRunner = (o: { stateRoot: string }) => Promise<KindRunResult>;

/** Distinct cells the butler signed within the last hour that are still green — the judge-butler KPI greens_per_hour. */
export function greensInWindow(cases: ReadonlyArray<{ at: string; kind: string; subject: string }>, reversed: Readonly<Record<string, unknown>>, nowMs: number, windowMs: number): number {
  const { filterInWindow } = require('../../kit/kpi/index.js') as typeof import('../../kit/kpi/index.js');
  return new Set(filterInWindow(cases, c => c.at, nowMs, windowMs).filter(c => c.kind === 'sign' && !reversed[c.subject]).map(c => c.subject)).size;
}

/** LOOP-AGENT-V3-SMART live wiring for the butler: agent.yaml hooks · L0 by duty «veto» · outcome = the proposal mail acked/done ·
 *  router = the coordinator LLM (judgment node only for a toss-up) · knowhow = the butler's v2 pack. Absent / refused → null. */
async function butlerSmart(ctx: { store: import('../../msg/msg-store.js').MsgStore; stateRoot: string }, llm: import('../../judge-butler/voice.js').VoiceLlm | null): Promise<import('../../judge-butler/smart.js').ButlerSmartInput | null> {
  try {
    const { loadButlerSmart } = await import('../../judge-butler/smart.js');
    const { cfg } = loadButlerSmart();
    if (!cfg) return null;
    const { supervisorSeat } = await import('./agent-yaml.js');
    const { fileAgentMemory } = await import('../memory.js');
    const l0 = supervisorSeat({ duty: 'veto' }, 'JUD');
    const shell = fileAgentMemory(ctx.stateRoot, 'judge-butler', l0);
    return {
      cfg, l0, router: llm,
      mailOutcome: row => {
        const id = Number(row.ref?.startsWith('msg:') ? row.ref.slice(4) : NaN);
        if (!Number.isFinite(id)) return null;
        const st = ctx.store.messageStatus(row.to, id);
        return st === 'acked' || st === 'done' ? true : null; // unread / delivered = the HOLD state decides
      },
      knowhow: { text: () => shell.knowhow().text, add: (item, by, at) => shell.addKnowhow(item, by, at) },
    };
  } catch { return null; }
}

/** judge-butler.tick — observe → judge vs done-when → act → verify → report, then voice turns for waiting mail (one tick at a time). */
const judgeButlerTick: KindRunner = async ({ stateRoot }) => {
  const { liveContext, configuredVoiceLlm } = await import('../../judge-butler/live.js');
  const { wakeButler } = await import('../../judge-butler/agent.js');
  const { loadCards } = await import('../../judge-butler/cards.js');
  const { butlerHome, fileMemory } = await import('../../judge-butler/memory.js');
  const { beatSafe } = await import('../../kit/heartbeat/index.js');
  const { HOUR_MS } = await import('../../kit/kpi/index.js');
  const { acquireTickLock } = await import('../../judge-butler/tick-lock.js');
  // BUTLER-TICK-CADENCE: one tick at a time (trigger ⊕ manual/stopgap ticks used to race and refuse each other's signs).
  mkdirSync(butlerHome(stateRoot), { recursive: true });
  const lock = acquireTickLock(butlerHome(stateRoot));
  if (lock.held) return { summary: { skipped: 'tick-running', pid: lock.pid, since: lock.at }, text: `judge-butler tick skipped — another tick is running (pid ${lock.pid} since ${lock.at})` };
  let ctx: ReturnType<typeof liveContext>;
  try { ctx = liveContext(); } catch (e) { lock.release(); beatSafe({ name: 'judge-butler', saw: 0, everyMin: 10, err: e instanceof Error ? e.message : String(e) }); throw e; }
  try {
    const cards = loadCards();
    const llm = configuredVoiceLlm();
    // SUPERVISORS-EXECUTE-NOT-PROPOSE: the tick runs under agent.yaml policies (its own-run caps read through pv())
    const { withPolicies } = await import('../policy-context.js');
    const { cardsDir } = await import('../../judge-butler/cards.js');
    const { lintAgentDir } = await import('./agent-yaml.js');
    const dir = cardsDir();
    const policies = lintAgentDir(dir, { triggersDir: join(dir, '..', '..', 'triggers') }).compiled?.policies ?? {};
    const smartIn = await butlerSmart(ctx, llm);
    const res = await withPolicies(policies, () => wakeButler({ view: ctx.view, ports: ctx.ports, inbox: ctx.inbox, llm, cards, smart: smartIn }));
    // heartbeat (watchers-check judges DEAD after 2× cadence): saw = yellow cells judged this tick
    beatSafe({ name: 'judge-butler', saw: ctx.view.cells.filter(c => c.status === 'yellow').length, everyMin: 10, last: new Date().toISOString() });
    // JUDGE-BUTLER-V3-LISTED: the KPI values agent.yaml `kpis[].from` reads (greens/h = the same count `eln loop butler status` shows)
    const mem = fileMemory(ctx.stateRoot); const st = mem.readState();
    const kpi = { greensLastHour: greensInWindow(mem.cases(1000), st.reversed, Date.now(), HOUR_MS), frozenHands: res.tick.frozenHands };
    const summary = { ...res.tick, kpi, ...(res.smart ? { smart: res.smart } : {}), voice: res.voice.map(v => ({ msg: v.msg.id, from: v.msg.from, folded: v.folded, model: v.model, escalated: v.escalated })) };
    mkdirSync(butlerHome(ctx.stateRoot), { recursive: true });
    writeFileSync(join(butlerHome(ctx.stateRoot), 'last-tick.json'), JSON.stringify(summary));
    await (await import('../live.js')).liveJournalRollup('judge-butler'); // SUPERVISOR-CORRECTION-JOURNAL
    const reasons = res.tick.notSigned.slice(0, 12).map(x => `\n  not signed ${x.cell} — ${x.why.slice(0, 200)}`).join('');
    return { summary, text: `judge-butler ${res.tick.level} · signed ${res.tick.signed.length}${res.tick.signed.length ? ` (${res.tick.signed.slice(0, 8).join(',')})` : ''} · refused ${res.tick.signRefused.length} · not signed ${res.tick.notSigned.length} · HOLD expired ${res.tick.expired.length} · proposed ${res.tick.proposed.length} · ✋ answered ${res.tick.answered.length} · → JUD ${res.tick.escalated.length} · freed ${res.tick.freed.length} · frozen ${res.tick.frozenHands} · voice ${res.voice.length}${reasons}` };
  } catch (e) { beatSafe({ name: 'judge-butler', saw: 0, everyMin: 10, err: e instanceof Error ? e.message : String(e) }); throw e; }
  finally { ctx.close(); lock.release(); }
};

/** land-graph.tick — CODE-BODY-TO-KIND: one wake of the land-graph agent (`eln land steward tick` is the alias): body ⊕ kpi-voice ⊕
 *  the cell-link sweep, the report written as the trigger's goal file. */
const landGraphTick: KindRunner = async ({ stateRoot }) => {
  const { defaultLandDeps } = await import('../../cli/land-graph-cli.js');
  const { landGraphAgentTick } = await import('./land-graph-kind.js');
  const { fileMemory, loadCards, stewardHome, STEWARD_ID, STEWARD_SEAT, STEWARD_SUPERVISOR } = await import('../../land-steward/memory.js');
  const { channelPort, l0MailPort } = await import('../../land-steward/cli.js');
  const { sweepMainCellLinks } = await import('../../land-graph/main-cell-link.js');
  const { liveSweepDeps } = await import('../../land-steward/cell-link-live.js');
  const d = { ...defaultLandDeps(), stateRoot };
  const cellSweep = () => sweepMainCellLinks(liveSweepDeps(d.stateRoot, d.dry ? { dry: true } : {}));
  const r = await landGraphAgentTick(d, { memory: fileMemory(d.stateRoot), channel: channelPort(d.stateRoot), report: l0MailPort(), cellSweep }, loadCards(),
    { id: STEWARD_ID, address: STEWARD_SEAT, l0Fallback: STEWARD_SUPERVISOR });
  // A lock-held duplicate tick reports itself but keeps the last valid report (KPI · lanes · blocked) on disk.
  if (!r.locked && !r.error) { mkdirSync(stewardHome(d.stateRoot), { recursive: true }); writeFileSync(join(stewardHome(d.stateRoot), 'last-tick.json'), JSON.stringify(r)); }
  // GH-BUDGET-GOVERNOR ④: a skipped tick (GitHub read failed) keeps the last valid report and stamps the skip on it — the
  // trigger's done-when (last-tick.json rewritten) holds, so a GitHub cooldown is never a trigger exception.
  else if (r.skipped) {
    const p = join(stewardHome(d.stateRoot), 'last-tick.json');
    let prev: Record<string, unknown> | null = null;
    try { prev = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { prev = null; }
    mkdirSync(stewardHome(d.stateRoot), { recursive: true });
    const at = d.now().toISOString();
    writeFileSync(p, JSON.stringify({ ...(prev ?? r), at, skipped: r.skipped, ...(prev?.at ? { reportAt: prev.at } : {}), lastSkipped: { at, why: r.error } }));
  }
  if (!r.locked && !d.dry) await (await import('../live.js')).liveJournalRollup(STEWARD_ID); // SUPERVISOR-CORRECTION-JOURNAL
  const k = r.kpi;
  const text = r.locked ? `${STEWARD_ID}: another tick holds the lock` : [`${STEWARD_ID} ${r.level} · body ${r.mode} · ${r.skipped ? 'skipped (next tick retries)' : `landed ${r.landed.join(',') || '—'}`}${r.error ? ` · ${r.error}` : ''}`,
    k ? `lands/h ${k.landsLastHour} · ready ${k.ready}/${k.judged} · finisher p50 ${k.needsFinisherWaitP50Min === null ? '—' : Math.round(k.needsFinisherWaitP50Min)}m · no-next ${k.refusalsWithoutNext.length}` : '',
    ...(r.cellLink ? [`cell-link ${r.cellLink.version ?? '—'} · merged ${r.cellLink.scanned} · ${Object.entries(r.cellLink.counts).map(([n, v]) => `${n} ${v}`).join(' · ') || 'nothing new'}${r.cellLink.error ? ` · ${r.cellLink.error}` : ''}`] : []),
    ...r.posted, ...(r.slots && r.slots.advise !== r.slots.slots ? [`slots: ${r.slots.why}`] : [])].filter(Boolean).join('\n');
  return { summary: r, text };
};

/** node kind → runner. A kind not here runs only through its own door (KIND_DOORS). */
export const KIND_RUNNERS: Readonly<Record<string, KindRunner>> = { 'judge-butler.tick': judgeButlerTick, 'land-graph.tick': landGraphTick };
/** The bespoke door of a kind the shared door does not run yet (named in the refusal). */
export const KIND_DOORS: Readonly<Record<string, string>> = { 'guardian.pulse': 'eln loop guardian pulse' };
