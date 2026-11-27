// FED-ORG-SIM — federation org structure simulation (CEO 11-27 00:0x «시뮬레이션 월드에서 이 편제와 현재 구조상에서 개선을
// 어떻게 할지 충분하게 모델링»). Deterministic, seeded, LLM 0: every seat / loop agent / hand is a policy function with
// latencies and error rates calibrated from the 11-26 night (seat-state/OP/evidence/20261126/fed-chatlog/2322 ·
// fed-ontology-bottleneck-REPORT §2–§3 · `eln loop trigger list` · origin/main land log). One tick = one simulated minute.
//
// Pipeline per cell: ready supply → (push|pull) claim → work → ✋ (answer rungs, re-ask echo or ladder) → PR → pregate
// host → judge → land graph (slots · stale-base refusal by hot-file overlap) → landed → green (done-when ⊕ evidence ⊕
// closer). Structures S0…S4 differ only by the knobs in STRUCTURES; stress events perturb one resource for a window.
// Helpers (capsule subagents · collector graph · borrowed pool hand) widen the loop agents' ✋ service in S3/S4.

export type StructureId = 'S0' | 'S1' | 'S2' | 'S3' | 'S4';
export type StressId = 'none' | 'coord-silence' | 'hot-burst' | 'host-down' | 'llm-95' | 'ceo-burst' | 'judge-backlog';
export type Domain = 'hold' | 'env' | 'cell' | 'tech';
export const DOMAINS: readonly Domain[] = ['hold', 'env', 'cell', 'tech'];
export const STRESSES: readonly StressId[] = ['coord-silence', 'hot-burst', 'host-down', 'llm-95', 'ceo-burst', 'judge-backlog'];

/** Seeded PRNG (mulberry32). Never Math.random — same seed ⇒ same day. */
export function seededRandom(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const expo = (r: () => number, mean: number) => -Math.log(1 - r()) * mean;
const pick = <T>(r: () => number, weights: readonly [T, number][]): T => {
  let x = r() * weights.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of weights) { x -= w; if (x <= 0) return v; }
  return weights[weights.length - 1][0];
};

export interface Structure {
  readonly id: StructureId;
  readonly label: string;
  /** hub = every ✋ goes to TC first · domain = 우편 집사 routes to the domain's loop agent (TC only for tech). */
  readonly routing: 'hub' | 'domain';
  /** Minutes before an unresolved hand re-asks the same ✋ (echo mail). Infinity = fingerprint dedupe. */
  readonly reaskMin: number;
  /** Escalate an unresolved ✋ to the next rung after N min on a rung (null = no ladder: answered-but-unresolved sits). */
  readonly ladderMin: number | null;
  /** Probability a writer-check resolver auto-answers a ✋ wrongly (and, without a ladder, hides it). */
  readonly wrongAutoResolve: number;
  /** Probability that one answer changes state (HOLD lifted · cell split · receipt issued), per domain, first rung. */
  readonly resolve: Readonly<Record<Domain, number>>;
  readonly assign: 'push' | 'push-wake' | 'pull';
  readonly assignLatencyMin: number;
  /** Share of ready cells a hand can see (home-space only vs federation pool). */
  readonly visibleReady: number;
  readonly holdMode: 'fog' | 'detect' | 'ledger';
  readonly hotLanes: boolean;
  readonly freshBase: boolean;
  readonly supplyPerH: number;
  /** Share of cells that make something (vs «find the original receipt» cells). */
  readonly makeShare: number;
  readonly doneWhenShare: number;
  /** Share of cells whose evidence a hand can produce (test universe allowed). */
  readonly evidenceShare: number;
  readonly reportPerHandH: number;
  readonly broadcastPerH: number;
  readonly opNoop: number;
  readonly opEnforce: boolean;
  readonly judgeAutoShare: number;
  readonly judgeServers: number;
  readonly greenCloser: number;
  /** Domain loop agents answer ✋ (S3/S4) instead of seats. */
  readonly agents: boolean;
  /** Body reaction latency of the answering agent/steward (cron wait vs event debounce), min. */
  readonly bodyReactMin: number;
  /** Throughput controller levers active (burst pregate host · extra land slot · oldest-first pregate). */
  readonly controller: boolean;
  /** OP is L0 only: routine OP mail goes to loop:coordinator. */
  readonly opL0: boolean;
  readonly landTickMin: number;
  /** A waiting hand mails «work/status?» every N min (push only · pull = `eln work next`, no mail). */
  readonly requestEveryMin: number;
  /** Controller turns the burst host on when the pregate queue exceeds this (headroom rule). */
  readonly burstAtQueue: number;
  /** PRs per hot file allowed in pregate→land at once (1 = strict lane · 3 = merge train of 3). */
  readonly laneWidth: number;
  /** Pregate rework multiplier (author precheck · self-review before push lowers it). */
  readonly errScale: number;
  /** WIP cap: hands stop pulling new cells while this many PRs wait for pregate (0 = no cap). */
  readonly wipCapPregateQ: number;
}

const base: Structure = {
  id: 'S0', label: 'S0 오늘 밤(관측)', routing: 'hub', reaskMin: 2.5, ladderMin: null, wrongAutoResolve: 0.38,
  resolve: { hold: 0.12, env: 0.15, cell: 0.3, tech: 0.65 }, assign: 'push', assignLatencyMin: 35, visibleReady: 0.35,
  holdMode: 'fog', hotLanes: false, freshBase: false, supplyPerH: 10, makeShare: 0.35, doneWhenShare: 0.3,
  evidenceShare: 0.2, reportPerHandH: 9, broadcastPerH: 45, opNoop: 0.75, opEnforce: false, judgeAutoShare: 0,
  greenCloser: 0.25, agents: false, bodyReactMin: 1, controller: false, opL0: false, landTickMin: 5, requestEveryMin: 9, judgeServers: 3, burstAtQueue: 6, laneWidth: 1, errScale: 1, wipCapPregateQ: 0,
};

