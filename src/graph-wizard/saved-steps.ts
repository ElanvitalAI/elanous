/**
 * GRAPH-WIZARD-SAVE-RECIPES — a wizard graph saved from the editor keeps its runnable steps.
 *
 * The wizard answers with `steps` (node id → {label, step, arg, retries}) and a `recipes` text. The editor
 * saves through `POST /v1/graphs` / `PUT …/yaml`, which store YAML only, so the steps used to be lost and
 * the graph could not really run.
 *
 * ⛔ We do NOT store the client's `recipes` text: `<mine>/` is HTTP-writable, and a recipes file there would
 *    make «run my edited graph» into «run my edited command» (TC 10-07 19:31 — graph-run-api.ts header).
 *    Instead the save stores the *structured* steps in a sidecar (`<mine>/.steps/<id>.json`), every field
 *    validated against the step library (WIZARD_STEPS); at run time the server itself turns them into
 *    commands with `recipesYamlFor` — step names from the whitelist, the argument shell-quoted.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WIZARD_MAX_RETRIES, WIZARD_STEP_IDS, recipesYamlFor, type WizardNodeStep } from './steps.js';

const NODE_ID = /^[a-z0-9][a-z0-9_-]*$/;
const GRAPH_ID = /^[a-z0-9-]+$/;
const MAX_NODES = 200;
const MAX_LABEL = 80;
const MAX_ARG = 1000;

export function savedStepsFile(mineDir: string, graphId: string): string {
  return join(mineDir, '.steps', `${graphId}.json`);
}

function nodeIdsOf(yaml: string): Set<string> {
  try {
    const raw = parseYaml(yaml) as { nodes?: Array<{ node_id?: unknown }> } | null;
    return new Set((raw?.nodes ?? []).map((node) => node?.node_id).filter((id): id is string => typeof id === 'string'));
  } catch { return new Set(); }
}

/** Validate the client's steps against the library and the graph's own node ids. Unknown fields are dropped. */
export function parseWizardSteps(raw: unknown, yaml: string): { ok: true; steps: Record<string, WizardNodeStep> } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'steps must be an object of node id → {label, step, arg, retries}' };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_NODES) return { ok: false, reason: `steps: at most ${MAX_NODES} nodes` };
  const ids = nodeIdsOf(yaml);
  const steps: Record<string, WizardNodeStep> = {};
  for (const [nodeId, value] of entries) {
    if (!NODE_ID.test(nodeId)) return { ok: false, reason: `steps: invalid node id '${nodeId.slice(0, 40)}'` };
    if (!ids.has(nodeId)) continue; // a node removed by hand since the wizard turn — nothing to keep
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: `steps.${nodeId} must be an object` };
    const { label, step, arg, retries } = value as Record<string, unknown>;
    const out: WizardNodeStep = {};
    if (label !== undefined) {
      if (typeof label !== 'string' || label.length > MAX_LABEL) return { ok: false, reason: `steps.${nodeId}.label must be a string ≤ ${MAX_LABEL}` };
      if (label.trim()) out.label = label.trim();
    }
    if (step !== undefined) {
      if (typeof step !== 'string' || !WIZARD_STEP_IDS.has(step)) return { ok: false, reason: `steps.${nodeId}.step must be one of ${[...WIZARD_STEP_IDS].join(', ')}` };
      out.step = step;
    }
    if (arg !== undefined) {
      if (typeof arg !== 'string' || arg.length > MAX_ARG || arg.includes('\0')) return { ok: false, reason: `steps.${nodeId}.arg must be a string ≤ ${MAX_ARG}` };
      if (arg.trim()) out.arg = arg;
    }
    if (retries !== undefined) {
      if (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0 || retries > WIZARD_MAX_RETRIES) return { ok: false, reason: `steps.${nodeId}.retries must be 0..${WIZARD_MAX_RETRIES}` };
      if (retries > 0) out.retries = retries;
    }
    steps[nodeId] = out;
  }
  return { ok: true, steps };
}

export function writeWizardSteps(mineDir: string, graphId: string, steps: Record<string, WizardNodeStep>): void {
  if (!GRAPH_ID.test(graphId)) throw new Error('invalid graph id');
  const file = savedStepsFile(mineDir, graphId);
  mkdirSync(join(mineDir, '.steps'), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(steps, null, 2)}\n`);
  renameSync(temp, file);
}

/** Save the steps and the graph together: the sidecar is written first; if the graph write then throws, the
 *  sidecar goes back to what it was (or away), so a failed save changes neither. A sidecar failure stops the
 *  save before the graph is touched. */
export function withWizardSteps<T>(mineDir: string, graphId: string, steps: Record<string, WizardNodeStep> | null, writeGraph: () => T): T {
  if (!steps) return writeGraph();
  const file = savedStepsFile(mineDir, graphId);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  writeWizardSteps(mineDir, graphId, steps);
  try {
    return writeGraph();
  } catch (error) {
    try {
      if (before === null) rmSync(file, { force: true }); else writeFileSync(file, before);
    } catch { /* best effort — the graph write error is the one to report */ }
    throw error;
  }
}

/** Read the sidecar back — re-validated (the file may have been edited by hand), pruned to the graph's nodes. */
export function readWizardSteps(mineDir: string, graphId: string, yaml: string): Record<string, WizardNodeStep> | null {
  if (!GRAPH_ID.test(graphId)) return null;
  const file = savedStepsFile(mineDir, graphId);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const parsed = parseWizardSteps(raw, yaml);
  return parsed.ok ? parsed.steps : null;
}

/** Recipes the server generates for the graph's `cmd:` nodes that carry a library step (approvals are not
 *  generated here — the editor run still refuses approval recipes). */
export function wizardRecipesFor(yaml: string, steps: Record<string, WizardNodeStep>, bin?: string): Record<string, unknown> {
  let raw: { nodes?: Array<{ node_id?: unknown; recipe?: unknown }> } | null;
  try { raw = parseYaml(yaml) as typeof raw; } catch { return {}; }
  const nodes = (raw?.nodes ?? [])
    .map((node) => ({ nodeId: String(node?.node_id ?? ''), recipe: typeof node?.recipe === 'string' ? node.recipe : '' }))
    .filter((node) => node.recipe.startsWith('cmd:') && steps[node.nodeId]?.step);
  if (!nodes.length) return {};
  const text = bin === undefined ? recipesYamlFor(nodes, steps) : recipesYamlFor(nodes, steps, bin);
  const parsed = parseYaml(text) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
