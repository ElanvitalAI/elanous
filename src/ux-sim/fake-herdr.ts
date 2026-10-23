// Fake herdr server for tests of code that drives the `herdr` CLI (TUI-HERDR-NAMED-AGENT).
//
// The real herdr 0.9.1 needs a live server socket and a terminal pane; a gate Pod has neither.
// This device answers the few agent/pane calls `herdr-prompt.ts` makes, as a `HerdrCliRunner`
// (argv in → rc · stdout · stderr out), from an in-memory pane table:
//   agent get <target>                    → {"result":{"agent":{…}}} · agent_not_found (rc1)
//   agent wait <target> [--until S]… [--timeout MS] → returns at once when the status already matches,
//                                           otherwise on the next matching transition · timeout (rc1)
//   pane run <pane> <text>                → records the submission · calls `onRun` (the test's «TUI»)
//   pane report-agent <pane>… --source S --agent A --state X --seq N
//                                         → self-reported agent (herdr «Integrate your own agent»)
//   pane release-agent <pane> --source S --agent A --seq N → releases it
//   pane report-agent-session …           → rc0 · no-op (measured: neither registers nor moves the state seq)
//   agent list                            → reported agents (`reportedAgents()` is the same list)
// Report faults (`reportFault`, TUI-HERDR-STATUS-STALE): a `pane report-agent` can answer as a client
// timeout — `applied-then-timeout` (the server took it, the answer came too late: the 10-22 n8n shape)
// or `timeout` (never applied). The answer is `{code:null, stderr:'timeout', timedOut:true}`.
// Report/release seq rule measured on herdr 0.9.1 (10-22 · isolated session `tf-exit-race`):
//   a report/release is applied only when its seq is above the last applied seq of that pane·source
//   (smaller is rc0 and ignored); a release of an agent that is not registered is rc0 and does NOT
//   record its seq — so a smaller-seq report arriving after it still registers (the exit-race ghost).
// Error envelopes follow the shape measured on herdr 0.9.1 (10-22 · isolated session `tf-herdr-e4`):
//   {"error":{"code":"…","message":"…"},"id":"cli:agent:get"} on stderr, exit 1.
//
// ⛔ This is not a herdr simulator: it fixes only those answers and the «matches now → return now»
// wait rule from the herdr agent-automation doc. Real herdr behaviour stays with the isolated-session E4.

export type FakeHerdrStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface FakeHerdrPane {
  readonly paneId: string;
  /** Reported or detected agent label (`elanous`, `codex`, …). */
  agent: string;
  name?: string;
  status: FakeHerdrStatus;
  stateChangeSeq: number;
}

export interface FakeHerdrRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set only by `reportFault` — the client gave up waiting (the report may or may not have been applied). */
  readonly timedOut?: boolean;
}

/** How one `pane report-agent` call fails (see `FakeHerdrOpts.reportFault`). */
export type FakeHerdrReportFault = 'applied-then-timeout' | 'timeout';

export interface FakeHerdrSubmission {
  readonly paneId: string;
  readonly text: string;
}

export interface FakeHerdr {
  /** The `HerdrCliRunner` the code under test receives. */
  run(argv: readonly string[], timeoutMs: number): Promise<FakeHerdrRunResult>;
  /** Move a pane to a new status (bumps `state_change_seq`, wakes matching waits). */
  setStatus(paneId: string, status: FakeHerdrStatus): void;
  pane(paneId: string): FakeHerdrPane | undefined;
  /** Every `pane run` submission, in order. */
  submissions(): FakeHerdrSubmission[];
  /** Every argv the runner saw, in order. */
  calls(): string[][];
  /**
   * The same answers as `run` for the commands that never wait (report-agent · release-agent ·
   * report-agent-session · agent list) — for code whose runner is synchronous (the TUI exit path).
   */
  runSync(argv: readonly string[]): FakeHerdrRunResult;
  /** Agents registered through `pane report-agent` and not released (what `agent list` shows). */
  reportedAgents(): FakeHerdrReportedAgent[];
}

export interface FakeHerdrReportedAgent {
  readonly paneId: string;
  readonly source: string;
  readonly agent: string;
  readonly state: string;
  readonly seq: number;
}