export const STRUCTURES: Readonly<Record<StructureId, Structure>> = {
  S0: base,
  S1: {
    ...base, id: 'S1', label: 'S1 오늘 밤 수리(#40308–#40318)', reaskMin: 10, ladderMin: 10, wrongAutoResolve: 0.1,
    resolve: { hold: 0.2, env: 0.2, cell: 0.35, tech: 0.65 }, assign: 'push-wake', assignLatencyMin: 12,
    holdMode: 'detect', reportPerHandH: 2.5, broadcastPerH: 25, opNoop: 0.35, opEnforce: true, requestEveryMin: 30,
  },
  S2: {
    ...base, id: 'S2', label: 'S2 + 진짜 pull 풀 · 핫파일 차선', reaskMin: 10, ladderMin: 10, wrongAutoResolve: 0.1,
    resolve: { hold: 0.2, env: 0.2, cell: 0.6, tech: 0.65 }, assign: 'pull', assignLatencyMin: 1, visibleReady: 1,
    holdMode: 'detect', hotLanes: true, freshBase: true, supplyPerH: 14, makeShare: 0.5, doneWhenShare: 0.45,
    evidenceShare: 0.35, reportPerHandH: 2.5, broadcastPerH: 25, opNoop: 0.35, opEnforce: true, requestEveryMin: Infinity,
  },
  S3: {
    ...base, id: 'S3', label: 'S3 + 서브 조율자 루프 에이전트(✋ SLA 10분)', routing: 'domain', reaskMin: Infinity, ladderMin: 10,
    wrongAutoResolve: 0, resolve: { hold: 0.8, env: 0.75, cell: 0.85, tech: 0.65 }, assign: 'pull', assignLatencyMin: 1,
    visibleReady: 1, holdMode: 'ledger', hotLanes: true, freshBase: true, supplyPerH: 10, makeShare: 0.8, doneWhenShare: 0.8,
    evidenceShare: 0.8, reportPerHandH: 1, broadcastPerH: 12, opNoop: 0.2, opEnforce: true, judgeAutoShare: 0.7,
    greenCloser: 0.95, agents: true, bodyReactMin: 0.5, controller: true, requestEveryMin: Infinity,
  },
  S4: {
    ...base, id: 'S4', label: 'S4 끝 그림(조율자·수호자 루프 · OP=L0)', routing: 'domain', reaskMin: Infinity, ladderMin: 10,
    wrongAutoResolve: 0, resolve: { hold: 0.85, env: 0.85, cell: 0.9, tech: 0.7 }, assign: 'pull', assignLatencyMin: 1,
    visibleReady: 1, holdMode: 'ledger', hotLanes: true, freshBase: true, supplyPerH: 12, makeShare: 0.85, doneWhenShare: 0.9,
    evidenceShare: 0.85, reportPerHandH: 0.5, broadcastPerH: 6, opNoop: 0.1, opEnforce: true, judgeAutoShare: 0.75,
    greenCloser: 0.97, agents: true, bodyReactMin: 0.3, controller: true, opL0: true, requestEveryMin: Infinity,
  },
};

export interface HelperPolicy {
  /** Helper slots per loop agent: 0 · 2 (collector graph + 1 capsule) · 4 (collector + 2 capsules + 1 borrowed hand). */
  readonly perAgent: 0 | 2 | 4;
  /** Federation-wide concurrent capsule cap (LLM accounts). */
  readonly fedCapsuleCap: number;
}

export interface SimOptions {
  readonly structure: StructureId | Structure;
  readonly seed: number;
  readonly hours?: number;
  readonly stress?: StressId;
  readonly stressAtMin?: number;
  readonly helpers?: HelperPolicy;
  /** Override one knob (sensitivity). */
  readonly patch?: Partial<Structure>;
}

const HAND_TYPES = [
  { kind: 'CX', n: 10, speed: 1, err: 0.25, llm: 'codex' },
  { kind: 'CC', n: 3, speed: 0.85, err: 0.18, llm: 'claude' },
  { kind: 'POOL', n: 4, speed: 1.2, err: 0.32, llm: 'codex' },
  { kind: 'MVP', n: 1, speed: 1.1, err: 0.3, llm: 'codex' },
] as const;
const HOT_FILES = 6;
const P_HOT = 0.5;
const CELL_MEAN_MIN = 45;
const DOMAIN_MIX: readonly [Domain, number][] = [['hold', 0.4], ['env', 0.2], ['cell', 0.25], ['tech', 0.15]];
const DEPTH_MIN: Readonly<Record<Domain, number>> = { hold: 8, env: 10, cell: 5, tech: 7 };
const PREGATE_HOSTS = [
  { id: 'host-a', cap: 2, min: 15, oom: 0.02 },
  { id: 'host-b', cap: 2, min: 18, oom: 0.08 },
  { id: 'host-c', cap: 1, min: 25, oom: 0.12 },
] as const;
const BURST_HOST = { id: 'burst', cap: 3, min: 16, oom: 0.03 };
export type AgentId = 'judge-butler' | 'guardian' | 'pool-broker' | 'board';
export const AGENTS: readonly AgentId[] = ['judge-butler', 'guardian', 'pool-broker', 'board'];
const AGENT_OF: Readonly<Record<Exclude<Domain, 'tech'>, AgentId>> = { hold: 'judge-butler', env: 'guardian', cell: 'pool-broker' };
/** Judgment depth per item (min) — investigation · evidence · drafting. */
const AGENT_DEPTH: Readonly<Record<AgentId, number>> = { 'judge-butler': 8, guardian: 10, 'pool-broker': 5, board: 12 };
/** Domain work besides ✋ (HOLD disposition · test-universe provisioning · claim conflicts), items/h. Board drafts on demand. */
const AGENT_WORK_PER_H: Readonly<Record<AgentId, number>> = { 'judge-butler': 4, guardian: 3, 'pool-broker': 2, board: 0 };
const AGENT_SLA_MIN = 10;
interface Item { ask: Ask | null; born: number }
const CAPSULE_LLM_CALLS = 4;

