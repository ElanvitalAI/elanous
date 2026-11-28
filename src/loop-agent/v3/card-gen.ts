// YAML-SUPERVISORS-RUNTIME — goal.yaml (the v2 card) is GENERATED from agent.yaml: no second definition. The v2 card stays
// on disk only as the fallback a refused agent.yaml runs with (the last clean generation, committed), and lint refuses any
// goal.yaml that is not what agent.yaml generates (`eln loop agent gen <id>` rewrites it).
//
// 세 얼굴: 관측 = `eln loop agent lint` («goal.yaml drift») / 판단 근거 = parseCard(generated) ≡ parseCard(on disk) (the card
// the runtime reads — comments and key order do not matter) / 수복과 인계 = `eln loop agent gen` rewrites the file; until then
// the runtime keeps the committed card (never a half-written one).
import { stringify } from 'yaml';
import { parseCard, type AgentCard } from '../card.js';
import type { CompiledAgent } from './agent-yaml.js';

export const GOAL_YAML_HEADER = (id: string): string =>
  `# GENERATED from graphs/loop-agents/${id}/agent.yaml by \`eln loop agent gen ${id}\` — do not edit (YAML-SUPERVISORS-RUNTIME).\n`
  + '# This v2 card is only the fallback a refused agent.yaml runs with; lint refuses it when it drifts from agent.yaml.\n';

const n = (p: Readonly<Record<string, number>>, k: string): number | undefined => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] : undefined);

/** The v2 card text agent.yaml defines (null when the agent has no `card:` block — not a v2-shell supervisor). */
export function genGoalYaml(c: CompiledAgent): string | null {
  if (!c.card) return null;
  const k = c.kpis[0];
  if (!k) return null;
  const p = c.policies;
  const doc: Record<string, unknown> = {
    runtime: 'v2', id: c.id, address: c.address, supervisor: c.card.fallbackSeat,
    soul: { name: c.card.name, role: c.card.role, temperament: c.card.temperament, values: [...c.card.values] },
    subject: c.card.subject, goal: c.goal,
    kpi: { name: k.name, [k.dir]: k.target, ...(k.unit ? { unit: k.unit } : {}) },
    done_when: [...c.doneWhen],
    rights: { actions: [...c.card.actions], never_auto: [...c.neverAuto], ...(n(p, 'max_per_tick') !== undefined ? { max_per_tick: n(p, 'max_per_tick') } : {}), ...(n(p, 'cooldown_min') !== undefined ? { cooldown_min: n(p, 'cooldown_min') } : {}) },
    wake: { events: [...c.card.wakeEvents], max_wait_min: c.wake.maxWaitMin ?? n(p, 'heartbeat_every_min') ?? 10 },
    ...(n(p, 'heartbeat_every_min') !== undefined ? { heartbeat_every_min: n(p, 'heartbeat_every_min') } : {}),
    voice: { per_hour_max: c.voice.perHourMax, role: c.card.voiceRole },
    ...(n(p, 'escalate_after_min') !== undefined ? { escalate_after_min: n(p, 'escalate_after_min') } : {}),
    ...(c.levels.start === 'shadow' || c.levels.start === 'L1' ? { start_level: c.levels.start } : {}),
    // the body policies — the refused-agent.yaml fallback runs with the last clean values (bodies hold no TS default)
    policies: { ...c.policies },
    // SUPERVISORS-EXECUTE-NOT-PROPOSE: the fallback card keeps the authority (its HOLD gate) — never a looser card
    ...(c.authority ? { authority: { executes: [...c.authority.executes], undo: { ...c.authority.undo }, limits: [...c.authority.limits], respect_hold: c.authority.respectHold } } : {}),
  };
  return GOAL_YAML_HEADER(c.id) + stringify(doc, { lineWidth: 0 });
}

/** The card the runtime reads, without the soul text (soul.md is shared by both paths). */
const cardOf = (text: string, where: string): Omit<AgentCard, 'soulText'> => { const { soulText: _s, ...rest } = parseCard(text, '', where); void _s; return rest; };

/** Lint: goal.yaml on disk must be the card agent.yaml generates. Returns the errors (empty = in parity). */
export function goalYamlParity(c: CompiledAgent, onDisk: string | null): string[] {
  const gen = genGoalYaml(c);
  if (gen === null) return [];
  if (onDisk === null) return [`goal.yaml missing — generate it: eln loop agent gen ${c.id}`];
  let a: unknown; let b: unknown;
  try { a = cardOf(gen, 'generated'); } catch (e) { return [`agent.yaml card block does not make a valid v2 card — ${e instanceof Error ? e.message : String(e)}`]; }
  try { b = cardOf(onDisk, 'goal.yaml'); } catch (e) { return [`goal.yaml unreadable — ${e instanceof Error ? e.message : String(e)} · regenerate: eln loop agent gen ${c.id}`]; }
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const ga = a as Record<string, unknown>; const gb = b as Record<string, unknown>;
  const diff = Object.keys(ga).filter(key => JSON.stringify(ga[key]) !== JSON.stringify(gb[key]));
  return [`goal.yaml drift: ${diff.join(', ')} differ from agent.yaml — goal.yaml is generated (eln loop agent gen ${c.id}), edit agent.yaml only`];
}