export interface FakeHerdrOpts {
  readonly panes: ReadonlyArray<{ paneId: string; agent: string; name?: string; status: FakeHerdrStatus }>;
  /** Called after a `pane run` is recorded — the test's TUI reacts here (e.g. working → idle). */
  readonly onRun?: (submission: FakeHerdrSubmission, herdr: FakeHerdr) => void;
  /**
   * Fault for the n-th `pane report-agent` call (0-based, counted across run/runSync) — undefined answers normally.
   * `applied-then-timeout` applies the report and then answers as a timeout; `timeout` answers without applying.
   */
  readonly reportFault?: (argv: readonly string[], index: number) => FakeHerdrReportFault | undefined;
}

const SETTLED: readonly FakeHerdrStatus[] = ['idle', 'done', 'blocked'];

function errorBody(id: string, code: string, message: string): FakeHerdrRunResult {
  return { code: 1, stdout: '', stderr: `${JSON.stringify({ error: { code, message }, id })}\n` };
}

function agentInfo(p: FakeHerdrPane): Record<string, unknown> {
  return {
    agent: p.agent,
    agent_status: p.status,
    pane_id: p.paneId,
    state_change_seq: p.stateChangeSeq,
    ...(p.name !== undefined ? { name: p.name } : {}),
  };
}

