import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { formatDoctorReport, registerDoctorCommand, runDoctor } from './doctor-cli.js';
import { formatDoctorLocalLlm, localInventory, probeDoctorLocalLlm } from './doctor-local-llm.js';
import type { LlmInventory, LlmModel, LlmNode } from '../llm/local-manager/types.js';
import type { UserConfig } from '../user-config.js';

const node: LlmNode = {
  id: 'local', label: 'local', isLocal: true, lastProbedAt: 1, reachable: true,
  runtimes: ['lmstudio'], lmstudioBaseUrl: 'http://127.0.0.1:1234/v1',
};
const model = (id: string, runtime: LlmModel['runtime'] = 'lmstudio'): LlmModel =>
  ({ id, label: id, runtime, nodeId: 'local', probedAt: 1 });
const inventory = (nodes: LlmNode[] = [], models: LlmModel[] = []): LlmInventory =>
  ({ nodes, models, at: 1, cached: false, warnings: [] });

async function cli(probe: () => Promise<LlmInventory>, args: string[] = []) {
  const output: string[] = [];
  const exitCodes: number[] = [];
  const program = new Command();
  const deps = {
    repositoryRoot: '/repo',
    readFile: (path: string) => path === '/repo/.env.example' ? 'KEY=\n' : '',
    exists: () => false, env: {},
    userConfig: { registry: { discovery: { firecrawl: {} } } } as UserConfig,
    readiness: { provider: 'auto' },
    localLlmInventory: probe,
  };
  registerDoctorCommand(program, {
    ...deps, out: { log: (line) => output.push(line) }, setExitCode: (code) => exitCodes.push(code),
  });
  await program.parseAsync(['doctor', ...args], { from: 'user' });
  return { output: output[0]!, exitCodes, baseline: runDoctor(deps) };
}

