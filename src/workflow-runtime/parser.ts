// Archon-port T2.1 (2026-05-08) — YAML → WorkflowDefinition.
//
// Thin wrapper around `yaml` package + `validateWorkflow` from
// schema.ts. Separated so callers (Nexus API, CLI, PWA) can choose
// to feed an already-parsed object straight into validateWorkflow,
// or hand a raw YAML string here.

import { parse as parseYaml } from 'yaml';
import type { ValidationResult } from './schema.js';

export function parseWorkflowYaml(yamlText: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          message: `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      warnings: [],
    };
  }
  const schema = require('./schema.js') as typeof import('./schema.js');
  return schema.validateWorkflow(parsed);
}