export function createFakeHerdr(opts: FakeHerdrOpts): FakeHerdr {
  const panes = new Map<string, FakeHerdrPane>();
  for (const p of opts.panes) panes.set(p.paneId, { ...p, stateChangeSeq: 1 });
  const subs: FakeHerdrSubmission[] = [];
  const argvLog: string[][] = [];
  const waiters = new Set<{ paneId: string; until: readonly FakeHerdrStatus[]; resolve: () => void }>();

  /** pane·source → registered agent · last applied seq (kept after release). */
  const reported = new Map<string, FakeHerdrReportedAgent>();
  const lastSeq = new Map<string, number>();
  const optsOf = (args: readonly string[]): { pane?: string; flags: Map<string, string> } => {
    const flags = new Map<string, string>();
    let pane: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a.startsWith('--')) flags.set(a.slice(2), args[++i] ?? '');
      else if (pane === undefined) pane = a;
    }
    return { pane, flags };
  };

  let reportIndex = 0;
  const TIMEOUT: FakeHerdrRunResult = { code: null, stdout: '', stderr: 'timeout', timedOut: true };
  /** `applyReport` with the scripted fault for `pane report-agent`. */
  const answerReport = (argv: readonly string[]): FakeHerdrRunResult | undefined => {
    if (argv[0] !== 'pane' || argv[1] !== 'report-agent') return applyReport(argv);
    const fault = opts.reportFault?.(argv, reportIndex++);
    if (fault === 'timeout') return TIMEOUT;
    const r = applyReport(argv);
    return fault === 'applied-then-timeout' ? TIMEOUT : r;
  };

  /** report-agent · release-agent · report-agent-session · agent list — answered at once (no waits). */
  const applyReport = (argv: readonly string[]): FakeHerdrRunResult | undefined => {
    const [group, cmd] = argv;
    if (group === 'pane' && cmd === 'report-agent-session') return { code: 0, stdout: '', stderr: '' };
    if (group === 'pane' && (cmd === 'report-agent' || cmd === 'release-agent')) {
      const { pane, flags } = optsOf(argv.slice(2));
      const source = flags.get('source') ?? '';
      const seq = Number(flags.get('seq'));
      if (pane === undefined || !source || !Number.isSafeInteger(seq)) {
        return { code: 2, stdout: '', stderr: `fake-herdr: ${cmd} needs <pane> --source --seq\n` };
      }
      const key = `${pane}\u0000${source}`;
      const prev = lastSeq.get(key);
      if (prev !== undefined && seq <= prev) return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'release-agent') {
        if (!reported.has(key)) return { code: 0, stdout: '', stderr: '' };
        reported.delete(key);
        lastSeq.set(key, seq);
        return { code: 0, stdout: '', stderr: '' };
      }
      reported.set(key, { paneId: pane, source, agent: flags.get('agent') ?? '', state: flags.get('state') ?? reported.get(key)?.state ?? 'unknown', seq });
      lastSeq.set(key, seq);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (group === 'agent' && cmd === 'list') {
      const agents = [...reported.values()].map((a) => ({ agent: a.agent, agent_status: a.state, pane_id: a.paneId }));
      return { code: 0, stdout: `${JSON.stringify({ id: 'cli:agent:list', result: { agents, type: 'agent_list' } })}\n`, stderr: '' };
    }
    return undefined;
  };

  const resolveTarget = (target: string): FakeHerdrPane | undefined =>
    panes.get(target) ?? [...panes.values()].find((p) => p.name === target);

  const herdr: FakeHerdr = {
    async run(argv, timeoutMs) {
      argvLog.push([...argv]);
      const [group, cmd, target, ...rest] = argv;
      if (group === 'agent' && cmd === 'get' && target !== undefined) {
        const p = resolveTarget(target);
        if (!p) return errorBody('cli:agent:get', 'agent_not_found', `agent target ${target} not found`);
        return { code: 0, stdout: `${JSON.stringify({ id: 'cli:agent:get', result: { agent: agentInfo(p), type: 'agent_info' } })}\n`, stderr: '' };
      }
      if (group === 'agent' && cmd === 'wait' && target !== undefined) {
        const p = resolveTarget(target);
        if (!p) return errorBody('cli:agent:wait', 'agent_not_found', `agent target ${target} not found`);
        const until: FakeHerdrStatus[] = [];
        let waitTimeout: number | undefined;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--until') until.push(rest[++i] as FakeHerdrStatus);
          else if (rest[i] === '--timeout') waitTimeout = Number(rest[++i]);
        }
        const want = until.length > 0 ? until : SETTLED;
        const ok = (): FakeHerdrRunResult => ({ code: 0, stdout: `${JSON.stringify({ id: 'cli:agent:wait', result: { agent: agentInfo(p), type: 'agent_info' } })}\n`, stderr: '' });
        if (want.includes(p.status)) return ok();
        const limit = Math.min(waitTimeout ?? Number.POSITIVE_INFINITY, timeoutMs);
        return new Promise<FakeHerdrRunResult>((resolve) => {
          const waiter = {
            paneId: p.paneId,
            until: want,
            resolve: () => { clearTimeout(timer); waiters.delete(waiter); resolve(ok()); },
          };
          const timer = Number.isFinite(limit)
            ? setTimeout(() => { waiters.delete(waiter); resolve(errorBody('cli:agent:wait', 'timeout', `timed out waiting for agent ${target}`)); }, limit)
            : undefined;
          waiters.add(waiter);
        });
      }
      if (group === 'pane' && cmd === 'run' && target !== undefined) {
        const p = panes.get(target);
        if (!p) return errorBody('cli:pane:run', 'pane_not_found', `pane ${target} not found`);
        const submission = { paneId: p.paneId, text: rest[0] ?? '' };
        subs.push(submission);
        opts.onRun?.(submission, herdr);
        return { code: 0, stdout: '', stderr: '' };
      }
      const reportedResult = answerReport(argv);
      if (reportedResult) return reportedResult;
      return { code: 2, stdout: '', stderr: `fake-herdr: unsupported argv ${argv.join(' ')}\n` };
    },
    setStatus(paneId, status) {
      const p = panes.get(paneId);
      if (!p) throw new Error(`fake-herdr: no pane ${paneId}`);
      p.status = status;
      p.stateChangeSeq += 1;
      for (const w of [...waiters]) if (w.paneId === paneId && w.until.includes(status)) w.resolve();
    },
    pane: (paneId) => panes.get(paneId),
    submissions: () => [...subs],
    runSync(argv) {
      argvLog.push([...argv]);
      return answerReport(argv) ?? { code: 2, stdout: '', stderr: `fake-herdr: runSync supports report/release/agent list only — ${argv.join(' ')}\n` };
    },
    calls: () => argvLog.map((a) => [...a]),
    reportedAgents: () => [...reported.values()],
  };
  return herdr;
}
