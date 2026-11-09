import { isObject } from '../primitives/guards.js';
// ── Presentation P5a · Scenario catalog loader ──
//
// Reads `scenarios/*.yaml` (or any directory the caller points to),
// parses each file via the project's existing `yaml@2.x` dep, validates
// the minimum ScenarioDef shape, and returns a Map keyed by id.
//
// Error handling is lenient — a broken file doesn't fail the whole
// load. The catalog reports errors per-file in `errors[]` so callers
// can surface them in the Playground UI or LLM tool output.

import { promises as fs } from 'fs';
import { join } from 'path';
import type { ScenarioCatalog, ScenarioDef, ScenarioLoadError } from './types.js';

export interface LoadScenarioCatalogOptions {
  /** How to handle duplicate ids across files. Defaults to `'last-wins'`
   *  which warns in `errors[]` but keeps the most recently-scanned file
   *  winning. `'strict'` rejects the second occurrence (the first file
   *  wins). */
  readonly onDuplicate?: 'last-wins' | 'strict';
  /** File extensions to consider. Default `['.yaml', '.yml']`. */
  readonly extensions?: readonly string[];
}

const DEFAULT_EXTENSIONS = ['.yaml', '.yml'] as const;

function validateShape(
  parsed: unknown,
  filePath: string,
): { ok: true; def: ScenarioDef } | { ok: false; error: ScenarioLoadError } {
  if (!isObject(parsed)) {
    return { ok: false, error: { path: filePath, message: 'root is not a YAML object' } };
  }
  const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
  if (!id) {
    return { ok: false, error: { path: filePath, message: 'missing `id` field (non-empty string required)' } };
  }
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  if (!title) {
    return { ok: false, error: { path: filePath, message: 'missing `title` field (non-empty string required)' } };
  }
  if (!('layout' in parsed)) {
    return { ok: false, error: { path: filePath, message: 'missing `layout` field' } };
  }
  const def: ScenarioDef = {
    id,
    title,
    ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
    layout: parsed.layout,
    ...(isObject(parsed.meta) ? { meta: parsed.meta as Record<string, unknown> } : {}),
  };
  return { ok: true, def };
}

/** Load every scenario YAML under `dir`. Returns a Map<id, ScenarioDef>
 *  + an errors array. Absent or unreadable directory → empty catalog
 *  + one error entry; no throw.
 *
 *  Scenarios are returned in the order their filenames sort — callers
 *  can rely on stable iteration for LLM output and Playground menus. */
export async function loadScenarioCatalog(
  dir: string,
  options: LoadScenarioCatalogOptions = {},
): Promise<ScenarioCatalog> {
  const onDuplicate = options.onDuplicate ?? 'last-wins';
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const errors: ScenarioLoadError[] = [];
  const scenarios = new Map<string, ScenarioDef>();

  let entries: string[];
  try {
    const list = await fs.readdir(dir);
    entries = list.filter((name) => extensions.some((ext) => name.endsWith(ext)));
  } catch (err) {
    errors.push({
      path: dir,
      message: `failed to read directory: ${(err as Error).message}`,
    });
    return { scenarios, errors };
  }

  entries.sort((a, b) => a.localeCompare(b));

  // `yaml` is already in package.json (brought in by B-3 timeline migration).
  // Lazy import keeps the module loadable in environments that stub the dep.
  const { parse } = await import('yaml');

  for (const name of entries) {
    const filePath = join(dir, name);
    let raw: string;
    try { raw = await fs.readFile(filePath, 'utf8'); }
    catch (err) {
      errors.push({ path: filePath, message: `read failed: ${(err as Error).message}` });
      continue;
    }
    let parsed: unknown;
    try { parsed = parse(raw); }
    catch (err) {
      errors.push({ path: filePath, message: `YAML parse failed: ${(err as Error).message}` });
      continue;
    }
    const validated = validateShape(parsed, filePath);
    if (!validated.ok) {
      errors.push(validated.error);
      continue;
    }
    const { def } = validated;
    if (scenarios.has(def.id)) {
      if (onDuplicate === 'strict') {
        errors.push({
          path: filePath,
          message: `duplicate id "${def.id}" — kept first occurrence (strict mode)`,
        });
        continue;
      }
      errors.push({
        path: filePath,
        message: `duplicate id "${def.id}" — overwritten by this file (last-wins)`,
      });
    }
    scenarios.set(def.id, def);
  }

  return { scenarios, errors };
}
