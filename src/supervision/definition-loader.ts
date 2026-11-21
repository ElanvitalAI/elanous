import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import type { SupervisorLoopRef } from './incident-claim.js';

import contractSchema from '../loops/contract/loop-agent.schema.json';
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(contractSchema);
const validateDefinition = ajv.getSchema(`${contractSchema.$id}#/$defs/supervisorV1`)!;

export interface SupervisorDefinition {
  readonly apiVersion: 'elanous.dev/supervisor/v1';
  readonly kind: 'supervisor';
  readonly ref: SupervisorLoopRef;
  readonly role: 'primary' | 'healer' | 'observer' | 'watcher';
  readonly supervises: readonly string[];
  readonly signals: readonly { readonly signal: string; readonly actor: 'final' | 'observer' }[];
  readonly authority: readonly string[];
  readonly reportsTo: SupervisorLoopRef;
  readonly escalation: { readonly to: SupervisorLoopRef; readonly silenceAfter: string };
  readonly memory: {
    readonly instance: { readonly read: boolean; readonly write: boolean; readonly promote: 'none' | 'template-candidate'; readonly retention: string };
    readonly template: { readonly read: boolean; readonly write: 'none' | 'gated-promotion'; readonly promote: 'none'; readonly retention: string };
    readonly global: { readonly read: 'none' | 'card-bound-only'; readonly write: 'none'; readonly promote: 'none' };
    readonly provenance: 'required';
  };
}

export interface LoadedSupervisorDefinition {
  readonly source: string;
  readonly definition: SupervisorDefinition;
}

export interface SupervisorDefinitionLoad {
  readonly definitions: readonly LoadedSupervisorDefinition[];
  readonly errors: readonly string[];
}

const repoRoot = resolve(import.meta.dir, '../..');

export const DEFAULT_SUPERVISOR_DEFINITION_PATHS: readonly string[] = [
  resolve(repoRoot, 'graphs/release/rla/loop.yaml'),
  resolve(import.meta.dir, 'definitions/macrophage.supervisor.yaml'),
  resolve(import.meta.dir, 'definitions/heal.supervisor.yaml'),
  resolve(import.meta.dir, 'definitions/silence.supervisor.yaml'),
  resolve(import.meta.dir, 'definitions/run-doctor.supervisor.yaml'),
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A loop card (elanous.dev/loop/v1) carries its definition under `supervisor`; any other document is the definition itself. */
function definitionDocument(document: unknown): unknown {
  return isRecord(document) && document.apiVersion === 'elanous.dev/loop/v1' ? document.supervisor : document;
}

export function supervisorDefinitionErrors(input: unknown): string[] {
  if (!validateDefinition(input)) {
    return (validateDefinition.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message}`);
  }
  const definition = input as SupervisorDefinition;
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const [index, entry] of definition.signals.entries()) {
    if (seen.has(entry.signal)) errors.push(`/signals/${index} duplicate signal: ${entry.signal}`);
    seen.add(entry.signal);
  }
  return errors;
}

/** Set rules across definitions: one definition per ref, and at most one final actor per signal. */
export function supervisorSetErrors(definitions: readonly LoadedSupervisorDefinition[]): string[] {
  const errors: string[] = [];
  const refs = new Map<string, string>();
  const finalActors = new Map<string, LoadedSupervisorDefinition>();
  for (const loaded of definitions) {
    const { ref, signals } = loaded.definition;
    const previousSource = refs.get(ref);
    if (previousSource !== undefined) errors.push(`duplicate supervisor ref ${ref}: ${previousSource} and ${loaded.source}`);
    else refs.set(ref, loaded.source);
    for (const entry of signals) {
      if (entry.actor !== 'final') continue;
      const owner = finalActors.get(entry.signal);
      if (owner && owner.definition.ref !== ref) {
        errors.push(`signal ${entry.signal} has two final actors: ${owner.definition.ref} (${owner.source}) and ${ref} (${loaded.source})`);
      } else if (!owner) {
        finalActors.set(entry.signal, loaded);
      }
    }
  }
  return errors;
}

/** Load and validate supervisor/v1 definitions. Any error rejects the whole set: `definitions` is empty unless `errors` is. */
export function loadSupervisorDefinitions(paths: readonly string[] = DEFAULT_SUPERVISOR_DEFINITION_PATHS): SupervisorDefinitionLoad {
  const loaded: LoadedSupervisorDefinition[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    let document: unknown;
    try {
      document = parseYaml(readFileSync(path, 'utf8'));
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const candidate = definitionDocument(document);
    const definitionErrors = supervisorDefinitionErrors(candidate);
    if (definitionErrors.length) errors.push(...definitionErrors.map(message => `${path}: ${message}`));
    else loaded.push({ source: path, definition: candidate as SupervisorDefinition });
  }
  errors.push(...supervisorSetErrors(loaded));
  return errors.length ? { definitions: [], errors } : { definitions: loaded, errors: [] };
}
