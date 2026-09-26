import { describe, expect, test } from 'bun:test';
import {
  ACTUAL_SUBSTRATE_ENV, RUN_CONTRACT_ENV, carryRunContract, completionFloorFor, parseGraphRunContract, resolveRunContract, runContractAtNode,
} from './graph-run-contract.js';
import { parseGraphTemplateYaml } from './graph-yaml.js';
import { compileGraphTemplate } from './graph-templates.js';

describe('run contract — decided once at the start, every node can check it', () => {
  test('resolution order: launch → parent-carried → graph → default', () => {
    const carried = { [RUN_CONTRACT_ENV]: carryRunContract({ substrate: 'pod' }) };
    expect(resolveRunContract({ env: {} })).toEqual({ substrate: 'local', source: 'default' });
    expect(resolveRunContract({ graph: { substrate: 'pod' }, env: {} })).toEqual({ substrate: 'pod', source: 'graph' });
    expect(resolveRunContract({ graph: { substrate: 'local' }, env: carried })).toEqual({ substrate: 'pod', source: 'parent' });
    expect(resolveRunContract({ launch: 'local', graph: { substrate: 'pod' }, env: carried })).toEqual({ substrate: 'local', source: 'launch' });
  });

  test('a garbled carried contract is ignored, not guessed', () => {
    expect(resolveRunContract({ env: { [RUN_CONTRACT_ENV]: '{"substrate":"mars"}' } }).source).toBe('default');
    expect(resolveRunContract({ env: { [RUN_CONTRACT_ENV]: 'not json' } }).source).toBe('default');
  });

  test('node check compares the contract with where the process actually runs', () => {
    const pod = { substrate: 'pod' as const, source: 'parent' as const };
    expect(runContractAtNode(pod, { [ACTUAL_SUBSTRATE_ENV]: 'pod' })).toEqual({ contractSubstrate: 'pod', actualSubstrate: 'pod', contractHonored: true, effectsHonored: 'unmeasured' });
    expect(runContractAtNode(pod, {})).toMatchObject({ actualSubstrate: 'local', contractHonored: false });
  });

  test('pod raises the completion floor to a PR (a pod vanishes with its worktree)', () => {
    expect(completionFloorFor({ substrate: 'pod' })).toBe('pr');
    expect(completionFloorFor({ substrate: 'local' })).toBeNull();
  });

  test('graph YAML: run_contract is parsed, validated and reaches the runtime template', () => {
    expect(parseGraphRunContract({ substrate: 'k8s' }).error).toContain('local|pod');
    const yaml = (extra: string) => `graph_id: t\nversion: 1\nentry_node: a\nterminal_nodes: [a]\n${extra}nodes:\n  - { node_id: a, kind: agent, recipe: r, max_visits: 1, contract: { inputs: [], tools: x, outputs: [] } }\nedges: []\n`;
    const ok = parseGraphTemplateYaml(yaml('run_contract:\n  substrate: pod\n'));
    expect(ok.errors).toEqual([]);
    expect(ok.template?.runContract).toEqual({ substrate: 'pod' });
    expect(compileGraphTemplate(ok.template!).template.runContract).toEqual({ substrate: 'pod' });
    const bad = parseGraphTemplateYaml(yaml('run_contract:\n  substrate: k8s\n'));
    expect(bad.errors.map((e) => e.path)).toContain('<inline>/run_contract');
    expect(parseGraphTemplateYaml(yaml('')).template?.runContract).toBeUndefined();   // 없으면 없다 — 기본값을 지어 싣지 않는다
  });

  test('profile·effects resolve per field and effectsHonored stays unmeasured until collections exist', () => {
    const carried = { [RUN_CONTRACT_ENV]: carryRunContract({ substrate: 'pod', profile: 'impl-draft', effects: 'draft-pr' }) };
    const c = resolveRunContract({ graph: { effects: 'none' }, env: carried });
    expect(c).toEqual({ substrate: 'pod', source: 'parent', profile: 'impl-draft', profileSource: 'parent', effects: 'draft-pr', effectsSource: 'parent' });
    expect(resolveRunContract({ launchEffects: 'none', env: carried }).effects).toBe('none');   // 발사 인자가 이긴다
    expect(runContractAtNode(c, { [ACTUAL_SUBSTRATE_ENV]: 'pod' })).toMatchObject({ profile: 'impl-draft', effects: 'draft-pr', effectsHonored: 'unmeasured' });
    expect(parseGraphRunContract({ effects: 'everything' }).error).toContain('none|draft-pr|merge|outbound');
    expect(parseGraphRunContract({ profile: 'bad name' }).error).toContain('run_contract.profile');
    expect(resolveRunContract({ env: {} })).toEqual({ substrate: 'local', source: 'default' });   // 선언이 없으면 칸도 없다
  });
});
