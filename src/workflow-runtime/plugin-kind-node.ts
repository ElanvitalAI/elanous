// Plugin kind node — dispatch a registered declarative `run` to its executor.
//
// Templates are `{{inputs.<name>}}` only. Anything else inside `{{…}}` is an
// error (left in place it would be a second interpolation language). Bash
// values are single-quoted so the substituted text cannot become shell syntax.

import { callDaemonMcpTool } from '../cli/mcp-call.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { pluginEnv } from '../plugins/install/plugin-credentials.js';
import { debug } from '../debug/log.js';
import { getNodeKind, type NodeKindEntry, type NodeKindRun } from '../graph-kinds/registry.js';
import { executeBashNode } from './nodes/bash.js';
import { executeHttpRequestNode } from './nodes/http.js';
import { executeSkillNode } from './nodes/skill.js';
import { listInstalledPlugins } from '../plugins/install/plugin-install.js';
import { join } from 'node:path';
import type { DagNode, NodeExecContext, NodeOutput, PluginKindNode, WorkflowDeps } from './types.js';

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const INPUT_REF = /^inputs\.([A-Za-z_][A-Za-z0-9_]*)$/;

export function isPluginKindNode(node: DagNode): node is PluginKindNode {
  return typeof (node as PluginKindNode).kind === 'string';
}

export function pluginKindRunName(run: NodeKindRun): 'bash' | 'http' | 'skill' | 'mcp' {
  if ('bash' in run) return 'bash';
  if ('http' in run) return 'http';
  if ('mcp' in run) return 'mcp';
  return 'skill';
}

