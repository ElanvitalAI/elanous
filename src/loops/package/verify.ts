import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../../debug/log.js';
import { loopAgentContractErrors } from '../contract/validate.js';

const contractSchema = JSON.parse(readFileSync(resolve(import.meta.dir, '../contract/loop-agent.schema.json'), 'utf8')) as { $id: string };
const allowedOverlayFields = new Set(['neighbors', 'cadence', 'grounding', 'budget']);
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaMajor(value: string): number | null {
  const match = /^(?:https:\/\/elanous\.ai\/schemas\/loop-agent\/)?(\d+)\.\d+\.\d+$/.exec(value);
  return match ? Number(match[1]) : null;
}

/** The package version is independent of the declared contract schema version. */
export function contractMajor(manifest: RecordValue): { ok: boolean; error?: string } {
  const declared = manifest.schema ?? manifest.$schema ?? contractSchema.$id;
  const expected = schemaMajor(contractSchema.$id);
  const actual = typeof declared === 'string' ? schemaMajor(declared) : null;
  const other = manifest.schema !== undefined && manifest.$schema !== undefined ? manifest.$schema : undefined;
  if (actual !== null && expected !== null && actual === expected &&
      (other === undefined || typeof other === 'string' && schemaMajor(other) === expected)) return { ok: true };
  return { ok: false, error: `contract major mismatch: declared ${String(declared)}${other === undefined ? '' : ` / ${String(other)}`}, expected ${contractSchema.$id}` };
}

/** Replace only allowlisted top-level fields; refused fields never enter the merged manifest. */
export function mergeOverlay(manifest: RecordValue, overlay: unknown): { merged: RecordValue; refused: string[] } {
  const merged = { ...manifest };
  const refused: string[] = [];
  if (!record(overlay)) return { merged, refused: ['overlay'] };
  for (const [field, value] of Object.entries(overlay)) {
    if (!allowedOverlayFields.has(field)) refused.push(field);
    else merged[field] = value;
  }
  return { merged, refused };
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function readReference(root: string, name: string, path: unknown, errors: string[]): void {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || path.split(/[\\/]/).includes('..')) {
    errors.push(`${name} path escape: ${String(path)}`);
    return;
  }
  const candidate = resolve(root, path);
  if (!inside(root, candidate)) {
    errors.push(`${name} path escape: ${path}`);
    return;
  }
  try {
    const actual = realpathSync(candidate);
    if (!inside(root, actual)) errors.push(`${name} path escape: ${path}`);
    else if (!statSync(actual).isFile()) errors.push(`${name} file missing: ${path}`);
  } catch {
    errors.push(`${name} file missing: ${path}`);
  }
}

export function readLoopPackage(dir: string): { manifest: RecordValue | null; overlay?: unknown; errors: string[] } {
  const errors: string[] = [];
  let manifest: RecordValue | null = null;
  let overlay: unknown;
  const root = realpathSync(dir);
  if (!statSync(root).isDirectory()) throw new Error(`${dir} is not a directory`);
  const readYaml = (name: string): unknown => {
    const path = resolve(root, name);
    const actual = realpathSync(path);
    if (!inside(root, actual) || !statSync(actual).isFile()) throw new Error(`${name} path escape or not a file`);
    return parseYaml(readFileSync(actual, 'utf8'));
  };
  try {
    const parsed = readYaml('loop.yaml');
    if (!record(parsed)) errors.push('loop.yaml must contain a manifest object');
    else manifest = parsed;
  } catch (error) { errors.push(`loop.yaml: ${error instanceof Error ? error.message : String(error)}`); }
  try { overlay = readYaml('overlay.yaml'); }
  catch (error) {
    if (!(record(error) && error.code === 'ENOENT')) errors.push(`overlay.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest) {
    readReference(root, 'graph', manifest.graph, errors);
    readReference(root, 'role', manifest.role, errors);
  }
  return { manifest, overlay, errors };
}

export function verifyLoopPackage(dir: string): {
  ok: boolean; errors: string[]; refusedOverlayFields: string[]; merged: RecordValue | null;
} {
  let manifest: RecordValue | null = null;
  let overlay: unknown;
  const errors: string[] = [];
  try {
    const read = readLoopPackage(dir);
    manifest = read.manifest;
    overlay = read.overlay;
    errors.push(...read.errors);
  } catch (error) { errors.push(`package directory: ${error instanceof Error ? error.message : String(error)}`); }
  let merged: RecordValue | null = null;
  let refusedOverlayFields: string[] = [];
  if (manifest) {
    const major = contractMajor(manifest);
    if (major.error) errors.push(major.error);
    const result = overlay === undefined ? { merged: { ...manifest }, refused: [] } : mergeOverlay(manifest, overlay);
    refusedOverlayFields = result.refused;
    merged = result.merged;
    if (refusedOverlayFields.length) errors.push(`overlay refused: ${refusedOverlayFields.join(', ')}`);
    // Schema declaration is package metadata, not a field in the loop-agent contract.
    const { schema: _schema, $schema: _dollarSchema, ...contractInput } = merged;
    errors.push(...loopAgentContractErrors(contractInput));
  }
  const ok = errors.length === 0;
  debug.log('loop.package', ok ? 'verified' : 'refused', {
    id: manifest?.id, version: manifest?.version, errors: errors.length, refusedOverlayFields,
  });
  return { ok, errors, refusedOverlayFields, merged };
}
