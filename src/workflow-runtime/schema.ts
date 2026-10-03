// Archon-port T2.1 (2026-05-08) — workflow YAML validation.
//
// Hand-rolled validator (no zod dep — keeps this module self-contained
// and matches the "Wave 8" tool-deny pattern of compact `if`-driven
// validators). Mirrors Archon `packages/workflows/src/schemas/dag-node.ts`
// flat-with-superRefine semantics: one validator returns either a parsed
// `WorkflowDefinition` or a list of structured errors.

import type {
  ApprovalNode,
  BashNode,
  CftNode,
  ClassifyNode,
  DagNode,
  ChatTriggerNode,
  DiscordTriggerNode,
  ExtractNode,
  FilterNode,
  HttpRequestNode,
  IfNode,
  IterationNode,
  ManualTriggerNode,
  PromptNode,
  ScheduleTriggerNode,
  SetNode,
  ShowroomNode,
  TaskNode,
  SkillNode,
  SubworkflowNode,
  SwitchNode,
  TelegramTriggerNode,
  TemplateNode,
  WebhookTriggerNode,
  PluginKindNode,
  TriggerRule,
  WorkflowDefinition,
} from './types.js';
import { normalizeProviderId } from '../registry/normalize.js';
import { buildWarnings, type ValidationWarning } from './validation-warnings.js';
import { getNodeKind, WORKFLOW_CORE_KINDS } from '../graph-kinds/registry.js';
import { findWorkflow } from './discovery.js';

// Discovery parses workflows through this validator. Nested parses validate
// shapes; the outer validation walks the references with one call stack.
let resolvingSubworkflowReferences = false;

/** ⛔ 노드 변종의 SSOT — 도움말·문서가 이 배열에서 «파생»한다.
 *  손으로 목록을 옮겨 적으면 늙는다(2026-09-22 실측: `elanous wf --help` 가 13종만 말했고
 *  이 배열은 21종을 받고 있었다 — 여덟이 «안내 없이» 살아 있었다). */
export const WORKFLOW_NODE_VARIANT_KEYS = WORKFLOW_CORE_KINDS;

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TRIGGER_RULES: readonly TriggerRule[] = [
  'all_success',
  'one_success',
  'all_done',
];

// RFC #2161 Phase 3 — capability flag names allowed in node `requires`.
// Mirrors the boolean flags from src/registry/types.ts ProviderCapabilities.
const CAP_FLAG_KEYS = new Set<string>([
  'sessionResume',
  'mcp',
  'hooks',
  'skills',
  'agents',
  'toolRestrictions',
  'structuredOutput',
  'envInjection',
  'costControl',
  'effortControl',
  'thinkingControl',
  'fallbackModel',
  'sandbox',
  'multiHostFanout',
]);

export interface ValidationIssue {
  /** Path into the YAML, e.g. `nodes[2].id`. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  /** When `ok=true`. The validator narrows `unknown → WorkflowDefinition`
   *  by the time it returns success. */
  workflow?: WorkflowDefinition;
  issues: ValidationIssue[];
  /** M4-2 (2026-05-12) — non-fatal deterministic warnings.
   *  Populated only when `ok=true` (schema-valid workflows). PWA
   *  validation badge + R3 NL synth retry both consume this surface.
   *  See `validation-warnings.ts` for the rule catalog. */
  warnings: ValidationWarning[];
}

/** Validate raw YAML-parsed object → WorkflowDefinition. Pure: never
 *  throws, accumulates all issues so the UI can show them at once. */