/** Single-quote a value for a POSIX shell. `'` becomes `'\''`. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function substituteInputs(template: string, inputs: Record<string, unknown>, quote: boolean): string {
  return template.replace(PLACEHOLDER, (whole, raw: string) => {
    const match = INPUT_REF.exec(raw.trim());
    if (!match) throw new Error(`unsupported template '${whole}' — only {{inputs.<name>}} is allowed`);
    const name = match[1]!;
    if (!Object.prototype.hasOwnProperty.call(inputs, name) || inputs[name] === undefined) {
      throw new Error(`missing input '${name}'`);
    }
    const value = inputs[name];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return quote ? shellSingleQuote(text) : text;
  });
}

function substituteMcpArg(value: unknown, inputs: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => substituteMcpArg(item, inputs));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteMcpArg(item, inputs)]));
  }
  if (typeof value !== 'string') return value;
  const full = /^\{\{([^{}]*)\}\}$/.exec(value);
  if (full) {
    const match = INPUT_REF.exec(full[1]!.trim());
    if (!match) throw new Error(`unsupported template '${value}' — only {{inputs.<name>}} is allowed`);
    const name = match[1]!;
    if (!Object.prototype.hasOwnProperty.call(inputs, name) || inputs[name] === undefined) {
      throw new Error(`missing input '${name}'`);
    }
    return inputs[name];
  }
  return substituteInputs(value, inputs, false);
}

function missingRequired(entry: NodeKindEntry, inputs: Record<string, unknown>): string[] {
  const schema = entry.schema;
  const required = schema && Array.isArray(schema['required']) ? schema['required'] : [];
  return required.filter((name): name is string => typeof name === 'string' && (inputs[name] === undefined || inputs[name] === null));
}

export async function executePluginKindNode(
  node: PluginKindNode,
  ctx: NodeExecContext,
  deps: WorkflowDeps,
): Promise<NodeOutput> {
  const startedAt = Date.now();
  const entry = getNodeKind('workflow', node.kind);
  if (!entry || entry.core || !entry.run) {
    return { ok: false, output: '', error: `unknown node kind '${node.kind}'`, durationMs: Date.now() - startedAt };
  }
  const missing = missingRequired(entry, node.inputs);
  if (missing.length > 0) {
    return { ok: false, output: '', error: `missing required input '${missing[0]}'`, durationMs: Date.now() - startedAt };
  }
  const run = pluginKindRunName(entry.run);
  debug.log('workflow.plugin-kind', 'dispatch', {
    kind: node.kind, run,
    ...('mcp' in entry.run ? { server: entry.run.mcp.server, tool: entry.run.mcp.tool } : {}),
  });
  try {
    if ('mcp' in entry.run) {
      const spec = entry.run.mcp;
      const args = Object.fromEntries(Object.entries(spec.args ?? {}).map(([key, value]) => [key, substituteMcpArg(value, node.inputs)]));
      const result = await callDaemonMcpTool({ tool: `${spec.server}.${spec.tool}`, arguments: args, pluginKind: node.kind });
      const record = result && typeof result === 'object' && !Array.isArray(result)
        ? result as { content?: unknown; structuredContent?: unknown }
        : {};
      if (record.structuredContent !== undefined || !Array.isArray(record.content)
        || record.content.length === 0 || record.content.some((item: unknown) =>
          !item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'text'
          || typeof (item as { text?: unknown }).text !== 'string')) {
        throw new Error('unsupported MCP tool result: expected text-only content');
      }
      const output = (record.content as Array<{ text: string }>).map((item) => item.text).join('\n');
      let credentials: Record<string, string> = {};
      try { credentials = pluginEnv(entry.plugin!, elanousStateRoot()); }
      catch { /* Registered kinds may also be used without an installed plugin. */ }
      const safe = Object.values(credentials).filter(value => value.length > 0)
        .reduce((text, value) => text.replaceAll(value, '[REDACTED]'), output);
      return { ok: true, output: safe, durationMs: Date.now() - startedAt };
    }
    if ('bash' in entry.run) {
      const bash = substituteInputs(entry.run.bash, node.inputs, true);
      return await executeBashNode({ ...node, bash }, ctx, deps);
    }
    if (entry.run && 'http' in entry.run) {
      const spec = entry.run.http;
      return await executeHttpRequestNode({
        ...node,
        http: {
          method: substituteInputs(spec.method, node.inputs, false) as 'GET',
          url: substituteInputs(spec.url, node.inputs, false),
          ...(spec.body !== undefined ? { body: substituteInputs(spec.body, node.inputs, false) } : {}),
        },
      }, ctx, deps);
    }
    const spec = (entry.run as { skill: { name: string; prompt?: string } }).skill;
    // 플러그인 kind 의 스킬은 그 플러그인 설치 폴더의 `skills/` 에서 먼저 찾는다(팩이 스킬 본체를 싣는다 · `elanous-hwp` → `hwp-write`).
    let skillsDir: string | undefined;
    if (entry.plugin) {
      try {
        const installed = listInstalledPlugins(elanousStateRoot()).find((item) => item.name === entry.plugin);
        if (installed) skillsDir = join(installed.path, 'skills');
      } catch { /* 설치 원장을 못 읽으면 종전 위치만 */ }
    }
    debug.log('workflow.plugin-kind', 'skill-dir', { plugin: entry.plugin ?? null, skill: spec.name, skillsDir: skillsDir ?? null });
    const skillDeps: WorkflowDeps = skillsDir && deps.runSkill
      ? { ...deps, runSkill: (slug, args) => deps.runSkill!(slug, args, { skillsDir }) }
      : deps;
    return await executeSkillNode({
      ...node,
      skill: substituteInputs(spec.name, node.inputs, false),
      ...(spec.prompt !== undefined ? { arguments: substituteInputs(spec.prompt, node.inputs, false) } : {}),
    }, ctx, skillDeps);
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    if ('mcp' in entry.run && entry.plugin) {
      try {
        const credentials = pluginEnv(entry.plugin, elanousStateRoot());
        for (const value of Object.values(credentials)) if (value) message = message.replaceAll(value, '[REDACTED]');
      } catch { /* Registered kinds may also be used without an installed plugin. */ }
    }
    return {
      ok: false,
      output: '',
      error: message,
      durationMs: Date.now() - startedAt,
    };
  }
}
