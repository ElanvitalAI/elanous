// LLM-ACCOUNT-POLICY overrides — interventions as ledger facts, never YAML edits (CEO 11-27 16:3x).
// `llm-override {scope · action · by · why · until · untilEvent}` in the lease ledger; ranked CEO > safety > OP=RES >
// GUARDIAN auto (llm-decide.ts LAYER_RANK). Every override expires: `until` (default pack overrides.default_hours) and
// optionally earlier at `until_event` (reset:<resources> = all back at L0 after the override was set).
// A CEO override carries its crown evidence (`ref` = bus / decision id); the guardian clears only its own overrides.
import { randomBytes } from 'node:crypto';
import { isLevelAction, loadLlmAccountPack, type LevelAction } from './llm-accounts.js';
import { resetLlmDecisionCache } from './llm-decide.js';
import { isOverrideActor, isOverrideScope, isUntilEvent, OVERRIDE_ACTORS, type LlmOverrideClear, type LlmOverrideSet, type OverrideActor } from '../../resource-ledger/llm-policy-events.js';

export interface SetOverrideInput {
  readonly by: string;
  readonly scope: string;
  readonly action: string;
  readonly why: string;
  /** ISO time, or a duration like `6h` / `90m` / `2d`. Absent = pack overrides.default_hours. */
  readonly until?: string;
  readonly untilEvent?: string;
  readonly ref?: string;
  readonly now?: Date;
  /** Did the CEO decision `ref` approve `action`? Default = the live decisions ledger (tests/sims inject). */
  readonly crownApproves?: (ref: string, action: string, scope: string) => boolean;
}

/** Pure: does an option's text carry out exactly this action on exactly this scope? A global action (`mode:` ·
 *  `fallback:`) and a clear (`clear:<id>`) are named alone; any other action is named WITH its scope as `<action> <scope>`
 *  (e.g. `credits_allow openai-codex:default:credits`, `credits_deny *`) — an approval for one account never covers `*`. */
export function optionApproves(text: string, action: string, scope: string): boolean {
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // Whole tokens only: `fallback:10` never approves `fallback:1`, `mode:credits` never approves `mode:credits-default`.
  const needle = /^(?:mode|fallback|clear):/u.test(action) ? esc(action) : `${esc(action)} ${esc(scope)}`;
  return new RegExp(`(?:^|\\s)${needle}(?=$|[\\s,.;)·])`, 'u').test(text);
}

/** A CEO-rank intervention exists only as a decision the CEO ANSWERED with the option that carries it out: decided by a
 *  human, and the chosen option's label/consequence names the action (and its scope — `optionApproves`).
 *  Unanswered · refused · withdrawn · unrelated decisions never rank CEO. No new approval step: this only makes «by CEO»
 *  mean what it says. */
export function decisionApproves(ref: string, action: string, scope: string): boolean {
  try {
    const m = require('../../decisions/decision-ledger.js') as typeof import('../../decisions/decision-ledger.js');
    const e = new m.DecisionLedger().list({ status: 'all' }).find(x => x.id === ref);
    if (!e || e.status !== 'decided' || e.decidedBy?.kind !== 'human' || !e.choice) return false;
    const opt = e.options.find(o => o.key === e.choice);
    return !!opt && optionApproves(`${opt.label} ${opt.consequence}`, action, scope);
  } catch { return false; }
}
/** Global actions (the phase, the fallback start) have no account to aim at — they take scope `*` only. */
const GLOBAL_ACTION = /^(?:mode|fallback):/u;

