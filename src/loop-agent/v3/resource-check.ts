// CODE-BODY-TO-KIND — the shared sub kind `resource-check` (대표 11-28 17:3x «루프 에이전트 중에 코드로 된 것도 빠르게 플러그인화» ·
// LOOP-AGENTS-AS-PLUGINS · «모든 것 YAML 정의»).
//
// S: the guardian's seven subs were seven TS runners (src/guardian-agent/pulse.ts): each hand-wrote which rows it looks at,
//    what «normal» is, which normalize step it calls, which card it sends to whom with what text and how often, and how its
//    KPI line reads. Two of them (순찰대 · 우체국) were already one generic read (kit/kpi rollup); five were code.
// C: a threshold lived in agent.yaml, but the decision around it — «a supervisor bad or a beat dead gets a reattach card to its
//    owner once per reattach_every_h», «an exhausted account still routed is a miss» — was code: another agent could not reuse
//    it, and changing a card text or a target was a code change.
// Q: what is left of a resource sub once its flavour is parameters?
// A: one kind. A sub declares `kind: resource-check` and a `resource_check:` block — per detector: which rows (`rows:` kind ⊕
//    `where:`) · when a row is normal (`normal_if:`) · the why line (template) · the normalize step it calls through an
//    action port (`act:` · retry window) or records from the rows (`acted:`) · its cards (`cards:` — action id = the right ·
//    throttle mark ⊕ window from $policies · key · to · body templates, or a card port) — plus sub-level `run:` / `run_after:`
//    steps (an action port that returns facts) · `counts:` · and the KPI `line:` (value template ⊕ ok terms). The engine
//    below only walks that block; the effects (kill a PID · write a route · run a CLI refresh · raise a decision) stay the
//    host body's action ports, named by the same action ids the agent's `actions:` declare.
//
// 세 얼굴: 관측 = the rows the host body's sensors give (`rows(kind)` — the guardian's world aggregate) / 판단 근거 = the
//          `resource_check:` block (agent.yaml) — the only place a predicate, a window, a target or a text lives / 수복과
//          인계 = the action ports (normalize) ⊕ the cards ⊕ the detector ladder the host reconciles (kit/case-ledger) · a port
//          that is absent is «no port» (the step is skipped, never faked) · a run step that throws is one log line.

export interface Row { readonly kind: string; readonly id: string; readonly owner: string | null; readonly status: string; readonly lastSeen?: string | null; readonly facts: Readonly<Record<string, unknown>> }

/** A row predicate (all given keys must hold). `facts` / `facts_not` compare by value (a list = one of). */
export interface Pred {
  readonly status?: readonly string[]; readonly statusNot?: readonly string[];
  readonly facts?: Readonly<Record<string, unknown>>; readonly factsNot?: Readonly<Record<string, unknown>>;
  readonly any?: readonly Pred[]; readonly all?: readonly Pred[]; readonly not?: Pred | null;
}
export interface CardSpec {
  /** the right this card uses (one of the sub's actions) */
  readonly action: string;
  /** rows of another kind (default = the detector's rows) */
  readonly rows: string | null;
  readonly when: Pred | null;
  /** only after this detector's act ran on the row and did not normalize it */
  readonly afterFailedAct: boolean;
  /** throttle: one card per mark per window · null ⊕ once = once ever */
  readonly everyMin: number | null; readonly once: boolean;
  readonly mark: string;
  /** the mark is written when the card was considered (always) or only when it was written (sent) */
  readonly markOn: 'always' | 'sent';
  readonly key: string; readonly to: string; readonly body: string;
  /** the escalation ref the ladder records: msg:<id> · the key · msg:<id or key> · the card port's ref */
  readonly ref: 'msg' | 'key' | 'msg-or-key' | 'port';
  /** a card port (the host's) builds and sends it — key/to/body unused */
  readonly port: boolean;
  /** no card this spawn but the mark exists → ref «card <mark time>» */
  readonly citeLast: boolean;
  readonly log: string;
  readonly sort: 'id' | null;
}
/** `normalizes` = an ok result makes the row normal this spawn (a verified refresh) — else the row's own state decides. */
export interface ActSpec { readonly action: string; readonly when: Pred | null; readonly retryMin: number | null; readonly mark: string | null; readonly normalizes: boolean }
export interface ActedSpec { readonly action: string; readonly when: Pred | null; readonly okIf: Pred | null; readonly line: string }
export interface CheckSpec {
  readonly detector: string; readonly rows: string; readonly where: Pred | null; readonly normalIf: Pred;
  readonly why: { readonly normal: string; readonly abnormal: string };
  readonly owner: boolean; readonly complete: boolean;
  readonly act: ActSpec | null; readonly acted: ActedSpec | null; readonly cards: readonly CardSpec[];
}
export interface StepSpec { readonly action: string; readonly failLog: string }
export interface OkTerm { readonly zero?: readonly string[]; readonly falsy?: string; readonly value?: string; readonly atMost?: { readonly path: string; readonly max: number }; readonly whenNonzero?: readonly string[] }
export interface ResourceCheckSpec {
  readonly run: readonly StepSpec[]; readonly checks: readonly CheckSpec[]; readonly runAfter: readonly StepSpec[];
  readonly counts: Readonly<Record<string, { readonly rows: string; readonly where: Pred | null }>>;
  readonly line: { readonly value: string; readonly ok: readonly OkTerm[] };
}

