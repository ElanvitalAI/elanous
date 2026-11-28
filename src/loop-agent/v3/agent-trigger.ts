// YAML-SUPERVISORS-RUNTIME (CEO 11-27 17:4x «9종 YAML 정의 최우선») — the agent.yaml `wake:` block is the ONE definition of
// a loop agent's trigger. graphs/triggers/<registered_as>.yaml for such an agent is only the runnable tick shim
// (`loop: { from_agent: <id> }` ⊕ the one `tick` node · it has no trigger of its own); the trigger registry builds the
// `loop:` block here from the agent's package, so `eln loop trigger register` reads agent.yaml and an edit there changes
// the registered trigger.
//
// 세 얼굴: 관측 = the registry row (`eln loop trigger list`) ⊕ `eln loop agent lint` (shim ⇄ agent.yaml) / 판단 근거 = agent.yaml
// wake (cron | condition · failure · owner) ⊕ card.fallback_seat (exception cards · literal, host-independent) ⊕ the shell's goal file / 수복과 인계 = a broken
// wake throws here → the registry refuses to register it (loud) and lint shows it in the OP world card.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

const ID_RE = /^[a-z][a-z0-9-]{0,62}$/u;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** graphs/triggers/<x>.yaml → graphs/loop-agents/<id>/agent.yaml (same `graphs/` tree — repo, install or sim copy). */
export const agentYamlBesideTrigger = (triggerFile: string, id: string): string => join(dirname(triggerFile), '..', 'loop-agents', id, 'agent.yaml');

/** The goal file the v2 shell writes at the end of every tick (the trigger's done-when). */
export const agentGoalPath = (id: string): string => `{stateRoot}/loop-agents/${id}/last-tick.json`;

/**
 * The trigger-registry `loop:` block for a shim that names `from_agent: <id>` — built from that agent's agent.yaml.
 * Throws (with the reason) when the package cannot define a trigger: the registry then refuses the registration.
 */
export function agentTriggerLoop(triggerFile: string, id: string): Record<string, unknown> {
  if (!ID_RE.test(id)) throw new Error(`loop.from_agent ${JSON.stringify(id)} is not an agent id`);
  const path = agentYamlBesideTrigger(triggerFile, id);
  if (!existsSync(path)) throw new Error(`loop.from_agent ${id}: no ${path}`);
  const j = parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!isObj(j)) throw new Error(`loop.from_agent ${id}: agent.yaml is not a mapping`);
  const ident = isObj(j.identity) ? j.identity : {};
  if (ident.id !== id) throw new Error(`loop.from_agent ${id}: agent.yaml identity.id is ${String(ident.id)}`);
  const wake = isObj(j.wake) ? j.wake : {};
  if (!isObj(wake.trigger)) throw new Error(`loop.from_agent ${id}: agent.yaml has no wake.trigger`);
  const card = isObj(j.card) ? j.card : {};
  // owner = who gets the registry's exception card (no tick / goal missed): `wake.owner` when set, else the card's
  // fallback_seat — literal, so the registered trigger is the same on every host (the L0 by duty can differ per org file)
  const owner = typeof wake.owner === 'string' && wake.owner ? wake.owner.toUpperCase()
    : typeof card.fallback_seat === 'string' && card.fallback_seat ? card.fallback_seat.toUpperCase() : '';
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/u.test(owner)) throw new Error(`loop.from_agent ${id}: agent.yaml needs card.fallback_seat (or wake.owner) — the trigger's exception-card owner`);
  const man = isObj(j.manifest) ? j.manifest : {};
  return {
    title: `${typeof card.name === 'string' ? card.name : id} (${id}) — loop agent tick (graphs/loop-agents/${id}/agent.yaml)`,
    managed_by: 'trigger-registry',
    description: typeof man.description === 'string' ? man.description : '',
    owner,
    trigger: wake.trigger,
    // GUARDIAN-V3-SMART: `wake.goal` = the agent's own result file when it is not the v2 shell (the guardian pulse writes
    // last-pulse.json) · absent = the shell's last-tick.json
    goal: isObj(wake.goal) ? wake.goal : { kind: 'file-mtime', path: agentGoalPath(id) },
    ...(isObj(wake.failure) ? { failure: wake.failure } : {}),
    // relation key `absorbs:` (top level · roles and triggers alike): the `kind: trigger` ids retire in the registry's registration
    // transaction; a garbled value goes through as written so the registry refuses it loudly
    ...(j.absorbs === undefined ? {} : { absorbs: Array.isArray(j.absorbs) ? j.absorbs.filter(a => isObj(a) && a.kind === 'trigger').map(a => (a as Record<string, unknown>).id) : j.absorbs }),
  };
}