const DUR = /^(\d+(?:\.\d+)?)(m|h|d)$/u;
/** Pure: until (ISO or duration) → ISO, or an error. */
export function resolveUntil(until: string | undefined, now: Date, defaultHours: number): { until: string } | { error: string } {
  if (!until) return { until: new Date(now.getTime() + defaultHours * 3_600_000).toISOString() };
  const m = DUR.exec(until.trim());
  if (m) return { until: new Date(now.getTime() + Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'])).toISOString() };
  const t = Date.parse(until);
  if (!Number.isFinite(t)) return { error: `until ${JSON.stringify(until)} is neither an ISO time nor <n>m|h|d` };
  if (t <= now.getTime()) return { error: `until ${until} is already past` };
  return { until: new Date(t).toISOString() };
}

/** Pure: validate and build the ledger event (no IO). */
export function buildOverrideSet(input: SetOverrideInput, defaultHours: number, phases: readonly string[]): { event: LlmOverrideSet } | { error: string } {
  const now = input.now ?? new Date();
  const by = input.by.trim().toUpperCase();
  if (!isOverrideActor(by)) return { error: `by ${by || '(none)'} cannot set an override (${OVERRIDE_ACTORS.join('|')}) — other seats ask OP` };
  if (by === 'CEO') {
    const ref = input.ref?.trim() ?? '';
    if (!ref) return { error: 'a CEO override needs --crown <decision id> (the CEO decision it carries out)' };
    if (!(input.crownApproves ?? decisionApproves)(ref, input.action, input.scope)) return { error: `crown ${ref} is not a CEO decision answered with an option that carries out ${input.action}${GLOBAL_ACTION.test(input.action) ? '' : ` ${input.scope}`}` };
  }
  if (!isOverrideScope(input.scope)) return { error: `scope ${input.scope} must be <provider>:<account>[:credits] · <provider> · *` };
  if (!isLevelAction(input.action, phases)) return { error: `action ${input.action} must be demote|skip|tier_down|credits_deny|credits_allow|fallback:<n>|mode:<${['normal', ...phases].join('|')}>` };
  if (GLOBAL_ACTION.test(input.action) && input.scope !== '*') return { error: `${input.action} is global — use --scope '*'` };
  if (!input.why.trim()) return { error: 'why is required' };
  if (input.untilEvent !== undefined && !isUntilEvent(input.untilEvent)) return { error: `until-event ${input.untilEvent} must be reset:<provider>:<account>[,…]` };
  const u = resolveUntil(input.until, now, defaultHours);
  if ('error' in u) return u;
  return { event: {
    event: 'llm-override', at: now.toISOString(), by: by as OverrideActor, op: 'set',
    id: `ovr-${now.toISOString().slice(0, 10).replace(/-/gu, '')}-${randomBytes(3).toString('hex')}`,
    scope: input.scope, action: input.action as LevelAction, why: input.why.trim().slice(0, 500), until: u.until,
    ...(input.untilEvent ? { untilEvent: input.untilEvent } : {}), ...(input.ref?.trim() ? { ref: input.ref.trim().slice(0, 200) } : {}),
  } };
}

export function setOverride(input: SetOverrideInput, ledgerPath?: string): { event: LlmOverrideSet } | { error: string } {
  const loaded = loadLlmAccountPack();
  const built = buildOverrideSet(input, loaded.pack?.overrides.defaultHours ?? 24, loaded.pack?.phases.map(p => p.name) ?? []);
  if ('error' in built) return built;
  const r = require('../../resource-ledger/resource-ledger.js') as typeof import('../../resource-ledger/resource-ledger.js');
  r.recordLlmPolicyEvent(built.event, ledgerPath ?? (process.env.RESOURCE_FACTS_LEDGER?.trim() || r.resourceLedgerPath()));
  resetLlmDecisionCache();
  return built;
}

/** Clear one override. The guardian may clear only its own; people clear any at or below their rank. The target is read
 *  from the SAME ledger the clear is written to. */
export function clearOverride(input: { by: string; id: string; why: string; now?: Date; ref?: string; crownApproves?: (ref: string, action: string, scope: string) => boolean }, ledgerPath?: string): { event: LlmOverrideClear } | { error: string } {
  const by = input.by.trim().toUpperCase();
  if (!isOverrideActor(by)) return { error: `by ${by || '(none)'} cannot clear an override (${OVERRIDE_ACTORS.join('|')})` };
  if (by === 'CEO' && !(input.ref?.trim() && (input.crownApproves ?? decisionApproves)(input.ref.trim(), `clear:${input.id}`, '*'))) return { error: `a CEO clear needs --crown <decision id> answered with an option that carries out clear:${input.id}` };
  if (!input.why.trim()) return { error: 'why is required' };
  const r = require('../../resource-ledger/resource-ledger.js') as typeof import('../../resource-ledger/resource-ledger.js');
  const path = ledgerPath ?? (process.env.RESOURCE_FACTS_LEDGER?.trim() || r.resourceLedgerPath());
  const d = require('./llm-decide.js') as typeof import('./llm-decide.js');
  const target = r.readResourceLedger(path).reverse().find((e): e is LlmOverrideSet => e.event === 'llm-override' && e.op === 'set' && e.id === input.id);
  if (!target) return { error: `no override ${input.id}` };
  if (d.LAYER_RANK[by as OverrideActor] < d.LAYER_RANK[target.by]) return { error: `${by} cannot clear a ${target.by} override (${input.id}) — rank CEO > OP=RES > GUARDIAN` };
  const event: LlmOverrideClear = { event: 'llm-override', at: (input.now ?? new Date()).toISOString(), by: by as OverrideActor, op: 'clear', id: input.id, why: input.why.trim().slice(0, 500),
    ...(input.ref?.trim() ? { ref: input.ref.trim().slice(0, 200) } : {}) };
  r.recordLlmPolicyEvent(event, path);
  resetLlmDecisionCache();
  return { event };
}