export interface ActResult { readonly ok: boolean; readonly line: string; readonly log?: string }
export interface RunResult { readonly facts: Readonly<Record<string, unknown>>; readonly log?: readonly string[] }
export interface CheckObs { readonly subject: string; readonly normal: boolean; readonly why: string; readonly owner?: string | null; readonly acted?: { readonly action: string; readonly ok: boolean; readonly line: string } | null; readonly escalated?: string | null }
export interface ResourceCheckPorts {
  readonly at: string; readonly nowMs: number;
  readonly policies: Readonly<Record<string, number>>;
  /** current rows of a kind (re-read after every act — a port may replace them) · null = unknown here (no sensor this
   *  spawn): no card, no count, and the detector's ladder is not reconciled (unknown ≠ «none» — open cases stay) */
  rows(kind: string): readonly Row[] | null;
  /** throttle marks as of the spawn start · mark() records a new one (the host merges them at the end) */
  readonly sent: Readonly<Record<string, string>>;
  mark(key: string, at: string): void;
  post(key: string, to: string, body: string): number | null;
  /** normalize step on one row · undefined = this install has no port for the action */
  act(action: string, row: Row): ActResult | undefined;
  /** sub-level step · undefined / null = not run (no port · nothing to do) */
  run(action: string): RunResult | null | undefined;
  /** a card the host's port builds (decisions ledger …) · undefined = no port */
  card(action: string, row: Row, act: ActResult | null): { ref: string | null; log?: string } | undefined;
  ladder(detector: string, obs: readonly CheckObs[], o: { complete: boolean; ownCard: boolean }): void;
}

// ── template · predicate (pure) ──────────────────────────────────────────────────────────────────────────────────────

const get = (ctx: unknown, path: string): unknown => {
  let v: unknown = ctx;
  for (const k of path.split('.')) { if (v === null || v === undefined || typeof v !== 'object') return undefined; v = (v as Record<string, unknown>)[k]; }
  return v;
};
const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : !!v);
const show = (v: unknown): string => (v === null || v === undefined ? '' : Array.isArray(v) ? v.map(show).join(',') : String(v));

function filter(v: unknown, f: string): unknown {
  const i = f.indexOf(':'); const name = i < 0 ? f : f.slice(0, i); const arg = i < 0 ? '' : f.slice(i + 1);
  if (name === 'pct') return typeof v === 'number' ? `${Math.round(v * 100)}%` : '?';
  if (name === 'fixed2') return typeof v === 'number' ? v.toFixed(2) : null;
  if (name === 'or') return v === null || v === undefined ? arg : v;
  if (name === 'slice') return show(v).slice(0, Number(arg));
  if (name === 'join') return Array.isArray(v) ? v.map(show).join(arg) : v;
  if (name === 'len') return Array.isArray(v) ? v.length : 0;
  throw new Error(`unknown template filter ${name}`);
}
const FILTERS = new Set(['pct', 'fixed2', 'or', 'slice', 'join', 'len']);

