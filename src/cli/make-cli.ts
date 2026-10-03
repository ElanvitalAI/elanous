import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { judge } from '../llm/judge-layer.js';
import { runPluginMake } from './plugin-cli.js';
import { workflowRun } from './workflow.js';

type MakeKind = 'plugin' | 'workflow';
type MakeDeps = {
  decide?: (request: string) => Promise<MakeKind | null>;
  pluginMake?: (request: string) => Promise<void>;
  workflowMake?: (request: string) => Promise<number>;
};

export async function classifyMakeRequest(request: string, call?: (args: { prompt: string; provider: string; model: string }) => Promise<{ text: string }>): Promise<MakeKind | null> {
  if (!request.trim()) return null;
  const result = await judge<MakeKind>({
    site: 'cli.make',
    ...(call ? { call } : {}),
    prompt: `Classify this request for an Elanous creator. Choose "plugin" for a reusable connector, integration, skill, or capability (including reading a file format). Choose "workflow" for a sequence of jobs, recurring schedule, automation, or publishing task, even when it uses a connector. If you cannot decide, return {"kind":"unclear"}. Respond with JSON only, exactly {"kind":"plugin"} or {"kind":"workflow"} or {"kind":"unclear"}. Do not execute the request.\nRequest: ${JSON.stringify(request)}`,
    schema: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const kind = (value as { kind?: unknown }).kind;
      return kind === 'plugin' || kind === 'workflow' ? kind : null;
    },
  });
  return result.ok ? result.value : null;
}

export function registerMakeCommand(program: Command, deps: MakeDeps = {}): void {
  program.command('make <request>')
    .description('Classify a one-line request and make a plugin or build a workflow')
    .action(async (request: string) => {
      const kind = await (deps.decide ?? classifyMakeRequest)(request).catch(() => null);
      debug.log('cli.make', 'route', { kind: kind ?? 'undecided' });
      if (!kind) {
        console.log('플러그인(커넥터·스킬)을 만들까요, 워크플로(잡)를 만들까요?');
        process.exitCode = 1;
        return;
      }
      if (kind === 'plugin') await (deps.pluginMake ?? runPluginMake)(request);
      else process.exitCode = await (deps.workflowMake ?? ((text: string) => workflowRun('build-workflow', text)))(request);
    });
}
