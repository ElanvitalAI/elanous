import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { HealCard, HealStep } from './heal-runner.js';
import { validateHealAction } from './heal-actions.js';

export const HEAL_ACTION_IDS = new Set([
  'evidence.read', 'host.load.read', 'host.load.wait', 'host.load.verify', 'hitl.request',
]);
const SIGNAL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const KEYS = new Set(['signal', 'owner', 'diagnose', 'repair', 'verify', 'escalate']);

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`heal card: ${where} must be a map`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`heal card: unknown ${where}.${key}`);
}
function steps(value: unknown, stage: 'diagnose' | 'repair' | 'verify'): HealStep[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`heal card: ${stage} must be a nonempty list`);
  return value.map((raw, index) => {
    const step = object(raw, `${stage}[${index}]`);
    keys(step, ['action', 'args', 'risk', 'rollback'], `${stage}[${index}]`);
    if (typeof step.action !== 'string' || !HEAL_ACTION_IDS.has(step.action)) throw new Error(`heal card: unsupported ${stage} action`);
    if (stage === 'repair' && !['host.load.wait', 'hitl.request'].includes(step.action)) throw new Error('heal card: action is not a repair');
    if (stage === 'diagnose' && !['evidence.read', 'host.load.read'].includes(step.action)) throw new Error('heal card: action is not a diagnosis');
    if (stage === 'verify' && !['evidence.read', 'host.load.read', 'host.load.verify'].includes(step.action)) throw new Error('heal card: action is not a verification');
    if (stage === 'repair' && (step.risk !== 'safe' && step.risk !== 'hitl')) throw new Error('heal card: repair risk required');
    if (stage !== 'repair' && (step.risk !== undefined || step.rollback !== undefined)) throw new Error('heal card: risk and rollback belong to repair');
    if (step.rollback !== undefined && (typeof step.rollback !== 'string' || !step.rollback.trim())) throw new Error('heal card: invalid rollback');
    let args: Record<string, string | number> | undefined;
    if (step.args !== undefined) {
      const parsed = object(step.args, `${stage}[${index}].args`);
      args = {};
      for (const [key, item] of Object.entries(parsed)) {
        if (typeof item !== 'string' && (typeof item !== 'number' || !Number.isFinite(item))) throw new Error('heal card: invalid action arg');
        args[key] = item;
      }
    }
    if (step.action === 'hitl.request' && (stage !== 'repair' || step.risk !== 'hitl')) throw new Error('heal card: hitl.request requires repair risk hitl');
    if (stage === 'repair' && step.risk === 'safe' && step.action !== 'host.load.wait') throw new Error('heal card: safe repair is not allowlisted');
    if (stage === 'repair' && step.risk === 'hitl' && step.action !== 'hitl.request') throw new Error('heal card: HITL repair must request HITL');
    if (stage === 'repair' && step.risk === 'safe' && !step.rollback) throw new Error('heal card: safe repair rollback required');
    validateHealAction(step.action, args);
    return { action: step.action, ...(args ? { args } : {}), ...(step.risk ? { risk: step.risk as 'safe' | 'hitl' } : {}), ...(step.rollback ? { rollback: step.rollback as string } : {}) };
  });
}

export function parseHealCard(contents: string, expectedSignal: string): HealCard {
  if (!SIGNAL.test(expectedSignal)) throw new Error('heal: invalid signal');
  if (Buffer.byteLength(contents) > 64 * 1024) throw new Error('heal card: over 64 KiB');
  const document = parseDocument(contents, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`heal card: YAML: ${document.errors[0]!.message}`);
  const card = object(document.toJS({ maxAliasCount: 0 }), 'root');
  keys(card, [...KEYS], 'root');
  if (card.signal !== expectedSignal) throw new Error('heal card: signal does not match filename');
  if (typeof card.owner !== 'string' || !/^[A-Z][A-Z0-9-]{1,31}$/.test(card.owner)) throw new Error('heal card: invalid owner');
  const escalate = object(card.escalate, 'escalate');
  keys(escalate, ['after', 'message'], 'escalate');
  if (!Number.isInteger(escalate.after) || (escalate.after as number) < 1 || (escalate.after as number) > 3 || typeof escalate.message !== 'string' || !escalate.message.trim()) throw new Error('heal card: invalid escalate');
  const diagnose = steps(card.diagnose, 'diagnose');
  const repair = steps(card.repair, 'repair');
  const verify = steps(card.verify, 'verify');
  if (repair.some((step) => step.risk === 'safe') &&
      (expectedSignal !== 'pregate-load-over' || repair.length !== 1 || repair[0]!.action !== 'host.load.wait' || verify.length !== 1 || verify[0]!.action !== 'host.load.verify')) {
    throw new Error('heal card: safe READY requires the pregate load verifier');
  }
  return { signal: expectedSignal, owner: card.owner, diagnose, repair, verify, escalate: { after: escalate.after as number, message: escalate.message } };
}

/** Cards are single regular files below a real OPS/tb directory. Missing and unreadable differ. */
export function loadHealCard(seatStateRoot: string, signal: string): HealCard {
  if (!SIGNAL.test(signal)) throw new Error('heal: invalid signal');
  const ops = join(seatStateRoot, 'OPS');
  const dir = join(ops, 'tb');
  for (const path of [seatStateRoot, ops, dir]) {
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`heal card: unsafe directory ${path}`);
  }
  const path = join(dir, `${signal}.yaml`);
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024) throw new Error('heal card: unsafe card file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 64 * 1024) throw new Error('heal card: unsafe opened card');
    return parseHealCard(readFileSync(fd, 'utf8'), signal);
  } finally { closeSync(fd); }
}