/** Split `{…}` blocks (nested) — returns null when the braces do not balance. */
function blocks(t: string): Array<{ lit: string } | { expr: string }> | null {
  const out: Array<{ lit: string } | { expr: string }> = []; let i = 0; let lit = '';
  while (i < t.length) {
    if (t[i] === '}') return null;
    if (t[i] !== '{') { lit += t[i++]; continue; }
    let depth = 0; let j = i;
    for (; j < t.length; j++) { if (t[j] === '{') depth++; else if (t[j] === '}' && --depth === 0) break; }
    if (j >= t.length) return null;
    if (lit) { out.push({ lit }); lit = ''; }
    out.push({ expr: t.slice(i + 1, j) }); i = j + 1;
  }
  if (lit) out.push({ lit });
  return out;
}
const cond = (c: string, ctx: unknown): boolean => {
  const ne = c.indexOf('!='); if (ne > 0) return show(get(ctx, c.slice(0, ne))) !== c.slice(ne + 2);
  const eq = c.indexOf('='); if (eq > 0) return show(get(ctx, c.slice(0, eq))) === c.slice(eq + 1);
  return truthy(get(ctx, c));
};

/** `{path|filter|…}` · `{?cond:text}` · `{!cond:text}` (cond = path · path=value · path!=value) — text may nest blocks. */
export function fill(t: string, ctx: unknown): string {
  const bs = blocks(t);
  if (!bs) throw new Error(`unbalanced template «${t.slice(0, 60)}»`);
  return bs.map(b => {
    if ('lit' in b) return b.lit;
    const e = b.expr;
    if (e[0] === '?' || e[0] === '!') {
      const k = e.indexOf(':'); const hit = cond(e.slice(1, k < 0 ? e.length : k), ctx);
      return (e[0] === '?' ? hit : !hit) && k >= 0 ? fill(e.slice(k + 1), ctx) : '';
    }
    const [path, ...fs] = e.split('|');
    return show(fs.reduce((v, f) => filter(v, f), get(ctx, path!)));
  }).join('');
}

/** Template lint: balanced braces · known filters · a non-empty path. Returns the first problem or null. */
export function templateProblem(t: string): string | null {
  const bs = blocks(t);
  if (!bs) return 'unbalanced braces';
  for (const b of bs) {
    if ('lit' in b) continue;
    const e = b.expr;
    if (e[0] === '?' || e[0] === '!') { const k = e.indexOf(':'); if (k < 2) return `conditional «${e.slice(0, 30)}» needs ?cond:text`; const p = templateProblem(e.slice(k + 1)); if (p) return p; continue; }
    const [path, ...fs] = e.split('|');
    if (!path) return `empty path in «{${e}}»`;
    for (const f of fs) if (!FILTERS.has(f.split(':')[0]!)) return `unknown filter ${f}`;
  }
  return null;
}

const oneOf = (v: unknown, want: unknown): boolean => (Array.isArray(want) ? want.some(w => w === v) : v === want);
export function matches(r: Row, p: Pred | null | undefined): boolean {
  if (!p) return true;
  if (p.status && !p.status.includes(r.status)) return false;
  if (p.statusNot && p.statusNot.includes(r.status)) return false;
  if (p.facts) for (const [k, w] of Object.entries(p.facts)) if (!oneOf(r.facts[k], w)) return false;
  if (p.factsNot) for (const [k, w] of Object.entries(p.factsNot)) if (oneOf(r.facts[k], w)) return false;
  if (p.any && !p.any.some(x => matches(r, x))) return false;
  if (p.all && !p.all.every(x => matches(r, x))) return false;
  if (p.not && matches(r, p.not)) return false;
  return true;
}

