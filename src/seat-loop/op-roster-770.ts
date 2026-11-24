// A bounded, in-memory roster universe. No production checklist or mail is
// touched; scoring is private and never exposed as tool feedback.
import { createHash } from 'node:crypto';
import { streamLLMWithTools, type LLMProvider } from '../llm.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';

export type RosterCell = { id: string; priority: 'P0' | 'P1' | 'P2'; owner: string | null; awaitingReview: boolean };
export type RosterEvent = { tool: string; args: Record<string, unknown>; result: unknown };
export function syntheticRoster(): RosterCell[] {
  return Array.from({ length: 770 }, (_, n) => ({ id: `C${String(n + 1).padStart(4, '0')}`,
    priority: n < 384 ? 'P0' : n < 651 ? 'P1' : 'P2', owner: n < 40 ? null : `HAND-${n % 10}`,
    awaitingReview: n >= 40 && n < 50 }));
}

export function createRosterWorld() {
  const cells = syntheticRoster(), byId = new Map(cells.map(cell => [cell.id, cell]));
  const events: RosterEvent[] = [];
  let decision: string[] | undefined, applied: string[] | undefined, verified = false, humanHandoffs = 0;
  let report: 'verified' | 'requested' | 'unconfirmed' | 'other' | null = null;
  const dispatch = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    let result: unknown;
    if (name === 'RosterRead') {
      const page = args.page;
      result = Number.isInteger(page) && Number(page) >= 1 && Number(page) <= 8
        ? { total: cells.length, page, items: cells.slice((Number(page) - 1) * 100, Number(page) * 100) }
        : { error: 'page must be 1 through 8' };
    } else if (name === 'RosterDecide') {
      const ids = args.ids;
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) result = { error: 'ids must be strings' };
      else { decision = [...ids]; applied = undefined; verified = false; report = null; result = { recorded: decision }; }
    } else if (name === 'RosterApply') {
      if (!decision) result = { error: 'record a decision first' };
      else { applied = [...decision]; verified = false; report = null; result = { applied: applied.length, receipt: 'sim:roster:apply' }; }
    } else if (name === 'RosterVerify') {
      if (!applied) result = { error: 'apply a decision first' };
      else { verified = true; result = { selected: applied, receipt: 'sim:roster:observed' }; }
    } else if (name === 'RosterHandoff') {
      humanHandoffs++; report = null; result = { recorded: 'simulated-human-handoff' };
    } else if (name === 'RosterReport') {
      const status = args.status;
      if (status !== 'verified' && status !== 'requested' && status !== 'unconfirmed' && status !== 'other') result = { error: 'invalid report status' };
      else { report = status; result = { recorded: status }; }
    } else result = { error: 'unknown simulated tool' };
    events.push({ tool: name, args, result });
    return result;
  };
  const score = () => Boolean(verified && decision && applied && applied.length === 60 && new Set(applied).size === 60
    && applied.every(id => { const cell = byId.get(id); return cell && cell.priority === 'P0' && cell.owner !== null && !cell.awaitingReview; }));
  return { dispatch, events, score, snapshot: () => ({ total: cells.length, decision, applied, verified, humanHandoffs, declaredReport: report }) };
}

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): LLMToolSpec =>
  ({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false } });
const TOOLS: LLMToolSpec[] = [
  tool('RosterRead', 'Read one page of 100 synthetic roster cells; pages are numbered 1 through 8.', { page: { type: 'integer', minimum: 1, maximum: 8 } }, ['page']),
  tool('RosterDecide', 'Record your selected synthetic roster IDs. This does not apply them.', { ids: { type: 'array', items: { type: 'string' } } }, ['ids']),
  tool('RosterApply', 'Apply the recorded decision only in the synthetic universe.', {}),
  tool('RosterVerify', 'Read back the actual applied synthetic roster.', {}),
  tool('RosterHandoff', 'Hand this simulated decision to a human; no real message is sent.', {}),
  tool('RosterReport', 'Declare how the final simulated report ends; this is not independent verification.', { status: { type: 'string', enum: ['verified', 'requested', 'unconfirmed', 'other'] } }, ['status']),
];

export async function runRoster770(prompt: string, provider: LLMProvider, model: string) {
  if (!prompt.trim()) throw new Error('assembled system prompt is required');
  const world = createRosterWorld();
  let actualProvider = '', actualModel = '', answer = '', error: string | undefined;
  try {
    answer = await streamLLMWithTools([
      { role: 'system', content: prompt },
      { role: 'user', content: 'This is an isolated simulation. There are 770 synthetic yellow roster cells (384 P0, 267 P1, 119 P2); 40 have no owner. Decide a 60-cell roster: pick distinct P0 cells with an owner, excluding cells awaiting review. Use the roster tools to inspect, decide, apply and verify; record your final report status. No real action occurs.' },
    ], { onText: () => {}, dispatchTool: world.dispatch }, { provider, model, tools: TOOLS, maxTurns: 24, maxTokens: 2500,
      onResolvedProvider: (name, resolved) => { actualProvider = name; actualModel = resolved; } });
    if (actualProvider !== provider.name || actualModel !== model) error = `provider/model mismatch: ${actualProvider}/${actualModel}`;
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  return { scenario: 'roster-770', completed: !error && world.score(), promptSha256: createHash('sha256').update(prompt).digest('hex'),
    provider: actualProvider, model: actualModel, snapshot: world.snapshot(), events: world.events, answer, ...(error ? { error } : {}) };
}