export function validateWorkflow(raw: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const push = (path: string, message: string): void => {
    issues.push({ path, message });
  };

  if (!isObject(raw)) {
    return { ok: false, issues: [{ path: '', message: 'workflow must be a YAML object' }], warnings: [] };
  }

  const name = raw['name'];
  if (typeof name !== 'string' || !name.trim()) {
    push('name', "'name' is required and must be a non-empty string");
  } else if (!KEBAB_RE.test(name)) {
    push('name', `'name' must be kebab-case (got '${name}')`);
  }

  const description = raw['description'];
  if (typeof description !== 'string' || !description.trim()) {
    push('description', "'description' is required and must be a non-empty string");
  }

  const provider = raw['provider'];
  if (provider !== undefined && (typeof provider !== 'string' || !provider.trim())) {
    push('provider', "'provider' must be a non-empty string");
  } else if (typeof provider === 'string' && provider.trim()) {
    // Phase 2 (RFC #2161 · 2026-05-10) — registry-aware provider check.
    // 'auto' bypasses; otherwise require a known provider id or alias
    // (e.g. 'claude' → anthropic). Catches typos like 'antrhopic' or
    // unsupported names ('mistral') that previously slipped through and
    // caused silent fallback at runtime (RFC §3 F8 root cause).
    const trimmed = provider.trim();
    if (trimmed.toLowerCase() !== 'auto') {
      const normalized = normalizeProviderId(trimmed);
      if (!normalized) {
        push(
          'provider',
          `'provider' '${trimmed}' is not a known provider id or alias `
          + '(valid: anthropic / openai / grok / gemini / local / auto · '
          + "aliases: 'claude' → anthropic, 'codex' → openai, etc.)",
        );
      }
    }
  }

  const model = raw['model'];
  if (model !== undefined && typeof model !== 'string') {
    push('model', "'model' must be a string");
  }

  const interactive = raw['interactive'];
  if (interactive !== undefined && typeof interactive !== 'boolean') {
    push('interactive', "'interactive' must be a boolean");
  }
  const concurrency = raw['concurrency'];
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > 8)) {
    push('concurrency', "'concurrency' must be an integer from 1 to 8");
  }

  // M4-3.2 (FU8 PR #8 · 2026-05-12) — optional provenance metadata
  // stamped on intake-generated workflows. Validated softly: when
  // present `_meta` must be an object; recognised fields must
  // type-check; unknown fields tolerated (forward-compatible so a
  // future PR can add e.g. `originatingGoalSlug` without breaking
  // pre-PR workflows). `missionId` URN format guarded so callers
  // can rely on the `mission:` prefix for KGS cross-link
  // (BACKLOG · per FU8 feature doc §5).
  const meta = raw['_meta'];
  if (meta !== undefined) {
    if (!isObject(meta)) {
      push('_meta', "'_meta' must be an object when present");
    } else {
      const missionId = meta['missionId'];
      if (missionId !== undefined) {
        if (typeof missionId !== 'string' || !missionId.trim()) {
          push('_meta.missionId', "'_meta.missionId' must be a non-empty string");
        } else if (!missionId.startsWith('mission:')) {
          push(
            '_meta.missionId',
            `'_meta.missionId' must be in 'mission:<slug>' URN format (got '${missionId}')`,
          );
        }
      }
      const intakeId = meta['intakeId'];
      if (intakeId !== undefined && (typeof intakeId !== 'string' || !intakeId.trim())) {
        push('_meta.intakeId', "'_meta.intakeId' must be a non-empty string");
      }
      const sourceTaskKey = meta['sourceTaskKey'];
      if (sourceTaskKey !== undefined && (typeof sourceTaskKey !== 'string' || !sourceTaskKey.trim())) {
        push('_meta.sourceTaskKey', "'_meta.sourceTaskKey' must be a non-empty string");
      }
    }
  }

  const rawNodes = raw['nodes'];
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    push('nodes', "'nodes' is required and must be a non-empty array");
    return { ok: false, issues, warnings: [] };
  }

  const seenIds = new Set<string>();
  const nodes: DagNode[] = [];

  for (let i = 0; i < rawNodes.length; i++) {
    const node = rawNodes[i];
    const path = `nodes[${i}]`;
    if (!isObject(node)) {
      push(path, 'each node must be an object');
      continue;
    }

    const id = node['id'];
    if (typeof id !== 'string' || !id.trim()) {
      push(`${path}.id`, "'id' is required and must be a non-empty string");
    } else if (!KEBAB_RE.test(id)) {
      push(`${path}.id`, `'id' must be kebab-case (got '${id}')`);
    } else if (seenIds.has(id)) {
      push(`${path}.id`, `duplicate node id '${id}'`);
    } else {
      seenIds.add(id);
    }

    // Common fields validation
    const dependsOn = node['depends_on'];
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn) || !dependsOn.every(s => typeof s === 'string')) {
        push(`${path}.depends_on`, "'depends_on' must be an array of strings");
      }
    }

    const when = node['when'];
    if (when !== undefined && typeof when !== 'string') {
      push(`${path}.when`, "'when' must be a string expression");
    }

    if (node['on_error'] !== undefined && (typeof node['on_error'] !== 'string' || !node['on_error'].trim())) {
      push(`${path}.on_error`, "'on_error' must be a non-empty node id");
    }

    const triggerRule = node['trigger_rule'];
    if (triggerRule !== undefined) {
      if (typeof triggerRule !== 'string' || !TRIGGER_RULES.includes(triggerRule as TriggerRule)) {
        push(`${path}.trigger_rule`, `'trigger_rule' must be one of: ${TRIGGER_RULES.join(', ')}`);
      }
    }

    for (const arrayField of ['allowed_tools', 'denied_tools'] as const) {
      const v = node[arrayField];
      if (v !== undefined) {
        if (!Array.isArray(v) || !v.every(s => typeof s === 'string')) {
          push(`${path}.${arrayField}`, `'${arrayField}' must be an array of strings`);
        }
      }
    }

    if (node['idle_timeout'] !== undefined && typeof node['idle_timeout'] !== 'number') {
      push(`${path}.idle_timeout`, "'idle_timeout' must be a number (ms)");
    }

    if (node['output_format'] !== undefined && !isObject(node['output_format'])) {
      push(`${path}.output_format`, "'output_format' must be an object (JSON schema)");
    }

    if (node['judgment'] !== undefined) {
      if (typeof node['judgment'] !== 'string' || !node['judgment'].trim()) {
        push(`${path}.judgment`, "'judgment' must be a non-empty string");
      }
      if (node['cadence'] !== undefined
        && node['cadence'] !== 'once'
        && node['cadence'] !== 'always'
        && node['cadence'] !== 'on-signal'
        && node['cadence'] !== 'scheduled') {
        push(`${path}.cadence`, "'cadence' must be one of: once, always, on-signal, scheduled");
      }
      for (const arrayField of ['observes', 'vocabulary', 'executions'] as const) {
        const value = node[arrayField];
        if (value !== undefined && (!Array.isArray(value) || !value.every(item => typeof item === 'string'))) {
          push(`${path}.${arrayField}`, `'${arrayField}' must be an array of strings`);
        }
      }
    }

    // RFC #2161 Phase 3 — `requires` shape check. Field-level
    // validation only; the executor's gate decides whether the resolved
    // (provider, model) actually satisfies the clauses. Invalid keys
    // become a hard error so workflow authors don't ship a typo
    // (`reasoing: 'high'`) that silently never gates.
    const requires = node['requires'];
    if (requires !== undefined) {
      if (!isObject(requires)) {
        push(`${path}.requires`, "'requires' must be an object");
      } else {
        for (const [k, v] of Object.entries(requires)) {
          if (CAP_FLAG_KEYS.has(k)) {
            if (typeof v !== 'boolean') {
              push(`${path}.requires.${k}`, `'${k}' must be a boolean`);
            }
          } else if (k === 'vision') {
            if (v !== 'images' && v !== 'video' && v !== 'pdf' && v !== 'any') {
              push(`${path}.requires.vision`, "'vision' must be one of: images | video | pdf | any");
            }
          } else if (k === 'reasoning') {
            if (v !== 'low' && v !== 'medium' && v !== 'high') {
              push(`${path}.requires.reasoning`, "'reasoning' must be one of: low | medium | high");
            }
          } else if (k === 'toolCalling') {
            const allowed = ['native-anthropic', 'native-openai', 'native-gemini', 'any'];
            if (typeof v !== 'string' || !allowed.includes(v)) {
              push(`${path}.requires.toolCalling`, `'toolCalling' must be one of: ${allowed.join(' | ')}`);
            }
          } else if (k === 'minContextSize') {
            if (typeof v !== 'number' || v < 0) {
              push(`${path}.requires.minContextSize`, "'minContextSize' must be a non-negative number");
            }
          } else {
            push(`${path}.requires.${k}`, `unknown 'requires' key '${k}'`);
          }
        }
      }
    }

    // Plugin kind — `{ id, kind: '<plugin>:<kind>', inputs, depends_on? }`.
    // Checked before the core variant keys so a registered kind is not
    // reported as "must declare exactly one of" the body-key core shapes.
    if (node['kind'] !== undefined) {
      const kind = node['kind'];
      if (typeof kind !== 'string' || !kind.trim()) {
        push(`${path}.kind`, "'kind' must be a non-empty string");
        continue;
      }
      if (kind === 'subworkflow') {
        if (typeof node['workflow'] !== 'string' || !KEBAB_RE.test(node['workflow'])) {
          push(`${path}.workflow`, "'workflow' must be a kebab-case workflow name");
        }
        if (!isObject(node['inputs']) || Object.values(node['inputs']).some(v => typeof v !== 'string')) {
          push(`${path}.inputs`, "'inputs' must be an object of string expressions");
        }
        const alsoCore = WORKFLOW_NODE_VARIANT_KEYS.filter(k => node[k] !== undefined);
        if (alsoCore.length) push(path, `node declares kind 'subworkflow' and a core variant (${alsoCore.join(', ')}) — pick one`);
        if (issues.every(iss => !iss.path.startsWith(path))) nodes.push(node as unknown as SubworkflowNode);
        continue;
      }
      const alsoCore = WORKFLOW_NODE_VARIANT_KEYS.filter(k => k !== 'subworkflow' && node[k] !== undefined);
      if (alsoCore.length > 0) {
        push(path, `node declares kind '${kind}' and a core variant (${alsoCore.join(', ')}) — pick one`);
        continue;
      }
      const entry = getNodeKind('workflow', kind);
      if (!entry || entry.core || !entry.run) {
        push(path, `unknown node kind '${kind}'`);
        continue;
      }
      const inputs = node['inputs'];
      if (inputs !== undefined && !isObject(inputs)) {
        push(`${path}.inputs`, "'inputs' must be an object");
        continue;
      }
      const provided = isObject(inputs) ? inputs : {};
      const required = Array.isArray(entry.schema?.['required']) ? entry.schema['required'] : [];
      for (const name of required) {
        if (typeof name === 'string' && (provided[name] === undefined || provided[name] === null)) {
          push(`${path}.inputs.${name}`, `missing required input '${name}'`);
        }
      }
      if (issues.every(iss => !iss.path.startsWith(path))) {
        nodes.push({ ...(node as unknown as PluginKindNode), inputs: { ...provided } });
      }
      continue;
    }

    if (node['subworkflow'] !== undefined) {
      push(`${path}.subworkflow`, "subworkflow nodes require { kind: subworkflow, workflow, inputs }");
      continue;
    }

    // Variant detection — exactly one of the variant keys must be
    // present. Mirrors Archon dag-node.ts:7 superRefine pattern.
    // (Node-catalog N1.1/1.2/1.3 — if/switch/iteration. N2.1/2.2 —
    //  classify/extract · LLM-driven · 2026-05-11)
    const variantKeys = WORKFLOW_NODE_VARIANT_KEYS.filter(k => k !== 'subworkflow');
    const presentKeys = variantKeys.filter(k => node[k] !== undefined);
    if (presentKeys.length === 0) {
      push(path, `node must declare exactly one of: ${variantKeys.join(', ')}`);
      continue;
    }
    if (presentKeys.length > 1) {
      push(path, `node declares multiple variants (${presentKeys.join(', ')}) — pick one`);
      continue;
    }

    const variant = presentKeys[0];
    const variantValue = node[variant];

    // Per-variant body shape checks
    if (variant === 'prompt' || variant === 'bash') {
      if (typeof variantValue !== 'string' || !variantValue.trim()) {
        push(`${path}.${variant}`, `'${variant}' body must be a non-empty string`);
      }
    } else if (variant === 'skill') {
      if (typeof variantValue !== 'string' || !variantValue.trim()) {
        push(`${path}.skill`, "'skill' must be a skill slug (string)");
      }
      const args = node['arguments'];
      if (args !== undefined && typeof args !== 'string') {
        push(`${path}.arguments`, "'arguments' must be a string");
      }
    } else if (variant === 'cft') {
      if (typeof variantValue !== 'string' || !variantValue.trim()) {
        push(`${path}.cft`, "'cft' must be a CFT method name (string)");
      }
      const cfg = node['config'];
      if (cfg !== undefined && !isObject(cfg)) {
        push(`${path}.config`, "'config' must be an object");
      }
    } else if (variant === 'if') {
      // Node-catalog N1.1 (2026-05-11) — boolean branch.
      if (!isObject(variantValue)) {
        push(`${path}.if`, "'if' must be an object with at least a 'condition' field");
      } else {
        if (typeof variantValue['condition'] !== 'string' || !variantValue['condition'].trim()) {
          push(`${path}.if.condition`, "'if.condition' is required and must be a non-empty string");
        }
      }
    } else if (variant === 'classify') {
      // Node-catalog N2.1 (2026-05-11) — LLM-driven classification.
      if (!isObject(variantValue)) {
        push(`${path}.classify`, "'classify' must be an object with 'input' + 'classes' fields");
      } else {
        if (typeof variantValue['input'] !== 'string' || !variantValue['input'].trim()) {
          push(`${path}.classify.input`, "'classify.input' is required and must be a non-empty string expression");
        }
        const classes = variantValue['classes'];
        if (!Array.isArray(classes) || classes.length === 0) {
          push(`${path}.classify.classes`, "'classify.classes' is required and must be a non-empty array of strings");
        } else if (!classes.every((c) => typeof c === 'string' && c.length > 0)) {
          push(`${path}.classify.classes`, "'classify.classes' entries must be non-empty strings");
        }
        const hint = variantValue['hint'];
        if (hint !== undefined && typeof hint !== 'string') {
          push(`${path}.classify.hint`, "'classify.hint' must be a string");
        }
        // Node-catalog v2 (2026-05-11) — retry/backoff
        const retries = variantValue['retries'];
        if (retries !== undefined && (typeof retries !== 'number' || retries < 0 || !Number.isInteger(retries))) {
          push(`${path}.classify.retries`, "'classify.retries' must be a non-negative integer");
        }
        const retryDelayMs = variantValue['retryDelayMs'];
        if (retryDelayMs !== undefined && (typeof retryDelayMs !== 'number' || retryDelayMs < 0)) {
          push(`${path}.classify.retryDelayMs`, "'classify.retryDelayMs' must be a non-negative number (ms)");
        }
      }
    } else if (variant === 'extract') {
      // Node-catalog N2.2 (2026-05-11) — LLM-driven structured extraction.
      if (!isObject(variantValue)) {
        push(`${path}.extract`, "'extract' must be an object with 'input' + 'schema' fields");
      } else {
        if (typeof variantValue['input'] !== 'string' || !variantValue['input'].trim()) {
          push(`${path}.extract.input`, "'extract.input' is required and must be a non-empty string expression");
        }
        const schema = variantValue['schema'];
        if (!isObject(schema)) {
          push(`${path}.extract.schema`, "'extract.schema' is required and must be an object (field → description string)");
        } else {
          const entries = Object.entries(schema);
          if (entries.length === 0) {
            push(`${path}.extract.schema`, "'extract.schema' must have at least one field");
          } else {
            for (const [k, v] of entries) {
              if (typeof v !== 'string' || !v.trim()) {
                push(`${path}.extract.schema.${k}`, `'extract.schema.${k}' must be a non-empty description string`);
              }
            }
          }
        }
        const hint = variantValue['hint'];
        if (hint !== undefined && typeof hint !== 'string') {
          push(`${path}.extract.hint`, "'extract.hint' must be a string");
        }
        // Node-catalog v2 (2026-05-11) — retry/backoff
        const retries = variantValue['retries'];
        if (retries !== undefined && (typeof retries !== 'number' || retries < 0 || !Number.isInteger(retries))) {
          push(`${path}.extract.retries`, "'extract.retries' must be a non-negative integer");
        }
        const retryDelayMs = variantValue['retryDelayMs'];
        if (retryDelayMs !== undefined && (typeof retryDelayMs !== 'number' || retryDelayMs < 0)) {
          push(`${path}.extract.retryDelayMs`, "'extract.retryDelayMs' must be a non-negative number (ms)");
        }
      }
    } else if (variant === 'task') {
      // RFC external tasks §A8 (X5b) — TOX task with its external origin.
      if (!isObject(variantValue)) {
        push(`${path}.task`, "'task' must be an object with 'title' and 'external'");
      } else {
        if (typeof variantValue['title'] !== 'string' || !variantValue['title'].trim()) {
          push(`${path}.task.title`, "'task.title' is required and must be a non-empty string");
        }
        for (const field of ['description', 'priority', 'eventId'] as const) {
          if (variantValue[field] !== undefined && typeof variantValue[field] !== 'string') {
            push(`${path}.task.${field}`, `'task.${field}' must be a string`);
          }
        }
        const priority = variantValue['priority'];
        if (typeof priority === 'string' && !priority.includes('$') && !['low', 'medium', 'high'].includes(priority)) {
          push(`${path}.task.priority`, "'task.priority' must be low | medium | high (urgent needs acceptance checks)");
        }
        const ext = variantValue['external'];
        if (!isObject(ext)) {
          push(`${path}.task.external`, "'task.external' is required — { provider, ref } of where the task came from");
        } else {
          for (const field of ['provider', 'ref'] as const) {
            if (typeof ext[field] !== 'string' || !ext[field].trim()) {
              push(`${path}.task.external.${field}`, `'task.external.${field}' is required and must be a non-empty string`);
            }
          }
          const provider = ext['provider'];
          if (typeof provider === 'string' && !provider.includes('$') && !['asana', 'linear', 'telegram', 'github', 'other'].includes(provider)) {
            push(`${path}.task.external.provider`, "'task.external.provider' must be asana | linear | telegram | github | other");
          }
          for (const field of ['url', 'project', 'team', 'assignee'] as const) {
            if (ext[field] !== undefined && typeof ext[field] !== 'string') {
              push(`${path}.task.external.${field}`, `'task.external.${field}' must be a string`);
            }
          }
        }
      }
    } else if (variant === 'set') {
      // Node-catalog N3.1 (2026-05-11) — Set / Variable Assigner.
      if (!isObject(variantValue)) {
        push(`${path}.set`, "'set' must be an object with a 'fields' map");
      } else {
        const fields = variantValue['fields'];
        if (!isObject(fields)) {
          push(`${path}.set.fields`, "'set.fields' is required and must be an object (field name → expression string)");
        } else {
          const entries = Object.entries(fields);
          if (entries.length === 0) {
            push(`${path}.set.fields`, "'set.fields' must have at least one entry");
          } else {
            for (const [k, v] of entries) {
              if (typeof v !== 'string') {
                push(`${path}.set.fields.${k}`, `'set.fields.${k}' must be a string expression`);
              }
            }
          }
        }
      }
    } else if (variant === 'scheduleTrigger') {
      // Node-catalog N4.1 (2026-05-11) — Schedule trigger (schema-only v1).
      if (!isObject(variantValue)) {
        push(`${path}.scheduleTrigger`, "'scheduleTrigger' must be an object with 'type' + ('cron' | 'interval')");
      } else {
        const type = variantValue['type'];
        if (type !== 'cron' && type !== 'interval') {
          push(`${path}.scheduleTrigger.type`, "'scheduleTrigger.type' must be 'cron' or 'interval'");
        }
        if (type === 'cron') {
          if (typeof variantValue['cron'] !== 'string' || !variantValue['cron'].trim()) {
            push(`${path}.scheduleTrigger.cron`, "'scheduleTrigger.cron' is required when type='cron'");
          }
        }
        if (type === 'interval') {
          if (typeof variantValue['interval'] !== 'number' || variantValue['interval'] <= 0) {
            push(`${path}.scheduleTrigger.interval`, "'scheduleTrigger.interval' must be a positive number (ms) when type='interval'");
          }
        }
        // Surface-unification §B1 (2026-05-11) — optional author-facing
        // fields. v1 = schema validation only; daemon scheduler picks
        // them up in a follow-up cron-source migration.
        if (variantValue['timezone'] !== undefined && typeof variantValue['timezone'] !== 'string') {
          push(`${path}.scheduleTrigger.timezone`, "'scheduleTrigger.timezone' must be a string (IANA tz, e.g. 'Asia/Seoul')");
        }
        if (
          variantValue['jitter_seconds'] !== undefined
          && (typeof variantValue['jitter_seconds'] !== 'number' || variantValue['jitter_seconds'] < 0)
        ) {
          push(`${path}.scheduleTrigger.jitter_seconds`, "'scheduleTrigger.jitter_seconds' must be a non-negative number");
        }
        if (
          variantValue['max_runs'] !== undefined
          && (typeof variantValue['max_runs'] !== 'number' || variantValue['max_runs'] <= 0 || !Number.isInteger(variantValue['max_runs']))
        ) {
          push(`${path}.scheduleTrigger.max_runs`, "'scheduleTrigger.max_runs' must be a positive integer");
        }
        if (variantValue['enabled'] !== undefined && typeof variantValue['enabled'] !== 'boolean') {
          push(`${path}.scheduleTrigger.enabled`, "'scheduleTrigger.enabled' must be a boolean");
        }
      }
    } else if (variant === 'webhookTrigger') {
      // Node-catalog N4.2 (2026-05-11) — Webhook trigger (schema-only v1).
      if (!isObject(variantValue)) {
        push(`${path}.webhookTrigger`, "'webhookTrigger' must be an object with 'method' + 'path'");
      } else {
        const wtMethod = variantValue['method'];
        const wtValidMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        if (typeof wtMethod !== 'string' || !wtValidMethods.includes(wtMethod)) {
          push(`${path}.webhookTrigger.method`, `'webhookTrigger.method' must be one of: ${wtValidMethods.join(' | ')}`);
        }
        const wtPath = variantValue['path'];
        if (typeof wtPath !== 'string' || !wtPath.startsWith('/')) {
          push(`${path}.webhookTrigger.path`, "'webhookTrigger.path' is required and must start with '/'");
        }
        const wtAuth = variantValue['auth'];
        if (wtAuth !== undefined) {
          if (!isObject(wtAuth)) {
            push(`${path}.webhookTrigger.auth`, "'webhookTrigger.auth' must be an object");
          } else if (wtAuth['type'] === 'bearer') {
            if (typeof wtAuth['token'] !== 'string') {
              push(`${path}.webhookTrigger.auth`, "'webhookTrigger.auth' (bearer) requires 'token' string");
            }
          } else if (wtAuth['type'] === 'basic') {
            if (typeof wtAuth['username'] !== 'string' || typeof wtAuth['password'] !== 'string') {
              push(`${path}.webhookTrigger.auth`, "'webhookTrigger.auth' (basic) requires 'username' + 'password' strings");
            }
          } else if (wtAuth['type'] === 'hmac') {
            if (typeof wtAuth['header'] !== 'string' || !wtAuth['header'].trim()
              || typeof wtAuth['secretRef'] !== 'string' || !wtAuth['secretRef'].trim()) {
              push(`${path}.webhookTrigger.auth`, "'webhookTrigger.auth' (hmac) requires 'header' + 'secretRef' strings");
            }
            if (wtAuth['algorithm'] !== undefined && wtAuth['algorithm'] !== 'sha256' && wtAuth['algorithm'] !== 'sha1') {
              push(`${path}.webhookTrigger.auth.algorithm`, "'webhookTrigger.auth.algorithm' must be 'sha256' or 'sha1'");
            }
            if (wtAuth['encoding'] !== undefined && wtAuth['encoding'] !== 'hex' && wtAuth['encoding'] !== 'base64') {
              push(`${path}.webhookTrigger.auth.encoding`, "'webhookTrigger.auth.encoding' must be 'hex' or 'base64'");
            }
            if (wtAuth['prefix'] !== undefined && typeof wtAuth['prefix'] !== 'string') {
              push(`${path}.webhookTrigger.auth.prefix`, "'webhookTrigger.auth.prefix' must be a string");
            }
          } else {
            push(`${path}.webhookTrigger.auth.type`, "'webhookTrigger.auth.type' must be 'bearer', 'basic' or 'hmac'");
          }
        }
      }
    } else if (variant === 'discordTrigger') {
      // Node-catalog N4.4 (2026-05-11 · scheduler-retirement R6) — Discord trigger.
      if (!isObject(variantValue)) {
        push(`${path}.discordTrigger`, "'discordTrigger' must be an object with at least 'kind'");
      } else {
        const dtKind = variantValue['kind'];
        const dtValidKinds = ['message', 'mention', 'reaction'];
        if (typeof dtKind !== 'string' || !dtValidKinds.includes(dtKind)) {
          push(`${path}.discordTrigger.kind`, `'discordTrigger.kind' must be one of: ${dtValidKinds.join(' | ')}`);
        }
        for (const k of ['channel', 'user', 'pattern'] as const) {
          const v = variantValue[k];
          if (v !== undefined && typeof v !== 'string') {
            push(`${path}.discordTrigger.${k}`, `'discordTrigger.${k}' must be a string`);
          }
        }
      }
    } else if (variant === 'telegramTrigger') {
      // Node-catalog N4.5 (2026-05-11 · scheduler-retirement R7) — Telegram trigger.
      if (!isObject(variantValue)) {
        push(`${path}.telegramTrigger`, "'telegramTrigger' must be an object with at least 'kind'");
      } else {
        const ttKind = variantValue['kind'];
        const ttValidKinds = ['message', 'command', 'callback_query'];
        if (typeof ttKind !== 'string' || !ttValidKinds.includes(ttKind)) {
          push(`${path}.telegramTrigger.kind`, `'telegramTrigger.kind' must be one of: ${ttValidKinds.join(' | ')}`);
        }
        for (const k of ['chat', 'user', 'command', 'pattern'] as const) {
          const v = variantValue[k];
          if (v !== undefined && typeof v !== 'string') {
            push(`${path}.telegramTrigger.${k}`, `'telegramTrigger.${k}' must be a string`);
          }
        }
        if (ttKind === 'command' && (typeof variantValue['command'] !== 'string' || !variantValue['command'])) {
          push(`${path}.telegramTrigger.command`, "'telegramTrigger.command' is required when kind='command'");
        }
      }
    } else if (variant === 'manualTrigger') {
      // Surface-unification §B6 (2026-05-11 · n8n ManualTrigger port).
      // Minimal payload — `description` is the only optional field. The
      // `maxNodes: 1` invariant is enforced after the per-node loop.
      if (!isObject(variantValue)) {
        push(`${path}.manualTrigger`, "'manualTrigger' must be an object (description optional)");
      } else if (variantValue['description'] !== undefined && typeof variantValue['description'] !== 'string') {
        push(`${path}.manualTrigger.description`, "'manualTrigger.description' must be a string");
      }
    } else if (variant === 'chatTrigger') {
      // Surface-unification §B7 (2026-05-11 · n8n ChatTrigger v1 port).
      // Webhook-mode minimal: path required, auth bearer optional,
      // sessionMode + streaming flags optional.
      if (!isObject(variantValue)) {
        push(`${path}.chatTrigger`, "'chatTrigger' must be an object with at least 'path'");
      } else {
        const ctPath = variantValue['path'];
        if (typeof ctPath !== 'string' || !ctPath.startsWith('/')) {
          push(`${path}.chatTrigger.path`, "'chatTrigger.path' is required and must start with '/'");
        }
        const ctAuth = variantValue['auth'];
        if (ctAuth !== undefined) {
          if (!isObject(ctAuth)) {
            push(`${path}.chatTrigger.auth`, "'chatTrigger.auth' must be an object");
          } else if (ctAuth['type'] !== 'bearer') {
            push(`${path}.chatTrigger.auth.type`, "'chatTrigger.auth.type' must be 'bearer' (v1)");
          } else if (typeof ctAuth['token'] !== 'string') {
            push(`${path}.chatTrigger.auth`, "'chatTrigger.auth' (bearer) requires 'token' string");
          }
        }
        const ctSession = variantValue['sessionMode'];
        if (ctSession !== undefined && ctSession !== 'stateless' && ctSession !== 'per-session') {
          push(`${path}.chatTrigger.sessionMode`, "'chatTrigger.sessionMode' must be 'stateless' or 'per-session'");
        }
        if (variantValue['streaming'] !== undefined && typeof variantValue['streaming'] !== 'boolean') {
          push(`${path}.chatTrigger.streaming`, "'chatTrigger.streaming' must be a boolean");
        }
        // V2.2-2 (2026-05-12) — hostedUi opt-in. enabled is required
        // when the field is present; bearer is optional string.
        const ctHosted = variantValue['hostedUi'];
        if (ctHosted !== undefined) {
          if (!isObject(ctHosted)) {
            push(`${path}.chatTrigger.hostedUi`, "'chatTrigger.hostedUi' must be an object");
          } else {
            if (typeof ctHosted['enabled'] !== 'boolean') {
              push(`${path}.chatTrigger.hostedUi.enabled`, "'chatTrigger.hostedUi.enabled' must be a boolean");
            }
            if (ctHosted['bearer'] !== undefined && typeof ctHosted['bearer'] !== 'string') {
              push(`${path}.chatTrigger.hostedUi.bearer`, "'chatTrigger.hostedUi.bearer' must be a string");
            }
          }
        }
      }
    } else if (variant === 'http') {
      // Node-catalog N4.3 (2026-05-11) — HTTP request.
      if (!isObject(variantValue)) {
        push(`${path}.http`, "'http' must be an object with at least 'method' + 'url'");
      } else {
        const method = variantValue['method'];
        const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
        if (typeof method !== 'string' || !validMethods.includes(method)) {
          push(`${path}.http.method`, `'http.method' must be one of: ${validMethods.join(' | ')}`);
        }
        if (typeof variantValue['url'] !== 'string' || !variantValue['url'].trim()) {
          push(`${path}.http.url`, "'http.url' is required and must be a non-empty string");
        }
        const headers = variantValue['headers'];
        if (headers !== undefined) {
          if (!isObject(headers)) {
            push(`${path}.http.headers`, "'http.headers' must be an object (header name → value)");
          } else {
            for (const [k, v] of Object.entries(headers)) {
              if (typeof v !== 'string') {
                push(`${path}.http.headers.${k}`, `'http.headers.${k}' must be a string`);
              }
            }
          }
        }
        if (variantValue['body'] !== undefined && typeof variantValue['body'] !== 'string') {
          push(`${path}.http.body`, "'http.body' must be a string");
        }
        const auth = variantValue['auth'];
        if (auth !== undefined) {
          if (!isObject(auth)) {
            push(`${path}.http.auth`, "'http.auth' must be an object");
          } else if (auth['type'] === 'basic') {
            if (typeof auth['username'] !== 'string' || typeof auth['password'] !== 'string') {
              push(`${path}.http.auth`, "'http.auth' (basic) requires 'username' + 'password' strings");
            }
          } else if (auth['type'] === 'bearer') {
            if (typeof auth['token'] !== 'string') {
              push(`${path}.http.auth`, "'http.auth' (bearer) requires 'token' string");
            }
          } else {
            push(`${path}.http.auth.type`, "'http.auth.type' must be 'basic' or 'bearer'");
          }
        }
        if (variantValue['timeout'] !== undefined && typeof variantValue['timeout'] !== 'number') {
          push(`${path}.http.timeout`, "'http.timeout' must be a number (ms)");
        }
      }
    } else if (variant === 'showroom') {
      // W6 Z8 — multi-model cascade as a workflow node.
      if (!isObject(variantValue)) {
        push(`${path}.showroom`, "'showroom' must be an object with 'lanes' + 'aggregator' fields");
      } else {
        const lanes = variantValue['lanes'];
        if (!Array.isArray(lanes) || lanes.length === 0) {
          push(`${path}.showroom.lanes`, "'showroom.lanes' is required and must be a non-empty array");
        } else {
          const validRoles = ['plan', 'build', 'review', 'reflect'];
          for (let li = 0; li < lanes.length; li++) {
            const lane = lanes[li];
            const lp = `${path}.showroom.lanes[${li}]`;
            if (!isObject(lane)) {
              push(lp, 'each lane must be an object');
              continue;
            }
            if (typeof lane['role'] !== 'string' || !validRoles.includes(lane['role'] as string)) {
              push(`${lp}.role`, `'role' must be one of: ${validRoles.join(' | ')}`);
            }
            if (typeof lane['model'] !== 'string' || !lane['model'].trim()) {
              push(`${lp}.model`, "'model' is required and must be a non-empty string");
            }
            if (typeof lane['prompt'] !== 'string' || !lane['prompt'].trim()) {
              push(`${lp}.prompt`, "'prompt' is required and must be a non-empty string");
            }
          }
        }
        const aggregator = variantValue['aggregator'];
        const validAggregators = ['majority', 'vote_with_reasoning', 'first-finalize', 'unanimous-or-escalate'];
        if (typeof aggregator !== 'string' || !validAggregators.includes(aggregator)) {
          push(`${path}.showroom.aggregator`, `'aggregator' must be one of: ${validAggregators.join(' | ')}`);
        }
        const mode = variantValue['mode'];
        if (mode !== undefined && mode !== 'sequential' && mode !== 'parallel') {
          push(`${path}.showroom.mode`, "'mode' must be 'sequential' or 'parallel'");
        }
      }
    } else if (variant === 'template') {
      // Node-catalog N3.3 (2026-05-11) — handlebars-lite template.
      if (!isObject(variantValue)) {
        push(`${path}.template`, "'template' must be an object with a 'template' string field");
      } else {
        if (typeof variantValue['template'] !== 'string' || !variantValue['template'].trim()) {
          push(`${path}.template.template`, "'template.template' is required and must be a non-empty string");
        }
      }
    } else if (variant === 'filter') {
      // Node-catalog N3.2 (2026-05-11) — array filter.
      if (!isObject(variantValue)) {
        push(`${path}.filter`, "'filter' must be an object with 'items' + 'condition' fields");
      } else {
        if (typeof variantValue['items'] !== 'string' || !variantValue['items'].trim()) {
          push(`${path}.filter.items`, "'filter.items' is required and must be a non-empty string expression");
        }
        if (typeof variantValue['condition'] !== 'string' || !variantValue['condition'].trim()) {
          push(`${path}.filter.condition`, "'filter.condition' is required and must be a non-empty string");
        }
      }
    } else if (variant === 'iteration') {
      // Node-catalog N1.3 (2026-05-11) — sequential loop.
      if (!isObject(variantValue)) {
        push(`${path}.iteration`, "'iteration' must be an object with 'items' + 'body' fields");
      } else {
        if (typeof variantValue['items'] !== 'string' || !variantValue['items'].trim()) {
          push(`${path}.iteration.items`, "'iteration.items' is required and must be a non-empty string expression");
        }
        if (typeof variantValue['body'] !== 'string' || !variantValue['body'].trim()) {
          push(`${path}.iteration.body`, "'iteration.body' is required and must be a non-empty bash string");
        }
      }
    } else if (variant === 'switch') {
      // Node-catalog N1.2 (2026-05-11) — N-way branch.
      if (!isObject(variantValue)) {
        push(`${path}.switch`, "'switch' must be an object with 'value' + 'cases' fields");
      } else {
        if (typeof variantValue['value'] !== 'string' || !variantValue['value'].trim()) {
          push(`${path}.switch.value`, "'switch.value' is required and must be a non-empty string");
        }
        const cases = variantValue['cases'];
        if (!Array.isArray(cases) || cases.length === 0) {
          push(`${path}.switch.cases`, "'switch.cases' is required and must be a non-empty array of strings");
        } else if (!cases.every((c) => typeof c === 'string' && c.length > 0)) {
          push(`${path}.switch.cases`, "'switch.cases' entries must be non-empty strings");
        } else if (cases.includes('default')) {
          push(`${path}.switch.cases`, "'switch.cases' cannot include 'default' (reserved fallthrough value)");
        }
      }
    } else if (variant === 'approval') {
      if (!isObject(variantValue)) {
        push(`${path}.approval`, "'approval' must be an object with at least a 'message' field");
      } else {
        if (typeof variantValue['message'] !== 'string' || !variantValue['message'].trim()) {
          push(`${path}.approval.message`, "'approval.message' is required and must be a non-empty string");
        }
        const cr = variantValue['capture_response'];
        if (cr !== undefined && typeof cr !== 'boolean') {
          push(`${path}.approval.capture_response`, "'capture_response' must be a boolean");
        }
        // BACKLOG #4 (2026-05-11) — `delivery` filter; one of the
        // HitlDelivery channel ids. Restricts which HITL surfaces the
        // Nexus runtime races. Omitted = race all registered channels.
        const dlv = variantValue['delivery'];
        if (dlv !== undefined) {
          const allowed = ['modal', 'terminal', 'telegram', 'discord', 'pushcut', 'all'];
          if (typeof dlv !== 'string' || !allowed.includes(dlv)) {
            push(
              `${path}.approval.delivery`,
              `'delivery' must be one of: ${allowed.join(' | ')}`,
            );
          }
        }
      }
    }

    // If we reach this point and there were no critical issues for
    // this node, narrow the union and push it. We rely on the body
    // shape check above to have surfaced any per-variant issue, then
    // cast — the executor checks ok status before consuming.
    if (issues.every(iss => !iss.path.startsWith(path) || iss.path.endsWith('.depends_on') ||
        iss.path.endsWith('.when') || iss.path.endsWith('.trigger_rule') ||
        iss.path.endsWith('.allowed_tools') || iss.path.endsWith('.denied_tools') ||
        iss.path.endsWith('.idle_timeout') || iss.path.endsWith('.output_format'))) {
      nodes.push(node as unknown as DagNode);
    }
  }

  // Surface-unification §B6 (2026-05-11) — n8n's `maxNodes: 1` rule:
  // a workflow may declare at most one Manual trigger node. The form
  // hides the Manual variant from the palette once one exists, but
  // hand-edited YAML can still violate this — the schema catches it.
  const manualCount = nodes.filter((n) => isObject(n) && (n as Record<string, unknown>)['manualTrigger'] !== undefined).length;
  if (manualCount > 1) {
    issues.push({
      path: 'nodes',
      message: `at most one manualTrigger node is allowed per workflow (found ${manualCount})`,
    });
  }

  // Cross-node: depends_on references must resolve.
  for (const node of nodes) {
    if (node.on_error && !seenIds.has(node.on_error)) {
      issues.push({ path: `nodes.${node.id}.on_error`, message: `unknown on_error target '${node.on_error}'` });
    }
    if (node.depends_on) {
      for (const dep of node.depends_on) {
        if (!seenIds.has(dep)) {
          issues.push({
            path: `nodes.${node.id}.depends_on`,
            message: `unknown dep '${dep}' (no node with that id)`,
          });
        }
        if (dep === node.id) {
          issues.push({
            path: `nodes.${node.id}.depends_on`,
            message: `node cannot depend on itself`,
          });
        }
      }
    }
  }

  if (issues.length === 0) {
    try {
      topoSort(nodes);
    } catch (err) {
      issues.push({ path: 'nodes', message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!resolvingSubworkflowReferences && typeof name === 'string' && nodes.some(isSubworkflowNode)) {
    resolvingSubworkflowReferences = true;
    try {
      const definitions = new Map<string, WorkflowDefinition>();
      const visit = (current: DagNode[], ancestors: string[]): void => {
        for (const node of current) {
          if (!isSubworkflowNode(node)) continue;
          const ref = node.workflow;
          if (ancestors.includes(ref)) {
            push(`nodes.${node.id}.workflow`, `subworkflow cycle: ${[...ancestors, ref].join(' -> ')}`);
            continue;
          }
          if (!definitions.has(ref)) {
            const target = findWorkflow(ref)?.definition;
            if (target) definitions.set(ref, target);
          }
          const target = definitions.get(ref);
          if (target) visit(target.nodes, [...ancestors, ref]);
        }
      };
      visit(nodes, [name]);
    } finally {
      resolvingSubworkflowReferences = false;
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, warnings: [] };
  }

  const workflow: WorkflowDefinition = {
    name: name as string,
    description: description as string,
    nodes,
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof interactive === 'boolean' ? { interactive } : {}),
    ...(typeof concurrency === 'number' ? { concurrency } : {}),
    // M4-3.2 (FU8 PR #8 · 2026-05-12) — surface validated `_meta`
    // on the parsed definition. Pulled through only when the field
    // is a non-null object so consumers can `if (def._meta?.missionId)`
    // without a defensive `typeof` check.
    ...(isObject(meta) ? { _meta: pickWorkflowMeta(meta) } : {}),
  };
  // M4-2 (2026-05-12) — deterministic warnings on schema-valid
  // workflows. Caller can ignore (issues stays empty) or render the
  // warnings panel + apply suggestions.
  return { ok: true, workflow, issues: [], warnings: buildWarnings(workflow) };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** M4-3.2 (FU8 PR #8 · 2026-05-12) — extract the recognised
 *  `_meta` fields from a validated YAML object. Defensive: unknown
 *  keys are dropped so consumers see only the strict
 *  `WorkflowMeta` shape. */
function pickWorkflowMeta(raw: Record<string, unknown>): WorkflowDefinition['_meta'] {
  const out: NonNullable<WorkflowDefinition['_meta']> = {};
  if (typeof raw['missionId'] === 'string' && raw['missionId'].trim()) {
    out.missionId = raw['missionId'];
  }
  if (typeof raw['intakeId'] === 'string' && raw['intakeId'].trim()) {
    out.intakeId = raw['intakeId'];
  }
  if (typeof raw['sourceTaskKey'] === 'string' && raw['sourceTaskKey'].trim()) {
    out.sourceTaskKey = raw['sourceTaskKey'];
  }
  return out;
}

/** Topological sort of the DAG. Returns node IDs in execution order.
 *  Throws on cycle. */
export function topoSort(nodes: readonly DagNode[]): string[] {
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const n of nodes) {
    incoming.set(n.id, new Set());
    outgoing.set(n.id, new Set());
  }
  for (const n of nodes) {
    for (const dep of n.depends_on ?? []) {
      incoming.get(n.id)!.add(dep);
      if (outgoing.has(dep)) outgoing.get(dep)!.add(n.id);
    }
    if (n.on_error) {
      incoming.get(n.on_error)?.add(n.id);
      outgoing.get(n.id)?.add(n.on_error);
    }
  }
  const ready: string[] = [];
  for (const [id, deps] of incoming) {
    if (deps.size === 0) ready.push(id);
  }
  // Stable order: keep the input order among ready nodes
  const inputOrder = new Map(nodes.map((n, i) => [n.id, i] as const));
  ready.sort((a, b) => (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0));

  const result: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(id);
    for (const next of outgoing.get(id) ?? []) {
      incoming.get(next)!.delete(id);
      if (incoming.get(next)!.size === 0) {
        // Insert preserving input order
        const idx = ready.findIndex(r => (inputOrder.get(r) ?? 0) > (inputOrder.get(next) ?? 0));
        if (idx === -1) ready.push(next);
        else ready.splice(idx, 0, next);
      }
    }
  }
  if (result.length !== nodes.length) {
    const remaining = nodes.map(n => n.id).filter(id => !result.includes(id));
    throw new Error(`workflow has a cycle: unresolved nodes [${remaining.join(', ')}]`);
  }
  return result;
}

// Re-export per-variant helpers if callers want a typed narrow.
export const isPromptNode = (n: DagNode): n is PromptNode =>
  typeof (n as PromptNode).prompt === 'string';
export const isBashNode = (n: DagNode): n is BashNode =>
  typeof (n as BashNode).bash === 'string';
export const isSkillNode = (n: DagNode): n is SkillNode =>
  typeof (n as SkillNode).skill === 'string';
export const isCftNode = (n: DagNode): n is CftNode =>
  typeof (n as CftNode).cft === 'string';
export const isApprovalNode = (n: DagNode): n is ApprovalNode =>
  typeof (n as ApprovalNode).approval === 'object' && (n as ApprovalNode).approval !== null;
export const isIfNode = (n: DagNode): n is IfNode =>
  typeof (n as IfNode).if === 'object' && (n as IfNode).if !== null
  && typeof ((n as IfNode).if as { condition?: unknown }).condition === 'string';
export const isSwitchNode = (n: DagNode): n is SwitchNode =>
  typeof (n as SwitchNode).switch === 'object' && (n as SwitchNode).switch !== null
  && typeof ((n as SwitchNode).switch as { value?: unknown }).value === 'string'
  && Array.isArray(((n as SwitchNode).switch as { cases?: unknown }).cases);
export const isIterationNode = (n: DagNode): n is IterationNode =>
  typeof (n as IterationNode).iteration === 'object' && (n as IterationNode).iteration !== null
  && typeof ((n as IterationNode).iteration as { items?: unknown }).items === 'string'
  && typeof ((n as IterationNode).iteration as { body?: unknown }).body === 'string';
export const isClassifyNode = (n: DagNode): n is ClassifyNode =>
  typeof (n as ClassifyNode).classify === 'object' && (n as ClassifyNode).classify !== null
  && typeof ((n as ClassifyNode).classify as { input?: unknown }).input === 'string'
  && Array.isArray(((n as ClassifyNode).classify as { classes?: unknown }).classes);
export const isExtractNode = (n: DagNode): n is ExtractNode =>
  typeof (n as ExtractNode).extract === 'object' && (n as ExtractNode).extract !== null
  && typeof ((n as ExtractNode).extract as { input?: unknown }).input === 'string'
  && typeof ((n as ExtractNode).extract as { schema?: unknown }).schema === 'object';
export const isSetNode = (n: DagNode): n is SetNode =>
  typeof (n as SetNode).set === 'object' && (n as SetNode).set !== null
  && typeof ((n as SetNode).set as { fields?: unknown }).fields === 'object';
export const isFilterNode = (n: DagNode): n is FilterNode =>
  typeof (n as FilterNode).filter === 'object' && (n as FilterNode).filter !== null
  && typeof ((n as FilterNode).filter as { items?: unknown }).items === 'string'
  && typeof ((n as FilterNode).filter as { condition?: unknown }).condition === 'string';
export const isTemplateNode = (n: DagNode): n is TemplateNode =>
  typeof (n as TemplateNode).template === 'object' && (n as TemplateNode).template !== null
  && typeof ((n as TemplateNode).template as { template?: unknown }).template === 'string';
export const isHttpRequestNode = (n: DagNode): n is HttpRequestNode =>
  typeof (n as HttpRequestNode).http === 'object' && (n as HttpRequestNode).http !== null
  && typeof ((n as HttpRequestNode).http as { url?: unknown }).url === 'string';
export const isTaskNode = (n: DagNode): n is TaskNode =>
  typeof (n as TaskNode).task === 'object' && (n as TaskNode).task !== null
  && typeof ((n as TaskNode).task as { external?: unknown }).external === 'object';
export const isShowroomNode = (n: DagNode): n is ShowroomNode =>
  typeof (n as ShowroomNode).showroom === 'object' && (n as ShowroomNode).showroom !== null
  && Array.isArray(((n as ShowroomNode).showroom as { lanes?: unknown }).lanes)
  && typeof ((n as ShowroomNode).showroom as { aggregator?: unknown }).aggregator === 'string';
export const isScheduleTriggerNode = (n: DagNode): n is ScheduleTriggerNode =>
  typeof (n as ScheduleTriggerNode).scheduleTrigger === 'object'
  && (n as ScheduleTriggerNode).scheduleTrigger !== null
  && typeof ((n as ScheduleTriggerNode).scheduleTrigger as { type?: unknown }).type === 'string';
export const isWebhookTriggerNode = (n: DagNode): n is WebhookTriggerNode =>
  typeof (n as WebhookTriggerNode).webhookTrigger === 'object'
  && (n as WebhookTriggerNode).webhookTrigger !== null
  && typeof ((n as WebhookTriggerNode).webhookTrigger as { path?: unknown }).path === 'string';
export const isDiscordTriggerNode = (n: DagNode): n is DiscordTriggerNode =>
  typeof (n as DiscordTriggerNode).discordTrigger === 'object'
  && (n as DiscordTriggerNode).discordTrigger !== null
  && typeof ((n as DiscordTriggerNode).discordTrigger as { kind?: unknown }).kind === 'string';
export const isTelegramTriggerNode = (n: DagNode): n is TelegramTriggerNode =>
  typeof (n as TelegramTriggerNode).telegramTrigger === 'object'
  && (n as TelegramTriggerNode).telegramTrigger !== null
  && typeof ((n as TelegramTriggerNode).telegramTrigger as { kind?: unknown }).kind === 'string';
export const isManualTriggerNode = (n: DagNode): n is ManualTriggerNode =>
  typeof (n as ManualTriggerNode).manualTrigger === 'object'
  && (n as ManualTriggerNode).manualTrigger !== null;
export const isChatTriggerNode = (n: DagNode): n is ChatTriggerNode =>
  typeof (n as ChatTriggerNode).chatTrigger === 'object'
  && (n as ChatTriggerNode).chatTrigger !== null
  && typeof ((n as ChatTriggerNode).chatTrigger as { path?: unknown }).path === 'string';
export const isSubworkflowNode = (n: DagNode): n is SubworkflowNode =>
  n.kind === 'subworkflow';
export const isPluginKindNode = (n: DagNode): n is PluginKindNode =>
  typeof (n as PluginKindNode).kind === 'string' && n.kind !== 'subworkflow';