/** ok terms → true | false | null: any false → false · else any true → true · else null (unknown). */
export function okOf(terms: readonly OkTerm[], ctx: unknown): boolean | null {
  const n = (p: string) => { const v = get(ctx, p); return typeof v === 'number' ? v : Array.isArray(v) ? v.length : v ? 1 : 0; };
  const vals = terms.map((t): boolean | null => {
    if (t.whenNonzero && !t.whenNonzero.some(p => n(p) !== 0)) return null;
    if (t.zero) return t.zero.every(p => n(p) === 0);
    if (t.falsy !== undefined) return !truthy(get(ctx, t.falsy));
    if (t.atMost) return n(t.atMost.path) > t.atMost.max ? false : null;
    if (t.value !== undefined) { const v = get(ctx, t.value); return v === true || v === false ? v : null; }
    return null;
  });
  return vals.includes(false) ? false : vals.includes(true) ? true : null;
}

// ── the engine ───────────────────────────────────────────────────────────────────────────────────────────────────────

const rowCtx = (r: Row, base: Record<string, unknown>, act: Record<string, unknown> | null = null) =>
  ({ ...base, id: r.id, kind: r.kind, owner: r.owner, status: r.status, lastSeen: r.lastSeen ?? null, facts: r.facts, act: act ?? { ran: false, tried: false, ok: false, line: '' } });
const due = (sent: Readonly<Record<string, string>>, mark: string, nowMs: number, everyMin: number | null, once: boolean): boolean => {
  const at = sent[mark];
  if (!at) return true;
  if (once || everyMin === null) return false;
  return nowMs - Date.parse(at) >= everyMin * 60_000;
};