interface Hand { id: number; kind: string; speed: number; err: number; llm: string; state: 'idle' | 'work' | 'blocked' | 'held' | 'lent'; cell: Cell | null; left: number; waitAssignUntil: number; workMin: number; heldFrozen: boolean }
interface Cell { id: number; make: boolean; doneWhen: boolean; hot: number; askedAt: number }
interface Ask { id: number; hand: Hand; domain: Domain; born: number; rung: number; rungAt: number; nextAt: number; inQueue: boolean; serving: boolean; hidden: boolean; resolved: number; mails: number }
interface PR { id: number; cell: Cell; hand: Hand | null; hot: number; base: number; stage: 'lane' | 'pregate-q' | 'pregate' | 'fix' | 'judge-q' | 'judge' | 'land-q' | 'rebase' | 'landed'; t: number; born: number; host: string | null }

export interface SimResult {
  readonly structure: StructureId;
  readonly seed: number;
  readonly stress: StressId;
  readonly helpers: number;
  readonly hours: number;
  readonly landsPerH: number;
  readonly greensPerH: number;
  readonly mailsPerH: number;
  readonly asksPerH: number;
  /** ✋ mails incl. echo re-asks (what fed-chatlog counts as NEED HUMAN). */
  readonly askMailsPerH: number;
  readonly pingPongRatio: number;
  readonly tcInboundPerH: number;
  readonly askWaitP50: number;
  readonly askWaitP95: number;
  readonly askOpenEnd: number;
  readonly handUtil: number;
  readonly idleHandsAvg: number;
  readonly readyAvg: number;
  readonly readyEmptyShare: number;
  readonly opNoopRatio: number;
  readonly opTurnsPerH: number;
  readonly overdueEnd: number;
  readonly staleRefusals: number;
  readonly ceoInterrupts: number;
  readonly llmCallsPerH: number;
  readonly asksHandledPerH: number;
  /** Loop agents (of 4) whose p95 time-to-start ≤ 10 min. */
  readonly domainsInSla: number;
  /** Items (✋ + domain work + drafts) loop agents started per hour — coverage. */
  readonly agentItemsPerH: number;
  readonly agentStartP95: number;
  readonly agentSlaShare: number;
  readonly draftedPerH: number;
  readonly util: Readonly<Record<'pregate' | 'judge' | 'land' | 'hands' | 'agents', number>>;
  readonly hourlyLands: readonly number[];
  readonly hourlyGreens: readonly number[];
  readonly hourlyOpenAsks: readonly number[];
  /** Backlog every 10 min: open ✋ + PRs queued at pregate/judge/land + hands waiting with ready work. */
  readonly backlog: readonly number[];
  readonly calib: { readonly first4h: { mailsPerH: number; asksPerH: number; askMailsPerH: number; landsPerH: number; greensPerH: number; tcInboundPerH: number; idleHands: number; pingPong: number; opNoop: number } };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};

