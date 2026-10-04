// Archon-port T2.2 (2026-05-08) — workflow YAML write/read/delete.
//
// Validates before write. Refuses to overwrite the built-in source
// (callers must save to project or global). Backup file
// (`<name>.yaml.bak`) is written on overwrite — cheap rollback.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { parseDocument } from 'yaml';
import {
  getGlobalWorkflowDir,
  getProjectWorkflowDir,
  validateWorkflowFile,
} from './discovery.js';
import { parseWorkflowYaml } from './parser.js';
import type { ValidationResult } from './schema.js';
import type { WorkflowSource } from './types.js';

export interface SaveOpts {
  /** 'project' (`<cwd>/.elanous/workflows/`) or 'global'
   *  (`~/.elanous/workflows/`). Built-in samples are not user-writable. */
  scope: 'project' | 'global';
  cwd?: string;
}

export interface SaveResult {
  ok: boolean;
  path?: string;
  /** When `ok=false`. */
  validation?: ValidationResult;
  error?: string;
  readonly?: boolean;
}

/** Read the target file rather than the incoming body: PUT cannot clear its own lock. */
function fileIsReadonly(filePath: string): boolean {
  try {
    const doc = parseDocument(readFileSync(filePath, 'utf-8'));
    return doc.errors.length === 0 && doc.get('readonly') === true;
  } catch {
    return false;
  }
}

/** Write YAML to disk after validation. Creates the dir if missing. */
export function saveWorkflow(
  name: string,
  yamlText: string,
  opts: SaveOpts,
): SaveResult {
  const dir =
    opts.scope === 'project'
      ? getProjectWorkflowDir(opts.cwd ?? process.cwd())
      : getGlobalWorkflowDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `cannot create dir ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const filePath = join(dir, `${name}.yaml`);
  if (fileIsReadonly(filePath) || fileIsReadonly(join(dir, `${name}.yml`))) {
    return { ok: false, error: 'readonly workflow cannot be overwritten', readonly: true };
  }
  const validation = parseWorkflowYaml(yamlText);
  if (!validation.ok || !validation.workflow) {
    return { ok: false, validation };
  }
  if (validation.workflow.name !== name) {
    return {
      ok: false,
      error: `name mismatch: YAML declares '${validation.workflow.name}', requested '${name}'`,
      validation,
    };
  }
  if (existsSync(filePath)) {
    try {
      copyFileSync(filePath, `${filePath}.bak`);
    } catch {
      // Best-effort backup; proceed even if backup fails.
    }
  }
  try {
    writeFileSync(filePath, yamlText, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      error: `write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, path: filePath };
}

export interface DeleteResult {
  ok: boolean;
  path?: string;
  error?: string;
  readonly?: boolean;
}

/** Delete a user-written workflow. Refuses built-in scope. */
export function deleteWorkflow(
  name: string,
  opts: SaveOpts,
): DeleteResult {
  const dir =
    opts.scope === 'project'
      ? getProjectWorkflowDir(opts.cwd ?? process.cwd())
      : getGlobalWorkflowDir();
  const filePath = join(dir, `${name}.yaml`);
  const ymlPath = join(dir, `${name}.yml`);
  if (fileIsReadonly(filePath) || fileIsReadonly(ymlPath)) {
    return { ok: false, error: 'readonly workflow cannot be deleted', readonly: true };
  }
  if (!existsSync(filePath)) {
    // Try .yml fallback before declaring missing
    if (existsSync(ymlPath)) {
      try {
        unlinkSync(ymlPath);
        return { ok: true, path: ymlPath };
      } catch (err) {
        return {
          ok: false,
          error: `delete failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return { ok: false, error: `not found: ${filePath}` };
  }
  try {
    unlinkSync(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return {
      ok: false,
      error: `delete failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Read the raw YAML text for a given file path. */
export function readWorkflowYaml(filePath: string): string {
  return readFileSync(filePath, 'utf-8');
}

/** Convenience: read + validate. Used by GET /v1/workflows/{name}. */
export function readAndValidate(filePath: string): {
  yaml: string;
  validation: ValidationResult;
} {
  const yaml = readFileSync(filePath, 'utf-8');
  const validation = validateWorkflowFile(filePath);
  return { yaml, validation };
}

/** Type re-export so callers don't need to dig into discovery.ts. */
export type { WorkflowSource };
