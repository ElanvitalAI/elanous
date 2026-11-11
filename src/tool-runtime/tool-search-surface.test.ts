import { expect, test } from 'bun:test';
import type { LLMToolRouteMetadata, LLMToolSpec } from '../llm/tool-spec.js';
import { dispatchClassicTuiTool, prioritizeDashboardTuiToolSearch } from '../dashboard/classic-tui-dispatch.js';
import { HYDRATED_TOOLS_KEY } from '../skills/tools/tool-search-spec.js';
import { dispatchToolByName, registerToolRuntime } from './registry.js';
import { toolSearchRuntime, type ToolSearchRunResult } from './tool-search-runtime.js';
import type { ToolRuntimeContext } from './types.js';

const gcpArchitectRoute: LLMToolRouteMetadata = {
  triggers: ['GCP 확장안', '용량 부족', '클라우드 확장'],
  examples: ['용량이 부족한데 GCP 확장안을 제안해줘'],
  sideEffects: 'external',
  risk: 'high',
  cost: 'spends-cloud',
  requiresConfirm: true,
};

const gcpArchitectSpec: LLMToolSpec = {
  name: 'gcp_architect_expand',
  description: '용량 부족을 분석해 GCP 확장안을 제안합니다.',
  parameters: { type: 'object', properties: { ticketDesignPath: { type: 'string' } } },
  pluginId: 'gcp-architect-expand',
  route: gcpArchitectRoute,
};

test('classic ToolSearch dispatch searches and hydrates route tools from the current surface pool', async () => {
  registerToolRuntime(toolSearchRuntime);
  const context: ToolRuntimeContext = { surface: 'tui', surfaceSpecs: [gcpArchitectSpec] };

  const result = await dispatchToolByName('tool_search', { query: 'route:용량 부족 GCP 확장안' }, context) as ToolSearchRunResult;

  expect(result.matched).toEqual(['gcp_architect_expand']);
  expect(result.unknown).toEqual([]);
  expect(result[HYDRATED_TOOLS_KEY]).toEqual([gcpArchitectSpec]);
});

test('classic dashboard dispatcher discovers and hydrates route specs, and scopes them to ToolSearch', async () => {
  registerToolRuntime(toolSearchRuntime);
  const result = await dispatchClassicTuiTool(
    dispatchToolByName,
    'ToolSearch',
    { query: 'route:용량 부족 GCP 확장안' },
    { surface: 'tui' },
    [gcpArchitectSpec],
  ) as ToolSearchRunResult;

  expect(result.matched).toEqual(['gcp_architect_expand']);
  expect(result[HYDRATED_TOOLS_KEY]).toEqual([gcpArchitectSpec]);

  let otherToolContext: ToolRuntimeContext | undefined;
  const inheritedCatalogContext: ToolRuntimeContext = { surface: 'tui', surfaceSpecs: [gcpArchitectSpec] };
  await dispatchClassicTuiTool(async (_name, _input, context) => {
    otherToolContext = context;
    return { output: 'ok' };
  }, 'SomeOtherTool', {}, inheritedCatalogContext, [gcpArchitectSpec]);
  expect(otherToolContext).toEqual({ surface: 'tui' });
});

test('dashboard TUI catalogs keep ToolSearch within the measured provider-visible prefix', () => {
  // Source: seat-state/R-GCPX/classic-pty-toolsearch-stack-receipt.json records 50 advertised tools without ToolSearch.
  const providerToolCap = 50;
  const commonTools = Array.from({ length: providerToolCap }, (_, index) => ({
    name: `Common${index}`, description: 'common', parameters: { type: 'object', properties: {} },
  }));
  const catalog = prioritizeDashboardTuiToolSearch([...commonTools, {
    name: 'ToolSearch', description: 'search', parameters: { type: 'object', properties: {} },
  }]);

  expect(catalog.slice(0, providerToolCap).map((tool) => tool.name)).toContain('ToolSearch');
});