/** Run one simulated day. Pure: same options ⇒ same result. */
export function simulate(opts: SimOptions): SimResult {
  const S: Structure = { ...(typeof opts.structure === 'string' ? STRUCTURES[opts.structure] : opts.structure), ...(opts.patch ?? {}) };
  const r = seededRandom(opts.seed * 7919 + S.id.charCodeAt(1) * 104729 + (opts.stress ? STRESSES.indexOf(opts.stress) + 1 : 0) * 31);
  const H = opts.hours ?? 24;
  const T = H * 60;
  const stress = opts.stress ?? 'none';
  const sAt = opts.stressAtMin ?? 8 * 60;
  const helpers = S.agents ? (opts.helpers ?? { perAgent: 2, fedCapsuleCap: 8 }) : { perAgent: 0 as const, fedCapsuleCap: 0 };
  const inStress = (t: number, durMin: number) => stress !== 'none' && t >= sAt && t < sAt + durMin;

  // ── state ──
  const hands: Hand[] = [];
  for (const ht of HAND_TYPES) for (let i = 0; i < ht.n; i++)
    hands.push({ id: hands.length, kind: ht.kind, speed: ht.speed, err: ht.err, llm: ht.llm, state: 'idle', cell: null, left: 0, waitAssignUntil: 0, workMin: 0, heldFrozen: false });
  let cellSeq = 0, askSeq = 0, prSeq = 0;
  const newCell = (): Cell => ({ id: cellSeq++, make: r() < S.makeShare, doneWhen: r() < S.doneWhenShare, hot: r() < P_HOT ? Math.floor(r() * HOT_FILES) : -1, askedAt: -1 });
  let ready = 0; let readyAcc = 0;
  const asks: Ask[] = [];
  const prs: PR[] = [];
  // Tonight's backlog: yellow PRs waiting on judge/land with old bases (green 1 / yellow 112).
  for (let i = 0; i < 50; i++) {
    const c = newCell(); c.make = true;
    prs.push({ id: prSeq++, cell: c, hand: null, hot: r() < P_HOT ? Math.floor(r() * HOT_FILES) : -1, base: -Math.floor(r() * 90), stage: 'judge-q', t: 0, born: -60, host: null });
  }
  ready = Math.round(20 * S.visibleReady);
  // Hold fog: tonight TC's blanket hold froze 18 hands at t=0.
  let holdUntil = S.holdMode === 'fog' ? 6 * 60 + expo(r, 120) : S.holdMode === 'detect' ? 30 : 10;
  let holdScope = S.holdMode === 'ledger' ? 2 : 14;
  let overdue = S.id === 'S0' ? 900 : S.opEnforce ? 0 : 400;
  const landsHot: number[][] = Array.from({ length: HOT_FILES }, () => []);
  const landsAll: number[] = [];

  // metrics
  let mails = 0, askMails = 0, echo = 0, tcIn = 0, opTurns = 0, opNoops = 0, stale = 0, ceo = 0, llmCalls = 0, asksTotal = 0, asksHandled = 0;
  let workMin = 0, idleAcc = 0, readyAcc2 = 0, readyEmpty = 0, pregateBusy = 0, judgeBusy = 0, landBusy = 0, agentBusy = 0, agentCap = 0;
  const waits: number[] = []; const waitsByDomain: Record<Domain, number[]> = { hold: [], env: [], cell: [], tech: [] };
  const hourlyLands = new Array(H).fill(0); const hourlyGreens = new Array(H).fill(0); const hourlyOpen = new Array(H).fill(0);
  const hourlyMails = new Array(H).fill(0); const hourlyAsks = new Array(H).fill(0); const hourlyAskMails = new Array(H).fill(0); const hourlyTc = new Array(H).fill(0); const hourlyIdle = new Array(H).fill(0);
  const hourlyEcho = new Array(H).fill(0); const hourlyOpTurns = new Array(H).fill(0); const hourlyOpNoop = new Array(H).fill(0);
  const mail = (t: number, n = 1, isEcho = false, toTc = false) => {
    mails += n; hourlyMails[Math.min(H - 1, Math.floor(t / 60))] += n;
    if (isEcho) { echo += n; hourlyEcho[Math.min(H - 1, Math.floor(t / 60))] += n; }
    if (toTc) { tcIn += n; hourlyTc[Math.min(H - 1, Math.floor(t / 60))] += n; }
  };
  const green = (t: number) => { hourlyGreens[Math.min(H - 1, Math.floor(t / 60))]++; };

  // answer rungs: hub = TC → owner seat → OP → CEO · domain = agent → L0 seat → OP → CEO
  const tcSilent = (t: number) => inStress(t, 180);
  const opQueue: Ask[] = [];
  let opBusyUntil = 0;
  const capsulesInUse = { n: 0 };
  const agentQ = Object.fromEntries(AGENTS.map((id) => [id, { busy: [] as { until: number; item: Item; capsule: boolean }[], queue: [] as Item[] }])) as Record<AgentId, { busy: { until: number; item: Item; capsule: boolean }[]; queue: Item[] }>;
  const agentStartWaits: Record<AgentId, number[]> = { 'judge-butler': [], guardian: [], 'pool-broker': [], board: [] };
  let agentItems = 0; let drafted = 0;
  const capsuleSlots = helpers.perAgent >= 4 ? 2 : helpers.perAgent >= 2 ? 1 : 0;
  const collector = helpers.perAgent >= 2;
  const borrow = helpers.perAgent >= 4;
  const borrowed: Record<AgentId, Hand | null> = { 'judge-butler': null, guardian: null, 'pool-broker': null, board: null };
  const fedCap = (t: number) => (stress === 'llm-95' && inStress(t, 240) ? 2 : helpers.fedCapsuleCap);
  const llmPressure = (t: number) => (stress === 'llm-95' && inStress(t, 240) ? 0.5 : 0.85);

  const raise = (t: number, hand: Hand, domain: Domain) => {
    const a: Ask = { id: askSeq++, hand, domain, born: t, rung: 0, rungAt: t, nextAt: t + S.bodyReactMin + (S.routing === 'hub' ? expo(r, 0.5) : 0), inQueue: false, serving: false, hidden: false, resolved: -1, mails: 1 };
    asks.push(a); asksTotal++; askMails++; hourlyAskMails[Math.min(H - 1, Math.floor(t / 60))]++; hourlyAsks[Math.min(H - 1, Math.floor(t / 60))]++;
    hand.state = 'blocked';
    mail(t, 1, false, S.routing === 'hub' || domain === 'tech');
    if (S.wrongAutoResolve && r() < S.wrongAutoResolve) { mail(t, 1, true); if (S.ladderMin === null) a.hidden = true; }
  };
  const resolveAsk = (t: number, a: Ask) => {
    a.resolved = t; waits.push(t - a.born); waitsByDomain[a.domain].push(t - a.born); asksHandled++;
    const h = a.hand;
    if (h.state === 'blocked') h.state = h.cell ? 'work' : 'idle';
  };
  const rungResolveP = (a: Ask): number => {
    if (a.rung === 0) return S.resolve[a.domain] + (S.agents && collector ? 0.07 : 0);
    if (a.rung === 1) return S.agents ? 0.8 : a.domain === 'env' ? 0.45 : 0.6;
    if (a.rung === 2) return 0.75;
    return 1; // CEO
  };
  const serveTime = (a: Ask, t: number): number => {
    if (S.routing === 'hub' && a.rung === 0) return tcSilent(t) ? Infinity : expo(r, 0.4);
    if (a.rung === 1 && !S.agents) return a.domain === 'env' ? (r() < 0.2 ? Infinity : expo(r, 28)) : expo(r, 2.5);
    const d = DEPTH_MIN[a.domain] * (collector ? 0.65 : 1);
    return expo(r, d);
  };

  const pregateQ: PR[] = []; const judgeQ: PR[] = prs.filter(p => p.stage === 'judge-q'); const landQ: PR[] = [];
  const laneBusy = new Array(HOT_FILES).fill(0);
  const hostBusy: Record<string, { until: number; pr: PR }[]> = { 'host-a': [], 'host-b': [], 'host-c': [], burst: [] };
  const judges: { until: number; pr: PR | null }[] = Array.from({ length: S.judgeServers }, () => ({ until: 0, pr: null }));
  let ceoBurstLeft = 0;
  const backlog: number[] = [];

  for (let t = 0; t < T; t++) {
    const hour = Math.floor(t / 60);
    // ── stress injections ──
    if (stress === 'hot-burst' && t === sAt) for (let i = 0; i < 10; i++) {
      const c = newCell(); c.make = true; c.hot = 0;
      const p: PR = { id: prSeq++, cell: c, hand: null, hot: 0, base: t - 30, stage: S.hotLanes ? 'lane' : 'pregate-q', t, born: t, host: null };
      prs.push(p); if (!S.hotLanes) pregateQ.push(p);
    }
    if (stress === 'judge-backlog' && t === sAt) for (let i = 0; i < 40; i++) {
      const c = newCell(); c.make = true;
      const p: PR = { id: prSeq++, cell: c, hand: null, hot: r() < P_HOT ? Math.floor(r() * HOT_FILES) : -1, base: t - 60, stage: 'judge-q', t, born: t, host: null };
      prs.push(p); judgeQ.push(p);
    }
    if (stress === 'ceo-burst' && t === sAt) { ceoBurstLeft = 10; for (let i = 0; i < 10; i++) { ready++; mail(t, S.opL0 ? 1 : 3); } }

    // ── board supply ──
    readyAcc += S.supplyPerH / 60 * S.visibleReady;
    while (readyAcc >= 1) { ready++; readyAcc--; }
    if (ready > 60) ready = 60;

    // ── holds ──
    if (r() < 0.12 / 60) { // a new blanket/scoped hold
      holdUntil = Math.max(holdUntil, t + (S.holdMode === 'fog' ? 6 * 60 + expo(r, 120) : S.holdMode === 'detect' ? expo(r, 30) : expo(r, 15)));
      holdScope = S.holdMode === 'ledger' ? 2 : 14;
      if (S.holdMode === 'fog') ceo++; // only a CEO notices a fog hold (13h #178978)
    }
    const holdOn = t < holdUntil;
    for (const h of hands) h.heldFrozen = holdOn && h.id < holdScope;

    // ── hands ──
    let idle = 0;
    for (const h of hands) {
      if (h.state === 'lent') continue;
      if (h.heldFrozen && h.state !== 'blocked') {
        // a frozen hand asks about the hold itself («HOLD 유지 · 원영수 필요» ✋)
        if (r() < 1 / 15) { h.state = h.state === 'work' ? 'work' : 'idle'; raise(t, h, 'hold'); }
        else if (r() < 0.05) mail(t, 1, false, S.routing === 'hub');
        idle++; continue;
      }
      if (h.state === 'blocked') idle++;
      if (h.state === 'idle') {
        idle++;
        if (ceoBurstLeft > 0 && ready > 0) { ceoBurstLeft--; }
        if (S.assign !== 'pull' && h.waitAssignUntil === 0) {
          h.waitAssignUntil = t + expo(r, S.assignLatencyMin * (tcSilent(t) && S.routing === 'hub' ? 6 : 1));
          if (S.assign === 'push') { mail(t, 1); if (r() < 0.25) mail(t, 2, true); }
        }
        if ((S.assign === 'pull' || t >= h.waitAssignUntil) && ready > 0 && !(S.wipCapPregateQ > 0 && pregateQ.length >= S.wipCapPregateQ)) {
          ready--; h.waitAssignUntil = 0;
          const c = newCell(); h.cell = c; h.state = 'work';
          h.left = expo(r, CELL_MEAN_MIN * h.speed) + 5;
          if (S.assign !== 'pull') mail(t, 1);
        }
        continue;
      }
      if (h.state === 'work' && h.cell) {
        const speed = h.llm === 'codex' ? llmPressure(t) / 0.85 : 1;
        h.left -= speed; workMin++;
        // ✋ hazard: receipt-finding cells block far more (B3); make cells block on HOLD/env/tech.
        const pAsk = (h.cell.make ? 0.25 : 0.7) / (CELL_MEAN_MIN * h.speed);
        if (h.cell.askedAt < 0 && r() < pAsk) {
          h.cell.askedAt = t;
          const dom = h.cell.make ? pick(r, DOMAIN_MIX) : pick(r, [['hold', 0.6], ['env', 0.25], ['cell', 0.15]] as [Domain, number][]);
          raise(t, h, dom); continue;
        }
        if (h.left <= 0) {
          const c = h.cell; h.cell = null; h.state = 'idle';
          if (c.make) {
            const p: PR = { id: prSeq++, cell: c, hand: h, hot: c.hot, base: t, stage: S.hotLanes && c.hot >= 0 ? 'lane' : 'pregate-q', t, born: t, host: null };
            prs.push(p); if (p.stage === 'pregate-q') pregateQ.push(p);
            mail(t, 1, false, S.routing === 'hub');
          } else if (r() < S.evidenceShare && !h.heldFrozen) {
            if (c.doneWhen && r() < S.greenCloser) green(t);
            mail(t, 1, false, S.routing === 'hub');
          } else {
            mail(t, 2, false, S.routing === 'hub'); // «block» + reply: receipt cannot be made
          }
        }
      }
      if (r() < S.reportPerHandH / 60) mail(t, 1, false, S.routing === 'hub');
    }
    for (const h of hands) if ((h.state === 'idle' || h.heldFrozen) && h.state !== 'lent' && Number.isFinite(S.requestEveryMin) && r() < 1 / S.requestEveryMin) {
      const toTc = S.routing === 'hub' && r() < 0.4;
      mail(t, 1, false, toTc);
      if (toTc && !tcSilent(t) && r() < 0.8) { mail(t, 1); llmCalls++; }
    }
    idleAcc += idle; hourlyIdle[Math.min(H - 1, hour)] += idle;

    // ── ✋ rungs ──
    for (const a of asks) {
      if (a.resolved >= 0 || a.hidden || a.serving) continue;
      // ladder: escalate after ladderMin on a rung
      if (S.ladderMin !== null && t - a.rungAt >= (a.rung === 0 && S.agents ? 10 : a.rung >= 2 ? 60 : S.ladderMin) && a.rung < 3) {
        if (a.inQueue) { if (a.rung === 0 && S.agents && a.domain !== 'tech') { const q = agentQ[AGENT_OF[a.domain]].queue; const i = q.findIndex((x) => x.ask === a); if (i >= 0) q.splice(i, 1); } else if (a.rung === 2) { const i = opQueue.indexOf(a); if (i >= 0) opQueue.splice(i, 1); } }
        a.rung++; a.rungAt = t; a.nextAt = t + S.bodyReactMin; a.inQueue = false; mail(t, 1);
        if (a.rung === 3) { ceo++; }
      }
      if (t < a.nextAt || a.inQueue) continue;
      if (a.rung === 2) { opQueue.push(a); a.inQueue = true; continue; }
      if (a.rung === 0 && S.agents && a.domain !== 'tech') { agentQ[AGENT_OF[a.domain]].queue.push({ ask: a, born: a.born }); a.inQueue = true; continue; }
      if (a.rung === 3) { resolveAsk(t, a); continue; }
      const st = serveTime(a, t);
      if (!Number.isFinite(st)) { a.nextAt = t + 1; continue; }
      a.serving = true; a.nextAt = t + st;
      llmCalls += 1;
    }
    for (const a of asks) {
      if (!a.serving || t < a.nextAt || a.resolved >= 0) continue;
      a.serving = false; mail(t, 1, a.mails > 1, false);
      if (r() < rungResolveP(a)) resolveAsk(t, a);
      else if (S.ladderMin === null || Number.isFinite(S.reaskMin)) {
        a.mails++; a.nextAt = t + (Number.isFinite(S.reaskMin) ? expo(r, S.reaskMin) : 1e9);
        if (Number.isFinite(S.reaskMin)) { mail(a.nextAt, 1, true, S.routing === 'hub'); askMails++; hourlyAskMails[Math.min(H - 1, Math.floor(a.nextAt / 60))]++; }
      } else a.nextAt = 1e9; // dedupe: wait for the ladder
    }
    // Loop agents serve their queues: voice (1 server) + capsule helpers (LLM, federation cap) + collector graph (depth ×0.65,
    // LLM 0) + one borrowed pool hand when the backlog is deep. A helper's output passes the agent's verify node (1.5 min ·
    // 12 % redo) before it acts; the main voice turn is never held by a helper.
    if (S.agents) {
      for (const id of AGENTS) if (r() < AGENT_WORK_PER_H[id] / 60) agentQ[id].queue.push({ ask: null, born: t });
      const idleNow = hands.filter((h) => h.state === 'idle').length;
      if (ready < 2 * idleNow + 4 && agentQ.board.queue.length < 2) agentQ.board.queue.push({ ask: null, born: t });
      for (const id of AGENTS) {
        const q = agentQ[id];
        for (let i = q.busy.length - 1; i >= 0; i--) if (q.busy[i].until <= t) {
          const b = q.busy.splice(i, 1)[0];
          if (b.capsule) capsulesInUse.n--;
          if (!b.item.ask && id === 'board') { ready++; drafted++; }
        }
        if (borrow && !borrowed[id] && q.queue.length > 3) {
          const free = hands.filter((h) => h.state === 'idle' && !h.heldFrozen);
          if (free.length >= 3) { borrowed[id] = free[0]; free[0].state = 'lent'; }
        }
        if (borrowed[id] && q.queue.length <= 1 && q.busy.length <= 1) { borrowed[id]!.state = 'idle'; borrowed[id] = null; }
        const capsulesHere = q.busy.filter((b) => b.capsule).length;
        const capsuleRoom = Math.max(0, Math.min(capsuleSlots - capsulesHere, fedCap(t) - capsulesInUse.n));
        const servers = 1 + capsulesHere + capsuleRoom + (borrowed[id] ? 1 : 0);
        agentCap += servers; agentBusy += Math.min(servers, q.busy.length);
        while (q.busy.length < servers && q.queue.length) {
          const item = q.queue.shift()!;
          const voiceFree = q.busy.filter((b) => !b.capsule).length < 1 + (borrowed[id] ? 1 : 0);
          const capsule = !voiceFree && capsuleRoom > 0 && q.busy.filter((b) => b.capsule).length < capsuleSlots && capsulesInUse.n < fedCap(t);
          if (!voiceFree && !capsule) { q.queue.unshift(item); break; }
          let st = expo(r, AGENT_DEPTH[id] * (collector ? 0.65 : 1));
          if (capsule) { st += 1.5; capsulesInUse.n++; llmCalls += CAPSULE_LLM_CALLS; if (r() < 0.12) st += expo(r, 4); }
          else llmCalls += 1;
          q.busy.push({ until: t + st, item, capsule });
          agentStartWaits[id].push(t - item.born); agentItems++;
          if (item.ask) { item.ask.inQueue = false; item.ask.serving = true; item.ask.nextAt = t + st; }
        }
      }
    }
    // OP turns: inbound triggers; each turn handles ≤3 escalated ✋; noop turns resolve nothing.
    if (t >= opBusyUntil) {
      const inboundRate = S.opL0 ? 4 : S.agents ? 15 : 94; // mails/h to OP
      if (opQueue.length || r() < inboundRate / 60 / 3) {
        opTurns++; hourlyOpTurns[Math.min(H - 1, hour)]++;
        const extra = ceoBurstLeft > 0 && !S.opL0 ? 6 : 0;
        const noop = r() < S.opNoop;
        llmCalls += 1;
        opBusyUntil = t + 2 + overdue / 250 + extra;
        if (noop) {
          opNoops++; hourlyOpNoop[Math.min(H - 1, hour)]++;
          if (!S.opEnforce && r() < 0.5) overdue += r() < 0.7 ? 1 : 0;
          mail(t, 1);
        } else {
          for (let k = 0; k < 3 && opQueue.length; k++) {
            const a = opQueue.shift()!; a.inQueue = false;
            if (r() < rungResolveP(a)) resolveAsk(t, a); else { a.nextAt = 1e9; }
            mail(t, 1);
          }
          if (S.opEnforce && overdue > 0) overdue = Math.max(0, overdue - 40);
        }
      }
    }
    // coordinators' broadcasts & bulletins
    if (r() < S.broadcastPerH / 60) mail(t, 1, false, false);

    // ── hot lanes → pregate ──
    if (S.hotLanes) for (const p of prs) if (p.stage === 'lane' && laneBusy[p.hot] < S.laneWidth) { laneBusy[p.hot]++; p.stage = 'pregate-q'; pregateQ.push(p); }
    // ── pregate hosts ──
    const hosts = [...PREGATE_HOSTS, ...(S.controller && (pregateQ.length > S.burstAtQueue || hostBusy.burst.length > 0) ? [BURST_HOST] : [])].filter(hh => !(stress === 'host-down' && inStress(t, 180) && hh.id === 'host-a'));
    let pgCap = 0; let pgRun = 0;
    for (const hh of hosts) {
      pgCap += hh.cap;
      const run = hostBusy[hh.id];
      for (let i = run.length - 1; i >= 0; i--) if (run[i].until <= t) {
        const p = run[i].pr; run.splice(i, 1);
        const errBase = (p.hand ? p.hand.err : 0.25) * S.errScale;
        if (r() < hh.oom) { p.stage = 'pregate-q'; pregateQ.push(p); continue; }
        if (r() < errBase * (llmPressure(t) < 0.6 ? 1.3 : 1)) { p.stage = 'fix'; p.t = t + expo(r, 20); continue; }
        p.stage = 'judge-q'; judgeQ.push(p);
      }
      if (S.controller) pregateQ.sort((a, b) => a.born - b.born);
      while (run.length < hh.cap && pregateQ.length) {
        const p = pregateQ.shift()!; p.stage = 'pregate'; p.host = hh.id;
        if (S.freshBase) p.base = t;
        run.push({ until: t + expo(r, hh.min) + 3, pr: p });
      }
      pgRun += run.length;
    }
    pregateBusy += pgCap ? pgRun / pgCap : 0;
    for (const hh of ['host-a', 'burst'] as const) if (!hosts.some(x => x.id === hh)) {
      for (const x of hostBusy[hh].splice(0)) { x.pr.stage = 'pregate-q'; pregateQ.push(x.pr); }
    }
    for (const p of prs) if (p.stage === 'fix' && t >= p.t) { p.stage = 'pregate-q'; pregateQ.push(p); }
    for (const p of prs) if (p.stage === 'rebase' && t >= p.t) { p.stage = 'pregate-q'; pregateQ.push(p); }
    // ── judge ──
    for (const j of judges) {
      if (j.pr && t >= j.until) { j.pr.stage = 'land-q'; landQ.push(j.pr); j.pr = null; }
      if (!j.pr && judgeQ.length) {
        const p = judgeQ.shift()!; p.stage = 'judge'; j.pr = p;
        const auto = r() < S.judgeAutoShare;
        j.until = t + (auto ? 1 : expo(r, 12));
        if (!auto) llmCalls += 1;
      }
      if (j.pr) judgeBusy++;
    }
    if (S.judgeAutoShare > 0) { // judge-butler auto-binds same-head receipts in parallel to the JUD seats
      for (let k = 0; k < 4 && judgeQ.length; k++) {
        if (r() < S.judgeAutoShare) { const p = judgeQ.shift()!; p.stage = 'land-q'; landQ.push(p); } else break;
      }
    }
    // ── land graph ──
    const slots = 2 + (S.controller && landQ.length > 6 ? 1 : 0);
    if (t % S.landTickMin === 0) {
      let used = 0;
      while (used < slots && landQ.length) {
        const p = landQ.shift()!; used++;
        const sinceAll = landsAll.filter(x => x > p.base).length;
        const sinceHot = p.hot >= 0 ? landsHot[p.hot].filter(x => x > p.base).length : 0;
        const pRefuse = 1 - Math.pow(S.freshBase ? 0.99 : 0.97, sinceAll) * Math.pow(S.hotLanes && S.laneWidth > 1 ? 0.95 : 0.72, sinceHot);
        if (r() < pRefuse) { stale++; p.stage = 'rebase'; p.t = t + expo(r, 15); mail(t, 1); continue; }
        p.stage = 'landed'; landsAll.push(t); if (p.hot >= 0) { landsHot[p.hot].push(t); if (S.hotLanes) laneBusy[p.hot] = Math.max(0, laneBusy[p.hot] - 1); }
        hourlyLands[Math.min(H - 1, hour)]++;
        mail(t, 1);
        if (p.cell.doneWhen && r() < S.evidenceShare && r() < S.greenCloser) green(t);
      }
      landBusy += used / slots;
    }
    // a refused hot PR keeps its lane (rebase goes back through pregate)
    ready = Math.max(0, ready);
    readyAcc2 += ready; if (ready === 0) readyEmpty++;
    const open = asks.filter(a => a.resolved < 0).length;
    if (t % 10 === 0) backlog.push(open + pregateQ.length + judgeQ.length + landQ.length + prs.filter((p) => p.stage === 'fix' || p.stage === 'rebase' || p.stage === 'lane').length);
    if (t % 60 === 59) hourlyOpen[hour] = open;
  }

  // censored waits (never resolved by the end) count at their age — 13h ✋ shows up in p95
  for (const a of asks) if (a.resolved < 0) { waits.push(T - a.born); waitsByDomain[a.domain].push(T - a.born); }
  const allStarts = AGENTS.flatMap((id) => agentStartWaits[id]);
  const domainsInSla = S.agents ? AGENTS.filter((id) => agentStartWaits[id].length && pct(agentStartWaits[id], 0.95) <= AGENT_SLA_MIN).length : 0;
  const lands = hourlyLands.reduce((s, x) => s + x, 0); const greens = hourlyGreens.reduce((s, x) => s + x, 0);
  const sum4 = (xs: number[]) => xs.slice(0, 4).reduce((s, x) => s + x, 0) / 4;
  const handsN = hands.length;
  return {
    structure: S.id, seed: opts.seed, stress, helpers: helpers.perAgent, hours: H,
    landsPerH: lands / H, greensPerH: greens / H, mailsPerH: mails / H, asksPerH: asksTotal / H, askMailsPerH: askMails / H,
    pingPongRatio: mails ? echo / mails : 0, tcInboundPerH: tcIn / H,
    askWaitP50: pct(waits, 0.5), askWaitP95: pct(waits, 0.95), askOpenEnd: asks.filter(a => a.resolved < 0).length,
    handUtil: workMin / (handsN * T), idleHandsAvg: idleAcc / T, readyAvg: readyAcc2 / T, readyEmptyShare: readyEmpty / T,
    opNoopRatio: opTurns ? opNoops / opTurns : 0, opTurnsPerH: opTurns / H, overdueEnd: overdue,
    staleRefusals: stale, ceoInterrupts: ceo, llmCallsPerH: llmCalls / H, asksHandledPerH: asksHandled / H, domainsInSla, agentItemsPerH: agentItems / H, agentStartP95: pct(allStarts, 0.95),
    agentSlaShare: allStarts.length ? allStarts.filter((w) => w <= AGENT_SLA_MIN).length / allStarts.length : 0, draftedPerH: drafted / H,
    util: {
      pregate: pregateBusy / T, judge: judgeBusy / (T * Math.max(1, S.judgeServers)), land: landBusy / (T / S.landTickMin),
      hands: workMin / (handsN * T), agents: agentCap ? agentBusy / agentCap : 0,
    },
    hourlyLands, hourlyGreens, hourlyOpenAsks: hourlyOpen, backlog,
    calib: { first4h: {
      mailsPerH: sum4(hourlyMails), asksPerH: sum4(hourlyAsks), askMailsPerH: sum4(hourlyAskMails), landsPerH: sum4(hourlyLands), greensPerH: sum4(hourlyGreens),
      tcInboundPerH: sum4(hourlyTc), idleHands: sum4(hourlyIdle) / 60,
      pingPong: hourlyMails.slice(0, 4).reduce((s, x) => s + x, 0) ? hourlyEcho.slice(0, 4).reduce((s, x) => s + x, 0) / hourlyMails.slice(0, 4).reduce((s, x) => s + x, 0) : 0,
      opNoop: hourlyOpTurns.slice(0, 4).reduce((s, x) => s + x, 0) ? hourlyOpNoop.slice(0, 4).reduce((s, x) => s + x, 0) / hourlyOpTurns.slice(0, 4).reduce((s, x) => s + x, 0) : 0,
    } },
  };
}