/** One spawn of a `resource-check` sub → its KPI and the action lines (the spawn line's outcome). */
export function runResourceCheck(spec: ResourceCheckSpec, ports: ResourceCheckPorts): { kpi: { value: string; ok: boolean | null }; actions: string[] } {
  const actions: string[] = [];
  const run: Record<string, unknown> = {};
  const base: Record<string, unknown> = { at: ports.at, day: ports.at.slice(0, 10), hour: ports.at.slice(0, 13), policies: ports.policies, run };
  const step = (s: StepSpec) => {
    try { const r = ports.run(s.action); run[s.action] = r ? r.facts : null; if (r?.log) actions.push(...r.log); }
    catch (e) { run[s.action] = null; actions.push(`${s.failLog} ${String(e).slice(0, 80)}`); }
  };
  for (const s of spec.run) step(s);
  for (const c of spec.checks) {
    const pick = (kind: string, where: Pred | null) => (ports.rows(kind) ?? []).filter(r => matches(r, where));
    // ① normalize step (an action port) on the rows it applies to · retry window per mark
    const acts = new Map<string, Record<string, unknown>>();
    if (c.act) for (const r of pick(c.rows, c.where)) {
      if (!matches(r, c.act.when)) continue;
      const mark = c.act.mark ? fill(c.act.mark, rowCtx(r, base)) : null;
      const tried = !!mark && !due(ports.sent, mark, ports.nowMs, c.act.retryMin, false);
      let res: ActResult | undefined;
      if (!tried) { res = ports.act(c.act.action, r); if (res && mark) ports.mark(mark, ports.at); }
      if (res?.log) actions.push(res.log);
      acts.set(r.id, res ? { ran: true, tried, ok: res.ok, line: res.line, before: r.facts } : { ran: false, tried, ok: false, line: '', before: r.facts });
    }
    // ② cards (card-major, each over its rows) — the ref the ladder records for the detector's own rows
    const refs = new Map<string, string>();
    for (const card of c.cards) {
      let rows = pick(card.rows ?? c.rows, card.rows ? null : c.where).filter(r => matches(r, card.when));
      if (card.sort === 'id') rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const r of rows) {
        const act = acts.get(r.id) ?? null;
        const ctx = rowCtx(r, base, act);
        const mark = fill(card.mark, ctx);
        const refKey = `${r.kind}:${r.id}`;
        if (card.afterFailedAct && !(act?.ran && !act.ok)) { if (card.citeLast && ports.sent[mark]) refs.set(refKey, `card ${ports.sent[mark]}`); continue; }
        if (!due(ports.sent, mark, ports.nowMs, card.everyMin, card.once)) { if (card.citeLast) refs.set(refKey, `card ${ports.sent[mark]}`); continue; }
        if (card.port) {
          const got = ports.card(card.action, r, act ? { ok: act.ok as boolean, line: String(act.line) } : null);
          if (got?.ref) { ports.mark(mark, ports.at); refs.set(refKey, got.ref); if (got.log) actions.push(got.log); }
          else if (card.citeLast && ports.sent[mark]) refs.set(refKey, `card ${ports.sent[mark]}`);
          continue;
        }
        const key = fill(card.key, ctx);
        const id = ports.post(key, fill(card.to, ctx), fill(card.body, ctx));
        if (card.markOn === 'always' || id !== null) ports.mark(mark, ports.at);
        if (card.markOn === 'sent' && id === null) continue;
        const ref = card.ref === 'key' ? key : id === null ? null : card.ref === 'msg-or-key' ? `msg:${id || key}` : `msg:${id}`;
        if (ref) refs.set(refKey, ref);
        if (card.log) actions.push(fill(card.log, ctx));
      }
    }
    // ③ what the detector saw → the host's ladder (kit/case-ledger)
    const obs: CheckObs[] = pick(c.rows, c.where).map(r => {
      const act = acts.get(r.id) ?? null; const ctx = rowCtx(r, base, act);
      const normal = (!!c.act?.normalizes && act?.ran === true && act.ok === true) || matches(r, c.normalIf);
      const acted = act?.ran ? { action: c.act!.action, ok: act.ok as boolean, line: String(act.line).slice(0, 200) }
        : c.acted && matches(r, c.acted.when) ? { action: c.acted.action, ok: matches(r, c.acted.okIf), line: fill(c.acted.line, ctx) } : null;
      return { subject: r.id, normal, why: fill(normal ? c.why.normal : c.why.abnormal, ctx), ...(c.owner ? { owner: r.owner } : {}),
        ...(acted ? { acted } : {}), escalated: refs.get(`${r.kind}:${r.id}`) ?? null };
    });
    if (ports.rows(c.rows) !== null) ports.ladder(c.detector, obs, { complete: c.complete, ownCard: c.cards.some(x => !x.rows || x.rows === c.rows) });
  }
  for (const s of spec.runAfter) step(s);
  // ④ the KPI line — counts · the first row of each kind · the run facts · policies
  const count: Record<string, number> = {};
  for (const [name, q] of Object.entries(spec.counts)) count[name] = (ports.rows(q.rows) ?? []).filter(r => matches(r, q.where)).length;
  const rows = new Proxy({} as Record<string, unknown>, { get: (_t, k) => (typeof k === 'string' ? ports.rows(k)?.[0] ?? null : undefined) });
  const ctx = { ...base, count, rows };
  return { kpi: { value: fill(spec.line.value, ctx), ok: okOf(spec.line.ok, ctx) }, actions };
}

// ── lint / compile (agent-yaml.ts calls this for a sub with `kind: resource-check`) ────────────────────────────────────

