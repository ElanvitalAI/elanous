import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireLockSync } from '../storage/file-lock.js';

export interface HealStep { action: string; args?: Record<string, string | number>; risk?: 'safe' | 'hitl'; rollback?: string }
export interface HealCard {
  signal: string;
  owner: string;
  diagnose: HealStep[];
  repair: HealStep[];
  verify: HealStep[];
  escalate: { after: number; message: string };
}
export interface HealActionResult { ok: boolean; detail: string }
export interface HealStepResult extends HealActionResult { action: string }
export interface HealResult {
  signal: string;
  outcome: 'ready' | 'hitl';
  diagnose: HealStepResult[];
  repair: HealStepResult[];
  verify: HealStepResult[];
  hitl?: { owner: string; message: string };
  improvementOpened: boolean;
}
export interface HealDeps {
  ledgerDir: string;
  execute: (action: string, args?: HealStep['args']) => Promise<HealActionResult>;
  openImprovement?: (signal: string) => void;
}

const SIGNAL_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
function validateCard(card: HealCard): void {
  if (!SIGNAL_RE.test(card.signal)) throw new Error('heal: invalid signal');
  if (!card.owner.trim()) throw new Error('heal: missing owner');
  if (!card.diagnose.length || !card.verify.length) throw new Error('heal: diagnose and verify are required');
  for (const step of [...card.diagnose, ...card.repair, ...card.verify]) {
    if (!/^[a-z][a-z0-9.-]+$/.test(step.action)) throw new Error('heal: invalid action id');
  }
  if (card.repair.some((step) => step.risk !== 'safe' && step.risk !== 'hitl')) throw new Error('heal: repair risk is required');
  if (!Number.isInteger(card.escalate.after) || card.escalate.after < 1 || card.escalate.after > 3 || !card.escalate.message.trim()) throw new Error('heal: invalid escalate');
}

async function runSteps(steps: readonly HealStep[], execute: HealDeps['execute']): Promise<HealStepResult[]> {
  const results: HealStepResult[] = [];
  for (const step of steps) {
    try {
      const result = await execute(step.action, step.args);
      results.push({ action: step.action, ...result });
      if (!result.ok) break;
    } catch (error) {
      results.push({ action: step.action, ok: false, detail: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  return results;
}

function assertPrivateDir(dir: string): void {
  let st;
  try { st = lstatSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = lstatSync(dir);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('heal: ledger directory is not a real directory');
}

function pathAbsent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

type HealEvent = { signal?: string; [key: string]: unknown };
function readEvents(path: string): HealEvent[] {
  let content: string;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) throw new Error('heal: unsafe ledger file');
      content = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return content.trim() ? content.trimEnd().split('\n').map((line) => JSON.parse(line) as HealEvent) : [];
}

function replaceEvents(path: string, events: HealEvent[]): void {
  const line = Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  if (line.length > 8 * 1024 * 1024) throw new Error('heal: ledger capacity reached');
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, path);
}

/** Runs a validated card. The caller supplies only registered action IDs, never shell text from YAML. */
export async function runHealCard(card: HealCard, deps: HealDeps): Promise<HealResult> {
  validateCard(card);
  assertPrivateDir(deps.ledgerDir);
  readEvents(join(deps.ledgerDir, 'heal-events.jsonl'));
  const diagnose = await runSteps(card.diagnose, deps.execute);
  let repair: HealStepResult[] = [];
  let verify: HealStepResult[] = [];
  let outcome: HealResult['outcome'] = 'hitl';
  if (diagnose.every((result) => result.ok) && card.repair.every((step) => step.risk === 'safe')) {
    for (let attempt = 0; attempt < card.escalate.after; attempt++) {
      const repaired = await runSteps(card.repair, deps.execute);
      repair.push(...repaired);
      if (repaired.length !== card.repair.length || repaired.some((result) => !result.ok)) continue;
      const checked = await runSteps(card.verify, deps.execute);
      verify.push(...checked);
      if (checked.length === card.verify.length && checked.every((result) => result.ok)) { outcome = 'ready'; break; }
    }
  }
  const path = join(deps.ledgerDir, 'heal-events.jsonl');
  const release = acquireLockSync(join(deps.ledgerDir, 'heal-events.lock'), { breakDeadHolder: true });
  let improvementOpened = false;
  try {
    const events = readEvents(path);
    const previous = events.filter((event) => event.signal === card.signal).length;
    const marker = join(deps.ledgerDir, `improve-${card.signal}.created`);
    events.push({ at: new Date().toISOString(), signal: card.signal, owner: card.owner, outcome, diagnose, repair, verify,
      ...(outcome === 'hitl' ? { escalate: card.escalate.message } : {}) });
    replaceEvents(path, events);
    if (previous + 1 >= 3 && pathAbsent(marker) && deps.openImprovement) {
      deps.openImprovement(card.signal);
      const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      improvementOpened = true;
    }
  } finally { release(); }
  return { signal: card.signal, outcome, diagnose, repair, verify,
    ...(outcome === 'hitl' ? { hitl: { owner: card.owner, message: card.escalate.message } } : {}), improvementOpened };
}