describe('doctor local LLM', () => {
  test('reachable LM Studio shows its address, model count and names in human and JSON, keeping existing fields', async () => {
    const probe = async () => inventory([node], [model('alpha'), model('beta')]);
    const human = await cli(probe);
    const json = await cli(probe, ['--json']);
    const parsed = JSON.parse(json.output);
    expect(human.output).toContain('Local LLM:\n  lmstudio · http://127.0.0.1:1234/v1 · 닿음 · 모델 2개 · alpha, beta');
    expect(parsed.localLlm).toEqual({ nodes: [{ kind: 'lmstudio', baseUrl: node.lmstudioBaseUrl, reachable: true, models: ['alpha', 'beta'] }], timedOut: false });
    const { localLlm: _localLlm, ...existing } = parsed;
    expect(existing).toEqual(human.baseline);
    expect(human.output).toBe(`${formatDoctorReport(human.baseline)}\nLocal LLM:\n  lmstudio · http://127.0.0.1:1234/v1 · 닿음 · 모델 2개 · alpha, beta`);
    expect(json.exitCodes).toEqual([]);
  });

  test('empty inventory prints the guidance and JSON nodes is empty', async () => {
    const probe = async () => inventory();
    const human = await cli(probe);
    const json = await cli(probe, ['--json']);
    expect(human.output).toContain('Local LLM:\n  로컬 LLM 서버를 찾지 못했다 — Ollama(:11434) · LM Studio(:1234) 를 띄우면 여기 보인다');
    expect(JSON.parse(json.output).localLlm).toEqual({ nodes: [], timedOut: false });
    expect(human.exitCodes).toEqual([]);
  });

  test('remote nodes and their models never appear in the Local LLM section or JSON', async () => {
    const remote: LlmNode = {
      ...node, id: 'remote', label: 'remote', isLocal: false,
      lmstudioBaseUrl: 'http://remote.example:1234/v1',
    };
    const probe = async () => inventory([node, remote], [model('local-model'), { ...model('remote-model'), nodeId: remote.id }]);
    const human = await cli(probe);
    const json = await cli(probe, ['--json']);
    expect(human.output).toContain('Local LLM:\n  lmstudio · http://127.0.0.1:1234/v1 · 닿음 · 모델 1개 · local-model');
    expect(human.output).not.toContain('remote.example');
    expect(human.output).not.toContain('remote-model');
    expect(JSON.parse(json.output).localLlm).toEqual({
      nodes: [{ kind: 'lmstudio', baseUrl: node.lmstudioBaseUrl, reachable: true, models: ['local-model'] }],
      timedOut: false,
    });
    const onlyRemote = await cli(async () => inventory([remote], [{ ...model('remote-model'), nodeId: remote.id }]));
    expect(onlyRemote.output).toContain('Local LLM:\n  로컬 LLM 서버를 찾지 못했다');
    expect(onlyRemote.output).not.toContain('remote.example');
  });

  test('inventory lookup failure is not reported as no servers and does not change doctor exit code', async () => {
    const failed = async (): Promise<LlmInventory> => { throw new Error('inventory unavailable'); };
    const human = await cli(failed);
    const json = await cli(failed, ['--json']);
    expect(human.output).toContain('Local LLM:\n  로컬 LLM 인벤토리를 조회하지 못했다');
    expect(human.output).not.toContain('로컬 LLM 서버를 찾지 못했다');
    expect(JSON.parse(json.output).localLlm).toEqual({ nodes: [], timedOut: false, failed: true });
    expect(human.exitCodes).toEqual([]);
    expect(json.exitCodes).toEqual([]);
  });

  test('a hanging inventory times out within 3 seconds and does not change doctor exit code', async () => {
    const never = () => new Promise<LlmInventory>(() => {});
    const started = Date.now();
    const human = await cli(never);
    const json = await cli(never, ['--json']);
    expect(Date.now() - started).toBeLessThan(7000);
    expect(human.output).toContain('Local LLM:\n  시간 초과');
    expect(JSON.parse(json.output).localLlm).toEqual({ nodes: [], timedOut: true });
    expect(human.exitCodes).toEqual([]);
    expect(json.exitCodes).toEqual([]);
  }, 9000);

  test('cached address of a runtime that is no longer reachable is marked 안 닿음', async () => {
    const result = await probeDoctorLocalLlm(async () => inventory([
      { ...node, reachable: false, runtimes: [] },
    ]));
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.kind).toBe('lmstudio');
    expect(result.nodes[0]?.baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(result.nodes[0]?.reachable).toBe(false);
    expect(result.nodes[0]?.models).toHaveLength(0);
    expect(formatDoctorLocalLlm(result).join('\n')).toContain('lmstudio · http://127.0.0.1:1234/v1 · 안 닿음 · 모델 0개');
  });

  test('per-runtime rows keep models separate and show only the first five names', async () => {
    const result = await probeDoctorLocalLlm(async () => inventory([
      { ...node, runtimes: ['lmstudio', 'ollama'], ollamaBaseUrl: 'http://127.0.0.1:11434/v1' },
    ], [...Array.from({ length: 6 }, (_, i) => model(`model-${i}`)), model('ollama-one', 'ollama')]));
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.find((row) => row.kind === 'ollama')?.models).toEqual(['ollama-one']);
    expect(result.nodes.find((row) => row.kind === 'lmstudio')?.models).toHaveLength(6);
    expect(formatDoctorLocalLlm(result).join('\n')).not.toContain('model-5');
  });
});

describe('localInventory — doctor probes only this machine', () => {
  test('remote fleet nodes are never probed; the local node gets the runtimes that answered', async () => {
    const probed: string[] = [];
    const answer = (reachable: boolean) => async (node: { id: string }) => { probed.push(node.id); return { reachable, models: [], warnings: [] }; };
    const local = { id: 'local', label: 'local', isLocal: true, lastProbedAt: 1, reachable: false, runtimes: [] } as unknown as LlmNode;
    const remote = { id: 'node-b', label: 'node-b', isLocal: false, lastProbedAt: 1, reachable: false, runtimes: [] } as unknown as LlmNode;
    const inv = await localInventory({ nodes: () => [local, remote], probes: { lmstudio: answer(true), ollama: answer(false), mlx: answer(false), docker: answer(false) } });
    expect(new Set(probed)).toEqual(new Set(['local']));
    expect(inv.nodes.map((n) => [n.id, n.reachable, n.runtimes])).toEqual([['local', true, ['lmstudio']]]);
  });
});