type Num = (v: unknown, at: string) => number | null;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const ss = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function parsePred(raw: unknown, at: string, errors: string[]): Pred | null {
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw)) { errors.push(`${at} must be a mapping`); return null; }
  const known = ['status', 'status_not', 'facts', 'facts_not', 'any', 'all', 'not'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) errors.push(`${at}.${k} is not a predicate key (${known.join(' · ')})`);
  const list = (k: string) => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).map((x, i) => parsePred(x, `${at}.${k}[${i}]`, errors)).filter((x): x is Pred => !!x) : undefined);
  const facts = (k: string) => { if (raw[k] === undefined) return undefined; if (!isObj(raw[k])) { errors.push(`${at}.${k} must be a mapping`); return undefined; } return raw[k] as Record<string, unknown>; };
  return {
    ...(raw.status !== undefined ? { status: ss(raw.status) } : {}), ...(raw.status_not !== undefined ? { statusNot: ss(raw.status_not) } : {}),
    ...(facts('facts') ? { facts: facts('facts')! } : {}), ...(facts('facts_not') ? { factsNot: facts('facts_not')! } : {}),
    ...(list('any') ? { any: list('any')! } : {}), ...(list('all') ? { all: list('all')! } : {}),
    ...(raw.not !== undefined ? { not: parsePred(raw.not, `${at}.not`, errors) } : {}),
  };
}
const tpl = (v: unknown, at: string, errors: string[], required = true): string => {
  const t = s(v);
  if (!t) { if (required) errors.push(`${at} is required (a template)`); return ''; }
  const p = templateProblem(t); if (p) errors.push(`${at}: ${p}`);
  return t;
};

/** Parse one `resource_check:` block. `actions` = the sub's rights · `detectors` = its detector ids. Errors returned, never thrown. */
export function parseResourceCheck(raw: unknown, num: Num, own: { actions: readonly string[]; detectors: readonly string[] }, at: string): { spec: ResourceCheckSpec | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { spec: null, errors: [`${at} must be a mapping`] };
  const right = (a: string, where: string) => { if (!own.actions.includes(a)) errors.push(`${where}: action ${a || '—'} is not one of this sub's actions (${own.actions.join(', ') || '—'})`); return a; };
  const steps = (k: string): StepSpec[] => (Array.isArray(raw[k]) ? raw[k] as unknown[] : []).map((x, i) => {
    const o = isObj(x) ? x : { action: x };
    const a = right(s(o.action), `${at}.${k}[${i}]`);
    return { action: a, failLog: s(o.fail_log) || `${a}-failed` };
  });
  const checks: CheckSpec[] = [];
  const rawChecks = isObj(raw.checks) ? raw.checks : {};
  for (const [det, rc] of Object.entries(rawChecks)) {
    const cat = `${at}.checks.${det}`;
    if (!own.detectors.includes(det)) errors.push(`${cat}: ${det} is not one of this sub's detectors`);
    if (!isObj(rc)) { errors.push(`${cat} must be a mapping`); continue; }
    const rows = s(rc.rows); if (!rows) errors.push(`${cat}.rows (a row kind) is required`);
    const normalIf = parsePred(rc.normal_if, `${cat}.normal_if`, errors);
    if (!normalIf) errors.push(`${cat}.normal_if (when a row is normal) is required`);
    const why = isObj(rc.why) ? { normal: tpl(rc.why.normal, `${cat}.why.normal`, errors), abnormal: tpl(rc.why.abnormal, `${cat}.why.abnormal`, errors) }
      : (() => { const t = tpl(rc.why, `${cat}.why`, errors); return { normal: t, abnormal: t }; })();
    let act: ActSpec | null = null;
    if (isObj(rc.act)) {
      const r = rc.act; const retry = r.retry_min === undefined ? null : num(r.retry_min, `${cat}.act.retry_min`);
      act = { action: right(s(r.action), `${cat}.act`), when: parsePred(r.when, `${cat}.act.when`, errors), retryMin: retry, mark: r.mark === undefined ? null : tpl(r.mark, `${cat}.act.mark`, errors), normalizes: r.normalizes === true };
      if (retry !== null && !act.mark) errors.push(`${cat}.act.retry_min needs a mark`);
    }
    let acted: ActedSpec | null = null;
    if (isObj(rc.acted)) { const r = rc.acted; acted = { action: right(s(r.action), `${cat}.acted`), when: parsePred(r.when, `${cat}.acted.when`, errors), okIf: parsePred(r.ok_if, `${cat}.acted.ok_if`, errors), line: tpl(r.line, `${cat}.acted.line`, errors) }; }
    if (act && acted) errors.push(`${cat}: act (call a port) and acted (record from the rows) are exclusive`);
    const cards: CardSpec[] = (Array.isArray(rc.cards) ? rc.cards : []).flatMap((x, i): CardSpec[] => {
      const k = `${cat}.cards[${i}]`;
      if (!isObj(x)) { errors.push(`${k} must be a mapping`); return []; }
      const port = x.port === true;
      const everyMin = x.every_min !== undefined ? num(x.every_min, `${k}.every_min`) : x.every_h !== undefined ? (() => { const h = num(x.every_h, `${k}.every_h`); return h === null ? null : h * 60; })() : null;
      const once = x.once === true;
      if (everyMin === null && !once) errors.push(`${k}: every_min | every_h ($policies) or once: true is required — an unthrottled card is a storm`);
      const ref = s(x.ref) || (port ? 'port' : 'msg');
      if (!['msg', 'key', 'msg-or-key', 'port'].includes(ref)) errors.push(`${k}.ref must be msg | key | msg-or-key | port`);
      const markOn = s(x.mark_on) || 'always';
      if (markOn !== 'always' && markOn !== 'sent') errors.push(`${k}.mark_on must be always | sent`);
      return [{
        action: right(s(x.action), k), rows: s(x.rows) || null, when: parsePred(x.when, `${k}.when`, errors), afterFailedAct: x.after_failed_act === true,
        everyMin, once, mark: tpl(x.mark, `${k}.mark`, errors), markOn: markOn as CardSpec['markOn'],
        key: port ? '' : tpl(x.key, `${k}.key`, errors), to: port ? '' : tpl(x.to, `${k}.to`, errors), body: port ? '' : tpl(x.body, `${k}.body`, errors),
        ref: ref as CardSpec['ref'], port, citeLast: x.cite_last === true, log: tpl(x.log, `${k}.log`, errors, false), sort: x.sort === 'id' ? 'id' : null,
      }];
    });
    checks.push({ detector: det, rows, where: parsePred(rc.where, `${cat}.where`, errors), normalIf: normalIf ?? {}, why, owner: rc.owner === true, complete: rc.complete !== false, act, acted, cards });
  }
  const counts: Record<string, { rows: string; where: Pred | null }> = {};
  if (isObj(raw.counts)) for (const [n, q] of Object.entries(raw.counts)) {
    if (!isObj(q) || !s(q.rows)) { errors.push(`${at}.counts.${n} needs rows`); continue; }
    counts[n] = { rows: s(q.rows), where: parsePred(q.where, `${at}.counts.${n}.where`, errors) };
  }
  const line = isObj(raw.line) ? raw.line : {};
  const ok: OkTerm[] = (Array.isArray(line.ok) ? line.ok : []).flatMap((t, i): OkTerm[] => {
    if (!isObj(t)) { errors.push(`${at}.line.ok[${i}] must be a mapping`); return []; }
    const nz = t.when_nonzero === undefined ? {} : { whenNonzero: ss(t.when_nonzero) };
    if (t.zero !== undefined) return [{ zero: ss(t.zero), ...nz }];
    if (t.falsy !== undefined) return [{ falsy: s(t.falsy), ...nz }];
    if (t.value !== undefined) return [{ value: s(t.value), ...nz }];
    if (isObj(t.at_most)) { const m = num(t.at_most.max, `${at}.line.ok[${i}].at_most.max`); return m === null ? [] : [{ atMost: { path: s(t.at_most.path), max: m }, ...nz }]; }
    errors.push(`${at}.line.ok[${i}] must be zero | falsy | value | at_most`); return [];
  });
  if (!ok.length) errors.push(`${at}.line.ok needs at least one term (when is the KPI met)`);
  const spec: ResourceCheckSpec = { run: steps('run'), checks, runAfter: steps('run_after'), counts, line: { value: tpl(line.value, `${at}.line.value`, errors), ok } };
  return { spec: errors.length ? null : spec, errors };
}
